// ============================================================
// Workflow de Aprovação — operador cria, gerente/admin aprova.
//
// Aplicável a:
//   • Vendas acima de um valor limite (APPROVAL_VENDA_LIMITE)
//   • Compras acima de um valor limite (APPROVAL_COMPRA_LIMITE)
//   • Descontos acima de X% (APPROVAL_DESCONTO_MAX)
//   • Exclusão de registros (operador não pode; já bloqueado)
//
// Fluxo:
//   1. Operador cria pedido → status = "pendente_aprovacao"
//   2. Gerente/Admin vê na fila de aprovação
//   3. Gerente aprova → status muda para "aberta" (ou faturada direto)
//   4. Gerente rejeita → status muda para "cancelada" com motivo
//
// GET  /api/aprovacoes              — lista pendentes (gerente/admin)
// POST /api/aprovacoes/:id/aprovar  — aprova pedido
// POST /api/aprovacoes/:id/rejeitar — rejeita pedido (com motivo)
// ============================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore, podeComercial, toHttpError } from './services';
import { assertRegistroDaEmpresa, escopoDoAtor, empresaDoRegistroAudit } from './empresa';
import { currentUser, requireAuth } from './auth';
import type { AuthUser } from './auth';
import type { Row, Tx } from './store';
import { parseId } from './validate';
import { labelOf } from './store';

const fmtMoney = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Verifica se o pedido precisa de aprovação. */
export function precisaAprovacao(tipo: 'venda' | 'compra', total: number, descontoPct?: number): boolean {
  const limiteVenda = Number(process.env.APPROVAL_VENDA_LIMITE) || 0;
  const limiteCompra = Number(process.env.APPROVAL_COMPRA_LIMITE) || 0;
  const descontoMax = Number(process.env.APPROVAL_DESCONTO_MAX) || 0;

  if (tipo === 'venda') {
    if (limiteVenda > 0 && total > limiteVenda) return true;
  } else {
    if (limiteCompra > 0 && total > limiteCompra) return true;
  }

  if (descontoMax > 0 && descontoPct && descontoPct > descontoMax) return true;

  return false;
}

/** Retorna se um perfil pode aprovar pedidos. */
export function podeAprovar(perfilOuUsuario: string | AuthUser): boolean {
  if (typeof perfilOuUsuario === 'string') return perfilOuUsuario === 'admin' || perfilOuUsuario === 'gerente';
  return podeComercial(perfilOuUsuario, 'aprovar');
}


/**
 * Verifica se o pedido deve ir para "pendente_aprovacao" em vez de "aberta".
 * Chamada pelo services.ts ao criar venda/compra quando o usuário é operador.
 */
export async function verificarAprovacaoCriacao(
  tipo: 'venda' | 'compra',
  data: Record<string, unknown>,
  perfil: string
): Promise<{ precisa: boolean; statusFinal: string }> {
  // Admin/gerente nunca precisa de aprovação
  if (podeAprovar(perfil)) return { precisa: false, statusFinal: String(data.status || 'aberta') };

  const total = Number(data.total || 0);
  const desconto = Number(data.desconto || 0);
  const descontoPct = total > 0 ? (desconto / total) * 100 : 0;

  if (precisaAprovacao(tipo, total, descontoPct)) {
    return { precisa: true, statusFinal: 'pendente_aprovacao' };
  }

  return { precisa: false, statusFinal: String(data.status || 'aberta') };
}

// ----------------------------------------------------------------------------
// Rotas
// ----------------------------------------------------------------------------

/** GET /api/aprovacoes — lista pedidos pendentes de aprovação. */
export async function listAprovacoes(req: Request, res: Response) {
  const actor = currentUser(req);
  if (!podeAprovar(actor)) {
    throw new HttpError(403, 'Apenas gerentes e administradores podem ver a fila de aprovação.');
  }

  const s = getStore();
  // MULTIEMPRESA: a fila é da empresa ativa. Sem este filtro o gerente de uma
  // empresa via — e podia aprovar — os pedidos pendentes das outras.
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const tipo = typeof req.query.tipo === 'string' ? req.query.tipo : undefined; // 'venda' | 'compra' | undefined (ambos)

  const resultados: Row[] = [];

  const buscar = async (resourceKey: string) => {
    const r = getResource(resourceKey)!;
    const lista = await s.list(r, { page: 1, pageSize: 200, sort: 'criado_em', dir: 'desc', filter: { status: 'pendente_aprovacao', empresa_id: escopo.empresaId } });
    for (const row of lista.rows) {
      resultados.push({
        ...row,
        __tipo: resourceKey === 'vendas' ? 'venda' : 'compra',
        __label: labelOf(r, row),
      });
    }
  };

  if (!tipo || tipo === 'venda') await buscar('vendas');
  if (!tipo || tipo === 'compra') await buscar('compras');

  // Ordena por data (mais recente primeiro)
  resultados.sort((a, b) => String(b.criado_em || '').localeCompare(String(a.criado_em || '')));

  res.json(resultados);
}

/** POST /api/aprovacoes/:id/aprovar — aprova pedido. */
export async function aprovarPedido(req: Request, res: Response) {
  const actor = currentUser(req);
  if (!podeAprovar(actor)) {
    throw new HttpError(403, 'Apenas gerentes e administradores podem aprovar pedidos.');
  }

  const s = getStore();
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const tipo = String(req.params.tipo || req.body.tipo || 'venda'); // 'venda' ou 'compra'
  const resourceKey = tipo === 'compra' ? 'compras' : 'vendas';
  const r = getResource(resourceKey)!;
  const id = parseId(req.params.id);

  // 404 (e não 403): dizer "não encontrado" é o que impede a empresa A de
  // descobrir que o id existe na empresa B.
  const pedido = assertRegistroDaEmpresa(r, await s.get(r, id), escopo);
  if (String(pedido.status) !== 'pendente_aprovacao') {
    throw new HttpError(409, 'Este pedido não está pendente de aprovação.');
  }

  const s2 = getStore();
  await s2.transaction(async (tx) => {
    await s2.update(r, id, { status: 'aberta', atualizado_em: new Date().toISOString() }, tx);
    await s2.audit({
      usuario_id: actor.id,
      usuario: actor.name,
      acao: 'editar',
      recurso: resourceKey,
      registro_id: id,
      descricao: `${r.singular} #${id} APROVADO por ${actor.name} (valor: R$ ${fmtMoney(Number(pedido.total || 0))})`,
      empresa_id: empresaDoRegistroAudit(r, pedido, actor),
      dados: { acao: 'aprovar', aprovador: actor.name },
    }, tx);
  });

  res.json({ ok: true, message: `${r.singular} #${id} aprovado com sucesso.` });
}

/** POST /api/aprovacoes/:id/rejeitar — rejeita pedido com motivo. */
export async function rejeitarPedido(req: Request, res: Response) {
  const actor = currentUser(req);
  if (!podeAprovar(actor)) {
    throw new HttpError(403, 'Apenas gerentes e administradores podem rejeitar pedidos.');
  }

  const s = getStore();
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const tipo = String(req.params.tipo || req.body.tipo || 'venda');
  const resourceKey = tipo === 'compra' ? 'compras' : 'vendas';
  const r = getResource(resourceKey)!;
  const id = parseId(req.params.id);
  const motivo = String(req.body?.motivo || '').trim();

  if (!motivo) throw new HttpError(400, 'Informe o motivo da rejeição.', { motivo: 'Campo obrigatório' });

  const pedido = assertRegistroDaEmpresa(r, await s.get(r, id), escopo);
  if (String(pedido.status) !== 'pendente_aprovacao') {
    throw new HttpError(409, 'Este pedido não está pendente de aprovação.');
  }

  const statusCancelado = tipo === 'compra' ? 'cancelado' : 'cancelada';
  await s.transaction(async (tx) => {
    await s.update(r, id, {
      status: statusCancelado,
      observacoes: pedido.observacoes
        ? `${pedido.observacoes}\n\n[REJEITADO por ${actor.name}: ${motivo}]`
        : `[REJEITADO por ${actor.name}: ${motivo}]`,
      atualizado_em: new Date().toISOString(),
    }, tx);
    await s.audit({
      usuario_id: actor.id,
      usuario: actor.name,
      acao: 'editar',
      recurso: resourceKey,
      registro_id: id,
      descricao: `${r.singular} #${id} REJEITADO por ${actor.name}: ${motivo}`,
      dados: { acao: 'rejeitar', motivo, rejeitado_por: actor.name },
      empresa_id: empresaDoRegistroAudit(r, pedido, actor),
    }, tx);
  });

  res.json({ ok: true, message: `${r.singular} #${id} rejeitado.` });
}

/** GET /api/aprovacoes/count — conta pendentes (para badge no menu). */
export async function countAprovacoes(req: Request, res: Response) {
  const actor = currentUser(req);
  if (!podeAprovar(actor)) return res.json({ count: 0 });

  const s = getStore();
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const [vendas, compras] = await Promise.all([
    s.countWhere(getResource('vendas')!, { status: 'pendente_aprovacao', empresa_id: escopo.empresaId }),
    s.countWhere(getResource('compras')!, { status: 'pendente_aprovacao', empresa_id: escopo.empresaId }),
  ]);

  res.json({ vendas, compras, total: vendas + compras });
}
