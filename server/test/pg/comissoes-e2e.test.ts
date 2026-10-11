// ============================================================================
// ERP-06 — COMISSÕES: APURAÇÃO, EFETIVAÇÃO E FECHAMENTO DO PERÍODO (P1-05).
//
// O gap do P1-05 não era cálculo: `comissoes.ts` já efetivava conforme o
// recebimento e já tinha teste. O gap era NÃO TER SUPERFÍCIE — nenhuma tela, e
// o critério de aceite do ciclo ("a soma da tela bate com o relatório
// `comissoes`") nunca havia sido executado como prova.
//
// Este arquivo prova, num BANCO NOVO com o servidor de verdade, o caminho que a
// tela de Comissões percorre:
//   1. vender, faturar e receber pela API — a apuração congela no faturamento;
//   2. `GET /financeiro/comissoes` (o que a tela mostra) e
//      `GET /relatorios/comissoes` (o relatório) devolvem o MESMO total
//      apurado no mesmo período — igualdade, tolerância zero;
//   3. antes de o dinheiro entrar, a comissão está APURADA e o saldo efetivado
//      é ZERO: a tela não pode apresentar como devida uma comissão que ninguém
//      recebeu;
//   4. baixa parcial efetiva a parte proporcional (livro com base recebida);
//   5. a quitação completa a apuração e nunca efetiva além dela;
//   6. cancelar a venda gera ESTORNO no livro: o saldo volta a zero e o total
//      estornado aparece separado — sem apagar histórico.
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
  throw new Error('comissoes-e2e.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { query } = await import('../../src/db');
const { hashPassword } = await import('../../src/password');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const RODADA = `e06${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

function nomeDoBancoNovo(): string {
  return `brobond_e06_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 60);
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

async function startRealServer(port: number, databaseUrl: string): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    JWT_SECRET: randomUUID(),
    ADMIN_EMAIL: `e06-bootstrap-${randomUUID().slice(0, 8)}@example.test`,
    ADMIN_PASSWORD: `E06-${randomUUID()}-OnlyForTest`,
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk: string | Buffer) => {
    output = `${output}${String(chunk)}`.slice(-40_000);
  };
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
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

type Resposta = { status: number; body: any; texto: string };

async function req(baseUrl: string, metodo: string, rota: string, corpo?: unknown, token?: string): Promise<Resposta> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (corpo !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${baseUrl}/api${rota}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  let body: any = null;
  try {
    body = JSON.parse(texto);
  } catch {
    body = null;
  }
  return { status: r.status, body, texto };
}

const reais = (v: unknown) => Math.round(Number(v || 0) * 100) / 100;

test('ERP-06/P1-05: comissão apurada = relatório, efetivada só no recebimento, estornada no cancelamento', async (t) => {
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

  // ---- Usuário (fixture do teste; o login de admin exigiria MFA) -----------
  const email = `e06-${RODADA}@example.test`;
  const senha = `E06-${randomUUID()}!`;
  await cliente.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'gerente', true, 1, false, false, false, now())`,
    [`Gerente ${RODADA}`, email, await hashPassword(senha)],
  );
  await cliente.query(`INSERT INTO usuario_empresas (usuario_id, empresa_id) SELECT id, 1 FROM usuarios WHERE email = $1 ON CONFLICT DO NOTHING`, [email]);

  const login = await req(baseUrl, 'POST', '/auth/login', { email, password: senha });
  assert.equal(login.status, 200, `login: ${login.texto}`);
  const token = String(login.body?.token || '');
  assert.ok(token.length > 20, 'login precisa emitir JWT');

  // ---- Cadastros e estoque -------------------------------------------------
  const clienteRes = await req(baseUrl, 'POST', '/clientes', { nome: `Cliente ${RODADA}`, cnpj_cpf: '11222333000181' }, token);
  assert.equal(clienteRes.status, 201, `cliente: ${clienteRes.texto}`);

  const produto = await req(baseUrl, 'POST', '/produtos', {
    sku: `E06-${RODADA}`.toUpperCase().slice(0, 30),
    nome: `Produto ${RODADA}`,
    preco_venda: 1000,
    custo: 400,
  }, token);
  assert.equal(produto.status, 201, `produto: ${produto.texto}`);
  const produtoId = Number(produto.body.id);

  const tamanho = await req(baseUrl, 'POST', '/tamanhos', { codigo: RODADA.slice(-5).toUpperCase(), descricao: 'E06', ordem: 951 }, token);
  assert.ok([200, 201].includes(tamanho.status), `tamanho: ${tamanho.texto}`);
  const tamanhoId = Number(tamanho.body.id);

  const entrada = await req(baseUrl, 'POST', '/movimentacoes', {
    tipo: 'entrada', produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 5, motivo: `Saldo ${RODADA}`,
  }, token);
  assert.ok([200, 201].includes(entrada.status), `entrada: ${entrada.texto}`);

  const representante = await req(baseUrl, 'POST', '/representantes', { nome: `Ana ${RODADA}`, comissao_pct: 10, ativo: true }, token);
  assert.ok([200, 201].includes(representante.status), `representante: ${representante.texto}`);
  const representanteId = Number(representante.body.id);

  // ---- VENDA com representante: faturamento congela a apuração -------------
  const hoje = new Date().toISOString().slice(0, 10);
  const venda = await req(baseUrl, 'POST', '/vendas', {
    cliente_id: Number(clienteRes.body.id), data: hoje, canal_venda: 'representante', representante_id: representanteId, status: 'aberta',
  }, token);
  assert.ok([200, 201].includes(venda.status), `venda: ${venda.texto}`);
  const vendaId = Number(venda.body.id);

  const item = await req(baseUrl, 'POST', `/vendas/${vendaId}/itens`, {
    produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 1, preco_unitario: 1000, desconto_pct: 0,
  }, token);
  assert.ok([200, 201].includes(item.status), `item: ${item.texto}`);

  const faturada = await req(baseUrl, 'PUT', `/vendas/${vendaId}`, { status: 'faturada' }, token);
  assert.equal(faturada.status, 200, `faturamento: ${faturada.texto}\n${logs().slice(-3000)}`);
  assert.equal(reais(faturada.body?.comissao_valor), 100, 'a apuração congela 10% de R$ 1.000');

  // ---- 1) A TELA vê a comissão APURADA e nada efetivado ainda --------------
  const periodo = `de=${hoje}&ate=${hoje}`;
  const resumo = await req(baseUrl, 'GET', `/financeiro/comissoes?${periodo}`, undefined, token);
  assert.equal(resumo.status, 200, `resumo de comissões: ${resumo.texto}`);
  const linha = (resumo.body?.linhas || []).find((l: any) => Number(l.representante_id) === representanteId);
  assert.ok(linha, 'o representante aparece no resumo do período');
  assert.equal(reais(linha.apurada), 100, 'apurada = comissão congelada no faturamento');
  assert.equal(reais(linha.efetivada), 0, 'nada recebido ⇒ NADA efetivado');
  assert.equal(reais(linha.saldo), 0, 'saldo do representante ainda é zero — a tela não antecipa dinheiro');
  assert.equal(reais(resumo.body?.resumo?.apurada), 100);

  // ---- 2) IGUALDADE: a soma da tela = o relatório `comissoes` --------------
  const relatorio = await req(baseUrl, 'GET', `/relatorios/comissoes?${periodo}`, undefined, token);
  assert.equal(relatorio.status, 200, `relatório de comissões: ${relatorio.texto}`);
  const totalRelatorio = reais(
    relatorio.body?.resumo?.comissao ?? (relatorio.body?.linhas || []).reduce((s: number, l: any) => s + Number(l.comissao || 0), 0),
  );
  assert.equal(
    totalRelatorio,
    reais(resumo.body?.resumo?.apurada),
    'o fechamento do período (tela) e o relatório publicam o MESMO número apurado',
  );

  // ---- 3) Baixa PARCIAL: efetiva a parte proporcional ---------------------
  const lancamentos = await req(baseUrl, 'GET', `/lancamentos_financeiros?page=1&pageSize=50&f.referencia_id=${vendaId}&f.referencia_tipo=venda`, undefined, token);
  assert.equal(lancamentos.status, 200, `parcelas da venda: ${lancamentos.texto}`);
  const parcela = (lancamentos.body?.rows || [])[0];
  assert.ok(parcela, 'a venda faturada gera conta a receber');

  const parcial = await req(baseUrl, 'POST', `/financeiro/lancamentos/${Number(parcela.id)}/baixar`, { valor: 400 }, token);
  assert.equal(parcial.status, 200, `baixa parcial: ${parcial.texto}`);

  const livroParcial = await req(baseUrl, 'GET', `/financeiro/comissoes/venda/${vendaId}`, undefined, token);
  assert.equal(livroParcial.status, 200, `livro da venda: ${livroParcial.texto}`);
  assert.equal(reais(livroParcial.body?.apurada), 100);
  assert.equal(reais(livroParcial.body?.efetivada), 40, '10% dos R$ 400 recebidos');
  assert.equal(reais(livroParcial.body?.pendente), 60, 'o que ainda não entrou continua pendente');
  assert.equal(livroParcial.body?.eventos?.length, 1);
  assert.equal(String(livroParcial.body?.eventos?.[0]?.tipo), 'realizada');
  assert.equal(reais(livroParcial.body?.eventos?.[0]?.base), 400, 'a base do evento é o RECEBIDO, não o total da venda');

  // ---- 4) Quitação: fecha a apuração, sem efetivar além dela --------------
  const quitacao = await req(baseUrl, 'POST', `/financeiro/lancamentos/${Number(parcela.id)}/baixar`, { valor: 600 }, token);
  assert.equal(quitacao.status, 200, `quitação: ${quitacao.texto}`);

  const livroQuitado = await req(baseUrl, 'GET', `/financeiro/comissoes/venda/${vendaId}`, undefined, token);
  assert.equal(reais(livroQuitado.body?.efetivada), 100, '40 + 60 = apuração integral');
  assert.equal(reais(livroQuitado.body?.pendente), 0);

  const resumoRecebido = await req(baseUrl, 'GET', `/financeiro/comissoes?${periodo}`, undefined, token);
  const linhaRecebida = (resumoRecebido.body?.linhas || []).find((l: any) => Number(l.representante_id) === representanteId);
  assert.equal(reais(linhaRecebida?.efetivada), 100, 'o que a tela mostra como comissão devida é o recebido');
  assert.equal(reais(linhaRecebida?.saldo), 100);

  // ---- 5) Cancelamento da venda: ESTORNO no livro, histórico preservado ---
  const cancelada = await req(baseUrl, 'PUT', `/vendas/${vendaId}`, { status: 'cancelada' }, token);
  assert.equal(cancelada.status, 200, `cancelamento: ${cancelada.texto}`);

  const livroEstornado = await req(baseUrl, 'GET', `/financeiro/comissoes/venda/${vendaId}`, undefined, token);
  assert.equal(reais(livroEstornado.body?.efetivada), 0, 'estorno devolve o que havia sido efetivado');
  assert.equal(livroEstornado.body?.eventos?.length, 3, 'os eventos anteriores continuam no livro (nada é apagado)');
  assert.equal(String(livroEstornado.body?.eventos?.[2]?.tipo), 'estornada', 'o último evento é o estorno');

  const eventoEstorno = await cliente.query(
    `SELECT count(*)::int AS n, COALESCE(sum(valor), 0) AS total FROM comissoes_eventos WHERE venda_id = $1 AND tipo = 'estornada'`,
    [vendaId],
  );
  assert.equal(Number(eventoEstorno.rows[0].n), 1, 'o estorno é UM evento persistido');
  assert.equal(reais(eventoEstorno.rows[0].total), 100, 'e estorna exatamente o que foi efetivado');

  const resumoCancelado = await req(baseUrl, 'GET', `/financeiro/comissoes?${periodo}`, undefined, token);
  const linhaCancelada = (resumoCancelado.body?.linhas || []).find((l: any) => Number(l.representante_id) === representanteId);
  assert.equal(reais(linhaCancelada?.apurada), 0, 'venda cancelada não deixa comissão apurada');
  assert.equal(reais(linhaCancelada?.estornada), 100, 'e o estorno aparece separado, não escondido');
  assert.equal(reais(linhaCancelada?.saldo), 0, 'saldo do representante zerado');

  // Nenhuma operação legítima pode ter virado erro interno do servidor.
  assert.doesNotMatch(logs(), /Erro interno do servidor/, 'nenhuma operação deste fluxo pode virar 500');
});
