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

// ---------- Onda 3: códigos de recuperação do MFA ----------
describe('MFA: códigos de recuperação (uso único)', () => {
  test('lote tem formato, unicidade e consumo único', async () => {
    const { gerarLoteCodigos, consumirCodigo, restantesRegistro, normalizarCodigo } = await import('../src/mfaBackup');
    const lote = gerarLoteCodigos();
    assert.equal(lote.codigos.length, 10);
    assert.ok(lote.codigos.every((c) => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c)), 'formato XXXX-XXXX sem ambíguos');
    assert.equal(new Set(lote.codigos).size, 10, 'sem repetição no lote');
    assert.equal(restantesRegistro(lote.registro), 10);
    const c1 = await consumirCodigo(lote.registro, lote.codigos[0].toLowerCase().replace('-', ''));
    assert.ok(c1 && c1.restantes === 9, 'aceita com outra caixa/espaço');
    assert.equal(await consumirCodigo(lote.registro, lote.codigos[0]), null, 'não reutiliza');
    assert.equal(await consumirCodigo(lote.registro, 'ZZZZ-ZZZZ'), null, 'código estranho falha');
    assert.equal(normalizarCodigo('ab12-cd34'), 'AB12CD34');
  });

  test('ativação emite códigos; login com código consome; regenerar invalida o lote', async () => {
    const { mfaSetup, mfaAtivar, mfaCodigos, decifrarSegredoMfa } = await import('../src/mfa');
    const { codigoTOTP } = await import('../src/totp');
    const { login, loginMFA } = await import('../src/auth');
    const { restantesRegistro, lerRegistro } = await import('../src/mfaBackup');

    const { row } = await criarComSenha('operador', 'Backup#4821x');
    const ator = { id: Number(row.id), name: String(row.nome), email: String(row.email), perfil: 'operador' as const };
    await mfaSetup(mockReq(ator), mockRes().res);
    const pendente = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(row.id) });
    const rAtivar = mockRes();
    await mfaAtivar(mockReq(ator, { codigo: codigoTOTP(decifrarSegredoMfa(pendente!.mfa_secret)!) }), rAtivar.res);
    assert.equal(rAtivar.code(), 200);
    const codigos = rAtivar.payload().codigos as string[];
    assert.equal(codigos.length, 10, 'ativação devolve os 10 códigos (exibição única)');

    // login com o 1º código de recuperação
    let r = mockRes();
    await login(mockReq(null, { email: row.email, password: 'Backup#4821x' }, {}, '198.51.100.31'), r.res);
    assert.equal(r.payload().mfa_required, true);
    const rMfa = mockRes();
    await loginMFA(mockReq(null, { mfa_ticket: r.payload().mfa_ticket, codigo: codigos[0] }, {}, '198.51.100.31'), rMfa.res);
    assert.equal(rMfa.code(), 200, 'código de recuperação conclui o login');
    assert.ok(rMfa.payload().token);
    const depois = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(row.id) });
    assert.equal(restantesRegistro(lerRegistro(depois!.mfa_backup_hashes)), 9);

    // reutilizar o mesmo código falha
    r = mockRes();
    await login(mockReq(null, { email: row.email, password: 'Backup#4821x' }, {}, '198.51.100.32'), r.res);
    const rReuso = mockRes();
    await loginMFA(mockReq(null, { mfa_ticket: r.payload().mfa_ticket, codigo: codigos[0] }, {}, '198.51.100.32'), rReuso.res);
    assert.equal(rReuso.code(), 401, 'código usado não vale de novo');

    // regenerar (com reauth) invalida o lote anterior
    await reauthComo(row, 'Backup#4821x');
    const rCod = mockRes();
    await mfaCodigos(mockReq(ator), rCod.res);
    assert.equal(rCod.code(), 200);
    assert.equal((rCod.payload().codigos as string[]).length, 10);
    const renovado = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(row.id) });
    assert.equal(restantesRegistro(lerRegistro(renovado!.mfa_backup_hashes)), 10);
    r = mockRes();
    await login(mockReq(null, { email: row.email, password: 'Backup#4821x' }, {}, '198.51.100.33'), r.res);
    const rVelho = mockRes();
    await loginMFA(mockReq(null, { mfa_ticket: r.payload().mfa_ticket, codigo: codigos[1] }, {}, '198.51.100.33'), rVelho.res);
    assert.equal(rVelho.code(), 401, 'lote antigo morre na regeneração');
  });

  test('desativar e resetar o MFA limpam os códigos', async () => {
    const { mfaSetup, mfaAtivar, mfaDesativar, decifrarSegredoMfa } = await import('../src/mfa');
    const { codigoTOTP } = await import('../src/totp');
    const { resetarMfaUsuario } = await import('../src/usuariosAdmin');
    const { lerRegistro } = await import('../src/mfaBackup');

    const a = await criarComSenha('operador', 'LimpaA#4821x');
    const atorA = { id: Number(a.row.id), name: String(a.row.nome), email: String(a.row.email), perfil: 'operador' as const };
    await mfaSetup(mockReq(atorA), mockRes().res);
    const pend = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(a.row.id) });
    await mfaAtivar(mockReq(atorA, { codigo: codigoTOTP(decifrarSegredoMfa(pend!.mfa_secret)!) }), mockRes().res);
    await reauthComo(a.row, 'LimpaA#4821x');
    const seg = decifrarSegredoMfa((await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(a.row.id) }))!.mfa_secret)!;
    await mfaDesativar(mockReq(atorA, { codigo: codigoTOTP(seg) }), mockRes().res);
    const limpo = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(a.row.id) });
    assert.equal(limpo!.mfa_backup_hashes, null, 'desativar limpa os códigos');

    const b = await criarComSenha('operador', 'LimpaB#4821x');
    const atorB = { id: Number(b.row.id), name: String(b.row.nome), email: String(b.row.email), perfil: 'operador' as const };
    await mfaSetup(mockReq(atorB), mockRes().res);
    const pendB = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(b.row.id) });
    await mfaAtivar(mockReq(atorB, { codigo: codigoTOTP(decifrarSegredoMfa(pendB!.mfa_secret)!) }), mockRes().res);
    const admin = await criarComSenha('admin', 'LimpaAdm#4821x');
    const atorAdm = await reauthComo(admin.row, 'LimpaAdm#4821x');
    await resetarMfaUsuario(mockReq(atorAdm, {}, { id: String(b.row.id) }), mockRes().res);
    const resetado = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(b.row.id) });
    assert.equal(resetado!.mfa_backup_hashes, null, 'reset do admin invalida os códigos');
  });
});

// ---------- Onda 3: bloqueio manual + revogação individual ----------
describe('Bloqueio manual e revogação de sessão individual', () => {
  test('bloquear trava login com motivo; desbloquear libera; guards valem', async () => {
    const { bloquearUsuario, desbloquearUsuario } = await import('../src/usuariosAdmin');
    const { login } = await import('../src/auth');
    const admin = await criarComSenha('admin', 'BloqAdm#4821x');
    const ator = await reauthComo(admin.row, 'BloqAdm#4821x');
    const alvo = await criarComSenha('operador', 'BloqAlvo#4821x');

    const rBloq = mockRes();
    await bloquearUsuario(mockReq(ator, { motivo: 'Suspeita de fraude no caixa' }, { id: String(alvo.row.id) }), rBloq.res);
    assert.equal(rBloq.code(), 200);
    assert.equal(rBloq.payload().manual, true);
    const raw = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(alvo.row.id) });
    assert.equal(raw!.bloqueio_manual, true);

    const rLogin = mockRes();
    await login(mockReq(null, { email: alvo.row.email, password: 'BloqAlvo#4821x' }, {}, '198.51.100.41'), rLogin.res);
    assert.equal(rLogin.code(), 403);
    assert.match(rLogin.payload().error, /bloqueado pelo administrador: Suspeita de fraude/i);

    await assert.rejects(
      () => bloquearUsuario(mockReq(ator, { motivo: 'x' }, { id: String(alvo.row.id) }), mockRes().res),
      /já está bloqueado/i
    );
    await assert.rejects(
      () => bloquearUsuario(mockReq(ator, { motivo: 'x' }, { id: String(admin.row.id) }), mockRes().res),
      /próprio acesso/i
    );

    await desbloquearUsuario(mockReq(ator, {}, { id: String(alvo.row.id) }), mockRes().res);
    const livre = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(alvo.row.id) });
    assert.equal(livre!.bloqueio_manual, false);
    const rOk = mockRes();
    await login(mockReq(null, { email: alvo.row.email, password: 'BloqAlvo#4821x' }, {}, '198.51.100.42'), rOk.res);
    assert.equal(rOk.code(), 200, 'desbloqueado entra');
  });

  test('bloqueio com duração grava bloqueado_ate (temporário, não manual)', async () => {
    const { bloquearUsuario } = await import('../src/usuariosAdmin');
    const admin = await criarComSenha('admin', 'BloqDur#4821x');
    const ator = await reauthComo(admin.row, 'BloqDur#4821x');
    const alvo = await criarComSenha('operador', 'BloqTmp#4821x');
    const r = mockRes();
    await bloquearUsuario(mockReq(ator, { motivo: 'Averiguação', duracao_minutos: 60 }, { id: String(alvo.row.id) }), r.res);
    assert.equal(r.payload().manual, false);
    const raw = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(alvo.row.id) });
    assert.ok(new Date(String(raw!.bloqueado_ate)).getTime() > Date.now());
    assert.notEqual(raw!.bloqueio_manual, true);
    await assert.rejects(
      () => bloquearUsuario(mockReq(ator, { motivo: 'x', duracao_minutos: 999999 }, { id: String(alvo.row.id) }), mockRes().res),
      /já está bloqueado/i
    );
  });

  test('admin revoga UMA sessão; as outras seguem; sid alheio dá 404', async () => {
    const { abrirSessao } = await import('../src/sessoes');
    const { revogarSessaoUsuario } = await import('../src/usuariosAdmin');
    const admin = await criarComSenha('admin', 'RevAdm#4821x');
    const ator = await reauthComo(admin.row, 'RevAdm#4821x');
    const alvo = await criarComSenha('operador', 'RevAlvo#4821x');
    const sid1 = await abrirSessao({ usuarioId: Number(alvo.row.id), lembrar: false, req: mockReq(null) });
    const sid2 = await abrirSessao({ usuarioId: Number(alvo.row.id), lembrar: false, req: mockReq(null) });
    const r = mockRes();
    await revogarSessaoUsuario(mockReq(ator, {}, { id: String(alvo.row.id), sid: sid1 }), r.res);
    assert.equal(r.code(), 200);
    const ativas = await getStore().listSessoesAtivas(Number(alvo.row.id));
    assert.equal(ativas.length, 1);
    assert.equal(ativas[0].id, sid2, 'só a escolhida caiu');
    await assert.rejects(
      () => revogarSessaoUsuario(mockReq(ator, {}, { id: String(admin.row.id), sid: sid2 }), mockRes().res),
      (e: any) => e.status === 404,
      'sid de outro usuário não revoga'
    );
  });
});

// ---------- Onda 3: série de acessos + export da seleção ----------
describe('Resumo: série 7 dias e export da seleção', () => {
  test('serie_logins_7d e falhas_24h refletem a trilha', async () => {
    const { resumoUsuarios } = await import('../src/usuariosAdmin');
    const { login } = await import('../src/auth');
    const admin = await criarComSenha('admin', 'SerieAdm#4821x');
    const ator = { id: Number(admin.row.id), name: 'Admin', perfil: 'admin' as const };
    const u = await criarComSenha('operador', 'SerieUsr#4821x');
    await login(mockReq(null, { email: u.row.email, password: 'SerieUsr#4821x' }, {}, '198.51.100.51'), mockRes().res);
    await login(mockReq(null, { email: u.row.email, password: 'errada-1' }, {}, '198.51.100.52'), mockRes().res);
    const r = mockRes();
    await resumoUsuarios(mockReq(ator), r.res);
    assert.equal(r.code(), 200);
    const serie = r.payload().serie_logins_7d as { dia: string; logins: number; falhas: number }[];
    assert.equal(serie.length, 7);
    const hoje = new Date().toISOString().slice(0, 10);
    const b = serie.find((x) => x.dia === hoje)!;
    assert.ok(b.logins >= 1, 'login de hoje entra na série');
    assert.ok(b.falhas >= 1, 'falha de hoje entra na série');
    assert.ok(r.payload().totais.falhas_24h >= 1, 'KPI falhas_24h');
  });

  test('export aceita ?ids= (seleção) e f.parado30d', async () => {
    const { exportarRecurso } = await import('../src/export');
    const admin = await criarComSenha('admin', 'ExpAdm#4821x');
    const ator = { id: Number(admin.row.id), name: 'Admin', email: String(admin.row.email), perfil: 'admin' as const };
    const a = await criarComSenha('operador', 'ExpA#4821x');
    const b = await criarComSenha('operador', 'ExpB#4821x');
    function mockExport(query: Record<string, string>) {
      let buf = '';
      const res: any = { setHeader: () => res, end: (d: any) => { buf = String(d); return res; } };
      return { req: { query, user: ator } as any, res, corpo: () => buf };
    }
    const sel = mockExport({ format: 'csv', ids: `${a.row.id},${b.row.id}` });
    await exportarRecurso(sel.req, sel.res, 'usuarios');
    assert.ok(sel.corpo().includes(String(a.row.email)), 'seleção traz A');
    assert.ok(sel.corpo().includes(String(b.row.email)), 'seleção traz B');
    assert.ok(!sel.corpo().includes('senha_hash'), 'sem segredos');
    const linhas = sel.corpo().trim().split('\n');
    assert.equal(linhas.length, 3, 'cabeçalho + 2 linhas');
    const par = mockExport({ format: 'csv', 'f.parado30d': 'sim' });
    await exportarRecurso(par.req, par.res, 'usuarios');
    assert.ok(par.corpo().length > 0);
  });
});

// ---------- Onda 4: política de senha configurável ----------
describe('Política de senha configurável (Onda 4)', () => {
  test('padrão reproduz a regra antiga; PUT valida limites e exige admin+reauth', async () => {
    const { obterPoliticaSenha, salvarPoliticaSenha } = await import('../src/usuariosAdmin');
    const { POLITICA_SENHA_PADRAO, salvarPolitica } = await import('../src/politicaSenha');
    const admin = await criarComSenha('admin', 'PolAdm#1000x');
    const ator = await reauthComo(admin.row, 'PolAdm#1000x');

    const rGet = mockRes();
    await obterPoliticaSenha(mockReq(ator), rGet.res);
    assert.equal(rGet.code(), 200);
    assert.deepEqual(rGet.payload().politica, POLITICA_SENHA_PADRAO);
    assert.ok(rGet.payload().limites.tamanho_minimo);

    const op = { id: 9999, name: 'Op', perfil: 'operador' as const };
    await assert.rejects(() => obterPoliticaSenha(mockReq(op), mockRes().res), (e: any) => e.status === 403);

    for (const ruim of [{ tamanho_minimo: 3 }, { tamanho_minimo: 99 }, { historico_qtd: 11 }, { expiracao_dias: 5 }, { expiracao_dias: 400 }]) {
      await assert.rejects(() => salvarPoliticaSenha(mockReq(ator, ruim), mockRes().res), (e: any) => e.status === 400);
    }
    const rPut = mockRes();
    await salvarPoliticaSenha(mockReq(ator, { tamanho_minimo: 12, exigir_numero: true, historico_qtd: 3, expiracao_dias: 90 }), rPut.res);
    assert.equal(rPut.code(), 200);
    assert.equal(rPut.payload().politica.tamanho_minimo, 12);
    assert.equal(rPut.payload().politica.exigir_numero, true);

    const outro = await criarComSenha('admin', 'PolOutro#1000x');
    const fresco = { id: Number(outro.row.id), name: String(outro.row.nome), perfil: 'admin' as const };
    await assert.rejects(
      () => salvarPoliticaSenha(mockReq(fresco, { tamanho_minimo: 10 }), mockRes().res),
      (e: any) => e.code === 'reauth_necessaria',
      'sem reautenticação não grava'
    );
    await salvarPolitica(POLITICA_SENHA_PADRAO, 'teste'); // restaura o padrão
  });

  test('composição configurada é cobrada na troca; pública sai sem login', async () => {
    const { changePassword } = await import('../src/auth');
    const { politicaSenhaPublica } = await import('../src/usuariosAdmin');
    const { salvarPolitica, POLITICA_SENHA_PADRAO } = await import('../src/politicaSenha');
    await salvarPolitica({ ...POLITICA_SENHA_PADRAO, tamanho_minimo: 12, exigir_numero: true, exigir_simbolo: true, exigir_maiuscula_minuscula: true }, 'teste');
    try {
      const u = await criarComSenha('operador', 'CompBase#1000x');
      const ator = { id: Number(u.row.id), name: String(u.row.nome), email: String(u.row.email), perfil: 'operador' as const };
      await assert.rejects(
        () => changePassword(mockReq(ator, { senha_atual: 'CompBase#1000x', senha_nova: 'curta1!' }), mockRes().res),
        /pelo menos 12 caracteres/
      );
      await assert.rejects(
        () => changePassword(mockReq(ator, { senha_atual: 'CompBase#1000x', senha_nova: 'longasemsimb-num1' }), mockRes().res),
        /maiúsculas e minúsculas/
      );
      const rOk = mockRes();
      await changePassword(mockReq(ator, { senha_atual: 'CompBase#1000x', senha_nova: 'NovaForte#2000x' }), rOk.res);
      assert.equal(rOk.code(), 200);

      const rPub = mockRes();
      await politicaSenhaPublica(mockReq(null), rPub.res);
      assert.equal(rPub.payload().politica.tamanho_minimo, 12);
      assert.equal(rPub.payload().politica.exigir_numero, true);
      assert.ok(!('historico_qtd' in rPub.payload().politica), 'pública só leva composição');
    } finally {
      await salvarPolitica(POLITICA_SENHA_PADRAO, 'teste');
    }
  });

  test('histórico impede reutilizar senha recente; igual à atual é vetada', async () => {
    const { changePassword } = await import('../src/auth');
    const { salvarPolitica, POLITICA_SENHA_PADRAO } = await import('../src/politicaSenha');
    await salvarPolitica({ ...POLITICA_SENHA_PADRAO, historico_qtd: 3 }, 'teste');
    try {
      const u = await criarComSenha('operador', 'HistA#1000xxx');
      const ator = { id: Number(u.row.id), name: String(u.row.nome), email: String(u.row.email), perfil: 'operador' as const };
      const troca = (atual: string, nova: string) => changePassword(mockReq(ator, { senha_atual: atual, senha_nova: nova }), mockRes().res);
      await troca('HistA#1000xxx', 'HistB#2000xxx');
      await troca('HistB#2000xxx', 'HistC#3000xxx');
      await assert.rejects(() => troca('HistC#3000xxx', 'HistA#1000xxx'), /já foi usada recentemente/);
      await assert.rejects(() => troca('HistC#3000xxx', 'HistC#3000xxx'), /diferente da atual/);
      const raw = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(u.row.id) });
      assert.equal(JSON.parse(String(raw!.senha_historico)).length, 2, 'duas anteriores guardadas');
      const primeira = (await getStore().list(RESOURCES.usuarios, { page: 1, pageSize: 1 })).rows[0];
      assert.ok(!('senha_historico' in primeira), 'histórico nunca sai na listagem');
    } finally {
      await salvarPolitica(POLITICA_SENHA_PADRAO, 'teste');
    }
  });

  test('senha vencida vira troca obrigatória no login; /me avisa o prazo', async () => {
    const { login, me } = await import('../src/auth');
    const { salvarPolitica, POLITICA_SENHA_PADRAO } = await import('../src/politicaSenha');
    await salvarPolitica({ ...POLITICA_SENHA_PADRAO, expiracao_dias: 90 }, 'teste');
    try {
      const velho = await criarComSenha('operador', 'ExpVelha#1000x');
      await getStore().update(RESOURCES.usuarios, Number(velho.row.id), { senha_definida_em: new Date(Date.now() - 100 * 86400000).toISOString() });
      const rLogin = mockRes();
      await login(mockReq(null, { email: velho.row.email, password: 'ExpVelha#1000x' }, {}, '198.51.100.61'), rLogin.res);
      assert.equal(rLogin.code(), 200);
      assert.equal(rLogin.payload().user.trocar_senha, true, 'vencida cobra troca');
      assert.equal(rLogin.payload().senha_expirada, true);
      const travado = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(velho.row.id) });
      assert.equal(travado!.trocar_senha, true, 'persistiu a cobrança');

      const novo = await criarComSenha('operador', 'ExpNova#1000x');
      const ator = { id: Number(novo.row.id), name: String(novo.row.nome), email: String(novo.row.email), perfil: 'operador' as const };
      const rMe = mockRes();
      await me(mockReq(ator), rMe.res);
      assert.equal(rMe.payload().senha_expirada, false);
      assert.ok(rMe.payload().senha_vence_em_dias >= 89 && rMe.payload().senha_vence_em_dias <= 90, 'fresca vence em ~90 dias');
    } finally {
      await salvarPolitica(POLITICA_SENHA_PADRAO, 'teste');
    }
  });
});

// ---------- Onda 4: certificação de acessos ----------
describe('Certificação de acessos (Onda 4)', () => {
  test('certificar carimba + audita; próprio acesso, inativa e sem senha vetados', async () => {
    const { certificarUsuario } = await import('../src/usuariosAdmin');
    const admin = await criarComSenha('admin', 'CertAdm#1000x');
    const ator = await reauthComo(admin.row, 'CertAdm#1000x');
    const alvo = await criarComSenha('operador', 'CertAlvo#1000x');

    const r = mockRes();
    await certificarUsuario(mockReq(ator, { observacao: 'Revisão trimestral OK' }, { id: String(alvo.row.id) }), r.res);
    assert.equal(r.code(), 200);
    const raw = await getStore().findOneWhere(RESOURCES.usuarios, { id: Number(alvo.row.id) });
    assert.ok(raw!.acesso_certificado_em);
    assert.equal(raw!.acesso_certificado_por, ator.name);
    assert.equal(raw!.acesso_certificado_obs, 'Revisão trimestral OK');
    const trilha = await getStore().list(RESOURCES.auditoria, { page: 1, pageSize: 5, sort: 'data', dir: 'desc', filter: { acao: 'seguranca', registro_id: Number(alvo.row.id) } });
    assert.ok(trilha.rows.some((e: any) => String(e.descricao).includes('CERTIFICADO')), 'carimbo auditado');

    await assert.rejects(
      () => certificarUsuario(mockReq(ator, {}, { id: String(admin.row.id) }), mockRes().res),
      /próprio acesso/,
      'quatro olhos: ninguém certifica a si mesmo'
    );
    const inativo = await criarComSenha('operador', 'CertInat#1000x');
    await getStore().update(RESOURCES.usuarios, Number(inativo.row.id), { ativo: false });
    await assert.rejects(
      () => certificarUsuario(mockReq(ator, {}, { id: String(inativo.row.id) }), mockRes().res),
      (e: any) => e.status === 409
    );
    const semSenha = await criarUsuario({});
    await assert.rejects(
      () => certificarUsuario(mockReq(ator, {}, { id: String(semSenha.id) }), mockRes().res),
      (e: any) => e.status === 409
    );
  });

  test('matriz traz pendências + vencidas; export CSV sem segredos', async () => {
    const { certificacaoUsuarios, exportarCertificacao, certificarUsuario } = await import('../src/usuariosAdmin');
    const admin = await criarComSenha('admin', 'MatAdm#1000xx');
    const ator = await reauthComo(admin.row, 'MatAdm#1000xx');
    const a = await criarComSenha('operador', 'MatA#1000xxxx');
    const b = await criarComSenha('operador', 'MatB#1000xxxx');
    await certificarUsuario(mockReq(ator, {}, { id: String(a.row.id) }), mockRes().res);
    await getStore().update(RESOURCES.usuarios, Number(b.row.id), {
      acesso_certificado_em: new Date(Date.now() - 400 * 86400000).toISOString(),
      acesso_certificado_por: 'ex-admin',
    });

    const r = mockRes();
    await certificacaoUsuarios(mockReq(ator), r.res);
    assert.equal(r.code(), 200);
    const linhas = r.payload().linhas as any[];
    const la = linhas.find((l) => l.id === Number(a.row.id))!;
    const lb = linhas.find((l) => l.id === Number(b.row.id))!;
    assert.equal(la.precisa_recertificar, false);
    assert.equal(la.certificado_por, ator.name);
    assert.equal(lb.precisa_recertificar, true, 'certificação de 400 dias venceu');
    assert.ok(r.payload().pendentes >= 1);

    let buf = '';
    const res: any = { setHeader: () => res, end: (d: any) => { buf = String(d); return res; } };
    await exportarCertificacao({ query: { format: 'csv' }, user: ator } as any, res);
    assert.ok(buf.includes(String(a.row.email)));
    assert.ok(buf.includes('Recertificação vencida'));
    assert.ok(!buf.includes('senha_hash'), 'sem segredos');
  });
});
