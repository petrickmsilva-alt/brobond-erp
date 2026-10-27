// ============================================================================
// COMPRAS 3.0 — GUARDA DE HOMOLOGAÇÃO NO CRUD DE PEDIDOS
//
// Vive num módulo próprio (e não em `services.ts` nem em `comprasFornecedor.ts`)
// de propósito: `services.ts` é quem chama a guarda, então importá-la de um
// módulo que dependa de `services` criaria ciclo. Aqui só entram `resources`,
// `errors` e o contrato de store — nenhuma dependência de volta.
//
// REGRA DE NEGÓCIO (não é validação de campo):
// fornecedor SUSPENSO ou BLOQUEADO não recebe pedido NOVO. Pedido existente
// segue o curso — bloquear a história em andamento seria reescrever o passado,
// e o que a homologação controla é a decisão de comprar de novo.
// ============================================================================
import { HttpError } from './errors';
import { getResource } from './resources';
import type { Store, Tx } from './store';

const LABEL: Record<string, string> = {
  pendente: 'Pendente',
  em_analise: 'Em análise',
  homologado: 'Homologado',
  suspenso: 'Suspenso',
  bloqueado: 'Bloqueado',
};

export async function validarFornecedorParaNovoPedido(
  s: Store,
  fornecedorId: number | null,
  empresaId: number,
  tx?: Tx
): Promise<void> {
  if (!fornecedorId) return;
  const r = getResource('fornecedores')!;
  const fornecedor = await s.findOneWhere(r, { id: fornecedorId, empresa_id: empresaId }, tx);
  if (!fornecedor) return; // "não existe / é de outra empresa" já é tratado pela validação de referência
  const status = String(fornecedor.homologacao_status ?? 'pendente');
  if (status === 'suspenso' || status === 'bloqueado') {
    throw new HttpError(
      409,
      `O fornecedor "${String(fornecedor.nome)}" está ${LABEL[status] ?? status} e não pode receber pedido novo. Regularize a homologação em Compras › Fornecedores.`,
      { fornecedor_id: `Homologação: ${LABEL[status] ?? status}` }
    );
  }
}
