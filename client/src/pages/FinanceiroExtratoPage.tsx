import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, EmptyState, PageHeader, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';

type Linha = { id: number; conta_id: number; data: string | null; valor: string | number; direcao: string; descricao: string | null;
  status: string; motivo: string | null; lancamento_id: number | null; baixa_lancamento_id: number | null; fitid: string | null };
type Lista = { total: number; linhas: Linha[] };
const base = '/financeiro/extrato';
export default function FinanceiroExtratoPage({ modo }: { modo: 'lista' | 'detalhe' | 'editar' }) {
  const { id } = useParams(); const navigate = useNavigate();
  const [page, setPage] = useState(1); const [lista, setLista] = useState<Lista | null>(null); const [linha, setLinha] = useState<Linha | null>(null);
  const [lancamento, setLancamento] = useState(''); const [motivo, setMotivo] = useState('');
  const [erro, setErro] = useState(''); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let ativo = true; setLoading(true); setErro(''); setLista(null); setLinha(null);
    const buscar = modo === 'lista' ? api.get<Lista>(`${base}?page=${page}&pageSize=30`) : api.get<{ linha: Linha }>(`${base}/${encodeURIComponent(id || '')}`);
    buscar.then((data) => { if (ativo) { if ('linhas' in data) setLista(data); else setLinha(data.linha); } })
      .catch((e: unknown) => { if (ativo) setErro(e instanceof Error ? e.message : 'Não foi possível carregar o extrato.'); })
      .finally(() => { if (ativo) setLoading(false); });
    return () => { ativo = false; };
  }, [id, modo, page]);
  async function enviar(e: FormEvent, tipo: 'conciliar' | 'divergir') {
    e.preventDefault(); setBusy(true); setErro('');
    try {
      await api.post(`${base}/${id}/${tipo}`, tipo === 'conciliar' ? { lancamento_id: Number(lancamento) } : { motivo });
      navigate(`${base}/${id}`);
    } catch (error) { setErro(error instanceof Error ? error.message : 'Não foi possível salvar.'); }
    finally { setBusy(false); }
  }
  return <div className="min-w-0 space-y-5">
    <PageHeader title={modo === 'lista' ? 'Linhas de extrato' : `Linha de extrato #${id || ''}`}
      description="Confira a identidade e a evidência bancária: valor e data, por si só, não autorizam uma baixa."
      actions={<Link className="btn-secondary" to={modo === 'lista' ? '/financeiro' : base}>{modo === 'lista' ? 'Voltar ao financeiro' : 'Voltar ao extrato'}</Link>} />
    {erro && <Alert tone="red">{erro}</Alert>}
    {loading && <Spinner label="Carregando extrato…" />}
    {modo === 'lista' && lista && <section className="space-y-4 rounded-xl border border-line p-4">
      {lista.linhas.length === 0 ? <EmptyState title="Nenhuma linha encontrada" description="Importe um extrato no financeiro." /> :
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Linhas importadas do extrato</caption>
          <thead><tr><th className="p-2">Linha</th><th className="p-2">Data</th><th className="p-2">Valor</th><th className="p-2">Direção</th><th className="p-2">Situação</th></tr></thead>
          <tbody>{lista.linhas.map((item) => <tr className="border-t border-line" key={item.id}><td className="p-2"><Link className="text-blue-700 underline" to={`${base}/${item.id}`}>#{item.id} · {item.descricao || 'Sem descrição'}</Link></td><td className="p-2">{String(item.data || '—').slice(0, 10)}</td><td className="p-2">{formatMoney(Number(item.valor))}</td><td className="p-2">{item.direcao}</td><td className="p-2">{item.status}</td></tr>)}</tbody>
        </table></div>}
      <nav aria-label="Paginação do extrato" className="flex flex-wrap items-center gap-3"><button className="btn-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button><span>Página {page} · {lista.total} linhas</span><button className="btn-secondary" disabled={page * 30 >= lista.total} onClick={() => setPage(page + 1)}>Próxima</button></nav>
    </section>}
    {linha && <section className="space-y-3 rounded-xl border border-line p-4">
      <p><strong>{linha.descricao || 'Sem descrição'}</strong> · {String(linha.data || 'Sem data').slice(0, 10)}</p>
      <p>{formatMoney(Number(linha.valor))} · {linha.direcao} · conta #{linha.conta_id} · situação {linha.status}</p>
      <p>Identificador bancário: {linha.fitid || 'não informado'} · título: {linha.lancamento_id || 'não vinculado'} · efeito da baixa: {linha.baixa_lancamento_id || 'não identificado'}</p>
      {linha.motivo && <p>Motivo: {linha.motivo}</p>}
      {modo === 'detalhe' && linha.status === 'importada' && <Link className="btn-primary" to={`${base}/${linha.id}/editar`}>Revisar e conciliar</Link>}
      {modo === 'editar' && linha.status === 'importada' && <div className="grid gap-5 md:grid-cols-2">
        <form className="space-y-3" onSubmit={(e) => void enviar(e, 'conciliar')}>
          <p>Confirme a identidade do título. Valores menores são baixas parciais; divergências de taxas exigem revisão.</p>
          <label className="block">ID do lançamento financeiro<input className="input mt-1" type="number" min="1" step="1" required value={lancamento} onChange={(e) => setLancamento(e.target.value)} /></label>
          <button className="btn-primary" disabled={busy}>Confirmar conciliação</button>
        </form>
        <form className="space-y-3" onSubmit={(e) => void enviar(e, 'divergir')}>
          <label className="block">Motivo da divergência<textarea className="input mt-1" required minLength={5} maxLength={500} value={motivo} onChange={(e) => setMotivo(e.target.value)} /></label>
          <button className="btn-secondary" disabled={busy}>Registrar divergência</button>
        </form>
      </div>}
    </section>}
  </div>;
}
