// ============================================================================
// Datas do calendário (dia civil), sem fuso.
//
// O valor de uma data em todo o componente é uma string `AAAA-MM-DD` — o dia
// civil escolhido, não um instante. A aritmética é feita em UTC só para não
// depender do fuso do navegador (um "dia" não pode mudar por causa do fuso).
// ============================================================================

const ISO_DIA = /^(\d{4})-(\d{2})-(\d{2})$/;

export type DiaCivil = { ano: number; mes: number; dia: number };

/** Lê `AAAA-MM-DD` e devolve o dia civil, ou null se for inválido/inexistente. */
export function lerDia(iso: string | null | undefined): DiaCivil | null {
  if (!iso) return null;
  const m = ISO_DIA.exec(iso);
  if (!m) return null;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return { ano, mes, dia };
}

/** Dia civil → `AAAA-MM-DD`. */
export function paraIso(d: DiaCivil): string {
  return `${String(d.ano).padStart(4, '0')}-${String(d.mes).padStart(2, '0')}-${String(d.dia).padStart(2, '0')}`;
}

/** Soma `n` dias (negativo volta) a um dia civil. */
export function somarDias(iso: string, n: number): string {
  const d = lerDia(iso);
  if (!d) throw new Error(`Data inválida: ${iso}`);
  const base = Date.UTC(d.ano, d.mes - 1, d.dia) + n * 86_400_000;
  const x = new Date(base);
  return paraIso({ ano: x.getUTCFullYear(), mes: x.getUTCMonth() + 1, dia: x.getUTCDate() });
}

/** Soma `n` meses, mantendo o dia quando possível (31/jan + 1 mês = 28/29 fev). */
export function somarMeses(iso: string, n: number): string {
  const d = lerDia(iso);
  if (!d) throw new Error(`Data inválida: ${iso}`);
  const total = d.ano * 12 + (d.mes - 1) + n;
  const ano = Math.floor(total / 12);
  const mes = (total % 12) + 1;
  const ultimo = diasNoMes(ano, mes);
  return paraIso({ ano, mes, dia: Math.min(d.dia, ultimo) });
}

/** Dias de um mês (1–12) de um ano. */
export function diasNoMes(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

/** Dia da semana: 0 = domingo … 6 = sábado. */
export function diaDaSemana(iso: string): number {
  const d = lerDia(iso);
  if (!d) throw new Error(`Data inválida: ${iso}`);
  return new Date(Date.UTC(d.ano, d.mes - 1, d.dia)).getUTCDay();
}

/** `AAAA-MM-DD` → `DD/MM/AAAA` (formato de exibição pt-BR). Vazio se inválido. */
export function formatarDiaBR(iso: string | null | undefined): string {
  const d = lerDia(iso);
  if (!d) return '';
  return `${String(d.dia).padStart(2, '0')}/${String(d.mes).padStart(2, '0')}/${d.ano}`;
}

const NOME_DIA_LONGO = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const NOME_MES = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Descrição completa para leitores de tela: "terça-feira, 8 de outubro de 2026". */
export function descreverDiaBR(iso: string): string {
  const d = lerDia(iso);
  if (!d) return '';
  return NOME_DIA_LONGO.format(new Date(Date.UTC(d.ano, d.mes - 1, d.dia)));
}

/** Nome do mês e ano para o cabeçalho do calendário: "outubro de 2026". */
export function nomeDoMesBR(ano: number, mes: number): string {
  return NOME_MES.format(new Date(Date.UTC(ano, mes - 1, 1)));
}

/** Valida um intervalo De/Até. Retorna a mensagem de erro, ou null se válido. */
export function validarIntervalo(de: string | null | undefined, ate: string | null | undefined): string | null {
  if (!de || !ate) return null;
  if (!lerDia(de)) return 'Data inicial inválida.';
  if (!lerDia(ate)) return 'Data final inválida.';
  if (de > ate) return 'A data inicial é posterior à data final.';
  return null;
}
