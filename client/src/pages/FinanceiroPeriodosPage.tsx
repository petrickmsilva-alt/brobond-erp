import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Alert, EmptyState, PageHeader, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';

type Periodo = { id: number; competencia: string; estado: 'aberto' | 'fechando' | 'fechado'; abrangencia?: 'escrituracao' | 'financeiro'; motivo: string; atualizado_em: string | null };
type Lista = { rows: Periodo[]; total: number; page: number; pageSize: number };
type Pendencias = { extratos: number; repasses: number; liquidacoes: number; operacoes: number; pagamentos_tardios: number };
type Detalhe = { competencia: string; estado: 'aberto' | 'fechando' | 'fechado'; registrado: boolean; periodo: Periodo | null; pendencias?: Pendencias };
const mensagem = (e: unknown) => e instanceof ApiError ? e.message : 'Não foi possível acessar os períodos. Tente novamente.';

export default function FinanceiroPeriodosPage({ modo }: { modo: 'lista' | 'novo' | 'detalhe' | 'reabrir' }) {
  const { competencia: parametro } = useParams();
  const [busca] = useSearchParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [competencia, setCompetencia] = useState(parametro || busca.get('competencia') || new Date().toISOString().slice(0, 7));
  const [motivo, setMotivo] = useState('');
  const [dados, setDados] = useState<Lista | null>(null);
  const [detalhe, setDetalhe] = useState<Detalhe | null>(null);
  const [erro, setErro] = useState('');
  const [bloqueios, setBloqueios] = useState<Pendencias | null>(null);
  const [aguardando, setAguardando] = useState(modo === 'lista' || modo === 'detalhe');
  const [page, setPage] = useState(1);

  useEffect(() => {
    let ativo = true;
    setErro('');
    if (modo !== 'lista' && modo !== 'detalhe') return () => { ativo = false; };
    setAguardando(true);
    const buscar = modo === 'lista'
      ? api.get<Lista>(`/financeiro/periodos?page=${page}`)
      : api.get<Detalhe>(`/financeiro/periodos/${encodeURIComponent(parametro || '')}`);
    buscar.then((result) => {
      if (!ativo) return;
      if (modo === 'lista') setDados(result as Lista);
      else setDetalhe(result as Detalhe);
    }).catch((e: unknown) => { if (ativo) setErro(mensagem(e)); })
      .finally(() => { if (ativo) setAguardando(false); });
    return () => { ativo = false; };
  }, [modo, parametro, page]);

  async function salvar(event: FormEvent) {
    event.preventDefault();
    setErro(''); setBloqueios(null); setAguardando(true);
    try {
      const mes = modo === 'reabrir' ? parametro : competencia;
      await api.post(`/financeiro/periodos/${encodeURIComponent(mes || '')}/${modo === 'reabrir' ? 'reabrir' : 'fechar'}`, { motivo, ...(modo === 'reabrir' ? {} : { abrangencia: 'financeiro' }) });
      navigate(`/financeiro/periodos/${mes}`);
    } catch (e) {
      setErro(mensagem(e));
      if (e instanceof ApiError && e.code === 'CLOSE_BLOCKED' && e.details?.pendencias) setBloqueios(e.details.pendencias as Pendencias);
    } finally { setAguardando(false); }
  }

  return <div className="space-y-5">
    <PageHeader title={modo === 'lista' ? 'Períodos financeiros' : modo === 'novo' ? 'Fechar período' : modo === 'reabrir' ? 'Reabrir período' : `Competência ${parametro || ''}`}
      description="Bloqueia alterações no livro financeiro, extratos e repasses da competência. Fechamentos antigos podem abranger somente escrituração; não substitui o fechamento fiscal."
      actions={<Link className="btn-secondary" to={modo === 'lista' ? '/financeiro/balancete' : '/financeiro/periodos'}>{modo === 'lista' ? 'Voltar ao balancete' : 'Voltar aos períodos'}</Link>} />
    {erro && <Alert tone="red">{erro}</Alert>}
    {bloqueios && <PendenciasDoPeriodo pendencias={bloqueios} />}
    {(modo === 'novo' || modo === 'reabrir') && <form onSubmit={(e) => void salvar(e)} className="space-y-4 rounded-xl border border-line bg-surface p-5">
      <label className="block text-sm font-medium">Competência
        <input className="input mt-1 block w-full max-w-xs" type="month" required value={competencia}
          readOnly={modo === 'reabrir'} onChange={(e) => setCompetencia(e.target.value)} />
      </label>
      <label className="block text-sm font-medium">Motivo da {modo === 'reabrir' ? 'reabertura' : 'ação'}
        <textarea className="input mt-1 block w-full max-w-xl" required minLength={8} maxLength={500} rows={3}
          value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </label>
      <button type="submit" className="btn-primary" disabled={aguardando}>{aguardando ? 'Salvando…' : modo === 'reabrir' ? 'Reabrir período' : 'Fechar período'}</button>
    </form>}
    {modo === 'lista' && <section className="space-y-4 rounded-xl border border-line bg-surface p-5" aria-label="Períodos registrados">
      <Link className="btn-primary" to="/financeiro/periodos/novo">Fechar período</Link>
      {aguardando ? <Spinner label="Carregando períodos…" /> : !dados ? null : dados.rows.length === 0
        ? <EmptyState title="Nenhum período registrado" description="Competências sem registro permanecem abertas." />
        : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Períodos de escrituração registrados</caption>
          <thead><tr><th className="p-2">Competência</th><th className="p-2">Estado</th><th className="p-2">Abrangência</th><th className="p-2">Motivo</th></tr></thead>
          <tbody>{dados.rows.map((item) => <tr key={item.id} className="border-t border-line"><td className="p-2"><Link className="text-primary underline" to={`/financeiro/periodos/${String(item.competencia).slice(0, 7)}`}>{String(item.competencia).slice(0, 7)}</Link></td><td className="p-2">{item.estado}</td><td className="p-2">{item.abrangencia === 'financeiro' ? 'Financeiro' : 'Somente escrituração'}</td><td className="p-2">{item.motivo}</td></tr>)}</tbody>
        </table></div>}
      {dados && dados.total > dados.pageSize && <nav aria-label="Paginação de períodos" className="flex items-center gap-3">
        <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
        <span>Página {page}</span><button type="button" className="btn-secondary" disabled={page * dados.pageSize >= dados.total} onClick={() => setPage(page + 1)}>Próxima</button>
      </nav>}
    </section>}
    {modo === 'detalhe' && (aguardando ? <Spinner label="Carregando período…" /> : detalhe && <section className="space-y-3 rounded-xl border border-line bg-surface p-5">
      <p>Estado do período: <strong>{detalhe.estado}</strong></p>
      {detalhe.registrado && <p>Abrangência: {detalhe.periodo?.abrangencia === 'financeiro' ? 'financeiro' : 'somente escrituração (legado)'}</p>}
      {detalhe.pendencias && <PendenciasDoPeriodo pendencias={detalhe.pendencias} />}
      <p>{detalhe.registrado ? `Motivo: ${detalhe.periodo?.motivo}` : 'Nenhum fechamento registrado para esta competência.'}</p>
      {detalhe.estado === 'fechado' && detalhe.periodo?.abrangencia !== 'financeiro' && <Link className="btn-secondary" to={`/financeiro/periodos/novo?competencia=${encodeURIComponent(detalhe.competencia)}`}>Ampliar para financeiro</Link>}
      {detalhe.estado === 'fechado' && user?.perfil === 'admin' && <Link className="btn-secondary" to={`/financeiro/periodos/${detalhe.competencia}/reabrir`}>Reabrir período</Link>}
      {detalhe.estado === 'aberto' && <Link className="btn-secondary" to="/financeiro/periodos/novo">Fechar período</Link>}
    </section>)}
  </div>;
}

function PendenciasDoPeriodo({ pendencias }: { pendencias: Pendencias }) {
  const itens: [keyof Pendencias, string][] = [
    ['extratos', 'Extratos não conciliados'], ['repasses', 'Repasses pendentes ou divergentes'],
    ['liquidacoes', 'Liquidações pendentes ou divergentes'], ['operacoes', 'Operações de pagamento incertas ou em andamento'],
    ['pagamentos_tardios', 'Pagamentos tardios em revisão'],
  ];
  return <section aria-label="Pendências para fechamento" className="space-y-1 rounded-lg border border-line p-3">
    <h2 className="font-semibold">Pendências para fechamento</h2>
    <p>Itens sem data comprovada e operações incertas também bloqueiam o fechamento.</p>
    <ul>{itens.map(([key, label]) => <li key={key}>{label}: {pendencias[key]}</li>)}</ul>
  </section>;
}
