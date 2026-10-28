// ============================================================================
// UNIDADES DE MEDIDA E CONVERSÃO DECLARADA (migration 0060 — P3-04 / P3-07)
//
// REGRA ÚNICA DESTE MÓDULO
// ------------------------
// O ERP só converte o que a EMPRESA DECLAROU em `unidade_conversoes`. Não existe
// fator "de fábrica", não existe conversão por semelhança de sigla e não existe
// conversão entre grandezas diferentes (metro ↔ quilo). Quando não há caminho
// declarado, a resposta é `null` — e quem chamou decide como declarar a falta
// (o MRP, por exemplo, marca `conversao_ausente: true` em vez de comprar no
// chute).
//
// POR QUE ISSO IMPORTA
// --------------------
// Compra-se em ROLO e consome-se em METRO. Um fator inventado (rolo = 50 m
// quando o fornecedor entrega 45 m) erra a compra em 10% e ninguém percebe até
// faltar material na produção. O fator é dado cadastral, não inferência.
//
// CAMINHO
// -------
// A busca é em largura sobre as regras ATIVAS da empresa e aceita cadeia
// (rolo → caixa → metro). Cada regra vale nos dois sentidos: declarar
// `1 rolo = 50 m` já responde "quantos rolos são 120 m". O resultado SEMPRE
// devolve o caminho percorrido — a conversão é auditável, não uma caixa-preta.
// ============================================================================
import type { Row, Tx } from './store';
import { checkAccess, escopoDe, getStore } from './services';
import { currentUser } from './auth';
import { getResource } from './resources';
import { round3 } from './utils';

const R_UNIDADE = () => getResource('unidades_medida')!;
const R_CONVERSAO = () => getResource('unidade_conversoes')!;

/** Profundidade máxima da cadeia. 3 é o suficiente (rolo → caixa → metro). */
const PROFUNDIDADE_MAXIMA = 3;

export type PassoConversao = { de: string; para: string; fator: number; inversa: boolean };

export type ResultadoConversao = {
  de: string;
  para: string;
  /** 1 `de` = `fator` `para`. */
  fator: number;
  /** `identica` (mesma unidade), `direta` (uma regra), `cadeia` (2+ regras). */
  origem: 'identica' | 'direta' | 'cadeia';
  caminho: PassoConversao[];
};

type Regra = { de: string; para: string; fator: number };

function normalizar(codigo: unknown): string {
  return String(codigo ?? '').trim().toLowerCase();
}

/** Regras ativas da empresa (cacheadas por chamada de alto nível). */
export async function regrasDeConversao(empresaId: number, tx?: Tx): Promise<Regra[]> {
  const { rows } = await getStore().list(R_CONVERSAO(), { page: 1, pageSize: 2000, filter: { empresa_id: empresaId, ativo: true } }, tx);
  return rows
    .map((r: Row) => ({ de: normalizar(r.de_codigo), para: normalizar(r.para_codigo), fator: Number(r.fator) }))
    .filter((r) => r.de && r.para && Number.isFinite(r.fator) && r.fator > 0);
}

/**
 * Fator entre duas unidades, ou `null` quando não há regra declarada.
 *
 * A mesma unidade é sempre 1 (identidade), mesmo sem regra cadastrada: não é
 * conversão, é a mesma coisa.
 */
export function calcularConversao(deEntrada: string, paraEntrada: string, regras: Regra[]): ResultadoConversao | null {
  const de = normalizar(deEntrada);
  const para = normalizar(paraEntrada);
  if (!de || !para) return null;
  if (de === para) return { de, para, fator: 1, origem: 'identica', caminho: [] };

  // BFS: o primeiro caminho encontrado é o de menor número de regras — e a
  // resposta leva o caminho, então o número é explicável.
  type No = { unidade: string; fator: number; caminho: PassoConversao[] };
  let fronteira: No[] = [{ unidade: de, fator: 1, caminho: [] }];
  const visitados = new Set<string>([de]);

  for (let nivel = 0; nivel < PROFUNDIDADE_MAXIMA; nivel++) {
    const proxima: No[] = [];
    for (const no of fronteira) {
      for (const regra of regras) {
        let passo: PassoConversao | null = null;
        if (regra.de === no.unidade) passo = { de: regra.de, para: regra.para, fator: regra.fator, inversa: false };
        else if (regra.para === no.unidade) passo = { de: regra.para, para: regra.de, fator: 1 / regra.fator, inversa: true };
        if (!passo) continue;
        const fator = no.fator * passo.fator;
        const caminho = [...no.caminho, passo];
        if (passo.para === para) {
          return {
            de,
            para,
            fator: Number(fator.toFixed(9)),
            origem: caminho.length === 1 ? 'direta' : 'cadeia',
            caminho,
          };
        }
        if (visitados.has(passo.para)) continue;
        visitados.add(passo.para);
        proxima.push({ unidade: passo.para, fator, caminho });
      }
    }
    if (proxima.length === 0) break;
    fronteira = proxima;
  }
  return null;
}

/** Wrapper assíncrono: carrega as regras da empresa e converte. */
export async function converterQuantidade(
  empresaId: number,
  quantidade: number,
  de: string,
  para: string,
  tx?: Tx
): Promise<{ quantidade: number; conversao: ResultadoConversao } | null> {
  if (!Number.isFinite(quantidade)) return null;
  const conversao = calcularConversao(de, para, await regrasDeConversao(empresaId, tx));
  if (!conversao) return null;
  return { quantidade: round3(quantidade * conversao.fator), conversao };
}

/**
 * Converte uma necessidade (na unidade de USO do insumo) para a unidade de
 * COMPRA — é o número que o comprador usa.
 *
 * Devolve `null` quando não há unidade de compra declarada ou quando a regra
 * não existe. NUNCA devolve a quantidade original "porque é parecido": quem
 * chama precisa declarar a ausência.
 */
export async function necessidadeNaUnidadeDeCompra(
  empresaId: number,
  insumo: Row,
  quantidadeDeUso: number
): Promise<{ unidade_compra: string; quantidade: number; conversao: ResultadoConversao } | null> {
  const unidadeUso = String(insumo.unidade ?? '').trim();
  const unidadeCompra = String(insumo.unidade_compra ?? '').trim();
  if (!unidadeUso || !unidadeCompra) return null;
  if (normalizar(unidadeUso) === normalizar(unidadeCompra)) {
    return {
      unidade_compra: unidadeCompra,
      quantidade: round3(quantidadeDeUso),
      conversao: { de: unidadeUso, para: unidadeCompra, fator: 1, origem: 'identica', caminho: [] },
    };
  }
  const conversao = calcularConversao(unidadeUso, unidadeCompra, await regrasDeConversao(empresaId));
  if (!conversao) return null;
  return { unidade_compra: unidadeCompra, quantidade: round3(quantidadeDeUso * conversao.fator), conversao };
}

/** GET /api/estoque/unidades/conversoes — o que a empresa DECLAROU, sem julgamento. */
export async function listarConversoes(req: any, res: any) {
  const actor = currentUser(req);
  checkAccess(R_CONVERSAO(), actor, 'read');
  const escopo = escopoDe(actor);
  const regras = await regrasDeConversao(escopo.empresaId);
  const unidades = (await getStore().list(R_UNIDADE(), { page: 1, pageSize: 1000, filter: { empresa_id: escopo.empresaId } })).rows;
  return res.json({
    unidades: unidades.map((u: Row) => ({
      codigo: String(u.codigo ?? ''),
      nome: String(u.nome ?? ''),
      grandeza: String(u.grandeza ?? 'contagem'),
      casas_decimais: Number(u.casas_decimais ?? 2),
      ativo: u.ativo !== false,
    })),
    conversoes: regras.map((r) => ({ de: r.de, para: r.para, fator: r.fator })),
    regra:
      'O ERP converte SOMENTE o que está declarado aqui. Unidade sem regra não é convertida — estoque, compras e MRP declaram a ausência em vez de estimar.',
  });
}
