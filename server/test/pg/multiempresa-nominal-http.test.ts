// ============================================================================
// P1-02 — ISOLAMENTO A × B PELA API HTTP, EM POSTGRESQL REAL.
//
// O teste de serviço (`server/test/multiempresa-nominal.test.ts`) prova o
// recorte para os 22 recursos. Este arquivo fecha a outra metade da exigência —
// a camada HTTP — para os 10 recursos do gap que POSSUEM rota pública
// (`getPublicResource`), contra servidor real e banco novo:
//
//   A cria (201) → A lê (200) → B lê (404) → B não vê na lista → B altera (404)
//   → B exclui (404) → A continua alterando (200) e excluindo (200).
//
// Nada de mock: a criação passa por `POST /api/:recurso` (validação, RBAC,
// carimbo de `empresa_id`), a leitura por `GET`, e cada resposta de B é
// conferida contra o registro que A continua enxergando.
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import type { Readable } from 'node:stream';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
const RODADA = `p102${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
type Child = ChildProcessByStdio<null, Readable, Readable>;
type Resposta = { status: number; body: any; texto: string };

function nomeDoBancoNovo(): string {
  return `brobond_p102_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 60);
}

function urlDoBanco(nome: string): string {
  const url = new URL(String(process.env.DATABASE_URL));
  url.pathname = `/${nome}`;
  return url.toString();
}

async function reservePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const endereco = srv.address();
  if (!endereco || typeof endereco === 'string') throw new Error('Não foi possível reservar porta TCP.');
  const porta = endereco.port;
  await new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
  return porta;
}

async function startRealServer(porta: number, databaseUrl: string): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(porta),
    DATABASE_URL: databaseUrl,
    JWT_SECRET: randomUUID(),
    ADMIN_EMAIL: `p102-bootstrap-${randomUUID().slice(0, 8)}@example.test`,
    ADMIN_PASSWORD: `P102-${randomUUID()}-OnlyForTest`,
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let saida = '';
  const anexar = (pedaco: string | Buffer) => { saida = `${saida}${String(pedaco)}`.slice(-40_000); };
  child.stdout.on('data', anexar);
  child.stderr.on('data', anexar);
  const baseUrl = `http://127.0.0.1:${porta}`;
  const prazo = Date.now() + 120_000;
  while (Date.now() < prazo) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`O servidor encerrou antes do health check.\n${saida}`);
    try {
      const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (r.ok) {
        const h = (await r.json()) as { ok?: boolean; db?: string };
        if (h.ok === true && h.db === 'postgres') return { child, baseUrl, logs: () => saida };
      }
    } catch {
      // migrations do banco novo ainda rodando
    }
    await delay(200);
  }
  throw new Error(`Health check não confirmou db=postgres em 120 s.\n${saida}`);
}

async function stopServer(child: Child): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGTERM');
  });
}

async function req(baseUrl: string, metodo: string, rota: string, corpo?: unknown, token?: string): Promise<Resposta> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (corpo !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${baseUrl}/api${rota}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  let body: any = null;
  try { body = JSON.parse(texto); } catch { body = null; }
  return { status: r.status, body, texto };
}

test('P1-02 HTTP/PostgreSQL: A × B nos 10 recursos públicos do gap', { skip }, async (t) => {
  const nome = nomeDoBancoNovo();
  const admin = new Client({ connectionString: String(process.env.DATABASE_URL) });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${nome}`);
  await admin.end();

  const databaseUrl = urlDoBanco(nome);
  const porta = await reservePort();
  const { child, baseUrl, logs } = await startRealServer(porta, databaseUrl);

  const cliente = new Client({ connectionString: databaseUrl });
  await cliente.connect();
  const escalar = async (sql: string, params: unknown[] = []) => (await cliente.query(sql, params)).rows[0];

  t.after(async () => {
    await cliente.end().catch(() => undefined);
    await stopServer(child);
    const limpeza = new Client({ connectionString: String(process.env.DATABASE_URL) });
    await limpeza.connect().catch(() => undefined);
    await limpeza.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`).catch(() => undefined);
    await limpeza.end().catch(() => undefined);
  });

  // ---- Duas empresas e um gerente em cada uma ----------------------------
  const idA = Number((await escalar(`INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id`, [`P102 A ${RODADA}`])).id);
  const idB = Number((await escalar(`INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id`, [`P102 B ${RODADA}`])).id);
  assert.notEqual(idA, idB);

  const { hashPassword } = await import('../../src/password');
  const senha = `P102-${randomUUID()}!`;
  const senhaHash = await hashPassword(senha);

  const criarUsuario = async (empresaId: number, rotulo: string): Promise<{ token: string }> => {
    const email = `${RODADA}-${rotulo}@example.test`;
    await cliente.query(
      `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
       VALUES ($1, $2, $3, 'gerente', true, $4, false, false, false, now())`,
      [`Gerente ${rotulo} ${RODADA}`, email, senhaHash, empresaId],
    );
    await cliente.query(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id) SELECT id, $2 FROM usuarios WHERE email = $1 ON CONFLICT DO NOTHING`,
      [email, empresaId],
    );
    const login = await req(baseUrl, 'POST', '/auth/login', { email, password: senha });
    assert.equal(login.status, 200, `login ${rotulo}: ${login.texto}`);
    const token = String(login.body?.token || '');
    assert.ok(token.length > 20, `login ${rotulo} precisa emitir JWT`);
    return { token };
  };

  const usuarioA = await criarUsuario(idA, 'a');
  const usuarioB = await criarUsuario(idB, 'b');

  // Cada token opera a empresa DELE (claim `emp` assinado, revalidado a cada
  // requisição contra `usuario_empresas`).
  assert.equal(Number((await req(baseUrl, 'GET', '/empresas/ativa', undefined, usuarioA.token)).body?.empresa_id), idA);
  assert.equal(Number((await req(baseUrl, 'GET', '/empresas/ativa', undefined, usuarioB.token)).body?.empresa_id), idB);

  const A = (metodo: string, rota: string, corpo?: unknown) => req(baseUrl, metodo, rota, corpo, usuarioA.token);
  const B = (metodo: string, rota: string, corpo?: unknown) => req(baseUrl, metodo, rota, corpo, usuarioB.token);

  await t.test('os 11 recursos internos do gap não têm rota pública (nem para o dono)', async () => {
    for (const interno of [
      'fornecedor_contatos', 'produto_composicao', 'documentos_fiscais_eventos',
      'importacoes_nfe', 'listas_preco_historico', 'proposta_itens', 'proposta_eventos',
      'compra_recebimento_itens', 'print_pairing_codes', 'print_agent_nonces', 'print_terminals',
    ]) {
      const resposta = await A('GET', `/${interno}`);
      assert.equal(resposta.status, 404, `${interno} não deve ser exposto no CRUD genérico`);
    }
  });

  // ---- Fixtures de apoio (todas criadas pela empresa A) ------------------
  const fornecedor = await A('POST', '/fornecedores', { nome: `Fornecedor ${RODADA}`, pessoa: 'pj', indicador_ie: '1' });
  assert.equal(fornecedor.status, 201, `fornecedor: ${fornecedor.texto}`);

  const clienteRes = await A('POST', '/clientes', { nome: `Cliente ${RODADA}`, pessoa: 'pj' });
  assert.equal(clienteRes.status, 201, `cliente: ${clienteRes.texto}`);

  const conta1 = await A('POST', '/contas_financeiras', { nome: `Conta A ${RODADA}`, tipo: 'banco', saldo_inicial: 1000 });
  const conta2 = await A('POST', '/contas_financeiras', { nome: `Conta B ${RODADA}`, tipo: 'banco', saldo_inicial: 0 });
  assert.equal(conta1.status, 201, `conta 1: ${conta1.texto}`);
  assert.equal(conta2.status, 201, `conta 2: ${conta2.texto}`);

  const representante = await A('POST', '/representantes', { nome: `Representante ${RODADA}` });
  assert.ok([200, 201].includes(representante.status), `representante: ${representante.texto}`);

  const hoje = new Date().toISOString().slice(0, 10);
  const venda = await A('POST', '/vendas', { cliente_id: Number(clienteRes.body.id), data: hoje, status: 'aberta' });
  assert.ok([200, 201].includes(venda.status), `venda: ${venda.texto}`);

  type Caso = { recurso: string; criar: () => Promise<Resposta>; patch: Record<string, unknown>; criarParaExcluir?: () => Promise<Resposta> };
  const casos: Caso[] = [
    {
      recurso: 'regras_fiscais',
      criar: () => A('POST', '/regras_fiscais', { nome: `Regra ${RODADA}`, operacao: 'saida' }),
      patch: { nome: `Regra ${RODADA} (A)` },
    },
    {
      recurso: 'categorias_financeiras',
      criar: () => A('POST', '/categorias_financeiras', { nome: `Categoria ${RODADA}`, tipo: 'despesa' }),
      patch: { nome: `Categoria ${RODADA} (A)` },
    },
    {
      recurso: 'investidores',
      criar: () => A('POST', '/investidores', { nome: `Investidor ${RODADA}` }),
      patch: { nome: `Investidor ${RODADA} (A)` },
    },
    {
      recurso: 'aportes',
      criar: async () => {
        const investidor = await A('POST', '/investidores', { nome: `Inv aporte ${RODADA}` });
        assert.equal(investidor.status, 201, `investidor do aporte: ${investidor.texto}`);
        return A('POST', '/aportes', {
          investidor_id: Number(investidor.body.id), data: hoje, tipo: 'aporte', valor: 100, status: 'previsto',
        });
      },
      patch: { observacoes: 'aporte revisado pela empresa A' },
    },
    {
      recurso: 'recorrencias_financeiras',
      criar: () => A('POST', '/recorrencias_financeiras', {
        descricao: `Recorrência ${RODADA}`, tipo: 'despesa', valor: 250, frequencia: 'mensal', status: 'ativo',
      }),
      patch: { descricao: `Recorrência ${RODADA} (A)` },
    },
    {
      recurso: 'centros_custo',
      criar: () => A('POST', '/centros_custo', { codigo: `CC-${RODADA}`.slice(0, 24), nome: `Centro ${RODADA}` }),
      patch: { nome: `Centro ${RODADA} (A)` },
    },
    {
      recurso: 'transferencias_financeiras',
      criar: () => A('POST', '/transferencias_financeiras', {
        data: hoje, conta_origem_id: Number(conta1.body.id), conta_destino_id: Number(conta2.body.id), valor: 10, status: 'confirmado',
      }),
      patch: { descricao: 'transferência revisada pela empresa A' },
      // Transferência CONFIRMADA não é apagável (o ERP exige cancelar, que
      // estorna o par preservando o histórico) — a exclusão do dono usa uma
      // segunda transferência já cancelada.
      criarParaExcluir: () => A('POST', '/transferencias_financeiras', {
        data: hoje, conta_origem_id: Number(conta1.body.id), conta_destino_id: Number(conta2.body.id), valor: 5, status: 'cancelado',
      }),
    },
    {
      recurso: 'planos_comissao',
      criar: () => A('POST', '/planos_comissao', { nome: `Plano ${RODADA}`, vigencia_inicio: hoje, padrao: false }),
      patch: { nome: `Plano ${RODADA} (A)` },
    },
    {
      recurso: 'regras_comissao',
      criar: async () => {
        const plano = await A('POST', '/planos_comissao', { nome: `Plano regra ${RODADA}`, vigencia_inicio: hoje, padrao: false });
        assert.equal(plano.status, 201, `plano da regra: ${plano.texto}`);
        return A('POST', '/regras_comissao', {
          plano_id: Number(plano.body.id), escopo: 'geral', tipo_valor: 'percentual', valor: 5, base: 'bruto',
        });
      },
      patch: { observacoes: 'regra revisada pela empresa A' },
    },
    {
      recurso: 'venda_atribuicao',
      criar: () => A('POST', '/venda_atribuicao', { venda_id: Number(venda.body.id), representante_id: Number(representante.body.id) }),
      patch: { papel: 'secundario' },
    },
  ];

  assert.equal(casos.length, 10, 'os 10 recursos do gap com rota pública');

  for (const caso of casos) {
    await t.test(`${caso.recurso}: B não lê, não lista, não altera e não exclui o registro de A`, async () => {
      // Criação pela A passa pelo caminho real (validação + RBAC + carimbo).
      const criado = await caso.criar();
      assert.equal(criado.status, 201, `${caso.recurso} (POST por A): ${criado.texto}`);
      const id = Number(criado.body?.id);
      assert.ok(id > 0, `${caso.recurso}: id devolvido`);
      assert.equal(Number(criado.body?.empresa_id), idA, `${caso.recurso}: carimbado com a empresa A`);

      const lidoA = await A('GET', `/${caso.recurso}/${id}`);
      assert.equal(lidoA.status, 200, `${caso.recurso} (GET por A): ${lidoA.texto}`);
      const antes = JSON.stringify(lidoA.body);

      // --- B: leitura direta e listagem ---
      const lidoB = await B('GET', `/${caso.recurso}/${id}`);
      assert.equal(lidoB.status, 404, `${caso.recurso}: B não lê o registro de A (${lidoB.status} ${lidoB.texto})`);

      const listaB = await B('GET', `/${caso.recurso}?page=1&pageSize=500&f.id=${id}`);
      assert.equal(listaB.status, 200, `${caso.recurso}: listagem de B responde: ${listaB.texto}`);
      assert.equal(
        (listaB.body?.rows ?? []).some((row: any) => Number(row.id) === id),
        false,
        `${caso.recurso}: o registro de A não aparece na listagem de B`,
      );
      assert.equal(Number(listaB.body?.total ?? -1), 0, `${caso.recurso}: filtro por id não vaza total de A`);

      // --- B: escrita e exclusão ---
      const alteradoB = await B('PUT', `/${caso.recurso}/${id}`, caso.patch);
      assert.equal(alteradoB.status, 404, `${caso.recurso}: B não altera o registro de A (${alteradoB.status} ${alteradoB.texto})`);

      const excluidoB = await B('DELETE', `/${caso.recurso}/${id}`);
      assert.equal(excluidoB.status, 404, `${caso.recurso}: B não exclui o registro de A (${excluidoB.status} ${excluidoB.texto})`);

      const depoisB = await A('GET', `/${caso.recurso}/${id}`);
      assert.equal(depoisB.status, 200, `${caso.recurso}: o registro continua existindo para A`);
      assert.equal(JSON.stringify(depoisB.body), antes, `${caso.recurso}: nada mudou depois das tentativas de B`);

      // --- A continua operando o próprio registro ---
      const alteradoA = await A('PUT', `/${caso.recurso}/${id}`, caso.patch);
      assert.equal(alteradoA.status, 200, `${caso.recurso}: A altera o próprio registro (${alteradoA.texto})`);
      for (const [campo, valor] of Object.entries(caso.patch)) {
        assert.equal(String(alteradoA.body?.[campo] ?? ''), String(valor), `${caso.recurso}.${campo} gravado para A`);
      }

      let idExcluido = id;
      if (caso.criarParaExcluir) {
        const alvo = await caso.criarParaExcluir();
        assert.equal(alvo.status, 201, `${caso.recurso} (registro para exclusão): ${alvo.texto}`);
        idExcluido = Number(alvo.body.id);
      }
      const excluidoA = await A('DELETE', `/${caso.recurso}/${idExcluido}`);
      assert.equal(excluidoA.status, 200, `${caso.recurso}: A exclui o próprio registro (${excluidoA.texto})`);
      assert.equal((await A('GET', `/${caso.recurso}/${idExcluido}`)).status, 404, `${caso.recurso}: sumiu para A depois do delete`);
    });
  }

  // ---- Recurso público SOMENTE LEITURA (o 11º do gap com rota) -----------
  await t.test('inutilizacoes_fiscais (somente leitura): B não lê nem lista o registro de A', async () => {
    const linha = await escalar(
      `INSERT INTO inutilizacoes_fiscais (empresa_id, serie, numero_inicial, numero_final, justificativa)
       VALUES ($1, 1, 1, 2, $2) RETURNING id`,
      [idA, `inutilização ${RODADA}`],
    );
    const id = Number(linha.id);

    const lidoA = await A('GET', `/inutilizacoes_fiscais/${id}`);
    assert.equal(lidoA.status, 200, `A lê a inutilização da própria empresa: ${lidoA.texto}`);
    const antes = JSON.stringify(lidoA.body);

    assert.equal((await B('GET', `/inutilizacoes_fiscais/${id}`)).status, 404, 'B não lê a inutilização de A');

    const listaB = await B('GET', `/inutilizacoes_fiscais?page=1&pageSize=500&f.id=${id}`);
    assert.equal(listaB.status, 200, `listagem de B: ${listaB.texto}`);
    assert.equal((listaB.body?.rows ?? []).some((row: any) => Number(row.id) === id), false, 'não aparece para B');
    assert.equal(Number(listaB.body?.total ?? -1), 0);

    // Escrita: o recurso é somente leitura para TODO MUNDO (contrato), não só
    // para B — o 405 é anterior ao recorte de empresa e não é o que prova o
    // isolamento; o que o prova são a leitura e a listagem acima.
    const escritaB = await B('PUT', `/inutilizacoes_fiscais/${id}`, { justificativa: 'B tentou' });
    assert.ok(escritaB.status >= 400, `B não escreve neste recurso (${escritaB.status})`);
    assert.equal((await A('GET', `/inutilizacoes_fiscais/${id}`)).status, 200);
    assert.equal(JSON.stringify((await A('GET', `/inutilizacoes_fiscais/${id}`)).body), antes, 'nada mudou');

    await cliente.query(`DELETE FROM inutilizacoes_fiscais WHERE id = $1`, [id]);
  });

  await t.test('as fixtures da empresa A também estão fora do alcance de B', async () => {
    for (const [recurso, id] of [
      ['fornecedores', Number(fornecedor.body.id)],
      ['clientes', Number(clienteRes.body.id)],
      ['contas_financeiras', Number(conta1.body.id)],
      ['representantes', Number(representante.body.id)],
      ['vendas', Number(venda.body.id)],
    ] as [string, number][]) {
      assert.equal((await B('GET', `/${recurso}/${id}`)).status, 404, `B não lê ${recurso}#${id} de A`);
    }
    assert.equal(logs().includes('UnhandledPromiseRejection'), false, 'o servidor não registrou rejeição não tratada');
  });

  // ---- A trilha de auditoria não guarda lançamento de uma empresa na outra -
  await t.test('nenhum evento de auditoria da empresa A é visível para B', async () => {
    const eventos = await escalar(
      `SELECT count(*)::int AS total FROM auditoria WHERE empresa_id = $1`,
      [idA],
    );
    assert.ok(Number(eventos?.total ?? 0) > 0, 'a empresa A gerou eventos de auditoria nesta rodada');
    const respostaB = await B('GET', `/auditoria?page=1&pageSize=500&f.empresa_id=${idA}`);
    // Duas recusas legítimas: o RBAC barra a trilha para o perfil do gerente
    // (403) ou o recorte de empresa devolve lista vazia (200). O que NÃO pode
    // acontecer é B enxergar um único evento da empresa A.
    assert.ok([403, 200].includes(respostaB.status), `auditoria para B: ${respostaB.status} ${respostaB.texto}`);
    if (respostaB.status === 200) {
      assert.deepEqual(respostaB.body?.rows ?? [], [], 'B não vê a auditoria de A mesmo filtrando por empresa_id');
    }
  });
});
