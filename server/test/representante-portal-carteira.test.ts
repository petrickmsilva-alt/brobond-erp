import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { administrarAcessosPortal } = await import('../src/portal');

test('portal administrativo respeita a carteira temporal do representante', async () => {
  const store = getStore();
  const sufixo = `${Date.now()}-${process.pid}`;
  const usuario = await store.insert(RESOURCES.usuarios, {
    nome: `Representante Portal ${sufixo}`,
    email: `representante.portal.${sufixo}@brobond.test`,
    perfil: 'operador',
    empresa_id: 1,
    ativo: true,
  });
  const representante = await store.insert(RESOURCES.representantes, {
    nome: `Representante ${sufixo}`,
    empresa_id: 1,
    usuario_id: Number(usuario.id),
    ativo: true,
  });
  const ator: any = {
    id: Number(usuario.id),
    name: String(usuario.nome),
    perfil: 'operador',
    empresa_id: 1,
    empresas: [1],
    empresa_sessao: 1,
    carteira: Number(representante.id),
  };

  const proprio = await store.insert(RESOURCES.clientes, {
    empresa_id: 1,
    nome: `Cliente próprio ${sufixo}`,
    pessoa: 'pj',
    ativo: true,
  });
  const alheio = await store.insert(RESOURCES.clientes, {
    empresa_id: 1,
    nome: `Cliente alheio ${sufixo}`,
    pessoa: 'pj',
    ativo: true,
  });
  await store.insert(RESOURCES.representante_cliente, {
    empresa_id: 1,
    cliente_id: Number(proprio.id),
    representante_id: Number(representante.id),
    inicio: '2026-01-01',
    fim: null,
    status: 'ativo',
    participacao_pct: 100,
  });

  const reqProprio: any = { user: ator, params: { id: String(proprio.id) } };
  let resposta: any;
  const resProprio: any = { json(value: unknown) { resposta = value; return resProprio; } };
  await administrarAcessosPortal(reqProprio, resProprio);
  assert.equal(resposta.cliente, `Cliente próprio ${sufixo}`);
  assert.deepEqual(resposta.acessos, []);

  const reqAlheio: any = { user: ator, params: { id: String(alheio.id) } };
  const resAlheio: any = { json() { return resAlheio; } };
  await assert.rejects(
    () => administrarAcessosPortal(reqAlheio, resAlheio),
    (error: any) => error?.status === 404
  );
});
