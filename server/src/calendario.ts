// ============================================================================
// CALENDÁRIO PRODUTIVO (migration 0062 — P2-15)
//
// POR QUE ESTE MÓDULO EXISTE
// --------------------------
// Contar dia útil como "seg–sex" infla a capacidade em toda semana com feriado.
// Capacidade inflada esconde gargalo e faz prometer prazo que não fecha. Aqui a
// contagem desconta os feriados que a EMPRESA cadastrou.
//
// REGRAS
// ------
//   • Feriado `recorrente` vale todo ano no mesmo dia/mês (25/12, 01/01);
//   • feriado NÃO recorrente vale só na data cadastrada;
//   • feriado móvel (Carnaval, Sexta-feira Santa, Corpus Christi) NUNCA é
//     derivado por cálculo: se não estiver cadastrado, o dia conta como útil.
//     Derivar Páscoa e inventar calendário municipal seria pior que não ter;
//   • feriado inativo é ignorado;
//   • empresa sem feriado cadastrado = comportamento anterior (seg–sex), e a
//     resposta diz isso em `feriados_considerados: 0`.
//
// A leitura nunca "conserta" dado: a resposta devolve a LISTA de feriados que
// entraram no cálculo, para o número ser auditável.
// ============================================================================
import { getResource } from './resources';
import { listarTodos } from './paginacaoCompleta';

const R_FERIADO = () => getResource('feriados')!;

export type Feriado = {
  id: number;
  data: string;
  nome: string;
  tipo: string;
  recorrente: boolean;
};

export type CalendarioPeriodo = {
  de: string;
  ate: string;
  dias_corridos: number;
  fins_de_semana: number;
  feriados: Feriado[];
  feriados_considerados: number;
  dias_uteis: number;
};

/** Lista de datas (AAAA-MM-DD) entre duas datas, inclusive. */
export function diasEntre(de: string, ate: string): string[] {
  const out: string[] = [];
  const d = new Date(`${de}T12:00:00Z`);
  const fim = new Date(`${ate}T12:00:00Z`);
  while (d.getTime() <= fim.getTime()) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export const ehFimDeSemana = (dia: string): boolean => {
  const dow = new Date(`${dia}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
};

/**
 * Feriados que atingem o período — inclui os recorrentes de qualquer ano
 * cadastrado (o dia/mês é o que vale) e os pontuais dentro da janela.
 */
export async function feriadosDoPeriodo(empresaId: number, de: string, ate: string): Promise<Feriado[]> {
  const rows = await listarTodos(R_FERIADO(), { empresa_id: empresaId, ativo: true }, undefined, { sort: 'id', dir: 'asc' });
  const dias = new Set(diasEntre(de, ate));
  const achados: Feriado[] = [];
  for (const linha of rows) {
    const dataISO = String(linha.data ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataISO)) continue;
    const recorrente = linha.recorrente === true;
    const diaMes = dataISO.slice(5);
    const ocorrencias = recorrente ? [...dias].filter((d) => d.slice(5) === diaMes) : dias.has(dataISO) ? [dataISO] : [];
    for (const data of ocorrencias) achados.push({
      id: Number(linha.id),
      // One occurrence per calendar year in the requested interval.
      data,
      nome: String(linha.nome ?? 'Feriado'),
      tipo: String(linha.tipo ?? 'nacional'),
      recorrente,
    });
  }
  return achados.sort((a, b) => a.data.localeCompare(b.data));
}

/** Calendário completo do período: dias corridos, fins de semana, feriados, úteis. */
export async function calendarioDoPeriodo(empresaId: number, de: string, ate: string): Promise<CalendarioPeriodo> {
  const dias = diasEntre(de, ate);
  const feriados = await feriadosDoPeriodo(empresaId, de, ate);
  const diasFeriado = new Set(feriados.map((f) => f.data));
  const fins = dias.filter(ehFimDeSemana);
  const uteis = dias.filter((d) => !ehFimDeSemana(d) && !diasFeriado.has(d));
  return {
    de,
    ate,
    dias_corridos: dias.length,
    fins_de_semana: fins.length,
    feriados,
    feriados_considerados: feriados.length,
    dias_uteis: uteis.length,
  };
}

/** Atalho: quantos dias úteis (já sem feriados) existem no período. */
export async function diasUteis(empresaId: number, de: string, ate: string): Promise<number> {
  return (await calendarioDoPeriodo(empresaId, de, ate)).dias_uteis;
}
