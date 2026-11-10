// ============================================================================
// FASE 9.5 — LEIAUTES FISCAIS SPED/EFD: registro versionado e validador
// estrutural. Fixtures construídas a partir dos campos PUBLICADOS nos guias
// oficiais (EFD ICMS/IPI Guia Prático 3.2.2; EFD-Contribuições Guia 1.35,
// Tabela 3.1.1). Nenhum código fiscal inventado.
//
// O que este arquivo trava:
//   A) arquivo EFD ICMS/IPI bem-formado passa;
//   B) campo obrigatório vazio reprova;
//   C) campo numérico não-numérico reprova;
//   D) registro desconhecido reprova;
//   E) quantidade de campos errada reprova;
//   F) QTD_LIN_0/C/9999 divergente reprova;
//   G) C100 sem C170/C190 reprova;
//   H) total dos itens ≠ VL_MERC reprova;
//   I) referência a item/participante/unidade inexistente reprova;
//   J) documento duplicado reprova;
//   K) período incoerente (meses diferentes) reprova;
//   L) layout vigente por período; período sem leiaute lança (não presume).
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { validarEfd, GRAMATICA_EFD_ICMS_IPI, resolverLeiauteVigente, SEED_LAYOUTS_FISCAIS } = await import('../src/fiscalLayouts');
const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { criarAtor, garantirAdmin } = await import('./_p1util');

await garantirAdmin();
const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };

/** Junta os campos de um registro com os delimitadores `|...|`. */
const L = (...campos: (string | number)[]) => `|${campos.join('|')}|`;

const CHAVE = '35250111111111000191550010000001231000001234'; // 44 dígitos

/** Monta um arquivo EFD ICMS/IPI válido e mínimo (0000..9999). */
function arquivoValido(): string[] {
  return [
    L('0000', '020', '0', '01012025', '31012025', 'EMPRESA TESTE LTDA', '11111111000191', '', 'SP', '111111111111', '3550308', '', '', 'A', '1'),
    L('0001', '0'),
    L('0150', 'FORNEC1', 'FORNECEDOR TESTE', '1058', '22222222000191', '', '', '3550308', '', 'Rua A', '100', '', 'Centro'),
    L('0190', 'UN', 'UNIDADE'),
    L('0200', 'PROD1', 'PRODUTO TESTE', '', '', 'UN', '00', '61091000', '', '', '', '', ''),
    L('0990', '5'),
    L('C001', '0'),
    L('C100', '0', '1', 'FORNEC1', '55', '00', '', '123', CHAVE, '01012025', '01012025', '100,00', '0', '', '', '100,00', '9', '', '', '', '', '', '', '', '', '', '', '', ''),
    L('C170', '1', 'PROD1', 'PRODUTO TESTE', '10,00000', 'UN', '100,00', '', '0', '000', '1102', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''),
    L('C190', '000', '1102', '', '100,00', '', '', '', '', '', '', ''),
    L('C990', '5'),
    L('9999', '12'),
  ];
}

before(async () => {
  await criarAtor(1, 'gerente');
  // O leiaute é dado de REFERÊNCIA global: a autoridade é a migração 0115 no
  // PostgreSQL. No modo memória semeamos a MESMA lista canônica
  // (`SEED_LAYOUTS_FISCAIS`) para exercitar `resolverLeiauteVigente`.
  const s = getStore();
  const jaTem = await s.list(RESOURCES.fiscal_layouts, { page: 1, pageSize: 1 });
  if (jaTem.total === 0) {
    for (const l of SEED_LAYOUTS_FISCAIS) await s.insert(RESOURCES.fiscal_layouts, { ...l });
  }
});

test('A) arquivo EFD ICMS/IPI bem-formado é válido', () => {
  const r = validarEfd('EFD_ICMS_IPI', '020', arquivoValido());
  assert.equal(r.valido, true, JSON.stringify(r.erros));
  assert.equal(r.erros.length, 0);
  assert.equal(r.registros.C100, 1);
  assert.equal(r.registros.C170, 1);
  assert.equal(r.total_linhas, 12);
});

test('B) campo obrigatório vazio reprova (VL_DOC do C100)', () => {
  const linhas = arquivoValido();
  // VL_DOC (índice 11 no C100) vira vazio
  const c = linhas[7].slice(1, -1).split('|');
  c[11] = '';
  linhas[7] = `|${c.join('|')}|`;
  const r = validarEfd('EFD_ICMS_IPI', '020', linhas);
  assert.equal(r.valido, false);
  assert.ok(r.erros.some((e) => e.codigo === 'CAMPO_OBRIGATORIO' && e.campo === 'VL_DOC'));
});

test('C) campo numérico com texto reprova (QTD do C170)', () => {
  const linhas = arquivoValido();
  const c = linhas[8].slice(1, -1).split('|');
  c[4] = 'dez';
  linhas[8] = `|${c.join('|')}|`;
  const r = validarEfd('EFD_ICMS_IPI', '020', linhas);
  assert.ok(r.erros.some((e) => e.codigo === 'CAMPO_NAO_NUMERICO' && e.campo === 'QTD'));
});

test('D) registro desconhecido reprova (X999)', () => {
  const linhas = arquivoValido();
  linhas.splice(linhas.length - 1, 0, L('X999', '1'));
  const r = validarEfd('EFD_ICMS_IPI', '020', linhas);
  assert.ok(r.erros.some((e) => e.codigo === 'REGISTRO_DESCONHECIDO'));
});

test('E) quantidade de campos errada reprova (0000 com campo a menos)', () => {
  const linhas = arquivoValido();
  linhas[0] = L('0000', '020', '0', '01012025', '31012025', 'EMPRESA', '11111111000191', '', 'SP', '111111111111', '3550308', '', '', 'A'); // falta IND_ATIV
  const r = validarEfd('EFD_ICMS_IPI', '020', linhas);
  assert.ok(r.erros.some((e) => e.codigo === 'QTD_CAMPOS' && e.registro === '0000'));
});

test('F) QTD_LIN_0 divergente reprova', () => {
  const linhas = arquivoValido();
  const c = linhas[5].slice(1, -1).split('|');
  c[1] = '99';
  linhas[5] = `|${c.join('|')}|`;
  const r = validarEfd('EFD_ICMS_IPI', '020', linhas);
  assert.ok(r.erros.some((e) => e.codigo === 'QTD_LIN_DIVERGENTE' && e.registro === '0990'));
});

test('G) C100 sem C170 e sem C190 reprova', () => {
  const linhas = arquivoValido();
  linhas.splice(8, 2); // remove C170 e C190
  // reajusta contadores: bloco C agora tem 3 linhas (C001, C100, C990)
  const c990 = linhas.findIndex((l) => l.startsWith('|C990|'));
  linhas[c990] = L('C990', '3');
  const i9999 = linhas.findIndex((l) => l.startsWith('|9999|'));
  linhas[i9999] = L('9999', String(linhas.length));
  const r = validarEfd('EFD_ICMS_IPI', '020', linhas);
  assert.ok(r.erros.some((e) => e.codigo === 'C100_SEM_C170'));
  assert.ok(r.erros.some((e) => e.codigo === 'C100_SEM_C190'));
});

test('H) soma dos itens ≠ VL_MERC reprova', () => {
  const linhas = arquivoValido();
  const c = linhas[8].slice(1, -1).split('|');
  c[6] = '90,00'; // VL_ITEM = 90 mas VL_MERC = 100
  linhas[8] = `|${c.join('|')}|`;
  const r = validarEfd('EFD_ICMS_IPI', '020', linhas);
  assert.ok(r.erros.some((e) => e.codigo === 'TOTAL_DIVERGENTE'));
});

test('I) referências inexistentes reprovam (item, participante, unidade)', () => {
  const linhas = arquivoValido();
  const cp = linhas[7].slice(1, -1).split('|'); cp[3] = 'NAOEXISTE'; linhas[7] = `|${cp.join('|')}|`;
  const ci = linhas[8].slice(1, -1).split('|'); ci[2] = 'ITEM_X'; ci[5] = 'XX'; linhas[8] = `|${ci.join('|')}|`;
  const r = validarEfd('EFD_ICMS_IPI', '020', linhas);
  assert.ok(r.erros.some((e) => e.codigo === 'PARTICIPANTE_INEXISTENTE'));
  assert.ok(r.erros.some((e) => e.codigo === 'ITEM_INEXISTENTE'));
  assert.ok(r.erros.some((e) => e.codigo === 'UNIDADE_INEXISTENTE'));
});

test('J) documento duplicado reprova', () => {
  const linhas = arquivoValido();
  const blocoC = linhas.slice(6, 11); // C001..C990
  // duplica o conjunto C100/C170/C190 antes do C990
  const dup = [linhas[7], linhas[8], linhas[9]];
  linhas.splice(10, 0, ...dup);
  // reajusta contadores
  const c990 = linhas.findIndex((l) => l.startsWith('|C990|'));
  linhas[c990] = L('C990', String(c990 - 6 + 1));
  const i9999 = linhas.findIndex((l) => l.startsWith('|9999|'));
  linhas[i9999] = L('9999', String(linhas.length));
  void blocoC;
  const r = validarEfd('EFD_ICMS_IPI', '020', linhas);
  assert.ok(r.erros.some((e) => e.codigo === 'DOCUMENTO_DUPLICADO'));
});

test('K) período incoerente (DT_INI e DT_FIN de meses diferentes) reprova', () => {
  const linhas = arquivoValido();
  const c = linhas[0].slice(1, -1).split('|');
  c[4] = '28022025'; // fev/2025 enquanto DT_INI é jan/2025
  linhas[0] = `|${c.join('|')}|`;
  const r = validarEfd('EFD_ICMS_IPI', '020', linhas);
  assert.ok(r.erros.some((e) => e.codigo === 'PERIODO_INCOERENTE'));
});

test('L) resolverLeiauteVigente: 2025→020, 2024→019, 2023→018; período sem leiaute lança', async () => {
  const l2025 = await resolverLeiauteVigente('EFD_ICMS_IPI', '2025-06');
  assert.equal(l2025.codigo_versao, '020');
  assert.match(l2025.fonte_url, /sped\.rfb\.gov\.br/);
  const l2024 = await resolverLeiauteVigente('EFD_ICMS_IPI', '2024-03');
  assert.equal(l2024.codigo_versao, '019');
  const l2023 = await resolverLeiauteVigente('EFD_ICMS_IPI', '2023-05');
  assert.equal(l2023.codigo_versao, '018');
  await assert.rejects(() => resolverLeiauteVigente('EFD_ICMS_IPI', '2010-01'), /Nenhum leiaute/);
  const lc2020 = await resolverLeiauteVigente('EFD_CONTRIBUICOES', '2020-05');
  assert.equal(lc2020.codigo_versao, '006');
});

test('M) gramática: C170 tem 38 campos e C100 tem 29 (conferência da transcrição oficial)', () => {
  assert.equal(GRAMATICA_EFD_ICMS_IPI.C170.campos.length, 38);
  assert.equal(GRAMATICA_EFD_ICMS_IPI.C100.campos.length, 29);
  assert.equal(GRAMATICA_EFD_ICMS_IPI['0000'].campos.length, 15);
  assert.equal(GRAMATICA_EFD_ICMS_IPI.C190.campos.length, 12);
});

test('N) coerência: cada leiaute da semente canônica existe no seed da migração 0115', async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../../db/migrations/0115_fase9_5_fiscal_layouts.sql', import.meta.url), 'utf8');
  for (const l of SEED_LAYOUTS_FISCAIS) {
    assert.ok(sql.includes(`'${l.sistema}', '${l.codigo_versao}'`), `migração 0115 não contém ${l.sistema}/${l.codigo_versao}`);
  }
  // A tabela também precisa estar espelhada em db/schema.sql (regra do AGENTS.md).
  const schema = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');
  assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS fiscal_layouts'), 'fiscal_layouts ausente em db/schema.sql');
});

void admin;
