import { RESOURCES } from './resources';
import { getStore } from './services';
import type { Row } from './store';

export type PoliticaAplicada = {
  id: number; nome: string; escopo: string; desconto_pct: number; pedido_min_valor: number;
  pedido_min_pecas: number; produto_min_qtd: number; multiplo_qtd: number; reserva_horas: number;
};

const peso: Record<string, number> = { geral: 0, canal: 1, colecao: 2, catalogo: 3, cliente: 4 };
const num = (v: unknown, padrao = 0) => Number.isFinite(Number(v)) ? Number(v) : padrao;
const dia = () => new Date().toISOString().slice(0, 10);

/** Resolve uma única política, de modo determinístico e explicável. */
export async function resolverPoliticaComercial(ctx: { catalogo: Row; clienteId?: number | null; canal: string }): Promise<PoliticaAplicada | null> {
  const rows = (await getStore().list(RESOURCES.politicas_comerciais, { page: 1, pageSize: 5000 })).rows;
  const hoje = dia();
  const validas = rows.filter((p) => {
    if (p.ativo === false || (p.inicio_em && String(p.inicio_em).slice(0, 10) > hoje) || (p.fim_em && String(p.fim_em).slice(0, 10) < hoje)) return false;
    const canalOk = !p.canal || p.canal === 'todos' || p.canal === ctx.canal;
    if (!canalOk) return false;
    if (p.escopo === 'cliente') return !!ctx.clienteId && Number(p.cliente_id) === Number(ctx.clienteId);
    if (p.escopo === 'catalogo') return Number(p.catalogo_id) === Number(ctx.catalogo.id);
    if (p.escopo === 'colecao') return !!ctx.catalogo.colecao_id && Number(p.colecao_id) === Number(ctx.catalogo.colecao_id);
    if (p.escopo === 'canal') return !!p.canal && p.canal !== 'todos';
    return p.escopo === 'geral';
  }).sort((a, b) => (peso[String(b.escopo)] ?? -1) - (peso[String(a.escopo)] ?? -1) || num(b.prioridade) - num(a.prioridade) || Number(b.id) - Number(a.id));
  const p = validas[0];
  return p ? { id: Number(p.id), nome: String(p.nome), escopo: String(p.escopo), desconto_pct: num(p.desconto_pct), pedido_min_valor: num(p.pedido_min_valor), pedido_min_pecas: num(p.pedido_min_pecas), produto_min_qtd: num(p.produto_min_qtd), multiplo_qtd: Math.max(1, num(p.multiplo_qtd, 1)), reserva_horas: num(p.reserva_horas) } : null;
}

export function precoComPolitica(preco: number, politica: PoliticaAplicada | null): number {
  return Math.round(preco * (1 - (politica?.desconto_pct || 0) / 100) * 100) / 100;
}
