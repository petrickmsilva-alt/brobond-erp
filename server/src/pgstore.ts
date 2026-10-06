// Implementação PostgreSQL do Store.
// SEGURANÇA: nomes de tabelas e colunas vêm exclusivamente de resources.ts;
// todos os valores do usuário entram como parâmetros ($1, $2...).
import type { PoolClient } from 'pg';
import { pool, query, withTransaction } from './db';
import { HttpError } from './errors';
import { COLUNAS_AUTENTICACAO, columnsOf, getResource, type Resource } from './resources';
import { hashCadeiaAuditoria, verificarCadeiaAuditoria } from './auditChain';
import { valorizarEstoque } from './valorizacao';
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

/** Traduz erros do Postgres para mensagens amigáveis. */
export function translatePgError(e: any, r?: Resource): HttpError | null {
  if (!e || typeof e.code !== 'string') return null;
  switch (e.code) {
    case '23505': {
      // unique_violation — descobre o campo pelo nome do constraint / detail
      const field = r?.fields.find((f) => f.unique && String(e.constraint || e.detail || '').includes(f.name));
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
  const cols = new Set(columnsOf(r).map((f) => f.name));
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
    const cond = keys.map((k, i) => `${k} = $${i + 1}`).join(' AND ');
    const res = await q(`SELECT * FROM ${r.table} WHERE ${cond} LIMIT 1`, keys.map((k) => where[k]), tx);
    return res.rows[0] ?? null;
  }

  async countWhere(r: Resource, where: Payload, tx?: Tx): Promise<number> {
    const allowed = new Set(columnsOf(r).map((f) => f.name).concat(COLUNAS_AUTENTICACAO));
    const keys = Object.keys(where).filter((k) => allowed.has(k) || k === 'id');
    const cond = keys.length ? `WHERE ${keys.map((k, i) => `${k} = $${i + 1}`).join(' AND ')}` : '';
    const res = await q(`SELECT COUNT(*)::int AS n FROM ${r.table} ${cond}`, keys.map((k) => where[k]), tx);
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
    const keys = Object.keys(data).filter((k) => allowed.has(k) && k !== 'id');
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

  async adjustStock(produtoId: number, tamanhoId: number, local: string, delta: number, tx?: Tx): Promise<Row> {
    const res = await q(
      `INSERT INTO estoques (produto_id, tamanho_id, local, quantidade, criado_em)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (produto_id, tamanho_id, local)
       DO UPDATE SET quantidade = estoques.quantidade + EXCLUDED.quantidade, atualizado_em = now()
       RETURNING *`,
      [produtoId, tamanhoId, local, delta],
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
    const keys = Object.keys(data).filter((k) => allowed.has(k) && k !== 'id');
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

  async tryAdjustStock(produtoId: number, tamanhoId: number, local: string, delta: number, tx?: Tx, minimo = 0): Promise<Row | null> {
    // Garante a linha do saldo (idempotente) e depois abate com a condição DENTRO
    // do UPDATE: o WHERE é reavaliado contra a versão mais recente da linha (o
    // UPDATE toma row lock), então duas transações concorrentes não passam as duas.
    await q(
      `INSERT INTO estoques (produto_id, tamanho_id, local, quantidade, criado_em)
       VALUES ($1, $2, $3, 0, now())
       ON CONFLICT (produto_id, tamanho_id, local) DO NOTHING`,
      [produtoId, tamanhoId, local],
      tx
    );
    if (delta === 0) {
      const atual = await q(`SELECT * FROM estoques WHERE produto_id = $1 AND tamanho_id = $2 AND local = $3`, [produtoId, tamanhoId, local], tx);
      return atual.rows[0] ?? null;
    }
    const res = await q(
      `UPDATE estoques
          SET quantidade = quantidade + $4, atualizado_em = now()
        WHERE produto_id = $1 AND tamanho_id = $2 AND local = $3 AND quantidade + $4 >= $5
        RETURNING *`,
      [produtoId, tamanhoId, local, delta, minimo],
      tx
    );
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

  async adjustInsumoStock(insumoId: number, delta: number, tx?: Tx): Promise<Row> {
    const res = await q(
      `INSERT INTO estoque_insumos (insumo_id, quantidade, atualizado_em)
       VALUES ($1, $2, now())
       ON CONFLICT (insumo_id)
       DO UPDATE SET quantidade = ROUND((estoque_insumos.quantidade + EXCLUDED.quantidade)::numeric, 3), atualizado_em = now()
       RETURNING *`,
      [insumoId, delta],
      tx
    );
    return res.rows[0];
  }

  async insumoStock(insumoId: number, tx?: Tx): Promise<number> {
    const res = await q(`SELECT quantidade FROM estoque_insumos WHERE insumo_id = $1`, [insumoId], tx);
    return Number(res.rows[0]?.quantidade ?? 0);
  }

  async audit(entry: AuditEntry, tx?: Tx): Promise<void> {
    // Cadeia de hashes: preciso do hash do último evento; com lock para não
    // bifurcar a cadeia quando dois eventos são gravados ao mesmo tempo.
    const escrever = async (t: Tx) => {
      await q(`SELECT pg_advisory_xact_lock(hashtext('brobond-auditoria'))`, [], t);
      const prev = await q(`SELECT hash FROM auditoria WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1`, [], t);
      const hash_anterior = prev.rows[0]?.hash ? String(prev.rows[0].hash) : '';
      const hash = hashCadeiaAuditoria(hash_anterior, entry);
      await q(
        `INSERT INTO auditoria (usuario_id, usuario, acao, recurso, registro_id, descricao, dados, hash_anterior, hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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

  async dashboard(): Promise<DashboardData> {
    const [kpis, alertas, ordens, recentes, chart6, chart7, chart8, chart9, saldos] = await Promise.all([
      query(`
        SELECT
          COALESCE((SELECT SUM(e.quantidade * COALESCE(p.custo, 0)) FROM estoques e JOIN produtos p ON p.id = e.produto_id), 0)::float AS valor_estoque,
          COALESCE((SELECT SUM(quantidade) FROM estoques), 0)::int AS pecas_estoque,
          (SELECT COUNT(*) FROM estoques WHERE estoque_min > 0 AND quantidade <= estoque_min)::int AS itens_alerta,
          (SELECT COUNT(*) FROM ordens_fabricacao WHERE status IN ('planejada', 'em_producao'))::int AS producao,
          (SELECT COUNT(*) FROM vendas WHERE status = 'aberta')::int AS vendas_abertas,
          (SELECT COUNT(*) FROM compras WHERE status = 'pendente')::int AS compras_pendentes,
          (SELECT COALESCE(SUM(total), 0) FROM vendas WHERE status IN ('faturada', 'entregue') AND faturada_em >= date_trunc('month', now()))::float AS vendas_mes,
          (SELECT COALESCE(SUM(comissao_valor), 0) FROM vendas WHERE status IN ('faturada', 'entregue'))::float AS comissoes_pagar,
          (SELECT COUNT(*) FROM produtos)::int AS produtos,
          (SELECT COUNT(*) FROM clientes)::int AS clientes,
          (SELECT COUNT(*) FROM fornecedores)::int AS fornecedores,
          (SELECT COUNT(*) FROM insumos)::int AS insumos
      `),
      query(`
        SELECT concat_ws(' — ', p.sku, p.nome) AS produto, t.codigo AS tamanho, e.local, e.quantidade, e.estoque_min
        FROM estoques e
        JOIN produtos p ON p.id = e.produto_id
        LEFT JOIN tamanhos t ON t.id = e.tamanho_id
        WHERE e.estoque_min > 0 AND e.quantidade <= e.estoque_min
        ORDER BY (e.quantidade - e.estoque_min) ASC
        LIMIT 8
      `),
      query(`
        SELECT o.id, concat_ws(' — ', p.sku, p.nome) AS produto, t.codigo AS tamanho, o.quantidade, o.status, o.previsao
        FROM ordens_fabricacao o
        LEFT JOIN produtos p ON p.id = o.produto_id
        LEFT JOIN tamanhos t ON t.id = o.tamanho_id
        WHERE o.status IN ('planejada', 'em_producao')
        ORDER BY o.previsao ASC NULLS LAST, o.id DESC
        LIMIT 8
      `),
      query(`
        SELECT data, usuario, acao, recurso, descricao
        FROM auditoria
        WHERE acao <> 'login'
        ORDER BY data DESC
        LIMIT 8
      `),
      // Fase 5 — vendas por mês (12 meses, completando os meses sem venda)
      query(`
        SELECT to_char(gs.mes, 'YYYY-MM') AS mes, COALESCE(SUM(v.total), 0)::float AS total
        FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') AS gs(mes)
        LEFT JOIN vendas v ON v.status IN ('faturada', 'entregue') AND date_trunc('month', COALESCE(v.faturada_em, v.data)) = gs.mes
        GROUP BY gs.mes ORDER BY gs.mes ASC
      `),
      // Fase 5 — produção concluída por semana (8 semanas; OP por grade soma a grade)
      query(`
        SELECT to_char(gs.sem, 'YYYY-MM-DD') AS semana,
               COALESCE(SUM(CASE
                 WHEN o.tipo = 'grade' THEN (SELECT COALESCE(SUM(io.quantidade), 0) FROM itens_ordem io WHERE io.ordem_id = o.id)
                 ELSE o.quantidade END), 0)::int AS pecas,
               COUNT(o.id)::int AS ordens
        FROM generate_series(date_trunc('week', now()) - interval '7 weeks', date_trunc('week', now()), interval '1 week') AS gs(sem)
        LEFT JOIN ordens_fabricacao o
          ON o.status = 'concluida' AND date_trunc('week', COALESCE(o.concluida_em, o.atualizado_em, o.criado_em)) = gs.sem
        GROUP BY gs.sem ORDER BY gs.sem ASC
      `),
      // Fase 5 — top 10 produtos por faturamento (pedidos faturados/entregues)
      query(`
        SELECT concat_ws(' — ', p.sku, p.nome) AS produto, SUM(iv.subtotal)::float AS total
        FROM itens_venda iv
        JOIN vendas v ON v.id = iv.venda_id AND v.status IN ('faturada', 'entregue')
        JOIN produtos p ON p.id = iv.produto_id
        GROUP BY p.id, p.sku, p.nome
        ORDER BY total DESC
        LIMIT 10
      `),
      // Fase 3 — insumos abaixo do estoque mínimo
      query(`
        SELECT i.nome AS insumo, ei.quantidade, ei.estoque_min
        FROM estoque_insumos ei
        JOIN insumos i ON i.id = ei.insumo_id
        WHERE ei.estoque_min > 0 AND ei.quantidade <= ei.estoque_min
        ORDER BY (ei.quantidade - ei.estoque_min) ASC
        LIMIT 8
      `),
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
        GROUP BY p.id, p.sku, p.nome, c.nome, p.custo, p.preco_venda, p.preco_atacado
        HAVING SUM(e.quantidade) > 0
      `),
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
