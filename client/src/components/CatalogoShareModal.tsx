import { useEffect, useMemo, useState } from 'react';
import { Copy, Download, ExternalLink, Mail, MessageCircle, QrCode, Share2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, Modal, useToast } from './ui';

type Cliente = { id: number; nome: string; telefone?: string | null; email?: string | null; ativo?: boolean };
type ShareInfo = { url: string; qr_data_url: string };

function soDigitos(v: string) {
  return v.replace(/\D/g, '');
}

export default function CatalogoShareModal({ catalogo, onClose }: { catalogo: Record<string, any> | null; onClose: () => void }) {
  const toast = useToast();
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [clienteId, setClienteId] = useState('');
  const [destinatario, setDestinatario] = useState('');
  const [mensagem, setMensagem] = useState('');
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const cliente = useMemo(() => clientes.find((c) => c.id === Number(clienteId)) ?? null, [clientes, clienteId]);

  useEffect(() => {
    if (!catalogo) return;
    setClienteId('');
    setDestinatario('');
    setInfo(null);
    setMensagem(`Olá!\n\nPreparamos o catálogo “${catalogo.nome}” para você.\n\nConsulte produtos, cores, tamanhos e condições comerciais pelo link abaixo:\n\n{link}\n\nVocê também pode montar sua solicitação diretamente pelo catálogo. Nossa equipe confirmará disponibilidade, valores e entrega.`);
    api
      .get<{ rows: Cliente[] }>('/clientes?page=1&pageSize=500&sort=nome&dir=asc&f.ativo=true')
      .then((d) => setClientes(d.rows ?? []))
      .catch(() => setClientes([]));
  }, [catalogo]);

  useEffect(() => {
    if (!cliente) return;
    setDestinatario(cliente.telefone || cliente.email || '');
  }, [cliente]);

  async function preparar(canal: string): Promise<ShareInfo | null> {
    if (!catalogo) return null;
    setBusy(true);
    try {
      const d = await api.post<ShareInfo>(`/catalogos/${catalogo.id}/compartilhar`, {
        canal,
        cliente_id: cliente?.id ?? null,
      });
      setInfo(d);
      return d;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível preparar o compartilhamento.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  function textoFinal(url: string) {
    const saudacao = cliente ? mensagem.replace(/^Olá!/, `Olá, ${cliente.nome}!`) : mensagem;
    return saudacao.split('{link}').join(url);
  }

  async function copiar(tipo: 'link' | 'mensagem') {
    const d = info ?? (await preparar('link'));
    if (!d) return;
    await navigator.clipboard.writeText(tipo === 'link' ? d.url : textoFinal(d.url));
    toast.success(tipo === 'link' ? 'Link do catálogo copiado.' : 'Mensagem completa copiada.');
  }

  async function whatsapp() {
    const d = await preparar('whatsapp');
    if (!d) return;
    const telefone = cliente?.telefone || destinatario;
    const destino = soDigitos(telefone || '');
    window.open(`https://wa.me/${destino}?text=${encodeURIComponent(textoFinal(d.url))}`, '_blank', 'noopener,noreferrer');
  }

  async function email() {
    const d = await preparar('email');
    if (!d) return;
    const para = cliente?.email || destinatario;
    window.location.href = `mailto:${encodeURIComponent(para || '')}?subject=${encodeURIComponent(`Catálogo ${catalogo?.nome ?? ''}`)}&body=${encodeURIComponent(textoFinal(d.url))}`;
  }

  async function visualizar() {
    const d = await preparar('visualizacao');
    if (d) window.open(d.url, '_blank', 'noopener,noreferrer');
  }

  async function mostrarQr() {
    await preparar('qrcode');
  }

  function baixarQr() {
    if (!info || !catalogo) return;
    const a = document.createElement('a');
    a.href = info.qr_data_url;
    a.download = `qrcode-${catalogo.nome.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
    a.click();
  }

  return (
    <Modal open={!!catalogo} onClose={onClose} title="Compartilhar catálogo" subtitle={catalogo?.nome} size="lg">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-4">
          {catalogo?.ativo === false && <Alert tone="amber">Este catálogo está inativo. Ative-o antes de enviar ao cliente.</Alert>}
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              <span className="label">Cliente (opcional)</span>
              <select className="input" value={clienteId} onChange={(e) => setClienteId(e.target.value)}>
                <option value="">Compartilhamento geral</option>
                {clientes.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            </label>
            <label>
              <span className="label">WhatsApp ou e-mail</span>
              <input className="input" value={destinatario} onChange={(e) => setDestinatario(e.target.value)} placeholder="Opcional — preenchido pelo cliente" />
            </label>
          </div>

          <label className="block">
            <span className="label">Mensagem</span>
            <textarea className="input min-h-44 resize-y text-sm leading-relaxed" value={mensagem} onChange={(e) => setMensagem(e.target.value)} />
            <span className="mt-1 block text-xs text-slate-400">Mantenha <strong>{'{link}'}</strong> onde o endereço do catálogo deve aparecer.</span>
          </label>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <button className="btn-accent justify-center" onClick={whatsapp} disabled={busy || catalogo?.ativo === false}>
              <MessageCircle className="h-4 w-4" /> WhatsApp
            </button>
            <button className="btn-primary justify-center" onClick={email} disabled={busy || catalogo?.ativo === false}>
              <Mail className="h-4 w-4" /> E-mail
            </button>
            <button className="btn-secondary justify-center" onClick={() => copiar('link')} disabled={busy}>
              <Copy className="h-4 w-4" /> Copiar link
            </button>
            <button className="btn-secondary justify-center" onClick={() => copiar('mensagem')} disabled={busy}>
              <Share2 className="h-4 w-4" /> Copiar mensagem
            </button>
            <button className="btn-secondary justify-center" onClick={mostrarQr} disabled={busy}>
              <QrCode className="h-4 w-4" /> Gerar QR Code
            </button>
            <button className="btn-secondary justify-center" onClick={visualizar} disabled={busy}>
              <ExternalLink className="h-4 w-4" /> Ver como cliente
            </button>
          </div>
          <p className="text-xs leading-relaxed text-slate-400">WhatsApp e e-mail são abertos com a mensagem pronta para você revisar antes do envio. A ação fica registrada na auditoria do ERP.</p>
        </div>

        <aside className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <h3 className="text-sm font-bold text-navy-900">QR Code do catálogo</h3>
          <p className="mt-1 text-xs text-slate-500">Use em mostruários, feiras, cartões e materiais impressos.</p>
          {info ? (
            <>
              <img src={info.qr_data_url} alt={`QR Code do catálogo ${catalogo?.nome}`} className="mx-auto mt-4 aspect-square w-full max-w-52 rounded-lg border border-slate-200 bg-white p-2" />
              <button className="btn-secondary mt-3 w-full justify-center" onClick={baixarQr}>
                <Download className="h-4 w-4" /> Baixar PNG
              </button>
            </>
          ) : (
            <button className="mt-4 flex aspect-square w-full items-center justify-center rounded-lg border-2 border-dashed border-slate-200 bg-white text-slate-400 hover:border-navy-200 hover:text-navy-500" onClick={mostrarQr} disabled={busy}>
              <span className="text-center text-xs"><QrCode className="mx-auto mb-2 h-10 w-10" />Clique para gerar</span>
            </button>
          )}
        </aside>
      </div>
    </Modal>
  );
}
