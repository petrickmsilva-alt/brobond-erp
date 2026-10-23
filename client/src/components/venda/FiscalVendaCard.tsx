import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, FileCheck2, FileSearch, Loader2, Send } from 'lucide-react';
import { api } from '../../lib/api';
import { formatDateTime, formatDocumento } from '../../lib/format';
import { Alert, Badge, useToast } from '../ui';
import type { ClienteVendaRegistro } from './ClienteVendaSelector';
import { SecaoVenda, type ModoPessoaVenda } from './VendaCampos';

type DocumentoFiscalResumo = {
  id?: number;
  modelo?: string;
  serie?: number | string | null;
  numero?: number | string | null;
  status?: string | null;
  chave_acesso?: string | null;
  protocolo_autorizacao?: string | null;
  emitida_em?: string | null;
  motivo_rejeicao?: string | null;
};

type SituacaoFiscal = {
  venda_id: number;
  emitido: boolean;
  documento: DocumentoFiscalResumo | null;
  documentos: DocumentoFiscalResumo[];
  configuracao?: {
    habilitado: boolean;
    provider?: string | null;
    ambiente?: string | null;
  };
};

type PreviaFiscal = {
  pendencias: Array<{ campo: string; mensagem: string }>;
  pode_emitir: boolean;
  provider?: string;
  ambiente?: string;
};

const TONE_FISCAL: Record<string, 'green' | 'red' | 'amber' | 'blue' | 'slate'> = {
  autorizado: 'green',
  emitida: 'green',
  rejeitado: 'red',
  rejeitada: 'red',
  erro_configuracao: 'red',
  cancelado: 'slate',
  cancelada: 'slate',
  processando: 'amber',
  pendente_envio: 'amber',
  rascunho: 'slate',
};

export function FiscalVendaCard({
  etapa = 7,
  vendaId,
  pedido,
  modoPessoa,
  cliente,
  onNavigate,
  onFiscalAtualizado,
}: {
  etapa?: number;
  vendaId: number | null;
  pedido: Record<string, unknown> | null;
  modoPessoa: ModoPessoaVenda;
  cliente: ClienteVendaRegistro | null;
  onNavigate: (rota: string) => void;
  onFiscalAtualizado?: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [modelo, setModelo] = useState<'55' | '65'>(modoPessoa === 'pj' ? '55' : '65');
  const [situacao, setSituacao] = useState<SituacaoFiscal | null>(null);
  const [previa, setPrevia] = useState<PreviaFiscal | null>(null);
  const [carregandoPrevia, setCarregandoPrevia] = useState(false);
  const [emitindo, setEmitindo] = useState(false);

  // Ajusta o modelo sugerido quando o operador alterna entre PF e PJ antes de emitir.
  useEffect(() => {
    if (!situacao?.emitido) {
      setModelo(modoPessoa === 'pj' ? '55' : '65');
    }
  }, [modoPessoa, situacao?.emitido]);

  const carregarSituacao = useCallback(async () => {
    if (!vendaId) return;
    try {
      const s = await api.get<SituacaoFiscal>(`/vendas/${vendaId}/fiscal`);
      setSituacao(s);
    } catch {
      // Silencioso quando mockado parcialmente em testes unitários.
      setSituacao(null);
    }
  }, [vendaId]);

  useEffect(() => {
    void carregarSituacao();
  }, [carregarSituacao, pedido?.nfe_status, pedido?.status]);

  const consultarPrevia = async () => {
    if (!vendaId) return;
    setCarregandoPrevia(true);
    try {
      const r = await api.get<PreviaFiscal>(`/vendas/${vendaId}/fiscal/previa?modelo=${modelo}`);
      setPrevia(r);
    } catch (e: unknown) {
      toast.error(e instanceof Error && e.message ? e.message : 'Não foi possível verificar as pendências fiscais.');
    } finally {
      setCarregandoPrevia(false);
    }
  };

  const emitirNota = async () => {
    if (!vendaId) return;
    setEmitindo(true);
    try {
      const resp = await api.post<Record<string, unknown>>(`/vendas/${vendaId}/fiscal/emitir`, { modelo });
      const st = String(resp?.status || '');
      const msg = typeof resp?.mensagem === 'string' && resp.mensagem ? resp.mensagem : '';
      if (st === 'autorizado') {
        toast.success(`Documento fiscal autorizado (${modelo === '55' ? 'NF-e' : 'NFC-e'} nº ${String(resp.numero ?? '')}).`);
      } else if (st === 'processando') {
        toast.info(msg || 'Documento enviado à SEFAZ e em processamento.');
      } else {
        toast.error(msg || 'A emissão não foi autorizada. Confira os detalhes fiscais.');
      }
      await carregarSituacao();
      await onFiscalAtualizado?.();
    } catch (e: unknown) {
      toast.error(e instanceof Error && e.message ? e.message : 'Falha ao solicitar emissão fiscal.');
    } finally {
      setEmitindo(false);
    }
  };

  const nfeStatusPedido = String(pedido?.nfe_status || '');
  const ultimoDoc = situacao?.documento ?? situacao?.documentos?.[0] ?? null;
  const statusEfetivo = String(ultimoDoc?.status || nfeStatusPedido || 'nao_emitida');
  const cancelada = String(pedido?.status) === 'cancelada';

  return (
    <SecaoVenda
      etapa={etapa}
      titulo="Fiscal (NF-e / NFC-e)"
      subtitulo="Situação do documento fiscal eletrônico vinculado ao pedido, preservando o motor fiscal oficial."
      direita={
        <div className="flex flex-wrap items-center gap-2">
          {situacao?.configuracao?.ambiente && (
            <Badge tone={situacao.configuracao.ambiente === 'producao' ? 'green' : 'amber'}>
              Ambiente: {situacao.configuracao.ambiente === 'producao' ? 'Produção' : 'Homologação'}
            </Badge>
          )}
          <Badge tone={TONE_FISCAL[statusEfetivo] || 'slate'}>
            {situacao?.emitido || nfeStatusPedido === 'emitida'
              ? 'Autorizada'
              : statusEfetivo === 'nao_emitida'
                ? 'Não emitida'
                : statusEfetivo}
          </Badge>
        </div>
      }
    >
      {!vendaId ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 text-xs text-slate-600 dark:border-navy-700 dark:bg-navy-800/40 dark:text-navy-200">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-navy-900 dark:text-white">
              Destinatário configurado: {modoPessoa === 'pj' ? 'Pessoa Jurídica (CNPJ · NF-e modelo 55 sugerida)' : 'Pessoa Física (CPF · NFC-e 65 ou NF-e 55)'}
            </span>
            {cliente?.cnpj_cpf && (
              <span className="font-mono text-slate-700 dark:text-slate-200">
                {modoPessoa === 'pj' ? 'CNPJ ' : 'CPF '}
                {formatDocumento(cliente.cnpj_cpf)}
              </span>
            )}
          </div>
          <p className="mt-1.5">
            Salve ou finalize a venda para consultar a prévia oficial de tributos/pendências da SEFAZ e transmitir a NF-e (modelo 55) ou NFC-e (modelo 65).
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {ultimoDoc ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 text-xs dark:border-navy-700 dark:bg-navy-800/40">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-semibold text-navy-900 dark:text-white">
                  <FileCheck2 className="h-4 w-4 text-brand-600" aria-hidden="true" />
                  <span>
                    {String(ultimoDoc.modelo) === '65' ? 'NFC-e (65)' : 'NF-e (55)'}
                    {ultimoDoc.numero ? ` nº ${ultimoDoc.numero}` : ''}
                    {ultimoDoc.serie ? ` · Série ${ultimoDoc.serie}` : ''}
                  </span>
                </div>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-300"
                  onClick={() => onNavigate('/documentos-fiscais')}
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  Abrir Documentos Fiscais
                </button>
              </div>
              <dl className="mt-2.5 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                {ultimoDoc.chave_acesso && (
                  <div className="sm:col-span-2">
                    <dt className="inline font-semibold text-slate-500">Chave: </dt>
                    <dd className="inline break-all font-mono text-slate-800 dark:text-slate-100">{String(ultimoDoc.chave_acesso)}</dd>
                  </div>
                )}
                {ultimoDoc.protocolo_autorizacao && (
                  <div>
                    <dt className="inline font-semibold text-slate-500">Protocolo: </dt>
                    <dd className="inline font-mono text-slate-800 dark:text-slate-100">{String(ultimoDoc.protocolo_autorizacao)}</dd>
                  </div>
                )}
                {ultimoDoc.emitida_em && (
                  <div>
                    <dt className="inline font-semibold text-slate-500">Autorizada em: </dt>
                    <dd className="inline text-slate-800 dark:text-slate-100">{formatDateTime(ultimoDoc.emitida_em)}</dd>
                  </div>
                )}
                {ultimoDoc.motivo_rejeicao && (
                  <div className="sm:col-span-3 text-red-600 dark:text-red-400">
                    <dt className="inline font-semibold">Retorno fiscal: </dt>
                    <dd className="inline">{String(ultimoDoc.motivo_rejeicao)}</dd>
                  </div>
                )}
              </dl>
            </div>
          ) : (
            <p className="text-xs text-slate-500 dark:text-navy-300">
              Nenhum documento fiscal emitido ainda para este pedido. Você pode validar a prévia de dados ou transmitir a nota quando desejar.
            </p>
          )}

          {!situacao?.emitido && !cancelada && (
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="venda-fiscal-modelo" className="label">
                  Modelo do documento
                </label>
                <select
                  id="venda-fiscal-modelo"
                  className="input"
                  value={modelo}
                  onChange={(e) => {
                    setModelo(e.target.value === '65' ? '65' : '55');
                    setPrevia(null);
                  }}
                >
                  <option value="55">55 — NF-e (Nota Fiscal Eletrônica completa)</option>
                  <option value="65">65 — NFC-e (Consumidor final)</option>
                </select>
              </div>

              <button
                type="button"
                className="btn-secondary"
                disabled={carregandoPrevia || emitindo}
                onClick={() => void consultarPrevia()}
              >
                {carregandoPrevia ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSearch className="h-4 w-4" />}
                Verificar pendências fiscais
              </button>

              <button
                type="button"
                className="btn-primary"
                disabled={emitindo || carregandoPrevia}
                onClick={() => void emitirNota()}
              >
                {emitindo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Emitir {modelo === '55' ? 'NF-e' : 'NFC-e'}
              </button>
            </div>
          )}

          {previa && (
            <div className="space-y-2">
              {previa.pendencias.length === 0 ? (
                <Alert tone="green">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    Nenhuma pendência cadastral ou tributária nos dados da venda para o modelo {modelo}.
                    {!previa.pode_emitir ? ' (A transmissão real depende da habilitação do provedor/certificado em Configurações Fiscais.)' : ''}
                  </span>
                </Alert>
              ) : (
                <Alert tone="amber">
                  <p className="font-semibold">Pendências apontadas pelo motor fiscal ({previa.pendencias.length}):</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                    {previa.pendencias.map((p, idx) => (
                      <li key={`${p.campo}-${idx}`}>
                        <span className="font-mono font-semibold">{p.campo}</span>: {p.mensagem}
                      </li>
                    ))}
                  </ul>
                </Alert>
              )}
            </div>
          )}
        </div>
      )}
    </SecaoVenda>
  );
}
