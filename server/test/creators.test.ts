import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { readFileSync } from 'node:fs';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
const { capacidadesCreators } = await import('../src/creators');
const { HttpError } = await import('../src/errors');

function consultar(user?: Record<string, unknown>, query = {}) {
  let body: any;
  const headers: Record<string, string> = {};
  const req = { user, query, body: { empresa_id: 999 }, headers: { 'x-empresa-id': '999' } } as unknown as Request;
  const res = {
    setHeader: (key: string, value: string) => { headers[key] = value; },
    json: (value: unknown) => { body = value; },
  } as unknown as Response;
  capacidadesCreators(req, res);
  return { body, headers };
}

const actor = { id: 10, perfil: 'operador', empresa_id: 1, empresas: [1, 2] };

describe('Creators — capacidades, identidade e escopo', () => {
  test('sem sessão não usa o fallback de empresa de sistema', () => {
    assert.throws(() => consultar(), (e: unknown) => e instanceof HttpError && e.status === 401);
  });

  for (const perfil of ['admin', 'gerente', 'operador']) {
    test(`${perfil} consulta metadados com escrita restrita ao perfil autorizado`, () => {
      const { body, headers } = consultar({ ...actor, perfil });
      assert.equal(headers['Cache-Control'], 'private, no-store');
      assert.deepEqual(Object.keys(body.modulos), ['creators', 'creator-matches', 'outreach-ai', 'campanhas']);
      for (const nome of ['creators', 'creator-matches', 'campanhas']) {
        const capability = body.modulos[nome];
        assert.equal(capability.consulta, true);
        assert.equal(capability.criacao, perfil !== 'operador');
        assert.ok(capability.fonte);
        assert.ok(!('rows' in capability));
        assert.ok(!('total' in capability));
      }
      assert.equal(body.modulos['creator-matches'].recomendacao, false);
      const outreach = body.modulos['outreach-ai'];
      assert.equal(outreach.estado, 'PENDENTE_DE_CONFIGURACAO');
      assert.equal(outreach.motivo, 'PERSISTENCIA_NAO_INSTALADA');
      assert.equal(outreach.fonte, null);
      assert.equal(outreach.consulta, false);
      assert.ok(!Object.values(outreach).includes(true));
    });
  }

  test('identidade de emergência e perfil desconhecido são rejeitados', () => {
    for (const user of [{ ...actor, id: 0, perfil: 'admin' }, { ...actor, perfil: 'visitante' }]) {
      assert.throws(() => consultar(user), (e: unknown) => e instanceof HttpError && e.status === 403);
    }
  });

  test('query, corpo e header não trocam a empresa autenticada', () => {
    assert.equal(consultar(actor, { empresa_id: 999, consolidar: 'true' }).body.empresa_id, 1);
  });

  test('seletor autorizado da sessão usa somente a empresa concedida', () => {
    assert.equal(consultar({ ...actor, empresa_sessao: 2 }).body.empresa_id, 2);
    assert.equal(consultar({ ...actor, empresa_sessao: 999 }).body.empresa_id, 1);
    assert.equal(consultar({ ...actor, empresa_id: 3, empresas: [3] }).body.empresa_id, 3);
  });

  test('consolidação não expõe dados nem enumera empresas', () => {
    const { body } = consultar({ ...actor, pode_consolidar: true, consolidar: true });
    assert.deepEqual(Object.keys(body).sort(), ['empresa_id', 'modulos']);
    assert.ok(!JSON.stringify(body).includes('999'));
  });

  test('rota usa a cadeia autenticada antes do CRUD genérico', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const route = source.indexOf("app.get('/api/creators/capabilities', wrap(capacidadesCreators))");
    assert.ok(route > source.indexOf("app.use('/api', wrap(requireAuth))"));
    assert.ok(route > source.indexOf("app.use('/api', bloquearSenhaProvisoria)"));
    assert.ok(route < source.search(/app\.get\(\s*'\/api\/:resource'/));
  });
});

describe('Creators — HTTP com autenticação canônica e sessões reais de teste', () => {
  test('401 anônimo; admin/gerente/operador consultam apenas o escopo da sessão', async () => {
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { requireAuth, signToken } = await import('../src/auth');
    const { abrirSessao } = await import('../src/sessoes');
    const { getStore } = await import('../src/services');
    const { RESOURCES } = await import('../src/resources');
    const app = express();
    app.use((req, res, next) => { void requireAuth(req, res, next).catch(next); });
    app.get('/api/creators/capabilities', capacidadesCreators);
    await request(app).get('/api/creators/capabilities').expect(401);
    for (const perfil of ['admin', 'gerente', 'operador'] as const) {
      const row = await getStore().insert(RESOURCES.usuarios, {
        nome: `Creators ${perfil}`, email: `creators-${perfil}@teste.invalid`, perfil, ativo: true,
      });
      const sid = await abrirSessao({ usuarioId: Number(row.id), lembrar: false, req: { headers: {}, socket: {} } as Request });
      const token = signToken({ id: Number(row.id), name: String(row.nome), email: String(row.email), perfil }, { sid, emp: 999 });
      const response = await request(app)
        .get('/api/creators/capabilities?empresa_id=999&consolidado=1')
        .set('Authorization', `Bearer ${token}`)
        .set('x-empresa-id', '999')
        .expect(200);
      assert.equal(response.body.empresa_id, 1);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      const empresa = await getStore().insert(RESOURCES.empresas, { nome: `Empresa Creators ${perfil}`, ativo: true });
      await getStore().insert(RESOURCES.usuario_empresas, { usuario_id: row.id, empresa_id: empresa.id });
      const { invalidarCacheEmpresas } = await import('../src/empresasAcesso');
      invalidarCacheEmpresas(Number(row.id));
      const scopedToken = signToken({ id: Number(row.id), name: String(row.nome), email: String(row.email), perfil }, { sid, emp: Number(empresa.id) });
      const scoped = await request(app).get('/api/creators/capabilities?empresa_id=999')
        .set('Authorization', `Bearer ${scopedToken}`).expect(200);
      assert.equal(scoped.body.empresa_id, Number(empresa.id));
    }
  });
});
