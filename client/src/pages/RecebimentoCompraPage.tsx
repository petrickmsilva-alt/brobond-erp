// ============================================================================
// COMPRAS — recebimento em PÁGINA PRÓPRIA (`/compras/:id/receber`)
// ----------------------------------------------------------------------------
// ZERO MODAL / ZERO PAINEL TRANSACIONAL: receber uma compra movimenta estoque e
// atualiza custo médio — é transação de módulo, não bloco auxiliar. Por isso a
// tela é uma rota, com o pedido visível ao lado do que vai ser gravado.
//
// Nenhum número é calculado aqui: o impacto projetado vem de
// `POST /compras/:id/receber { previsao: true }`, que roda a MESMA rotina
// canônica de custo (`server/src/custoRecebimento.ts`) dentro de uma transação
// desfeita. O que a tela mostra é o que o servidor vai gravar.
// ============================================================================
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Box } from 'lucide-react';
import RecebimentoCompraForm from '../components/RecebimentoCompraForm';
import { Alert, PageHeader } from '../components/ui';

export default function RecebimentoCompraPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const compraId = Number(id);

  if (!Number.isInteger(compraId) || compraId <= 0) {
    return (
      <div className="space-y-4">
        <PageHeader title="Receber compra" description="Pedido de compra inválido." />
        <Alert tone="red">O identificador do pedido de compra é inválido.</Alert>
        <button className="btn-secondary" onClick={() => navigate('/compras')}>
          Voltar para Compras
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 pb-24 sm:p-6 md:pb-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <Box className="h-5 w-5 text-navy-600" />
            Receber compra #{compraId}
          </span>
        }
        description="Quantidade recebida, custo efetivo e impacto no estoque antes de confirmar. Recebimento parcial não gera conta a pagar; o financeiro nasce quando o pedido fecha."
        actions={
          <button type="button" className="btn btn-secondary" onClick={() => navigate(`/compras/${compraId}`)}>
            <ArrowLeft className="h-4 w-4" /> Voltar ao pedido
          </button>
        }
      />
      <RecebimentoCompraForm
        compraId={compraId}
        onClose={() => navigate(`/compras/${compraId}`)}
        onRecebido={() => navigate(`/compras/${compraId}`)}
      />
    </div>
  );
}
