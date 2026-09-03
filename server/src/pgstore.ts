// Implementação PostgreSQL do Store.
// SEGURANÇA: nomes de tabelas e colunas vêm exclusivamente de resources.ts;
// todos os valores do usuário entram como parâmetros ($1, $2...).
import type { PoolClient } from 'pg';
import { pool, query, withTransaction } from './db';
import { HttpError } from './errors';
import { columnsOf, getResource, type Resource } from './resources';
import {
  labelOf,
  type AuditEntry,
  type DashboardData,
  type FileMeta,
  type ListParams,
  type ListResult,
  type Option,
  type Payload,
  type Row,
  type Store,
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
    case '42703':
      return new HttpError(500, 'Coluna não encontrada no banco. Execute db/schema.sql para migrar.');
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
  for (const [k, v] of Object.entries(filter || {})) {
    if (!cols.has(k) || v === undefined || v === null || v === '') continue;
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

const FILE_META_COLS = 'id, recurso, registro_id, nome, mime, tamanho_bytes, url, thumb_url, externo_id, token, principal, ordem, criado_em';

export class PgStore implements Store {
  readonly kind = 'postgres' as const;

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTransaction((client: PoolClient) => fn(client));
  }

  async list(r: Resource, p: ListParams, tx?: Tx): Promise<ListResult> {
    const { selects, joins, refs } = refJoins(r);
    const params: unknown[] = [];
    const where = searchClause(r, p.q, params, refs, p.filter);
    const cols = columnsOf(r)
      .map((f) => `t.${f.name}`)
      .concat(['t.id'])
      .filter((c, i, a) => a.indexOf(c) === i)
      .filter((c) => c !== 't.senha_hash' && c !== 't.dados' && c !== 't.thumb');
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
      .filter((c) => c !== 't.senha_hash' && c !== 't.dados' && c !== 't.thumb');
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
    const keys = Object.keys(where).filter((k) => columnsOf(r).some((f) => f.name === k) || k === 'id');
    if (!keys.length) return null;
    const cond = keys.map((k, i) => `${k} = $${i + 1}`).join(' AND ');
    const res = await q(`SELECT * FROM ${r.table} WHERE ${cond} LIMIT 1`, keys.map((k) => where[k]), tx);
    return res.rows[0] ?? null;
  }

  async countWhere(r: Resource, where: Payload, tx?: Tx): Promise<number> {
    const keys = Object.keys(where).filter((k) => columnsOf(r).some((f) => f.name === k) || k === 'id');
    const cond = keys.length ? `WHERE ${keys.map((k, i) => `${k} = $${i + 1}`).join(' AND ')}` : '';
    const res = await q(`SELECT COUNT(*)::int AS n FROM ${r.table} ${cond}`, keys.map((k) => where[k]), tx);
    return res.rows[0]?.n ?? 0;
  }

  async insert(r: Resource, data: Payload, tx?: Tx): Promise<Row> {
    const allowed = new Set(columnsOf(r).map((f) => f.name).concat(['senha_hash']));
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
    const allowed = new Set(columnsOf(r).map((f) => f.name).concat(['senha_hash']));
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
    await q(
      `INSERT INTO auditoria (usuario_id, usuario, acao, recurso, registro_id, descricao, dados)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.usuario_id,
        entry.usuario,
        entry.acao,
        entry.recurso,
        entry.registro_id,
        entry.descricao,
        entry.dados === undefined ? null : JSON.stringify(entry.dados),
      ],
      tx
    );
  }

  async dashboard(): Promise<DashboardData> {
    const [kpis, alertas, ordens, recentes] = await Promise.all([
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
    ]);
    const k = kpis.rows[0] || {};
    return {
      valorEstoque: Number(k.valor_estoque || 0),
      pecasEstoque: Number(k.pecas_estoque || 0),
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
    };
  }

  async findUserByEmail(email: string): Promise<Row | null> {
    const res = await query(
      'SELECT id, nome, email, senha_hash, perfil, ativo FROM usuarios WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [email]
    );
    return res.rows[0] ?? null;
  }

  async touchLogin(userId: number): Promise<void> {
    await query('UPDATE usuarios SET ultimo_login = now() WHERE id = $1', [userId]).catch(() => undefined);
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
