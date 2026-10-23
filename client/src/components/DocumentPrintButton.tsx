import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, FileText, Printer, RefreshCw } from 'lucide-react';
import {
  abrirContingenciaImpressao,
  getPreferredTerminal,
  imprimirDocumentoErp,
  listarTerminaisImpressao,
  novaChaveIdempotencia,
  reimprimirDocumentoErp,
  setPreferredTerminal,
  type TerminalConfigCliente,
  type TipoDocumentoImprimivel,
} from '../lib/printAgent';
import { Modal, useToast } from './ui';

export function DocumentPrintButton({
  tipo,
  documentoId,
  label = 'Imprimir',
  compact = false,
}: {
  tipo: TipoDocumentoImprimivel;
  documentoId: number;
  label?: string;
  compact?: boolean;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [modo, setModo] = useState<'imprimir' | 'reimprimir'>('imprimir');
  const [copies, setCopies] = useState(1);
  const [terminal, setTerminal] = useState(() => getPreferredTerminal());
  const [motivo, setMotivo] = useState('');
  const [terminais, setTerminais] = useState<TerminalConfigCliente[]>([]);
  const [loading, setLoading] = useState(false);
  const [idemKey, setIdemKey] = useState(() => novaChaveIdempotencia());
  const [ultimoJob, setUltimoJob] = useState<{ public_id: string; status: string; pdfUrl: string; htmlUrl: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setIdemKey(novaChaveIdempotencia());
    listarTerminaisImpressao()
      .then((r) => setTerminais(r.rows.filter((t) => t.ativo)))
      .catch(() => {});
  }, [open]);

  async function dispararFila() {
    setLoading(true);
    try {
      if (terminal) setPreferredTerminal(terminal);
      const res =
        modo === 'reimprimir'
          ? await reimprimirDocumentoErp(tipo, documentoId, {
              copies,
              terminal: terminal || undefined,
              motivo: motivo.trim() || undefined,
              idempotency_key: idemKey,
            })
          : await imprimirDocumentoErp(tipo, documentoId, {
              copies,
              terminal: terminal || undefined,
              idempotency_key: idemKey,
            });
      setUltimoJob({
        public_id: res.job.public_id,
        status: res.job.status,
        pdfUrl: res.fallback_pdf_url,
        htmlUrl: res.fallback_html_url,
      });
      toast.success(
        modo === 'reimprimir'
          ? `Reimpressão enfileirada (${res.job.public_id.slice(0, 8)}).`
          : `Impressão enfileirada (${res.job.public_id.slice(0, 8)}).`
      );
      setIdemKey(novaChaveIdempotencia());
    } catch (e: any) {
      toast.error(e?.message || 'Falha ao enfileirar impressão.');
    } finally {
      setLoading(false);
    }
  }

  async function abrirContingencia(formato: 'pdf' | 'html') {
    try {
      const url =
        formato === 'pdf'
          ? ultimoJob?.pdfUrl || `/api/print/documentos/${tipo}/${documentoId}/pdf?copies=${copies}`
          : ultimoJob?.htmlUrl || `/api/print/documentos/${tipo}/${documentoId}/html?copies=${copies}`;
      await abrirContingenciaImpressao(url);
    } catch (e: any) {
      toast.error(e?.message || 'Falha ao abrir contingência.');
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          compact
            ? 'btn-secondary !px-2.5 !py-1.5 text-xs'
            : 'btn-secondary'
        }
        title="Imprimir na fila ou abrir contingência PDF/HTML"
      >
        <Printer className="h-4 w-4" />
        <span>{label}</span>
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Impressão do Documento"
        subtitle="Envie para a fila do agente local ou utilize a contingência PDF / Navegador"
      >
        <div className="space-y-4">
          <div className="flex gap-2 rounded-lg bg-slate-100 p-1 dark:bg-navy-800">
            <button
              type="button"
              onClick={() => {
                setModo('imprimir');
                setIdemKey(novaChaveIdempotencia());
              }}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                modo === 'imprimir'
                  ? 'bg-white text-navy-900 shadow-sm dark:bg-navy-900 dark:text-white'
                  : 'text-slate-600 dark:text-navy-300'
              }`}
            >
              Impressão normal
            </button>
            <button
              type="button"
              onClick={() => {
                setModo('reimprimir');
                setIdemKey(novaChaveIdempotencia());
              }}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                modo === 'reimprimir'
                  ? 'bg-white text-navy-900 shadow-sm dark:bg-navy-900 dark:text-white'
                  : 'text-slate-600 dark:text-navy-300'
              }`}
            >
              Reimpressão auditada
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Terminal de destino</label>
              <select
                className="input"
                value={terminal}
                onChange={(e) => setTerminal(e.target.value)}
              >
                <option value="">Qualquer agente ativo da empresa</option>
                {terminais.map((t) => (
                  <option key={t.id} value={t.codigo}>
                    {t.codigo} — {t.nome} {t.agent_online ? '(online)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Cópias (1 a 10)</label>
              <input
                type="number"
                min={1}
                max={10}
                className="input"
                value={copies}
                onChange={(e) => setCopies(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
              />
            </div>
          </div>

          {modo === 'reimprimir' && (
            <div>
              <label className="label">Motivo da reimpressão (opcional — registrado na auditoria)</label>
              <input
                type="text"
                maxLength={240}
                placeholder="Ex.: papel enroscou, 2ª via solicitada..."
                className="input"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
              />
            </div>
          )}

          {ultimoJob && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 text-xs text-emerald-900 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-200">
              <div className="flex items-center justify-between gap-2">
                <span>
                  Job <strong>{ultimoJob.public_id.slice(0, 8)}</strong> na fila ({ultimoJob.status})
                </span>
                <Link to="/config/impressao" className="inline-flex items-center gap-1 font-semibold underline" onClick={() => setOpen(false)}>
                  Ver fila <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 dark:border-navy-800">
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary text-xs" onClick={() => abrirContingencia('pdf')}>
                <FileText className="h-3.5 w-3.5" />
                Contingência PDF
              </button>
              <button type="button" className="btn-secondary text-xs" onClick={() => abrirContingencia('html')}>
                <ExternalLink className="h-3.5 w-3.5" />
                Imprimir no navegador
              </button>
            </div>
            <button type="button" className="btn-primary" disabled={loading} onClick={dispararFila}>
              {modo === 'reimprimir' ? <RefreshCw className="h-4 w-4" /> : <Printer className="h-4 w-4" />}
              {loading ? 'Enviando...' : modo === 'reimprimir' ? 'Reimprimir na fila' : 'Enviar para fila'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
