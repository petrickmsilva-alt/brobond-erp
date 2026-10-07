// ============================================================================
// MULTIEMPRESA — isolamento real por empresa.
//
// O ponto de partida é desconfiar do cliente. O id da empresa NUNCA vem do
// corpo da requisição nem da query string: ele é derivado do ator autenticado
// (`usuarios.empresa_id`), opcionalmente trocado por um seletor de empresa que
// vive na SESSÃO (claim `emp` do JWT) e que só é aceito se o usuário tiver
// aquela empresa concedida em `usuario_empresas`.
//
// A partir daí, três garantias:
//
//   1) LEITURA — toda listagem de recurso com escopo recebe um filtro
//      `empresa_id` obrigatório, somado (AND) a qualquer filtro do usuário.
//      Um `?f.empresa_id=2` enviado pelo cliente é descartado antes.
//
//   2) ACESSO DIRETO POR ID — `assertRegistroDaEmpresa` compara a empresa do
//      registro com a do escopo e responde 404 (e não 403) quando difere:
//      dizer "403" já vazaria a existência do registro da outra empresa.
//
//   3) ESCRITA — a empresa é SEMPRE carimbada pelo servidor na criação, e
//      jamais pode ser alterada numa edição. Além disso, toda referência
//      (`type: 'ref'`) apontando para um recurso com escopo é validada: não é
//      possível montar uma venda da Empresa A com um cliente da Empresa B.
//
// Consolidação (ver o grupo inteiro) é um privilégio EXPLÍCITO
// (`usuarios.pode_consolidar`) e só vale para leitura.
// ============================================================================
import { HttpError } from './errors';
import { getResource, type Resource } from './resources';
import type { Payload, Row, Tx } from './store';

/** Empresa padrão do grupo (BROBOND) — criada pela migration 0016. */
export const EMPRESA_PADRAO = 1;

export type EscopoEmpresa = {
  /** Empresa ativa da sessão. */
  empresaId: number;
  /** Leitura consolidada do grupo (somente quem tem `pode_consolidar`). */
  consolidado: boolean;
  /** Empresas que o ator pode acessar. */
  permitidas: number[];
};

export type AtorEmpresa = {
  id: number;
  perfil?: string;
  empresa_id?: number | null;
  pode_consolidar?: boolean;
  /** Empresa escolhida no seletor (claim `emp` do token de sessão). */
  empresa_sessao?: number | null;
  /** Empresas concedidas (carregadas no login). */
  empresas?: number[];
  /** Pedido explícito de consolidação nesta requisição. */
  consolidar?: boolean;
};

/** Escopo de serviço (jobs, cron, importadores) — sem usuário na frente. */
export function escopoDeSistema(empresaId: number = EMPRESA_PADRAO): EscopoEmpresa {
  return { empresaId, consolidado: false, permitidas: [empresaId] };
}

/**
 * Escopo irrestrito. Usado SOMENTE por rotinas internas que já aplicam o
 * recorte por outro caminho (ex.: o motor 1. MEU NEGÓCIOS, que recebe
 * `empresa_id` como parâmetro de BI). Nunca derivável de input do usuário.
 */
export function escopoIrrestrito(): EscopoEmpresa {
  return { empresaId: EMPRESA_PADRAO, consolidado: true, permitidas: [] };
}

/**
 * Resolve o escopo do ator.
 *
 * - `empresa_id` da linha de `usuarios` é o padrão;
 * - o seletor de empresa da sessão (`empresa_sessao`) só vence se estiver
 *   entre as empresas concedidas;
 * - consolidar exige `pode_consolidar` E pedido explícito.
 */
export function escopoDoAtor(actor: AtorEmpresa | null | undefined): EscopoEmpresa {
  if (!actor) return escopoDeSistema();
  const padrao = Number(actor.empresa_id) > 0 ? Number(actor.empresa_id) : EMPRESA_PADRAO;
  const permitidas = normalizarPermitidas(actor, padrao);

  const selecionada = Number(actor.empresa_sessao);
  const empresaId = selecionada > 0 && permitidas.includes(selecionada) ? selecionada : padrao;

  const consolidado = actor.consolidar === true && actor.pode_consolidar === true;
  return { empresaId, consolidado, permitidas };
}

function normalizarPermitidas(actor: AtorEmpresa, padrao: number): number[] {
  const lista = Array.isArray(actor.empresas) ? actor.empresas.map(Number).filter((n) => n > 0) : [];
  if (!lista.includes(padrao)) lista.push(padrao);
  return [...new Set(lista)];
}

/** O ator pode operar nesta empresa? */
export function podeAcessarEmpresa(actor: AtorEmpresa | null | undefined, empresaId: number): boolean {
  const escopo = escopoDoAtor(actor);
  return escopo.permitidas.includes(Number(empresaId));
}

/** Lança 403 quando a empresa pedida não foi concedida ao ator. */
export function exigirEmpresaPermitida(actor: AtorEmpresa | null | undefined, empresaId: number): number {
  const alvo = Number(empresaId);
  if (!Number.isInteger(alvo) || alvo <= 0) throw new HttpError(400, 'Empresa inválida.');
  if (!podeAcessarEmpresa(actor, alvo)) {
    throw new HttpError(403, 'Você não tem acesso a esta empresa.');
  }
  return alvo;
}

// ---------------------------------------------------------------------------
// Recursos com escopo
// ---------------------------------------------------------------------------

/** O recurso é isolado por empresa? (declarado em resources.ts) */
export function temEscopoEmpresa(r: Resource): boolean {
  return r.empresa === true;
}

/**
 * Filtro de empresa a aplicar numa listagem.
 * `null` = sem recorte (recurso global ou leitura consolidada autorizada).
 */
export function filtroEmpresa(r: Resource, escopo: EscopoEmpresa | null | undefined): number | null {
  if (!escopo || !temEscopoEmpresa(r)) return null;
  if (escopo.consolidado) return null;
  return escopo.empresaId;
}

/**
 * Sanitiza os filtros recebidos do cliente e aplica o recorte do servidor.
 * `f.empresa_id` enviado pelo usuário é SEMPRE descartado.
 */
export function aplicarFiltroEmpresa(
  r: Resource,
  filter: Record<string, unknown> | undefined,
  escopo: EscopoEmpresa | null | undefined
): Record<string, unknown> | undefined {
  const base: Record<string, unknown> = { ...(filter || {}) };
  if (temEscopoEmpresa(r)) delete base.empresa_id;
  const alvo = filtroEmpresa(r, escopo);
  if (alvo !== null) base.empresa_id = alvo;
  return Object.keys(base).length ? base : undefined;
}

/** Um registro lido do banco pertence ao escopo? */
export function registroNoEscopo(r: Resource, row: Row | null | undefined, escopo: EscopoEmpresa | null | undefined): boolean {
  if (!row) return false;
  if (!temEscopoEmpresa(r) || !escopo) return true;
  if (escopo.consolidado) return true;
  const dono = row.empresa_id === null || row.empresa_id === undefined ? EMPRESA_PADRAO : Number(row.empresa_id);
  return dono === escopo.empresaId;
}

/**
 * Acesso direto por id. Responde 404 (e não 403) quando o registro é de outra
 * empresa: a existência de um id alheio não é informação a vazar.
 */
export function assertRegistroDaEmpresa(r: Resource, row: Row | null | undefined, escopo: EscopoEmpresa | null | undefined): Row {
  if (!row || !registroNoEscopo(r, row, escopo)) {
    throw new HttpError(404, `${r.singular} não encontrado(a).`);
  }
  return row;
}

/**
 * Carimba a empresa no payload de criação. O valor vindo do cliente é
 * ignorado — quem decide é o servidor.
 */
export function carimbarEmpresa(r: Resource, data: Payload, escopo: EscopoEmpresa | null | undefined): Payload {
  if (!temEscopoEmpresa(r)) return data;
  data.empresa_id = escopo ? escopo.empresaId : EMPRESA_PADRAO;
  return data;
}

/**
 * Edição: a empresa de um registro nunca muda por um PUT. Remover a chave é
 * suficiente — o store só grava o que está no payload.
 */
export function protegerEmpresaNaEdicao(r: Resource, data: Payload): Payload {
  if (temEscopoEmpresa(r)) delete data.empresa_id;
  return data;
}

// ---------------------------------------------------------------------------
// Integridade referencial entre empresas
// ---------------------------------------------------------------------------

type LeitorRegistro = (r: Resource, id: number, tx?: Tx) => Promise<Row | null>;

/**
 * Impede o "ID forjado": uma venda da Empresa A não pode referenciar um
 * cliente, produto, representante ou conta da Empresa B, ainda que o id exista
 * e a FK do banco aceite.
 *
 * Percorre apenas os campos `type: 'ref'` cujo recurso-alvo também tem escopo.
 */
export async function validarReferenciasDaEmpresa(
  r: Resource,
  data: Payload,
  escopo: EscopoEmpresa | null | undefined,
  ler: LeitorRegistro,
  tx?: Tx
): Promise<void> {
  if (!escopo || escopo.consolidado) return;
  for (const field of r.fields) {
    if (field.type !== 'ref' || !field.ref) continue;
    const valor = data[field.name];
    if (valor === undefined || valor === null || valor === '') continue;
    const alvo = getResource(field.ref);
    if (!alvo || !temEscopoEmpresa(alvo)) continue;
    const id = Number(valor);
    if (!Number.isInteger(id) || id <= 0) continue;
    const row = await ler(alvo, id, tx);
    if (!row || !registroNoEscopo(alvo, row, escopo)) {
      throw new HttpError(400, `${field.label}: o registro selecionado não pertence à empresa ativa.`, {
        [field.name]: 'Registro de outra empresa',
      });
    }
  }
}
