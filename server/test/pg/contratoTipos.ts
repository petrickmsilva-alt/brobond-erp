// ============================================================================
// CONTRATO TIPO × COLUNA — o inspetor reutilizável (ERP-03).
//
// Nasceu do P0-02: `gateway_webhook_events.payload` era declarado `textarea` no
// recurso e a coluna real é `jsonb`. Como o PostgreSQL não aceita um contrato
// "quase certo" — o driver serializa o que recebe, e o código que lia assumia
// texto — a divergência só apareceu em PostgreSQL real: todo webhook virava
// `ignorado`.
//
// O inspetor compara, para CADA campo não-virtual de CADA recurso:
//
//   1. EXISTÊNCIA — o campo tem coluna na tabela do recurso;
//   2. TIPO       — o tipo declarado no recurso aceita o tipo real da coluna;
//   3. UNICIDADE  — `unique` exige índice único GLOBAL da coluna;
//                   `uniqueEmpresa` exige índice único de (empresa_id, coluna).
//                   (É o contrato que o modo memória replica em `memdb.ts`:
//                   declarar `unique` onde o banco só tem unicidade por
//                   empresa faz a memória recusar o que o Postgres aceita.)
//
// Só o item 2 já teria pegado o P0-02. Os itens 1 e 3 pegam a mesma classe de
// defeito nas outras dimensões, sem custo nenhum.
//
// As exceções são EXPLÍCITAS e justificadas — nunca "ajustes de expectativa"
// genéricos: cada linha de `EXCECOES` diz qual campo está fora do contrato e
// por quê. Um campo novo que divirja não tem como passar.
// ============================================================================
import type { Resource } from '../../src/resources';

/** Compatibilidade declarada → tipos de coluna aceitos pelo driver e pelo domínio. */
export const TIPOS_ACEITOS: Record<string, string[]> = {
  text: ['text', 'character varying', 'character', 'citext', 'uuid'],
  // `textarea` é texto longo: cabe em text/varchar, mas NÃO em jsonb (P0-02).
  textarea: ['text', 'character varying'],
  email: ['text', 'character varying', 'citext'],
  phone: ['text', 'character varying'],
  document: ['text', 'character varying'],
  select: ['text', 'character varying'],
  uf: ['text', 'character varying', 'character'],
  cep: ['text', 'character varying'],
  password: ['text', 'character varying'],
  color: ['text', 'character varying'],
  integer: ['integer', 'bigint', 'smallint', 'numeric'],
  ref: ['integer', 'bigint', 'smallint'],
  money: ['numeric', 'double precision', 'real', 'integer', 'bigint'],
  number: ['numeric', 'double precision', 'real', 'integer', 'bigint'],
  percent: ['numeric', 'double precision', 'real', 'integer', 'bigint'],
  boolean: ['boolean'],
  date: ['date', 'timestamp with time zone', 'timestamp without time zone', 'text'],
  datetime: ['timestamp with time zone', 'timestamp without time zone', 'date'],
  // `json` é objeto/lista: só jsonb/json (o store serializa o objeto); text não
  // serve porque o domínio lê o payload como estrutura, não como string.
  json: ['jsonb', 'json'],
};

/** Campos sem coluna por definição: não são gravados no banco. */
export const TIPOS_VIRTUAIS = new Set(['images', 'multiref']);

export type ExcecaoContrato = {
  recurso: string;
  campo: string;
  regra: 'existencia' | 'tipo' | 'unicidade' | 'interface';
  coluna?: string;
  motivo: string;
};

/**
 * O cliente renderiza o tipo `json`?
 *
 * Enquanto o `RecordForm` genérico não tinha editor de JSON, um campo `json`
 * editável em recurso PÚBLICO gravava `"[object Object]"` (o input de texto
 * chamava `String(objeto)`). O editor foi implementado em
 * `client/src/components/RecordForm.tsx` e provado por
 * `client/src/components/RecordForm.json.test.tsx`; por isso a regra de
 * interface abaixo deixa de reprovar esses campos. Se o renderizador for
 * removido, mude este flag para `false` e a regra volta a proteger o contrato.
 */
export const CLIENTE_SUPORTA_JSON = true;

// ---------------------------------------------------------------------------
// EXCEÇÕES CONHECIDAS — cada uma é uma dívida declarada, não uma tolerância.
// ---------------------------------------------------------------------------
export const EXCECOES: ExcecaoContrato[] = [
  {
    recurso: 'arquivos',
    campo: 'dados',
    regra: 'tipo',
    coluna: 'bytea',
    motivo:
      'Os bytes do anexo são gravados por uploads.ts (decode base64 → bytea); o recurso é interno e READ_ONLY, e o campo existe só para o store selecionar a coluna.',
  },
  {
    recurso: 'arquivos',
    campo: 'thumb',
    regra: 'tipo',
    coluna: 'bytea',
    motivo: 'Idem `dados`: miniatura do anexo, bytea, escrita exclusivamente por uploads.ts.',
  },
];

const chaveDe = (e: ExcecaoContrato) => `${e.recurso}.${e.campo}:${e.regra}`;

export function excecaoPara(recurso: string, campo: string, regra: ExcecaoContrato['regra']): ExcecaoContrato | undefined {
  return EXCECOES.find((e) => chaveDe(e) === `${recurso}.${campo}:${regra}`);
}

export type Coluna = { nome: string; tipo: string };
export type IndiceUnico = { nome: string; colunas: string[] };

export type Achado = {
  recurso: string;
  tabela: string;
  campo: string;
  regra: ExcecaoContrato['regra'];
  detalhe: string;
};

/** Um recurso + o que existe no banco para ele (nada é consultado aqui: o
 *  inspetor é puro e por isso pode ser testado com um recurso sintético). */
export type RecursoInspecionado = {
  recurso: Resource;
  colunas: Map<string, string>; // nome → data_type
  indices: IndiceUnico[];
};

export function inspecionar(entrada: RecursoInspecionado[]): Achado[] {
  const achados: Achado[] = [];
  for (const { recurso: r, colunas, indices } of entrada) {
    for (const f of r.fields) {
      if (f.virtual || TIPOS_VIRTUAIS.has(f.type)) continue;

      // 1. existência
      const tipoColuna = colunas.get(f.name);
      if (!tipoColuna) {
        if (!excecaoPara(r.key, f.name, 'existencia')) {
          achados.push({ recurso: r.key, tabela: r.table, campo: f.name, regra: 'existencia', detalhe: 'campo declarado sem coluna na tabela' });
        }
        continue;
      }

      // 2. tipo
      const aceitos = TIPOS_ACEITOS[f.type];
      if (!aceitos) {
        achados.push({ recurso: r.key, tabela: r.table, campo: f.name, regra: 'tipo', detalhe: `tipo desconhecido no inspetor: "${f.type}"` });
      } else if (!aceitos.includes(tipoColuna) && !excecaoPara(r.key, f.name, 'tipo')) {
        achados.push({
          recurso: r.key,
          tabela: r.table,
          campo: f.name,
          regra: 'tipo',
          detalhe: `recurso declara "${f.type}" (${aceitos.join('/')}) mas a coluna é "${tipoColuna}"`,
        });
      }

      // 4. interface: campo `json` editável em recurso público. Enquanto o
      // cliente não renderiza o tipo `json`, o formulário genérico cai no input
      // de texto e `String(objeto)` vira "[object Object]" — editar um JSONB
      // gravaria lixo. Com o editor de JSON implementado (CLIENTE_SUPORTA_JSON),
      // o campo é editável de verdade; sem ele, precisa ser `form: false`.
      if (f.type === 'json' && !r.internal && f.form !== false && !CLIENTE_SUPORTA_JSON) {
        achados.push({
          recurso: r.key,
          tabela: r.table,
          campo: f.name,
          regra: 'interface',
          detalhe: 'campo json editável em recurso público — o cliente não renderiza json (form: false é o correto até existir renderizador)',
        });
      }

      // 3. unicidade
      if (!f.unique && !f.uniqueEmpresa) continue;
      const col = f.name;
      const ehEmpresa = (idx: IndiceUnico) => idx.colunas.length === 2 && idx.colunas.includes('empresa_id') && idx.colunas.includes(col);
      const ehGlobal = (idx: IndiceUnico) => idx.colunas.length === 1 && idx.colunas[0] === col;
      // `unique` (global) exige índice GLOBAL: o modo memória (memdb.ts) compara
      // o valor contra TODAS as linhas, então aceitar um índice por empresa aqui
      // mascararia a divergência memória × PostgreSQL (era o caso de
      // produtos.sku e empresas.nome antes do ERP-03).
      const ok = f.uniqueEmpresa ? indices.some(ehEmpresa) : indices.some(ehGlobal);
      if (!ok && !excecaoPara(r.key, f.name, 'unicidade')) {
        const esperado = f.uniqueEmpresa ? 'índice único (empresa_id, coluna)' : 'índice único global da coluna';
        const existentes = indices.map((i) => `(${i.colunas.join(', ')})`).join(' ') || 'nenhum índice único';
        achados.push({
          recurso: r.key,
          tabela: r.table,
          campo: f.name,
          regra: 'unicidade',
          detalhe: `declarado ${f.uniqueEmpresa ? 'uniqueEmpresa' : 'unique'} — exige ${esperado}; o banco tem ${existentes}`,
        });
      }
    }
  }
  return achados;
}

/**
 * Índices únicos da tabela, com as colunas na ordem do índice.
 *
 * Lê a lista de expressões do próprio `indexdef` (entre `USING <método> (` e o
 * primeiro `)`) e normaliza `lower(nome)` → `nome`. Índice PARCIAL (com `WHERE`)
 * conta: `uq_produtos_codigo_barras_empresa` é `(empresa_id, codigo_barras)
 * WHERE codigo_barras IS NOT NULL AND <> ''` e é exatamente o lastro do
 * `uniqueEmpresa` declarado no recurso. Índice de EXPRESSÃO que não vira uma
 * coluna simples é descartado — não há como casar com um campo.
 */
export function indicesUnicosDe(linhas: { indexname: string; indexdef: string }[]): IndiceUnico[] {
  return linhas
    .filter((l) => /CREATE UNIQUE INDEX/i.test(l.indexdef))
    .map((l) => {
      const m = l.indexdef.match(/USING\s+\w+\s*\(([^)]*)\)/i);
      const colunas = (m ? m[1] : '')
        .split(',')
        .map((c) => c.trim().replace(/^(lower|upper|trim)\s*\(/i, '').replace(/\)$/, '').replace(/"/g, '').trim())
        .filter(Boolean);
      return { nome: l.indexname, colunas };
    })
    .filter((i) => i.colunas.length > 0 && !i.colunas.some((c) => c.includes('(') || c.includes(' ')));
}
