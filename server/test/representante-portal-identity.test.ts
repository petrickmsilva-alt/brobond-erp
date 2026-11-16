import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { portalRepresentantePodeAcessar, restringirAcessoPortalRepresentante, obterIdentidadeRepresentante } =
  await import('../src/representantePortal');
const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { carteiraDoUsuario, invalidarCacheCarteira } = await import('../src/empresasAcesso');
const { signToken, requireAuth, invalidateUserCache } = await import('../src/auth');
const { abrirSessao } = await import('../src/sessoes');

test('allowlist do portal libera apenas autenticação, metadados e endpoints do portal', () => {
  assert.equal(portalRepresentantePodeAcessar('GET', '/api/meta'), true);
  assert.equal(portalRepresentantePodeAcessar('GET', '/api/auth/me'), true);
  assert.equal(portalRepresentantePodeAcessar('POST', '/api/auth/change-password'), true);
  assert.equal(portalRepresentantePodeAcessar('GET', '/api/representante/portal/me'), true);
  assert.equal(portalRepresentantePodeAcessar('POST', '/api/representante/portal/pedidos'), true);
  assert.equal(portalRepresentantePodeAcessar('GET', '/api/representantes'), false);
  assert.equal(portalRepresentantePodeAcessar('GET', '/api/clientes'), false);
  assert.equal(portalRepresentantePodeAcessar('POST', '/api/vendas'), false);
  assert.equal(portalRepresentantePodeAcessar('GET', '/api/financeiro/comissoes'), false);
});

test('middleware bloqueia chamadas diretas a módulos gerais para conta de portal', () => {
  let status = 200;
  let body: any;
  let nextChamado = false;
  const req: any = {
    method: 'GET',
    originalUrl: '/api/representantes?page=1',
    user: { id: 9, perfil: 'operador', portal_representante: true, carteira: 17 },
  };
  const res: any = {
    status(n: number) { status = n; return res; },
    json(v: unknown) { body = v; return res; },
  };

  restringirAcessoPortalRepresentante(req, res, () => { nextChamado = true; });
  assert.equal(status, 403);
  assert.equal(nextChamado, false);
  assert.match(String(body?.error), /exclusivo/i);
});

test('middleware permite a identidade própria e não afeta usuários ERP comuns', () => {
  const reqPortal: any = {
    method: 'GET',
    originalUrl: '/api/representante/portal/me',
    user: { id: 9, perfil: 'operador', portal_representante: true, carteira: 17 },
  };
  let nextPortal = false;
  const resPortal: any = { status() { return resPortal; }, json() { return resPortal; } };
  restringirAcessoPortalRepresentante(reqPortal, resPortal, () => { nextPortal = true; });
  assert.equal(nextPortal, true);

  const reqComum: any = { method: 'GET', originalUrl: '/api/vendas', user: { id: 10, perfil: 'operador', portal_representante: false } };
  let nextComum = false;
  restringirAcessoPortalRepresentante(reqComum, resPortal, () => { nextComum = true; });
  assert.equal(nextComum, true);
});

test('carteira do usuário é resolvida pela empresa ativa, sem reutilizar vínculo de outro tenant', async () => {
  const store = getStore();
  const usuario = await store.insert(RESOURCES.usuarios, {
    nome: 'Representante Multiempresa',
    email: 'representante.multiempresa@brobond.test',
    perfil: 'operador',
    empresa_id: 1,
    ativo: true,
  });
  const repA = await store.insert(RESOURCES.representantes, {
    nome: 'Representante Empresa A',
    empresa_id: 1,
    usuario_id: Number(usuario.id),
    ativo: true,
  });
  const repB = await store.insert(RESOURCES.representantes, {
    nome: 'Representante Empresa B',
    empresa_id: 2,
    usuario_id: Number(usuario.id),
    ativo: true,
  });

  invalidarCacheCarteira(Number(usuario.id));
  const emA = await carteiraDoUsuario({
    id: Number(usuario.id), perfil: 'operador', empresas: [1, 2], empresa_id: 1, empresa_sessao: 1,
  });
  const emB = await carteiraDoUsuario({
    id: Number(usuario.id), perfil: 'operador', empresas: [1, 2], empresa_id: 1, empresa_sessao: 2,
  });
  assert.equal(emA, Number(repA.id));
  assert.equal(emB, Number(repB.id));
  invalidarCacheCarteira(Number(usuario.id));
});

test('identidade do portal devolve apenas dados profissionais mínimos do representante ativo', async () => {
  const store = getStore();
  const usuario = await store.insert(RESOURCES.usuarios, {
    nome: 'Representante Portal',
    email: 'representante.portal@brobond.test',
    perfil: 'operador',
    empresa_id: 1,
    portal_representante: true,
    ativo: true,
  });
  const rep = await store.insert(RESOURCES.representantes, {
    nome: 'Representante Portal Teste',
    codigo: 'REP-PORTAL-TEST',
    tipo_representante: 'REPRESENTANTE_COMERCIAL',
    email: 'rep.portal@brobond.test',
    cpf: '52998224725',
    empresa_id: 1,
    usuario_id: Number(usuario.id),
    ativo: true,
  });

  const req: any = {
    user: {
      id: Number(usuario.id), name: String(usuario.nome), email: String(usuario.email),
      perfil: 'operador', portal_representante: true, carteira: Number(rep.id),
      empresa_id: 1, empresas: [1],
    },
  };
  let body: any;
  const res: any = { json(v: unknown) { body = v; return res; } };
  await obterIdentidadeRepresentante(req, res);

  assert.equal(body.representante.id, Number(rep.id));
  assert.equal(body.representante.nome, 'Representante Portal Teste');
  assert.equal(body.empresa_id, 1);
  assert.equal('cpf' in body.representante, false);
  assert.equal('cnpj' in body.representante, false);
});

test('conta marcada como portal sem representante ativo é recusada na autenticação', async () => {
  const store = getStore();
  const usuario = await store.insert(RESOURCES.usuarios, {
    nome: 'Portal sem vínculo',
    email: 'portal.sem.vinculo@brobond.test',
    perfil: 'operador',
    empresa_id: 1,
    portal_representante: true,
    ativo: true,
  });
  const sid = await abrirSessao({
    usuarioId: Number(usuario.id),
    lembrar: false,
    req: { headers: {}, socket: {} } as any,
  });
  const token = signToken({
    id: Number(usuario.id),
    name: String(usuario.nome),
    email: String(usuario.email),
    perfil: 'operador',
    empresa_id: 1,
    portal_representante: true,
  }, { sid, emp: 1 });

  let status = 200;
  let body: any;
  let nextChamado = false;
  const res: any = {
    status(n: number) { status = n; return res; },
    json(v: unknown) { body = v; return res; },
  };
  invalidateUserCache(Number(usuario.id));
  invalidarCacheCarteira(Number(usuario.id));
  await requireAuth({
    headers: { authorization: 'Bearer ' + token },
    query: {},
    method: 'GET',
    path: '/api/meta',
    originalUrl: '/api/meta',
  } as any, res, () => { nextChamado = true; });

  assert.equal(status, 403);
  assert.equal(nextChamado, false);
  assert.match(String(body?.error), /vínculo comercial inválido/i);
  invalidateUserCache(Number(usuario.id));
  invalidarCacheCarteira(Number(usuario.id));
});
