// Banco em memória para o MODO DEMONSTRAÇÃO (sem DATABASE_URL).
// Implementa o mesmo contrato do PostgreSQL (store.ts), incluindo regras de
// unicidade, integridade referencial, busca, paginação e auditoria — assim o
// sistema pode ser testado por completo antes de ligar o banco real.
import { HttpError } from './errors';
import { RESOURCES, columnsOf, getResource, type Resource } from './resources';
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

type Table = { seq: number; rows: Map<number, Row> };

function norm(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Arredonda para 3 casas decimais (quantidades de insumo). */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Arredonda para 2 casas decimais (valores monetários). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class MemStore implements Store {
  readonly kind = 'memory' as const;
  private tables = new Map<string, Table>();

  constructor() {
    for (const r of Object.values(RESOURCES)) {
      const t = this.table(r.table);
      for (const m of r.mock || []) {
        const id = Number(m.id) || t.seq + 1;
        t.rows.set(id, { ...m, id, criado_em: new Date().toISOString() });
        t.seq = Math.max(t.seq, id);
      }
    }
    this.table('auditoria');
  }

  private table(name: string): Table {
    let t = this.tables.get(name);
    if (!t) {
      t = { seq: 0, rows: new Map() };
      this.tables.set(name, t);
    }
    return t;
  }

  private snapshot(): Map<string, Table> {
    const copy = new Map<string, Table>();
    for (const [k, t] of this.tables) {
      copy.set(k, { seq: t.seq, rows: new Map([...t.rows].map(([id, r]) => [id, { ...r }])) });
    }
    return copy;
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const backup = this.snapshot();
    try {
      return await fn(null);
    } catch (e) {
      this.tables = backup; // rollback
      throw e;
    }
  }

  private decorate(r: Resource, row: Row): Row {
    const out: Row = { ...row };
    delete out.senha_hash;
    delete out.senha_cifrada;
    delete out.dados;
    delete out.thumb;
    for (const f of r.fields) {
      if (f.type === 'ref' && f.ref) {
        const target = getResource(f.ref);
        const ref = target ? this.table(target.table).rows.get(Number(row[f.name])) : undefined;
        out[`${f.name}__label`] = target && ref ? labelOf(target, ref) : null;
        const colorField = target?.fields.find((tf) => tf.type === 'color');
        if (colorField) out[`${f.name}__color`] = ref ? ref[colorField.name] ?? null : null;
      }
    }
    return out;
  }

  private matches(r: Resource, row: Row, term: string): boolean {
    const t = term.toLowerCase();
    if (/^\d+$/.test(term) && row.id === Number(term)) return true;
    for (const f of r.fields) {
      if (!f.search) continue;
      if (f.type === 'ref' && f.ref) {
        const target = getResource(f.ref);
        const ref = target ? this.table(target.table).rows.get(Number(row[f.name])) : undefined;
        if (target && ref && labelOf(target, ref).toLowerCase().includes(t)) return true;
      } else if (norm(row[f.name]).toLowerCase().includes(t)) return true;
    }
    return false;
  }

  async list(r: Resource, p: ListParams): Promise<ListResult> {
    const term = (p.q || '').trim();
    let rows = [...this.table(r.table).rows.values()];
    const cols0 = new Set(columnsOf(r).map((f) => f.name));
    const dateCols0 = new Set(r.fields.filter((f) => f.type === 'date' || f.type === 'datetime').map((f) => f.name));
    for (const [k, v] of Object.entries(p.filter || {})) {
      if (v === undefined || v === null || v === '') continue;
      // Intervalo de datas: f.<campo>_de / f.<campo>_ate (ex.: f.data_de)
      const mDate = /^(.*?)_(de|ate)$/.exec(k);
      if (mDate && dateCols0.has(mDate[1])) {
        const dia = String(v).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) continue;
        if (mDate[2] === 'de') {
          rows = rows.filter((row) => norm(row[mDate[1]]).slice(0, 10) >= dia);
        } else {
          rows = rows.filter((row) => norm(row[mDate[1]]).slice(0, 10) <= dia);
        }
        continue;
      }
      if (!cols0.has(k)) continue;
      rows = rows.filter((row) => norm(row[k]) === norm(v));
    }
    if (term) rows = rows.filter((row) => this.matches(r, row, term));
    const cols = new Set(columnsOf(r).map((f) => f.name));
    const sort = p.sort && cols.has(p.sort) ? p.sort : r.orderBy?.field || 'id';
    const dir = (p.dir || r.orderBy?.dir || 'asc') === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      const av = a[sort];
      const bv = b[sort];
      if (av === bv) return b.id - a.id;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return norm(av).localeCompare(norm(bv), 'pt-BR', { numeric: true }) * dir;
    });
    const total = rows.length;
    const start = (p.page - 1) * p.pageSize;
    return {
      rows: rows.slice(start, start + p.pageSize).map((row) => this.decorate(r, row)),
      total,
      page: p.page,
      pageSize: p.pageSize,
    };
  }

  async get(r: Resource, id: number): Promise<Row | null> {
    const row = this.table(r.table).rows.get(id);
    return row ? this.decorate(r, row) : null;
  }

  async options(r: Resource): Promise<Option[]> {
    const res = await this.list(r, { page: 1, pageSize: 2000 });
    return res.rows.map((row) => ({
      value: row.id,
      label: labelOf(r, row) + (row.ativo === false ? ' (inativo)' : ''),
    }));
  }

  async findOneWhere(r: Resource, where: Payload): Promise<Row | null> {
    for (const row of this.table(r.table).rows.values()) {
      if (Object.entries(where).every(([k, v]) => norm(row[k]).toLowerCase() === norm(v).toLowerCase())) return { ...row };
    }
    return null;
  }

  async countWhere(r: Resource, where: Payload): Promise<number> {
    let n = 0;
    for (const row of this.table(r.table).rows.values()) {
      if (Object.entries(where).every(([k, v]) => norm(row[k]) === norm(v))) n++;
    }
    return n;
  }

  private checkConstraints(r: Resource, data: Payload, id?: number) {
    for (const f of r.fields) {
      if (f.unique && data[f.name] !== undefined && data[f.name] !== null) {
        for (const [rid, row] of this.table(r.table).rows) {
          if (rid !== id && norm(row[f.name]).toLowerCase() === norm(data[f.name]).toLowerCase()) {
            throw new HttpError(409, `Já existe um registro com este ${f.label.toLowerCase()}.`, { [f.name]: 'Já cadastrado' });
          }
        }
      }
      if (f.type === 'ref' && f.ref && data[f.name] !== undefined && data[f.name] !== null) {
        const target = getResource(f.ref);
        if (target && !this.table(target.table).rows.has(Number(data[f.name]))) {
          throw new HttpError(400, `${f.label} inválida: o registro selecionado não existe.`, { [f.name]: 'Registro não encontrado' });
        }
      }
    }
    // Chave composta do estoque (produto + tamanho + local)
    if (r.key === 'estoques') {
      const cur = id ? this.table(r.table).rows.get(id) : undefined;
      const merged = { ...(cur || {}), ...data };
      for (const [rid, row] of this.table(r.table).rows) {
        if (rid !== id && row.produto_id === merged.produto_id && row.tamanho_id === merged.tamanho_id && row.local === merged.local) {
          throw new HttpError(409, 'Já existe saldo para este produto, tamanho e local. Edite o registro existente ou lance uma movimentação.');
        }
      }
    }
  }

  async insert(r: Resource, data: Payload): Promise<Row> {
    this.checkConstraints(r, data);
    const t = this.table(r.table);
    const id = ++t.seq;
    const row: Row = { id };
    for (const f of columnsOf(r)) row[f.name] = data[f.name] ?? (f.type === 'boolean' ? f.default ?? null : f.default ?? null);
    if ('senha_hash' in data) row.senha_hash = data.senha_hash;
    if (r.fields.some((f) => f.name === 'criado_em')) row.criado_em = new Date().toISOString();
    if (r.key === 'movimentacoes' || r.key === 'auditoria') row.data = row.data || new Date().toISOString();
    t.rows.set(id, row);
    return { ...row };
  }

  async update(r: Resource, id: number, data: Payload): Promise<Row | null> {
    const t = this.table(r.table);
    const cur = t.rows.get(id);
    if (!cur) return null;
    this.checkConstraints(r, data, id);
    const allowed = new Set(columnsOf(r).map((f) => f.name).concat(['senha_hash']));
    for (const [k, v] of Object.entries(data)) if (allowed.has(k) && k !== 'id') cur[k] = v;
    if (r.fields.some((f) => f.name === 'atualizado_em')) cur.atualizado_em = new Date().toISOString();
    return { ...cur };
  }

  async remove(r: Resource, id: number): Promise<boolean> {
    const t = this.table(r.table);
    if (!t.rows.has(id)) return false;
    // Integridade referencial: alguém aponta para este registro?
    for (const other of Object.values(RESOURCES)) {
      for (const f of other.fields) {
        if (f.type === 'ref' && f.ref === r.key) {
          for (const row of this.table(other.table).rows.values()) {
            if (Number(row[f.name]) === id) {
              throw new HttpError(409, `Este registro está em uso em "${other.label}" e não pode ser excluído. Você pode desativá-lo.`);
            }
          }
        }
      }
    }
    t.rows.delete(id);
    return true;
  }

  async adjustStock(produtoId: number, tamanhoId: number, local: string, delta: number): Promise<Row> {
    const r = RESOURCES.estoques;
    const t = this.table(r.table);
    for (const row of t.rows.values()) {
      if (row.produto_id === produtoId && row.tamanho_id === tamanhoId && row.local === local) {
        row.quantidade = Number(row.quantidade || 0) + delta;
        row.atualizado_em = new Date().toISOString();
        return { ...row };
      }
    }
    return this.insert(r, { produto_id: produtoId, tamanho_id: tamanhoId, local, quantidade: delta, estoque_min: 0 });
  }

  async adjustInsumoStock(insumoId: number, delta: number): Promise<Row> {
    const t = this.table('estoque_insumos');
    for (const row of t.rows.values()) {
      if (Number(row.insumo_id) === Number(insumoId)) {
        row.quantidade = round3(Number(row.quantidade || 0) + delta);
        row.atualizado_em = new Date().toISOString();
        return { ...row };
      }
    }
    const id = ++t.seq;
    const row: Row = { id, insumo_id: insumoId, quantidade: round3(delta), estoque_min: 0, atualizado_em: new Date().toISOString() };
    t.rows.set(id, row);
    return { ...row };
  }

  async insumoStock(insumoId: number): Promise<number> {
    const t = this.table('estoque_insumos');
    for (const row of t.rows.values()) {
      if (Number(row.insumo_id) === Number(insumoId)) return Number(row.quantidade || 0);
    }
    return 0;
  }

  async audit(entry: AuditEntry): Promise<void> {
    const t = this.table('auditoria');
    const id = ++t.seq;
    t.rows.set(id, { id, data: new Date().toISOString(), ...entry, dados: entry.dados ?? null });
    // mantém só os últimos 2000 eventos em memória
    if (t.rows.size > 2000) t.rows.delete(Math.min(...t.rows.keys()));
  }

  async dashboard(): Promise<DashboardData> {
    const rows = (name: string) => [...this.table(name).rows.values()];
    const produtos = new Map(rows('produtos').map((p) => [p.id, p]));
    const tamanhos = new Map(rows('tamanhos').map((t) => [t.id, t]));
    const estoques = rows('estoques');
    const prodLabel = (id: number) => (produtos.get(id) ? labelOf(RESOURCES.produtos, produtos.get(id)!) : `#${id}`);
    const alertas = estoques
      .filter((e) => Number(e.estoque_min) > 0 && Number(e.quantidade) <= Number(e.estoque_min))
      .sort((a, b) => a.quantidade - a.estoque_min - (b.quantidade - b.estoque_min))
      .slice(0, 8)
      .map((e) => ({ produto: prodLabel(e.produto_id), tamanho: tamanhos.get(e.tamanho_id)?.codigo ?? '', local: e.local, quantidade: e.quantidade, estoque_min: e.estoque_min }));
    const ordens = rows('ordens_fabricacao')
      .filter((o) => ['planejada', 'em_producao'].includes(o.status))
      .sort((a, b) => norm(a.previsao).localeCompare(norm(b.previsao)) || b.id - a.id)
      .slice(0, 8)
      .map((o) => ({ id: o.id, produto: prodLabel(o.produto_id), tamanho: tamanhos.get(o.tamanho_id)?.codigo ?? '', quantidade: o.quantidade, status: o.status, previsao: o.previsao ?? null }));
    const recentes = rows('auditoria')
      .filter((a) => a.acao !== 'login')
      .sort((a, b) => norm(b.data).localeCompare(norm(a.data)))
      .slice(0, 8)
      .map((a) => ({ data: a.data, usuario: a.usuario, acao: a.acao, recurso: a.recurso, descricao: a.descricao }));
    const vendasRows = rows('vendas');
    const faturadas = vendasRows.filter((v) => v.status === 'faturada' || v.status === 'entregue');
    const mesAtual = new Date().toISOString().slice(0, 7);

    // Fase 5 — gráficos: 12 meses, 8 semanas, top 10 produtos, insumos em alerta
    const chaveMes = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const vendasPorMes: { mes: string; total: number }[] = [];
    const hoje = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - i, 1));
      const mes = chaveMes(d);
      vendasPorMes.push({ mes, total: faturadas.filter((v) => String(v.faturada_em || '').slice(0, 7) === mes).reduce((s, v) => s + Number(v.total || 0), 0) });
    }
    const inicioSemana = (d: Date) => {
      const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const dia = (x.getUTCDay() + 6) % 7; // segunda = 0
      x.setUTCDate(x.getUTCDate() - dia);
      return x;
    };
    const chaveDia = (d: Date) => d.toISOString().slice(0, 10);
    const hojeSemana = inicioSemana(hoje);
    const producaoPorSemana: { semana: string; pecas: number; ordens: number }[] = [];
    const concluidas = rows('ordens_fabricacao').filter((o) => o.status === 'concluida');
    const itensOrdem = rows('itens_ordem');
    for (let i = 7; i >= 0; i--) {
      const sem = new Date(hojeSemana.getTime() - i * 7 * 86400000);
      const chave = chaveDia(sem);
      const daSemana = concluidas.filter((o) => {
        const base = o.concluida_em || o.atualizado_em || o.criado_em;
        return inicioSemana(new Date(String(base))).toISOString().slice(0, 10) === chave;
      });
      producaoPorSemana.push({
        semana: chave,
        ordens: daSemana.length,
        pecas: daSemana.reduce((acc, o) => {
          if (String(o.tipo || 'tamanho') === 'grade') return acc + itensOrdem.filter((io) => Number(io.ordem_id) === Number(o.id)).reduce((a, io) => a + Number(io.quantidade || 0), 0);
          return acc + Number(o.quantidade || 0);
        }, 0),
      });
    }
    const valorItensVenda = rows('itens_venda');
    const faturadasIds = new Set(faturadas.map((v) => v.id));
    const porProduto = new Map<number, number>();
    for (const iv of valorItensVenda) {
      if (!faturadasIds.has(Number(iv.venda_id))) continue;
      const pid = Number(iv.produto_id);
      porProduto.set(pid, (porProduto.get(pid) || 0) + Number(iv.subtotal || 0));
    }
    const topProdutos = [...porProduto.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, total]) => ({ produto: produtos.get(id) ? labelOf(RESOURCES.produtos, produtos.get(id)!) : `#${id}`, total }));
    const estoqueInsumos = rows('estoque_insumos');
    const insumosRows = rows('insumos');
    const insumosAlerta = estoqueInsumos
      .filter((ei) => Number(ei.estoque_min) > 0 && Number(ei.quantidade) <= Number(ei.estoque_min))
      .sort((a, b) => a.quantidade - a.estoque_min - (b.quantidade - b.estoque_min))
      .slice(0, 8)
      .map((ei) => {
        const ins = insumosRows.find((x) => Number(x.id) === Number(ei.insumo_id));
        return { insumo: ins ? labelOf(RESOURCES.insumos, ins) : `#${ei.insumo_id}`, quantidade: Number(ei.quantidade || 0), estoque_min: Number(ei.estoque_min || 0) };
      });

    return {
      valorEstoque: estoques.reduce((s, e) => s + Number(e.quantidade || 0) * Number(produtos.get(e.produto_id)?.custo || 0), 0),
      pecasEstoque: estoques.reduce((s, e) => s + Number(e.quantidade || 0), 0),
      itensAlerta: estoques.filter((e) => Number(e.estoque_min) > 0 && Number(e.quantidade) <= Number(e.estoque_min)).length,
      producao: rows('ordens_fabricacao').filter((o) => ['planejada', 'em_producao'].includes(o.status)).length,
      vendasAbertas: vendasRows.filter((v) => v.status === 'aberta').length,
      comprasPendentes: rows('compras').filter((c) => c.status === 'pendente').length,
      vendasMes: faturadas
        .filter((v) => String(v.faturada_em || '').slice(0, 7) === mesAtual)
        .reduce((s, v) => s + Number(v.total || 0), 0),
      comissoesPagar: faturadas.reduce((s, v) => s + Number(v.comissao_valor || 0), 0),
      totais: { produtos: produtos.size, clientes: rows('clientes').length, fornecedores: rows('fornecedores').length, insumos: rows('insumos').length },
      alertas,
      ordens,
      recentes,
      vendasPorMes,
      producaoPorSemana,
      topProdutos,
      insumosAlerta,
    };
  }

  async findUserByEmail(email: string): Promise<Row | null> {
    const e = email.toLowerCase();
    for (const row of this.table('usuarios').rows.values()) {
      if (norm(row.email).toLowerCase() === e) return { ...row };
    }
    return null;
  }

  async listUsuariosRaw(): Promise<Row[]> {
    return [...this.table('usuarios').rows.values()].map((r) => ({ ...r }));
  }

  async getPreferences(userId: number): Promise<Record<string, unknown>> {
    const row = this.table('usuarios').rows.get(userId);
    const prefs = row?.preferencias;
    return prefs && typeof prefs === 'object' ? prefs : {};
  }

  async setPreferences(userId: number, prefs: Record<string, unknown>): Promise<void> {
    const row = this.table('usuarios').rows.get(userId);
    if (row) {
      row.preferencias = prefs;
      row.atualizado_em = new Date().toISOString();
    }
  }

  async touchLogin(userId: number): Promise<void> {
    const row = this.table('usuarios').rows.get(userId);
    if (row) row.ultimo_login = new Date().toISOString();
  }

  async filesFor(recurso: string, registroIds: number[]): Promise<FileMeta[]> {
    const ids = new Set(registroIds.map(Number));
    return [...this.table('arquivos').rows.values()]
      .filter((f) => f.recurso === recurso && ids.has(Number(f.registro_id)))
      .sort((a, b) => Number(!!b.principal) - Number(!!a.principal) || Number(a.ordem) - Number(b.ordem) || a.id - b.id)
      .map(({ dados: _d, thumb: _t, ...meta }) => meta as FileMeta);
  }

  async fileById(id: number): Promise<Row | null> {
    const row = this.table('arquivos').rows.get(id);
    return row ? { ...row } : null;
  }
}
