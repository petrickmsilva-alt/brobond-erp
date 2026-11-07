// ============================================================================
// MOTOR DE FRETE E LOGÍSTICA MULTICANAL › DOMÍNIO › CONTRATO
//
// Este é o núcleo do módulo. Ele NÃO conhece nenhuma transportadora, nenhuma
// loja e nenhuma tabela: conhece tipos e regras puras. Os adaptadores, a
// persistência e a integração WooCommerce vivem nas outras camadas.
//
// A regra que governa o módulo, herdada do `ShippingProvider` já existente:
//
//   **O sistema nunca diz que cotou, postou ou entregou o que não existe.**
//
// Quando uma cotação externa falha, o resultado é um ESTADO EXPLÍCITO
// (`PROVIDER_UNAVAILABLE`, `CREDENTIALS_MISSING`, `QUOTE_FAILED`,
// `INVALID_DESTINATION`, `NO_SERVICE_AVAILABLE`) — nunca um valor inventado.
// ============================================================================

/** Identificadores imutáveis das lojas (espelham o registry do WooCommerce). */
export const STORE_KEYS = ['RETAIL', 'WHOLESALE'] as const;
export type StoreKey = (typeof STORE_KEYS)[number];

export function ehStoreKey(valor: unknown): valor is StoreKey {
  return typeof valor === 'string' && (STORE_KEYS as readonly string[]).includes(valor);
}

/** Modalidade de entrega — regra comercial, não da transportadora. */
export const MODALIDADES = ['CIF', 'FOB', 'RETIRADA', 'SUBSIDIADO'] as const;
export type Modalidade = (typeof MODALIDADES)[number];

export function ehModalidade(valor: unknown): valor is Modalidade {
  return typeof valor === 'string' && (MODALIDADES as readonly string[]).includes(valor);
}

// ----------------------------------------------------------------------------
// STATUS NORMALIZADO
//
// O ERP tem UM vocabulário de status. Cada transportadora fala o seu; o
// adaptador traduz o status BRUTO para este vocabulário e o histórico bruto é
// preservado. A ordem abaixo é a ORDEM DE PROGRESSO — ela é o que impede que um
// evento atrasado faça um pedido entregue voltar para "em trânsito".
// ----------------------------------------------------------------------------
export const STATUS_LOGISTICOS = [
  'pendente',
  'cotado',
  'pronto_expedicao',
  'separacao',
  'embalada',
  'etiqueta_pendente',
  'etiqueta_gerada',
  'gerado',
  'postado',
  'em_transito',
  'em_rota',
  'entregue',
  'tentativa_falha',
  'devolvido',
  'extraviado',
  'cancelado',
  'erro',
] as const;

export type StatusLogistico = (typeof STATUS_LOGISTICOS)[number];

export function ehStatusLogistico(valor: unknown): valor is StatusLogistico {
  return typeof valor === 'string' && (STATUS_LOGISTICOS as readonly string[]).includes(valor);
}

/**
 * Peso de progresso de cada status. Estados TERMINAIS (entregue, cancelado,
 * extraviado) têm peso alto; estados de EXCEÇÃO (tentativa_falha, devolvido)
 * são "laterais" — não avançam o pedido, mas também não o regridem.
 *
 * A comparação por peso é o que decide se um evento pode mover o status:
 * eventos de peso MENOR que o status atual são RECUSADOS (não regridem).
 */
const PESO_STATUS: Record<StatusLogistico, number> = {
  pendente: 0,
  cotado: 10,
  pronto_expedicao: 20,
  separacao: 25,
  embalada: 30,
  etiqueta_pendente: 35,
  etiqueta_gerada: 40,
  gerado: 45,
  postado: 50,
  em_transito: 60,
  em_rota: 70,
  entregue: 100,
  tentativa_falha: 65,
  devolvido: 90,
  extraviado: 95,
  cancelado: 110,
  erro: 5,
};

export function pesoDoStatus(status: StatusLogistico): number {
  return PESO_STATUS[status] ?? 0;
}

/** Estados terminais: depois deles, só eventos com peso igual ou maior. */
export const STATUS_TERMINAIS: readonly StatusLogistico[] = ['entregue', 'cancelado', 'extraviado'];

export function ehStatusTerminal(status: StatusLogistico): boolean {
  return STATUS_TERMINAIS.includes(status);
}

/**
 * A regra de NÃO REGRESSÃO.
 *
 * Um evento novo só move o status quando:
 *   • o status atual não é terminal e o peso do novo é MAIOR; ou
 *   • o status novo é o MESMO (idempotência); ou
 *   • o status novo é CANCELADO (exceção administrativa) ou uma EXCEÇÃO lateral
 *     a partir de um status em trânsito (tentativa falha, extraviado).
 *
 * Um pedido ENTREGUE nunca volta para "em trânsito": peso 60 < 100 → recusado.
 * O evento bruto é SEMPRE gravado no histórico; só o `status` do envio não
 * regride.
 */
export function podeAvancar(atual: StatusLogistico, novo: StatusLogistico): boolean {
  if (atual === novo) return true;
  const pAtual = pesoDoStatus(atual);
  const pNovo = pesoDoStatus(novo);
  if (pNovo > pAtual) return true;
  // Exceções laterais: só a partir de um estado em movimento e para estados que
  // descrevem um problema (não um "retorno" de entrega concluída).
  if (novo === 'tentativa_falha' && pAtual >= pesoDoStatus('postado') && pAtual < pesoDoStatus('entregue')) return true;
  if (novo === 'cancelado') return true;
  return false;
}

// ----------------------------------------------------------------------------
// ESTADO DA COTAÇÃO
// ----------------------------------------------------------------------------
export const ESTADOS_COTACAO = [
  'OK',
  'PROVIDER_UNAVAILABLE',
  'CREDENTIALS_MISSING',
  'QUOTE_FAILED',
  'INVALID_DESTINATION',
  'NO_SERVICE_AVAILABLE',
] as const;
export type EstadoCotacao = (typeof ESTADOS_COTACAO)[number];

/** Motivo do contrato legado (`ShippingProvider`) → estado da cotação nova. */
export function estadoDoMotivoProvedor(motivo: 'nao_configurado' | 'falha' | 'recusado'): EstadoCotacao {
  if (motivo === 'nao_configurado') return 'CREDENTIALS_MISSING';
  if (motivo === 'recusado') return 'NO_SERVICE_AVAILABLE';
  return 'PROVIDER_UNAVAILABLE';
}

/** Motivo técnico legível para cada estado (sem expor credencial). */
export const MENSAGEM_ESTADO: Record<EstadoCotacao, string> = {
  OK: 'Cotação obtida.',
  PROVIDER_UNAVAILABLE: 'A transportadora está indisponível ou não respondeu dentro do tempo limite.',
  CREDENTIALS_MISSING: 'A transportadora não está configurada (credenciais ausentes).',
  QUOTE_FAILED: 'A cotação falhou no provedor. Tente novamente ou escolha outra modalidade.',
  INVALID_DESTINATION: 'O CEP de destino é inválido ou não é atendido pela transportadora.',
  NO_SERVICE_AVAILABLE: 'Nenhum serviço da transportadora atende este trecho/peso.',
};

// ----------------------------------------------------------------------------
// CONTRATO DE COTAÇÃO (saída do domínio, sem I/O)
// ----------------------------------------------------------------------------
export type OpcaoFrete = {
  /** slug do serviço no provedor (ex.: '04014' SEDEX) */
  servico: string;
  /** nome legível (ex.: 'SEDEX') */
  nome: string;
  /** código do serviço no provedor */
  codigo: string;
  /** valor bruto cobrado pelo operador (R$) */
  valor: number;
  /** valor após regras comerciais do ERP (R$) */
  valor_final: number;
  /** prazo estimado em dias */
  prazo_dias: number;
  /** operadora (ex.: 'Correios') */
  empresa?: string;
  /** frete grátis aplicado por regra do ERP */
  frete_gratis: boolean;
  /** subsídio aplicado pela empresa (R$) */
  subsidio: number;
  /** aviso do provedor, quando houver */
  aviso?: string;
};

export type ResultadoCotacao = {
  estado: EstadoCotacao;
  /** motivo técnico legível; sempre presente, mesmo em OK (resumo) */
  motivo: string;
  provedor: string;
  provedorNome: string;
  modalidade: Modalidade;
  opcoes: OpcaoFrete[];
  /** referência da resposta externa do provedor, quando houver */
  referenciaExterna: string | null;
  /** validade da cotação (ISO) */
  validaAte: string | null;
};

// ----------------------------------------------------------------------------
// DADOS DE ENTRADA DA COTAÇÃO (montados pelo serviço, NUNCA pelo cliente)
// ----------------------------------------------------------------------------
export type EnderecoFrete = { cep: string; cidade?: string | null; uf?: string | null };

export type VolumeFrete = {
  peso_g: number;
  altura_cm?: number;
  largura_cm?: number;
  comprimento_cm?: number;
  quantidade?: number;
};

export type ContextoCotacao = {
  empresaId: number;
  storeKey: StoreKey | null;
  vendaId: number | null;
  origem: EnderecoFrete;
  destino: EnderecoFrete;
  volumes: VolumeFrete[];
  pesoTotalG: number;
  valorDeclarado: number;
  valorPedido: number;
  modalidade: Modalidade;
  /** tipo de produto predominante (opcional; regras podem restringir) */
  tipoProduto?: string | null;
};

// ----------------------------------------------------------------------------
// VALIDAÇÃO DE CEP / VOLUMES (puro)
// ----------------------------------------------------------------------------
export function cepNormalizado(valor: unknown): string {
  return String(valor ?? '').replace(/\D/g, '');
}

export function cepValido(valor: unknown): boolean {
  const cep = cepNormalizado(valor);
  return cep.length === 8 && cep !== '00000000';
}

export type VolumeValidado = {
  peso_g: number;
  altura_cm: number;
  largura_cm: number;
  comprimento_cm: number;
  quantidade: number;
};

const PESO_MIN_G = 1;
const PESO_MAX_G = 300_000;
const DIM_MIN_CM = 1;
const DIM_MAX_CM = 300;

/**
 * Normaliza e valida volumes. Dimensões fora da faixa operacional são
 * PRESERVADAS mas sinalizadas — a decisão de recusar é da regra comercial, não
 * do parser. Devolve `erros` não vazios quando algum volume é inutilizável.
 */
export function validarVolumes(volumes: VolumeFrete[]): { volumes: VolumeValidado[]; erros: string[] } {
  const erros: string[] = [];
  const out: VolumeValidado[] = [];
  if (!volumes.length) {
    erros.push('Nenhum volume informado.');
    return { volumes: out, erros };
  }
  for (const [i, v] of volumes.entries()) {
    const peso = Math.trunc(Number(v.peso_g) || 0);
    const quantidade = Math.max(1, Math.trunc(Number(v.quantidade) || 1));
    const dim = (valor: unknown, padrao: number) => {
      const n = Number(valor);
      if (!Number.isFinite(n) || n <= 0) return padrao;
      return Math.min(DIM_MAX_CM, Math.max(DIM_MIN_CM, Math.round(n * 10) / 10));
    };
    if (peso < PESO_MIN_G) erros.push(`Volume ${i + 1}: peso inválido (${v.peso_g}).`);
    if (peso > PESO_MAX_G) erros.push(`Volume ${i + 1}: peso acima do limite operacional (${PESO_MAX_G / 1000} kg).`);
    out.push({
      peso_g: peso,
      altura_cm: dim(v.altura_cm, 10),
      largura_cm: dim(v.largura_cm, 15),
      comprimento_cm: dim(v.comprimento_cm, 20),
      quantidade,
    });
  }
  return { volumes: out, erros };
}

/** Peso cubado (fator 6000) — usado para restrição de modalidade por volume. */
export function pesoCubado(volume: VolumeValidado): number {
  const cubagemCm3 = volume.altura_cm * volume.largura_cm * volume.comprimento_cm;
  return Math.max(volume.peso_g, (cubagemCm3 / 6000) * 1000);
}
