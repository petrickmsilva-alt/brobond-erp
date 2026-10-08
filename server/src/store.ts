// Contrato de persistência usado pelo serviço de CRUD.
// Há duas implementações:
//   • pgstore.ts — PostgreSQL (produção / DATABASE_URL definida)
//   • memdb.ts   — banco em memória (modo demonstração, sem DATABASE_URL)
import type { PoolClient } from 'pg';
import type { Resource } from './resources';

export type Row = Record<string, any>;
export type Payload = Record<string, unknown>;
export type Tx = PoolClient | null;

export type TransactionOptions = {
  /** Nível mais forte para operações de estoque/expedição concorrentes. */
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
};

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
  acao: 'criar' | 'editar' | 'excluir' | 'login' | 'login_falha' | 'senha' | 'mfa' | 'seguranca' | 'bloqueio' | 'convite' | 'importar' | 'ajuste' | 'estornar';
  recurso: string | null;
  registro_id: number | null;
  descricao: string;
  dados?: unknown;
  /**
   * MULTIEMPRESA (Etapa 2.1): toda entrada de auditoria carrega a empresa do
   * fato registrado, resolvida NO MOMENTO DO EVENTO (ver empresaDoEventoAudit
   * em empresa.ts) — nunca inferida depois a partir de dados que podem ter
   * mudado. O feed (/api/auditoria) filtra por ela via `empresa: true` do
   * recurso. Obrigatório: o tipo exige para nenhum call site esquecer.
   */
  empresa_id: number;
};

/** Sessão de login (invalidação por dispositivo — JTI no JWT). */
export type Sessao = {
  id: string;
  usuario_id: number;
  criada_em: string;
  expira_em: string;
  revogada_em: string | null;
  ip: string | null;
  user_agent: string | null;
};

/** Estado do bucket persistente de rate limit. */
export type RateState = { count: number; primeira_em: string; bloqueado_ate: string | null };

/** Resultado da verificação da cadeia de hashes da auditoria. */
export type AuditoriaVerificacao = { ok: boolean; total: number; verificadas: number; quebras: number[] };

/** Limite de produtos detalhados na valorização do Dashboard (o restante fica no relatório). */
export const VALORIZACAO_MAX_PRODUTOS = 200;

/**
 * Valorização do estoque em três bases — custo de produção (produtos.custo),
 * atacado (preco_atacado; sem atacado cadastrado vale o varejo, como no
 * catálogo/portal) e varejo (preco_venda) — nos três níveis: unidade (por
 * produto), coleção e todas as peças em estoque.
 */
export type ValorizacaoEstoque = {
  pecas: number;
  custo: number;
  atacado: number;
  varejo: number;
  /** Produtos com saldo > 0 (para avisar quando a lista abaixo foi cortada). */
  produtosComSaldo: number;
  /** Produtos com saldo e sem preço de atacado (valorizados pelo varejo). */
  semPrecoAtacado: number;
  colecoes: { colecao: string; pecas: number; custo: number; atacado: number; varejo: number }[];
  produtos: {
    id: number;
    produto: string;
    colecao: string | null;
    pecas: number;
    custo_unit: number;
    atacado_unit: number;
    varejo_unit: number;
    atacado_definido: boolean;
    custo: number;
    atacado: number;
    varejo: number;
  }[];
};

export type DashboardData = {
  valorEstoque: number;
  pecasEstoque: number;
  valorizacao: ValorizacaoEstoque;
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
  transaction<T>(fn: (tx: Tx) => Promise<T>, options?: TransactionOptions): Promise<T>;

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

  /**
   * Como `adjustStock`, mas só aplica se o saldo resultante não ficar abaixo de
   * `minimo` (padrão 0) — e a checagem faz parte da escrita, na mesma
   * instrução. `adjustStock` + `if (saldo < 0) throw` lido antes deixa uma
   * janela entre ler e gravar: duas saídas concorrentes veem o mesmo saldo e
   * ambas abatem. Retorna null quando o abatimento não cabe.
   */
  tryAdjustStock(produtoId: number, tamanhoId: number, local: string, delta: number, tx?: Tx, minimo?: number): Promise<Row | null>;

  /** Vários inserts em uma ida ao banco (usado no snapshot do inventário). */
  insertMany(r: Resource, rows: Payload[], tx?: Tx): Promise<Row[]>;
  /** UPDATE atômico condicionado ao valor atual: 0 linhas alteradas → null. */
  tryUpdateIf(r: Resource, id: number, esperado: Payload, data: Payload, tx?: Tx): Promise<Row | null>;

  /** Soma `delta` ao saldo do insumo (cria o registro se não existir) e atualiza `atualizado_em`. */
  adjustInsumoStock(insumoId: number, delta: number, tx?: Tx): Promise<Row>;
  /** Saldo atual de um insumo (0 se nunca movimentado). */
  insumoStock(insumoId: number, tx?: Tx): Promise<number>;

  audit(entry: AuditEntry, tx?: Tx): Promise<void>;
  /** Verifica a cadeia de hashes da auditoria (integridade/tamper-evidence). */
  verificarAuditoria(): Promise<AuditoriaVerificacao>;
  dashboard(): Promise<DashboardData>;

  findUserByEmail(email: string): Promise<Row | null>;
  /** Todos os usuários com senha_hash (usado na migração de senhas legadas). */
  listUsuariosRaw(): Promise<Row[]>;
  /** Preferências por usuário (JSONB no Postgres). */
  getPreferences(userId: number): Promise<Record<string, unknown>>;
  setPreferences(userId: number, prefs: Record<string, unknown>): Promise<void>;
  touchLogin(userId: number, ip?: string | null): Promise<void>;

  // ---- Sessões (invalidação de sessões por dispositivo) ----
  criarSessao(s: Omit<Sessao, 'criada_em' | 'revogada_em'>): Promise<Sessao>;
  getSessao(id: string): Promise<Sessao | null>;
  listSessoesAtivas(usuarioId: number): Promise<Sessao[]>;
  revogarSessao(id: string): Promise<boolean>;
  /** Revoga todas as sessões ativas do usuário; `exceto` preserva a sessão atual. */
  revogarSessoes(usuarioId: number, exceto?: string): Promise<number>;
  /** Remove sessões encerradas há mais de 7 dias (limpeza). */
  limparSessoesEncerradas(): Promise<void>;

  // ---- Rate limit persistente (sobrevive a reinícios) ----
  rateLimitEstado(chave: string, windowMs: number): Promise<RateState | null>;
  /** Registra uma tentativa; retorna (restantes, bloqueadoAté). */
  rateLimitHit(chave: string, windowMs: number, max: number): Promise<{ restantes: number; bloqueado_ate: string | null }>;
  rateLimitReset(chave: string): Promise<void>;
  /** Remove buckets expirados há mais de 24 h (limpeza). */
  limparRateLimitsAntigos(): Promise<void>;

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
