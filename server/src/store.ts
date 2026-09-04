// Contrato de persistência usado pelo serviço de CRUD.
// Há duas implementações:
//   • pgstore.ts — PostgreSQL (produção / DATABASE_URL definida)
//   • memdb.ts   — banco em memória (modo demonstração, sem DATABASE_URL)
import type { PoolClient } from 'pg';
import type { Resource } from './resources';

export type Row = Record<string, any>;
export type Payload = Record<string, unknown>;
export type Tx = PoolClient | null;

export type ListParams = {
  q?: string;
  page: number;
  pageSize: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  /** filtro de igualdade por coluna (ex.: { produto_id: 3 }) */
  filter?: Record<string, unknown>;
};

/** Metadados de um arquivo anexado (sem os bytes). */
export type FileMeta = {
  id: number;
  recurso: string;
  registro_id: number;
  nome: string | null;
  mime: string | null;
  tamanho_bytes: number | null;
  url: string | null;
  thumb_url: string | null;
  externo_id: string | null;
  token: string;
  principal: boolean;
  ordem: number;
  criado_em: string;
};

export type ListResult = {
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
};

export type Option = { value: number; label: string };

export type AuditEntry = {
  usuario_id: number | null;
  usuario: string | null;
  acao: 'criar' | 'editar' | 'excluir' | 'login' | 'senha' | 'importar' | 'ajuste';
  recurso: string | null;
  registro_id: number | null;
  descricao: string;
  dados?: unknown;
};

export type DashboardData = {
  valorEstoque: number;
  pecasEstoque: number;
  itensAlerta: number;
  producao: number;
  vendasAbertas: number;
  comprasPendentes: number;
  vendasMes: number;
  comissoesPagar: number;
  totais: { produtos: number; clientes: number; fornecedores: number; insumos: number };
  alertas: { produto: string; tamanho: string; local: string; quantidade: number; estoque_min: number }[];
  ordens: { id: number; produto: string; tamanho: string; quantidade: number; status: string; previsao: string | null }[];
  recentes: { data: string; usuario: string | null; acao: string; recurso: string | null; descricao: string }[];
  /** Fase 5 — gráficos do Dashboard */
  vendasPorMes: { mes: string; total: number }[];
  producaoPorSemana: { semana: string; pecas: number; ordens: number }[];
  topProdutos: { produto: string; total: number }[];
  insumosAlerta: { insumo: string; quantidade: number; estoque_min: number }[];
};

export interface Store {
  readonly kind: 'postgres' | 'memory';
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;

  list(r: Resource, p: ListParams, tx?: Tx): Promise<ListResult>;
  get(r: Resource, id: number, tx?: Tx): Promise<Row | null>;
  options(r: Resource, tx?: Tx): Promise<Option[]>;
  findOneWhere(r: Resource, where: Payload, tx?: Tx): Promise<Row | null>;
  countWhere(r: Resource, where: Payload, tx?: Tx): Promise<number>;

  insert(r: Resource, data: Payload, tx?: Tx): Promise<Row>;
  update(r: Resource, id: number, data: Payload, tx?: Tx): Promise<Row | null>;
  remove(r: Resource, id: number, tx?: Tx): Promise<boolean>;

  /** Soma `delta` ao saldo (cria o registro de estoque se não existir). */
  adjustStock(produtoId: number, tamanhoId: number, local: string, delta: number, tx?: Tx): Promise<Row>;

  /** Soma `delta` ao saldo do insumo (cria o registro se não existir) e atualiza `atualizado_em`. */
  adjustInsumoStock(insumoId: number, delta: number, tx?: Tx): Promise<Row>;
  /** Saldo atual de um insumo (0 se nunca movimentado). */
  insumoStock(insumoId: number, tx?: Tx): Promise<number>;

  audit(entry: AuditEntry, tx?: Tx): Promise<void>;
  dashboard(): Promise<DashboardData>;

  findUserByEmail(email: string): Promise<Row | null>;
  /** Todos os usuários com senha_hash (usado na migração de senhas legadas). */
  listUsuariosRaw(): Promise<Row[]>;
  /** Preferências por usuário (JSONB no Postgres). */
  getPreferences(userId: number): Promise<Record<string, unknown>>;
  setPreferences(userId: number, prefs: Record<string, unknown>): Promise<void>;
  touchLogin(userId: number): Promise<void>;

  /** Arquivos (fotos) de um conjunto de registros — sem os bytes. */
  filesFor(recurso: string, registroIds: number[], tx?: Tx): Promise<FileMeta[]>;
  /** Um arquivo com os bytes (`dados`, `thumb`) para servir a imagem. */
  fileById(id: number): Promise<Row | null>;
}

/** Rótulo legível de um registro (ex.: "CAM-001 — Camisa Polo" ou "#12"). */
export function labelOf(r: Resource, row: Row | null | undefined): string {
  if (!row) return '';
  const parts = r.labelFields
    .map((f) => row[f])
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(String);
  if (r.labelFields.length === 1 && r.labelFields[0] === 'id') return `#${row.id}`;
  return parts.length ? parts.join(' — ') : `#${row.id}`;
}
