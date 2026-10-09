// Implementação PostgreSQL do Store.
// SEGURANÇA: nomes de tabelas e colunas vêm exclusivamente de resources.ts;
// todos os valores do usuário entram como parâmetros ($1, $2...).
import type { PoolClient } from 'pg';
import { pool, query, withTransaction } from './db';
import { HttpError } from './errors';
import { COLUNAS_AUTENTICACAO, columnsOf, getResource, type Resource } from './resources';
import { hashCadeiaAuditoria, verificarCadeiaAuditoria } from './auditChain';
import { valorizarEstoque } from './valorizacao';
import type { EscopoEmpresa } from './empresa';
import { sqlCivil } from './fuso';
import { EMPRESA_PADRAO } from './empresa';
import {
  labelOf,
  type AuditEntry,
  type AuditoriaVerificacao,
  type DashboardData,
  type FileMeta,
  type ListParams,
  type ListResult,
  type Option,
  type Payload,
  type RateState,
  type Row,
  type Sessao,
  type Store,
  type TransactionOptions,
  type Tx,
} from './store';

function q(text: string, params: unknown[] = [], tx?: Tx) {
  return tx ? tx.query(text, params as any[]) : query(text, params);
}

/** Valida a empresa do produto e resolve, se informado, o Local canônico. */
async function canonicalInsumoEmpresa(insumoId: number, empresaId: number | undefined, tx?: Tx): Promise<number> {
  const res = await q(
    'SELECT empresa_id FROM insumos WHERE id = $1 AND ($2::integer IS NULL OR empresa_id = $2)',
    [insumoId, empresaId ?? null],
    tx
  );
  const dono = res.rows[0] ? Number(res.rows[0].empresa_id ?? EMPRESA_PADRAO) : null;
  if (dono === null || (empresaId !== undefined && Number(empresaId) !== dono)) {
    throw new HttpError(404, 'Insumo não encontrado.');
  }
  return dono;
}

async function canonicalStockCell(
  produtoId: number,
  tamanhoId: number | null,
  local: string,
  localId: number | null | undefined,
  empresaId: number | undefined,
  tx?: Tx
): Promise<{ empresaId: number; local: string; localId: number }> {
  const prod = await q(
    'SELECT empresa_id FROM produtos WHERE id = $1 AND ($2::integer IS NULL OR empresa_id = $2)',
    [produtoId, empresaId ?? null],
    tx
  );
  if (!prod.rows[0]) throw new HttpError(404, 'Produto não encontrado.');
  const dono = Number(prod.rows[0].empresa_id ?? EMPRESA_PADRAO);
  if (empresaId !== undefined && Number(empresaId) !== dono) throw new HttpError(404, 'Produto não encontrado.');
  if (localId === undefined || localId === null || !Number.isInteger(Number(localId)) || Number(localId) <= 0) {
    throw new HttpError(409, 'A movimentação exige um local canônico identificado por ID.');
  }
  const loc = await q('SELECT nome FROM locais WHERE id = $1 AND empresa_id = $2', [localId, dono], tx);
  if (!loc.rows[0]) throw new HttpError(404, 'Local não encontrado.');
  const nome = String(loc.rows[0].nome);
  const celulas = await q(
    `SELECT id, local_id, local FROM estoques
      WHERE empresa_id = $1 AND produto_id = $2
        AND tamanho_id IS NOT DISTINCT FROM $3
        AND (local_id = $5 OR (local_id IS NULL AND local = $4))
      LIMIT 2`,
    [dono, produtoId, tamanhoId, nome, localId],
    tx
  );
  if (celulas.rows.length > 1) throw new HttpError(409, 'Há saldos duplicados para este produto/tamanho/local. Nenhuma movimentação foi aplicada.');
  const existente = celulas.rows[0];
  if (existente && (existente.local_id === null || existente.local_id === undefined || Number(existente.local_id) !== Number(localId) || String(existente.local) !== nome)) {
    throw new HttpError(409, 'O saldo existente não possui vínculo canônico compatível. Nenhuma movimentação foi aplicada.');
  }
  return { empresaId: dono, local: nome, localId: Number(localId) };
}

/** Traduz erros do Postgres para mensagens amigáveis. */
export function translatePgError(e: any, r?: Resource): HttpError | null {
  if (!e || typeof e.code !== 'string') return null;
  switch (e.code) {
    case '23505': {
      // unique_violation — descobre o campo pelo nome do constraint / detail
      const constraint = String(e.constraint || e.detail || '');
      const field = r?.fields.find((f) => (f.unique || f.uniqueEmpresa) && constraint.includes(f.name));
      if (r?.key === 'estoques' && /estoques/i.test(constraint)) {
        return new HttpError(409, 'Já existe saldo para este produto, tamanho e local. Edite o registro existente ou lance uma movimentação.');
      }
      const label = field?.label || 'valor';
      return new HttpError(409, `Já existe um registro com este ${label.toLowerCase()}.`, field ? { [field.name]: 'Já cadastrado' } : undefined);
    }
    case '23503': {
      // foreign_key_violation
      if (/update or delete/i.test(e.message)) {
        return new HttpError(409, 'Este registro está em uso em outro módulo e não pode ser excluído. Você pode desativá-lo.');
      }
      const field = r?.fields.find((f) => f.type === 'ref' && String(e.constraint || e.detail || '').includes(f.name));
      return new HttpError(400, `${field?.label || 'Referência'} inválida: o registro selecionado não existe.`, field ? { [field.name]: 'Registro não encontrado' } : undefined);
    }
    case '23502':
      return new HttpError(400, `O campo "${e.column}" é obrigatório.`);
    case '40001':
    case '40P01':
      // serialization_failure / deadlock_detected — duas transações disputaram
      // as mesmas linhas (ex.: duas saídas do mesmo saldo). Não é falha do
      // servidor: é conflito de concorrência, e nada foi gravado. Sem esta
      // tradução o usuário via 500 numa operação que apenas perdeu a corrida.
      return new HttpError(
        409,
        'Outra operação alterou estes dados ao mesmo tempo. Nada foi gravado — confira os valores e tente novamente.'
      );
    case '22P02':
    case '22003':
    case '22007':
    case '22008':
      return new HttpError(400, 'Valor inválido em um dos campos.');
    case '42P01':
      return new HttpError(500, 'Tabela não encontrada no banco. Execute db/schema.sql.');
    case '42703': {
      const col =
        e.column ||
        (String(e.message || '').match(/column "?([a-z0-9_.]+)"?/i) || [])[1];
      return new HttpError(
        500,
        col
          ? `Coluna "${col}" não encontrada no banco. Execute db/schema.sql para migrar.`
          : 'Coluna não encontrada no banco. Execute db/schema.sql para migrar.'
      );
    }
    default:
      return null;
  }
}

function refJoins(r: Resource) {
  const refs = r.fields.filter((f) => f.type === 'ref' && f.ref && getResource(f.ref));
  const selects: string[] = [];
  const joins: string[] = [];
  refs.forEach((f, i) => {
    const target = getResource(f.ref!)!;
    const alias = `r${i}`;
    const labelExpr =
      target.labelFields.length === 1 && target.labelFields[0] === 'id'
        ? `('#' || ${alias}.id)`
        : `concat_ws(' — ', ${target.labelFields.map((lf) => `NULLIF(${alias}.${lf}::text, '')`).join(', ')})`;
    selects.push(`${labelExpr} AS ${f.name}__label`);
    const colorField = target.fields.find((tf) => tf.type === 'color');
    if (colorField) selects.push(`${alias}.${colorField.name} AS ${f.name}__color`);
    joins.push(`LEFT JOIN ${target.table} ${alias} ON ${alias}.id = t.${f.name}`);
  });
  return { selects, joins, refs };
}

function orderClause(r: Resource, p: ListParams): string {
  // `id` é ordenável (ver memdb.ts): trilhas de eventos pedem sort: 'id'.
  const cols = new Set(columnsOf(r).map((f) => f.name).concat('id'));
  const sort = p.sort && cols.has(p.sort) ? p.sort : r.orderBy?.field && cols.has(r.orderBy.field) ? r.orderBy.field : 'id';
  const dir = (p.dir || r.orderBy?.dir || 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  return `ORDER BY t.${sort} ${dir} NULLS LAST, t.id DESC`;
}

function searchClause(r: Resource, qtext: string | undefined, params: unknown[], refs: ReturnType<typeof refJoins>['refs'], filter?: Record<string, unknown>): string {
  const conds: string[] = [];
  // Filtros de igualdade (somente colunas reais do recurso)
  const cols = new Set(columnsOf(r).map((f) => f.name));
  const dateCols = new Set(r.fields.filter((f) => f.type === 'date' || f.type === 'datetime').map((f) => f.name));
  for (const [k, v] of Object.entries(filter || {})) {
    if (v === undefined || v === null || v === '') continue;
    // Intervalo de datas: f.<campo>_de / f.<campo>_ate (ex.: f.data_de, f.data_ate)
    const mDate = /^(.*?)_(de|ate)$/.exec(k);
    if (mDate && dateCols.has(mDate[1]) && typeof v === 'string') {
      const dia = v.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) continue;
      if (mDate[2] === 'de') {
        params.push(dia);
        conds.push(`t.${mDate[1]} >= $${params.length}::date`);
      } else {
        const d = new Date(`${dia}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        params.push(d.toISOString().slice(0, 10));
        conds.push(`t.${mDate[1]} < $${params.length}::date`);
      }
      continue;
    }
    if (!cols.has(k)) continue;
    params.push(v);
    conds.push(`t.${k} = $${params.length}`);
  }
  const term = (qtext || '').trim();
  if (!term) return conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  params.push(`%${term}%`);
  const idx = params.length;
  const parts: string[] = [];
  for (const f of r.fields) {
    if (!f.search) continue;
    if (f.type === 'ref') {
      const i = refs.indexOf(f);
      if (i >= 0) {
        const target = getResource(f.ref!)!;
        for (const lf of target.labelFields) parts.push(`r${i}.${lf}::text ILIKE $${idx}`);
      }
    } else {
      parts.push(`t.${f.name}::text ILIKE $${idx}`);
    }
  }
  if (/^\d+$/.test(term)) parts.push(`t.id = ${Number(term)}`);
  if (parts.length) conds.push(`(${parts.join(' OR ')})`);
  return conds.length ? `WHERE ${conds.join(' AND ')}` : '';
}

/** Colunas secretas que nunca saem em consultas genéricas da API. */
const COLUNAS_SECRETAS = new Set(['t.senha_hash', 't.mfa_secret', 't.convite_token_hash', 't.reset_token_hash', 't.dados', 't.thumb']);

const FILE_META_COLS = 'id, recurso, registro_id, nome, mime, tamanho_bytes, url, thumb_url, externo_id, token, principal, ordem, criado_em';

export class PgStore implements Store {
  readonly kind = 'postgres' as const;

  transaction<T>(fn: (tx: Tx) => Promise<T>, options?: TransactionOptions): Promise<T> {
    return withTransaction((client: PoolClient) => fn(client), options?.isolation || 'serializable');
  }

  async list(r: Resource, p: ListParams, tx?: Tx): Promise<ListResult> {
    const { selects, joins, refs } = refJoins(r);
    const params: unknown[] = [];
    const where = searchClause(r, p.q, params, refs, p.filter);
    const cols = columnsOf(r)
      .map((f) => `t.${f.name}`)
      .concat(['t.id'])
      .filter((c, i, a) => a.indexOf(c) === i)
      .filter((c) => !COLUNAS_SECRETAS.has(c));
    const selectList = [...cols, ...selects].join(', ');
    const from = `FROM ${r.table} t ${joins.join(' ')} ${where}`;

    const totalRes = await q(`SELECT COUNT(*)::int AS total ${from}`, params, tx);
    const total = totalRes.rows[0]?.total ?? 0;

    const offset = (p.page - 1) * p.pageSize;
    const rowsRes = await q(
      `SELECT ${selectList} ${from} ${orderClause(r, p)} LIMIT ${p.pageSize} OFFSET ${offset}`,
      params,
      tx
    );
    return { rows: rowsRes.rows, total, page: p.page, pageSize: p.pageSize };
  }

  async get(r: Resource, id: number, tx?: Tx): Promise<Row | null> {
    const { selects, joins } = refJoins(r);
    const cols = columnsOf(r)
      .map((f) => `t.${f.name}`)
      .concat(['t.id'])
      .filter((c, i, a) => a.indexOf(c) === i)
      .filter((c) => !COLUNAS_SECRETAS.has(c));
    const res = await q(
      `SELECT ${[...cols, ...selects].join(', ')} FROM ${r.table} t ${joins.join(' ')} WHERE t.id = $1`,
      [id],
      tx
    );
    return res.rows[0] ?? null;
  }

  async options(r: Resource, tx?: Tx): Promise<Option[]> {
    const cols = ['id', ...r.labelFields.filter((f) => f !== 'id')];
    const hasAtivo = r.fields.some((f) => f.name === 'ativo');
    const order = r.orderBy?.field && columnsOf(r).some((f) => f.name === r.orderBy!.field) ? r.orderBy.field : cols[1] || 'id';
    const res = await q(
      `SELECT ${cols.join(', ')}${hasAtivo ? ', ativo' : ''} FROM ${r.table} ORDER BY ${order} ${r.orderBy?.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, id LIMIT 2000`,
      [],
      tx
    );
    return res.rows.map((row: Row) => ({
      value: row.id,
      label: labelOf(r, row) + (hasAtivo && row.ativo === false ? ' (inativo)' : ''),
    }));
  }

  async findOneWhere(r: Resource, where: Payload, tx?: Tx): Promise<Row | null> {
    // Colunas de autenticação (convite_token_hash, reset_token_hash etc.) são
    // graváveis via API interna e precisam ser consultáveis por ela — o fluxo de
    // convite/redefinição depende exatamente disso. Sem elas o filtro ficava vazio
    // e o método retornava null, invalidando TODO convite/link em produção.
    const allowed = new Set(columnsOf(r).map((f) => f.name).concat(COLUNAS_AUTENTICACAO));
    const keys = Object.keys(where).filter((k) => allowed.has(k) || k === 'id');
    if (!keys.length) return null;
    const params: unknown[] = [];
    const cond = keys.map((k) => {
      const value = where[k];
      if (value === null || value === undefined) return `${k} IS NULL`;
      params.push(value);
      return `${k} = $${params.length}`;
    }).join(' AND ');
    const res = await q(`SELECT * FROM ${r.table} WHERE ${cond} LIMIT 1`, params, tx);
    return res.rows[0] ?? null;
  }

  async countWhere(r: Resource, where: Payload, tx?: Tx): Promise<number> {
    const allowed = new Set(columnsOf(r).map((f) => f.name).concat(COLUNAS_AUTENTICACAO));
    const keys = Object.keys(where).filter((k) => allowed.has(k) || k === 'id');
    const params: unknown[] = [];
    const predicates = keys.map((k) => {
      const value = where[k];
      if (value === null || value === undefined) return `${k} IS NULL`;
      params.push(value);
      return `${k} = $${params.length}`;
    });
    const cond = predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
    const res = await q(`SELECT COUNT(*)::int AS n FROM ${r.table} ${cond}`, params, tx);
    return res.rows[0]?.n ?? 0;
  }

  async insert(r: Resource, data: Payload, tx?: Tx): Promise<Row> {
    const allowed = new Set(columnsOf(r).map((f) => f.name).concat(COLUNAS_AUTENTICACAO));
    const keys = Object.keys(data).filter((k) => allowed.has(k));
    const hasCriado = r.fields.some((f) => f.name === 'criado_em');
    const cols = keys.slice();
    const vals = keys.map((_, i) => `$${i + 1}`);
    if (hasCriado && !keys.includes('criado_em')) {
      cols.push('criado_em');
      vals.push('now()');
    }
    const sql = cols.length
      ? `INSERT INTO ${r.table} (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING *`
      : `INSERT INTO ${r.table} DEFAULT VALUES RETURNING *`;
    const res = await q(sql, keys.map((k) => data[k]), tx);
    return res.rows[0];
  }

  async update(r: Resource, id: number, data: Payload, tx?: Tx): Promise<Row | null> {
    const allowed = new Set(columnsOf(r).map((f) => f.name).concat(COLUNAS_AUTENTICACAO));
    // criado_em/atualizado_em são geridos pelo store: payloads que espelham a
    // linha inteira (padrão patch-then-save) não podem atribuí-los de novo —
    // "multiple assignments to same column" (42601).
    const keys = Object.keys(data).filter((k) => allowed.has(k) && k !== 'id' && k !== 'atualizado_em' && k !== 'criado_em');
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    if (r.fields.some((f) => f.name === 'atualizado_em')) sets.push('atualizado_em = now()');
    if (!sets.length) return this.get(r, id, tx);
    const res = await q(
      `UPDATE ${r.table} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      [id, ...keys.map((k) => data[k])],
      tx
    );
    return res.rows[0] ?? null;
  }

  async remove(r: Resource, id: number, tx?: Tx): Promise<boolean> {
    const res = await q(`DELETE FROM ${r.table} WHERE id = $1`, [id], tx);
    return (res.rowCount ?? 0) > 0;
  }

  async adjustStock(
    produtoId: number,
    tamanhoId: number | null,
    local: string,
    delta: number,
    tx?: Tx,
    localId?: number | null,
    empresaId?: number
  ): Promise<Row> {
    const cell = await canonicalStockCell(produtoId, tamanhoId, local, localId, empresaId, tx);
    const alvoConflito = tamanhoId === null
      ? '(empresa_id, produto_id, local_id) WHERE tamanho_id IS NULL AND local_id IS NOT NULL'
      : '(empresa_id, produto_id, tamanho_id, local_id) WHERE tamanho_id IS NOT NULL AND local_id IS NOT NULL';
    const res = await q(
      `INSERT INTO estoques (empresa_id, produto_id, tamanho_id, local, local_id, quantidade, criado_em)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT ${alvoConflito}
       DO UPDATE SET
         quantidade = estoques.quantidade + EXCLUDED.quantidade,
         local_id = EXCLUDED.local_id,
         atualizado_em = now()
       RETURNING *`,
      [cell.empresaId, produtoId, tamanhoId, cell.local, cell.localId, delta],
      tx
    );
    return res.rows[0];
  }

  async tryUpdateIf(r: Resource, id: number, esperado: Payload, data: Payload, tx?: Tx): Promise<Row | null> {
    const allowed = new Set(columnsOf(r).map((f) => f.name).concat(COLUNAS_AUTENTICACAO));
    const params: unknown[] = [id];
    const conds: string[] = [`id = $1`];
    for (const [k, v] of Object.entries(esperado)) {
      if (!allowed.has(k)) continue;
      if (v === null || v === undefined) conds.push(`${k} IS NULL`);
      else {
        params.push(v);
        conds.push(`${k} = $${params.length}`);
      }
    }
    const keys = Object.keys(data).filter((k) => allowed.has(k) && k !== 'id' && k !== 'atualizado_em' && k !== 'criado_em');
    const sets = keys.map((k, i) => `${k} = $${params.length + 1 + i}`);
    if (r.fields.some((f) => f.name === 'atualizado_em')) sets.push('atualizado_em = now()');
    if (!sets.length) return this.get(r, id, tx);
    const res = await q(
      `UPDATE ${r.table} SET ${sets.join(', ')} WHERE ${conds.join(' AND ')} RETURNING *`,
      [...params, ...keys.map((k) => data[k])],
      tx
    );
    return res.rows[0] ?? null;
  }

  async tryAdjustStock(
    produtoId: number,
    tamanhoId: number | null,
    local: string,
    delta: number,
    tx?: Tx,
    minimo = 0,
    localId?: number | null,
    empresaId?: number
  ): Promise<Row | null> {
    const cell = await canonicalStockCell(produtoId, tamanhoId, local, localId, empresaId, tx);
    // Os índices parciais separam tamanho presente de NULL, e incluem a empresa
    // e o local textual derivado do ID canônico. O UPDATE toma row lock: saídas
    // concorrentes nunca passam ambas pelo mesmo saldo.
    const alvoConflito = tamanhoId === null
      ? '(empresa_id, produto_id, local_id) WHERE tamanho_id IS NULL AND local_id IS NOT NULL'
      : '(empresa_id, produto_id, tamanho_id, local_id) WHERE tamanho_id IS NOT NULL AND local_id IS NOT NULL';
    await q(
      `INSERT INTO estoques (empresa_id, produto_id, tamanho_id, local, local_id, quantidade, criado_em)
       VALUES ($1, $2, $3, $4, $5, 0, now())
       ON CONFLICT ${alvoConflito} DO NOTHING`,
      [cell.empresaId, produtoId, tamanhoId, cell.local, cell.localId],
      tx
    );
    if (delta === 0) {
      const atual = await q(
        `SELECT * FROM estoques
          WHERE empresa_id = $1 AND produto_id = $2
            AND tamanho_id IS NOT DISTINCT FROM $3 AND local = $4 AND local_id = $5
          LIMIT 1`,
        [cell.empresaId, produtoId, tamanhoId, cell.local, cell.localId],
        tx
      );
      return atual.rows[0] ?? null;
    }
    const res = await q(
      `UPDATE estoques
          SET quantidade = quantidade + $4,
              local_id = $6,
              atualizado_em = now()
        WHERE empresa_id = $1 AND produto_id = $2
          AND tamanho_id IS NOT DISTINCT FROM $7 AND local = $3
          AND local_id = $6
          AND quantidade + $4 >= $5
        RETURNING *`,
      [cell.empresaId, produtoId, cell.local, delta, minimo, cell.localId, tamanhoId],
      tx
    );
    if (!res.rows[0] && cell.localId !== null) {
      const mismatch = await q(
        `SELECT 1 FROM estoques WHERE empresa_id = $1 AND produto_id = $2
           AND tamanho_id IS NOT DISTINCT FROM $3
           AND (local_id = $5 OR (local_id IS NULL AND local = $4))
           AND (local_id IS DISTINCT FROM $5 OR local IS DISTINCT FROM $4) LIMIT 1`,
        [cell.empresaId, produtoId, tamanhoId, cell.local, cell.localId],
        tx
      );
      if (mismatch.rows.length) throw new HttpError(409, 'O saldo possui vínculo de local inconsistente.');
    }
    return res.rows[0] ?? null;
  }

  async insertMany(r: Resource, rows: Payload[], tx?: Tx): Promise<Row[]> {
    if (!rows.length) return [];
    const allowed = new Set(columnsOf(r).map((f) => f.name).concat(COLUNAS_AUTENTICACAO));
    const cols = Array.from(new Set(rows.flatMap((d) => Object.keys(d).filter((k) => allowed.has(k)))));
    if (!cols.length) return rows.map(() => ({} as Row));
    const hasCriado = r.fields.some((f) => f.name === 'criado_em') && !cols.includes('criado_em');
    const all = hasCriado ? [...cols, 'criado_em'] : cols;
    const params: unknown[] = [];
    const tuples = rows.map((d) => {
      const vals = cols.map((c) => {
        params.push(d[c] ?? null);
        return `$${params.length}`;
      });
      if (hasCriado) vals.push('now()');
      return `(${vals.join(', ')})`;
    });
    const res = await q(`INSERT INTO ${r.table} (${all.join(', ')}) VALUES ${tuples.join(', ')} RETURNING *`, params, tx);
    return res.rows as Row[];
  }

  async adjustInsumoStock(insumoId: number, delta: number, tx?: Tx, empresaId?: number): Promise<Row> {
    const dono = await canonicalInsumoEmpresa(insumoId, empresaId, tx);
    const res = await q(
      `INSERT INTO estoque_insumos (empresa_id, insumo_id, quantidade, atualizado_em)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (insumo_id)
       DO UPDATE SET quantidade = ROUND((estoque_insumos.quantidade + EXCLUDED.quantidade)::numeric, 3), atualizado_em = now()
       WHERE estoque_insumos.empresa_id = EXCLUDED.empresa_id
       RETURNING *`,
      [dono, insumoId, delta],
      tx
    );
    if (!res.rows[0]) throw new HttpError(409, 'O saldo do insumo possui vínculo de empresa inconsistente. Nenhuma alteração foi aplicada.');
    return res.rows[0];
  }

  async insumoStock(insumoId: number, tx?: Tx, empresaId?: number): Promise<number> {
    const dono = await canonicalInsumoEmpresa(insumoId, empresaId, tx);
    const res = await q('SELECT empresa_id, quantidade FROM estoque_insumos WHERE insumo_id = $1', [insumoId], tx);
    if (!res.rows[0]) return 0;
    if (Number(res.rows[0].empresa_id ?? EMPRESA_PADRAO) !== dono) {
      throw new HttpError(409, 'O saldo do insumo possui vínculo de empresa inconsistente. Nenhuma leitura foi aplicada.');
    }
    return Number(res.rows[0].quantidade ?? 0);
  }

  async audit(entry: AuditEntry, tx?: Tx): Promise<void> {
    // Cadeia de hashes: preciso do hash do último evento; com lock para não
    // bifurcar a cadeia quando dois eventos são gravados ao mesmo tempo.
    const escrever = async (t: Tx) => {
      await q(`SELECT pg_advisory_xact_lock(hashtext('brobond-auditoria'))`, [], t);
      const prev = await q(`SELECT hash FROM auditoria WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1`, [], t);
      const hash_anterior = prev.rows[0]?.hash ? String(prev.rows[0].hash) : '';
      const hash = hashCadeiaAuditoria(hash_anterior, entry);
      // O tipo exige empresa_id; o fallback protege chamadas legadas/diretas
      // em runtime (a coluna é NOT NULL desde a migration 0017).
      const empresaId = entry.empresa_id ?? EMPRESA_PADRAO;
      await q(
        `INSERT INTO auditoria (usuario_id, usuario, acao, recurso, registro_id, descricao, dados, hash_anterior, hash, empresa_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          entry.usuario_id,
          entry.usuario,
          entry.acao,
          entry.recurso,
          entry.registro_id,
          entry.descricao,
          entry.dados === undefined ? null : JSON.stringify(entry.dados),
          hash_anterior,
          hash,
          empresaId,
        ],
        t
      );
    };
    if (tx) await escrever(tx);
    else await withTransaction((client) => escrever(client));
  }

  async verificarAuditoria(): Promise<AuditoriaVerificacao> {
    const res = await q(`SELECT * FROM auditoria ORDER BY id ASC LIMIT 100000`);
    return verificarCadeiaAuditoria(res.rows);
  }

  /**
   * Painel "Meu negócio": agregados sobre as tabelas com `empresa_id`.
   *
   * MULTIEMPRESA: com `escopo` de uma empresa (padrão), cada consulta recebe
   * `empresa_id = $1`; sem recorte (escopo consolidado autorizado ou chamada de
   * sistema sem escopo) mantém a leitura do grupo inteiro.
   */
  async dashboard(escopo?: EscopoEmpresa | null): Promise<DashboardData> {
    const emp = escopo && !escopo.consolidado ? escopo.empresaId : null;
    const p: unknown[] = emp === null ? [] : [emp];
    // Condição de empresa por alias de tabela ('' quando não há recorte).
    const w = (alias: string) => (emp === null ? '' : ` AND ${alias}.empresa_id = $1`);
    const [kpis, alertas, ordens, recentes, chart6, chart7, chart8, chart9, saldos] = await Promise.all([
      query(`
        SELECT
          COALESCE((SELECT SUM(e.quantidade * COALESCE(p.custo, 0)) FROM estoques e JOIN produtos p ON p.id = e.produto_id WHERE TRUE${w('e')}), 0)::float AS valor_estoque,
          COALESCE((SELECT SUM(quantidade) FROM estoques WHERE TRUE${w('estoques')}), 0)::int AS pecas_estoque,
          (SELECT COUNT(*) FROM estoques WHERE estoque_min > 0 AND quantidade <= estoque_min${w('estoques')})::int AS itens_alerta,
          (SELECT COUNT(*) FROM ordens_fabricacao WHERE status IN ('planejada', 'em_producao')${w('ordens_fabricacao')})::int AS producao,
          (SELECT COUNT(*) FROM vendas WHERE status = 'aberta'${w('vendas')})::int AS vendas_abertas,
          (SELECT COUNT(*) FROM compras WHERE status = 'pendente'${w('compras')})::int AS compras_pendentes,
          (SELECT COALESCE(SUM(total), 0) FROM vendas WHERE status IN ('faturada', 'entregue') AND faturada_em >= timezone('America/Sao_Paulo', date_trunc('month', ${sqlCivil('now()')}))${w('vendas')})::float AS vendas_mes,
          (SELECT COALESCE(SUM(comissao_valor), 0) FROM vendas WHERE status IN ('faturada', 'entregue')${w('vendas')})::float AS comissoes_pagar,
          (SELECT COUNT(*) FROM produtos WHERE TRUE${w('produtos')})::int AS produtos,
          (SELECT COUNT(*) FROM clientes WHERE TRUE${w('clientes')})::int AS clientes,
          (SELECT COUNT(*) FROM fornecedores WHERE TRUE${w('fornecedores')})::int AS fornecedores,
          (SELECT COUNT(*) FROM insumos WHERE TRUE${w('insumos')})::int AS insumos
      `, p),
      query(`
        SELECT concat_ws(' — ', p.sku, p.nome) AS produto, t.codigo AS tamanho, e.local, e.quantidade, e.estoque_min
        FROM estoques e
        JOIN produtos p ON p.id = e.produto_id
        LEFT JOIN tamanhos t ON t.id = e.tamanho_id
        WHERE e.estoque_min > 0 AND e.quantidade <= e.estoque_min${w('e')}
        ORDER BY (e.quantidade - e.estoque_min) ASC
        LIMIT 8
      `, p),
      query(`
        SELECT o.id, concat_ws(' — ', p.sku, p.nome) AS produto, t.codigo AS tamanho, o.quantidade, o.status, o.previsao
        FROM ordens_fabricacao o
        LEFT JOIN produtos p ON p.id = o.produto_id
        LEFT JOIN tamanhos t ON t.id = o.tamanho_id
        WHERE o.status IN ('planejada', 'em_producao')${w('o')}
        ORDER BY o.previsao ASC NULLS LAST, o.id DESC
        LIMIT 8
      `, p),
      query(`
        SELECT data, usuario, acao, recurso, descricao
        FROM auditoria
        WHERE acao <> 'login'${w('auditoria')}
        ORDER BY data DESC
        LIMIT 8
      `, p),
      // Fase 5 — vendas por mês (12 meses, completando os meses sem venda).
      // MÊS CIVIL em America/Sao_Paulo: cada instante é agrupado no calendário brasileiro.
      query(`
        SELECT to_char(gs.mes, 'YYYY-MM') AS mes, COALESCE(SUM(v.total), 0)::float AS total
        FROM generate_series(date_trunc('month', ${sqlCivil('now()')}) - interval '11 months', date_trunc('month', ${sqlCivil('now()')}), interval '1 month') AS gs(mes)
        LEFT JOIN vendas v ON v.status IN ('faturada', 'entregue') AND date_trunc('month', ${sqlCivil('COALESCE(v.faturada_em, v.data)')}) = gs.mes${w('v')}
        GROUP BY gs.mes ORDER BY gs.mes ASC
      `, p),
      // Fase 5 — produção concluída por semana (8 semanas; OP por grade soma a grade).
      // SEMANA CIVIL em America/Sao_Paulo (segunda a domingo, horário de Brasília).
      query(`
        SELECT to_char(gs.sem, 'YYYY-MM-DD') AS semana,
               COALESCE(SUM(CASE
                 WHEN o.tipo = 'grade' THEN (SELECT COALESCE(SUM(io.quantidade), 0) FROM itens_ordem io WHERE io.ordem_id = o.id)
                 ELSE o.quantidade END), 0)::int AS pecas,
               COUNT(o.id)::int AS ordens
        FROM generate_series(date_trunc('week', ${sqlCivil('now()')}) - interval '7 weeks', date_trunc('week', ${sqlCivil('now()')}), interval '1 week') AS gs(sem)
        LEFT JOIN ordens_fabricacao o
          ON o.status = 'concluida' AND date_trunc('week', ${sqlCivil('COALESCE(o.concluida_em, o.atualizado_em, o.criado_em)')}) = gs.sem${w('o')}
        GROUP BY gs.sem ORDER BY gs.sem ASC
      `, p),
      // Fase 5 — top 10 produtos por faturamento (pedidos faturados/entregues)
      query(`
        SELECT concat_ws(' — ', p.sku, p.nome) AS produto, SUM(iv.subtotal)::float AS total
        FROM itens_venda iv
        JOIN vendas v ON v.id = iv.venda_id AND v.status IN ('faturada', 'entregue')${w('v')}
        JOIN produtos p ON p.id = iv.produto_id
        GROUP BY p.id, p.sku, p.nome
        ORDER BY total DESC
        LIMIT 10
      `, p),
      // Fase 3 — insumos abaixo do estoque mínimo
      query(`
        SELECT i.nome AS insumo, ei.quantidade, ei.estoque_min
        FROM estoque_insumos ei
        JOIN insumos i ON i.id = ei.insumo_id
        WHERE ei.estoque_min > 0 AND ei.quantidade <= ei.estoque_min${w('ei')}
        ORDER BY (ei.quantidade - ei.estoque_min) ASC
        LIMIT 8
      `, p),
      // Valorização em três bases (custo × atacado × varejo) — saldo por produto,
      // somando todos os tamanhos e locais; o cálculo fica em valorizacao.ts.
      query(`
        SELECT p.id, concat_ws(' — ', p.sku, p.nome) AS produto, c.nome AS colecao,
               SUM(e.quantidade)::int AS pecas,
               COALESCE(p.custo, 0)::float AS custo,
               COALESCE(p.preco_venda, 0)::float AS preco_venda,
               COALESCE(p.preco_atacado, 0)::float AS preco_atacado
        FROM estoques e
        JOIN produtos p ON p.id = e.produto_id
        LEFT JOIN colecoes c ON c.id = p.colecao_id
        WHERE TRUE${w('e')}
        GROUP BY p.id, p.sku, p.nome, c.nome, p.custo, p.preco_venda, p.preco_atacado
        HAVING SUM(e.quantidade) > 0
      `, p),
    ]);
    const k = kpis.rows[0] || {};
    return {
      valorEstoque: Number(k.valor_estoque || 0),
      pecasEstoque: Number(k.pecas_estoque || 0),
      valorizacao: valorizarEstoque(
        saldos.rows.map((r) => ({
          id: Number(r.id),
          produto: String(r.produto),
          colecao: r.colecao ? String(r.colecao) : null,
          pecas: Number(r.pecas || 0),
          custo: r.custo,
          preco_venda: r.preco_venda,
          preco_atacado: r.preco_atacado,
        }))
      ),
      itensAlerta: Number(k.itens_alerta || 0),
      producao: Number(k.producao || 0),
      vendasAbertas: Number(k.vendas_abertas || 0),
      comprasPendentes: Number(k.compras_pendentes || 0),
      vendasMes: Number(k.vendas_mes || 0),
      comissoesPagar: Number(k.comissoes_pagar || 0),
      totais: {
        produtos: Number(k.produtos || 0),
        clientes: Number(k.clientes || 0),
        fornecedores: Number(k.fornecedores || 0),
        insumos: Number(k.insumos || 0),
      },
      alertas: alertas.rows,
      ordens: ordens.rows,
      recentes: recentes.rows,
      vendasPorMes: chart6.rows.map((r: any) => ({ mes: String(r.mes), total: Number(r.total || 0) })),
      producaoPorSemana: chart7.rows.map((r: any) => ({ semana: String(r.semana), pecas: Number(r.pecas || 0), ordens: Number(r.ordens || 0) })),
      topProdutos: chart8.rows.map((r: any) => ({ produto: String(r.produto), total: Number(r.total || 0) })),
      insumosAlerta: chart9.rows.map((r: any) => ({ insumo: String(r.insumo), quantidade: Number(r.quantidade || 0), estoque_min: Number(r.estoque_min || 0) })),
    };
  }

  async findUserByEmail(email: string): Promise<Row | null> {
    // SELECT * interno (nunca vai para o cliente): o login precisa do ciclo de
    // vida completo (bloqueio, expiração, tentativas) e das permissões/alçadas.
    const res = await query('SELECT * FROM usuarios WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    return res.rows[0] ?? null;
  }

  async listUsuariosRaw(): Promise<Row[]> {
    const res = await query('SELECT id, nome, email, senha_hash, perfil, ativo, trocar_senha, token_versao FROM usuarios ORDER BY id');
    return res.rows;
  }

  async getPreferences(userId: number): Promise<Record<string, unknown>> {
    const res = await query('SELECT preferencias FROM usuarios WHERE id = $1', [userId]);
    const raw = res.rows[0]?.preferencias;
    return raw && typeof raw === 'object' ? raw : {};
  }

  async setPreferences(userId: number, prefs: Record<string, unknown>): Promise<void> {
    await query('UPDATE usuarios SET preferencias = $1, atualizado_em = now() WHERE id = $2', [JSON.stringify(prefs), userId]);
  }

  async touchLogin(userId: number, ip?: string | null): Promise<void> {
    // Login com sucesso: registra acesso, IP e zera as falhas consecutivas.
    await query(
      'UPDATE usuarios SET ultimo_login = now(), ultimo_ip = COALESCE($2, ultimo_ip), tentativas_falhas = 0, ultimo_falha_em = NULL WHERE id = $1',
      [userId, ip ?? null]
    ).catch(() => undefined);
  }

  // ------------------------------------------------------------------
  // Sessões (invalidação por dispositivo)
  // ------------------------------------------------------------------
  async criarSessao(s: Omit<Sessao, 'criada_em' | 'revogada_em'>): Promise<Sessao> {
    const res = await q(
      `INSERT INTO sessoes (id, usuario_id, expira_em, ip, user_agent) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [s.id, s.usuario_id, s.expira_em, s.ip, s.user_agent]
    );
    return res.rows[0];
  }

  async getSessao(id: string): Promise<Sessao | null> {
    const res = await q(`SELECT * FROM sessoes WHERE id = $1 LIMIT 1`, [id]);
    return res.rows[0] ?? null;
  }

  async listSessoesAtivas(usuarioId: number): Promise<Sessao[]> {
    const res = await q(
      `SELECT * FROM sessoes WHERE usuario_id = $1 AND revogada_em IS NULL AND expira_em > now() ORDER BY criada_em DESC LIMIT 50`,
      [usuarioId]
    );
    return res.rows;
  }

  async revogarSessao(id: string): Promise<boolean> {
    const res = await q(`UPDATE sessoes SET revogada_em = now() WHERE id = $1 AND revogada_em IS NULL`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async revogarSessoes(usuarioId: number, exceto?: string): Promise<number> {
    const res = await q(
      `UPDATE sessoes SET revogada_em = now() WHERE usuario_id = $1 AND revogada_em IS NULL AND ($2::text IS NULL OR id <> $2)`,
      [usuarioId, exceto ?? null]
    );
    return res.rowCount ?? 0;
  }

  async limparSessoesEncerradas(): Promise<void> {
    await query(`DELETE FROM sessoes WHERE expira_em < now() - interval '7 days' OR revogada_em < now() - interval '7 days'`).catch(() => undefined);
  }

  // ------------------------------------------------------------------
  // Rate limit persistente
  // ------------------------------------------------------------------
  async rateLimitEstado(chave: string, windowMs: number): Promise<RateState | null> {
    const res = await q(`SELECT count, primeira_em, bloqueado_ate FROM login_tentativas WHERE chave = $1`, [chave]);
    const row = res.rows[0];
    if (!row) return null;
    const agora = Date.now();
    const primeira = new Date(row.primeira_em).getTime();
    const bloqueado = row.bloqueado_ate ? new Date(row.bloqueado_ate).getTime() : 0;
    if (agora - primeira > windowMs && bloqueado < agora) {
      await q(`DELETE FROM login_tentativas WHERE chave = $1`, [chave]);
      return null;
    }
    return { count: Number(row.count || 0), primeira_em: String(row.primeira_em), bloqueado_ate: row.bloqueado_ate ? String(row.bloqueado_ate) : null };
  }

  async rateLimitHit(chave: string, windowMs: number, max: number): Promise<{ restantes: number; bloqueado_ate: string | null }> {
    const segundos = Math.ceil(windowMs / 1000);
    const up = await q(
      `INSERT INTO login_tentativas (chave, count, primeira_em)
       VALUES ($1, 1, now())
       ON CONFLICT (chave) DO UPDATE SET
         count = CASE WHEN login_tentativas.primeira_em < now() - make_interval(secs => $2) THEN 1 ELSE login_tentativas.count + 1 END,
         primeira_em = CASE WHEN login_tentativas.primeira_em < now() - make_interval(secs => $2) THEN now() ELSE login_tentativas.primeira_em END
       RETURNING count`,
      [chave, segundos]
    );
    const count = Number(up.rows[0]?.count || 0);
    if (count < max) return { restantes: max - count, bloqueado_ate: null };
    const blk = await q(
      `UPDATE login_tentativas SET bloqueado_ate = now() + make_interval(secs => $2) WHERE chave = $1 RETURNING bloqueado_ate`,
      [chave, segundos]
    );
    return { restantes: 0, bloqueado_ate: blk.rows[0]?.bloqueado_ate ? String(blk.rows[0].bloqueado_ate) : null };
  }

  async rateLimitReset(chave: string): Promise<void> {
    await q(`DELETE FROM login_tentativas WHERE chave = $1`, [chave]);
  }

  async limparRateLimitsAntigos(): Promise<void> {
    await query(`DELETE FROM login_tentativas WHERE COALESCE(bloqueado_ate, primeira_em) < now() - interval '24 hours'`).catch(() => undefined);
  }

  async filesFor(recurso: string, registroIds: number[], tx?: Tx): Promise<FileMeta[]> {
    if (!registroIds.length) return [];
    const res = await q(
      `SELECT ${FILE_META_COLS} FROM arquivos WHERE recurso = $1 AND registro_id = ANY($2::int[]) ORDER BY principal DESC, ordem ASC, id ASC`,
      [recurso, registroIds],
      tx
    );
    return res.rows as FileMeta[];
  }

  async fileById(id: number): Promise<Row | null> {
    const res = await query('SELECT * FROM arquivos WHERE id = $1', [id]);
    return res.rows[0] ?? null;
  }
}

export function isPgAvailable(): boolean {
  return !!pool;
}
