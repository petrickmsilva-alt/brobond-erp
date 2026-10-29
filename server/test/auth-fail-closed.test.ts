import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test'; delete process.env.DATABASE_URL;
const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { signToken, requireAuth, invalidateUserCache } = await import('../src/auth');
const { abrirSessao } = await import('../src/sessoes');

test('falha na revalidação de sessão fecha acesso, mesmo com JWT previamente válido', async () => {
  const store = getStore();
  const user = await store.insert(RESOURCES.usuarios, { nome: 'Usuário', email: 'auth-fail-closed@test.invalid', perfil: 'gerente', ativo: true });
  const sid = await abrirSessao({ usuarioId: Number(user.id), lembrar: false, req: { headers: {}, socket: {} } as any });
  const token = signToken({ id: Number(user.id), name: 'Usuário', email: String(user.email), perfil: 'gerente' }, { sid, emp: 1 });
  const original = store.findOneWhere.bind(store); invalidateUserCache(Number(user.id));
  store.findOneWhere = async () => { throw new Error('ERRO SENSÍVEL DO BANCO'); };
  let status = 200; let body: any; let called = false;
  const response: any = { status(n: number) { status = n; return response; }, json(v: unknown) { body = v; return response; } };
  try {
    await requireAuth({ headers: { authorization: `Bearer ${token}` }, query: {} } as any, response, () => { called = true; });
    assert.equal(status, 503); assert.equal(called, false); assert.doesNotMatch(JSON.stringify(body), /SENSÍVEL|BANCO/);
  } finally { store.findOneWhere = original; invalidateUserCache(Number(user.id)); }
});
