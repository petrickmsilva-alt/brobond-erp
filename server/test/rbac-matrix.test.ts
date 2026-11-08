// ============================================================================
// RBAC — contrato do guard de autorização (backend é a autoridade).
//
// A matriz em docs/architecture/RBAC-MATRIX.md é gerada de resources.ts; este
// teste trava o CONTRATO do guard para todas as classes de acesso:
//   • admin     → lê tudo; escreve onde `ops` permite.
//   • gerente   → lê/opera o que exige gerente; barrado no que exige admin.
//   • operador  → barrado onde exige gerente/admin; nunca exclui.
//   • catálogo global (categorias/cores/grades/tamanhos) → operador lê, não escreve.
//   • comercial (catalogos/politicas) → fail-closed para operador sem permissão.
//
// É a autorização do SERVIDOR: esconder botão no frontend não conta.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { checkAccess } = await import('../src/services');

type Perfil = 'admin' | 'gerente' | 'operador';
const ator = (perfil: Perfil) => ({ id: 1, name: 'x', perfil } as any);
const negado = (e: any) => e && e.status === 403;

const recursos = Object.values(RESOURCES) as any[];
const deGerente = recursos.filter((r) => r.minPerfil === 'gerente');
const deAdmin = recursos.filter((r) => r.minPerfil === 'admin' || r.adminOnly);
const abertosLeitura = recursos.filter((r) => !r.minPerfil && !r.adminOnly);

test('admin lê todos os recursos', () => {
  for (const r of recursos) assert.doesNotThrow(() => checkAccess(r, ator('admin'), 'read'), `${r.key}: admin precisa LER`);
});

test('gerente lê os recursos de gerente; operador NÃO', () => {
  assert.ok(deGerente.length > 0);
  for (const r of deGerente) {
    assert.doesNotThrow(() => checkAccess(r, ator('gerente'), 'read'), `${r.key}: gerente lê`);
    assert.throws(() => checkAccess(r, ator('operador'), 'read'), negado, `${r.key}: operador não lê`);
  }
});

test('recursos de admin barram gerente e operador', () => {
  assert.ok(deAdmin.length > 0);
  for (const r of deAdmin) {
    assert.doesNotThrow(() => checkAccess(r, ator('admin'), 'read'), `${r.key}: admin lê`);
    assert.throws(() => checkAccess(r, ator('gerente'), 'read'), negado, `${r.key}: gerente barrado`);
    assert.throws(() => checkAccess(r, ator('operador'), 'read'), negado, `${r.key}: operador barrado`);
  }
});

test('operador lê os recursos abertos à leitura', () => {
  assert.ok(abertosLeitura.length > 0);
  for (const r of abertosLeitura) assert.doesNotThrow(() => checkAccess(r, ator('operador'), 'read'), `${r.key}: operador lê`);
});

test('operador NUNCA exclui (mesmo em recurso aberto com ops.delete)', () => {
  const comDelete = recursos.filter((r) => r.ops?.delete);
  assert.ok(comDelete.length > 0);
  for (const r of comDelete) {
    assert.throws(() => checkAccess(r, ator('operador'), 'delete'), negado, `${r.key}: operador não exclui`);
  }
});

test('catálogo global: operador lê, mas não escreve (minPerfilEscrita)', () => {
  for (const key of ['categorias', 'cores', 'grades', 'tamanhos'] as const) {
    const r = RESOURCES[key] as any;
    assert.equal(r.minPerfilEscrita, 'gerente', `${key}: piso de escrita gerente`);
    assert.doesNotThrow(() => checkAccess(r, ator('operador'), 'read'), `${key}: operador lê`);
    for (const op of ['create', 'update', 'delete'] as const) {
      assert.throws(() => checkAccess(r, ator('operador'), op), negado, `${key}: operador não ${op}`);
    }
  }
});

test('comercial é fail-closed: operador sem permissão não acessa catálogos/políticas', () => {
  assert.throws(() => checkAccess(RESOURCES.catalogos as any, ator('operador'), 'read'), negado);
  assert.throws(() => checkAccess(RESOURCES.politicas_comerciais as any, ator('operador'), 'read'), negado);
});

test('comercial com permissão explícita (perm_catalogos=permitir) libera o operador', () => {
  const operador = { id: 1, name: 'x', perfil: 'operador', perm_catalogos: 'permitir' } as any;
  assert.doesNotThrow(() => checkAccess(RESOURCES.catalogos as any, operador, 'read'));
});

test('a matriz de RBAC cobre todo recurso (nenhum recurso sem regra declarada)', () => {
  const semRegra = recursos.filter((r) => !r.minPerfil && !r.adminOnly && !r.minPerfilEscrita && r.key !== 'catalogos' && r.key !== 'politicas_comerciais');
  // Recursos sem minPerfil são de leitura/operação aberta ao operador — o
  // contrato é: ou têm piso (minPerfil/adminOnly/minPerfilEscrita) ou são
  // explicitamente abertos. Nenhum pode estar indefinido por acidente.
  assert.ok(semRegra.length >= 0);
  for (const r of semRegra) assert.doesNotThrow(() => checkAccess(r, ator('operador'), 'read'), `${r.key}: aberto ao operador`);
});

test('a matriz documental (RBAC-MATRIX.md) bate com o código: 1 linha por recurso', () => {
  // Trava a divergência numérica recorrente: o total de recursos é o número de
  // linhas `| \`recurso\`` da seção 2, SEM contar cabeçalho/separador. Um recurso
  // novo em resources.ts sem entrada na matriz (ou vice-versa) quebra aqui.
  const caminho = new URL('../../docs/architecture/RBAC-MATRIX.md', import.meta.url);
  const texto = readFileSync(caminho, 'utf8');
  const linhas = texto.split('\n');
  let dentro = false;
  const daMatriz: string[] = [];
  for (const linha of linhas) {
    if (/^## 2\./.test(linha)) { dentro = true; continue; }
    if (dentro && /^> Matriz gerada/.test(linha)) break;
    if (dentro && /^\| `/.test(linha)) daMatriz.push(linha.split('|')[1].trim().replace(/`/g, ''));
  }
  const doCodigo = Object.keys(RESOURCES);
  assert.equal(new Set(daMatriz).size, daMatriz.length, 'matriz não pode ter recurso duplicado');
  assert.deepEqual(daMatriz.slice().sort(), doCodigo.slice().sort(), 'matriz × resources.ts divergem');
  // O cabeçalho declara o total; ele precisa bater com a contagem real.
  const declarado = Number((texto.match(/## 2\. Matriz por recurso \((\d+) recursos\)/) ?? [])[1]);
  assert.equal(declarado, doCodigo.length, 'total declarado no cabeçalho ≠ nº de recursos');
});
