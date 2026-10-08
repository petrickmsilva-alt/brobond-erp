// ============================================================================
// Período do Dashboard ("Meu Negócio").
//
// Calcula a janela atual e a janela ANTERIOR de mesma duração, em datas de
// calendário YYYY-MM-DD (sem horas, para não sofrer com horário de verão).
// O servidor filtra por dia (De/Até) em UTC; a comparação usa a mesma regra,
// então as duas janelas ficam alinhadas.
// ============================================================================

export type PresetPeriodo = '7d' | '30d' | 'mes' | '90d' | 'personalizado';

export const PRESETS_PERIODO: { key: PresetPeriodo; label: string }[] = [
  { key: '7d', label: 'Últimos 7 dias' },
  { key: '30d', label: 'Últimos 30 dias' },
  { key: 'mes', label: 'Mês atual' },
  { key: '90d', label: 'Últimos 90 dias' },
  { key: 'personalizado', label: 'Personalizado' },
];

export type Janela = {
  de: string;
  ate: string;
  prevDe: string;
  prevAte: string;
  dias: number;
};

const DIA_MS = 86_400_000;

/** Data de calendário local → "YYYY-MM-DD". */
export function dataISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dia}`;
}

/** "YYYY-MM-DD" → número de dias desde 1970-01-01 (aritmética sem fuso). */
function diaNumero(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DIA_MS);
}

function deNumero(n: number): string {
  const d = new Date(n * DIA_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dia = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dia}`;
}

export function deslocar(iso: string, dias: number): string {
  return deNumero(diaNumero(iso) + dias);
}

/** Quantidade de dias de um intervalo fechado [de, ate]. */
export function diasEntre(de: string, ate: string): number {
  return diaNumero(ate) - diaNumero(de) + 1;
}

/**
 * Janela do período escolhido. `hoje` é injetado para testes.
 * Retorna null para intervalo personalizado inválido (De depois de Até).
 */
export function janelaDoPeriodo(preset: PresetPeriodo, hoje: Date, custom?: { de: string; ate: string }): Janela | null {
  const fim = dataISO(hoje);
  let de: string;
  let ate = fim;

  if (preset === 'personalizado') {
    if (!custom?.de || !custom.ate || custom.de > custom.ate) return null;
    de = custom.de;
    ate = custom.ate;
  } else if (preset === 'mes') {
    de = dataISO(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
  } else {
    const dias = preset === '7d' ? 7 : preset === '90d' ? 90 : 30;
    de = deslocar(fim, -(dias - 1));
  }

  const dias = diasEntre(de, ate);
  const prevAte = deslocar(de, -1);
  const prevDe = deslocar(prevAte, -(dias - 1));
  return { de, ate, prevDe, prevAte, dias };
}

/** Variação percentual. null quando não há base (anterior = 0) — nunca inventa 100%. */
export function variacaoPct(atual: number, anterior: number): number | null {
  if (!Number.isFinite(atual) || !Number.isFinite(anterior) || anterior === 0) return null;
  return ((atual - anterior) / Math.abs(anterior)) * 100;
}
