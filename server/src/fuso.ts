// ============================================================================
// FUSO DO NEGÓCIO — America/Sao_Paulo (Brasília).
//
// O ERP apresenta ao usuário brasileiro o CONCEITO DE DIA CIVIL, SEMANA CIVIL
// E MÊS CIVIL. Antes desta padronização, os agrupamentos do dashboard eram
// feitos em UTC: um faturamento de 31/01 21:00–23:59 (horário de Brasília)
// aparecia no mês seguinte, e a virada de semana/ano era deslocada.
//
// Regras:
//   • o banco CONTINUA armazenando timestamptz (UTC) — nada é convertido na
//     gravação; a correção acontece só na definição dos LIMITES e dos
//     AGRUPAMENTOS das consultas;
//   • SQL (Postgres): `expr AT TIME ZONE 'America/Sao_Paulo'` devolve o
//     timestamp CIVIL (sem fuso) daquele instante — é a base para o
//     date_trunc de mês/semana/dia e para as fronteiras De/Até;
//   • memória (memdb): os helpers JS abaixo fazem a mesma coisa com
//     Intl.DateTimeFormat, garantindo a MESMA semântica nos dois stores.
// ============================================================================

/** Fuso civil usado para dia/semana/mês apresentados ao usuário. */
export const FUSO_NEGOCIO = 'America/Sao_Paulo';

// ---------------------------------------------------------------------------
// SQL (Postgres)
// ---------------------------------------------------------------------------

/**
 * Expressão SQL: timestamptz → timestamp CIVIL em America/Sao_Paulo.
 * Usar dentro de date_trunc('month'|'week'|'day', ...) para agrupar pelo
 * mês/semana/dia civil do usuário brasileiro.
 */
export function sqlCivil(expr: string): string {
  return `(${expr} AT TIME ZONE '${FUSO_NEGOCIO}')`;
}

/**
 * Início do dia civil (00:00:00, horário de Brasília) da data informada,
 * como timestamptz. `refData` é um literal 'YYYY-MM-DD' ou um parâmetro
 * `$n` (ex.: `$1::date` já vem embutido na chamada).
 */
export function sqlInicioDiaCivil(refData: string): string {
  return `timezone('${FUSO_NEGOCIO}', ${refData}::date::timestamp)`;
}

/**
 * Início do dia civil SEGUINTE — o limite EXCLUSIVO do dia informado
 * (meia-noite de Brasília do dia seguinte).
 */
export function sqlFimDiaCivil(refData: string): string {
  return `timezone('${FUSO_NEGOCIO}', (${refData}::date + 1)::timestamp)`;
}

// ---------------------------------------------------------------------------
// JavaScript (memória + testes) — mesma semântica do SQL
// ---------------------------------------------------------------------------

const formatadorPartes = new Intl.DateTimeFormat('en-US', {
  timeZone: FUSO_NEGOCIO,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

const DIA_SEMANA: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export type PartesCivil = {
  ano: number;
  mes: number; // 1–12
  dia: number; // 1–31
  hora: number; // 0–23
  minuto: number;
  segundo: number;
  /** 0 = domingo … 6 = sábado (semana civil começa na segunda). */
  diaSemana: number;
};

function paraData(instante: Date | string | number): Date {
  const d = instante instanceof Date ? instante : new Date(instante);
  if (Number.isNaN(d.getTime())) throw new Error(`Instante inválido para o fuso do negócio: ${String(instante)}`);
  return d;
}

/** Partes do instante no dia civil de America/Sao_Paulo. */
export function partesCivil(instante: Date | string | number): PartesCivil {
  const d = paraData(instante);
  const partes: PartesCivil = { ano: 0, mes: 0, dia: 0, hora: 0, minuto: 0, segundo: 0, diaSemana: 0 };
  for (const p of formatadorPartes.formatToParts(d)) {
    switch (p.type) {
      case 'year':
        partes.ano = Number(p.value);
        break;
      case 'month':
        partes.mes = Number(p.value);
        break;
      case 'day':
        partes.dia = Number(p.value);
        break;
      case 'hour':
        partes.hora = Number(p.value) % 24;
        break;
      case 'minute':
        partes.minuto = Number(p.value);
        break;
      case 'second':
        partes.segundo = Number(p.value);
        break;
      case 'weekday':
        partes.diaSemana = DIA_SEMANA[p.value] ?? 0;
        break;
    }
  }
  return partes;
}

/** "YYYY-MM-DD" do dia civil em America/Sao_Paulo. */
export function diaCivil(instante: Date | string | number): string {
  const p = partesCivil(instante);
  return `${p.ano}-${String(p.mes).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}`;
}

/** "YYYY-MM" do mês civil em America/Sao_Paulo. */
export function mesCivil(instante: Date | string | number): string {
  return diaCivil(instante).slice(0, 7);
}

/** Deslocamento (ms) entre o UTC e o civil de SP no instante (negativo a oeste). */
function deslocamentoCivilMs(instante: Date): number {
  const p = partesCivil(instante);
  const civilInterpretadoComoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return civilInterpretadoComoUtc - instante.getTime();
}

/** Converte um dia civil de SP (ano, mes 1–12, dia) no instante UTC correspondente (00:00 local). */
function civilParaInstante(ano: number, mes: number, dia: number, referencia: Date): Date {
  let chute = new Date(Date.UTC(ano, mes - 1, dia) - deslocamentoCivilMs(referencia));
  // Refinamento: se uma transição de fuso (histórica) mudar o offset entre o
  // chute e o alvo, recalcula uma segunda vez a partir do próprio chute.
  for (let i = 0; i < 2; i++) {
    const p = partesCivil(chute);
    if (p.ano === ano && p.mes === mes && p.dia === dia && p.hora === 0 && p.minuto === 0 && p.segundo === 0) break;
    chute = new Date(Date.UTC(ano, mes - 1, dia) - deslocamentoCivilMs(chute));
  }
  // Trunca os milissegundos: as partes vêm em segundos, então o chute herda
  // os ms do instante de referência (ex.: 03:00:00.554Z). Sem o truncamento,
  // "início do mês menos 1ms" ainda cairia no dia 1 em vez do mês anterior.
  // A resposta verdadeira é sempre um segundo exato (00:00:00 local).
  return new Date(Math.floor(chute.getTime() / 1000) * 1000);
}

/** Início do dia civil (00:00:00, horário de Brasília) que contém o instante. */
export function inicioDiaCivil(instante: Date | string | number): Date {
  const d = paraData(instante);
  const p = partesCivil(d);
  return civilParaInstante(p.ano, p.mes, p.dia, d);
}

/** Fim do dia civil (23:59:59.999, horário de Brasília) que contém o instante. */
export function fimDiaCivil(instante: Date | string | number): Date {
  return new Date(inicioDiaCivil(instante).getTime() + 86_400_000 - 1);
}

/** Início do mês civil (dia 1, 00:00, horário de Brasília). */
export function inicioMesCivil(instante: Date | string | number): Date {
  const d = paraData(instante);
  const p = partesCivil(d);
  return civilParaInstante(p.ano, p.mes, 1, d);
}

/** Início da semana civil (segunda-feira 00:00, horário de Brasília). */
export function inicioSemanaCivil(instante: Date | string | number): Date {
  const d = paraData(instante);
  const p = partesCivil(d);
  const diasDesdeSegunda = (p.diaSemana + 6) % 7; // domingo (0) vira 6; segunda (1) vira 0
  return civilParaInstante(p.ano, p.mes, p.dia - diasDesdeSegunda, d);
}

/** "YYYY-MM-DD" da segunda-feira da semana civil que contém o instante. */
export function chaveSemanaCivil(instante: Date | string | number): string {
  return diaCivil(inicioSemanaCivil(instante));
}

/**
 * Desloca meses no CALENDÁRIO CIVIL (sem fuso): mæs civil de `instante`
 * menos/mais `meses`. Ex.: virada de ano — mesCivil de 2026-01-15 menos 1 mês
 * é 2025-12.
 */
export function deslocarMesCivil(instante: Date | string | number, meses: number): { ano: number; mes: number } {
  const p = partesCivil(instante);
  const total = p.ano * 12 + (p.mes - 1) + meses;
  return { ano: Math.floor(total / 12), mes: (total % 12) + 1 };
}

/** "YYYY-MM" do mês civil deslocado. */
export function mesCivilDeslocado(instante: Date | string | number, meses: number): string {
  const { ano, mes } = deslocarMesCivil(instante, meses);
  return `${ano}-${String(mes).padStart(2, '0')}`;
}
