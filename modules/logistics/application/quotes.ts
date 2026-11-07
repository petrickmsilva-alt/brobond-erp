// ============================================================================
// MOTOR DE FRETE › APLICAÇÃO › COTAÇÃO
//
// Fluxo (determinístico, sem I/O no domínio):
//   1) valida CEP de origem/destino e volumes;
//   2) resolve as REGRAS COMERCIAIS da empresa/loja;
//   3) chama o ADAPTADOR da transportadora (timeout + retry já na camada HTTP);
//   4) aplica as regras (frete grátis, subsídio, restrição, preferência);
//   5) PERSISTE a cotação com origem, operador, modalidade, valor, prazo,
//      validade e referência da resposta externa;
//   6) devolve um ESTADO EXPLÍCITO em caso de falha — nunca um valor inventado.
//
// O CHECKOUT chama isto no BACKEND e guarda o `quote_id` no pedido. O valor de
// frete enviado pelo navegador NUNCA é confiado: a cotação é revalidada.
// ============================================================================
import { getStore } from '../../../server/src/services';
import { round2 } from '../../../server/src/utils';
import {
  cepValido,
  cepNormalizado,
  estadoDoMotivoProvedor,
  MENSAGEM_ESTADO,
  type ContextoCotacao,
  type OpcaoFrete,
  type ResultadoCotacao,
  type StatusLogistico,
  type StoreKey,
  type Modalidade,
} from '../domain/contract';
import { aplicarRegras, type RegraLogistica } from '../domain/rules';
import { validarVolumes } from '../domain/contract';
import { carrier, CARRIER_NULO, type CarrierAdapter } from '../providers/contract';
import { R_QUOTES, R_SHIPPING_RULES } from '../infrastructure/resources';
import { auditarLogistica } from '../infrastructure/audit';
import { fingerprintCotacao } from './tracking';
import type { Row, Tx } from '../../../server/src/store';

/** Validade padrão de uma cotação (minutos). Configurável. */
function validadeMinutos(): number {
  const n = Number(process.env.LOGISTICS_QUOTE_TTL_MIN);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 24 * 60) : 30;
}

function boolEnv(nome: string, padrao = false): boolean {
  const bruto = String(process.env[nome] ?? '').trim().toLowerCase();
  if (!bruto) return padrao;
  return ['1', 'true', 'sim', 'yes', 'on'].includes(bruto);
}

/** Módulo ligado? Sem `LOGISTICS_ENABLED`, fica em MODO SEGURO (desabilitado). */
export function logisticsHabilitado(): boolean {
  return boolEnv('LOGISTICS_ENABLED', false);
}

/** Reconciliação periódica ligada? (desligada por padrão; exige o motor ligado) */
export function reconciliacaoHabilitada(): boolean {
  return logisticsHabilitado() && boolEnv('LOGISTICS_RECONCILIATION_ENABLED', false);
}

/**
 * Intervalo do polling de rastreio, em minutos (0 = desligado).
 * `LOGISTICS_TRACKING_POLL_INTERVAL` é expresso em SEGUNDOS. Padrão: 30 min.
 */
export function intervaloPollMin(): number {
  const bruto = process.env.LOGISTICS_TRACKING_POLL_INTERVAL;
  if (bruto === undefined || String(bruto).trim() === '') return 30;
  const n = Number(bruto);
  if (!Number.isFinite(n) || n < 0) return 30;
  return Math.floor(n / 60);
}

/** Carrega as regras ativas da empresa (e, opcionalmente, da loja). */
export async function carregarRegras(empresaId: number, storeKey: StoreKey | null, tx?: Tx): Promise<RegraLogistica[]> {
  const s = getStore();
  const out = await s.list(R_SHIPPING_RULES(), { page: 1, pageSize: 500, filter: { empresa_id: empresaId, ativo: true }, sort: 'prioridade', dir: 'desc' }, tx);
  return out.rows
    .filter((r) => !r.store_key || r.store_key === storeKey)
    .map((r) => ({
      id: Number(r.id),
      empresa_id: Number(r.empresa_id),
      store_key: (r.store_key as StoreKey) || null,
      nome: String(r.nome),
      tipo: String(r.tipo) as RegraLogistica['tipo'],
      prioridade: Number(r.prioridade) || 0,
      ativo: r.ativo !== false,
      condicoes: (r.condicoes && typeof r.condicoes === 'object' ? r.condicoes : {}) as Record<string, unknown>,
      acoes: (r.acoes && typeof r.acoes === 'object' ? r.acoes : {}) as Record<string, unknown>,
      inicio_em: r.inicio_em ? String(r.inicio_em) : null,
      fim_em: r.fim_em ? String(r.fim_em) : null,
    }));
}

export type OpcoesCotacao = {
  /** slug do operador; sem ele, usa o padrão da empresa (`LOGISTICS_DEFAULT_PROVIDER`). */
  provider?: string | null;
  modalidade?: Modalidade;
  /** ignora o cache de cotação válida e força nova chamada ao operador */
  forcar?: boolean;
  tx?: Tx;
};

/** Adaptador padrão da empresa: explícito, senão o ambiente, senão `manual`. */
export function provedorPadrao(): string {
  return String(process.env.LOGISTICS_DEFAULT_PROVIDER ?? 'manual').trim() || 'manual';
}

/**
 * Cota o frete. Persiste o resultado (mesmo em falha) e devolve o estado
 * explícito. Nunca lança por indisponibilidade do operador.
 */
export async function cotarFrete(ctx: ContextoCotacao, opcoes: OpcoesCotacao = {}): Promise<ResultadoCotacao & { quote_id: number | null }> {
  const s = getStore();
  const tx = opcoes.tx;
  const modalidade = opcoes.modalidade ?? ctx.modalidade;
  const slug = String(opcoes.provider || provedorPadrao()).toLowerCase();
  const adapter: CarrierAdapter = carrier(slug) ?? CARRIER_NULO;

  const cepOrigem = cepNormalizado(ctx.origem.cep);
  const cepDestino = cepNormalizado(ctx.destino.cep);
  const { volumes, erros: errosVolume } = validarVolumes(ctx.volumes);
  const fingerprint = fingerprintCotacao({
    empresaId: ctx.empresaId,
    storeKey: ctx.storeKey,
    vendaId: ctx.vendaId,
    cepOrigem,
    cepDestino,
    pesoG: ctx.pesoTotalG,
    volumes: volumes.length,
    modalidade,
  });

  const persistir = async (r: ResultadoCotacao): Promise<number | null> => {
    try {
      const row = await s.insert(
        R_QUOTES(),
        {
          empresa_id: ctx.empresaId,
          store_key: ctx.storeKey,
          venda_id: ctx.vendaId,
          provider: r.provedor,
          modalidade: r.modalidade,
          estado: r.estado,
          cep_origem: cepOrigem || null,
          cep_destino: cepDestino || null,
          peso_g: Math.round(ctx.pesoTotalG),
          volumes: volumes.length,
          valor_declarado: round2(ctx.valorDeclarado),
          valor_pedido: round2(ctx.valorPedido),
          opcoes: r.opcoes,
          referencia_externa: r.referenciaExterna,
          motivo: r.motivo,
          fingerprint,
          valida_ate: r.validaAte,
        },
        tx
      );
      return Number(row.id);
    } catch (e) {
      console.error('[logistics:quote] falha ao persistir cotação', { provider: r.provedor, erro: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };

  // --- validações de entrada: falham ANTES de qualquer chamada externa ---
  if (!cepValido(cepOrigem)) {
    const r: ResultadoCotacao = {
      estado: 'INVALID_DESTINATION',
      motivo: 'O CEP de origem da empresa é inválido ou não foi configurado.',
      provedor: adapter.slug,
      provedorNome: adapter.nome,
      modalidade,
      opcoes: [],
      referenciaExterna: null,
      validaAte: null,
    };
    return { ...r, quote_id: await persistir(r) };
  }
  if (!cepValido(cepDestino)) {
    const r: ResultadoCotacao = {
      estado: 'INVALID_DESTINATION',
      motivo: MENSAGEM_ESTADO.INVALID_DESTINATION,
      provedor: adapter.slug,
      provedorNome: adapter.nome,
      modalidade,
      opcoes: [],
      referenciaExterna: null,
      validaAte: null,
    };
    return { ...r, quote_id: await persistir(r) };
  }
  if (errosVolume.length) {
    const r: ResultadoCotacao = {
      estado: 'QUOTE_FAILED',
      motivo: `Volume inválido: ${errosVolume.join(' ')}`,
      provedor: adapter.slug,
      provedorNome: adapter.nome,
      modalidade,
      opcoes: [],
      referenciaExterna: null,
      validaAte: null,
    };
    return { ...r, quote_id: await persistir(r) };
  }

  // --- módulo desabilitado: modo seguro, sem chamar operador ---
  if (!logisticsHabilitado() && !boolEnv('LOGISTICS_QUOTE_ALLOW_DISABLED', false)) {
    const r: ResultadoCotacao = {
      estado: 'CREDENTIALS_MISSING',
      motivo: 'O motor de logística está desabilitado (LOGISTICS_ENABLED=false). Nenhuma cotação foi solicitada ao operador.',
      provedor: adapter.slug,
      provedorNome: adapter.nome,
      modalidade,
      opcoes: [],
      referenciaExterna: null,
      validaAte: null,
    };
    return { ...r, quote_id: await persistir(r) };
  }

  // --- chamada ao operador ---
  const resultado = await adapter.cotar({
    empresaId: ctx.empresaId,
    origem: { ...ctx.origem, cep: cepOrigem },
    destino: { ...ctx.destino, cep: cepDestino },
    volumes: ctx.volumes,
    pesoTotalG: ctx.pesoTotalG,
    valorDeclarado: ctx.valorDeclarado,
  });

  if (!resultado.ok) {
    const estado = estadoDoMotivoProvedor(resultado.motivo);
    const r: ResultadoCotacao = {
      estado,
      motivo: resultado.mensagem || MENSAGEM_ESTADO[estado],
      provedor: adapter.slug,
      provedorNome: adapter.nome,
      modalidade,
      opcoes: [],
      referenciaExterna: null,
      validaAte: null,
    };
    const quote_id = await persistir(r);
    await auditarLogistica(
      { empresaId: ctx.empresaId, storeKey: ctx.storeKey, entidade: 'quote', entidadeId: quote_id, acao: 'cotacao_falha', descricao: `Cotação ${adapter.slug}: ${estado} — ${r.motivo}`, dados: { estado, motivo: r.motivo } },
      tx
    );
    return { ...r, quote_id };
  }

  // --- aplica as regras comerciais ---
  const regras = await carregarRegras(ctx.empresaId, ctx.storeKey, tx);
  const base: OpcaoFrete[] = resultado.data.map((o) => ({
    servico: o.servico,
    nome: o.nome,
    codigo: o.codigo,
    valor: round2(o.valor),
    valor_final: round2(o.valor),
    prazo_dias: Math.max(1, Number(o.prazo_dias) || 1),
    empresa: o.empresa,
    frete_gratis: false,
    subsidio: 0,
    aviso: o.aviso,
  }));
  const avaliadas = aplicarRegras(regras, base, {
    empresaId: ctx.empresaId,
    storeKey: ctx.storeKey,
    valorPedido: ctx.valorPedido,
    valorDeclarado: ctx.valorDeclarado,
    pesoTotalG: ctx.pesoTotalG,
    volumes,
    destino: { cep: cepDestino, uf: ctx.destino.uf, cidade: ctx.destino.cidade },
    modalidade,
  });

  const referencia = resultado.data.find((o) => o.referencia)?.referencia ?? null;
  const validaAte = new Date(Date.now() + validadeMinutos() * 60_000).toISOString();
  const r: ResultadoCotacao = {
    estado: 'OK',
    motivo: MENSAGEM_ESTADO.OK,
    provedor: adapter.slug,
    provedorNome: adapter.nome,
    modalidade,
    opcoes: avaliadas.opcoes,
    referenciaExterna: referencia,
    validaAte,
  };
  const quote_id = await persistir(r);
  return { ...r, quote_id };
}

/** Seleciona a melhor opção segundo uma estratégia (prazo ou custo). */
export function selecionarOpcao(opcoes: OpcaoFrete[], criterio: 'custo' | 'prazo' | 'preferencial'): OpcaoFrete | null {
  if (!opcoes.length) return null;
  const pref = opcoes.filter((o) => (o as OpcaoFrete & { operador_preferencial?: boolean }).operador_preferencial);
  if (criterio === 'preferencial' && pref.length) {
    return [...pref].sort((a, b) => a.valor_final - b.valor_final)[0];
  }
  const pool = pref.length && criterio === 'custo' ? opcoes : opcoes;
  if (criterio === 'prazo') return [...pool].sort((a, b) => a.prazo_dias - b.prazo_dias || a.valor_final - b.valor_final)[0];
  return [...pool].sort((a, b) => a.valor_final - b.valor_final || a.prazo_dias - b.prazo_dias)[0];
}

export { R_QUOTES, R_SHIPPING_RULES };
export type { Row, StatusLogistico };
