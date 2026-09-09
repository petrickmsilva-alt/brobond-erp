// ============================================================
// Testes dos webhooks de eventos de usuário (Onda 4):
//   • CRUD com validações, admin + reautenticação
//   • Entrega real com assinatura HMAC + registro de ok/erro
//   • Reenvio, teste, filtros e roteamento por assinatura
// Modo memória (mesmo contrato do Postgres).
// ============================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { getStore } = await import('../src/services');

function mockReq(user: any, body: any = {}, params: any = {}, query: any = {}): any {
  return { user, body, params, query, headers: {}, socket: { remoteAddress: '198.51.100.20' } };
}
function mockRes() {
  let payload: any;
  let status = 0;
  const res: any = {
    json: (d: any) => {
      payload = d;
      if (!status) status = 200;
      return res;
    },
    status: (s: number) => {
      status = s;
      return res;
    },
    setHeader: () => res,
  };
  return { res, payload: () => payload, code: () => status };
}

let seq = 0;
async function criarAdmin(senha = 'HookAdm#1000x') {
  seq++;
  const { hashPassword } = await import('../src/password');
  const { RESOURCES } = await import('../src/resources');
  const row = await getStore().insert(RESOURCES.usuarios, {
    nome: `Admin Hook ${seq}`,
    email: `hookadm${seq}@teste.com.br`,
    senha_hash: await hashPassword(senha),
    senha_definida_em: new Date().toISOString(),
    perfil: 'admin',
    ativo: true,
  });
  const { reautenticar } = await import('../src/auth');
  const ator = { id: Number(row.id), name: String(row.nome), email: String(row.email), perfil: 'admin' as const };
  const r = mockRes();
  await reautenticar(mockReq(ator, { senha }), r.res);
  assert.equal(r.code(), 200);
  return ator;
}

/** Servidor receptor de mentira: guarda headers + corpo bruto de cada POST. */
function subirReceptor(responder = 200) {
  const recebidos: { headers: Record<string, unknown>; corpo: string }[] = [];
  const srv = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => (corpo += c));
    req.on('end', () => {
      recebidos.push({ headers: { ...req.headers }, corpo });
      res.writeHead(responder, { 'Content-Type': 'text/plain' });
      res.end(responder === 200 ? 'ok' : 'falhou');
    });
  });
  return new Promise<{ url: string; recebidos: typeof recebidos; fechar: () => Promise<void> }>((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const end = srv.address();
      const porta = typeof end === 'object' && end ? end.port : 0;
      resolve({
        url: `http://127.0.0.1:${porta}/hook`,
        recebidos,
        fechar: () => new Promise<void>((ok) => srv.close(() => ok())),
      });
    });
  });
}

describe('Webhooks de eventos de usuário (Onda 4)', () => {
  test('CRUD: cria com segredo único, valida tudo, exige admin + reauth', async () => {
    const { listarWebhooks, criarWebhook, atualizarWebhook, excluirWebhook } = await import('../src/webhooks');
    const ator = await criarAdmin();

    const r = mockRes();
    await criarWebhook(mockReq(ator, { nome: 'SIEM matriz', url: 'https://siem.exemplo.com.br/hook', eventos: ['usuario.bloqueado', 'usuario.desativado'] }), r.res);
    assert.equal(r.code(), 201);
    assert.ok(r.payload().segredo && r.payload().segredo.length >= 32, 'segredo devolvido UMA vez');
    assert.equal(r.payload().tem_segredo, true);
    assert.ok(!('segredo_cifrado' in r.payload()), 'cifrado nunca sai');
    const id = r.payload().id;

    await assert.rejects(() => criarWebhook(mockReq(ator, { nome: 'x', url: 'ftp://a.com', eventos: ['usuario.criado'] }), mockRes().res), /http/);
    await assert.rejects(() => criarWebhook(mockReq(ator, { nome: 'x', url: 'https://a.com', eventos: [] }), mockRes().res), /ao menos um evento/);
    await assert.rejects(() => criarWebhook(mockReq(ator, { nome: 'x', url: 'https://a.com', eventos: ['nada.algo'] }), mockRes().res), /desconhecido/);
    const op = { id: 9999, name: 'Op', perfil: 'operador' as const };
    await assert.rejects(() => criarWebhook(mockReq(op, { nome: 'x', url: 'https://a.com', eventos: ['usuario.criado'] }), mockRes().res), (e: any) => e.status === 403);
    const { RESOURCES } = await import('../src/resources');
    const { hashPassword } = await import('../src/password');
    const semReauthRow = await getStore().insert(RESOURCES.usuarios, {
      nome: 'Admin Sem Reauth', email: `semreauth${Date.now()}@teste.com.br`,
      senha_hash: await hashPassword('x'), perfil: 'admin', ativo: true,
    });
    const semReauth = { id: Number(semReauthRow.id), name: 'Admin Sem Reauth', perfil: 'admin' as const };
    await assert.rejects(
      () => criarWebhook(mockReq(semReauth, { nome: 'x', url: 'https://a.com', eventos: ['usuario.criado'] }), mockRes().res),
      (e: any) => e.code === 'reauth_necessaria',
      'sem reautenticação não cria'
    );

    const rUp = mockRes();
    await atualizarWebhook(mockReq(ator, { ativo: false, regenerar_segredo: true }, { id: String(id) }), rUp.res);
    assert.equal(rUp.payload().ativo, false);
    assert.ok(rUp.payload().segredo, 'regeneração devolve o novo segredo uma vez');

    const rList = mockRes();
    await listarWebhooks(mockReq(ator), rList.res);
    assert.ok(rList.payload().webhooks.some((w: any) => w.id === id));
    assert.ok(rList.payload().eventos_disponiveis.some((e: any) => e.id === 'usuario.bloqueado'));

    const rDel = mockRes();
    await excluirWebhook(mockReq(ator, {}, { id: String(id) }), rDel.res);
    assert.equal(rDel.code(), 200);
    const rList2 = mockRes();
    await listarWebhooks(mockReq(ator), rList2.res);
    assert.ok(!rList2.payload().webhooks.some((w: any) => w.id === id));
  });

  test('entrega real: HMAC válido, ok registrado; URL morta registra erro', async () => {
    const { criarWebhook, listarEntregas, disparar, R_ENTREGAS } = await import('../src/webhooks');
    const ator = await criarAdmin();
    const receptor = await subirReceptor(200);
    try {
      const r = mockRes();
      await criarWebhook(mockReq(ator, { nome: 'Recibo', url: receptor.url, eventos: ['usuario.criado'] }), r.res);
      const id = r.payload().id;
      const segredo = r.payload().segredo as string;

      await disparar('usuario.criado', { usuario_id: 7, nome: 'Zé', email: 'ze@x.com', perfil: 'operador', por: 'Admin' });
      assert.equal(receptor.recebidos.length, 1, 'POST chegou ao receptor');
      const { headers, corpo } = receptor.recebidos[0];
      assert.equal(headers['x-brobond-event'], 'usuario.criado');
      const esperado = `sha256=${createHmac('sha256', segredo).update(corpo, 'utf8').digest('hex')}`;
      assert.equal(headers['x-brobond-signature'], esperado, 'assinatura HMAC confere');
      assert.equal(JSON.parse(corpo).dados.usuario_id, 7);

      const rEnt = mockRes();
      await listarEntregas(mockReq(ator, {}, { id: String(id) }), rEnt.res);
      assert.equal(rEnt.payload().entregas[0].estado, 'ok');
      assert.equal(rEnt.payload().entregas[0].resposta_status, 200);

      const rMorto = mockRes();
      await criarWebhook(mockReq(ator, { nome: 'Morto', url: 'http://127.0.0.1:9/hook', eventos: ['usuario.criado'] }), rMorto.res);
      await disparar('usuario.criado', { usuario_id: 8 });
      const ent = await getStore().list(R_ENTREGAS, { page: 1, pageSize: 5, sort: 'id', dir: 'desc', filter: { webhook_id: Number(rMorto.payload().id) } });
      assert.equal(ent.rows[0].estado, 'erro');
      assert.ok(String(ent.rows[0].erro || '').length > 0, 'motivo registrado');
    } finally {
      await receptor.fechar();
    }
  });

  test('reenvio tenta de novo e conta tentativas; teste respeita ativo', async () => {
    const { criarWebhook, reenviarEntrega, testarWebhook, R_ENTREGAS } = await import('../src/webhooks');
    const ator = await criarAdmin();
    const r = mockRes();
    await criarWebhook(mockReq(ator, { nome: 'Flaky', url: 'http://127.0.0.1:9/hook', eventos: ['usuario.criado'] }), r.res);
    const id = r.payload().id;

    // entrega falha (porta fechada) via teste
    const rTeste = mockRes();
    await testarWebhook(mockReq(ator, {}, { id: String(id) }), rTeste.res);
    assert.equal(rTeste.payload().ok, false);
    const entregaId = rTeste.payload().entrega_id as number;

    // conserta a URL, reenvia e dá ok
    const receptor = await subirReceptor(200);
    try {
      const { atualizarWebhook } = await import('../src/webhooks');
      await atualizarWebhook(mockReq(ator, { url: receptor.url }, { id: String(id) }), mockRes().res);
      const rRe = mockRes();
      await reenviarEntrega(mockReq(ator, {}, { id: String(entregaId) }), rRe.res);
      assert.equal(rRe.payload().ok, true);
      assert.equal(rRe.payload().tentativas, 2);
      assert.equal(receptor.recebidos.length, 1);
    } finally {
      await receptor.fechar();
    }
    const ent = await getStore().findOneWhere(R_ENTREGAS, { id: entregaId });
    assert.equal(ent!.estado, 'ok');
  });

  test('disparar só atinge assinantes ativos e nunca lança', async () => {
    const { criarWebhook, atualizarWebhook, disparar, R_ENTREGAS } = await import('../src/webhooks');
    const ator = await criarAdmin();
    const mk = async (nome: string, eventos: string[]) => {
      const r = mockRes();
      await criarWebhook(mockReq(ator, { nome, url: 'http://127.0.0.1:9/hook', eventos }), r.res);
      return Number(r.payload().id);
    };
    const sim = await mk('Sim', ['usuario.bloqueado']);
    const outro = await mk('OutroEvento', ['usuario.criado']);
    const off = await mk('Desligado', ['usuario.bloqueado']);
    await atualizarWebhook(mockReq(ator, { ativo: false }, { id: String(off) }), mockRes().res);

    await disparar('usuario.bloqueado', { usuario_id: 1 });
    for (const [wid, esperado] of [[sim, 1], [outro, 0], [off, 0]] as const) {
      const ent = await getStore().list(R_ENTREGAS, { page: 1, pageSize: 10, filter: { webhook_id: wid } });
      assert.equal(ent.total, esperado, `webhook ${wid}: ${esperado} entrega(s)`);
    }
    await assert.doesNotReject(() => disparar('evento.que.nao.existe', {}));
  });
});
