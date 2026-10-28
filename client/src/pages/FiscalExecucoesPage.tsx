import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, FilePlus2, RefreshCw, ShieldAlert } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, PageHeader, Spinner, useToast } from '../components/ui';

type Execucao = {
  id: number; periodo: string; status: 'PENDENTE' | 'EM_PROCESSAMENTO' | 'VALIDADO' | 'ERRO' | 'ENTREGUE' | 'NAO_SUPORTADO';
  started_at: string; finished_at: string; executed_by: number | null; versao: string; execution_hash: string; resultado: string;
};
type Evidencia = { id: number; arquivo_ref: string; hash_sha256: string; tamanho_bytes: number; timestamp: string; resultado: string };

export default function FiscalExecucoesPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const [periodo, setPeriodo] = useState(new Date().toISOString().slice(0, 7));
  const [execucoes, setExecucoes] = useState<Execucao[] | null>(null);
  const [evidencias, setEvidencias] = useState<Record<number, Evidencia[]>>({});
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [form, setForm] = useState({ execucao_id: '', arquivo_ref: '', hash_sha256: '', tamanho_bytes: '' });

  const carregar = useCallback(async () => {
    setErro('');
    try {
      const d = await api.get<{ execucoes: Execucao[] }>(`/fiscal/obrigacoes/${id}/execucoes`);
      setExecucoes(d.execucoes);
      const pairs = await Promise.all(d.execucoes.map(async (e) => [e.id, await api.get<Evidencia[]>(`/fiscal/execucoes/${e.id}/evidencias`)] as const));
      setEvidencias(Object.fromEntries(pairs));
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar o histórico fiscal.');
    }
  }, [id]);
  useEffect(() => { void carregar(); }, [carregar]);

  async function executar() {
    setOcupado(true);
    try {
      const result = await api.post<Execucao & { idempotente: boolean; layout_suportado: boolean }>(`/fiscal/obrigacoes/${id}/execucoes`, { periodo });
      toast.success(result.idempotente ? 'Tentativa existente retornada por idempotência.' : 'Tentativa registrada. Leia o resultado: nenhum leiaute oficial está configurado.');
      await carregar();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Não foi possível registrar a execução.'); }
    finally { setOcupado(false); }
  }

  async function registrarEvidencia() {
    setOcupado(true);
    try {
      await api.post(`/fiscal/execucoes/${form.execucao_id}/evidencias`, {
        arquivo_ref: form.arquivo_ref, hash_sha256: form.hash_sha256, tamanho_bytes: Number(form.tamanho_bytes),
      });
      toast.success('Metadados da evidência registrados; o arquivo não foi validado como leiaute oficial.');
      setForm({ execucao_id: '', arquivo_ref: '', hash_sha256: '', tamanho_bytes: '' });
      await carregar();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Não foi possível registrar a evidência.'); }
    finally { setOcupado(false); }
  }

  if (!execucoes && !erro) return <div className="flex justify-center py-16"><Spinner /></div>;
  return <div className="space-y-4">
    <PageHeader title="Execuções fiscais" description="Histórico imutável por obrigação e competência. O ERP não gera nem valida layout oficial sem fonte oficial configurada." actions={<Link className="btn-secondary" to={`/fiscal/obrigacoes/${id}`}><ArrowLeft className="h-4 w-4" /> Detalhe da obrigação</Link>} />
    {erro && <Alert tone="red">{erro}</Alert>}
    <Alert tone="amber"><ShieldAlert className="mr-2 inline h-4 w-4" />SPED/EFD não suportado nesta instalação: uma tentativa será registrada como NAO_SUPORTADO, sem arquivo ou validação inventados.</Alert>
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold text-slate-800">Registrar tentativa</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm"><span className="label">Período</span><input className="input" type="month" value={periodo} onChange={(e) => setPeriodo(e.target.value)} /></label>
        <button type="button" className="btn-primary" disabled={ocupado} onClick={() => void executar()}><RefreshCw className="h-4 w-4" /> Registrar execução idempotente</button>
      </div>
    </section>
    <section className="card overflow-x-auto">
      <table className="table"><thead><tr><th>ID</th><th>Período</th><th>Status</th><th>Versão</th><th>Hash</th><th>Resultado</th></tr></thead>
        <tbody>{(execucoes ?? []).map((e) => <tr key={e.id}>
          <td>#{e.id}</td><td>{e.periodo}</td><td><Badge tone={e.status === 'ERRO' ? 'red' : e.status === 'NAO_SUPORTADO' ? 'amber' : e.status === 'VALIDADO' || e.status === 'ENTREGUE' ? 'green' : 'amber'}>{e.status}</Badge></td>
          <td>{e.versao}</td><td className="font-mono text-xs">{e.execution_hash}</td><td className="max-w-md whitespace-normal">{e.resultado}</td>
        </tr>)}</tbody>
      </table>
      {!execucoes?.length && <p className="p-5 text-sm text-slate-500">Nenhuma tentativa registrada.</p>}
    </section>
    <section className="card space-y-3 p-4">
      <h2 className="flex items-center gap-2 font-semibold text-slate-800"><FilePlus2 className="h-4 w-4" /> Acrescentar evidência externa</h2>
      <p className="text-sm text-slate-500">Informe referência do arquivo, SHA-256 e tamanho. O registro é append-only e não declara a validade fiscal do conteúdo.</p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm"><span className="label">Execução</span><select className="input" value={form.execucao_id} onChange={(e) => setForm({ ...form, execucao_id: e.target.value })}><option value="">Selecione</option>{(execucoes ?? []).map((e) => <option key={e.id} value={e.id}>#{e.id} · {e.periodo}</option>)}</select></label>
        <label className="text-sm"><span className="label">Referência de arquivo</span><input className="input" value={form.arquivo_ref} onChange={(e) => setForm({ ...form, arquivo_ref: e.target.value })} /></label>
        <label className="text-sm"><span className="label">SHA-256</span><input className="input font-mono" value={form.hash_sha256} onChange={(e) => setForm({ ...form, hash_sha256: e.target.value })} maxLength={64} /></label>
        <label className="text-sm"><span className="label">Tamanho em bytes</span><input className="input" type="number" min="1" value={form.tamanho_bytes} onChange={(e) => setForm({ ...form, tamanho_bytes: e.target.value })} /></label>
      </div>
      <button type="button" className="btn-primary" disabled={ocupado || !form.execucao_id} onClick={() => void registrarEvidencia()}>Registrar evidência</button>
    </section>
    <section className="space-y-3"><h2 className="font-semibold">Evidências por execução</h2>{(execucoes ?? []).map((e) => <article className="card p-4" key={`e-${e.id}`}><h3 className="mb-2 font-medium">Execução #{e.id}</h3>{(evidencias[e.id] ?? []).length ? <ul className="space-y-1 text-sm">{evidencias[e.id].map((ev) => <li key={ev.id} className="break-all">{ev.arquivo_ref} · SHA-256 {ev.hash_sha256} · {ev.tamanho_bytes} bytes · {ev.resultado}</li>)}</ul> : <p className="text-sm text-slate-500">Sem evidências.</p>}</article>)}</section>
  </div>;
}
