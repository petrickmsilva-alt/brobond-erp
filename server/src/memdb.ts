// Banco em memória para o MODO DEMONSTRAÇÃO (sem DATABASE_URL).
// Implementa o mesmo contrato do PostgreSQL (store.ts), incluindo regras de
// unicidade, integridade referencial, busca, paginação e auditoria — assim o
// sistema pode ser testado por completo antes de ligar o banco real.
import { HttpError } from './errors';
import { COLUNAS_AUTENTICACAO, RESOURCES, columnsOf, getResource, type Resource } from './resources';
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
import { round2 } from './utils';
import { EMPRESA_PADRAO, type EscopoEmpresa } from './empresa';
import { chaveSemanaCivil, diaCivil, inicioSemanaCivil, mesCivil, mesCivilDeslocado } from './fuso';

/** Tabelas do painel que carregam `empresa_id` (migration 0017). */
const TABELAS_DO_PAINEL_COM_EMPRESA = new Set([
  'estoques', 'ordens_fabricacao', 'vendas', 'compras', 'produtos', 'clientes', 'fornecedores', 'insumos',
  'estoque_insumos', 'itens_venda', 'itens_ordem', 'colecoes', 'auditoria',
]);

type Table = { seq: number; rows: Map<number, Row> };

/**
 * Tabelas filhas que herdam `empresa_id` do pai — espelho exato dos triggers
 * `trg_empresa_*` criados pela migration 0017 no Postgres.
 */
const HERANCA_EMPRESA: Record<string, { pai: string; fk: string }> = {
  itens_venda: { pai: 'vendas', fk: 'venda_id' },
  itens_compra: { pai: 'compras', fk: 'compra_id' },
  itens_ordem: { pai: 'ordens_fabricacao', fk: 'ordem_id' },
  itens_inventario: { pai: 'inventarios', fk: 'inventario_id' },
  itens_ficha_tecnica: { pai: 'fichas_tecnicas', fk: 'ficha_id' },
  estoques: { pai: 'produtos', fk: 'produto_id' },
  movimentacoes: { pai: 'produtos', fk: 'produto_id' },
  estoque_insumos: { pai: 'insumos', fk: 'insumo_id' },
  movimentacoes_insumos: { pai: 'insumos', fk: 'insumo_id' },
  produto_composicao: { pai: 'produtos', fk: 'produto_id' },
};

function norm(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Arredonda para 3 casas decimais (quantidades de insumo). */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export class MemStore implements Store {
  readonly kind = 'memory' as const;
  private tables = new Map<string, Table>();
  // Chaves textuais (sessões por JTI e buckets de rate limit) fora das tabelas numéricas.
  private sessoes = new Map<string, Record<string, any>>();
  private rateLimits = new Map<string, Record<string, any>>();

  constructor() {
    for (const r of Object.values(RESOURCES)) {
      const t = this.table(r.table);
      for (const m of r.mock || []) {
        const id = Number(m.id) || t.seq + 1;
        // MULTIEMPRESA: os dados de demonstração pertencem à empresa padrão —
        // o mesmo DEFAULT 1 que o Postgres aplica nas colunas `empresa_id`.
        const empresa = r.empresa ? { empresa_id: Number(m.empresa_id) || EMPRESA_PADRAO } : null;
        t.rows.set(id, { ...m, ...empresa, id, criado_em: new Date().toISOString() });
        t.seq = Math.max(t.seq, id);
      }
    }
    this.table('auditoria');
  }

  /**
   * Espelha o trigger `brobond_herdar_empresa` do Postgres: tabelas filhas
   * herdam a empresa do registro-pai, de modo que nem o app nem um teste
   * consigam criar um item órfão de escopo.
   */
  private herdarEmpresa(r: Resource, row: Row): void {
    if (!r.empresa) return;
    const spec = HERANCA_EMPRESA[r.table];
    if (spec) {
      const fk = Number(row[spec.fk]);
      if (fk > 0) {
        const pai = this.table(spec.pai).rows.get(fk);
        if (pai && pai.empresa_id !== undefined && pai.empresa_id !== null) {
          row.empresa_id = Number(pai.empresa_id);
          return;
        }
      }
    }
    if (row.empresa_id === undefined || row.empresa_id === null || row.empresa_id === '') {
      row.empresa_id = EMPRESA_PADRAO;
    } else {
      row.empresa_id = Number(row.empresa_id);
    }
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

  async transaction<T>(fn: (tx: Tx) => Promise<T>, _options?: TransactionOptions): Promise<T> {
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
    // Colunas secretas jamais saem da API: hash de senha, segredo MFA e tokens.
    delete out.senha_hash;
    delete out.senha_historico;
    delete out.mfa_secret;
    delete out.mfa_backup_hashes;
    delete out.convite_token_hash;
    delete out.reset_token_hash;
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
    // `id` é ordenável mesmo não aparecendo em `fields`: é a ordem real de
    // inserção, e trilhas de eventos dependem dela (o fallback por criado_em
    // embaralha eventos gravados no mesmo milissegundo).
    const cols = new Set(columnsOf(r).map((f) => f.name).concat('id'));
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
    const cur = id ? this.table(r.table).rows.get(id) : undefined;
    const merged = { ...(cur || {}), ...data };
    for (const f of r.fields) {
      if ((f.unique || f.uniqueEmpresa) && data[f.name] !== undefined && data[f.name] !== null) {
        for (const [rid, row] of this.table(r.table).rows) {
          const mesmaEmpresa = !f.uniqueEmpresa || Number(row.empresa_id ?? EMPRESA_PADRAO) === Number(merged.empresa_id ?? EMPRESA_PADRAO);
          const mesmoValor = f.uniqueEmpresa
            ? norm(row[f.name]) === norm(data[f.name])
            : norm(row[f.name]).toLowerCase() === norm(data[f.name]).toLowerCase();
          if (rid !== id && mesmaEmpresa && mesmoValor) {
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
    // A célula é produto + tamanho (NULL é um tamanho válido) + local canônico,
    // isolada por empresa. Registros antigos só com texto usam a chave textual.
    if (r.key === 'estoques') {
      const empresaId = Number(merged.empresa_id ?? EMPRESA_PADRAO);
      const localKey = (row: Row) => norm(row.local);
      for (const [rid, row] of this.table(r.table).rows) {
        const mesmoTamanho = (row.tamanho_id === null || row.tamanho_id === undefined ? null : Number(row.tamanho_id)) ===
          (merged.tamanho_id === null || merged.tamanho_id === undefined ? null : Number(merged.tamanho_id));
        if (
          rid !== id &&
          Number(row.empresa_id ?? EMPRESA_PADRAO) === empresaId &&
          Number(row.produto_id) === Number(merged.produto_id) &&
          mesmoTamanho &&
          localKey(row) === localKey(merged)
        ) {
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
    // Colunas internas de autenticação (hash/segredos/tokens) graváveis pela API interna.
    for (const k of COLUNAS_AUTENTICACAO) if (k in data) row[k] = data[k];
    if (r.fields.some((f) => f.name === 'criado_em')) row.criado_em = new Date().toISOString();
    if (r.key === 'movimentacoes' || r.key === 'auditoria') row.data = row.data || new Date().toISOString();
    this.herdarEmpresa(r, row);
    t.rows.set(id, row);
    return { ...row };
  }

  async update(r: Resource, id: number, data: Payload): Promise<Row | null> {
    const t = this.table(r.table);
    const cur = t.rows.get(id);
    if (!cur) return null;
    this.checkConstraints(r, data, id);
    const allowed = new Set(columnsOf(r).map((f) => f.name).concat(COLUNAS_AUTENTICACAO));
    for (const [k, v] of Object.entries(data)) if (allowed.has(k) && k !== 'id') cur[k] = v;
    if (r.fields.some((f) => f.name === 'atualizado_em')) cur.atualizado_em = new Date().toISOString();
    this.herdarEmpresa(r, cur);
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

  async adjustStock(
    produtoId: number,
    tamanhoId: number | null,
    local: string,
    delta: number,
    _tx?: Tx,
    localId?: number | null,
    empresaId?: number
  ): Promise<Row> {
    const r = RESOURCES.estoques;
    const t = this.table(r.table);
    const produto = this.table('produtos').rows.get(Number(produtoId));
    const ownerId = Number(empresaId ?? produto?.empresa_id ?? EMPRESA_PADRAO);
    if (!produto || Number(produto.empresa_id ?? EMPRESA_PADRAO) !== ownerId) throw new HttpError(404, 'Produto não encontrado.');
    if (localId === undefined || localId === null || !Number.isInteger(Number(localId)) || Number(localId) <= 0) {
      throw new HttpError(409, 'A movimentação exige um local canônico identificado por ID.');
    }
    const localRow = this.table('locais').rows.get(Number(localId));
    if (!localRow || Number(localRow.empresa_id ?? EMPRESA_PADRAO) !== ownerId) throw new HttpError(404, 'Local não encontrado.');
    const nomeLocal = String(localRow.nome);
    const sameSize = (v: unknown) => (v === null || v === undefined ? null : Number(v)) === (tamanhoId === null ? null : Number(tamanhoId));
    const matches = [...t.rows.values()].filter((row) =>
      Number(row.empresa_id ?? EMPRESA_PADRAO) === ownerId &&
      Number(row.produto_id) === Number(produtoId) &&
      sameSize(row.tamanho_id) &&
      (Number(row.local_id) === Number(localId) || ((row.local_id === null || row.local_id === undefined) && row.local === nomeLocal))
    );
    if (matches.length > 1) throw new HttpError(409, 'Há saldos duplicados para este produto/tamanho/local. Nenhuma movimentação foi aplicada.');
    const row = matches[0];
    if (row) {
      if (row.local_id === null || row.local_id === undefined || Number(row.local_id) !== Number(localId) || String(row.local) !== nomeLocal) {
        throw new HttpError(409, 'O saldo possui vínculo canônico de local ausente ou inconsistente.');
      }
      row.quantidade = Number(row.quantidade || 0) + delta;
      row.atualizado_em = new Date().toISOString();
      return { ...row };
    }
    return this.insert(r, {
      empresa_id: ownerId,
      produto_id: produtoId,
      tamanho_id: tamanhoId,
      local: nomeLocal,
      local_id: localId ?? null,
      quantidade: delta,
      estoque_min: 0,
    });
  }

  async tryUpdateIf(r: Resource, id: number, esperado: Payload, data: Payload): Promise<Row | null> {
    const cur = this.table(r.table).rows.get(id);
    if (!cur) return null;
    for (const [k, v] of Object.entries(esperado)) {
      const atual = cur[k];
      if (v === null || v === undefined) {
        if (atual !== null && atual !== undefined) return null;
      } else if (String(atual) !== String(v)) return null;
    }
    return this.update(r, id, data);
  }

  async tryAdjustStock(
    produtoId: number,
    tamanhoId: number | null,
    local: string,
    delta: number,
    _tx?: Tx,
    minimo = 0,
    localId?: number | null,
    empresaId?: number
  ): Promise<Row | null> {
    const r = RESOURCES.estoques;
    const t = this.table(r.table);
    const produto = this.table('produtos').rows.get(Number(produtoId));
    const ownerId = Number(empresaId ?? produto?.empresa_id ?? EMPRESA_PADRAO);
    if (!produto || Number(produto.empresa_id ?? EMPRESA_PADRAO) !== ownerId) throw new HttpError(404, 'Produto não encontrado.');
    if (localId === undefined || localId === null || !Number.isInteger(Number(localId)) || Number(localId) <= 0) {
      throw new HttpError(409, 'A movimentação exige um local canônico identificado por ID.');
    }
    const localRow = this.table('locais').rows.get(Number(localId));
    if (!localRow || Number(localRow.empresa_id ?? EMPRESA_PADRAO) !== ownerId) throw new HttpError(404, 'Local não encontrado.');
    const nomeLocal = String(localRow.nome);
    const sameSize = (v: unknown) => (v === null || v === undefined ? null : Number(v)) === (tamanhoId === null ? null : Number(tamanhoId));
    const matches = [...t.rows.values()].filter((row) =>
      Number(row.empresa_id ?? EMPRESA_PADRAO) === ownerId &&
      Number(row.produto_id) === Number(produtoId) &&
      sameSize(row.tamanho_id) &&
      (Number(row.local_id) === Number(localId) || ((row.local_id === null || row.local_id === undefined) && row.local === nomeLocal))
    );
    if (matches.length > 1) throw new HttpError(409, 'Há saldos duplicados para este produto/tamanho/local. Nenhuma movimentação foi aplicada.');
    const linha = matches[0];
    if (!linha) {
      if (delta < minimo || delta === 0) return null;
      return this.insert(r, {
        empresa_id: ownerId,
        produto_id: produtoId,
        tamanho_id: tamanhoId,
        local: nomeLocal,
        local_id: localId ?? null,
        quantidade: delta,
        estoque_min: 0,
      });
    }
    if (linha.local_id === null || linha.local_id === undefined || Number(linha.local_id) !== Number(localId) || String(linha.local) !== nomeLocal) {
      throw new HttpError(409, 'O saldo possui vínculo canônico de local ausente ou inconsistente.');
    }
    const atual = Number(linha.quantidade || 0);
    if (atual + delta < minimo) return null;
    if (delta === 0) return { ...linha };
    linha.quantidade = atual + delta;
    linha.atualizado_em = new Date().toISOString();
    return { ...linha };
  }

  async insertMany(r: Resource, rows: Payload[]): Promise<Row[]> {
    const out: Row[] = [];
    for (const d of rows) out.push(await this.insert(r, d));
    return out;
  }

  async adjustInsumoStock(insumoId: number, delta: number, _tx?: Tx, empresaId?: number): Promise<Row> {
    const insumo = this.table('insumos').rows.get(Number(insumoId));
    const dono = Number(empresaId ?? insumo?.empresa_id ?? EMPRESA_PADRAO);
    if (!insumo || Number(insumo.empresa_id ?? EMPRESA_PADRAO) !== dono) throw new HttpError(404, 'Insumo não encontrado.');
    const t = this.table('estoque_insumos');
    for (const row of t.rows.values()) {
      if (Number(row.insumo_id) === Number(insumoId)) {
        if (Number(row.empresa_id ?? EMPRESA_PADRAO) !== dono) throw new HttpError(409, 'O saldo do insumo possui vínculo de empresa inconsistente.');
        row.quantidade = round3(Number(row.quantidade || 0) + delta);
        row.atualizado_em = new Date().toISOString();
        return { ...row };
      }
    }
    const id = ++t.seq;
    const row: Row = { id, empresa_id: dono, insumo_id: insumoId, quantidade: round3(delta), estoque_min: 0, atualizado_em: new Date().toISOString() };
    t.rows.set(id, row);
    return { ...row };
  }

  async insumoStock(insumoId: number, _tx?: Tx, empresaId?: number): Promise<number> {
    const insumo = this.table('insumos').rows.get(Number(insumoId));
    const dono = Number(empresaId ?? insumo?.empresa_id ?? EMPRESA_PADRAO);
    if (!insumo || Number(insumo.empresa_id ?? EMPRESA_PADRAO) !== dono) throw new HttpError(404, 'Insumo não encontrado.');
    const t = this.table('estoque_insumos');
    for (const row of t.rows.values()) {
      if (Number(row.insumo_id) === Number(insumoId)) {
        if (Number(row.empresa_id ?? EMPRESA_PADRAO) !== dono) throw new HttpError(409, 'O saldo do insumo possui vínculo de empresa inconsistente.');
        return Number(row.quantidade || 0);
      }
    }
    return 0;
  }

  async audit(entry: AuditEntry): Promise<void> {
    const t = this.table('auditoria');
    const id = ++t.seq;
    // Cadeia de hashes (tamper-evidence): hash_i = SHA-256(hash_{i-1} | payload).
    const anterior = t.rows.get(t.rows.size ? Math.max(...t.rows.keys()) : 0);
    const hash_anterior = anterior?.hash ? String(anterior.hash) : '';
    const hash = hashCadeiaAuditoria(hash_anterior, entry);
    // O tipo exige empresa_id, mas chamadas legadas/diretas (testes, jobs)
    // podem omitir em runtime: nunca grava sem empresa (coluna NOT NULL).
    const empresa_id = entry.empresa_id ?? EMPRESA_PADRAO;
    t.rows.set(id, { id, data: new Date().toISOString(), ...entry, empresa_id, dados: entry.dados ?? null, hash_anterior, hash });
    // mantém só os últimos 2000 eventos em memória
    if (t.rows.size > 2000) t.rows.delete(Math.min(...t.rows.keys()));
  }

  async verificarAuditoria(): Promise<AuditoriaVerificacao> {
    return verificarCadeiaAuditoria([...this.table('auditoria').rows.values()]);
  }

  async dashboard(escopo?: EscopoEmpresa | null): Promise<DashboardData> {
    // MULTIEMPRESA: mesma regra do pgstore — só as tabelas com empresa_id são
    // recortadas; tabelas globais (tamanhos, etc.) seguem inteiras.
    const emp = escopo && !escopo.consolidado ? escopo.empresaId : null;
    const rows = (name: string) =>
      [...this.table(name).rows.values()].filter(
        (r) => emp === null || !TABELAS_DO_PAINEL_COM_EMPRESA.has(name) || Number(r.empresa_id ?? EMPRESA_PADRAO) === emp
      );
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
    // Agrupamentos por MÊS/SEMANA CIVIL em America/Sao_Paulo (ver fuso.ts):
    // antes eram UTC — 21:00–23:59 BR do último dia do mês caía no mês
    // seguinte, e a semana civil era deslocada.
    const mesAtual = mesCivil(new Date());

    // Fase 5 — gráficos: 12 meses, 8 semanas, top 10 produtos, insumos em alerta
    const chaveMes = (d: Date) => mesCivil(d);
    // Mesma regra do SQL (COALESCE de faturada_em para data).
    const quandoFaturada = (v: Row) => v.faturada_em || v.data || null;
    const vendasPorMes: { mes: string; total: number }[] = [];
    const hoje = new Date();
    for (let i = 11; i >= 0; i--) {
      const mes = mesCivilDeslocado(hoje, -i);
      vendasPorMes.push({
        mes,
        total: faturadas
          .filter((v) => {
            const quando = quandoFaturada(v);
            return quando !== null && chaveMes(new Date(String(quando))) === mes;
          })
          .reduce((s, v) => s + Number(v.total || 0), 0),
      });
    }
    const hojeSemana = inicioSemanaCivil(hoje);
    const producaoPorSemana: { semana: string; pecas: number; ordens: number }[] = [];
    const concluidas = rows('ordens_fabricacao').filter((o) => o.status === 'concluida');
    const itensOrdem = rows('itens_ordem');
    for (let i = 7; i >= 0; i--) {
      const sem = new Date(hojeSemana.getTime() - i * 7 * 86400000);
      const chave = diaCivil(sem);
      const daSemana = concluidas.filter((o) => {
        const base = o.concluida_em || o.atualizado_em || o.criado_em;
        return base ? chaveSemanaCivil(String(base)) === chave : false;
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

    // Valorização em três bases (custo × atacado × varejo): saldo por produto
    // somando todos os tamanhos e locais; o cálculo fica em valorizacao.ts.
    const colecoes = new Map(rows('colecoes').map((c) => [Number(c.id), String(c.nome || '')]));
    const saldoPorProduto = new Map<number, number>();
    for (const e of estoques) {
      const pid = Number(e.produto_id);
      saldoPorProduto.set(pid, (saldoPorProduto.get(pid) || 0) + Number(e.quantidade || 0));
    }
    const valorizacao = valorizarEstoque(
      [...saldoPorProduto.entries()].map(([pid, pecas]) => {
        const p = produtos.get(pid);
        return {
          id: pid,
          produto: prodLabel(pid),
          colecao: p?.colecao_id ? colecoes.get(Number(p.colecao_id)) ?? null : null,
          pecas,
          custo: p?.custo,
          preco_venda: p?.preco_venda,
          preco_atacado: p?.preco_atacado,
        };
      })
    );

    return {
      valorEstoque: estoques.reduce((s, e) => s + Number(e.quantidade || 0) * Number(produtos.get(e.produto_id)?.custo || 0), 0),
      pecasEstoque: estoques.reduce((s, e) => s + Number(e.quantidade || 0), 0),
      valorizacao,
      itensAlerta: estoques.filter((e) => Number(e.estoque_min) > 0 && Number(e.quantidade) <= Number(e.estoque_min)).length,
      producao: rows('ordens_fabricacao').filter((o) => ['planejada', 'em_producao'].includes(o.status)).length,
      vendasAbertas: vendasRows.filter((v) => v.status === 'aberta').length,
      comprasPendentes: rows('compras').filter((c) => c.status === 'pendente').length,
      vendasMes: faturadas
        .filter((v) => v.faturada_em != null && v.faturada_em !== '' && mesCivil(String(v.faturada_em)) === mesAtual)
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

  async touchLogin(userId: number, ip?: string | null): Promise<void> {
    const row = this.table('usuarios').rows.get(userId);
    if (row) {
      row.ultimo_login = new Date().toISOString();
      if (ip) row.ultimo_ip = ip;
      row.tentativas_falhas = 0;
      row.ultimo_falha_em = null;
    }
  }

  // ------------------------------------------------------------------
  // Sessões (invalidação por dispositivo)
  // ------------------------------------------------------------------
  async criarSessao(sessao: Omit<Sessao, 'criada_em' | 'revogada_em'>): Promise<Sessao> {
    const agora = new Date().toISOString();
    const row: Sessao = { ...sessao, criada_em: agora, revogada_em: null };
    this.sessoes.set(row.id, { ...row });
    return { ...row };
  }

  async getSessao(id: string): Promise<Sessao | null> {
    const row = this.sessoes.get(id);
    return row ? ({ ...row } as Sessao) : null;
  }

  async listSessoesAtivas(usuarioId: number): Promise<Sessao[]> {
    const agora = Date.now();
    return [...this.sessoes.values()]
      .filter((s) => Number(s.usuario_id) === Number(usuarioId) && !s.revogada_em && new Date(s.expira_em).getTime() > agora)
      .sort((a, b) => String(b.criada_em).localeCompare(String(a.criada_em)))
      .map((s) => ({ ...s }) as Sessao);
  }

  async revogarSessao(id: string): Promise<boolean> {
    const row = this.sessoes.get(id);
    if (!row || row.revogada_em) return false;
    row.revogada_em = new Date().toISOString();
    return true;
  }

  async revogarSessoes(usuarioId: number, exceto?: string): Promise<number> {
    let n = 0;
    for (const s of this.sessoes.values()) {
      if (Number(s.usuario_id) === Number(usuarioId) && !s.revogada_em && s.id !== exceto) {
        s.revogada_em = new Date().toISOString();
        n++;
      }
    }
    return n;
  }

  async limparSessoesEncerradas(): Promise<void> {
    const limite = Date.now() - 7 * 24 * 3600_000;
    for (const [id, s] of this.sessoes) {
      const fim = Math.max(new Date(s.expira_em).getTime(), s.revogada_em ? new Date(s.revogada_em).getTime() : 0);
      if (fim < limite) this.sessoes.delete(id);
    }
  }

  // ------------------------------------------------------------------
  // Rate limit persistente (memória no modo demonstração)
  // ------------------------------------------------------------------
  async rateLimitEstado(chave: string, windowMs: number): Promise<RateState | null> {
    const row = this.rateLimits.get(chave);
    if (!row) return null;
    const agora = Date.now();
    const primeira = new Date(row.primeira_em).getTime();
    const bloqueado = row.bloqueado_ate ? new Date(row.bloqueado_ate).getTime() : 0;
    if (agora - primeira > windowMs && bloqueado < agora) {
      // Janela expirada: bucket zera.
      this.rateLimits.delete(chave);
      return null;
    }
    return { count: Number(row.count || 0), primeira_em: String(row.primeira_em), bloqueado_ate: row.bloqueado_ate ? String(row.bloqueado_ate) : null };
  }

  async rateLimitHit(chave: string, windowMs: number, max: number): Promise<{ restantes: number; bloqueado_ate: string | null }> {
    const agora = Date.now();
    let b = this.rateLimits.get(chave);
    if (!b || agora - new Date(b.primeira_em).getTime() > windowMs) b = { chave, count: 0, primeira_em: new Date(agora).toISOString(), bloqueado_ate: null };
    b.count = Number(b.count || 0) + 1;
    let bloqueado_ate: string | null = b.bloqueado_ate ? String(b.bloqueado_ate) : null;
    if (b.count >= max && (!bloqueado_ate || new Date(bloqueado_ate).getTime() < agora)) {
      bloqueado_ate = new Date(agora + windowMs).toISOString();
    }
    this.rateLimits.set(chave, { chave, count: b.count, primeira_em: b.primeira_em, bloqueado_ate });
    return { restantes: Math.max(0, max - b.count), bloqueado_ate };
  }

  async rateLimitReset(chave: string): Promise<void> {
    this.rateLimits.delete(chave);
  }

  async limparRateLimitsAntigos(): Promise<void> {
    const limite = Date.now() - 24 * 3600_000;
    for (const [k, b] of this.rateLimits) {
      const fim = Math.max(new Date(b.primeira_em).getTime(), b.bloqueado_ate ? new Date(b.bloqueado_ate).getTime() : 0);
      if (fim < limite) this.rateLimits.delete(k);
    }
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
