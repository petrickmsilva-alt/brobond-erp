// ============================================================
// Testes do módulo Usuários profissional:
//   • Painel gerencial (resumo) e ficha do usuário (atividade)
//   • Ciclo de vida: desativar/ativar, desbloquear, encerrar sessões,
//     troca forçada de senha
//   • Segurança: bloqueio automático por tentativas, expiração de acesso,
//     troca de perfil derrubando sessões, exclusão com histórico vetada
// Modo memória (mesmo contrato do Postgres).
// ============================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');

function mockReq(user: any, body: any = {}, params: any = {}, ip = '198.51.100.20', headers: any = {}): any {
  return { user, body, params, headers, socket: { remoteAddress: ip } };
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
async function criarUsuario(dados: Record<string, unknown> = {}) {
  seq++;
  const store = getStore();
  return store.insert(RESOURCES.usuarios, {
    nome: dados.nome ?? `Colaborador ${seq}`,
    email: String(dados.email ?? `colab${seq}@teste.com.br`),
    senha_hash: (dados.senha_hash as string) ?? null,
    perfil: dados.perfil ?? 'operador',
    ativo: dados.ativo ?? true,
    ...(dados.extras ?? {}),
  });
}

async function criarComSenha(perfil = 'operador', senha = 'SenhaForte#1') {
  const { hashPassword } = await import('../src/password');
  const row = await criarUsuario({ perfil });
  await getStore().update(RESOURCES.usuarios, Number(row.id), {
    senha_hash: await hashPassword(senha),
    senha_definida_em: new Date().toISOString(),
  });
  return { row, senha };
}

async function reauthComo(adminRow: any, senha: string) {
  const { reautenticar } = await import('../src/auth');
  const ator = { id: Number(adminRow.id), name: String(adminRow.nome), email: String(adminRow.email), perfil: 'admin' as const };
  const r = mockRes();
  await reautenticar(mockReq(ator, { senha }), r.res);
  assert.equal(r.code(), 200);
  return ator;
}

// ---------- 1) Resumo gerencial ----------
describe('GET /api/usuarios/resumo — painel do módulo', () => {
  test('admin vê KPIs e alertas; não-admin é vetado', async () => {
    const { resumoUsuarios } = await import('../src/usuariosAdmin');
    const admin = await criarComSenha('admin', 'AdminResumo#1');
    const ator = { id: Number(admin.row.id), name: 'Admin', perfil: 'admin' as const };

    // massa: convite expirado + bloqueado + inativo
    await criarUsuario({ extras: { convite_token_hash: 'abc', convite_expira_em: new Date(Date.now() - 1000).toISOString() } });
    await criarUsuario({ extras: { bloqueado_ate: new Date(Date.now() + 3600_000).toISOString(), motivo_bloqueio: 'teste' } });
    await criarUsuario({ extras: {}, ativo: false });

    const r = mockRes();
    await resumoUsuarios(mockReq(ator), r.res);
    assert.equal(r.code(), 200);
    const body = r.payload();
    assert.ok(body.totais.total >= 4, 'conta todos os usuários');
    assert.ok(body.totais.admins >= 1);
    assert.ok(body.totais.convites_expirados >= 1, 'convite vencido entra no KPI');
    assert.ok(body.totais.bloqueados >= 1, 'bloqueio entra no KPI');
    assert.ok(body.totais.inativos >= 1);
    assert.ok(Array.isArray(body.alertas) && body.alertas.length >= 2, 'alertas acionáveis');
    assert.ok(body.alertas.some((a: any) => a.tipo === 'admin_sem_mfa'), 'admin sem MFA é alertado');
    assert.ok(body.alertas.some((a: any) => a.tipo === 'convite_expirado'));
    assert.ok(body.alertas.some((a: any) => a.tipo === 'bloqueado'));

    const operador = { id: 9999, name: 'Op', perfil: 'operador' as const };
    await assert.rejects(() => resumoUsuarios(mockReq(operador), mockRes().res), (e: any) => e.status === 403);
  });
});

// ---------- 2) Ficha do usuário ----------
describe('GET /api/usuarios/:id/atividade — ficha do usuário', () => {
  test('traz dados sanitizados, sessões, acessos e trilha; sem segredos', async () => {
    const { atividadeUsuario } = await import('../src/usuariosAdmin');
    const { login } = await import('../src/auth');
    const admin = await criarComSenha('admin', 'AdminFicha#1');
    const ator = { id: Number(admin.row.id), name: 'Admin', perfil: 'admin' as const };

    const alvo = await criarComSenha('gerente', 'AlvoFicha#1');
    const rl = mockRes();
    await login(mockReq(null, { email: alvo.row.email, password: 'AlvoFicha#1' }, {}, '198.51.100.21'), rl.res);
    assert.equal(rl.code(), 200, 'login do alvo cria sessão + evento');

    const r = mockRes();
    await atividadeUsuario(mockReq(ator, {}, { id: String(alvo.row.id) }), r.res);
    assert.equal(r.code(), 200);
    const body = r.payload();
    assert.equal(body.usuario.email, alvo.row.email);
    assert.equal(body.usuario.senha_hash, undefined, 'hash nunca sai na API');
    assert.equal(body.usuario.mfa_secret, undefined);
    assert.ok(body.usuario.status_conta, 'status consolidado presente');
    assert.ok(body.sessoes.length >= 1, 'sessão ativa listada');
    assert.ok(body.acessos_total >= 1, 'login aparece nos acessos');
    assert.ok(body.estatisticas.logins_30d >= 1);

    await assert.rejects(() => atividadeUsuario(mockReq(ator, {}, { id: '999999' }), mockRes().res), (e: any) => e.status === 404);
    const operador = { id: 9999, name: 'Op', perfil: 'operador' as const };
    await assert.rejects(() => atividadeUsuario(mockReq(operador, {}, { id: String(alvo.row.id) }), mockRes().res), (e: any) => e.status === 403);
  });
});

// ---------- 3) Desativar / reativar ----------
describe('Ciclo de vida: desativar e reativar', () => {
  test('desativar exige motivo e reauth; derruba sessões e invalida tokens', async () => {
    const { desativarUsuario, ativarUsuario } = await import('../src/usuariosAdmin');
    const { login, requireAuth, limparReautenticacao } = await import('../src/auth');
    const admin = await criarComSenha('admin', 'AdminCiclo#1');
    const ator = await reauthComo(admin.row, 'AdminCiclo#1');

    const alvo = await criarComSenha('operador', 'AlvoCiclo#1');
    const rl = mockRes();
    await login(mockReq(null, { email: alvo.row.email, password: 'AlvoCiclo#1' }, {}, '198.51.100.22'), rl.res);
    const tokenAlvo = rl.payload().token;
    assert.ok(tokenAlvo);

    // sem motivo → 400
    await assert.rejects(
      () => desativarUsuario(mockReq(ator, {}, { id: String(alvo.row.id) }), mockRes().res),
      (e: any) => e.status === 400 && /motivo/i.test(e.message)
    );

    const antes = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(alvo.row.id) });
    const r = mockRes();
    await desativarUsuario(mockReq(ator, { motivo: 'Desligamento — fim do contrato' }, { id: String(alvo.row.id) }), r.res);
    assert.equal(r.code(), 200);
    assert.equal(r.payload().sessoes_encerradas, 1, 'sessão ativa encerrada');

    const depois = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(alvo.row.id) });
    assert.equal(depois.ativo, false);
    assert.equal(depois.desativado_motivo, 'Desligamento — fim do contrato');
    assert.ok(depois.desativado_por && depois.desativado_em, 'trilha de desativação carimbada');
    assert.ok(Number(depois.token_versao) > Number(antes.token_versao || 0), 'tokens invalidados');

    // sessão antiga cai na hora
    const reqT = mockReq(null, {}, {}, '198.51.100.22', { authorization: `Bearer ${tokenAlvo}` });
    const resT = mockRes();
    await requireAuth(reqT, resT.res, () => {});
    assert.equal(resT.code(), 401, 'token de desativado não passa');

    // login de desativado → 403
    const rl2 = mockRes();
    await login(mockReq(null, { email: alvo.row.email, password: 'AlvoCiclo#1' }, {}, '198.51.100.22'), rl2.res);
    assert.equal(rl2.code(), 403);

    // reativar (requer reauth também)
    limparReautenticacao(Number(admin.row.id));
    await assert.rejects(
      () => ativarUsuario(mockReq(ator, {}, { id: String(alvo.row.id) }), mockRes().res),
      (e: any) => e.status === 403 && e.code === 'reauth_necessaria'
    );
    const ator2 = await reauthComo(admin.row, 'AdminCiclo#1');
    const ra = mockRes();
    await ativarUsuario(mockReq(ator2, {}, { id: String(alvo.row.id) }), ra.res);
    assert.equal(ra.code(), 200);
    const reativo = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(alvo.row.id) });
    assert.equal(reativo.ativo, true);
    assert.equal(reativo.desativado_motivo, null, 'trilha limpa na reativação');

    const rl3 = mockRes();
    await login(mockReq(null, { email: alvo.row.email, password: 'AlvoCiclo#1' }, {}, '198.51.100.22'), rl3.res);
    assert.equal(rl3.code(), 200, 'reativado volta a entrar');
    limparReautenticacao(Number(admin.row.id));
  });

  test('não desativa a si mesmo; reativar conta virgem gera convite novo', async () => {
    const { desativarUsuario, ativarUsuario } = await import('../src/usuariosAdmin');
    const { limparReautenticacao } = await import('../src/auth');
    const admin = await criarComSenha('admin', 'AdminCiclo#2');
    const ator = await reauthComo(admin.row, 'AdminCiclo#2');

    await assert.rejects(
      () => desativarUsuario(mockReq(ator, { motivo: 'x' }, { id: String(admin.row.id) }), mockRes().res),
      (e: any) => e.status === 400 && /próprio/i.test(e.message)
    );

    // conta virgem desativada → reativar gera convite (sem SMTP o link volta)
    const virgem = await criarUsuario({ ativo: false });
    const r = mockRes();
    await ativarUsuario(mockReq(ator, {}, { id: String(virgem.id) }), r.res);
    assert.equal(r.code(), 200);
    const atual = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(virgem.id) });
    assert.ok(atual.convite_token_hash, 'convite novo gerado na reativação');
    limparReautenticacao(Number(admin.row.id));
  });

  test('último administrador ativo não pode ser desativado', async () => {
    const { updateRecord } = await import('../src/services');
    // isola: novo processo não — então cria admin exclusivo e tenta rebaixá-lo
    // quando ele é o único admin ATIVO restante é impossível garantir aqui;
    // o invariante é testado desativando via CRUD genérico com 1 admin virgem:
    // em vez disso, valida a regra de negócio diretamente no último admin da base.
    const lista = await getStore().list(RESOURCES.usuarios, { page: 1, pageSize: 1000, filter: { perfil: 'admin', ativo: true } });
    assert.ok(lista.rows.length >= 1);
    // desativa todos os admins menos um via store (sem passar pela regra),
    // depois tenta desativar o restante pelo CRUD → deve vetar.
    const ids = lista.rows.map((u: any) => Number(u.id));
    const ultimo = ids[ids.length - 1];
    for (const id of ids.slice(0, -1)) {
      await getStore().update(RESOURCES.usuarios, id, { ativo: false });
    }
    const ator = { id: 424242, name: 'Root', perfil: 'admin' as const };
    await assert.rejects(() => updateRecord(RESOURCES.usuarios, ultimo, { ativo: false }, ator), /único administrador/i);
    // restaura
    for (const id of ids.slice(0, -1)) {
      await getStore().update(RESOURCES.usuarios, id, { ativo: true });
    }
  });
});

// ---------- 4) Bloqueio automático + desbloqueio + expiração ----------
describe('Bloqueio por tentativas, desbloqueio e expiração de acesso', () => {
  test('5 senhas erradas bloqueiam a conta; atropela even senha certa; desbloquear libera', async () => {
    const { login } = await import('../src/auth');
    const { desbloquearUsuario } = await import('../src/usuariosAdmin');
    const admin = await criarComSenha('admin', 'AdminBloq#1');
    const ator = { id: Number(admin.row.id), name: 'Admin', perfil: 'admin' as const };
    const alvo = await criarComSenha('operador', 'CertaBloq#1');

    for (let i = 0; i < 5; i++) {
      const r = mockRes();
      await login(mockReq(null, { email: alvo.row.email, password: 'errada' }, {}, '198.51.100.30'), r.res);
      assert.equal(r.code(), 401);
    }
    const raw = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(alvo.row.id) });
    assert.equal(Number(raw.tentativas_falhas), 5);
    assert.ok(raw.bloqueado_ate, 'bloqueio temporário gravado');

    const rBloq = mockRes();
    await login(mockReq(null, { email: alvo.row.email, password: 'CertaBloq#1' }, {}, '198.51.100.30'), rBloq.res);
    assert.equal(rBloq.code(), 403);
    assert.match(rBloq.payload().error, /bloqueado/i);

    const rDes = mockRes();
    await desbloquearUsuario(mockReq(ator, {}, { id: String(alvo.row.id) }), rDes.res);
    assert.equal(rDes.code(), 200);
    const limpo = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(alvo.row.id) });
    assert.equal(limpo.bloqueado_ate, null);
    assert.equal(Number(limpo.tentativas_falhas), 0);

    const rOk = mockRes();
    await login(mockReq(null, { email: alvo.row.email, password: 'CertaBloq#1' }, {}, '198.51.100.30'), rOk.res);
    assert.equal(rOk.code(), 200, 'desbloqueado entra com a senha certa');

    await assert.rejects(
      () => desbloquearUsuario(mockReq(ator, {}, { id: String(alvo.row.id) }), mockRes().res),
      (e: any) => e.status === 400 && /não está bloqueado/i.test(e.message)
    );
  });

  test('acesso temporário vencido veta o login com 403', async () => {
    const { login } = await import('../src/auth');
    const alvo = await criarComSenha('operador', 'CertaExp#1');
    await getStore().update(RESOURCES.usuarios, Number(alvo.row.id), {
      acesso_expira_em: new Date(Date.now() - 1000).toISOString(),
    });
    const r = mockRes();
    await login(mockReq(null, { email: alvo.row.email, password: 'CertaExp#1' }, {}, '198.51.100.31'), r.res);
    assert.equal(r.code(), 403);
    assert.match(r.payload().error, /expirado/i);
  });
});

// ---------- 5) Encerrar sessões + troca forçada ----------
describe('Encerrar sessões e troca forçada de senha', () => {
  test('encerrar-sessoes derruba tudo e invalida tokens; própria conta vetada', async () => {
    const { encerrarSessoesUsuario } = await import('../src/usuariosAdmin');
    const { login, requireAuth, limparReautenticacao } = await import('../src/auth');
    const admin = await criarComSenha('admin', 'AdminSess#1');
    const ator = await reauthComo(admin.row, 'AdminSess#1');
    const alvo = await criarComSenha('operador', 'AlvoSess#1');

    const r1 = mockRes();
    await login(mockReq(null, { email: alvo.row.email, password: 'AlvoSess#1' }, {}, '198.51.100.40'), r1.res);
    const r2 = mockRes();
    await login(mockReq(null, { email: alvo.row.email, password: 'AlvoSess#1' }, {}, '198.51.100.41'), r2.res);
    const tokenA = r1.payload().token;

    const r = mockRes();
    await encerrarSessoesUsuario(mockReq(ator, {}, { id: String(alvo.row.id) }), r.res);
    assert.equal(r.code(), 200);
    assert.equal(r.payload().sessoes_encerradas, 2);

    const reqT = mockReq(null, {}, {}, '198.51.100.40', { authorization: `Bearer ${tokenA}` });
    const resT = mockRes();
    await requireAuth(reqT, resT.res, () => {});
    assert.equal(resT.code(), 401, 'tokens antigos invalidados');

    await assert.rejects(
      () => encerrarSessoesUsuario(mockReq(ator, {}, { id: String(admin.row.id) }), mockRes().res),
      (e: any) => e.status === 400 && /própria conta/i.test(e.message)
    );
    limparReautenticacao(Number(admin.row.id));
  });

  test('forcar-troca-senha marca trocar_senha; convite pendente é vetado', async () => {
    const { forcarTrocaSenha } = await import('../src/usuariosAdmin');
    const admin = await criarComSenha('admin', 'AdminTroca#1');
    const ator = { id: Number(admin.row.id), name: 'Admin', perfil: 'admin' as const };
    const alvo = await criarComSenha('operador', 'AlvoTroca#1');

    const r = mockRes();
    await forcarTrocaSenha(mockReq(ator, {}, { id: String(alvo.row.id) }), r.res);
    assert.equal(r.code(), 200);
    const raw = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(alvo.row.id) });
    assert.equal(raw.trocar_senha, true);

    await assert.rejects(() => forcarTrocaSenha(mockReq(ator, {}, { id: String(alvo.row.id) }), mockRes().res), (e: any) => e.status === 400);

    const virgem = await criarUsuario({});
    await assert.rejects(
      () => forcarTrocaSenha(mockReq(ator, {}, { id: String(virgem.id) }), mockRes().res),
      (e: any) => e.status === 409 && /convite/i.test(e.message)
    );
  });
});

// ---------- 6) Perfil e exclusão ----------
describe('Troca de perfil e exclusão com histórico', () => {
  test('trocar o perfil derruba as sessões (novo perfil vale no próximo login)', async () => {
    const { updateRecord } = await import('../src/services');
    const { login, requireAuth } = await import('../src/auth');
    const admin = await criarComSenha('admin', 'AdminPerfil#1');
    const ator = { id: Number(admin.row.id), name: String(admin.row.nome), perfil: 'admin' as const };
    const alvo = await criarComSenha('operador', 'AlvoPerfil#1');

    const rl = mockRes();
    await login(mockReq(null, { email: alvo.row.email, password: 'AlvoPerfil#1' }, {}, '198.51.100.50'), rl.res);
    const token = rl.payload().token;

    await updateRecord(RESOURCES.usuarios, Number(alvo.row.id), { perfil: 'gerente' }, ator);
    const reqT = mockReq(null, {}, {}, '198.51.100.50', { authorization: `Bearer ${token}` });
    const resT = mockRes();
    await requireAuth(reqT, resT.res, () => {});
    assert.equal(resT.code(), 401, 'sessão com perfil antigo cai');
  });

  test('usuário com histórico não pode ser excluído; conta virgem pode', async () => {
    const { deleteRecord, createRecord } = await import('../src/services');
    const admin = await criarComSenha('admin', 'AdminDel#1');
    const ator = { id: Number(admin.row.id), name: String(admin.row.nome), perfil: 'admin' as const };

    // conta virgem (insert direto, sem auditoria, sem login) → exclui
    const virgem = await criarUsuario({});
    await deleteRecord(RESOURCES.usuarios, Number(virgem.id), ator);
    assert.equal(await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(virgem.id) }), null);

    // conta com login → 409 sugerindo desativar
    const usado = await createRecord(
      RESOURCES.usuarios,
      { nome: 'Usado Silva', email: `usado.${Date.now()}@t.com`, perfil: 'operador' },
      ator
    );
    await getStore().touchLogin(Number(usado.id), '1.2.3.4');
    await assert.rejects(() => deleteRecord(RESOURCES.usuarios, Number(usado.id), ator), (e: any) => e.status === 409 && /Desative/i.test(e.message));

    // conta que agiu no sistema (evento próprio) → 409 mesmo sem login
    const autor = await createRecord(RESOURCES.usuarios, { nome: 'Autor Souza', email: `autor.${Date.now()}@t.com`, perfil: 'gerente' }, ator);
    await createRecord(RESOURCES.categorias, { nome: `Cat Aud ${Date.now()}` }, { id: Number(autor.id), name: 'Autor Souza', perfil: 'gerente' });
    await assert.rejects(() => deleteRecord(RESOURCES.usuarios, Number(autor.id), ator), (e: any) => e.status === 409);
  });
});

// ---------- Filtros virtuais da lista ----------
describe('Filtros virtuais da lista (status, MFA, parados 30d)', () => {
  test('filtram no servidor com total consistente', async () => {
    const { listRecords } = await import('../src/services');
    const store = getStore();
    const dia = 24 * 3600_000;
    const agora = Date.now();
    const ids = (out: any) => out.rows.map((u: any) => Number(u.id));

    const recente = await criarComSenha('operador', 'Recente#4821x');
    await store.update(RESOURCES.usuarios, Number(recente.row.id), { ultimo_login: new Date(agora - 2 * dia).toISOString() });
    const parado = await criarComSenha('operador', 'Parado#4821x');
    await store.update(RESOURCES.usuarios, Number(parado.row.id), { ultimo_login: new Date(agora - 45 * dia).toISOString() });
    const nunca = await criarComSenha('operador', 'Nunca#4821x'); // senha definida, nunca logou
    const convite = await criarUsuario({ email: `convite.filtro.${Date.now()}@t.com` }); // sem senha
    const mfa = await criarComSenha('operador', 'MfaFiltro#4821x');
    await store.update(RESOURCES.usuarios, Number(mfa.row.id), { mfa_ativado_em: new Date().toISOString() });

    const r = RESOURCES.usuarios;
    const st = await listRecords(r, { page: 1, pageSize: 5000, filter: { status: 'convite_pendente' } });
    assert.ok(ids(st).includes(Number(convite.id)));
    assert.ok(!ids(st).includes(Number(recente.row.id)));

    const mf = await listRecords(r, { page: 1, pageSize: 5000, filter: { mfa: 'sim' } });
    assert.ok(ids(mf).includes(Number(mfa.row.id)));
    assert.ok(!ids(mf).includes(Number(recente.row.id)));

    const par = await listRecords(r, { page: 1, pageSize: 5000, filter: { parado30d: 'sim' } });
    const pids = ids(par);
    assert.ok(pids.includes(Number(parado.row.id)));
    assert.ok(pids.includes(Number(nunca.row.id))); // nunca logou também é parado
    assert.ok(!pids.includes(Number(recente.row.id)));
    assert.ok(!pids.includes(Number(convite.id))); // sem senha não conta como parado
    assert.equal(par.total, par.rows.length);

    // paginação continua correta com filtro virtual
    const pag1 = await listRecords(r, { page: 1, pageSize: 1, filter: { parado30d: 'sim' } });
    assert.equal(pag1.rows.length, 1);
    assert.equal(pag1.total, par.total);
  });
});
