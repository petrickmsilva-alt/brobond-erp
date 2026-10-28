import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, FileClock } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, PageHeader, Spinner } from '../components/ui';

type Obrigacao = { id: number; codigo: string; nome: string; tipo: string; periodicidade: string; dia_vencimento: number; responsavel_id__label?: string | null; ativo: boolean };
export default function FiscalObrigacaoDetalhePage() {
  const { id = '' } = useParams();
  const [row, setRow] = useState<Obrigacao | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api.get<Obrigacao>(`/fiscal_obrigacoes/${id}`).then((data) => { if (active) setRow(data); }).catch((e) => { if (active) setError(e instanceof ApiError ? e.message : 'Obrigação não encontrada.'); });
    return () => { active = false; };
  }, [id]);
  if (error) return <Alert tone="red">{error}</Alert>;
  if (!row) return <div className="flex justify-center py-16"><Spinner /></div>;
  return <div className="space-y-4">
    <PageHeader title={row.nome} description={`Obrigação ${row.codigo} · ${row.tipo}`} actions={<Link className="btn-secondary" to="/fiscal/obrigacoes"><ArrowLeft className="h-4 w-4" /> Obrigações</Link>} />
    <section className="card grid gap-4 p-5 sm:grid-cols-2">
      <div><p className="text-xs uppercase text-slate-500">Periodicidade</p><p className="font-medium">{row.periodicidade}</p></div>
      <div><p className="text-xs uppercase text-slate-500">Dia do vencimento</p><p className="font-medium">Dia {row.dia_vencimento} do mês seguinte à competência</p></div>
      <div><p className="text-xs uppercase text-slate-500">Responsável</p><p className="font-medium">{row.responsavel_id__label || 'Não definido'}</p></div>
      <div><p className="text-xs uppercase text-slate-500">Situação</p><p className="font-medium">{row.ativo ? 'Ativa' : 'Inativa'}</p></div>
    </section>
    <Link to={`/fiscal/obrigacoes/${row.id}/execucoes`} className="card flex items-center gap-3 p-5 font-medium text-brand-700 hover:bg-brand-50"><FileClock className="h-5 w-5" />Abrir histórico de execuções e evidências fiscais</Link>
    <Alert tone="blue">Leiautes SPED/EFD são tratados como não suportados quando não há fonte oficial configurada. Nenhum registro ou regra fiscal é fabricado.</Alert>
  </div>;
}
