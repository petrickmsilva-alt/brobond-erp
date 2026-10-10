// Camada de serviço: CRUD genérico + regras de negócio por módulo
// (estoque, movimentações, ordens, usuários) + auditoria.
import { randomBytes } from 'node:crypto';
import { HttpError } from './errors';
import { MemStore } from './memdb';
import { PgStore, isPgAvailable, translatePgError } from './pgstore';
import { getResource, RESOURCES, type Resource } from './resources';
import { labelOf, type ListParams, type Payload, type Row, type Store, type Tx } from './store';
import { validatePayload } from './validate';
import type { Request } from 'express';
import type { AuthUser } from './auth';
import { attachImages, removeAllFiles } from './uploads';
import { aplicarRegrasPedido } from './itens';
import { aplicarRegrasOrdem, recalcularFichaValores, validarOrdemPayload } from './producao';
import { hookTaxaLancamento, syncAporte, syncLancamentoCompra, syncLancamentoVenda, syncTransferencia } from './financeiro';
import {
  aplicarFiltroEmpresa,
  assertRegistroDaEmpresa,
  EMPRESA_PADRAO,
  assertRegistroDaEmpresaParaEscrita,
  carimbarEmpresa,
  empresaDoAtorAudit,
  empresaDoRegistroAudit,
  escopoDoAtor,
  escopoDeSistema,
  protegerEmpresaNaEdicao,
  temEscopoEmpresa,
  registroNoEscopo,
  validarReferenciasDaEmpresa,
  type EscopoEmpresa,
} from './empresa';

const PERFIL_RANK: Record<string, number> = { operador: 1, gerente: 2, admin: 3 };

let store: Store | null = null;

export function getStore(): Store {
  if (!store) store = isPgAvailable() ? new PgStore() : new MemStore();
  return store;
}

/** Converte qualquer erro em HttpError legível para o cliente. */
export function toHttpError(e: any, r?: Resource): HttpError {
  if (e instanceof HttpError) return e;
  const pg = translatePgError(e, r);
  if (pg) return pg;
  if (e?.message === 'NO_DB') return new HttpError(503, 'Banco de dados indisponível.');
  console.error('Erro inesperado:', e);
  return new HttpError(500, 'Erro interno do servidor');
}

type Actor = Pick<AuthUser, 'id' | 'name' | 'perfil'> & Partial<AuthUser>;

/**
 * MULTIEMPRESA: o escopo é SEMPRE derivado do ator (ou explicitamente nulo
 * para chamadas internas que já recortam por outro caminho). Nunca do corpo
 * da requisição. Ver empresa.ts.
 */
export type { EscopoEmpresa };

/** Aceita tanto um ator quanto um escopo já resolvido (ou nada). */
export type EscopoOuAtor = Actor | EscopoEmpresa | null | undefined;

/**
 * Normaliza o 3º parâmetro das funções de CRUD.
 *
 *   • `undefined` → SEM recorte. Reservado a chamadas internas que já filtram
 *     por outro caminho (jobs, BI, endpoints públicos por token).
 *   • um escopo → usado como está.
 *   • um ator → o escopo é derivado dele (nunca do corpo da requisição).
 */
export function comoEscopo(x: EscopoOuAtor): EscopoEmpresa | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof (x as EscopoEmpresa).empresaId === 'number') return x as EscopoEmpresa;
  return escopoDoAtor(x as any);
}

/** Escopo do ator — atalho explícito para as rotas HTTP. */
export function escopoDe(actor: Actor | null | undefined): EscopoEmpresa {
  return escopoDoAtor(actor as any);
}

function audit(
  tx: Tx,
  actor: Actor,
  acao: 'criar' | 'editar' | 'excluir',
  r: Resource,
  id: number | null,
  descricao: string,
  dados?: unknown,
  /** Linha do registro (create: carimbada; update/delete: ANTES) — a empresa do evento sai dela. */
  row?: Row | null
) {
  return getStore().audit(
    {
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao,
      recurso: r.key,
      registro_id: id,
      descricao,
      dados,
      empresa_id: empresaDoRegistroAudit(r, row ?? null, actor),
    },
    tx
  );
}

/** Campos que mudaram entre o registro anterior e o payload (para a auditoria). */
function diff(before: Row, data: Payload): Record<string, { de: unknown; para: unknown }> {
  const out: Record<string, { de: unknown; para: unknown }> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'senha_hash') {
      out.senha = { de: '••••', para: '••••' };
      continue;
    }
    const prev = before[k];
    const same =
      prev === v ||
      (prev !== null && v !== null && prev !== undefined && v !== undefined && String(prev) === String(v)) ||
      (typeof prev === 'string' && typeof v === 'string' && prev.slice(0, 10) === v.slice(0, 10) && /^\d{4}-\d{2}-\d{2}/.test(v));
    if (!same) out[k] = { de: prev ?? null, para: v ?? null };
  }
  return out;
}

export type CapacidadeComercial = 'catalogos' | 'compartilhar' | 'metricas' | 'politicas' | 'aprovar';

export function podeComercial(actor: Actor, capacidade: CapacidadeComercial): boolean {
  if (actor.perfil === 'admin') return true;
  const valor = String(actor[`perm_${capacidade}` as keyof Actor] || 'herdar');
  if (valor === 'permitir') return true;
  if (valor === 'negar') return false;
  return actor.perfil === 'gerente';
}

export function exigirComercial(actor: Actor, capacidade: CapacidadeComercial) {
  if (!podeComercial(actor, capacidade)) throw new HttpError(403, 'Você não possui esta permissão comercial. Peça ao administrador para revisar sua alçada.');
}

export function checkAccess(r: Resource, actor: Actor, op: 'read' | 'create' | 'update' | 'delete') {
  if (r.key === 'catalogos') {
    if (op === 'read') {
      if (!podeComercial(actor, 'catalogos') && !podeComercial(actor, 'compartilhar') && !podeComercial(actor, 'metricas')) exigirComercial(actor, 'catalogos');
    } else exigirComercial(actor, 'catalogos');
  }
  if (r.key === 'politicas_comerciais') { exigirComercial(actor, 'politicas'); }
  const perfil = actor.perfil || 'operador';
  if (r.minPerfil && !['catalogos', 'politicas_comerciais'].includes(r.key) && (PERFIL_RANK[perfil] ?? 0) < PERFIL_RANK[r.minPerfil]) {
    throw new HttpError(403, r.minPerfil === 'admin' ? 'Apenas administradores acessam este módulo.' : 'Apenas gerentes e administradores acessam este módulo.');
  }
  if (r.adminOnly && perfil !== 'admin') {
    throw new HttpError(403, 'Apenas administradores acessam este módulo.');
  }
  if (op !== 'read' && !r.ops[op]) {
    const verbo = op === 'create' ? 'incluir' : op === 'update' ? 'alterar' : 'excluir';
    throw new HttpError(405, `Não é possível ${verbo} registros em ${r.label}.`);
  }
  if (op === 'delete' && actor.perfil === 'operador') {
    throw new HttpError(403, 'Operadores não podem excluir registros. Peça a um gerente ou administrador.');
  }
}

/**
 * Alçada dos ENDPOINTS DE FLUXO (abrir caixa, converter proposta, autorizar
 * devolução, receber compra, expedir...).
 *
 * Diferente de `checkAccess(r, 'create'|'update'|'delete')`, não consulta
 * `r.ops` — e não é descuido. `r.ops` fechado existe justamente para impedir
 * que o CRUD genérico (POST/PUT /api/:recurso) crie ou edite esses registros
 * POR FORA do fluxo: um PUT em `pdv_caixas` não pode fechar caixa, um PUT em
 * `devolucoes` não pode autorizar. Aqui o endpoint É o caminho legítimo, então
 * o que vale é a alçada da pessoa: minPerfil, adminOnly e as permissões
 * comerciais continuam todas sendo conferidas (é o que o `read` já faz).
 */
export function checkFluxo(r: Resource, actor: Actor): void {
  checkAccess(r, actor, 'read');
}

const RECURSOS_COM_REFERENCIAS_ESTOQUE = new Set([
  'produtos', 'insumos', 'estoques', 'movimentacoes', 'movimentacoes_insumos',
  'estoque_insumos', 'inventarios', 'itens_inventario', 'compras',
  'compra_recebimentos', 'itens_compra', 'ordens', 'itens_ordem', 'fichas',
]);

/** Antes de devolver labels/joined refs, confirma que cada relação pertence ao mesmo tenant do registro raiz. */
export async function validarReferenciasDeSaida(r: Resource, rows: Row[], escopo: EscopoOuAtor): Promise<void> {
  if (!rows.length || !RECURSOS_COM_REFERENCIAS_ESTOQUE.has(r.key)) return;
  const s = getStore();
  const escopoNormalizado = comoEscopo(escopo);
  const cache = new Map<string, Row | null>();
  const ler = async (alvo: Resource, id: number, dono: number): Promise<Row | null> => {
    const empresaId = temEscopoEmpresa(alvo) ? dono : 0;
    const chave = `${alvo.key}:${empresaId}:${id}`;
    if (cache.has(chave)) return cache.get(chave)!;
    const filtro = empresaId ? { id, empresa_id: empresaId } : { id };
    const row = await s.findOneWhere(alvo, filtro);
    cache.set(chave, row);
    return row;
  };
  for (const row of rows) {
    if (!registroNoEscopo(r, row, escopoNormalizado)) throw new HttpError(404, `${r.singular} não encontrado(a).`);
    const dono = Number(row.empresa_id ?? EMPRESA_PADRAO);
    for (const field of r.fields) {
      if (field.type !== 'ref' || !field.ref) continue;
      const valor = row[field.name];
      if (valor === undefined || valor === null || valor === '') continue;
      const id = Number(valor);
      const alvo = getResource(field.ref);
      if (!alvo || !Number.isInteger(id) || id <= 0 || !await ler(alvo, id, dono)) {
        throw new HttpError(404, `${field.label} não encontrado(a).`);
      }
    }
    // compra_id é coluna legada inteira (não declarada como `ref` no Resource).
    if (r.key === 'movimentacoes' && row.compra_id !== undefined && row.compra_id !== null && row.compra_id !== '') {
      const id = Number(row.compra_id);
      const compra = Number.isInteger(id) && id > 0 ? await ler(getResource('compras')!, id, dono) : null;
      if (!compra) throw new HttpError(404, 'Compra não encontrada.');
    }
  }
}

// ----------------------------------------------------------------------------
// Leitura
// ----------------------------------------------------------------------------
export async function listRecords(r: Resource, p: ListParams, escopoOuAtor?: EscopoOuAtor) {
  const escopo = comoEscopo(escopoOuAtor);
  // Filtros virtuais do módulo Usuários (status consolidado, MFA, senha, acesso):
  // a tabela de usuários é pequena, então filtra em JS sobre a lista completa
  // — com total e paginação corretos — em vez de aproximar na página atual.
  if (r.key === 'usuarios' && (p.filter?.status || p.filter?.mfa || p.filter?.parado30d || p.filter?.senha || p.filter?.acesso)) {
    return listUsuariosFiltrados(p);
  }
  // MULTIEMPRESA: o recorte entra como filtro obrigatório (AND) e descarta
  // qualquer `f.empresa_id` que o cliente tenha tentado injetar.
  const params: ListParams = { ...p, filter: aplicarFiltroEmpresa(r, p.filter, escopo) };
  const out = await getStore().list(r, params);
  await validarReferenciasDeSaida(r, out.rows, escopo);
  await attachImages(r, out.rows);
  anotarStatusSenha(r, out.rows);
  await anotarUsoLocal(r, out.rows);
  await attachGradeTamanhos(r, out.rows);
  return out;
}

/** Lista de usuários com filtro por status consolidado, MFA, senha e/ou período de acesso (admin). */
async function listUsuariosFiltrados(p: ListParams) {
  const r = getResource('usuarios')!;
  const { status, mfa, parado30d, senha, acesso, ...base } = p.filter || {};
  const full = await getStore().list(r, { q: p.q, page: 1, pageSize: 5000, sort: p.sort, dir: p.dir, filter: base });
  await attachImages(r, full.rows);
  anotarStatusSenha(r, full.rows);
  let rows = full.rows;
  if (typeof status === 'string' && status) rows = rows.filter((row) => row.status_conta === status);
  if (typeof senha === 'string' && senha) rows = rows.filter((row) => row.senha_status === senha);
  if (mfa === 'sim') rows = rows.filter((row) => !!row.mfa_ativado_em);
  else if (mfa === 'nao') rows = rows.filter((row) => !row.mfa_ativado_em);

  const agora = Date.now();
  if (typeof acesso === 'string' && acesso) {
    if (acesso === 'recente') {
      rows = rows.filter((row) => row.ultimo_login && agora - new Date(String(row.ultimo_login)).getTime() <= 7 * 86400000);
    } else if (acesso === 'parado30d') {
      const ha30d = agora - 30 * 24 * 3600_000;
      rows = rows.filter((row) => {
        if (row.ativo === false || !row.senha_definida_em) return false;
        const loginMs = row.ultimo_login ? new Date(String(row.ultimo_login)).getTime() : 0;
        return !loginMs || loginMs < ha30d;
      });
    } else if (acesso === 'nunca') {
      rows = rows.filter((row) => !row.ultimo_login);
    }
  } else if (parado30d === 'sim') {
    const ha30d = agora - 30 * 24 * 3600_000;
    rows = rows.filter((row) => {
      if (row.ativo === false || !row.senha_definida_em) return false;
      const loginMs = row.ultimo_login ? new Date(String(row.ultimo_login)).getTime() : 0;
      return !loginMs || loginMs < ha30d;
    });
  }
  const total = rows.length;
  const start = (p.page - 1) * p.pageSize;
  return { rows: rows.slice(start, start + p.pageSize), total, page: p.page, pageSize: p.pageSize };
}

export async function getRecord(r: Resource, id: number, escopoOuAtor?: EscopoOuAtor) {
  const escopo = comoEscopo(escopoOuAtor);
  const filtro = aplicarFiltroEmpresa(r, { id }, escopo) || { id };
  const store = getStore();
  // Primeiro prova a posse com uma busca já recortada pelo tenant. Só depois
  // usa get() para carregar os labels/joins do recurso, sem expor IDs alheios.
  const posse = await store.findOneWhere(r, filtro);
  if (!posse) throw new HttpError(404, `${r.singular} não encontrado(a).`);
  const row = await store.get(r, id);
  if (!row) throw new HttpError(404, `${r.singular} não encontrado(a).`);
  // Registro de outra empresa responde 404 — 403 já vazaria que ele existe.
  assertRegistroDaEmpresa(r, row, escopo);
  await validarReferenciasDeSaida(r, [row], escopo);
  await attachImages(r, [row]);
  anotarStatusSenha(r, [row]);
  await anotarUsoLocal(r, [row]);
  await attachGradeTamanhos(r, [row]);
  return row;
}

/**
 * Colunas "Senha" e "Status" da lista de usuários: mostram o ESTADO do acesso,
 * nunca o valor. A senha é guardada em hash Argon2id (mão única) — nem um
 * administrador consegue vê-la ou recuperá-la.
 *   senha_status: convite_pendente | provisoria | propria
 *   status_conta: ativo | convite_pendente | convite_expirado | provisoria |
 *                 bloqueado | expirado | inativo
 */
function anotarStatusSenha(r: Resource, rows: Row[]) {
  if (r.key !== 'usuarios') return;
  const agora = Date.now();
  for (const row of rows) {
    row.senha_status = !row.senha_definida_em ? 'convite_pendente' : row.trocar_senha ? 'provisoria' : 'propria';
    const conviteExpirado = row.convite_expira_em ? new Date(String(row.convite_expira_em)).getTime() < agora : false;
    row.convite_expirado = conviteExpirado;
    const bloqueado = row.bloqueio_manual === true || (!!row.bloqueado_ate && new Date(String(row.bloqueado_ate)).getTime() > agora);
    const expirado = !!row.acesso_expira_em && new Date(String(row.acesso_expira_em)).getTime() < agora;
    row.conta_bloqueada = bloqueado;
    row.acesso_expirado = expirado;
    row.status_conta =
      row.ativo === false
        ? 'inativo'
        : bloqueado
          ? 'bloqueado'
          : expirado
            ? 'expirado'
            : !row.senha_definida_em
              ? conviteExpirado
                ? 'convite_expirado'
                : 'convite_pendente'
              : row.trocar_senha
                ? 'provisoria'
                : 'ativo';
  }
}

export async function optionsFor(r: Resource, escopoOuAtor?: EscopoOuAtor) {
  const escopo = comoEscopo(escopoOuAtor);
  if (!temEscopoEmpresa(r)) return getStore().options(r);
  // Selects só oferecem registros da empresa ativa: escolher é o primeiro
  // passo para referenciar, e referenciar entre empresas é proibido.
  const filtro = aplicarFiltroEmpresa(r, undefined, escopo);
  if (!filtro) return getStore().options(r);
  const { rows } = await getStore().list(r, { page: 1, pageSize: 2000, filter: filtro, sort: r.orderBy?.field, dir: r.orderBy?.dir });
  const temAtivo = r.fields.some((f) => f.name === 'ativo');
  return rows.map((row) => ({
    value: Number(row.id),
    label: labelOf(r, row) + (temAtivo && row.ativo === false ? ' (inativo)' : ''),
  }));
}

// ----------------------------------------------------------------------------
// Grades de tamanhos (muitos-para-muitos grade × tamanho)
// ----------------------------------------------------------------------------

export type GradeInfo = {
  gradeId: number;
  gradeNome: string;
  tamanhos: { id: number; codigo: string }[];
};

/** Anexa `tamanhos` (ids) e `tamanhos__label` (códigos) aos registros de grades. */
async function attachGradeTamanhos(r: Resource, rows: Row[], tx?: Tx): Promise<void> {
  if (r.key !== 'grades' || !rows.length) return;
  const s = getStore();
  const [todos, itens] = await Promise.all([
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 1000 }, tx),
    s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 10000, sort: 'ordem', dir: 'asc' }, tx),
  ]);
  const codigoPor = new Map(todos.rows.map((t) => [Number(t.id), String(t.codigo || '')]));
  const porGrade = new Map<number, number[]>();
  for (const it of itens.rows) {
    const g = Number(it.grade_id);
    if (!porGrade.has(g)) porGrade.set(g, []);
    porGrade.get(g)!.push(Number(it.tamanho_id));
  }
  for (const row of rows) {
    const ids = porGrade.get(Number(row.id)) ?? [];
    row.tamanhos = ids;
    row.tamanhos__label = ids.map((id) => codigoPor.get(id) ?? `#${id}`).join(', ');
  }
}

/** Substitui os tamanhos de uma grade pelos ids fornecidos (ordem = posição). */
async function syncGradeTamanhos(gradeId: number, tamanhoIds: number[], tx: Tx): Promise<void> {
  const s = getStore();
  const existentes = await s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 1000, filter: { grade_id: gradeId } }, tx);
  for (const it of existentes.rows) await s.remove(RESOURCES.grade_tamanhos, Number(it.id), tx);
  let ordem = 1;
  for (const t of tamanhoIds) {
    await s.insert(RESOURCES.grade_tamanhos, { grade_id: gradeId, tamanho_id: t, ordem }, tx);
    ordem += 1;
  }
}

/** Resolve a grade efetiva de um produto (produto.grade_id ?? categoria.grade_id). */
export async function gradeDoProduto(produto: Row, tx?: Tx): Promise<GradeInfo | null> {
  const s = getStore();
  let gradeId = Number(produto.grade_id) || 0;
  if (!gradeId && Number(produto.categoria_id)) {
    const cat = await s.findOneWhere(RESOURCES.categorias, { id: produto.categoria_id }, tx);
    gradeId = Number(cat?.grade_id) || 0;
  }
  if (!gradeId) return null;
  const grade = await s.findOneWhere(RESOURCES.grades, { id: gradeId }, tx);
  if (!grade) return null;
  const [todos, itens] = await Promise.all([
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 1000 }),
    s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 1000, filter: { grade_id: gradeId }, sort: 'ordem', dir: 'asc' }, tx),
  ]);
  const codigoPor = new Map(todos.rows.map((t) => [Number(t.id), String(t.codigo || '')]));
  const tamanhos = itens.rows.map((it) => ({
    id: Number(it.tamanho_id),
    codigo: codigoPor.get(Number(it.tamanho_id)) ?? `#${it.tamanho_id}`,
  }));
  return { gradeId, gradeNome: String(grade.nome || `#${gradeId}`), tamanhos };
}

/**
 * O tamanho precisa existir na grade efetiva do produto (a do produto, senão a
 * da categoria). A tela já filtra, mas planilha de importação, integração e
 * chamada direta à API não passam pela tela — é aqui que a mistura PP–GG com
 * 36–48 para de verdade. Produto sem grade fica de fora (ainda não organizado).
 */
export async function validarTamanhoNaGrade(produtoId: number, tamanhoId: number | null, tx: Tx | undefined, escopo: EscopoEmpresa): Promise<void> {
  if (!Number.isInteger(produtoId) || produtoId <= 0) throw new HttpError(404, 'Produto não encontrado.');
  const s = getStore();
  const produto = await s.findOneWhere(RESOURCES.produtos, { id: produtoId, empresa_id: escopo.empresaId }, tx);
  if (!produto) throw new HttpError(404, 'Produto não encontrado.');
  if (tamanhoId === null) return;
  if (!Number.isInteger(tamanhoId) || tamanhoId <= 0) throw new HttpError(404, 'Tamanho não encontrado.');
  const tamanho = await s.findOneWhere(RESOURCES.tamanhos, { id: tamanhoId }, tx);
  if (!tamanho) throw new HttpError(404, 'Tamanho não encontrado.');
  const grade = await gradeDoProduto(produto, tx);
  if (!grade || !grade.tamanhos.length) return;
  if (grade.tamanhos.some((t) => t.id === tamanhoId)) return;
  throw new HttpError(
    400,
    `O tamanho "${String(tamanho.codigo ?? `#${tamanhoId}`)}" não faz parte da grade "${grade.gradeNome}" de ${String(produto.sku ?? `#${produtoId}`)}.`,
    {
      tamanho_id:
        `A grade aceita: ${grade.tamanhos.map((t) => t.codigo).join(', ')}. ` +
        'Se o produto pertence a outra grade, ajuste a grade no cadastro dele.',
    }
  );
}

// ----------------------------------------------------------------------------
// Escrita (com regras por módulo)
// ----------------------------------------------------------------------------
/**
 * `ctx.req` é opcional: serve para os links disparados por efeitos colaterais
 * (convite de acesso por e-mail) saírem com a origem absoluta correta quando
 * APP_URL não está configurada.
 */
/** Plano de contas em dois níveis: a categoria-pai não pode ser a própria nem ter avô. */
async function validarCategoriaPai(r: Resource, data: Row, before: Row | null, tx: Tx): Promise<void> {
  if (data.pai_id === undefined || data.pai_id === null || data.pai_id === '') return;
  const s = getStore();
  const paiId = Number(data.pai_id);
  if (before && paiId === Number(before.id)) {
    throw new HttpError(400, 'A categoria não pode ser pai de si mesma.', { pai_id: 'Escolha outra categoria' });
  }
  const pai = await s.findOneWhere(r, { id: paiId }, tx);
  if (!pai) throw new HttpError(404, 'Categoria-pai não encontrada.', { pai_id: 'Categoria inexistente' });
  if (pai.pai_id) {
    throw new HttpError(400, `“${String(pai.nome)}” já é uma subcategoria — o plano de contas tem dois níveis. Vincule a uma categoria principal.`, { pai_id: 'Já é subcategoria' });
  }
}

export async function createRecord(r: Resource, body: unknown, actor: Actor, ctx: { req?: Request; escopo?: EscopoOuAtor } = {}): Promise<Row> {
  const data = validatePayload(r, body, 'create');
  const s = getStore();
  // MULTIEMPRESA: a empresa do novo registro é decidida pelo SERVIDOR.
  const escopo = ctx.escopo === undefined ? escopoDe(actor) : (comoEscopo(ctx.escopo) ?? escopoDeSistema());
  carimbarEmpresa(r, data, escopo);
  let conviteLink: string | undefined;
  let conviteEntregue = false;
  try {
    const criado = await s.transaction(async (tx) => {
      // Regras específicas
      if (r.key === 'usuarios') await prepareUserPayload(data, null, actor);
      if (r.key === 'catalogos') await prepareCatalogosPayload(data, null, actor);
      if (r.key === 'politicas_comerciais') prepararPoliticaComercial(data, null);
      if (r.key === 'movimentacoes') return createMovimentacao(data, actor, tx, escopo);
      if (r.key === 'movimentacoes_insumos') return createMovimentacaoInsumo(data, actor, tx, escopo);
      if (r.key === 'estoques') {
        await resolveLocal(data, tx, escopo);
        await validarTamanhoNaGrade(Number(data.produto_id), data.tamanho_id == null ? null : Number(data.tamanho_id), tx, escopo);
        await ensureUniqueStock(data, null, tx, escopo);
        await garantirSaldoNaoNegativo(data, null);
      }
      if (r.key === 'inventarios') {
        await resolveLocal(data, tx, escopo);
        // Abrir um inventário é sempre abrir: `status` é readonly na API e o
        // DEFAULT 'aberto' só existe no Postgres, então no modo demonstração o
        // registro nascia sem status e o snapshot do saldo nunca rodava.
        if (data.status === undefined || data.status === null || data.status === '') data.status = 'aberto';
      }
      // O estado fiscal pertence aos endpoints de NF-e: o formulário não cria nota.
      if (r.key === 'vendas') for (const k of ['nfe_status', 'nfe_numero', 'nfe_emitida_em', 'nfe_provider']) delete data[k];
      if (r.key === 'locais') await ensureLocalPadraoUnico(data, null, tx, escopo);
      if (r.key === 'ordens') await validarOrdemPayload(data, null);
      // Lançamento: taxa da operadora → líquido calculado antes de gravar
      if (r.key === 'lancamentos_financeiros') hookTaxaLancamento(data, null);
      if (r.key === 'categorias_financeiras') await validarCategoriaPai(r, data, null, tx);
      if (r.key === 'transferencias_financeiras' && Number(data.conta_origem_id) === Number(data.conta_destino_id)) {
        throw new HttpError(400, 'Origem e destino precisam ser contas diferentes.', { conta_destino_id: 'Escolha outra conta' });
      }

      const gradeTamanhos = r.key === 'grades' ? ((data.tamanhos as number[]) || []) : null;
      if (gradeTamanhos) delete data.tamanhos;

      // Nenhum id enviado pelo cliente fura o escopo: toda referência para um
      // recurso com empresa precisa pertencer à MESMA empresa ativa.
      await validarReferenciasDaEmpresa(r, data, escopo, (alvo, alvoId, empresaId, t) => s.findOneWhere(alvo, { id: alvoId, empresa_id: empresaId }, t), tx);

      const row = await s.insert(r, data, tx);
      if (r.key === 'locais') await garantirLocalPadrao(tx, escopo);
      if (r.key === 'grades' && gradeTamanhos) await syncGradeTamanhos(Number(row.id), gradeTamanhos, tx);

      if (r.key === 'estoques' && Number(row.quantidade) !== 0) {
        await s.insert(
          getResource('movimentacoes')!,
          { empresa_id: escopo.empresaId, tipo: 'ajuste', produto_id: row.produto_id, tamanho_id: row.tamanho_id, local: row.local, local_id: row.local_id ?? null, quantidade: Number(row.quantidade), motivo: 'Saldo inicial (cadastro de estoque)', usuario_id: actor.id || null },
          tx
        );
      }
      if (r.key === 'ordens') {
        const full = (await s.get(r, row.id, tx)) ?? row;
        await aplicarRegrasOrdem(null, full, data, { id: actor.id || null, name: actor.name, perfil: actor.perfil }, tx, escopo, { forcar: false });
      }
      if (r.key === 'fichas') {
        await recalcularFichaValores(Number(row.id), tx, escopo);
      }
      if (r.key === 'inventarios' && row.status === 'aberto') {
        await abrirInventarioSnapshot(row, actor, tx, escopo);
      }
      if (r.key === 'vendas' || r.key === 'compras') {
        await aplicarRegrasPedido(r.key === 'vendas' ? 'venda' : 'compra', null, row, data, { id: actor.id || null, name: actor.name }, tx, escopo);
        const full = (await s.get(r, row.id, tx)) ?? row;
        await (r.key === 'vendas' ? syncLancamentoVenda : syncLancamentoCompra)(null, full, data, { id: actor.id || null, name: actor.name }, tx);
      }
      if (r.key === 'aportes') {
        await syncAporte(null, row, actor, tx);
      }
      // Transferência → par espelho (saída na origem, entrada no destino)
      if (r.key === 'transferencias_financeiras') {
        const full = (await s.get(r, row.id, tx)) ?? row;
        await syncTransferencia(null, full, actor, tx);
      }

      // Convite de acesso: usuário criado sem senha recebe um link por e-mail
      // para definir a própria senha (48 h). Quando o e-mail não pode sair
      // (sem SMTP ou SMTP com falha), o link volta na resposta da criação
      // (`convite_link`) para entrega manual, em vez de ficar só no console.
      if (r.key === 'usuarios' && !row.senha_hash) {
        const { gerarConvite } = await import('./usuariosAdmin');
        const convite = await gerarConvite(row, { id: actor.id || 0, name: actor.name }, tx, ctx.req);
        conviteLink = convite.link;
        conviteEntregue = convite.entregue;
      }

      await audit(tx, actor, 'criar', r, row.id, `${r.singular} ${labelOf(r, row)} incluído(a)`, sanitize(data), row);
      const final = (await s.get(r, row.id, tx)) ?? row;
      if (conviteLink) (final as Row).convite_link = conviteLink;
      await attachGradeTamanhos(r, [final], tx);
      return final;
    });
    // Pós-commit: integrações (fire-and-forget — nunca derrubam a resposta).
    if (r.key === 'usuarios') {
      const conta = {
        usuario_id: Number(criado.id),
        nome: String(criado.nome || ''),
        email: String(criado.email || ''),
        perfil: String(criado.perfil || ''),
        por: String(actor.name || ''),
      };
      void import('./webhooks')
        .then((m) => m.disparar('usuario.criado', conta))
        .catch(() => undefined);
      if (conviteEntregue) {
        void import('./webhooks')
          .then((m) => m.disparar('usuario.convite_enviado', conta))
          .catch(() => undefined);
      }
    }
    return criado;
  } catch (e) {
    throw toHttpError(e, r);
  }
}

export type UpdateOpts = { forcar?: boolean; escopo?: EscopoOuAtor };

export async function updateRecord(r: Resource, id: number, body: unknown, actor: Actor, opts: UpdateOpts = {}): Promise<Row> {
  const data = validatePayload(r, body, 'update');
  const s = getStore();
  // A empresa de um registro NUNCA muda por um PUT.
  protegerEmpresaNaEdicao(r, data);
  const escopo = opts.escopo === undefined ? escopoDe(actor) : (comoEscopo(opts.escopo) ?? escopoDeSistema());
  try {
    return await s.transaction(async (tx) => {
      const filtroAntes = temEscopoEmpresa(r) ? { id, empresa_id: escopo.empresaId } : { id };
      const before = await s.findOneWhere(r, filtroAntes, tx);
      if (!before) throw new HttpError(404, `${r.singular} não encontrado(a).`);
      assertRegistroDaEmpresaParaEscrita(r, before, escopo);
      await validarReferenciasDaEmpresa(r, data, escopo, (alvo, alvoId, empresaId, t) => s.findOneWhere(alvo, { id: alvoId, empresa_id: empresaId }, t), tx);

      if (r.key === 'usuarios') await prepareUserPayload(data, before, actor);
      if (r.key === 'catalogos') await prepareCatalogosPayload(data, before, actor);
      if (r.key === 'politicas_comerciais') prepararPoliticaComercial(data, before);
      if (r.key === 'estoques') {
        const localAnteriorId = before.local_id === null || before.local_id === undefined ? null : Number(before.local_id);
        const localIdInformado = data.local_id !== undefined && data.local_id !== null && data.local_id !== '';
        const nomeInformado = data.local !== undefined && data.local !== null && data.local !== '' ? String(data.local).trim() : null;
        if (localAnteriorId === null) {
          // Não converter saldo histórico sem vínculo por uma associação baseada em nome.
          if (localIdInformado || (nomeInformado !== null && nomeInformado !== String(before.local || ''))) {
            throw new HttpError(409, 'Este saldo histórico não possui vínculo canônico de local. Atribua-o por um procedimento administrativo explícito antes de alterar o local.');
          }
          if (data.quantidade !== undefined && Number(data.quantidade) !== Number(before.quantidade)) {
            throw new HttpError(409, 'Não é possível ajustar um saldo sem local canônico. Corrija o vínculo do local antes de lançar a movimentação.');
          }
          if (nomeInformado === null) data.local = String(before.local || '');
          data.local_id = null;
        } else {
          if (localIdInformado && Number(data.local_id) !== localAnteriorId) throw new HttpError(409, 'A localização de um saldo existente não pode ser trocada diretamente; use uma movimentação entre locais.');
          if (nomeInformado !== null && nomeInformado !== String(before.local || '')) throw new HttpError(409, 'A localização de um saldo existente não pode ser trocada por nome.');
          data.local_id = localAnteriorId;
          data.local = String(before.local || '');
          await resolveLocal(data, tx, escopo);
          if (String(data.local) !== String(before.local || '')) throw new HttpError(409, 'O vínculo canônico e o nome histórico do local estão inconsistentes. Revise os dados antes de alterar o saldo.');
        }
        const produtoId = Number(data.produto_id ?? before.produto_id);
        const tamanhoRaw = data.tamanho_id === undefined ? before.tamanho_id : data.tamanho_id;
        await validarTamanhoNaGrade(produtoId, tamanhoRaw === null || tamanhoRaw === undefined || tamanhoRaw === '' ? null : Number(tamanhoRaw), tx, escopo);
        await ensureUniqueStock(data, before, tx, escopo);
        await garantirSaldoNaoNegativo(data, before);
      }
      if (r.key === 'movimentacoes') throw new HttpError(405, 'Movimentações são imutáveis. Faça o lançamento inverso.');
      if (r.key === 'movimentacoes_insumos') throw new HttpError(405, 'Movimentações de insumos são imutáveis. Faça o lançamento inverso.');
      if (r.key === 'inventarios') await validarUpdateInventario(data, before);
      // Idem criação: editar à mão criaria uma NF-e "emitida" que não existe.
      if (r.key === 'vendas') {
        for (const k of ['nfe_status', 'nfe_numero', 'nfe_emitida_em', 'nfe_provider']) delete data[k];
        // E4.2.1: se o texto `local_saida` mudar, o ID canônico é zerado e o faturamento
        // passa a usar o texto digitado. O ID em si não é editável: `local_saida_id` é
        // readonly/form:false no recurso e writableFields() o remove do payload.
        if (data.local_saida !== undefined && String(data.local_saida ?? '').trim() !== String(before.local_saida ?? '').trim()) {
          data.local_saida_id = null;
        }
        // Fase 3B: ao tentar faturar acima da alçada, encaminha para a fila em
        // vez de confiar no cliente ou simplesmente perder o trabalho digitado.
        if (['faturada', 'entregue'].includes(String(data.status || '')) && !podeComercial(actor, 'aprovar')) {
          const total = Number(before.total || 0);
          const desconto = Number(data.desconto ?? before.desconto ?? 0);
          const descontoPct = total > 0 ? (desconto / (total + desconto)) * 100 : 0;
          const limiteValor = actor.venda_sem_aprovacao_ate == null ? (actor.perfil === 'gerente' ? Infinity : 0) : Number(actor.venda_sem_aprovacao_ate);
          const limiteDesconto = actor.desconto_max_pct == null ? (actor.perfil === 'gerente' ? 100 : 0) : Number(actor.desconto_max_pct);
          if (total > limiteValor || descontoPct > limiteDesconto) {
            data.status = 'pendente_aprovacao';
            data.observacoes = [String(data.observacoes ?? before.observacoes ?? '').trim(), `Aguardando aprovação: alçada de ${actor.name} excedida.`].filter(Boolean).join('\n');
          }
        }
      }
      let renomeouLocal = false;
      if (r.key === 'locais') {
        renomeouLocal = await validarRenomeLocal(data, before, actor, tx, escopo);
        await ensureLocalPadraoUnico(data, before, tx, escopo);
      }
      if (r.key === 'estoque_insumos') {
        // Único campo editável diretamente: estoque mínimo.
        const extra = Object.keys(data).filter((k) => k !== 'estoque_min' && k !== 'atualizado_em');
        if (extra.length) {
          throw new HttpError(400, 'O saldo do insumo só muda por movimentações (compra, ajuste ou consumo de OP). Apenas o estoque mínimo pode ser editado aqui.', { quantidade: 'Use uma movimentação de insumo' });
        }
      }
      if (r.key === 'ordens') await validarOrdemPayload(data, before);
      // Lançamento: edição de valor/taxa recalcula o líquido
      if (r.key === 'lancamentos_financeiros') hookTaxaLancamento(data, before);
      if (r.key === 'categorias_financeiras') await validarCategoriaPai(r, data, before, tx);
      if (r.key === 'transferencias_financeiras') {
        const origem = Number(data.conta_origem_id ?? before.conta_origem_id ?? 0);
        const destino = Number(data.conta_destino_id ?? before.conta_destino_id ?? 0);
        if (origem && destino && origem === destino) {
          throw new HttpError(400, 'Origem e destino precisam ser contas diferentes.', { conta_destino_id: 'Escolha outra conta' });
        }
      }

      const gradeTamanhos = r.key === 'grades' && data.tamanhos !== undefined ? ((data.tamanhos as number[]) || []) : null;
      if (gradeTamanhos) delete data.tamanhos;

      const changes = diff(before, data);
      const mudouGrade = gradeTamanhos !== null;
      if (!Object.keys(changes).length && !mudouGrade) return (await s.get(r, id, tx))!;

      const row = await s.update(r, id, data, tx);
      if (!row) throw new HttpError(404, `${r.singular} não encontrado(a).`);
      if (mudouGrade) await syncGradeTamanhos(id, gradeTamanhos, tx);

      // Usuários: desativação/reativação/troca de perfil têm efeitos de segurança.
      if (r.key === 'usuarios') {
        await aplicarEfeitosUsuario(before, row, data, actor, tx);
      }

      if (r.key === 'locais') {
        await garantirLocalPadrao(tx, escopo);
        // Local renomeado: propaga o novo nome para saldos, movimentações,
        // inventários e vendas que guardavam o nome antigo como texto.
        if (renomeouLocal) await propagarRenomeLocal(before, String(data.nome), tx);
      }

      // Estoque: alteração manual de quantidade vira movimentação de ajuste
      if (r.key === 'estoques' && changes.quantidade) {
        const delta = Number(row.quantidade) - Number(before.quantidade);
        if (delta !== 0) {
          await s.insert(getResource('movimentacoes')!, { empresa_id: escopo.empresaId, tipo: 'ajuste', produto_id: row.produto_id, tamanho_id: row.tamanho_id, local: row.local, local_id: row.local_id ?? null, quantidade: delta, motivo: 'Ajuste manual pelo Estoque Físico', usuario_id: actor.id || null }, tx);
        }
      }
      // Ordem concluída/reaberta: entrada/estorno no estoque + consumo de insumos
      if (r.key === 'ordens' && changes.status) {
        const full = (await s.get(r, id, tx)) ?? row;
        await aplicarRegrasOrdem(before, full, data, { id: actor.id || null, name: actor.name, perfil: actor.perfil }, tx, escopo, opts);
      }
      // Ficha técnica: recalcula custo/preço sugerido (mão de obra, indiretos, margem)
      if (r.key === 'fichas' && (changes.mao_obra || changes.custos_indiretos || changes.margem_pct || changes.produto_id)) {
        await recalcularFichaValores(id, tx, escopo);
      }
      // Vendas/Compras: faturamento/baixa de estoque, recebimento/custo médio e estornos
      if (r.key === 'vendas' || r.key === 'compras') {
        const full = (await s.get(r, id, tx)) ?? row;
        await aplicarRegrasPedido(r.key === 'vendas' ? 'venda' : 'compra', before, full, data, { id: actor.id || null, name: actor.name }, tx, escopo);
        await (r.key === 'vendas' ? syncLancamentoVenda : syncLancamentoCompra)(before, full, data, { id: actor.id || null, name: actor.name }, tx);
      }
      // Aporte confirmado/estornado → lançamento financeiro automático
      if (r.key === 'aportes' && (changes.status || changes.valor || changes.investidor_id || changes.conta_id || changes.forma_pagamento || changes.data)) {
        const full = (await s.get(r, id, tx)) ?? row;
        await syncAporte(before, full, actor, tx);
      }
      // Transferência editada/cancelada → atualiza o par espelho no livro-caixa
      if (r.key === 'transferencias_financeiras') {
        const full = (await s.get(r, id, tx)) ?? row;
        await syncTransferencia(before, full, actor, tx);
      }

      const campos = Object.keys(changes).join(', ');
      const descricao =
        r.key === 'locais' && renomeouLocal
          ? `${r.singular} "${String(before.nome)}" renomeado para "${String(data.nome)}" (saldos, movimentações, inventários e vendas atualizados com o novo nome)`
          : `${r.singular} ${labelOf(r, row)} alterado(a) (${campos})`;
      await audit(tx, actor, 'editar', r, id, descricao, changes, before);
      const final = (await s.get(r, id, tx)) ?? row;
      await attachGradeTamanhos(r, [final], tx);
      return final;
    });
  } catch (e) {
    throw toHttpError(e, r);
  }
}

export async function deleteRecord(r: Resource, id: number, actor: Actor, escopoOpt?: EscopoOuAtor): Promise<void> {
  const s = getStore();
  const escopo = escopoOpt === undefined ? escopoDe(actor) : (comoEscopo(escopoOpt) ?? escopoDeSistema());
  try {
    await s.transaction(async (tx) => {
      const filtroAntes = temEscopoEmpresa(r) ? { id, empresa_id: escopo.empresaId } : { id };
      const before = await s.findOneWhere(r, filtroAntes, tx);
      if (!before) throw new HttpError(404, `${r.singular} não encontrado(a).`);
      assertRegistroDaEmpresaParaEscrita(r, before, escopo);

      if (r.key === 'usuarios') {
        if (Number(before.id) === Number(actor.id)) throw new HttpError(400, 'Você não pode excluir o seu próprio usuário.');
        await ensureNotLastAdmin(before, { ativo: false, perfil: 'x' }, tx);
        // Conta que já foi usada não é apagada: a trilha de auditoria precisa
        // dela. Desative em vez de excluir. Só contas virgens — que nunca
        // acessaram, nunca agiram no sistema e nunca tiveram senha definida
        // (convite pendente, ex.: cadastro duplicado por engano) — podem ser
        // excluídas. Os eventos de criação/convite permanecem na trilha.
        const temLogin = !!before.ultimo_login;
        const teveSenha = !!before.senha_definida_em;
        const eventosProprios = await s.countWhere(getResource('auditoria')!, { usuario_id: Number(before.id) }, tx);
        if (temLogin || teveSenha || eventosProprios > 0) {
          const detalhe = temLogin ? ', com acessos registrados' : teveSenha ? ', com credenciais emitidas' : '';
          throw new HttpError(
            409,
            `“${String(before.nome || before.email)}” já tem histórico no sistema (${eventosProprios} evento(s) próprio(s)${detalhe}) e não pode ser excluído(a) — a trilha de auditoria depende deste registro. Desative a conta em vez disso.`
          );
        }
      }
      let usoLocal: UsoLocal | null = null;
      if (r.key === 'locais') {
        // A decisão é do administrador: o local pode ser excluído mesmo que o
        // sistema o use (saldos, movimentações, inventários) — o histórico não é
        // apagado, apenas o vínculo (FK) e o registro do cadastro. Gerente só
        // pode excluir local sem uso e que não seja o último local ativo.
        usoLocal = await usoDoLocal(before, tx);
        const ativos = await s.list(r, { page: 1, pageSize: 1000, filter: { ativo: true } }, tx);
        const ehUltimoAtivo = ativos.rows.length <= 1 && Number(ativos.rows[0]?.id) === Number(before.id);
        if ((usoLocal.emUso || ehUltimoAtivo) && actor.perfil !== 'admin') {
          throw new HttpError(
            403,
            usoLocal.emUso
              ? `O local "${String(before.nome)}" está em uso (${usoLocal.saldos} saldo(s), ${usoLocal.movimentacoes} movimentação(ões), ${usoLocal.inventarios} inventário(s)). Excluí-lo é uma decisão do administrador.`
              : 'Este é o único local ativo. Excluí-lo é uma decisão do administrador.'
          );
        }
        // Desfaz os vínculos de chave estrangeira: saldos, movimentações e
        // inventários continuam com o nome do local como histórico em texto.
        await desvincularLocal(before, tx);
      }
      if (r.key === 'ordens' && before.status === 'concluida') {
        throw new HttpError(409, 'Ordem concluída já deu entrada no estoque. Reabra ou cancele em vez de excluir.');
      }
      // Integridade do histórico financeiro: cadastros em uso se desativam,
      // não se excluem (a trilha de auditoria e o saldo dependem deles).
      if (r.key === 'contas_financeiras') {
        const emUso =
          (await s.countWhere(getResource('lancamentos_financeiros')!, { conta_id: id }, tx)) +
          (await s.countWhere(getResource('transferencias_financeiras')!, { conta_origem_id: id }, tx)) +
          (await s.countWhere(getResource('transferencias_financeiras')!, { conta_destino_id: id }, tx)) +
          (await s.countWhere(getResource('recorrencias_financeiras')!, { conta_id: id }, tx)) +
          (await s.countWhere(getResource('aportes')!, { conta_id: id }, tx)) +
          (await s.countWhere(getResource('vendas')!, { fin_conta_id: id }, tx)) +
          (await s.countWhere(getResource('compras')!, { fin_conta_id: id }, tx));
        if (emUso > 0) {
          throw new HttpError(409, `A conta "${String(before.nome)}" está em uso por ${emUso} registro(s) de lançamentos, transferências, vendas/compras, aportes ou recorrências. Desative-a em vez de excluir — o histórico financeiro depende dela.`);
        }
      }
      if (r.key === 'categorias_financeiras') {
        const filhas = await s.countWhere(r, { pai_id: id }, tx);
        const emUso =
          (await s.countWhere(getResource('lancamentos_financeiros')!, { categoria_id: id }, tx)) +
          (await s.countWhere(getResource('recorrencias_financeiras')!, { categoria_id: id }, tx));
        if (filhas > 0 || emUso > 0) {
          const motivo = filhas > 0 ? `${filhas} subcategoria(s)` : `${emUso} lançamento(s)/recorrência(s)`;
          throw new HttpError(409, `A categoria "${String(before.nome)}" está em uso por ${motivo}. Desative-a em vez de excluir — o histórico financeiro depende dela.`);
        }
      }
      if (r.key === 'centros_custo') {
        const emUso =
          (await s.countWhere(getResource('lancamentos_financeiros')!, { centro_custo_id: id }, tx)) +
          (await s.countWhere(getResource('recorrencias_financeiras')!, { centro_custo_id: id }, tx));
        if (emUso > 0) {
          throw new HttpError(409, `O centro de custo "${String(before.nome)}" está em uso por ${emUso} lançamento(s)/recorrência(s). Desative-o em vez de excluir.`);
        }
      }
      if (r.key === 'transferencias_financeiras' && String(before.status) !== 'cancelado') {
        throw new HttpError(409, 'Transferência confirmada já movimentou as contas. Cancele-a (o par é estornado preservando o histórico) em vez de excluir.');
      }
      if (r.key === 'vendas' && ['faturada', 'entregue'].includes(String(before.status))) {
        throw new HttpError(409, 'Pedido faturado já baixou o estoque. Cancele o pedido (estorna automaticamente) em vez de excluí-lo.');
      }
      if (r.key === 'compras' && before.status === 'recebido') {
        throw new HttpError(409, 'Compra recebida já deu entrada nos insumos. Cancele a compra (estorna automaticamente) em vez de excluí-la.');
      }
      // Remove os itens do pedido junto (no Postgres o ON DELETE CASCADE faz;
      // aqui garantimos o mesmo comportamento no modo demonstração).
      const filhos: { r: Resource; col: string }[] = [];
      if (r.key === 'vendas' || r.key === 'compras') {
        filhos.push({ r: getResource(r.key === 'vendas' ? 'itens_venda' : 'itens_compra')!, col: r.key === 'vendas' ? 'venda_id' : 'compra_id' });
      }
      if (r.key === 'ordens') filhos.push({ r: getResource('itens_ordem')!, col: 'ordem_id' });
      if (r.key === 'fichas') filhos.push({ r: getResource('itens_ficha_tecnica')!, col: 'ficha_id' });
      for (const filho of filhos) {
        const itens = await s.list(filho.r, { page: 1, pageSize: 1000, filter: { [filho.col]: id } }, tx);
        for (const it of itens.rows) await s.remove(filho.r, Number(it.id), tx);
      }
      if (r.key === 'estoques' && Number(before.quantidade) !== 0) {
        throw new HttpError(409, 'Só é possível excluir saldos zerados. Lance uma saída/ajuste antes.');
      }
      if (r.key === 'grades') {
        // Grade em uso por categoria ou produto não pode ser excluída.
        const [emCategorias, emProdutos] = await Promise.all([
          s.countWhere(getResource('categorias')!, { grade_id: id }, tx),
          s.countWhere(getResource('produtos')!, { grade_id: id }, tx),
        ]);
        if (emCategorias || emProdutos) {
          throw new HttpError(
            409,
            `A grade "${String(before.nome)}" está em uso (${emCategorias} categoria(s) e ${emProdutos} produto(s)). Remova o vínculo antes de excluir.`
          );
        }
        // Remove os tamanhos da grade (no Postgres o ON DELETE CASCADE já faz;
        // aqui garantimos o mesmo no modo demonstração).
        const itensGrade = await s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 1000, filter: { grade_id: id } }, tx);
        for (const it of itensGrade.rows) await s.remove(RESOURCES.grade_tamanhos, Number(it.id), tx);
      }

      await removeAllFiles(r, id, tx);
      const ok = await s.remove(r, id, tx);
      if (!ok) throw new HttpError(404, `${r.singular} não encontrado(a).`);
      if (r.key === 'locais') await garantirLocalPadrao(tx, escopo);
      const detalheUso =
        usoLocal?.emUso
          ? ` — em uso na exclusão: ${usoLocal.saldos} saldo(s), ${usoLocal.movimentacoes} movimentação(ões), ${usoLocal.inventarios} inventário(s) (histórico preservado com o nome do local)`
          : '';
      await audit(tx, actor, 'excluir', r, id, `${r.singular} ${labelOf(r, before)} excluído(a)${detalheUso}`, sanitize(before), before);
    });
  } catch (e) {
    throw toHttpError(e, r);
  }
}

// ----------------------------------------------------------------------------
// Regras específicas
// ----------------------------------------------------------------------------
function sanitize(row: Row | Payload): Row {
  const out: Row = { ...row };
  delete out.senha;
  delete out.senha_hash;
  delete out.mfa_secret;
  delete out.convite_token_hash;
  delete out.reset_token_hash;
  return out;
}

/** Fraquezas de senha conhecidas (política da Fase 6). */
const SENHAS_FRACAS = ['123456', '12345678', '123456789', '1234567890', 'senha', 'senha123', 'password', 'password123', 'qwerty', 'abc123', 'brobond', 'brobond123', 'admin', 'administrador', 'lojinha', 'brasil', 'batata'];

/** Política de senha: mínimo 8, ≠ e-mail, fora da lista de senhas óbvias. */
export function validarPoliticaSenha(senha: string, email?: string): string | null {
  if (!senha) return 'Informe uma senha.';
  if (senha.length < 8) return 'A senha deve ter pelo menos 8 caracteres.';
  const lower = senha.toLowerCase();
  if (email && lower === String(email || '').trim().toLowerCase()) return 'A senha não pode ser igual ao e-mail.';
  const parteEmail = String(email || '').split('@')[0].toLowerCase();
  if (parteEmail.length >= 4 && lower.includes(parteEmail)) return 'A senha não pode conter o e-mail.';
  if (SENHAS_FRACAS.includes(lower) || /^(.)\1{6,}$/.test(lower)) return 'Escolha uma senha menos óbvia.';
  return null;
}

async function prepareUserPayload(data: Payload, before: Row | null, actor: Actor) {
  const { invalidateUserCache } = await import('./auth');
  // A senha NUNCA é digitada pelo admin no cadastro/edição: novos usuários
  // recebem um convite por e-mail e o admin pode gerar senha temporária de
  // exibição única (endpoint próprio). Qualquer `senha` no payload é rejeitada.
  if (typeof data.senha === 'string' && data.senha.length > 0) {
    throw new HttpError(400, 'Senhas não são mais definidas neste formulário: convide o usuário por e-mail ou use "Gerar senha temporária" (exibição única).');
  }
  delete data.senha;

  if (!before) {
    // Rastreabilidade: quem criou a conta.
    (data as Record<string, unknown>).criado_por = actor.id || null;
    return;
  }

  if (Number(before.id) === Number(actor.id)) {
    if (data.ativo === false) throw new HttpError(400, 'Você não pode desativar o seu próprio usuário.');
    if (data.perfil && data.perfil !== 'admin') throw new HttpError(400, 'Você não pode remover o seu próprio perfil de administrador.');
  }
  await ensureNotLastAdmin(before, data, null);
  invalidateUserCache(Number(before.id));
}

/**
 * Efeitos colaterais da edição de um usuário (via CRUD genérico):
 *   • desativação → carimba trilha (quando/por quem), derruba TODAS as sessões
 *     e invalida os tokens (bump de token_versao);
 *   • reativação → limpa trilha de desativação, bloqueio e falhas;
 *   • troca de perfil → derruba as sessões (o novo perfil passa a valer no
 *     próximo login, sem janela de permissão antiga).
 */
async function aplicarEfeitosUsuario(before: Row, row: Row, data: Payload, actor: Actor, tx: Tx): Promise<void> {
  const s = getStore();
  const r = getResource('usuarios')!;
  const { revogarTodas } = await import('./sessoes');
  const { invalidateUserCache } = await import('./auth');
  const id = Number(row.id);

  const desativou = before.ativo !== false && row.ativo === false;
  const reativou = before.ativo === false && row.ativo !== false;
  const perfilMudou = data.perfil !== undefined && data.perfil !== null && String(data.perfil) !== String(before.perfil);

  if (desativou) {
    const patch: Record<string, unknown> = { token_versao: Number(row.token_versao || 0) + 1 };
    if (!row.desativado_em) patch.desativado_em = new Date().toISOString();
    if (!row.desativado_por) patch.desativado_por = actor.name;
    await s.update(r, id, patch, tx);
    const sessoes = await revogarTodas(id);
    await s.audit(
      {
        usuario_id: actor.id || null,
        usuario: actor.name,
        acao: 'seguranca',
        recurso: 'usuarios',
        registro_id: id,
        descricao: `${String(before.nome || before.email)} DESATIVADO por ${actor.name}${sessoes ? ` — ${sessoes} sessão(ões) encerrada(s)` : ''}`,
        dados: { sessoes_encerradas: sessoes },
        empresa_id: empresaDoAtorAudit(actor),
      },
      tx
    );
  }
  if (reativou) {
    await s.update(
      r,
      id,
      {
        desativado_por: null,
        desativado_em: null,
        desativado_motivo: null,
        bloqueado_ate: null,
        motivo_bloqueio: null,
        tentativas_falhas: 0,
        ultimo_falha_em: null,
      },
      tx
    );
    await s.audit(
      {
        usuario_id: actor.id || null,
        usuario: actor.name,
        acao: 'seguranca',
        recurso: 'usuarios',
        registro_id: id,
        descricao: `${String(before.nome || before.email)} REATIVADO por ${actor.name}`,
        empresa_id: empresaDoAtorAudit(actor),
      },
      tx
    );
  }
  if (perfilMudou && !desativou) {
    const atual = (await s.findOneWhere(r, { id }, tx)) ?? row;
    await s.update(r, id, { token_versao: Number(atual.token_versao || 0) + 1 }, tx);
    const sessoes = await revogarTodas(id);
    await s.audit(
      {
        usuario_id: actor.id || null,
        usuario: actor.name,
        acao: 'seguranca',
        recurso: 'usuarios',
        registro_id: id,
        descricao: `Perfil de ${String(before.nome || before.email)} alterado de "${String(before.perfil)}" para "${String(data.perfil)}" por ${actor.name} — sessões encerradas (${sessoes}), novo perfil vale no próximo login`,
        dados: { de: before.perfil, para: data.perfil, sessoes_encerradas: sessoes },
        empresa_id: empresaDoAtorAudit(actor),
      },
      tx
    );
  }
  if (desativou || reativou || perfilMudou) invalidateUserCache(id);
}


function prepararPoliticaComercial(data: Payload, before: Row | null) {
  const p = { ...(before || {}), ...data };
  const escopo = String(p.escopo || 'geral');
  const exigido: Record<string, string> = { canal: 'canal', colecao: 'colecao_id', catalogo: 'catalogo_id', cliente: 'cliente_id' };
  const campo = exigido[escopo];
  if (campo && !p[campo]) throw new HttpError(400, `Informe ${campo.replace('_id', '')} para o escopo selecionado.`, { [campo]: 'Campo obrigatório neste escopo' });
  if (p.inicio_em && p.fim_em && String(p.inicio_em).slice(0, 10) > String(p.fim_em).slice(0, 10)) throw new HttpError(400, 'O início da vigência não pode ser posterior ao fim.', { fim_em: 'Data anterior ao início' });
  if (Number(p.multiplo_qtd || 1) < 1) throw new HttpError(400, 'O múltiplo deve ser ao menos 1.', { multiplo_qtd: 'Mínimo 1' });
}

async function prepareCatalogosPayload(data: Payload, before: Row | null, _actor: Actor) {
  const { hashPassword } = await import('./auth');
  const senha = typeof data.senha === 'string' ? data.senha : '';
  if (senha) {
    const erro = validarPoliticaSenha(senha, '');
    if (erro) throw new HttpError(400, `Senha do catálogo: ${erro}`, { senha: erro });
    data.senha_hash = await hashPassword(senha);
  }
  delete data.senha;
  if (!before) {
    data.token = randomBytes(12).toString('hex');
  }
}

async function ensureNotLastAdmin(before: Row, data: Payload, tx: Tx) {
  const losingAdmin = before.perfil === 'admin' && before.ativo !== false && ((data.perfil !== undefined && data.perfil !== 'admin') || data.ativo === false);
  if (!losingAdmin) return;
  const s = getStore();
  const usuarios = getResource('usuarios')!;
  const admins = await s.list(usuarios, { page: 1, pageSize: 1000 }, tx ?? undefined);
  const others = admins.rows.filter((u) => u.perfil === 'admin' && u.ativo !== false && Number(u.id) !== Number(before.id));
  if (!others.length) throw new HttpError(400, 'Este é o único administrador ativo. Cadastre outro administrador antes.');
}

/**
 * Espelha no código a constraint `estoques_quantidade_nao_negativo` (Postgres):
 * no modo demonstração não há banco para segurar, e um saldo negativo editado à
 * mão invalidaria tudo que a matriz de estoque mostra.
 */
async function garantirSaldoNaoNegativo(data: Payload, before: Row | null): Promise<void> {
  if (data.quantidade === undefined || data.quantidade === null) return;
  const qtd = Number(data.quantidade);
  if (!Number.isFinite(qtd)) return; // a validação de tipo cuida disso
  if (qtd < 0) {
    const local = String(data.local ?? before?.local ?? 'estoque');
    throw new HttpError(
      400,
      `O saldo não pode ser negativo. Para lançar uma diferença de contagem use uma Saída ou um Ajuste em "${local}".`,
      { quantidade: 'Saldo não pode ser negativo' }
    );
  }
}

export async function ensureUniqueStock(data: Payload, before: Row | null, tx: Tx, escopo: EscopoEmpresa) {
  const merged = { ...(before || {}), ...data };
  if (!merged.produto_id) return;
  const s = getStore();
  const base = {
    empresa_id: escopo.empresaId,
    produto_id: Number(merged.produto_id),
    tamanho_id: merged.tamanho_id ?? null,
  };
  const localId = merged.local_id === null || merged.local_id === undefined || merged.local_id === '' ? null : Number(merged.local_id);
  const filtroCanonico = localId === null ? null : { ...base, local_id: localId };
  const filtroLegado = { ...base, local: String(merged.local), local_id: null };
  const canonicos = filtroCanonico ? await s.countWhere(getResource('estoques')!, filtroCanonico, tx ?? undefined) : 0;
  const legados = await s.countWhere(getResource('estoques')!, filtroLegado, tx ?? undefined);
  if (canonicos + legados > 1) throw new HttpError(409, 'Há saldos históricos duplicados para este produto/tamanho/local. Nada foi alterado; corrija as duplicidades primeiro.');
  const filtroExistente = canonicos ? filtroCanonico! : filtroLegado;
  const existing = canonicos + legados ? await s.findOneWhere(getResource('estoques')!, filtroExistente, tx ?? undefined) : null;
  if (canonicos + legados === 1 && !existing) throw new HttpError(409, 'Não foi possível identificar o saldo de estoque com segurança.');
  if (existing && (!before || Number(existing.id) !== Number(before.id))) {
    throw new HttpError(409, 'Já existe saldo para este produto, tamanho e local. Edite o registro existente ou lance uma movimentação.');
  }
  if (existing && (Number(existing.local_id || 0) !== Number(localId || 0) || String(existing.local || '') !== String(merged.local || ''))) {
    throw new HttpError(409, 'O saldo possui vínculo canônico de local ausente ou inconsistente. Nada foi alterado; revise os dados antes de continuar.');
  }
}

/** Nome do Local padrão da empresa ativa. Não há fallback global por nome. */
export async function getDefaultLocal(tx: Tx | undefined, escopo: EscopoEmpresa): Promise<string> {
  const info = await getDefaultLocalInfo(tx, escopo);
  if (!info) throw new HttpError(409, 'A empresa ativa não possui um local de estoque ativo. Cadastre um local antes de movimentar o estoque.');
  return info.nome;
}

/** Resolve o Local padrão (ou o primeiro ativo) somente dentro da empresa ativa. */
export async function getDefaultLocalInfo(
  tx: Tx | undefined,
  escopo: EscopoEmpresa
): Promise<{ id: number; nome: string } | null> {
  const s = getStore();
  const r = getResource('locais')!;
  const empresa_id = escopo.empresaId;
  const padroes = await s.list(r, { page: 1, pageSize: 2, filter: { empresa_id, padrao: true } }, tx ?? undefined);
  if (padroes.total > 1) {
    throw new HttpError(409, 'A empresa ativa possui mais de um local padrão. Corrija a configuração antes de movimentar o estoque.');
  }
  const padrao = padroes.rows[0];
  if (padrao) {
    if (!ativoYn(padrao)) throw new HttpError(409, 'O local padrão da empresa ativa está inativo. Escolha um local padrão ativo antes de movimentar o estoque.');
    return { id: Number(padrao.id), nome: String(padrao.nome) };
  }
  const ativos = await s.list(r, {
    page: 1,
    pageSize: 2,
    sort: 'nome',
    dir: 'asc',
    filter: { empresa_id, ativo: true },
  }, tx ?? undefined);
  if (ativos.total > 1) {
    throw new HttpError(409, 'A empresa ativa não possui um local padrão único. Defina o local padrão antes de movimentar o estoque.');
  }
  if (ativos.rows.length === 1) return { id: Number(ativos.rows[0].id), nome: String(ativos.rows[0].nome) };
  return null;
}

function ativoYn(row: Row): boolean {
  const v = row.ativo;
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'TRUE' || v === 'on' || v === 'sim';
}

/** Ao marcar um local como padrão, desmarca os demais da mesma empresa. */
async function ensureLocalPadraoUnico(data: Payload, before: Row | null, tx: Tx, escopo: EscopoEmpresa): Promise<void> {
  if (data.padrao !== true) return;
  const s = getStore();
  const r = getResource('locais')!;
  const demais = await s.list(r, {
    page: 1,
    pageSize: 1000,
    filter: { empresa_id: escopo.empresaId, padrao: true },
  }, tx ?? undefined);
  if (demais.total > demais.rows.length) throw new HttpError(409, 'Há mais locais padrão que o limite de leitura segura. Corrija a configuração antes de continuar.');
  for (const l of demais.rows) {
    if (!before || Number(l.id) !== Number(before.id)) {
      await s.update(r, Number(l.id), { padrao: false }, tx);
    }
  }
}

/** Mantém um padrão ativo independente em cada empresa. */
async function garantirLocalPadrao(tx: Tx, escopo: EscopoEmpresa): Promise<void> {
  const s = getStore();
  const r = getResource('locais')!;
  const filtroPadrao = { empresa_id: escopo.empresaId, padrao: true };
  const totalPadroes = await s.countWhere(r, filtroPadrao, tx ?? undefined);
  if (totalPadroes > 1) throw new HttpError(409, 'Há mais de um local padrão nesta empresa. Corrija a configuração antes de continuar.');
  const padrao = await s.findOneWhere(r, filtroPadrao, tx ?? undefined);
  if (padrao && ativoYn(padrao)) return;
  const ativos = await s.list(r, {
    page: 1,
    pageSize: 1,
    sort: 'nome',
    dir: 'asc',
    filter: { empresa_id: escopo.empresaId, ativo: true },
  }, tx ?? undefined);
  if (!ativos.rows.length) return;
  await s.update(r, Number(ativos.rows[0].id), { padrao: true }, tx);
}

// ----------------------------------------------------------------------------
// Locais de estoque: gestão livre — a decisão é do administrador
// ----------------------------------------------------------------------------
// O local NÃO fica preso ao sistema: pode ser incluído, alterado e excluído
// mesmo quando já está em uso (saldos, movimentações, inventários, vendas).
//   • Renomear propaga o novo nome para todo o sistema (o nome do local é a
//     chave de texto do estoque).
//   • Excluir desfaz apenas os vínculos (chaves estrangeiras); o histórico
//     permanece com o nome do local como texto — nada é apagado.
// Gerente mantém o acesso normal, mas excluir/renomear local EM USO (ou excluir
// o último local ativo) é decisão exclusiva do administrador.

export type UsoLocal = { saldos: number; movimentacoes: number; inventarios: number; emUso: boolean };

/** Conta apenas vínculos por ID canônico; texto legado ambíguo não é atribuído a nenhum local. */
async function contarVinculos(r: Resource, colId: string, id: number, tx?: Tx): Promise<number> {
  return getStore().countWhere(r, { [colId]: id }, tx);
}

/** Quantos saldos, movimentações e inventários apontam para o ID deste local. */
export async function usoDoLocal(local: Row, tx?: Tx): Promise<UsoLocal> {
  const id = Number(local.id);
  const saldos = await contarVinculos(getResource('estoques')!, 'local_id', id, tx);
  const movOrigem = await contarVinculos(getResource('movimentacoes')!, 'local_id', id, tx);
  const movDestino = await contarVinculos(getResource('movimentacoes')!, 'local_destino_id', id, tx);
  const inventarios = await contarVinculos(getResource('inventarios')!, 'local_id', id, tx);
  const movimentacoes = movOrigem + movDestino;
  return { saldos, movimentacoes, inventarios, emUso: saldos + movimentacoes + inventarios > 0 };
}

/** Anota cada local com o uso (a UI usa isso para avisar antes de excluir/renomear). */
async function anotarUsoLocal(r: Resource, rows: Row[]): Promise<void> {
  if (r.key !== 'locais' || !rows.length) return;
  const s = getStore();
  for (const row of rows) {
    const uso = await usoDoLocal(row);
    const ativos = await s.list(r, {
      page: 1,
      pageSize: 1,
      filter: { empresa_id: Number(row.empresa_id), ativo: true },
    });
    row.em_uso = uso.emUso;
    row.uso_saldos = uso.saldos;
    row.uso_movimentacoes = uso.movimentacoes;
    row.uso_inventarios = uso.inventarios;
    row.eh_ultimo_ativo = ativoYn(row) && ativos.total <= 1;
  }
}

/**
 * Valida a alteração de nome de um local. Retorna true quando o nome muda.
 * Local em uso só o administrador renomeia; o nome novo não pode colidir com
 * outro local nem com saldos já gravados (chave produto+tamanho+local).
 */
async function validarRenomeLocal(data: Payload, before: Row, actor: Actor, tx: Tx, escopo: EscopoEmpresa): Promise<boolean> {
  if (data.nome === undefined || data.nome === null) return false;
  const novo = String(data.nome).trim();
  const antigo = String(before.nome || '');
  if (!novo || novo === antigo) return false;
  const s = getStore();
  const uso = await usoDoLocal(before, tx);
  if (uso.emUso && actor.perfil !== 'admin') {
    throw new HttpError(
      403,
      `O local "${antigo}" está em uso (${uso.saldos} saldo(s), ${uso.movimentacoes} movimentação(ões), ${uso.inventarios} inventário(s)). Renomeá-lo é uma decisão do administrador.`
    );
  }
  const outro = await s.findOneWhere(getResource('locais')!, { nome: novo, empresa_id: escopo.empresaId }, tx);
  if (outro && Number(outro.id) !== Number(before.id)) {
    throw new HttpError(409, `Já existe outro local chamado "${novo}" nesta empresa.`, { nome: 'Nome já cadastrado' });
  }
  const colisao = await s.countWhere(getResource('estoques')!, { empresa_id: escopo.empresaId, local: novo }, tx);
  if (colisao > 0) {
    throw new HttpError(409, `Já existem saldos de estoque gravados com o nome "${novo}" nesta empresa. Escolha outro nome para não misturar os estoques.`, { nome: 'Conflito com saldos existentes' });
  }
  return true;
}

/** Propaga o nome apenas pelos vínculos canônicos deste ID e dentro da empresa. */
async function propagarRenomeLocal(before: Row, novo: string, tx: Tx): Promise<void> {
  const id = Number(before.id);
  const empresa_id = Number(before.empresa_id);
  await renomearOnde(getResource('estoques')!, 'local', 'local_id', id, novo, tx);
  await renomearOnde(getResource('movimentacoes')!, 'local', 'local_id', id, novo, tx);
  await renomearOnde(getResource('movimentacoes')!, 'local_destino', 'local_destino_id', id, novo, tx);
  await renomearOnde(getResource('inventarios')!, 'local', 'local_id', id, novo, tx);
  // Vendas históricas guardam somente texto; empresa + nome identificam o local
  // porque o nome é único dentro da empresa. Nenhuma outra empresa é alterada.
  await renomearOnde(getResource('vendas')!, 'local_saida', 'empresa_id', empresa_id, novo, tx, String(before.nome || ''));
}

/** Renomeia em lotes usando ID canônico (ou filtro tenantado para campos legados sem ID). */
async function renomearOnde(
  r: Resource,
  col: string,
  fk: string,
  id: number,
  novo: string,
  tx: Tx,
  legadoAntigo?: string
): Promise<void> {
  const s = getStore();
  const filtro = legadoAntigo === undefined ? { [fk]: id } : { [fk]: id, [col]: legadoAntigo };
  for (;;) {
    const rows = await s.list(r, { page: 1, pageSize: 1000, filter: filtro, sort: 'id', dir: 'asc' }, tx);
    if (!rows.rows.length) break;
    for (const row of rows.rows) await s.update(r, Number(row.id), { [col]: novo }, tx);
    if (rows.rows.length < 1000) break;
  }
}

/**
 * Exclusão com o local em uso: zera as chaves estrangeiras (`*_id`) que apontam
 * para o local. O nome do local permanece nos registros como texto — saldos,
 * movimentações e inventários continuam legíveis e auditáveis.
 */
async function desvincularLocal(local: Row, tx: Tx): Promise<void> {
  const id = Number(local.id);
  await desvincularTodos(getResource('estoques')!, 'local_id', id, tx);
  await desvincularTodos(getResource('movimentacoes')!, 'local_id', id, tx);
  await desvincularTodos(getResource('movimentacoes')!, 'local_destino_id', id, tx);
  await desvincularTodos(getResource('inventarios')!, 'local_id', id, tx);
}

/** Zera a coluna de vínculo em todos os registros que apontam para o local. */
async function desvincularTodos(r: Resource, col: string, id: number, tx: Tx): Promise<void> {
  const s = getStore();
  for (;;) {
    const rows = await s.list(r, { page: 1, pageSize: 1000, filter: { [col]: id }, sort: 'id', dir: 'asc' }, tx);
    if (!rows.rows.length) break;
    for (const row of rows.rows) await s.update(r, Number(row.id), { [col]: null }, tx);
    if (rows.rows.length < 1000) break;
  }
}

/** Resolve texto/ID para um Local canônico da empresa ativa. */
export async function resolveLocal(data: Payload, tx: Tx, escopo: EscopoEmpresa): Promise<void> {
  const s = getStore();
  const locais = getResource('locais')!;
  const rawId = data.local_id;
  const localId = rawId === undefined || rawId === null || rawId === '' ? null : Number(rawId);
  const nomeInformado = data.local === undefined || data.local === null ? '' : String(data.local).trim();
  let local: Row | null = null;

  if (localId !== null) {
    if (!Number.isInteger(localId) || localId <= 0) throw new HttpError(404, 'Local não encontrado.');
    local = await s.findOneWhere(locais, { id: localId, empresa_id: escopo.empresaId }, tx ?? undefined);
    if (!local) throw new HttpError(404, 'Local não encontrado.');
  } else if (nomeInformado) {
    const filtro = { nome: nomeInformado, empresa_id: escopo.empresaId };
    const quantidade = await s.countWhere(locais, filtro, tx ?? undefined);
    if (quantidade > 1) throw new HttpError(409, 'O nome do local não identifica um único local desta empresa. Selecione pelo ID e corrija os cadastros duplicados.');
    local = await s.findOneWhere(locais, filtro, tx ?? undefined);
    if (!local) throw new HttpError(404, 'Local não encontrado. Selecione um local cadastrado da empresa ativa.');
  } else {
    const padrao = await getDefaultLocalInfo(tx, escopo);
    if (!padrao) throw new HttpError(409, 'A empresa ativa não possui um local de estoque ativo. Cadastre um local antes de movimentar o estoque.');
    local = await s.findOneWhere(locais, { id: padrao.id, empresa_id: escopo.empresaId }, tx ?? undefined);
    if (!local) throw new HttpError(404, 'Local não encontrado.');
  }

  if (!ativoYn(local)) throw new HttpError(409, 'O local selecionado está inativo. Escolha um local ativo.');
  data.local_id = Number(local.id);
  data.local = String(local.nome);
}

/** Referências de origem/estorno são gravadas apenas pelos fluxos internos que conhecem a relação entre os registros. */
async function validarReferenciasMovimentacaoManual(r: Resource, data: Payload, escopo: EscopoEmpresa, tx: Tx): Promise<void> {
  const s = getStore();
  await validarReferenciasDaEmpresa(r, data, escopo, (alvo, alvoId, empresaId, t) => s.findOneWhere(alvo, { id: alvoId, empresa_id: empresaId }, t), tx);
  if (r.key === 'movimentacoes' && data.compra_id !== undefined && data.compra_id !== null && data.compra_id !== '') {
    const compraId = Number(data.compra_id);
    if (!Number.isInteger(compraId) || compraId <= 0 || !await s.findOneWhere(getResource('compras')!, { id: compraId, empresa_id: escopo.empresaId }, tx)) {
      throw new HttpError(404, 'Compra não encontrada.');
    }
  }
  const internos = r.key === 'movimentacoes'
    ? ['compra_id', 'recebimento_id', 'item_compra_id', 'ordem_id', 'venda_id', 'movimentacao_estorno_id', 'estornado_em', 'estornado_por']
    : ['compra_id', 'recebimento_id', 'item_compra_id', 'ordem_id'];
  if (internos.some((campo) => data[campo] !== undefined && data[campo] !== null && data[campo] !== '')) {
    throw new HttpError(400, 'Vínculos de compra, produção e estorno são definidos pelo fluxo de origem e não podem ser informados em lançamento manual.');
  }
  if (r.key === 'movimentacoes' && data.estornado === true) {
    throw new HttpError(400, 'O estado de estorno é definido pelo sistema.');
  }
}

/** Movimentação de produtos acabados (entrada/saída/ajuste/transferência). */
async function createMovimentacao(data: Payload, actor: Actor, tx: Tx, escopo: EscopoEmpresa): Promise<Row> {
  const s = getStore();
  const mov = getResource('movimentacoes')!;
  await validarReferenciasMovimentacaoManual(mov, data, escopo, tx);
  const qtd = Number(data.quantidade);
  const tipo = String(data.tipo);

  if (tipo !== 'transferencia' && tipo !== 'ajuste' && qtd <= 0) {
    throw new HttpError(400, 'Para entrada e saída informe uma quantidade maior que zero.', { quantidade: 'Deve ser maior que zero' });
  }
  if (qtd === 0) throw new HttpError(400, 'A quantidade não pode ser zero.', { quantidade: 'Não pode ser zero' });

  await resolveLocal(data, tx, escopo);
  const local = String(data.local);
  const localId = Number(data.local_id);
  const produtoId = Number(data.produto_id);
  const tamanhoId = data.tamanho_id === null || data.tamanho_id === undefined || data.tamanho_id === '' ? null : Number(data.tamanho_id);
  data.tamanho_id = tamanhoId;
  const usuarioId = actor.id || null;

  // Nenhum tamanho fora da grade do produto; produto sem tamanho usa NULL.
  await validarTamanhoNaGrade(produtoId, tamanhoId, tx, escopo);

  // Transferência entre locais: em UMA transação, saída na origem + entrada no
  // destino — duas linhas ligadas por transferencia_id.
  if (tipo === 'transferencia') {
    if (qtd <= 0) throw new HttpError(400, 'Informe uma quantidade maior que zero.', { quantidade: 'Deve ser maior que zero' });
    const rawDest = data.local_destino_id;
    const destId = rawDest === undefined || rawDest === null || rawDest === '' ? null : Number(rawDest);
    if (!destId || !Number.isInteger(destId)) {
      throw new HttpError(400, 'Escolha o local de destino da transferência.', { local_destino_id: 'Campo obrigatório' });
    }
    const destino = await s.findOneWhere(getResource('locais')!, { id: destId, empresa_id: escopo.empresaId }, tx ?? undefined);
    if (!destino) throw new HttpError(404, 'Local de destino não encontrado.');
    if (!ativoYn(destino)) throw new HttpError(409, 'O local de destino está inativo.');
    const localDestino = String(destino.nome);
    if (destId === localId) throw new HttpError(400, 'A origem e o destino da transferência devem ser locais diferentes.', { local_destino_id: 'Escolha outro local' });

    const motivo = data.motivo ? String(data.motivo) : `Transferência para ${localDestino}`;
    // Retira na origem com a condição dentro do próprio UPDATE — ver tryAdjustStock.
    const retirado = await s.tryAdjustStock(produtoId, tamanhoId, local, -qtd, tx, 0, localId, escopo.empresaId);
    if (!retirado) {
      const origem = await s.findOneWhere(getResource('estoques')!, { empresa_id: escopo.empresaId, produto_id: produtoId, tamanho_id: tamanhoId, local }, tx ?? undefined);
      const atual = Number(origem?.quantidade ?? 0);
      throw new HttpError(409, `Saldo insuficiente para transferir: há ${atual} peça(s) em "${local}" e você quer transferir ${qtd}.`, { quantidade: `Saldo atual: ${atual}` });
    }
    const saida = await s.insert(mov, { empresa_id: escopo.empresaId, tipo: 'saida', produto_id: produtoId, tamanho_id: tamanhoId, local, local_id: data.local_id ?? null, local_destino: localDestino, local_destino_id: destId, quantidade: qtd, motivo, usuario_id: usuarioId }, tx);
    await s.insert(mov, { empresa_id: escopo.empresaId, tipo: 'entrada', produto_id: produtoId, tamanho_id: tamanhoId, local: localDestino, local_id: destId, transferencia_id: Number(saida.id), quantidade: qtd, motivo: `Transferência de ${local}`, usuario_id: usuarioId }, tx);
    await s.adjustStock(produtoId, tamanhoId, localDestino, qtd, tx, destId, escopo.empresaId);
    await s.update(mov, Number(saida.id), { transferencia_id: Number(saida.id) }, tx);
    await audit(tx, actor, 'criar', mov, Number(saida.id), `Transferência de ${qtd} un. de "${local}" para "${localDestino}" — ${await produtoTamanhoLabel(produtoId, tamanhoId, tx)}`, sanitize({ ...data, local, local_destino: localDestino }), saida);
    return (await s.get(mov, Number(saida.id), tx)) ?? saida;
  }

  const delta = tipo === 'saida' ? -qtd : qtd;
  if (delta < 0) {
    // O abatimento é a primeira coisa e é condicional na própria escrita: checar
    // o saldo antes e gravar depois deixaria duas vendas concorrentes tirarem a
    // mesma peça (e o saldo virar negativo).
    const aplicado = await s.tryAdjustStock(produtoId, tamanhoId, local, delta, tx, 0, localId, escopo.empresaId);
    if (!aplicado) {
      const saldo = await s.findOneWhere(getResource('estoques')!, { empresa_id: escopo.empresaId, produto_id: produtoId, tamanho_id: tamanhoId, local }, tx ?? undefined);
      const atual = Number(saldo?.quantidade ?? 0);
      throw new HttpError(409, `Saldo insuficiente: há ${atual} peça(s) em "${local}" e a movimentação retiraria ${Math.abs(delta)}.`, { quantidade: `Saldo atual: ${atual}` });
    }
  }

  const row = await s.insert(mov, { ...data, local, local_id: data.local_id ?? null, local_destino: data.local_destino ?? null, local_destino_id: data.local_destino_id ?? null, usuario_id: usuarioId }, tx);
  if (delta > 0) await s.adjustStock(produtoId, tamanhoId, local, delta, tx, localId, escopo.empresaId);
  const full = (await s.get(mov, row.id, tx)) ?? row;
  await audit(tx, actor, 'criar', mov, row.id, `${tipo === 'entrada' ? 'Entrada' : tipo === 'saida' ? 'Saída' : 'Ajuste'} de ${qtd} un. — ${full.produto_id__label ?? '#' + produtoId} ${full.tamanho_id__label ?? ''} (${local})`, sanitize(data), row);
  return full;
}

/** Rótulo "Produto tam. X" para auditoria. */
async function produtoTamanhoLabel(produtoId: number, tamanhoId: number | null, tx?: Tx): Promise<string> {
  const s = getStore();
  const p = await s.findOneWhere(getResource('produtos')!, { id: produtoId }, tx);
  const t = await s.findOneWhere(getResource('tamanhos')!, { id: tamanhoId }, tx);
  const nome = p ? labelOf(getResource('produtos')!, p) : `#${produtoId}`;
  return `${nome}${t ? ` tam. ${t.codigo}` : ''}`.trim();
}

/** Movimentação manual de insumo (módulo Estoque de Insumos). */
async function createMovimentacaoInsumo(data: Payload, actor: Actor, tx: Tx, escopo: EscopoEmpresa): Promise<Row> {
  const s = getStore();
  const mov = getResource('movimentacoes_insumos')!;
  await validarReferenciasMovimentacaoManual(mov, data, escopo, tx);
  const qtd = Number(data.quantidade);
  const tipo = String(data.tipo);
  if (qtd === 0) throw new HttpError(400, 'A quantidade não pode ser zero.', { quantidade: 'Não pode ser zero' });
  if (tipo !== 'ajuste' && qtd <= 0) {
    throw new HttpError(400, 'Para entrada e saída informe uma quantidade maior que zero.', { quantidade: 'Deve ser maior que zero' });
  }
  const insumoId = Number(data.insumo_id);
  if (!Number.isInteger(insumoId) || insumoId <= 0) throw new HttpError(404, 'Insumo não encontrado.');
  const insumo = await s.findOneWhere(getResource('insumos')!, { id: insumoId, empresa_id: escopo.empresaId }, tx);
  if (!insumo) throw new HttpError(404, 'Insumo não encontrado.');
  const delta = tipo === 'saida' ? -qtd : qtd;
  const atual = await s.insumoStock(insumoId, tx, escopo.empresaId);
  if (atual + delta < 0) {
    const nome = labelOf(getResource('insumos')!, insumo);
    throw new HttpError(409, `Saldo insuficiente do insumo: há ${atual} de ${nome} e a movimentação retiraria ${Math.abs(delta)}.`, { quantidade: `Saldo atual: ${atual}` });
  }
  const row = await s.insert(mov, { ...data, empresa_id: escopo.empresaId, usuario_id: actor.id || null }, tx);
  await s.adjustInsumoStock(insumoId, delta, tx, escopo.empresaId);
  const nome = labelOf(getResource('insumos')!, insumo);
  const un = insumo.unidade || 'un';
  await audit(tx, actor, 'criar', mov, row.id, `${tipo === 'entrada' ? 'Entrada' : tipo === 'saida' ? 'Saída' : 'Ajuste'} de ${qtd} ${un} de ${nome}${data.motivo ? ` — ${data.motivo}` : ''}`, sanitize(data), row);
  return row;
}

/** Abrir inventário: congela apenas os saldos da empresa/local canônicos. */
async function abrirInventarioSnapshot(row: Row, actor: Actor, tx: Tx, escopo: EscopoEmpresa) {
  const s = getStore();
  const local = String(row.local);
  const localId = Number(row.local_id);
  if (!Number.isInteger(localId) || localId <= 0 || !await s.findOneWhere(getResource('locais')!, { id: localId, empresa_id: escopo.empresaId }, tx)) {
    throw new HttpError(404, 'Local não encontrado.');
  }
  const rInventarios = getResource('inventarios')!;
  const filtroAberto = { empresa_id: escopo.empresaId, local_id: localId, status: 'aberto' };
  if (await s.countWhere(rInventarios, filtroAberto, tx) > 1) {
    throw new HttpError(409, 'Há mais de um inventário aberto para este local nesta empresa. Revise os dados antes de abrir outro.');
  }
  const aberto = await s.findOneWhere(rInventarios, filtroAberto, tx);
  if (aberto && Number(aberto.id) !== Number(row.id)) {
    throw new HttpError(409, `Já existe um inventário aberto para o local "${local}" nesta empresa. Feche-o antes de abrir outro.`);
  }
  const rEstoques = getResource('estoques')!;
  if (await s.countWhere(rEstoques, { empresa_id: escopo.empresaId, local, local_id: null }, tx) > 0) {
    throw new HttpError(409, 'Há saldos sem vínculo canônico para este local. Nada foi copiado; revise os dados históricos antes de abrir o inventário.');
  }
  const estoques = await s.list(rEstoques, {
    page: 1,
    pageSize: 20000,
    filter: { empresa_id: escopo.empresaId, local_id: localId },
  }, tx);
  const celulasSaldo = new Set<string>();
  for (const saldo of estoques.rows) {
    const chave = `${Number(saldo.produto_id)}:${saldo.tamanho_id === null || saldo.tamanho_id === undefined ? 'null' : Number(saldo.tamanho_id)}`;
    if (celulasSaldo.has(chave)) throw new HttpError(409, 'Há saldos duplicados para o mesmo produto/tamanho/local. Nada foi copiado ao inventário; revise os dados históricos.');
    celulasSaldo.add(chave);
    await validarTamanhoNaGrade(
      Number(saldo.produto_id),
      saldo.tamanho_id === null || saldo.tamanho_id === undefined ? null : Number(saldo.tamanho_id),
      tx,
      escopo
    );
  }
  // 2000 era o teto antigo e virava contagem silenciosa pela metade num local
  // maior — melhor recusar do que fechar um inventário incompleto.
  if (estoques.total > estoques.rows.length) {
    throw new HttpError(409, `O local "${local}" tem ${estoques.total} saldos e o snapshot só suporta ${estoques.rows.length} por inventário. Abra um inventário por produto/categoria.`);
  }
  const itensR = getResource('itens_inventario')!;
  const linhas = estoques.rows
    .filter((e) => Number(e.quantidade) !== 0 || Number(e.estoque_min || 0) !== 0)
    .map((e) => ({
      empresa_id: escopo.empresaId,
      inventario_id: Number(row.id),
      produto_id: e.produto_id,
      tamanho_id: e.tamanho_id,
      saldo_sistema: Number(e.quantidade),
      contado: null,
      diferenca: 0,
    }));
  // Um INSERT por linha tornava abrir a contagem O(n) em round-trips (2 mil saldos
  // = 2 mil ida-e-volta no Postgres). Em lote é um statement só.
  await s.insertMany(itensR, linhas, tx);
  const n = linhas.length;
  await s.update(getResource('inventarios')!, Number(row.id), { aberto_por: actor.name }, tx);
  await s.audit(
    { usuario_id: actor.id || null, usuario: actor.name, acao: 'criar', recurso: 'inventarios', registro_id: Number(row.id), descricao: `Inventário #${row.id} aberto no local "${local}" — ${n} itens com saldo congelado`, dados: { itens: n }, empresa_id: empresaDoRegistroAudit(getResource('inventarios')!, row, actor) },
    tx
  );
}

/** Inventários: em edição, apenas observações, e somente enquanto estiver aberto. */
async function validarUpdateInventario(data: Payload, before: Row) {
  const permitidos = new Set(['observacoes', 'local', 'local_id']);
  const invalidos = Object.keys(data).filter((k) => !permitidos.has(k) && k !== 'atualizado_em' && k !== 'criado_em');
  if (invalidos.length) {
    throw new HttpError(400, 'Um inventário não pode ser alterado diretamente: use o fechamento (gera os ajustes) ou abra um novo.', { status: 'Use a ação "Fechar inventário"' });
  }
  if (before.status === 'fechado') {
    throw new HttpError(409, 'Este inventário já foi fechado e não pode mais ser alterado.');
  }
}
