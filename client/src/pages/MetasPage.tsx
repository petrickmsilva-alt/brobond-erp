// ============================================================================
// METAS (MA-04) — LISTA + ACESSO AO ACOMPANHAMENTO.
//
// A lista é a padrão (CadastroComercialPage: busca, filtros, ordenação,
// paginação, export, exclusão com diagnóstico). O que esta tela acrescenta é o
// atalho para o ACOMPANHAMENTO de cada meta — a tela onde o número de verdade
// aparece.
//
// Regra de ouro: o REALIZADO não é cadastrado. Ele é apurado no servidor a
// partir das vendas faturadas do período (GET /api/comercial/metas/:id/acompanhamento).
// Por isso não existe campo "realizado" no formulário nem coluna editável.
// ============================================================================
import { Link } from 'react-router-dom';
import { LineChart } from 'lucide-react';
import CadastroComercialPage from './CadastroComercialPage';

export default function MetasPage() {
  return (
    <CadastroComercialPage
      recurso="metas"
      acoesLinha={(row) => (
        <Link
          to={`/metas/${row.id}/acompanhamento`}
          className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-navy-900 dark:hover:bg-navy-800"
          title="Acompanhamento (realizado calculado)"
          aria-label={`Acompanhamento da meta ${row.id}`}
        >
          <LineChart className="h-4 w-4" />
        </Link>
      )}
    />
  );
}
