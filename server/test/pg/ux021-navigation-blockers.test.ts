// ============================================================================
// ERP-UX-02.1 — prova HTTP em PostgreSQL real dos bloqueadores P0.
//
// Sem DATABASE_URL este arquivo FALHA. A suíte em memória prova os handlers;
// aqui o servidor real prova sessão, `requireAuth`, rotas, persistência e o
// isolamento A↔B com linhas carregadas do PostgreSQL.
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
  throw new Error('ux021-navigation-blockers.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { query } = await import('../../src/db');
const { hashPassword } = await import('../../src/password');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;
const RODADA = `ux021${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

function nomeDoBancoNovo(): string {
  return `brobond_ux021_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 60);
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
  if (!address || typeof address === 'string') throw new Error('Não foi possível reservar porta TCP.');
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
    ADMIN_EMAIL: `ux021-bootstrap-${randomUUID().slice(0, 8)}@example.test`,
    ADMIN_PASSWORD: `UX021-${randomUUID()}-OnlyForTest`,
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk: string | Buffer) => { output = `${output}${String(chunk)}`.slice(-40_000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Servidor encerrou antes do health.\n${output}`);
    try {
      const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (r.ok) {
        const h = (await r.json()) as { ok?: boolean; db?: string };
        if (h.ok === true && h.db === 'postgres') return { child, baseUrl, logs: () => output };
      }
    } catch { /* boot/migrations */ }
    await delay(200);
  }
  throw new Error(`Health não confirmou db=postgres em 120s.\n${output}`);
}

async function stopServer(child: Child): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGTERM');
  });
}

type Resposta = { status: number; body: any; texto: string; headers: Headers };
async function req(baseUrl: string, metodo: string, rota: string, corpo?: unknown, token?: string): Promise<Resposta> {
  const headers: Record<string, string> = { accept: 'application/json, image/png, application/pdf' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (corpo !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${baseUrl}/api${rota}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  let body: any = null;
  try { body = JSON.parse(texto); } catch { body = texto; }
  return { status: r.status, body, texto, headers: r.headers };
}

async function criarUsuario(cliente: Client, empresaId: number, perfil: 'admin' | 'gerente' | 'operador', rotulo: string) {
  const email = `${rotulo}-${RODADA}@example.test`;
  const senha = `UX021-${randomUUID()}!`;
  const hash = await hashPassword(senha);
  const r = await cliente.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1,$2,$3,$4,true,$5,false,false,false,now()) RETURNING id`,
    [`${rotulo} ${RODADA}`, email, hash, perfil, empresaId],
  );
  await cliente.query('INSERT INTO usuario_empresas (usuario_id, empresa_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [r.rows[0].id, empresaId]);
  return { id: Number(r.rows[0].id), email, senha };
}

test('UX02.1/P0: HTTP real separa tenant, perfil, URL/API e jornada PDV', async (t) => {
  const nomeBanco = nomeDoBancoNovo();
  await query(`CREATE DATABASE ${nomeBanco}`);
  const databaseUrl = urlDoBanco(nomeBanco);
  const porta = await reservePort();
  const { child, baseUrl, logs } = await startRealServer(porta, databaseUrl);
  const cliente = new Client({ connectionString: databaseUrl });
  await cliente.connect();
  t.after(async () => {
    await cliente.end().catch(() => undefined);
    await stopServer(child);
    await query(`DROP DATABASE IF EXISTS ${nomeBanco} WITH (FORCE)`).catch(() => undefined);
  });

  const empresaB = await cliente.query(`INSERT INTO empresas (nome, razao_social, ativo) VALUES ($1,$2,true) RETURNING id`, [`Empresa B ${RODADA}`, `Empresa B ${RODADA} LTDA`]);
  const empresaBId = Number(empresaB.rows[0].id);
  assert.ok(empresaBId > 1);

  // Sequencial de propósito: `hashPassword` é CPU-bound e cinco hashes em
  // paralelo podem atrasar o login o bastante para o harness reutilizar um
  // token já rotacionado pela sessão anterior. A ordem também é a ordem de
  // login abaixo, o que deixa a evidência reproduzível.
  const aAdmin = await criarUsuario(cliente, 1, 'admin', 'a-admin');
  const aGerente = await criarUsuario(cliente, 1, 'gerente', 'a-gerente');
  const aOperador = await criarUsuario(cliente, 1, 'operador', 'a-operador');
  const bGerente = await criarUsuario(cliente, empresaBId, 'gerente', 'b-gerente');
  const bOperador = await criarUsuario(cliente, empresaBId, 'operador', 'b-operador');

  const tokens = new Map<string, string>();
  for (const u of [aGerente, aOperador, bGerente, bOperador]) {
    const login = await req(baseUrl, 'POST', '/auth/login', { email: u.email, password: u.senha });
    assert.equal(login.status, 200, `login ${u.email}: ${login.texto}`);
    assert.ok(login.body.token, `login sem token de acesso para ${u.email}: ${login.texto}`);
    tokens.set(u.email, String(login.body.token));
  }
  // Admin real: o primeiro login devolve o desafio de cadastro de MFA.
  // Concluímos o fluxo real (desafio -> TOTP -> sessão) para não trocar o
  // gate por um token fabricado no teste.
  const adminLogin = await req(baseUrl, 'POST', '/auth/login', { email: aAdmin.email, password: aAdmin.senha });
  assert.equal(adminLogin.status, 200, `login admin: ${adminLogin.texto}`);
  assert.equal(adminLogin.body.mfa_setup_required, true, `admin sem MFA deve entrar no cadastro guiado: ${adminLogin.texto}`);
  const desafio = await req(baseUrl, 'POST', '/auth/mfa/desafio', { mfa_ticket: adminLogin.body.mfa_ticket });
  assert.equal(desafio.status, 200, `desafio MFA admin: ${desafio.texto}`);
  const { codigoTOTP } = await import('../../src/totp');
  const adminMfa = await req(baseUrl, 'POST', '/auth/login/mfa', { mfa_ticket: adminLogin.body.mfa_ticket, codigo: codigoTOTP(String(desafio.body.segredo)) });
  assert.equal(adminMfa.status, 200, `login MFA admin: ${adminMfa.texto}`);
  assert.ok(adminMfa.body.token, 'login MFA do admin deve emitir access token');
  tokens.set(aAdmin.email, String(adminMfa.body.token));

  const tok = (u: { email: string }) => tokens.get(u.email)!;

  // Seed mínimo por SQL apenas para representar linhas já existentes. Todas as
  // operações sob auditoria abaixo passam pela API real.
  const stamp = RODADA;
  const cliA = await cliente.query(`INSERT INTO clientes (empresa_id,nome,tipo,ativo) VALUES (1,$1,'pf',true) RETURNING id`, [`Cliente A ${stamp}`]);
  const cliB = await cliente.query(`INSERT INTO clientes (empresa_id,nome,tipo,ativo) VALUES ($1,$2,'pf',true) RETURNING id`, [empresaBId, `Cliente B ${stamp}`]);
  const catA = await cliente.query(`INSERT INTO catalogos (empresa_id,nome,token,ativo) VALUES (1,$1,$2,true) RETURNING id`, [`Catálogo A ${stamp}`, `cat-a-${stamp}`]);
  const catB = await cliente.query(`INSERT INTO catalogos (empresa_id,nome,token,ativo) VALUES ($1,$2,$3,true) RETURNING id`, [empresaBId, `Catálogo B ${stamp}`, `cat-b-${stamp}`]);
  const prodA = await cliente.query(`INSERT INTO produtos (empresa_id,sku,nome,preco_venda,ativo) VALUES (1,$1,'Produto A UX021',10,true) RETURNING id`, [`A-${stamp}`]);
  const prodB = await cliente.query(`INSERT INTO produtos (empresa_id,sku,nome,preco_venda,ativo) VALUES ($1,$2,'Produto B UX021',20,true) RETURNING id`, [empresaBId, `B-${stamp}`]);
  const ordemA = await cliente.query(`INSERT INTO ordens_fabricacao (empresa_id,produto_id,tipo,quantidade,status) VALUES (1,$1,'grade',3,'planejada') RETURNING id`, [prodA.rows[0].id]);
  const ordemB = await cliente.query(`INSERT INTO ordens_fabricacao (empresa_id,produto_id,tipo,quantidade,status) VALUES ($1,$2,'grade',3,'planejada') RETURNING id`, [empresaBId, prodB.rows[0].id]);
  const vendaA = await cliente.query(`INSERT INTO vendas (empresa_id,cliente_id,data,status,total) VALUES (1,$1,'2026-10-13','aberta',10) RETURNING id`, [cliA.rows[0].id]);
  const vendaB = await cliente.query(`INSERT INTO vendas (empresa_id,cliente_id,data,status,total) VALUES ($1,$2,'2026-10-13','aberta',20) RETURNING id`, [empresaBId, cliB.rows[0].id]);
  const compraA = await cliente.query(`INSERT INTO compras (empresa_id,data,status,total) VALUES (1,'2026-10-13','pendente',10) RETURNING id`);
  const compraB = await cliente.query(`INSERT INTO compras (empresa_id,data,status,total) VALUES ($1,'2026-10-13','pendente',20) RETURNING id`, [empresaBId]);
  const shareA = await cliente.query(`INSERT INTO catalogo_compartilhamentos (catalogo_id,cliente_id,usuario_id,token_hash,canal,acessos) VALUES ($1,$2,$3,$4,'link',0) RETURNING id`, [catA.rows[0].id, cliA.rows[0].id, aGerente.id, `share-a-${stamp}`]);
  const shareB = await cliente.query(`INSERT INTO catalogo_compartilhamentos (catalogo_id,cliente_id,usuario_id,token_hash,canal,acessos) VALUES ($1,$2,$3,$4,'link',0) RETURNING id`, [catB.rows[0].id, cliB.rows[0].id, bGerente.id, `share-b-${stamp}`]);
  const localA = await cliente.query(`INSERT INTO locais (empresa_id,nome,tipo,ativo,padrao) VALUES (1,'loja ux021 a','loja',true,true) RETURNING id`);
  await cliente.query(`INSERT INTO locais (empresa_id,nome,tipo,ativo,padrao) VALUES ($1,'loja ux021 b','loja',true,true)`, [empresaBId]);
  const tam = await cliente.query(`INSERT INTO tamanhos (codigo,descricao,ordem) VALUES ('UX021','UX021',99) ON CONFLICT (codigo) DO UPDATE SET descricao=EXCLUDED.descricao RETURNING id`).catch(async () => cliente.query(`INSERT INTO tamanhos (codigo,descricao,ordem) VALUES ('UX021','UX021',99) RETURNING id`));
  await cliente.query(`INSERT INTO estoques (empresa_id,produto_id,tamanho_id,local,local_id,quantidade) VALUES (1,$1,$2,'loja ux021 a',$3,20)`, [prodA.rows[0].id, tam.rows[0].id, localA.rows[0].id]);

  await t.test('P0-01 tenant: A não lê/escreve B e B não lê/escreve A nas seis superfícies', async () => {
    assert.equal((await req(baseUrl, 'GET', `/clientes/${cliA.rows[0].id}/portal-acessos`, undefined, tok(aGerente))).status, 200);
    assert.equal((await req(baseUrl, 'GET', `/clientes/${cliB.rows[0].id}/portal-acessos`, undefined, tok(aGerente))).status, 404);
    assert.equal((await req(baseUrl, 'POST', `/clientes/${cliB.rows[0].id}/portal-acessos`, { validade_dias: 1 }, tok(aGerente))).status, 404);
    assert.equal((await req(baseUrl, 'GET', `/clientes/${cliA.rows[0].id}/portal-acessos`, undefined, tok(bGerente))).status, 404);

    assert.equal((await req(baseUrl, 'POST', `/catalogos/${catA.rows[0].id}/compartilhar`, { cliente_id: cliA.rows[0].id }, tok(aGerente))).status, 200);
    assert.equal((await req(baseUrl, 'POST', `/catalogos/${catA.rows[0].id}/compartilhar`, { cliente_id: cliB.rows[0].id }, tok(aGerente))).status, 400);
    assert.equal((await req(baseUrl, 'POST', `/catalogos/${catB.rows[0].id}/compartilhar`, {}, tok(aGerente))).status, 404);
    assert.equal((await req(baseUrl, 'POST', `/catalogos/compartilhamentos/${shareB.rows[0].id}/revogar`, {}, tok(aGerente))).status, 404);
    const intelA = await req(baseUrl, 'GET', '/catalogos/inteligencia', undefined, tok(aGerente));
    assert.equal(intelA.status, 200);
    assert.ok(!intelA.body.recentes.some((x: any) => Number(x.id) === Number(shareB.rows[0].id)));

    assert.equal((await req(baseUrl, 'GET', `/vendas/${vendaB.rows[0].id}/pdf`, undefined, tok(aGerente))).status, 404);
    assert.equal((await req(baseUrl, 'GET', `/compras/${compraA.rows[0].id}/pdf`, undefined, tok(bGerente))).status, 404);
    assert.equal((await req(baseUrl, 'GET', `/produtos/${prodB.rows[0].id}/qrcode/dados`, undefined, tok(aGerente))).status, 404);
    assert.equal((await req(baseUrl, 'GET', `/produtos/${prodA.rows[0].id}/qrcode/dados`, undefined, tok(bGerente))).status, 404);
    assert.equal((await req(baseUrl, 'GET', `/vendas/${vendaB.rows[0].id}/nfe/status`, undefined, tok(aGerente))).status, 404);
    assert.equal((await req(baseUrl, 'GET', `/vendas/${vendaA.rows[0].id}/nfe/dados`, undefined, tok(bGerente))).status, 404);

    assert.equal((await req(baseUrl, 'POST', `/ordens/${ordemA.rows[0].id}/qualidade`, { etapa: 'corte', defeito: 'furo', quantidade: 1 }, tok(aGerente))).status, 201);
    assert.equal((await req(baseUrl, 'POST', `/ordens/${ordemA.rows[0].id}/qualidade`, { etapa: 'corte', defeito: 'furo', quantidade: 1 }, tok(bGerente))).status, 404);
    assert.equal((await req(baseUrl, 'GET', `/ordens/${ordemB.rows[0].id}/qualidade`, undefined, tok(aGerente))).status, 404);
    const relA = await req(baseUrl, 'GET', '/relatorios/qualidade', undefined, tok(aGerente));
    assert.equal(relA.status, 200);
    assert.ok(relA.body.itens.every((x: any) => Number(x.ordem_id) === Number(ordemA.rows[0].id)));
  });

  await t.test('P0-02 perfil: API genérica e conectores seguem menu (admin/gerente/operador)', async () => {
    for (const [rota, metodo, corpo] of [
      ['/listas_preco', 'GET', undefined],
      ['/envios', 'GET', undefined],
    ] as const) {
      assert.equal((await req(baseUrl, metodo, rota, corpo, tok(aOperador))).status, 403, `operador ${rota}`);
      assert.equal((await req(baseUrl, metodo, rota, corpo, tok(aGerente))).status, 200, `gerente ${rota}`);
      const adminResp = await req(baseUrl, metodo, rota, corpo, tok(aAdmin)); assert.equal(adminResp.status, 200, `admin ${rota}: ${adminResp.texto}`);
    }
    assert.equal((await req(baseUrl, 'POST', '/listas_preco', { nome: `Operador ${stamp}` }, tok(aOperador))).status, 403);
    assert.equal((await req(baseUrl, 'GET', '/connectors', undefined, tok(aOperador))).status, 403);
    assert.equal((await req(baseUrl, 'GET', '/connectors/mercadolivre', undefined, tok(aOperador))).status, 403);
    assert.notEqual((await req(baseUrl, 'GET', '/connectors', undefined, tok(aGerente))).status, 403);
  });

  await t.test('P0-03 PDV: gerente abre, operador vende, outra empresa não usa o caixa', async () => {
    const semCaixa = await req(baseUrl, 'GET', '/pdv/caixas/aberto', undefined, tok(aOperador));
    assert.equal(semCaixa.status, 200);
    assert.equal(semCaixa.body.caixa, null);

    const aberto = await req(baseUrl, 'POST', '/pdv/caixas', { numero: `UX021-${stamp}`, valor_abertura: 10, local_id: localA.rows[0].id }, tok(aGerente));
    assert.equal(aberto.status, 201, aberto.texto);
    const caixaId = Number(aberto.body.id);
    const descoberto = await req(baseUrl, 'GET', '/pdv/caixas/aberto', undefined, tok(aOperador));
    assert.equal(descoberto.status, 200);
    assert.equal(Number(descoberto.body.caixa.id), caixaId);

    assert.equal((await req(baseUrl, 'POST', '/pdv/caixas', { numero: 'UX021-OPERADOR', valor_abertura: 1 }, tok(aOperador))).status, 403);
    assert.equal((await req(baseUrl, 'POST', `/pdv/caixas/${caixaId}/movimentos`, { tipo: 'sangria', valor: 1 }, tok(aOperador))).status, 403);
    assert.equal((await req(baseUrl, 'GET', `/pdv/caixas/${caixaId}/resumo`, undefined, tok(aOperador))).status, 403);

    const venda = await req(baseUrl, 'POST', '/pdv/vendas', { caixa_id: caixaId, itens: [{ produto_id: prodA.rows[0].id, tamanho_id: tam.rows[0].id, quantidade: 1, desconto_pct: 0 }], pagamentos: [{ forma: 'dinheiro', valor: 10 }] }, tok(aOperador));
    assert.equal(venda.status, 201, venda.texto);
    assert.equal(Number(venda.body.calculo.total), 10);

    const descobertoB = await req(baseUrl, 'GET', '/pdv/caixas/aberto', undefined, tok(bOperador));
    assert.equal(descobertoB.status, 200);
    assert.equal(descobertoB.body.caixa, null);
    assert.equal((await req(baseUrl, 'POST', '/pdv/vendas', { caixa_id: caixaId, itens: [{ produto_id: prodA.rows[0].id, tamanho_id: tam.rows[0].id, quantidade: 1, desconto_pct: 0 }], pagamentos: [{ forma: 'dinheiro', valor: 10 }] }, tok(bOperador))).status, 404);

    assert.equal((await req(baseUrl, 'POST', `/pdv/caixas/${caixaId}/fechar`, { valor_fechamento: 20 }, tok(aOperador))).status, 403);
    assert.equal((await req(baseUrl, 'POST', `/pdv/caixas/${caixaId}/fechar`, { valor_fechamento: 20 }, tok(aGerente))).status, 200);
    assert.equal((await req(baseUrl, 'GET', '/pdv/caixas/aberto', undefined, tok(aOperador))).body.caixa, null);
  });

  assert.doesNotMatch(logs(), /Erro interno do servidor/, 'nenhuma operação P0 pode virar 500');
});
