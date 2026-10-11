// ============================================================================
// ERP-07 — ADMINISTRAÇÃO DE EMPRESAS contra POSTGRES REAL (P1-04).
//
// A suíte em memória prova as regras; esta prova que elas sobrevivem ao banco:
//
//   • `empresas` tem alçada de ADMINISTRADOR (a checagem que as rotas do CRUD
//     genérico chamam recusa gerente e operador nos quatro verbos);
//   • a empresa padrão (id 1) e a empresa com vínculos NÃO são excluídas nem
//     com o ator mais poderoso do sistema;
//   • empresa vazia é excluída normalmente — a guarda não é um bloqueio cego;
//   • a última palavra continua sendo do banco: com o guard removido, a FK
//     (`empresa_id` em 72 tabelas) responde `23503`.
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

const sufixo = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** CNPJ válido e diferente a cada execução (o cadastro recusa DV errado e o índice é único). */
function cnpjValidoAleatorio(): string {
  const base = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10));
  const dv = (nums: number[]) => {
    const pesos = nums.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = nums.reduce((acc, n, i) => acc + n * pesos[i], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = dv(base);
  const d2 = dv([...base, d1]);
  return [...base, d1, d2].join('');
}

type Perfil = 'admin' | 'gerente' | 'operador';

async function esperarErro(fn: () => Promise<unknown>, status: number, re?: RegExp) {
  try {
    await fn();
    assert.fail(`esperava HTTP ${status}, mas a operação foi permitida`);
  } catch (e: any) {
    assert.equal(e.status, status, `esperava ${status}, veio ${e.status}: ${e.message}`);
    if (re) assert.match(String(e.message), re);
  }
}

test('ERP-07 em Postgres real: alçada de administrador e guardas de exclusão de empresa', { skip }, async (t) => {
  const { query, migrate } = await import('../src/db');
  await migrate();

  const { RESOURCES } = await import('../src/resources');
  const { checkAccess, createRecord, deleteRecord, getRecord, listRecords, getStore } = await import('../src/services');

  const ADMIN = { id: 1, name: 'Admin ERP-07 PG', perfil: 'admin' as const, empresa_id: 1, empresas: [1] };
  const GERENTE = { id: 2, name: 'Gerente ERP-07 PG', perfil: 'gerente' as const, empresa_id: 1, empresas: [1] };
  const OPERADOR = { id: 3, name: 'Operador ERP-07 PG', perfil: 'operador' as const, empresa_id: 1, empresas: [1] };
  const s = getStore();

  // ---- 1) Alçada: é a MESMA checagem que as rotas do CRUD chamam ----------
  assert.equal(RESOURCES.empresas.adminOnly, true, 'a declaração é a fonte da alçada');
  for (const op of ['read', 'create', 'update', 'delete'] as const) {
    await esperarErro(async () => checkAccess(RESOURCES.empresas, GERENTE, op), 403, /administradores/i);
    await esperarErro(async () => checkAccess(RESOURCES.empresas, OPERADOR, op), 403, /administradores/i);
    checkAccess(RESOURCES.empresas, ADMIN, op);
  }

  // ---- 2) A empresa padrão não se apaga -----------------------------------
  const padraoAntes = await getRecord(RESOURCES.empresas, 1, ADMIN);
  assert.ok(padraoAntes, 'a empresa padrão existe no banco novo');
  await esperarErro(() => deleteRecord(RESOURCES.empresas, 1, ADMIN), 409, /empresa padrão|BROBOND/i);
  assert.ok(await getRecord(RESOURCES.empresas, 1, ADMIN), 'a empresa padrão continua no banco');

  // ---- 3) Empresa com acesso concedido a usuário não se apaga -------------
  const comAcesso = await createRecord(RESOURCES.empresas, { nome: `E07 acesso ${sufixo}` }, ADMIN);
  const empresaAcesso = Number(comAcesso.id);
  const usuario = await createRecord(
    RESOURCES.usuarios,
    { nome: `Usuario E07 ${sufixo}`, email: `e07-${sufixo}@example.test`, perfil: 'gerente', ativo: true },
    ADMIN
  );
  await s.insert(RESOURCES.usuario_empresas, { usuario_id: Number(usuario.id), empresa_id: empresaAcesso });
  await esperarErro(() => deleteRecord(RESOURCES.empresas, empresaAcesso, ADMIN), 409, /usuário|acesso/i);
  assert.ok(await getRecord(RESOURCES.empresas, empresaAcesso, ADMIN), 'a empresa com acesso continua no banco');

  // ---- 4) Empresa com DADOS operacionais não se apaga --------------------
  const comDados = await createRecord(RESOURCES.empresas, { nome: `E07 dados ${sufixo}` }, ADMIN);
  const empresaDados = Number(comDados.id);
  const atorDaEmpresa = { id: 1, name: 'Admin ERP-07 PG', perfil: 'admin' as const, empresa_id: empresaDados, empresas: [empresaDados] };
  await createRecord(RESOURCES.produtos, { sku: `E07-${sufixo}`.toUpperCase().slice(0, 30), nome: `Produto ${sufixo}`, custo: 10, preco_venda: 20 }, atorDaEmpresa);
  assert.equal(
    Number((await query(`SELECT count(*)::int AS n FROM produtos WHERE empresa_id = $1`, [empresaDados])).rows[0].n),
    1,
    'o produto ficou na empresa nova'
  );
  await esperarErro(() => deleteRecord(RESOURCES.empresas, empresaDados, ADMIN), 409, /registros de|histórico/i);
  assert.ok(await getRecord(RESOURCES.empresas, empresaDados, ADMIN), 'a empresa com dados continua no banco');

  // ---- 5) A ÚLTIMA PALAVRA É DO BANCO: hard delete pela store é recusado --
  await assert.rejects(
    () => s.remove(RESOURCES.empresas, empresaDados),
    (e: any) => e.code === '23503',
    'mesmo sem passar pela guarda do serviço, a FK de produtos.empresa_id recusa (23503)'
  );

  // ---- 6) Empresa nova e vazia é excluída normalmente ---------------------
  const descartavel = await createRecord(RESOURCES.empresas, { nome: `E07 descartável ${sufixo}`, cnpj: cnpjValidoAleatorio() }, ADMIN);
  const empresaDescartavel = Number(descartavel.id);
  await deleteRecord(RESOURCES.empresas, empresaDescartavel, ADMIN);
  const lista = await listRecords(RESOURCES.empresas, { page: 1, pageSize: 500 }, ADMIN);
  assert.equal(
    lista.rows.some((r) => Number(r.id) === empresaDescartavel),
    false,
    'a empresa vazia saiu do banco'
  );

  // ---- 7) Limpeza do que este teste criou --------------------------------
  t.after(async () => {
    await query(`DELETE FROM usuario_empresas WHERE empresa_id = $1`, [empresaAcesso]).catch(() => undefined);
    await query(`DELETE FROM usuarios WHERE email = $1`, [`e07-${sufixo}@example.test`]).catch(() => undefined);
    await query(`DELETE FROM empresas WHERE id = ANY($1::int[])`, [[empresaAcesso]]).catch(() => undefined);
    // `empresaDados` fica: produtos (e o histórico) apontam para ela — é justamente a prova.
  });
});
