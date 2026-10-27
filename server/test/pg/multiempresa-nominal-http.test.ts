// ============================================================================
// MULTIEMPRESA — ISOLAMENTO A × B PELA CAMADA HTTP, em PostgreSQL REAL (P1-02)
//
// O teste de serviço (`server/test/multiempresa-nominal.test.ts`) prova o
// recorte nas quatro operações para os 22 recursos. Este arquivo fecha a outra
// metade da exigência do ciclo: os 10 recursos do P1-02 que POSSUEM rota
// pública (`/api/:resource`) são exercitados PONTA A PONTA contra um servidor
// HTTP real e um banco novo — nada de mocks, nada de modo demonstração.
//
// Para cada recurso, com registro criado pela EMPRESA A:
//   A lê (200) · B lê (404) · B não vê na listagem · B altera (404 e registro
//   intacto) · B exclui (404 e registro intacto) · A altera (200) · A exclui.
//
// E o próprio PostgreSQL é conferido: a linha nasce com `empresa_id` da A e
// NÃO muda de dono depois das tentativas da B.
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
  const address = srv.address();
  if (!address || typeof address === 'string') throw new Error('Não foi possível reservar porta TCP.');
  const porta = address.port;
  await new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
  return porta;
}

type Resposta = { status: number; body: any; texto: string };

/**
 * Compara valores devolvidos pela API sem depender da forma textual do
 * PostgreSQL: NUMERIC chega como "7.0000", boolean como true, data como
 * "2026-01-01T00:00:00.000Z". A igualdade é de VALOR, não de string.
 */
function mesmoValor(obtido: unknown, esperado: unknown): boolean {
  if (obtido === esperado) return true;
  const a = Number(obtido);
  const b = Number(esperado);
  if (Number.isFinite(a) && Number.isFinite(b) && String(esperado).trim() !== '') return a === b;
  return String(obtido ?? '') === String(esperado ?? '');
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
  let output = '';
  const append = (chunk: string | Buffer) => { output = `${output}${String(chunk)}`.slice(-40_000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const baseUrl = `http://127.0.0.1:${porta}`;
  const prazo = Date.now() + 120_000;
  while (Date.now() < prazo) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`O servidor encerrou antes do health check.\n${output}`);
    try {
      const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (r.ok) {
        const h = (await r.json()) as { ok?: boolean; db?: string };
        if (h.ok === true && h.db === 'postgres') return { child, baseUrl, logs: () => output };
      }
    } catch {
      // migrations do banco novo em andamento
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

test('P1-02 HTTP/PostgreSQL: isolamento A × B nos 10 recursos públicos do gap', { skip }, async (t) => {
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
  const empA = await escalar(`INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id`, [`P102 A ${RODADA}`]);
  const empB = await escalar(`INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id`, [`P102 B ${RODADA}`]);
  const idA = Number(empA.id);
  const idB = Number(empB.id);
  assert.notEqual(idA, idB);

  const { hashPassword } = await import('../../src/password');
  const senha = `P102-${randomUUID()}!`;
  const senhaHash = await hashPassword(senha);
  const criarUsuario = async (empresaId: number, rotulo: string) => {
    const email = `${RODADA}-${rotulo}@example.test`;
    await cliente.query(
      `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
       VALUES ($1, $2, $3, 'gerente', true, $4, false, false, false, now())`,
      [`Gerente ${rotulo} ${RODADA}`, email, senhaHash, empresaId],
    );
    await cliente.query(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id)
       SELECT id, $2 FROM usuarios WHERE email = $1 ON CONFLICT DO NOTHING`,
      [email, empresaId],
    );
    const login = await req(baseUrl, 'POST', '/auth/login', { email, password: senha });
    assert.equal(login.status, 200, `login ${rotulo}: ${login.texto}`);
    const token = String(login.body?.token || '');
    assert.ok(token.length > 20, `login ${rotulo} precisa emitir JWT`);
    return { token, email };
  };

  const usuarioA = await criarUsuario(idA, 'a');
  const usuarioB = await criarUsuario(idB, 'b');

  // O token de cada um opera a empresa DELE (claim `emp` assinado).
  const ativaA = await req(baseUrl, 'GET', '/empresas/ativa', undefined, usuarioA.token);
  const ativaB = await req(baseUrl, 'GET', '/empresas/ativa', undefined, usuarioB.token);
  assert.equal(Number(ativaA.body?.empresa_id), idA, `empresa ativa de A: ${ativaA.texto}`);
  assert.equal(Number(ativaB.body?.empresa_id), idB, `empresa ativa de B: ${ativaB.texto}`);

  const A = (metodo: string, rota: string, corpo?: unknown) => req(baseUrl, metodo, rota, corpo, usuarioA.token);
  const B = (metodo: string, rota: string, corpo?: unknown) => req(baseUrl, metodo, rota, corpo, usuarioB.token);

  await t.test('nenhuma rota pública de recurso interno do gap existe (não é porta de entrada)', async () => {
    for (const interno of ['print_terminals', 'print_pairing_codes', 'importacoes_nfe', 'proposta_itens', 'documentos_fiscais_eventos']) {
      const r = await A('GET', `/${interno}`);
      assert.equal(r.status, 404, `${interno} deve continuar fora da API pública: ${r.texto}`);
    }
  });

  // ---- Fixtures compartilhadas (criadas pela empresa A) ------------------
  const forn = await A('POST', '/fornecedores', { nome: `Fornecedor ${RODADA}`, pessoa: 'pj', indicador_ie: '1' });
  assert.equal(forn.status, 201, `fornecedor: ${forn.texto}`);

  const clienteRes = await A('POST', '/clientes', { nome: `Cliente ${RODADA}`, pessoa: 'pj' });
  assert.equal(clienteRes.status, 201, `cliente: ${clienteRes.texto}`);

  const rep = await A('POST', '/representantes', { nome: `Representante ${RODADA}` });
  assert.ok([200, 201].includes(rep.status), `representante: ${rep.texto}`);

  const venda = await A('POST', '/vendas', {
    cliente_id: Number(clienteRes.body.id), data: new Date().toISOString().slice(0, 10), status: 'aberta',
  });
  assert.ok([200, 201].includes(venda.status), `venda: ${venda.texto}`);

  const conta1 = await A('POST', '/contas_financeiras', { nome: `Conta 1 ${RODADA}`, tipo: 'banco' });
  const conta2 = await A('POST', '/contas_financeiras', { nome: `Conta 2 ${RODADA}`, tipo: 'banco' });
  assert.ok([200, 201].includes(conta1.status), `conta 1: ${conta1.texto}`);
  assert.ok([200, 201].includes(conta2.status), `conta 2: ${conta2.texto}`);

  const investidor = await A('POST', '/investidores', { nome: `Investidor ${RODADA}` });
  assert.equal(investidor.status, 201, `investidor: ${investidor.texto}`);

  const plano = await A('POST', '/planos_comissao', { nome: `Plano ${RODADA}`, vigencia_inicio: '2026-01-01', padrao: false });
  assert.equal(plano.status, 201, `plano: ${plano.texto}`);

  // ---- Os 10 recursos públicos do P1-02 ---------------------------------
  type Caso = { recurso: string; criar: () => Promise<Resposta>; patch: Record<string, unknown>; excluivel: boolean };
  const casos: Caso[] = [
    {
      recurso: 'regras_fiscais',
      criar: () => A('POST', '/regras_fiscais', { nome: `Regra ${RODADA}`, operacao: 'saida' }),
      patch: { nome: `Regra ${RODADA} editada` },
      excluivel: true,
    },
    {
      recurso: 'categorias_financeiras',
      criar: () => A('POST', '/categorias_financeiras', { nome: `Categoria ${RODADA}`, tipo: 'despesa' }),
      patch: { cor: '#334455' },
      excluivel: true,
    },
    {
      recurso: 'investidores',
      criar: () => A('POST', '/investidores', { nome: `Investidor caso ${RODADA}` }),
      patch: { email: 'investidor.caso@brobond.test' },
      excluivel: true,
    },
    {
      recurso: 'aportes',
      criar: () => A('POST', '/aportes', {
        investidor_id: Number(investidor.body.id), data: '2026-10-01', tipo: 'aporte', valor: 1000, status: 'previsto',
      }),
      patch: { observacoes: 'editado pela empresa dona' },
      excluivel: true,
    },
    {
      recurso: 'recorrencias_financeiras',
      criar: () => A('POST', '/recorrencias_financeiras', {
        descricao: `Recorrência ${RODADA}`, tipo: 'despesa', valor: 250, frequencia: 'mensal', status: 'ativo',
      }),
      patch: { descricao: `Recorrência ${RODADA} editada` },
      excluivel: true,
    },
    {
      recurso: 'centros_custo',
      criar: () => A('POST', '/centros_custo', { codigo: `CC${RODADA}`.slice(0, 20), nome: `Centro ${RODADA}` }),
      patch: { descricao: 'editado pela empresa dona' },
      excluivel: true,
    },
    {
      recurso: 'transferencias_financeiras',
      criar: () => A('POST', '/transferencias_financeiras', {
        data: '2026-10-10', conta_origem_id: Number(conta1.body.id), conta_destino_id: Number(conta2.body.id), valor: 120, status: 'cancelado',
      }),
      patch: { descricao: 'editada pela empresa dona' },
      excluivel: true,
    },
    {
      recurso: 'planos_comissao',
      criar: () => A('POST', '/planos_comissao', { nome: `Plano caso ${RODADA}`, vigencia_inicio: '2026-01-01', padrao: false }),
      patch: { descricao: 'editado pela empresa dona' },
      excluivel: true,
    },
    {
      recurso: 'regras_comissao',
      criar: () => A('POST', '/regras_comissao', {
        plano_id: Number(plano.body.id), escopo: 'geral', tipo_valor: 'percentual', valor: 5, base: 'bruto',
      }),
      patch: { valor: 7 },
      excluivel: true,
    },
    {
      recurso: 'venda_atribuicao',
      criar: () => A('POST', '/venda_atribuicao', {
        venda_id: Number(venda.body.id), representante_id: Number(rep.body.id),
      }),
      patch: { papel: 'secundario' },
      excluivel: true,
    },
  ];

  assert.equal(casos.length, 10, 'os 10 recursos do gap com rota pública');

  for (const caso of casos) {
    await t.test(`${caso.recurso}: A cria, B não lê/altera/exclui, A altera e exclui`, async (sub) => {
      const criado = await caso.criar();
      assert.equal(criado.status, 201, `${caso.recurso} (criação por A): ${criado.texto}`);
      const id = Number(criado.body?.id);
      assert.ok(id > 0, `${caso.recurso}: id devolvido`);
      assert.equal(Number(criado.body?.empresa_id), idA, `${caso.recurso}: criado na empresa A`);

      const lidoA = await A('GET', `/${caso.recurso}/${id}`);
      assert.equal(lidoA.status, 200, `${caso.recurso}: A lê o próprio registro: ${lidoA.texto}`);

      // B: leitura direta negada com 404 (não 403 — não se confirma existência).
      const lidoB = await B('GET', `/${caso.recurso}/${id}`);
      assert.equal(lidoB.status, 404, `${caso.recurso}: B não lê o registro de A (${lidoB.texto})`);

      // B: listagem sem o registro de A, mesmo filtrando pelo id.
      const listaB = await B('GET', `/${caso.recurso}?page=1&pageSize=500&f.id=${id}`);
      assert.equal(listaB.status, 200, `${caso.recurso}: listagem de B responde: ${listaB.texto}`);
      assert.equal(Number(listaB.body?.total), 0, `${caso.recurso}: total da listagem de B`);
      assert.deepEqual(listaB.body?.rows ?? [], [], `${caso.recurso}: B não vê o registro de A`);

      // B: alteração negada e o registro permanece idêntico.
      const antes = JSON.stringify(lidoA.body);
      const alteradoB = await B('PUT', `/${caso.recurso}/${id}`, caso.patch);
      assert.equal(alteradoB.status, 404, `${caso.recurso}: B não altera o registro de A (${alteradoB.texto})`);
      const depoisB = await A('GET', `/${caso.recurso}/${id}`);
      assert.equal(depoisB.status, 200);
      assert.equal(JSON.stringify(depoisB.body), antes, `${caso.recurso}: tentativa de B não alterou nada`);

      // B: exclusão negada e o registro continua existindo.
      const excluidoB = await B('DELETE', `/${caso.recurso}/${id}`);
      assert.equal(excluidoB.status, 404, `${caso.recurso}: B não exclui o registro de A (${excluidoB.texto})`);
      assert.equal((await A('GET', `/${caso.recurso}/${id}`)).status, 200, `${caso.recurso}: registro intacto para A`);

      // PostgreSQL: a linha nunca saiu da empresa A.
      const linha = await escalar(`SELECT empresa_id FROM ${caso.recurso} WHERE id = $1`, [id]);
      assert.equal(Number(linha?.empresa_id), idA, `${caso.recurso}: empresa_id permanece o da empresa A`);

      // A: ainda pode alterar o próprio registro...
      const alteradoA = await A('PUT', `/${caso.recurso}/${id}`, caso.patch);
      if (caso.recurso === 'transferencias_financeiras') {
        // Transferência cancelada não é reeditável pelo fluxo comercial; a prova
        // de isolamento acima já está feita. Só aceitamos a recusa do PRÓPRIO
        // contrato (nunca 404, que é o código do recorte de empresa).
        assert.notEqual(alteradoA.status, 404, `transferencias: A nunca recebe 404: ${alteradoA.texto}`);
      } else {
        assert.equal(alteradoA.status, 200, `${caso.recurso}: A altera o próprio registro: ${alteradoA.texto}`);
        for (const [campo, valor] of Object.entries(caso.patch)) {
          assert.ok(mesmoValor(alteradoA.body?.[campo], valor), `${caso.recurso}.${campo} gravado para A (veio ${String(alteradoA.body?.[campo])})`);
        }
      }

      // ...e excluir.
      const excluidoA = await A('DELETE', `/${caso.recurso}/${id}`);
      assert.equal(excluidoA.status, 200, `${caso.recurso}: A exclui o próprio registro: ${excluidoA.texto}`);
      assert.equal((await A('GET', `/${caso.recurso}/${id}`)).status, 404, `${caso.recurso}: sumiu para A depois do delete`);
      sub.diagnostic(`${caso.recurso}: ok`);
    });
  }

  // ---- Guarda-corpo: nenhuma das fixtures vazou para a empresa B --------
  await t.test('nenhum registro auxiliar do fluxo A aparece para B', async () => {
    for (const [recurso, id] of [
      ['fornecedores', Number(forn.body.id)],
      ['clientes', Number(clienteRes.body.id)],
      ['representantes', Number(rep.body.id)],
      ['vendas', Number(venda.body.id)],
      ['contas_financeiras', Number(conta1.body.id)],
      ['investidores', Number(investidor.body.id)],
      ['planos_comissao', Number(plano.body.id)],
    ] as [string, number][]) {
      assert.equal((await B('GET', `/${recurso}/${id}`)).status, 404, `B não lê ${recurso}#${id} de A`);
      const lista = await B('GET', `/${recurso}?page=1&pageSize=500&f.id=${id}`);
      assert.equal(Number(lista.body?.total), 0, `B não lista ${recurso}#${id} de A`);
    }
    assert.equal(logs().includes('UnhandledPromiseRejection'), false, 'o servidor não registrou rejeição não tratada');
  });
});
