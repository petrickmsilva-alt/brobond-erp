// ============================================================================
// OMS — LEITURA DA TRILHA DE ESTADO DO PEDIDO (migration 0109)
//
// Expõe a linha do tempo de `vendas_status_historico` para um pedido, do mais
// recente para o mais antigo. É o "por que este pedido está neste estado?"
// respondível por tela e por API.
//
// A ESCRITA da trilha acontece nos mesmos pontos que mudam `vendas.status`
// (itens.ts via `aplicarRegrasPedido`, portal, aprovação) — este módulo só lê.
//
// Multiempresa: exige que o pedido pertença à empresa do ator antes de devolver
// qualquer linha; um id de outra empresa responde 404 (não vaza existência).
// ============================================================================
import type { Request, Response } from 'express';
import { getResource } from './resources';
import { checkAccess, getStore } from './services';
import { currentUser } from './auth';
import { assertRegistroDaEmpresa, escopoDoAtor } from './empresa';
import { parseId } from './validate';

const R_VENDA = () => getResource('vendas')!;
const R_HIST = () => getResource('vendas_status_historico')!;

/** GET /api/oms/vendas/:id/status-historico — linha do tempo de estado do pedido. */
export async function historicoStatusVenda(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_HIST(), actor, 'read');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  // A existência do pedido já é escopada: pedido de outra empresa responde 404.
  assertRegistroDaEmpresa(R_VENDA(), await s.get(R_VENDA(), id), escopo);
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
  const out = await s.list(R_HIST(), {
    page: 1,
    pageSize: limit,
    filter: { empresa_id: escopo.empresaId, venda_id: id },
    sort: 'criado_em',
    dir: 'desc',
  });
  res.json(out.rows);
}
