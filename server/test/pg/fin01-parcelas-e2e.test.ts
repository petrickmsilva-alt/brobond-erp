// ============================================================================
// FIN-01 — PARCELAS VÁLIDAS E EXATAS NO SERVIDOR REAL (PostgreSQL + HTTP).
//
// A prova em memória (`fin01-parcelas.test.ts`) exercita as funções de serviço.
// Aqui sobe-se o servidor de VERDADE contra um BANCO NOVO e percorre-se o
// caminho completo `HTTP → requireAuth → rota → venderPdv → transação →
// sincronizarParcelas → PostgreSQL`, sem `req.user` injetado e sem memória:
//
//   A) venda com total divisível não perde centavo (Σ parcelas === total);
//   B) total com resíduo joga o centavo na ÚLTIMA parcela (determinístico);
//   C) total < número de parcelas (R$ 0,01 em 3x) → 422 e NADA persiste
//      (venda e lançamentos continuam ausentes — atomicidade real);
//   D) toda parcela gravada é > 0 (nunca zero, nunca negativa);
//   E) retry de reconciliação não duplica parcelas.
//
// Sem DATABASE_URL este arquivo FALHA: a prova deste ciclo é PostgreSQL.
// ============================================================================
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import type { Readable } from 'node:stream';
import { test } from 'node:test';

if (!process.env.DATABASE_URL) {
  throw new Error('fin01-parcelas-e2e.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { query } = await import('../../src/db');
const { hashPassword } = await import('../../src/password');
const { codigoTOTP } = await import('../../src/totp');
const { decifrarSegredoMfa } = await import('../../src/mfa');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;
const RODADA = `fin01${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

function nomeDoBancoNovo(): string {
  return `brobond_fin01_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 60);
}
function urlDoBanco(nome: string): string {
  const url = new URL(String(process.env.DATABASE_URL));
  url.pathname = `/${nome}`;
  return url.toString();
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Não foi possível reservar porta TCP para o harness.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

const ADMIN_EMAIL_TESTE = `fin01-bootstrap-${RODADA}@example.test`;
const ADMIN_SENHA_TESTE = `FIN01-${randomUUID()}-OnlyForTest`;

async function startRealServer(port: number, databaseUrl: string): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    JWT_SECRET: randomUUID(),
    ADMIN_EMAIL: ADMIN_EMAIL_TESTE,
    ADMIN_PASSWORD: ADMIN_SENHA_TESTE,
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk: string | Buffer) => { output = `${output}${String(chunk)}`.slice(-40_000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`O servidor encerrou antes do health check.\n${output}`);
    try {
      const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (r.ok) {
        const h = (await r.json()) as { ok?: boolean; db?: string };
        if (h.ok === true && h.db === 'postgres') return { child, baseUrl, logs: () => output };
      }
    } catch {
      // migrações do banco novo em andamento
    }
    await delay(200);
  }
  throw new Error(`Health check não confirmou db=postgres em 120 s.\n${output}`);
}

async function stopServer(child: Child): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGTERM');
  });
}

type Resposta = { status: number; body: any; texto: string };

async function req(baseUrl: string, metodo: string, rota: string, corpo?: unknown, token?: string): Promise<Resposta> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  if (corpo !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(`${baseUrl}/api${rota}`, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  let body: any = null;
  try { body = JSON.parse(texto); } catch { body = null; }
  return { status: r.status, body, texto };
}

/** Loga o ADMIN com MFA (cadastro guiado na 1ª vez, desafio depois). */
async function loginAdmin(baseUrl: string, cliente: Client, email: string, senha: string): Promise<string> {
  // O servidor começa a escutar ANTES de `ensureAdmin()` criar o admin de
  // bootstrap (server/src/index.ts, de propósito, para o Render ver a porta).
  // O health check confirma o banco assim que `migrate()` termina — ou seja,
  // antes do admin existir. Espera-se o bootstrap na FONTE (a linha em
  // `usuarios`), não em tentativas de login: cada falha 401 consome o rate
  // limit de 5 tentativas e poderia bloquear a conta de teste.
  const limite = Date.now() + 60_000;
  for (;;) {
    try {
      const { rows } = await cliente.query('SELECT 1 FROM usuarios WHERE email = $1 AND senha_hash IS NOT NULL', [email]);
      if (rows.length) break;
    } catch {
      // `usuarios` ainda não existe: `migrate()` roda depois do listen.
    }
    if (Date.now() > limite) throw new Error(`admin de bootstrap "${email}" não foi criado em 60 s`);
    await delay(200);
  }
  const r = await req(baseUrl, 'POST', '/auth/login', { email, password: senha });
  assert.equal(r.status, 200, `login admin: ${r.texto}`);
  const ticket = String(r.body?.mfa_ticket || '');
  assert.ok(ticket, 'admin precisa receber mfa_ticket');
  let segredo: string;
  if (r.body?.mfa_setup_required) {
    const d = await req(baseUrl, 'POST', '/auth/mfa/desafio', { mfa_ticket: ticket });
    assert.equal(d.status, 200, `desafio MFA: ${d.texto}`);
    segredo = String(d.body.segredo);
  } else {
    const cifrado = String((await cliente.query(`SELECT mfa_secret FROM usuarios WHERE email = $1`, [email])).rows[0].mfa_secret);
    segredo = String(decifrarSegredoMfa(cifrado));
    assert.ok(segredo, 'segredo MFA do admin precisa ser decifrável para o desafio');
  }
  const r2 = await req(baseUrl, 'POST', '/auth/login/mfa', { mfa_ticket: ticket, codigo: codigoTOTP(segredo) });
  assert.equal(r2.status, 200, `login/mfa: ${r2.texto}`);
  return String(r2.body.token);
}

/** Soma em CENTAVOS inteiros — imune ao ruído de ponto flutuante. */
function somaCentavos(valores: number[]): number {
  return Math.round(valores.reduce((a, b) => a + Number(b), 0) * 100);
}

test('FIN-01: parcelas válidas e exatas via HTTP real + PostgreSQL', async (t) => {
  const nome = nomeDoBancoNovo();
  await query(`CREATE DATABASE ${nome}`);
  const databaseUrl = urlDoBanco(nome);

  const porta = await reservePort();
  const { child, baseUrl, logs } = await startRealServer(porta, databaseUrl);

  const cliente = new Client({ connectionString: databaseUrl });
  await cliente.connect();

  t.after(async () => {
    await cliente.end().catch(() => undefined);
    await stopServer(child);
    await query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`).catch(() => undefined);
  });

  const evidencia: string[] = [];
  const registra = (texto: string) => evidencia.push(texto);

  // ---- ADMIN de bootstrap: troca da senha provisória; a sessão atual segue --
  const adminToken = await loginAdmin(baseUrl, cliente, ADMIN_EMAIL_TESTE, ADMIN_SENHA_TESTE);
  const novaSenhaAdmin = `FIN01-Adm-${randomUUID()}!X`;
  const troca = await req(baseUrl, 'POST', '/auth/change-password', { senha_atual: ADMIN_SENHA_TESTE, senha_nova: novaSenhaAdmin }, adminToken);
  assert.equal(troca.status, 200, `troca de senha do admin: ${troca.texto}`);

  // ---- Seed mínimo por SQL: local, tamanho, produto e saldo de estoque ------
  const local = await cliente.query(`INSERT INTO locais (empresa_id,nome,tipo,ativo,padrao) VALUES (1,$1,'loja',true,true) RETURNING id`, [`loja fin01 ${RODADA}`]);
  const tam = await cliente.query(`INSERT INTO tamanhos (codigo,descricao,ordem) VALUES ($1,$1,99) ON CONFLICT (codigo) DO UPDATE SET descricao=EXCLUDED.descricao RETURNING id`, [`F01${RODADA}`.slice(0, 20)]);
  const tamanhoId = Number(tam.rows[0].id);
  const prod = await cliente.query(`INSERT INTO produtos (empresa_id,sku,nome,preco_venda,ativo) VALUES (1,$1,'Produto FIN-01',100,true) RETURNING id`, [`FIN01-${RODADA}`]);
  const produtoId = Number(prod.rows[0].id);
  const prodCentavo = await cliente.query(`INSERT INTO produtos (empresa_id,sku,nome,preco_venda,ativo) VALUES (1,$1,'Produto FIN-01 centavo',0.01,true) RETURNING id`, [`FIN01C-${RODADA}`]);
  const produtoCentavoId = Number(prodCentavo.rows[0].id);
  for (const pid of [produtoId, produtoCentavoId]) {
    await cliente.query(`INSERT INTO estoques (empresa_id,produto_id,tamanho_id,local,local_id,quantidade) VALUES (1,$1,$2,$3,$4,50)`, [pid, tamanhoId, `loja fin01 ${RODADA}`, local.rows[0].id]);
  }
  registra(`seed: local #${local.rows[0].id}, tamanho #${tamanhoId}, produtos #${produtoId}/#${produtoCentavoId} com 50 un cada`);

  // ---- Abre o caixa (pré-condição do PDV) ----------------------------------
  const caixa = await req(baseUrl, 'POST', '/pdv/caixas', { numero: `FIN01-${RODADA}`, valor_abertura: 10, local_id: local.rows[0].id }, adminToken);
  assert.equal(caixa.status, 201, `abrir caixa: ${caixa.texto}`);
  const caixaId = Number(caixa.body.id);

  const parcelasDaoBanco = async (vendaId: number) => {
    const { rows } = await cliente.query(
      `SELECT parcela, valor::float8 AS valor, total_parcelas, status
         FROM lancamentos_financeiros
        WHERE referencia_tipo = 'venda' AND referencia_id = $1
        ORDER BY parcela`,
      [vendaId],
    );
    return rows;
  };

  // ------------------------------------------------------------------------
  // A/B) Venda real de R$ 100,00 em 3x → [33,33, 33,33, 33,34] no PostgreSQL.
  // ------------------------------------------------------------------------
  const vendaOk = await req(baseUrl, 'POST', '/pdv/vendas', {
    caixa_id: caixaId,
    itens: [{ produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 1, desconto_pct: 0 }],
    pagamentos: [{ forma: 'cartao_credito', valor: 100, parcelas: 3 }],
  }, adminToken);
  assert.equal(vendaOk.status, 201, `venda 100 em 3x: ${vendaOk.texto}`);
  const vendaId = Number(vendaOk.body.venda_id);
  assert.equal(Number(vendaOk.body.calculo.total), 100);

  const parcelasOk = await parcelasDaoBanco(vendaId);
  assert.equal(parcelasOk.length, 3, 'a venda precisa gerar exatamente 3 parcelas');
  assert.deepEqual(parcelasOk.map((p) => Number(p.valor)), [33.33, 33.33, 33.34], 'resíduo na ÚLTIMA parcela');
  assert.equal(somaCentavos(parcelasOk.map((p) => Number(p.valor))), 10000, 'Σ parcelas === total (sem perder centavo)');
  assert.ok(parcelasOk.every((p) => Number(p.valor) > 0), 'nenhuma parcela pode ser zero/negativa');
  assert.deepEqual(parcelasOk.map((p) => Number(p.total_parcelas)), [3, 3, 3]);
  registra(`A/B) venda #${vendaId} 100,00 em 3x → ${JSON.stringify(parcelasOk.map((p) => Number(p.valor)))} (Σ=100,00)`);

  // ------------------------------------------------------------------------
  // C/D) Venda de R$ 0,01 em 3x → 422 e NADA persiste (venda + lançamentos).
  // ------------------------------------------------------------------------
  const antesVendas = Number((await cliente.query(`SELECT count(*)::int AS n FROM vendas`)).rows[0].n);
  const antesLanc = Number((await cliente.query(`SELECT count(*)::int AS n FROM lancamentos_financeiros`)).rows[0].n);

  const vendaRuim = await req(baseUrl, 'POST', '/pdv/vendas', {
    caixa_id: caixaId,
    itens: [{ produto_id: produtoCentavoId, tamanho_id: tamanhoId, quantidade: 1, desconto_pct: 0 }],
    pagamentos: [{ forma: 'cartao_credito', valor: 0.01, parcelas: 3 }],
  }, adminToken);
  assert.equal(vendaRuim.status, 422, `0,01 em 3x deve ser rejeitado (422), não persistido: ${vendaRuim.texto}`);
  assert.match(String(vendaRuim.body?.error || ''), /zerada|parcela/i, `mensagem canônica do 422: ${vendaRuim.texto}`);

  const depoisVendas = Number((await cliente.query(`SELECT count(*)::int AS n FROM vendas`)).rows[0].n);
  const depoisLanc = Number((await cliente.query(`SELECT count(*)::int AS n FROM lancamentos_financeiros`)).rows[0].n);
  assert.equal(depoisVendas, antesVendas, 'a venda inválida NÃO pode persistir (rollback total)');
  assert.equal(depoisLanc, antesLanc, 'nenhum lançamento pode sobrar da venda inválida');
  registra(`C/D) venda 0,01 em 3x → ${vendaRuim.status}; vendas ${antesVendas}→${depoisVendas}, lançamentos ${antesLanc}→${depoisLanc} (sem resíduo)`);

  // ------------------------------------------------------------------------
  // D) Toda parcela no banco é > 0 (nenhuma linha zero/negativa em lugar algum).
  // ------------------------------------------------------------------------
  const naoPositivas = Number((await cliente.query(`SELECT count(*)::int AS n FROM lancamentos_financeiros WHERE valor <= 0`)).rows[0].n);
  assert.equal(naoPositivas, 0, 'não pode existir lançamento com valor <= 0');
  registra('D) lançamentos com valor <= 0 no banco: 0');

  // ------------------------------------------------------------------------
  // E) Edição da venda (mesmo plano) não duplica parcelas — idempotência real.
  // ------------------------------------------------------------------------
  const idsAntes = (await cliente.query(
    `SELECT id FROM lancamentos_financeiros WHERE referencia_tipo='venda' AND referencia_id=$1 ORDER BY parcela`,
    [vendaId],
  )).rows.map((r) => Number(r.id));
  const reSync = await req(baseUrl, 'PUT', `/vendas/${vendaId}`, { fin_parcelas: 3 }, adminToken);
  assert.equal(reSync.status, 200, `PUT venda (retry do mesmo plano): ${reSync.texto}`);
  const parcelasDepois = await parcelasDaoBanco(vendaId);
  assert.equal(parcelasDepois.length, 3, 'a reconciliação repetida NÃO pode duplicar parcelas');
  const idsDepois = (await cliente.query(
    `SELECT id FROM lancamentos_financeiros WHERE referencia_tipo='venda' AND referencia_id=$1 ORDER BY parcela`,
    [vendaId],
  )).rows.map((r) => Number(r.id));
  assert.deepEqual(idsDepois, idsAntes, 'o retry atualiza as MESMAS parcelas (não cria novas)');
  assert.equal(somaCentavos(parcelasDepois.map((p) => Number(p.valor))), 10000, 'Σ continua 100,00 após retry');
  registra(`E) retry de reconciliação → ${parcelasDepois.length} parcelas, mesmos ids ${JSON.stringify(idsDepois)}, Σ ${(somaCentavos(parcelasDepois.map((p) => Number(p.valor))) / 100).toFixed(2)}`);

  // ------------------------------------------------------------------------
  // Consolida a evidência no log do teste.
  // ------------------------------------------------------------------------
  console.log(`\n[FIN-01 PostgreSQL] ${evidencia.join('\n  ')}\n`);
  assert.doesNotMatch(logs(), /Erro inesperado/, 'nenhuma operação pode virar 500 inesperado');
});

// ============================================================================
// FIN-01 — DETALHES DO DOCUMENTO (XML/NF-e) via HTTP real + PostgreSQL.
//
// A importação de NF-e é o produtor REAL de `fin_parcelas_detalhes`: as
// duplicatas do XML viram o plano de parcelas do contas a pagar. Aqui se prova,
// pelo stack HTTP completo + banco novo:
//   • detalhes VÁLIDOS (duplicatas 100/100/100) → compra criada com as parcelas
//     exatas do documento (Σ === total, todas > 0);
//   • detalhes INCONSISTENTES (100/100/99, 1 centavo abaixo) → 422 e NENHUMA
//     gravação parcial (compra, itens, importação e lançamentos intactos).
// ============================================================================
function nfeXml(opts: {
  chave: string;
  numero: string;
  cnpj: string;
  razao: string;
  cProd: string;
  descricao: string;
  qtd: number;
  unit: number;
  vNF: number;
  duplicatas: { n: number; venc: string; valor: number }[];
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe><infNFe Id="NFe${opts.chave}" versao="4.00">
    <ide><cUF>52</cUF><natOp>VENDA</natOp><mod>55</mod><serie>1</serie><nNF>${opts.numero}</nNF><dhEmi>2026-10-01T10:00:00-03:00</dhEmi></ide>
    <emit><CNPJ>${opts.cnpj}</CNPJ><xNome>${opts.razao}</xNome><enderEmit><xLgr>Rua Teste</xLgr><nro>1</nro><xBairro>Centro</xBairro><cMun>5208707</cMun><xMun>GOIANIA</xMun><UF>GO</UF><CEP>74000000</CEP></enderEmit></emit>
    <det nItem="1"><prod><cProd>${opts.cProd}</cProd><cEAN>SEM GTIN</cEAN><xProd>${opts.descricao}</xProd><NCM>60062100</NCM><CFOP>6102</CFOP><uCom>M</uCom><qCom>${opts.qtd.toFixed(4)}</qCom><vUnCom>${opts.unit.toFixed(4)}</vUnCom><vProd>${(opts.qtd * opts.unit).toFixed(2)}</vProd></prod>
      <imposto><ICMS><ICMS00><orig>0</orig><CST>00</CST><vBC>${(opts.qtd * opts.unit).toFixed(2)}</vBC><pICMS>18.00</pICMS><vICMS>${(opts.qtd * opts.unit * 0.18).toFixed(2)}</vICMS></ICMS00></ICMS></imposto></det>
    <total><ICMSTot><vNF>${opts.vNF.toFixed(2)}</vNF><vProd>${(opts.qtd * opts.unit).toFixed(2)}</vProd><vFrete>0.00</vFrete></ICMSTot></total>
    <cobr><fat><nFat>${opts.numero}</nFat><vOrig>${opts.vNF.toFixed(2)}</vOrig></fat>
${opts.duplicatas.map((d) => `      <dup><nDup>${String(d.n).padStart(3, '0')}</nDup><dVenc>${d.venc}</dVenc><vDup>${d.valor.toFixed(2)}</vDup></dup>`).join('\n')}
    </cobr>
  </infNFe></NFe>
</nfeProc>`;
}

test('FIN-01: detalhes do XML (duplicatas) via HTTP real + PostgreSQL — válidos e inconsistentes', async (t) => {
  const nome = nomeDoBancoNovo();
  await query(`CREATE DATABASE ${nome}`);
  const databaseUrl = urlDoBanco(nome);

  const porta = await reservePort();
  const { child, baseUrl, logs } = await startRealServer(porta, databaseUrl);

  const cliente = new Client({ connectionString: databaseUrl });
  await cliente.connect();

  t.after(async () => {
    await cliente.end().catch(() => undefined);
    await stopServer(child);
    await query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`).catch(() => undefined);
  });

  const evidencia: string[] = [];
  const registra = (texto: string) => evidencia.push(texto);

  const adminToken = await loginAdmin(baseUrl, cliente, ADMIN_EMAIL_TESTE, ADMIN_SENHA_TESTE);
  const novaSenhaAdmin = `FIN01-Det-${randomUUID()}!X`;
  const troca = await req(baseUrl, 'POST', '/auth/change-password', { senha_atual: ADMIN_SENHA_TESTE, senha_nova: novaSenhaAdmin }, adminToken);
  assert.equal(troca.status, 200, `troca de senha do admin: ${troca.texto}`);

  // Seed: local padrão, tamanho único e produto com SKU igual ao cProd do XML.
  await cliente.query(`INSERT INTO locais (empresa_id,nome,tipo,ativo,padrao) VALUES (1,$1,'loja',true,true)`, [`loja det ${RODADA}`]);
  const tam = await cliente.query(`INSERT INTO tamanhos (codigo,descricao,ordem) VALUES ($1,$1,99) ON CONFLICT (codigo) DO UPDATE SET descricao=EXCLUDED.descricao RETURNING id`, [`FD${RODADA}`.slice(0, 20)]);
  const sku = `FIN01-DET-${RODADA}`;
  await cliente.query(`INSERT INTO produtos (empresa_id,sku,nome,preco_venda,ativo) VALUES (1,$1,'Produto detalhe',10,true)`, [sku]);
  registra(`seed detalhes: tamanho #${tam.rows[0].id}, produto sku ${sku}`);

  const parcelasDaCompra = async (compraId: number) => (await cliente.query(
    `SELECT parcela, valor::float8 AS valor, total_parcelas, status
       FROM lancamentos_financeiros WHERE referencia_tipo='compra' AND referencia_id=$1 ORDER BY parcela`,
    [compraId],
  )).rows;

  // ---- VÁLIDO: duplicatas 100/100/100 fechando o total 300,00 --------------
  const chaveOk = `522610${RODADA.toUpperCase().replace(/[^0-9A-Z]/g, '').padEnd(38, '0').slice(0, 38)}`;
  const xmlOk = nfeXml({ chave: chaveOk, numero: '900001', cnpj: '11.222.333/0001-81', razao: 'Fornecedor Detalhe', cProd: sku, descricao: 'Tecido', qtd: 30, unit: 10, vNF: 300, duplicatas: [{ n: 1, venc: '2026-11-01', valor: 100 }, { n: 2, venc: '2026-12-01', valor: 100 }, { n: 3, venc: '2027-01-01', valor: 100 }] });
  const impOk = await req(baseUrl, 'POST', '/suprimentos/compras/importar-xml', { xml: xmlOk, aplicar: true }, adminToken);
  assert.equal(impOk.status, 201, `importação válida deveria criar a compra: ${impOk.texto}`);
  const compraOkId = Number(impOk.body.compra_id);
  const pOk = await parcelasDaCompra(compraOkId);
  assert.equal(pOk.length, 3, 'as 3 duplicatas do XML viram 3 parcelas');
  assert.deepEqual(pOk.map((p) => Number(p.valor)), [100, 100, 100], 'os valores das duplicatas mandam');
  assert.equal(somaCentavos(pOk.map((p) => Number(p.valor))), 30000, 'Σ === total do documento');
  assert.ok(pOk.every((p) => Number(p.valor) > 0));
  registra(`detalhes válidos) XML 300,00 em 3 dup [100,100,100] → compra #${compraOkId}, ${JSON.stringify(pOk.map((p) => Number(p.valor)))}, Σ=300,00`);

  // ---- INCONSISTENTE: duplicatas 100/100/99 (1 centavo abaixo) → 422 --------
  const contar = async (tabela: string) => Number((await cliente.query(`SELECT count(*)::int AS n FROM ${tabela}`)).rows[0].n);
  const antes = { compras: await contar('compras'), lanc: await contar('lancamentos_financeiros'), imports: await contar('importacoes_nfe') };
  const chaveRuim = `522611${RODADA.toUpperCase().replace(/[^0-9A-Z]/g, '').padEnd(38, '1').slice(0, 38)}`;
  const xmlRuim = nfeXml({ chave: chaveRuim, numero: '900002', cnpj: '11.222.333/0001-81', razao: 'Fornecedor Detalhe', cProd: sku, descricao: 'Tecido', qtd: 30, unit: 10, vNF: 300, duplicatas: [{ n: 1, venc: '2026-11-01', valor: 100 }, { n: 2, venc: '2026-12-01', valor: 100 }, { n: 3, venc: '2027-01-01', valor: 99 }] });
  const impRuim = await req(baseUrl, 'POST', '/suprimentos/compras/importar-xml', { xml: xmlRuim, aplicar: true }, adminToken);
  assert.equal(impRuim.status, 422, `duplicatas que não fecham o total devem ser rejeitadas (422): ${impRuim.texto}`);
  assert.match(String(impRuim.body?.error || ''), /não fecha o total|resíduo/i, `mensagem canônica: ${impRuim.texto}`);
  const depois = { compras: await contar('compras'), lanc: await contar('lancamentos_financeiros'), imports: await contar('importacoes_nfe') };
  assert.equal(depois.compras, antes.compras, 'a importação inválida NÃO pode gravar a compra (rollback total)');
  assert.equal(depois.lanc, antes.lanc, 'nenhuma parcela pode sobrar da importação inválida');
  assert.equal(depois.imports, antes.imports, 'a chave inválida não pode ser registrada como importada');
  registra(`detalhes inconsistentes) XML 300,00 em 3 dup [100,100,99] → ${impRuim.status}; compras ${antes.compras}→${depois.compras}, lançamentos ${antes.lanc}→${depois.lanc}, importações ${antes.imports}→${depois.imports} (sem gravação parcial)`);

  const naoPositivas = Number((await cliente.query(`SELECT count(*)::int AS n FROM lancamentos_financeiros WHERE valor <= 0`)).rows[0].n);
  assert.equal(naoPositivas, 0, 'não pode existir lançamento com valor <= 0');
  registra('lançamentos com valor <= 0 no banco: 0');

  console.log(`\n[FIN-01 detalhes PostgreSQL] ${evidencia.join('\n  ')}\n`);
  assert.doesNotMatch(logs(), /Erro inesperado/, 'nenhuma operação pode virar 500 inesperado');
});
