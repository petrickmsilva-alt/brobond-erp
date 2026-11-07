// ============================================================================
// MOTOR DE FRETE › REGRAS COMERCIAIS (PURO, sem I/O)
//
// As regras NÃO são acopladas a nenhuma transportadora. Elas decidem sobre a
// COTAÇÃO já obtida: frete grátis, subsídio, desconto logístico, restrição de
// modalidade por peso/dimensão, operador preferencial e restrição por região.
//
// As regras vivem no banco (`logistics_shipping_rules`) como `condicoes` e
// `acoes` JSONB. Este motor as avalia em ordem de PRIORIDADE (maior primeiro) e
// é a ÚNICA implementação da lógica comercial — RETAIL e WHOLESALE usam o mesmo
// motor, recortadas por `store_key`.
// ============================================================================
import { round2 } from '../../../server/src/utils';
import type { OpcaoFrete, StoreKey, VolumeValidado, Modalidade } from './contract';

export type TipoRegra =
  | 'FRETE_GRATIS_VALOR'
  | 'FRETE_GRATIS_REGIAO'
  | 'FRETE_SUBSIDIADO'
  | 'DESCONTO_LOGISTICO'
  | 'RESTRICAO_MODALIDADE'
  | 'OPERADOR_PREFERENCIAL'
  | 'RESTRICAO_REGIAO';

export const TIPOS_REGRA: readonly TipoRegra[] = [
  'FRETE_GRATIS_VALOR',
  'FRETE_GRATIS_REGIAO',
  'FRETE_SUBSIDIADO',
  'DESCONTO_LOGISTICO',
  'RESTRICAO_MODALIDADE',
  'OPERADOR_PREFERENCIAL',
  'RESTRICAO_REGIAO',
];

export type RegraLogistica = {
  id: number;
  empresa_id: number;
  store_key: StoreKey | null;
  nome: string;
  tipo: TipoRegra;
  prioridade: number;
  ativo: boolean;
  condicoes: Record<string, unknown>;
  acoes: Record<string, unknown>;
  inicio_em?: string | null;
  fim_em?: string | null;
};

export type ContextoRegras = {
  empresaId: number;
  storeKey: StoreKey | null;
  valorPedido: number;
  valorDeclarado: number;
  pesoTotalG: number;
  volumes: VolumeValidado[];
  destino: { cep: string; uf?: string | null; cidade?: string | null };
  modalidade: Modalidade;
  agora?: Date;
};

/** Uma opção de cotação + a aplicação acumulada de regras. */
export type OpcaoAvaliada = OpcaoFrete & {
  regras_aplicadas: string[];
  operador_preferencial: boolean;
};

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function listaUf(condicoes: Record<string, unknown>): string[] | null {
  const bruto = condicoes.ufs ?? condicoes.uf ?? condicoes.estados;
  if (!bruto) return null;
  const arr = Array.isArray(bruto) ? bruto : String(bruto).split(',');
  const ufs = arr.map((u) => String(u).trim().toUpperCase()).filter(Boolean);
  return ufs.length ? ufs : null;
}

function prefixosCep(condicoes: Record<string, unknown>): string[] | null {
  const bruto = condicoes.cep_prefixos ?? condicoes.cep_prefixo ?? condicoes.ceps;
  if (!bruto) return null;
  const arr = Array.isArray(bruto) ? bruto : String(bruto).split(',');
  const p = arr.map((c) => String(c).replace(/\D/g, '')).filter(Boolean);
  return p.length ? p : null;
}

/** Vigência: a regra está dentro do período? (sem datas = sempre vigente) */
export function regraVigente(regra: RegraLogistica, agora: Date): boolean {
  if (!regra.ativo) return false;
  const inicio = regra.inicio_em ? Date.parse(regra.inicio_em) : null;
  const fim = regra.fim_em ? Date.parse(regra.fim_em) : null;
  if (inicio !== null && Number.isFinite(inicio) && agora.getTime() < inicio) return false;
  if (fim !== null && Number.isFinite(fim) && agora.getTime() > fim) return false;
  return true;
}

/** A regra se aplica a este contexto? (empresa, loja e condições de escopo) */
export function regraAplicavel(regra: RegraLogistica, ctx: ContextoRegras, agora: Date): boolean {
  if (Number(regra.empresa_id) !== ctx.empresaId) return false;
  if (regra.store_key && regra.store_key !== ctx.storeKey) return false;
  if (!regraVigente(regra, agora)) return false;

  const ufs = listaUf(regra.condicoes);
  if (ufs && !(ctx.destino.uf && ufs.includes(String(ctx.destino.uf).toUpperCase()))) return false;

  const prefixos = prefixosCep(regra.condicoes);
  if (prefixos && !prefixos.some((p) => ctx.destino.cep.startsWith(p))) return false;

  const minValor = num(regra.condicoes.valor_minimo);
  if (minValor !== null && ctx.valorPedido < minValor) return false;

  const minQtd = num(regra.condicoes.quantidade_minima);
  if (minQtd !== null && ctx.volumes.reduce((a, v) => a + v.quantidade, 0) < minQtd) return false;

  const maxPeso = num(regra.condicoes.peso_maximo_g);
  if (maxPeso !== null && ctx.pesoTotalG > maxPeso) return false;

  const minPeso = num(regra.condicoes.peso_minimo_g);
  if (minPeso !== null && ctx.pesoTotalG < minPeso) return false;

  return true;
}

/** Ordena por prioridade (maior primeiro) e desempata por id (estável). */
export function ordenarRegras(regras: RegraLogistica[]): RegraLogistica[] {
  return [...regras].sort((a, b) => (b.prioridade - a.prioridade) || (a.id - b.id));
}

export type ResultadoRegras = {
  opcoes: OpcaoAvaliada[];
  /** true quando alguma regra de frete grátis se aplicou a alguma opção */
  freteGratis: boolean;
  /** subsídio total aplicado (por opção, o maior) */
  subsidio: number;
  /** modalidades/operadores bloqueados (diagnóstico) */
  restricoes: string[];
};

/**
 * Avalia as regras sobre as opções de cotação. Devolve as opções já com
 * `valor_final`, `frete_gratis`, `subsidio` e `regras_aplicadas`.
 *
 * Ordem de aplicação (determinística):
 *   1) RESTRICAO_MODALIDADE / RESTRICAO_REGIAO → removem opções;
 *   2) OPERADOR_PREFERENCIAL → marca a opção (usada como desempate no serviço);
 *   3) FRETE_GRATIS_VALOR / FRETE_GRATIS_REGIAO → zeram o valor;
 *   4) FRETE_SUBSIDIADO / DESCONTO_LOGISTICO → reduzem o valor.
 */
export function aplicarRegras(regras: RegraLogistica[], opcoes: OpcaoFrete[], ctx: ContextoRegras): ResultadoRegras {
  const agora = ctx.agora ?? new Date();
  const ativas = ordenarRegras(regras).filter((r) => regraAplicavel(r, ctx, agora));

  let avaliadas: OpcaoAvaliada[] = opcoes.map((o) => ({
    ...o,
    valor_final: round2(o.valor),
    frete_gratis: false,
    subsidio: 0,
    regras_aplicadas: [],
    operador_preferencial: false,
  }));

  const restricoes: string[] = [];

  // 1) restrições (removem opções)
  for (const regra of ativas) {
    if (regra.tipo === 'RESTRICAO_MODALIDADE') {
      const modalidadesBloqueadas = (Array.isArray(regra.acoes.modalidades) ? regra.acoes.modalidades : []).map((m) => String(m).toUpperCase());
      if (modalidadesBloqueadas.includes(ctx.modalidade)) {
        restricoes.push(`${regra.nome}: modalidade ${ctx.modalidade} bloqueada`);
        avaliadas = [];
      }
    }
    if (regra.tipo === 'RESTRICAO_REGIAO') {
      const servicosBloqueados = (Array.isArray(regra.acoes.servicos) ? regra.acoes.servicos : []).map(String);
      if (servicosBloqueados.length) {
        const antes = avaliadas.length;
        avaliadas = avaliadas.filter((o) => !servicosBloqueados.includes(o.servico) && !servicosBloqueados.includes(o.codigo));
        if (avaliadas.length < antes) restricoes.push(`${regra.nome}: ${antes - avaliadas.length} serviço(s) indisponível(is) na região`);
      }
    }
  }

  // 2) operador preferencial
  for (const regra of ativas) {
    if (regra.tipo !== 'OPERADOR_PREFERENCIAL') continue;
    const provedor = String(regra.acoes.provider ?? '').toLowerCase();
    const servico = regra.acoes.servico ? String(regra.acoes.servico) : null;
    for (const o of avaliadas) {
      const casaProvedor = !provedor || String(o.empresa ?? '').toLowerCase().includes(provedor) || provedor.includes(String(o.empresa ?? '').toLowerCase());
      const casaServico = !servico || o.servico === servico || o.codigo === servico;
      if (casaProvedor && casaServico) {
        o.operador_preferencial = true;
        o.regras_aplicadas.push(regra.nome);
      }
    }
  }

  // 3) frete grátis
  let freteGratis = false;
  for (const regra of ativas) {
    if (regra.tipo !== 'FRETE_GRATIS_VALOR' && regra.tipo !== 'FRETE_GRATIS_REGIAO') continue;
    const provedor = String(regra.acoes.provider ?? '').toLowerCase();
    const servico = regra.acoes.servico ? String(regra.acoes.servico) : null;
    for (const o of avaliadas) {
      if (provedor && !(String(o.empresa ?? '').toLowerCase().includes(provedor) || provedor.includes(String(o.empresa ?? '').toLowerCase()))) continue;
      if (servico && o.servico !== servico && o.codigo !== servico) continue;
      o.frete_gratis = true;
      o.subsidio = round2(o.subsidio + o.valor_final);
      o.valor_final = 0;
      o.regras_aplicadas.push(regra.nome);
      freteGratis = true;
    }
  }

  // 4) subsídio / desconto logístico
  let subsidioMax = 0;
  for (const regra of ativas) {
    if (regra.tipo !== 'FRETE_SUBSIDIADO' && regra.tipo !== 'DESCONTO_LOGISTICO') continue;
    const percentual = num(regra.acoes.percentual);
    const fixo = num(regra.acoes.valor);
    const provedor = String(regra.acoes.provider ?? '').toLowerCase();
    const servico = regra.acoes.servico ? String(regra.acoes.servico) : null;
    const teto = num(regra.acoes.teto);
    for (const o of avaliadas) {
      if (provedor && !(String(o.empresa ?? '').toLowerCase().includes(provedor) || provedor.includes(String(o.empresa ?? '').toLowerCase()))) continue;
      if (servico && o.servico !== servico && o.codigo !== servico) continue;
      if (o.valor_final <= 0) continue;
      let desconto = 0;
      if (percentual !== null) desconto += (o.valor_final * percentual) / 100;
      if (fixo !== null) desconto += fixo;
      if (teto !== null) desconto = Math.min(desconto, teto);
      desconto = Math.min(desconto, o.valor_final);
      if (desconto <= 0) continue;
      const novo = round2(o.valor_final - desconto);
      o.subsidio = round2(o.subsidio + (o.valor_final - novo));
      o.valor_final = novo;
      o.regras_aplicadas.push(regra.nome);
      subsidioMax = Math.max(subsidioMax, o.subsidio);
    }
  }

  return { opcoes: avaliadas, freteGratis, subsidio: subsidioMax, restricoes };
}
