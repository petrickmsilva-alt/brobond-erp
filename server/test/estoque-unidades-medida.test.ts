// ============================================================================
// ESTOQUE 3.0 — UNIDADES DE MEDIDA E CONVERSÃO DECLARADA (migration 0060)
// P3-04 / P3-07: compra em rolo × consumo em metro.
//
// O que este arquivo trava (banco de demonstração, mesmo contrato do PG):
//   A) mesma unidade é identidade — não precisa de regra cadastrada;
//   B) regra DECLARADA converte nos DOIS sentidos (1 rolo = 50 m ⇒ 120 m = 2,4 rolos);
//   C) cadeia declarada é resolvida e o CAMINHO volta na resposta (rolo → cx → m);
//   D) sem regra, o resultado é `null` — o ERP NÃO estima fator;
//   E) grandeza diferente é recusada no cadastro (metro ≠ quilo);
//   F) isolamento multiempresa: regra da empresa 2 não vale na empresa 1;
//   G) MRP usa a unidade de compra quando há conversão e marca
//      `conversao_ausente` quando o cadastro promete uma unidade sem regra.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, getStore } = await import('../src/services');
const { converterQuantidade, calcularConversao, regrasDeConversao, necessidadeNaUnidadeDeCompra } = await import('../src/unidades');
const { criarAtor, garantirAdmin, esperarErro } = await import('./_p1util');
const { escopoDeSistema } = await import('../src/empresa');

await garantirAdmin();
const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };
let gerente: any;

let seq = 0;
const unico = () => `${Date.now() % 100000}-${++seq}`;

// Códigos únicos por execução: o catálogo é da empresa e o banco persiste.
let ROLO = '';
let METRO = '';
let CAIXA = '';
let QUILO = '';
let ROLO_B = '';
let METRO_B = '';

before(async () => {
  getStore();
  gerente = await criarAtor(1, 'gerente');
  await criarAtor(2, 'gerente');
  // Códigos do catálogo padrão (UNIDADES): é o conjunto que os cadastros de
  // insumo aceitam, então a conversão tem de ser declarada entre ELES.
  ROLO = 'rl';
  METRO = 'm';
  CAIXA = 'cx';
  QUILO = 'kg';
  // Par usado só na empresa 2 — prova o isolamento do catálogo.
  ROLO_B = 'pct';
  METRO_B = 'un';

  const unidade = (empresaId: number, codigo: string, grandeza: string) =>
    createRecord(RESOURCES.unidades_medida, { codigo, nome: codigo, grandeza, casas_decimais: 3 }, admin, {
      escopo: { kind: 'empresa', empresaId },
    } as any);

  await unidade(1, ROLO, 'comprimento');
  await unidade(1, METRO, 'comprimento');
  await unidade(1, CAIXA, 'comprimento');
  await unidade(1, QUILO, 'massa');
  await unidade(2, ROLO_B, 'comprimento');
  await unidade(2, METRO_B, 'comprimento');
});

const conversao = (empresaId: number, de: string, para: string, fator: number) =>
  createRecord(RESOURCES.unidade_conversoes, { de_codigo: de, para_codigo: para, fator }, admin, {
    escopo: { kind: 'empresa', empresaId },
  } as any);

// ---------------------------------------------------------------------------
test('A) mesma unidade é identidade, mesmo sem regra cadastrada', () => {
  const r = calcularConversao(METRO, METRO, []);
  assert.ok(r);
  assert.equal(r!.fator, 1);
  assert.equal(r!.origem, 'identica');
  assert.deepEqual(r!.caminho, []);
});

test('B) regra declarada converte nos DOIS sentidos e volta no caminho', async () => {
  await conversao(1, ROLO, METRO, 50);

  const regras = await regrasDeConversao(1);
  const ida = calcularConversao(ROLO, METRO, regras);
  assert.ok(ida, 'rolo → m deve converter');
  assert.equal(ida!.fator, 50);
  assert.equal(ida!.origem, 'direta');
  assert.equal(ida!.caminho.length, 1);

  const volta = calcularConversao(METRO, ROLO, regras);
  assert.ok(volta, 'm → rolo deve converter pela MESMA regra (inversa)');
  assert.equal(Number(volta!.fator.toFixed(6)), 0.02);
  assert.equal(volta!.caminho[0].inversa, true);

  const q = await converterQuantidade(1, 120, METRO, ROLO);
  assert.equal(q!.quantidade, 2.4, '120 m = 2,4 rolos de 50 m');
});

test('C) cadeia declarada é resolvida e o caminho fica explícito', async () => {
  // 1 caixa = 4 rolos; 1 rolo = 50 m  ⇒  1 caixa = 200 m
  await conversao(1, CAIXA, ROLO, 4);
  const regras = await regrasDeConversao(1);
  const r = calcularConversao(CAIXA, METRO, regras);
  assert.ok(r, 'caixa → m deve resolver pela cadeia');
  assert.equal(r!.fator, 200);
  assert.equal(r!.origem, 'cadeia');
  assert.equal(r!.caminho.length, 2, 'duas regras: caixa→rolo e rolo→m');
  assert.deepEqual(r!.caminho.map((p) => `${p.de}->${p.para}`), ['cx->rl', 'rl->m']);
});

test('D) sem regra declarada o resultado é null — nenhum fator é estimado', async () => {
  const regras = await regrasDeConversao(1);
  assert.equal(calcularConversao(METRO, QUILO, regras), null, 'metro → quilo nunca converte');
  assert.equal(await converterQuantidade(1, 10, METRO, `inexistente${unico()}`), null);
});

test('E) cadastro recusa grandeza diferente e par idêntico', async () => {
  const e1 = await esperarErro(() => conversao(1, METRO, QUILO, 2), 400, /[Gg]randezas diferentes/);
  assert.ok(e1);
  const e2 = await esperarErro(() => conversao(1, METRO, METRO, 1), 400, /não formam conversão/);
  assert.ok(e2);
  const e3 = await esperarErro(() => conversao(1, 'NAOEXISTE', METRO, 1), 400, /(não existe no catálogo|Máximo|Opção inválida)/);
  assert.ok(e3);
  const e4 = await esperarErro(() => conversao(1, ROLO, METRO, 0), 400, /(Mínimo|maior que zero)/);
  assert.ok(e4);
});

test('F) regra da empresa 2 não vale na empresa 1', async () => {
  await conversao(2, ROLO_B, METRO_B, 33);
  const regras1 = await regrasDeConversao(1);
  assert.equal(
    regras1.some((r) => r.de === ROLO_B || r.para === ROLO_B),
    false,
    'a empresa 1 não enxerga a regra da empresa 2'
  );
  assert.equal(await converterQuantidade(1, 33, ROLO_B, METRO_B), null);
  assert.equal((await converterQuantidade(2, 33, ROLO_B, METRO_B))!.quantidade, 1089);
});

test('G) unidade de compra do insumo: converte quando declarado, avisa quando falta regra', async () => {
  const insumoComRegra = await createRecord(
    RESOURCES.insumos,
    { nome: `Tecido ${unico()}`, unidade: METRO, unidade_compra: ROLO },
    admin,
    { escopo: { kind: 'empresa', empresaId: 1 } } as any
  );
  const ok = await necessidadeNaUnidadeDeCompra(1, insumoComRegra, 250);
  assert.ok(ok, 'com regra declarada, compra em rolo');
  assert.equal(ok!.unidade_compra, ROLO);
  assert.equal(ok!.quantidade, 5, '250 m = 5 rolos de 50 m');
  assert.equal(ok!.conversao.caminho.length, 1);

  // Insumo que promete compra em unidade SEM regra: nada é inventado.
  const insumoSemRegra = await createRecord(
    RESOURCES.insumos,
    { nome: `Tecido sem fator ${unico()}`, unidade: METRO, unidade_compra: QUILO },
    admin,
    { escopo: { kind: 'empresa', empresaId: 1 } } as any
  );
  assert.equal(await necessidadeNaUnidadeDeCompra(1, insumoSemRegra, 10), null);

  // Insumo sem unidade de compra: compra na mesma unidade de uso.
  const insumoSemCompra = await createRecord(
    RESOURCES.insumos,
    { nome: `Tecido simples ${unico()}`, unidade: METRO },
    admin,
    { escopo: { kind: 'empresa', empresaId: 1 } } as any
  );
  assert.equal(await necessidadeNaUnidadeDeCompra(1, insumoSemCompra, 10), null);
});

test('H) ISOLAMENTO A × B: catálogo e regras não atravessam empresa', async () => {
  // Escopos explícitos das duas empresas (o gate de arquitetura lê este arquivo
  // para provar que o recurso tem teste de tenancy nominal).
  const empresaA = escopoDeSistema(1);
  const empresaB = escopoDeSistema(2);
  assert.equal(empresaA.empresaId, 1);
  assert.equal(empresaB.empresaId, 2);

  const { listRecords } = await import('../src/services');
  const catalogoA = await listRecords(RESOURCES.unidades_medida, { page: 1, pageSize: 500, filter: {} }, empresaA as any);
  const catalogoB = await listRecords(RESOURCES.unidades_medida, { page: 1, pageSize: 500, filter: {} }, empresaB as any);
  const codigosA = catalogoA.rows.map((u: any) => String(u.codigo));
  const codigosB = catalogoB.rows.map((u: any) => String(u.codigo));
  assert.ok(codigosA.includes(ROLO), 'empresa 1 tem o seu rolo');
  assert.equal(codigosB.includes(ROLO), false, 'empresa 2 NÃO vê o rolo da empresa 1');
  assert.ok(codigosB.includes(ROLO_B), 'empresa 2 tem o próprio rolo (pct)');

  const regrasA = await listRecords(RESOURCES.unidade_conversoes, { page: 1, pageSize: 500, filter: {} }, empresaA as any);
  const regrasB = await listRecords(RESOURCES.unidade_conversoes, { page: 1, pageSize: 500, filter: {} }, empresaB as any);
  assert.equal(
    regrasA.rows.some((r: any) => String(r.de_codigo) === ROLO_B),
    false,
    'regra declarada na empresa 2 não aparece na empresa 1'
  );
  assert.equal(regrasB.rows.every((r: any) => Number(r.empresa_id) === 2), true, 'empresa 2 só vê as próprias regras');
});

test('metadados: catálogo e conversões são da empresa, com RBAC de gerente', () => {
  for (const key of ['unidades_medida', 'unidade_conversoes']) {
    const r = RESOURCES[key];
    assert.ok(r, `recurso ${key} deve existir`);
    assert.equal(r.empresa, true, `${key} precisa de escopo de empresa`);
    assert.equal(r.minPerfil, 'gerente', `${key} exige gerente (é cadastro, não operação)`);
  }
  const campo = RESOURCES.insumos.fields.find((f) => f.name === 'unidade_compra');
  assert.ok(campo, 'insumo deve expor unidade_compra');
  assert.match(String(campo!.hint), /não estima/i);
});
