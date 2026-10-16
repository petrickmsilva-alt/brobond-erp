// ============================================================================
// SEC-03 / P1-02 — GUARD CANÔNICO DE ADMINISTRADOR (unidade do middleware).
//
// Prova a regra mínima do ciclo no ponto mais baixo:
//
//   REQUEST → AUTHENTICATION → ADMIN AUTHORIZATION → HANDLER
//
// O guard é `requireRole('admin')` (server/src/auth.ts), derivado SOMENTE da
// identidade autenticada (`req.user.perfil`, populado pelo requireAuth a partir
// do JWT + revalidação no banco). Nenhum valor controlável pelo cliente — role,
// perfil, empresa_id, header, query ou parâmetro de rota — eleva privilégio.
//
// A prova de ponta a ponta (HTTP real → Express → guard → handler → Postgres)
// está em test/pg/sec03-admin-routes-authorization.test.ts; este arquivo fixa o
// contrato do middleware isoladamente (rápido, sem banco).
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { requireRole } = await import('../src/auth');

/** Resposta falsa: captura status + payload sem tocar em sockets. */
function resFake() {
  const saida: { status?: number; json?: any; headers: Record<string, string> } = { headers: {} };
  const res: any = {
    status: (s: number) => ((saida.status = s), res),
    json: (d: any) => ((saida.json = d), res),
  };
  return { res, saida };
}

/** Requisição com um usuário autenticado (ou ausente) e campos hostis do cliente. */
function reqDe(user: any, hostis: Record<string, any> = {}): any {
  return {
    user,
    body: hostis.body ?? {},
    query: hostis.query ?? {},
    params: hostis.params ?? {},
    headers: hostis.headers ?? {},
  };
}

const guard = requireRole('admin');

function chama(req: any): { passou: boolean; status?: number } {
  const { res, saida } = resFake();
  let passou = false;
  guard(req, res, () => {
    passou = true;
  });
  return { passou, status: saida.status };
}

describe('SEC-03: requireRole("admin") — decisão de autorização', () => {
  test('ADMIN autenticado passa (next chamado, sem resposta de erro)', () => {
    const r = chama(reqDe({ id: 1, name: 'Admin', email: 'a@x', perfil: 'admin' }));
    assert.equal(r.passou, true);
    assert.equal(r.status, undefined, 'admin não recebe status de erro');
  });

  test('GERENTE autenticado recebe 403 (nunca chega ao handler)', () => {
    const r = chama(reqDe({ id: 2, name: 'Gerente', email: 'g@x', perfil: 'gerente' }));
    assert.equal(r.passou, false);
    assert.equal(r.status, 403);
  });

  test('OPERADOR autenticado recebe 403', () => {
    const r = chama(reqDe({ id: 3, name: 'Operador', email: 'o@x', perfil: 'operador' }));
    assert.equal(r.passou, false);
    assert.equal(r.status, 403);
  });

  test('sem usuário (não autenticado) recebe 403 no guard (o 401 vem do requireAuth antes)', () => {
    const r = chama(reqDe(undefined));
    assert.equal(r.passou, false);
    assert.equal(r.status, 403);
  });

  test('perfil ausente/desconhecido não vira admin', () => {
    for (const perfil of [undefined, null, '', 'superadmin', 'ADMIN', 'Admin', 'root', 'owner']) {
      const r = chama(reqDe({ id: 9, name: 'X', email: 'x@x', perfil }));
      assert.equal(r.passou, false, `perfil ${String(perfil)} não pode passar`);
      assert.equal(r.status, 403);
    }
  });
});

describe('SEC-03: spoofing do cliente não eleva privilégio no guard', () => {
  test('role/perfil/empresa_id no corpo são ignorados (só a identidade autenticada decide)', () => {
    const r = chama(
      reqDe(
        { id: 2, name: 'Gerente', email: 'g@x', perfil: 'gerente' },
        { body: { perfil: 'admin', role: 'admin', empresa_id: 1, is_admin: true } }
      )
    );
    assert.equal(r.passou, false);
    assert.equal(r.status, 403);
  });

  test('query parameters (role/perfil/consolidado) são ignorados', () => {
    const r = chama(
      reqDe(
        { id: 2, name: 'Gerente', email: 'g@x', perfil: 'gerente' },
        { query: { perfil: 'admin', role: 'admin', consolidado: '1', admin: 'true' } }
      )
    );
    assert.equal(r.passou, false);
    assert.equal(r.status, 403);
  });

  test('headers arbitrários (x-perfil, x-role, x-empresa-consolidado) são ignorados', () => {
    const r = chama(
      reqDe(
        { id: 2, name: 'Gerente', email: 'g@x', perfil: 'gerente' },
        { headers: { 'x-perfil': 'admin', 'x-role': 'admin', role: 'admin', 'x-empresa-consolidado': '1', 'x-admin': 'true' } }
      )
    );
    assert.equal(r.passou, false);
    assert.equal(r.status, 403);
  });

  test('parâmetro de rota ("admin" no caminho) não autoriza — o guard olha o usuário, não a URL', () => {
    const r = chama(
      reqDe(
        { id: 2, name: 'Gerente', email: 'g@x', perfil: 'gerente' },
        { params: { resource: 'admin', role: 'admin' } }
      )
    );
    assert.equal(r.passou, false);
    assert.equal(r.status, 403);
  });
});
