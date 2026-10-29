// ============================================================================
// COMMERCE OS — pedaços compartilhados das telas operacionais.
// Vocabulary espelha o servidor (server/src/commerce/regras.ts): qualquer
// rótulo/estado novo nasce lá e é copiado aqui — nunca inventado na tela.
// ============================================================================
import type { ReactNode } from 'react';
import { Badge } from '../../components/ui';
import { formatMoney, formatDate } from '../../lib/format';

export const CANAIS_PUBLICACAO = [
  { valor: 'BROBOND', rotulo: 'Loja própria' },
  { valor: 'MERCADOLIVRE', rotulo: 'Mercado Livre' },
  { valor: 'NUVEMSHOP', rotulo: 'Nuvemshop' },
  { valor: 'WOOCOMMERCE', rotulo: 'WooCommerce' },
  { valor: 'INSTAGRAM_SHOPPING', rotulo: 'Instagram Shopping' },
] as const;

export const CANAIS_PEDIDO = [
  { valor: 'BROBOND', rotulo: 'Loja própria' },
  { valor: 'MERCADOLIVRE', rotulo: 'Mercado Livre' },
  { valor: 'NUVEMSHOP', rotulo: 'Nuvemshop' },
  { valor: 'MERCADOPAGO', rotulo: 'Mercado Pago' },
  { valor: 'INSTAGRAM_SHOPPING', rotulo: 'Instagram Shopping' },
  { valor: 'WOOCOMMERCE', rotulo: 'WooCommerce' },
] as const;

type Tone = 'slate' | 'blue' | 'amber' | 'green' | 'red';

export const TONE_PUBLICACAO: Record<string, Tone> = {
  DRAFT: 'slate',
  READY: 'blue',
  QUEUED: 'blue',
  PUBLISHING: 'amber',
  PUBLISHED: 'green',
  UPDATE_QUEUED: 'amber',
  ERROR: 'red',
  REJECTED: 'red',
  UNPUBLISHED: 'slate',
};

export const ROTULO_PUBLICACAO: Record<string, string> = {
  DRAFT: 'Rascunho',
  READY: 'Pronta',
  QUEUED: 'Na fila',
  PUBLISHING: 'Publicando',
  PUBLISHED: 'Publicada',
  UPDATE_QUEUED: 'Atualização na fila',
  ERROR: 'Erro',
  REJECTED: 'Não suportada',
  UNPUBLISHED: 'Despublicada',
};

export const TONE_PEDIDO: Record<string, Tone> = {
  AGUARDANDO_PAGAMENTO: 'amber',
  PAGAMENTO_AUTORIZADO: 'blue',
  PAGO: 'green',
  AGUARDANDO_CORRECAO: 'red',
  CONVERTIDO: 'green',
  CANCELADO: 'slate',
  EXPIRADO: 'slate',
  ESTORNADO: 'red',
  ERRO: 'red',
};

export const ROTULO_PEDIDO: Record<string, string> = {
  AGUARDANDO_PAGAMENTO: 'Aguardando pagamento',
  PAGAMENTO_AUTORIZADO: 'Pagamento autorizado',
  PAGO: 'Pago',
  AGUARDANDO_CORRECAO: 'Aguardando correção',
  CONVERTIDO: 'Convertido em venda',
  CANCELADO: 'Cancelado',
  EXPIRADO: 'Expirado',
  ESTORNADO: 'Estornado',
  ERRO: 'Erro',
};

export const TONE_PAGAMENTO: Record<string, Tone> = {
  PENDING: 'amber',
  AUTHORIZED: 'blue',
  APPROVED: 'green',
  REJECTED: 'red',
  CANCELLED: 'slate',
  REFUNDED: 'red',
  CHARGEBACK: 'red',
  EXPIRED: 'slate',
};

export const ROTULO_PAGAMENTO: Record<string, string> = {
  PENDING: 'Pendente',
  AUTHORIZED: 'Autorizado',
  APPROVED: 'Aprovado',
  REJECTED: 'Recusado',
  CANCELLED: 'Cancelado',
  REFUNDED: 'Estornado',
  CHARGEBACK: 'Chargeback',
  EXPIRED: 'Expirado',
};

export const TONE_OUTBOX: Record<string, Tone> = {
  PENDENTE: 'amber',
  PROCESSANDO: 'blue',
  PROCESSADO: 'green',
  ERRO: 'red',
};

export const TONE_RASTREIO: Record<string, Tone> = {
  postado: 'blue',
  em_transito: 'amber',
  saiu_entrega: 'amber',
  entregue: 'green',
  devolvido: 'slate',
  extraviado: 'red',
};

export const ROTULO_RASTREIO: Record<string, string> = {
  postado: 'Postado',
  em_transito: 'Em trânsito',
  saiu_entrega: 'Saiu para entrega',
  entregue: 'Entregue',
  devolvido: 'Devolvido',
  extraviado: 'Extraviado',
  enviado_sem_rastreio: 'Enviado sem rastreio',
  aguardando_envio: 'Aguardando envio',
};

export function rotuloCanal(valor: string): string {
  return (
    CANAIS_PUBLICACAO.find((c) => c.valor === valor)?.rotulo ??
    CANAIS_PEDIDO.find((c) => c.valor === valor)?.rotulo ??
    valor
  );
}

export function EstadoBadge({ estado, mapa, rotulos }: { estado: string; mapa: Record<string, Tone>; rotulos: Record<string, string> }) {
  return <Badge tone={mapa[estado] ?? 'slate'}>{rotulos[estado] ?? estado}</Badge>;
}

/** Valor monetário sem fingir dado: vazio real vira traço honesto. */
export function grana(valor: number | null | undefined): string {
  if (valor === null || valor === undefined || Number.isNaN(Number(valor))) return '—';
  return formatMoney(valor);
}

export function dataHora(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${formatDate(d)} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Caixa de métrica com valor REAL (0 é número; `null` é indisponível). */
export function Metrica({ rotulo, valor, nota, tom }: { rotulo: string; valor: ReactNode; nota?: ReactNode; tom?: 'green' | 'amber' | 'red' }) {
  const cor = tom === 'green' ? 'text-success' : tom === 'amber' ? 'text-warning' : tom === 'red' ? 'text-danger' : 'text-ink';
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-xs uppercase tracking-wide text-muted">{rotulo}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${cor}`}>{valor}</div>
      {nota != null && <div className="mt-1 text-xs text-muted">{nota}</div>}
    </div>
  );
}
