// ============================================================================
// WEBHOOKS — cadastro e edição em PÁGINA PRÓPRIA
// ----------------------------------------------------------------------------
// ZERO MODAL / ZERO PAINEL TRANSACIONAL: criar (`/webhooks/novo`) e editar
// (`/webhooks/:id/editar`) são páginas. A listagem apenas navega.
//
// Exceções legítimas preservadas, porque são infraestrutura de segurança e não
// fluxo de módulo:
//   • reautenticação (step-up) antes de gravar — ReauthModal;
//   • o SEGREDO HMAC aparece UMA ÚNICA VEZ, aqui nesta página, depois de criar
//     ou regenerar. Ele não é recuperável: o servidor só devolve o hash.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Copy, Loader2, Plus, Save } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { Alert, PageHeader, Spinner, useToast } from '../components/ui';
import ReauthModal from '../components/ReauthModal';

type Webhook = {
  id: number;
  nome: string;
  url: string;
  eventos: string[];
  ativo: boolean;
  tem_segredo: boolean;
};

type EventoInfo = { id: string; label: string };

type FormWebhook = { id?: number; nome: string; url: string; eventos: string[]; ativo: boolean; regenerar?: boolean };

const FORM_VAZIO: FormWebhook = { nome: '', url: '', eventos: [], ativo: true };

export default function WebhookFormPage({ modo = 'novo' }: { modo?: 'novo' | 'editar' }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { id } = useParams();

  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [form, setForm] = useState<FormWebhook>(FORM_VAZIO);
  const [eventos, setEventos] = useState<EventoInfo[]>([]);
  const [formErro, setFormErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [reauth, setReauth] = useState<{ titulo: string } | null>(null);
  const [segredo, setSegredo] = useState<{ nome: string; valor: string } | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const d = await api.get<{ webhooks: Webhook[]; eventos_disponiveis: EventoInfo[] }>('/webhooks');
      setEventos(d.eventos_disponiveis || []);
      if (modo === 'editar') {
        const alvo = (d.webhooks || []).find((w) => Number(w.id) === Number(id));
        if (!alvo) {
          setErro('Webhook não encontrado nesta empresa.');
          return;
        }
        setForm({ id: alvo.id, nome: alvo.nome, url: alvo.url, eventos: [...alvo.eventos], ativo: alvo.ativo });
      }
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os webhooks.');
    } finally {
      setCarregando(false);
    }
  }, [id, modo]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  function toggleEvento(eventoId: string) {
    setForm((f) => ({
      ...f,
      eventos: f.eventos.includes(eventoId) ? f.eventos.filter((e) => e !== eventoId) : [...f.eventos, eventoId],
    }));
  }

  async function salvar() {
    setFormErro('');
    setSalvando(true);
    try {
      if (form.id) {
        const d = await api.put<{ segredo?: string }>(`/webhooks/${form.id}`, {
          nome: form.nome.trim(),
          url: form.url.trim(),
          eventos: form.eventos,
          ativo: form.ativo,
          ...(form.regenerar ? { regenerar_segredo: true } : {}),
        });
        if (d.segredo) setSegredo({ nome: form.nome.trim(), valor: d.segredo });
        else {
          toast.success('Webhook salvo.');
          navigate('/webhooks');
        }
      } else {
        const d = await api.post<{ segredo: string }>('/webhooks', {
          nome: form.nome.trim(),
          url: form.url.trim(),
          eventos: form.eventos,
          ativo: form.ativo,
        });
        setSegredo({ nome: form.nome.trim(), valor: d.segredo });
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'reauth_necessaria') {
        setReauth({ titulo: form.id ? `Autorizar alteração — ${form.nome}` : 'Autorizar novo webhook' });
        return;
      }
      setFormErro(e instanceof ApiError ? e.message : 'Não foi possível salvar.');
    } finally {
      setSalvando(false);
    }
  }

  const podeSalvar = !!form.nome.trim() && !!form.url.trim() && form.eventos.length > 0;

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={modo === 'editar' ? 'Editar webhook' : 'Novo webhook'}
        description="Criar, alterar e excluir exigem a sua senha (reautenticação). Cada entrega é assinada (HMAC) e registrada no log."
        actions={
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/webhooks')} disabled={salvando}>
              Cancelar
            </button>
            <button type="button" className="btn btn-accent" onClick={() => void salvar()} disabled={salvando || carregando || !podeSalvar}>
              {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {salvando ? 'Salvando...' : 'Salvar webhook'}
            </button>
          </div>
        }
      />

      {carregando && <Spinner label="Carregando webhook..." />}
      {erro && <Alert tone="red">{erro}</Alert>}

      {segredo && (
        <div className="card mb-4 space-y-4 p-5">
          <Alert tone="amber">
            <strong>Guarde agora:</strong> o segredo de <strong>{segredo.nome}</strong> aparece <strong>uma única vez</strong>.
            O receptor usa ele para validar o header <span className="font-mono">X-Brobond-Signature</span>. Se perder,
            regenere na edição (o antigo morre na hora).
          </Alert>
          <div className="flex flex-wrap gap-2">
            <input className="input flex-1 font-mono text-sm" readOnly value={segredo.valor} onFocus={(e) => e.currentTarget.select()} />
            <button
              type="button"
              className="btn-secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(segredo.valor);
                toast.success('Segredo copiado.');
              }}
            >
              <Copy className="h-4 w-4" /> Copiar
            </button>
          </div>
          <div className="flex justify-end">
            <button type="button" className="btn-primary" onClick={() => navigate('/webhooks')}>
              Guardei — concluir
            </button>
          </div>
        </div>
      )}

      {!carregando && !erro && !segredo && (
        <div className="card mx-auto max-w-2xl space-y-4 p-5">
          {formErro && <Alert tone="red">{formErro}</Alert>}
          <label className="block" htmlFor="webhook-nome">
            <span className="label">Nome *</span>
            <input
              id="webhook-nome"
              className="input"
              value={form.nome}
              onChange={(e) => setForm({ ...form, nome: e.target.value })}
              placeholder="Ex.: SIEM da matriz"
              maxLength={80}
              autoFocus
            />
          </label>
          <label className="block" htmlFor="webhook-url">
            <span className="label">URL do receptor (POST JSON) *</span>
            <input
              id="webhook-url"
              className="input font-mono text-sm"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://..."
              inputMode="url"
            />
          </label>
          <div>
            <span className="label">Eventos *</span>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {eventos.map((e) => (
                <label key={e.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm hover:border-brand-300">
                  <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={form.eventos.includes(e.id)} onChange={() => toggleEvento(e.id)} />
                  <span>
                    {e.label}
                    <span className="block font-mono text-[11px] text-slate-400">{e.id}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={form.ativo} onChange={(e) => setForm({ ...form, ativo: e.target.checked })} />
              Ativo (entregando)
            </label>
            {!!form.id && (
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-200" title="Troca o segredo HMAC. O receptor precisa atualizar a chave.">
                <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={!!form.regenerar} onChange={(e) => setForm({ ...form, regenerar: e.target.checked })} />
                Regenerar o segredo
              </label>
            )}
          </div>
          {!podeSalvar && (
            <p className="text-xs text-slate-400">
              <Plus className="mr-1 inline h-3.5 w-3.5" />
              Nome, URL e ao menos um evento são obrigatórios.
            </p>
          )}
        </div>
      )}

      <ReauthModal
        open={!!reauth}
        onClose={() => setReauth(null)}
        onConfirmed={() => {
          setReauth(null);
          void salvar();
        }}
        titulo={reauth?.titulo || 'Autorização necessária'}
      />
    </div>
  );
}
