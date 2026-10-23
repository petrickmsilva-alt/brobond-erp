// ============================================================================
// P2-01 — INTEGRIDADE TEMPORAL DA CADEIA DE AUDITORIA AO PASSAR POR JSONB.
//
// Finding (FULL FORENSIC AUDIT): ao gravar um evento cujo payload de auditoria
// contém um `Date`, a assinatura da cadeia era calculada sobre o objeto cru
// (`jsonCanônico(Date)` devolvia `{}`) enquanto o JSONB persistia a string ISO.
// O instante nunca entrava no hash e a cadeia "quebrava" na releitura.
//
// Este arquivo prova, no Store real (modo demonstração / memória):
//   A — Date simples;                    B — Date com milissegundos;
//   C — Date UTC;                        D — Date com offset;
//   E — mudança de timezone do processo; F — Date aninhado;
//   G — Date em array;                   H — múltiplos Dates no payload;
//   I — null;                            J — campo ausente;
//   K — string temporal que NÃO é Date;  L — valor inválido;
//   M — leitura após round-trip JSON (equivalente ao JSONB);
//   N — ordenação temporal determinística; Q — eventos concorrentes.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { getStore } = await import('../src/services');
const { jsonCanônico, normalizarPayloadAuditoria, instanteAuditoriaISO, hashCadeiaAuditoria } = await import('../src/auditChain');

const store = getStore();

let seq = 0;
function evento(dados: unknown, descricao = 'evento P2-01') {
  return store.audit({
    usuario_id: null,
    usuario: 'p2-01',
    acao: 'seguranca',
    recurso: null,
    registro_id: null,
    descricao: `${descricao} #${++seq}`,
    dados,
    empresa_id: 1,
  } as any);
}

/** Última linha de auditoria gravada (a mais recente por id). */
async function ultimoEvento() {
  const t = (store as any).tables.get('auditoria') as { rows: Map<number, any> };
  const ids = [...t.rows.keys()];
  return t.rows.get(ids[ids.length - 1]);
}

/** Simula a passagem por JSONB: o driver devolve o JSON já parseado. */
function comoJsonb(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v));
}

// ---------------------------------------------------------------------------
// Invariante central: o instante sobrevive à serialização canônica
// ---------------------------------------------------------------------------

test('invariante: jsonCanônico(Date) === jsonCanônico(Date.toISOString()) (mesmo instante, mesma assinatura)', () => {
  const d = new Date('2026-10-17T12:34:56.789Z');
  assert.equal(jsonCanônico(d), jsonCanônico(d.toISOString()));
  assert.equal(jsonCanônico(d), '"2026-10-17T12:34:56.789Z"');
});

// ---------------------------------------------------------------------------
// A–D — formas de instante
// ---------------------------------------------------------------------------

test('A: Date simples sobrevive ao round-trip e a cadeia permanece íntegra', async () => {
  const d = new Date('2026-10-17T12:34:56.000Z');
  await evento({ de: d });
  const linha = await ultimoEvento();
  assert.equal(linha.dados.de, '2026-10-17T12:34:56.000Z', 'o payload persistido é a string ISO');
  const verificado = await store.verificarAuditoria();
  assert.equal(verificado.ok, true, 'a cadeia continua íntegra');
  assert.equal(new Date(linha.dados.de).getTime(), d.getTime(), 'o instante é preservado');
});

test('B: Date com milissegundos preserva os milissegundos', async () => {
  const d = new Date('2026-10-17T12:34:56.789Z');
  await evento({ de: d });
  const linha = await ultimoEvento();
  assert.equal(linha.dados.de, '2026-10-17T12:34:56.789Z');
  assert.equal(new Date(linha.dados.de).getTime(), d.getTime());
  assert.equal((await store.verificarAuditoria()).ok, true);
});

test('C: Date em UTC mantém o instante exato', async () => {
  const d = new Date('2026-10-17T00:00:00.000Z');
  await evento({ de: d });
  const linha = await ultimoEvento();
  assert.equal(linha.dados.de, '2026-10-17T00:00:00.000Z');
  assert.equal(new Date(linha.dados.de).getTime(), d.getTime());
  assert.equal((await store.verificarAuditoria()).ok, true);
});

test('D: Date com offset é normalizado para o MESMO instante em UTC', async () => {
  // -03:00 → 15:34:56.789Z
  const d = new Date('2026-10-17T12:34:56.789-03:00');
  await evento({ de: d });
  const linha = await ultimoEvento();
  assert.equal(linha.dados.de, '2026-10-17T15:34:56.789Z', 'offset é convertido para UTC');
  assert.equal(new Date(linha.dados.de).getTime(), d.getTime(), 'o INSTANTE, não a aparência, é preservado');
  assert.equal((await store.verificarAuditoria()).ok, true);
});

test('D2: valores próximos de epoch e da virada do dia são preservados', async () => {
  const casos = [
    new Date(0),
    new Date('1970-01-01T00:00:00.001Z'),
    new Date('2026-10-17T23:59:59.999Z'),
    new Date('2026-10-18T00:00:00.000Z'),
  ];
  for (const d of casos) await evento({ de: d });
  const verificado = await store.verificarAuditoria();
  assert.equal(verificado.ok, true);
});

// ---------------------------------------------------------------------------
// E — mudança de timezone do processo
// ---------------------------------------------------------------------------

test('E: o instante não muda quando o processo roda em outro timezone', () => {
  const alvo = '2026-10-17T12:34:56.789Z';
  const script = `
    const { instanteAuditoriaISO } = await import(${JSON.stringify(fileURLToPath(new URL('../src/auditChain.ts', import.meta.url)))});
    const d = new Date(${JSON.stringify(alvo)});
    process.stdout.write(JSON.stringify({ iso: instanteAuditoriaISO(d), ms: d.getTime(), offsetMin: d.getTimezoneOffset() }));
  `;
  // TZ é lido pelo Node no startup: precisa entrar no ambiente do processo filho.
  const rodar = (tz: string) => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `processo em TZ=${tz} falhou: ${r.stderr}`);
    return JSON.parse(r.stdout) as { iso: string; ms: number; offsetMin: number };
  };
  const utc = rodar('UTC');
  const saoPaulo = rodar('America/Sao_Paulo');
  const toquio = rodar('Asia/Tokyo');

  for (const r of [utc, saoPaulo, toquio]) {
    assert.equal(r.iso, alvo, 'o formato persistido é sempre o mesmo instante em UTC');
    assert.equal(r.ms, new Date(alvo).getTime());
  }
  // Sanidade: os fusos realmente divergem, então o teste tem poder de detecção.
  assert.notEqual(utc.offsetMin, saoPaulo.offsetMin);
  assert.notEqual(utc.offsetMin, toquio.offsetMin);
});

// ---------------------------------------------------------------------------
// F–H — estruturas aninhadas, arrays e múltiplos instantes
// ---------------------------------------------------------------------------

test('F: Date em objeto aninhado é normalizado em profundidade', async () => {
  const d = new Date('2026-10-17T12:34:56.789Z');
  await evento({ dados: { criadoEm: d } });
  const linha = await ultimoEvento();
  assert.equal(linha.dados.dados.criadoEm, '2026-10-17T12:34:56.789Z');
  assert.equal((await store.verificarAuditoria()).ok, true);
});

test('G: Date dentro de array (inclusive aninhado) é normalizado', async () => {
  const d1 = new Date('2026-01-02T03:04:05.006Z');
  const d2 = new Date('2026-06-07T08:09:10.011Z');
  await evento({ eventos: [{ criadoEm: d1 }, { criadoEm: d2 }] });
  const linha = await ultimoEvento();
  assert.deepEqual(linha.dados.eventos, [
    { criadoEm: '2026-01-02T03:04:05.006Z' },
    { criadoEm: '2026-06-07T08:09:10.011Z' },
  ]);
  assert.equal((await store.verificarAuditoria()).ok, true);
});

test('H: múltiplos Dates no mesmo payload, inclusive tipos mistos, são preservados', async () => {
  const de = new Date('2026-03-04T05:06:07.008Z');
  const para = new Date('2026-09-10T11:12:13.014Z');
  await evento({ de, para, contador: 3, motivo: 'ajuste' });
  const linha = await ultimoEvento();
  assert.equal(linha.dados.de, '2026-03-04T05:06:07.008Z');
  assert.equal(linha.dados.para, '2026-09-10T11:12:13.014Z');
  assert.equal(linha.dados.contador, 3);
  assert.equal(linha.dados.motivo, 'ajuste');
  assert.equal((await store.verificarAuditoria()).ok, true);
});

// ---------------------------------------------------------------------------
// I–L — ausência, strings e valores inválidos
// ---------------------------------------------------------------------------

test('I: payload null é aceito e não quebra a cadeia', async () => {
  await evento(null);
  const linha = await ultimoEvento();
  assert.equal(linha.dados, null);
  assert.equal((await store.verificarAuditoria()).ok, true);
});

test('J: campo temporal ausente não é inventado', async () => {
  await evento({ outro: 'valor' });
  const linha = await ultimoEvento();
  assert.deepEqual(linha.dados, { outro: 'valor' });
  assert.equal('de' in linha.dados, false);
  assert.equal((await store.verificarAuditoria()).ok, true);
});

test('K: string temporal que NÃO é Date permanece string (não é reinterpretada)', async () => {
  await evento({ de: '2026-10-17T12:34:56.789Z', solta: '2026-10-17' });
  const linha = await ultimoEvento();
  assert.equal(typeof linha.dados.de, 'string');
  assert.equal(linha.dados.de, '2026-10-17T12:34:56.789Z');
  assert.equal(linha.dados.solta, '2026-10-17', 'data civil "YYYY-MM-DD" não é convertida');
  assert.equal((await store.verificarAuditoria()).ok, true);
});

test('L: Date inválido é recusado explicitamente (nunca descartado em silêncio)', () => {
  assert.throws(() => normalizarPayloadAuditoria(new Date('não é data')), /instante inválido/i);
  assert.throws(() => normalizarPayloadAuditoria({ x: [new Date(Number.NaN)] }), /instante inválido/i);
  assert.equal(instanteAuditoriaISO(new Date('não é data')), null);
});

test('L2: jsonCanônico recusa Date inválido em vez de assinar "null" (fecha a divergência da revisão)', () => {
  const invalido = new Date(Number.NaN);
  // Antes: jsonCanônico(invalido) devolvia "null" (JSON.stringify(null)) — o
  // instante era descartado em silêncio na assinatura. Agora é recusado.
  assert.throws(() => jsonCanônico(invalido), /instante inválido/i);
  assert.throws(() => jsonCanônico({ a: { b: invalido } }), /instante inválido/i, 'aninhado');
  assert.throws(() => jsonCanônico({ lista: [invalido] }), /instante inválido/i, 'em array');
  // A mensagem do caminho de assinatura difere da do caminho de persistência.
  assert.throws(() => jsonCanônico(invalido), /não pode ser assinado/i);
});

test('L3: hashCadeiaAuditoria recusa Date inválido dentro de dados (não assina "null")', () => {
  assert.throws(
    () => hashCadeiaAuditoria('', { usuario_id: null, usuario: 'x', acao: 'seguranca', recurso: null, registro_id: null, descricao: 'd', dados: { quando: new Date(Number.NaN) } } as any),
    /instante inválido/i
  );
  assert.throws(
    () => hashCadeiaAuditoria('', { usuario_id: null, usuario: 'x', acao: 'seguranca', recurso: null, registro_id: null, descricao: 'd', dados: { eventos: [{ em: new Date(NaN) }] } } as any),
    /instante inválido/i
  );
});

test('L4: a recusa de Date inválido NÃO altera hashes de datas válidas (sem migração histórica)', () => {
  // Assinatura de um evento com Date VÁLIDO tem de permanecer bit a bit a mesma
  // de antes do ajuste — o formato persistido (ISO UTC com ms) não mudou.
  const d = new Date('2026-10-17T12:34:56.789Z');
  const entrada = { usuario_id: 1, usuario: 'ana', acao: 'criar', recurso: 'tamanhos', registro_id: 7, descricao: 'x', dados: { de: d, quando: d.toISOString() } };
  const h = hashCadeiaAuditoria('', entrada as any);
  // O Date e a string ISO do mesmo instante assinam igual (comportamento antigo).
  const hString = hashCadeiaAuditoria('', { ...entrada, dados: { de: d.toISOString(), quando: d.toISOString() } } as any);
  assert.equal(h, hString, 'Date válido e a string ISO equivalente continuam assinando igual');
  assert.match(h, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// M — leitura após round-trip JSON (equivalente ao JSONB) + verificação
// ---------------------------------------------------------------------------

test('M: o payload lido de volta (JSON parseado, como o JSONB) revalida a assinatura da linha', async () => {
  await evento({ de: new Date('2026-10-17T12:34:56.789Z'), eventos: [{ em: new Date('2025-12-31T23:59:59.999Z') }] });
  const linha = await ultimoEvento();

  // Reconstrói a linha como o driver Postgres a entrega (dados já parseado).
  const comoLida = { ...linha, dados: comoJsonb(linha.dados) };
  assert.equal(
    hashCadeiaAuditoria(String(linha.hash_anterior), comoLida),
    String(linha.hash),
    'a assinatura recalculada sobre a linha lida do "JSONB" bate com a gravada'
  );
  // E a cadeia inteira continua íntegra.
  assert.equal((await store.verificarAuditoria()).ok, true);

  // E a adulteração do instante continua detectável.
  const adulterada = { ...comoLida, dados: { ...comoLida.dados, de: '2000-01-01T00:00:00.000Z' } };
  assert.notEqual(hashCadeiaAuditoria(String(linha.hash_anterior), adulterada), String(linha.hash), 'alterar o instante continua quebrando a cadeia');
});

// ---------------------------------------------------------------------------
// N — ordenação temporal determinística
// ---------------------------------------------------------------------------

test('N: eventos mantêm ordem determinística por id e os instantes ficam em ordem não-decrescente', async () => {
  const marca = `ordem-${++seq}`;
  const instantes = [
    new Date('2026-01-01T00:00:00.000Z'),
    new Date('2026-05-05T05:05:05.005Z'),
    new Date('2026-12-31T23:59:59.999Z'),
  ];
  for (const d of instantes) await evento({ marca, de: d });

  const t = (store as any).tables.get('auditoria') as { rows: Map<number, any> };
  const linhas = [...t.rows.values()]
    .filter((l) => l.dados && l.dados.marca === marca)
    .sort((a, b) => Number(a.id) - Number(b.id));
  assert.equal(linhas.length, 3, 'os três eventos do cenário foram gravados');
  const ms = linhas.map((l) => new Date(l.dados.de).getTime());
  assert.deepEqual(ms, instantes.map((d) => d.getTime()), 'a ordem por id preserva a ordem dos instantes');
  assert.equal((await store.verificarAuditoria()).ok, true);
});

// ---------------------------------------------------------------------------
// Q — concorrência
// ---------------------------------------------------------------------------

test('Q: eventos concorrentes com Date continuam formando uma cadeia única e íntegra', async () => {
  const antes = (await store.verificarAuditoria()).total;
  await Promise.all(
    Array.from({ length: 25 }, (_, i) => evento({ de: new Date(1_700_000_000_000 + i * 1000), i }, 'concorrente'))
  );
  const verificado = await store.verificarAuditoria();
  assert.equal(verificado.ok, true, 'a cadeia permanece íntegra após gravações concorrentes');
  assert.equal(verificado.total - antes, 25, 'nenhum evento se perdeu');
});

// ---------------------------------------------------------------------------
// R — chaves `undefined`: a assinatura precisa sobreviver ao round-trip JSON
//
// Achado (gate testes-postgres do CI): eventos que montam o payload com
// `campo: x ?? undefined` (ex.: `reprint_of` e `recuperado_de_lease` em
// printJobs.ts) quebravam a cadeia ao serem lidos do JSONB. `jsonCanônico`
// assinava `{"reprint_of":null}`, mas `JSON.stringify` DESCARTA a chave
// `undefined` na persistência — a releitura assinava `{}` e acusava quebra sem
// adulteração alguma. A regra agora é a mesma dos dois lados: chave `undefined`
// não existe no objeto.
// ---------------------------------------------------------------------------

test('R: invariante — jsonCanônico(x) === jsonCanônico(JSON.parse(JSON.stringify(x))) com chaves undefined', () => {
  const casos: Array<[string, unknown]> = [
    ['undefined de primeiro nível', { evento: 'print.job.created', reprint_of: undefined }],
    ['undefined aninhado', { a: { b: undefined, c: 1 } }],
    ['undefined em array vira null', { lista: [undefined, 1, undefined] }],
    ['mix de null e undefined', { n: null, u: undefined, z: 0 }],
    ['undefined sob chave que também existe como null', { reprint_of: null }],
    ['objeto profundamente aninhado', { x: { y: { z: undefined, w: [1, { k: undefined }] } } }],
  ];
  for (const [nome, valor] of casos) {
    assert.equal(
      jsonCanônico(valor),
      jsonCanônico(comoJsonb(valor)),
      `a assinatura divergiu do que a releitura vê: ${nome}`
    );
  }
});

test('R: chave undefined é descartada; null é preservado; array preserva a posição', () => {
  assert.equal(jsonCanônico({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(jsonCanônico({ a: 1, b: null }), '{"a":1,"b":null}');
  assert.equal(jsonCanônico({ lista: [1, undefined, 3] }), '{"lista":[1,null,3]}');
  assert.equal(jsonCanônico({ lista: [1, null, 3] }), '{"lista":[1,null,3]}', 'array: undefined e null coincidem, como no JSON');
  assert.equal(jsonCanônico(undefined), 'null');
  assert.equal(jsonCanônico({}), '{}');
});

test('R: evento de auditoria com chave undefined mantém a cadeia íntegra na releitura', async () => {
  const antes = (await store.verificarAuditoria()).total;
  // O payload é exatamente o que printJobs monta: `reprint_of` ausente vira
  // `undefined` e o hash precisa continuar válido depois do round-trip JSONB.
  await evento({ evento: 'print.job.created', status: 'QUEUED', doc_type: 'teste', reprint_of: undefined });
  await evento({ evento: 'print.job.claimed', status: 'CLAIMED', tentativa: 1, recuperado_de_lease: undefined });

  const linha = await ultimoEvento();
  // A chave `undefined` não entra na assinatura: assinar com ou sem ela é o
  // mesmo, e é isso que faz a releitura (após o JSONB, onde a chave some)
  // reproduzir o hash gravado.
  assert.equal(
    hashCadeiaAuditoria(linha.hash_anterior, { ...linha, dados: { ...linha.dados, reprint_of: undefined } }),
    linha.hash,
    'a chave undefined não pode alterar a assinatura'
  );

  const verificado = await store.verificarAuditoria();
  assert.equal(verificado.ok, true, `a cadeia ficou íntegra; quebras=${JSON.stringify(verificado.quebras)}`);
  assert.equal(verificado.total - antes, 2);
});

test('R: a assinatura gravada é a mesma que a releitura calcula (round-trip explícito)', async () => {
  await evento({ evento: 'print.job.created', reprint_of: undefined, doc_type: 'teste' });
  const linha = await ultimoEvento();
  const relido = comoJsonb(linha.dados);
  assert.equal(
    hashCadeiaAuditoria(linha.hash_anterior, { ...linha, dados: relido }),
    linha.hash,
    'o hash gravado precisa ser reproduzível a partir do payload já serializado'
  );
});
