import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Eye,
  FileText,
  KeyRound,
  Monitor,
  Play,
  Plus,
  Power,
  Printer,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  Wrench,
  XCircle,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import {
  abrirContingenciaImpressao,
  cancelarImpressao,
  detalheJobImpressao,
  detectarAgenteLocal,
  executarManutencaoImpressao,
  gerarCodigoPareamentoAgente,
  getPreferredTerminal,
  listarAgentesImpressao,
  listarImpressorasDetectadas,
  listarJobsImpressao,
  listarTerminaisImpressao,
  novaChaveIdempotencia,
  obterResumoImpressao,
  parearAgenteLocalLoopback,
  reativarAgenteImpressao,
  reimprimirJob,
  removerTerminalImpressao,
  retentarImpressao,
  revogarAgenteImpressao,
  rotacionarTokenAgenteImpressao,
  setPreferredTerminal,
  testarTerminalImpressao,
  type AgenteRemotoCliente,
  type JobCliente,
  type ResumoOperacionalImpressao,
  type StatusAgenteLocal,
  type TerminalConfigCliente,
} from '../lib/printAgent';
import { PainelInline, useToast } from '../components/ui';

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  QUEUED: { label: 'Na fila', cls: 'bg-slate-100 text-slate-700 dark:bg-navy-800 dark:text-navy-200' },
  CLAIMED: { label: 'Reservado', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300' },
  PRINTING: { label: 'Imprimindo', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300' },
  PRINTED: { label: 'Impresso', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300' },
  FAILED: { label: 'Falhou', cls: 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300' },
  CANCELLED: { label: 'Cancelado', cls: 'bg-slate-200 text-slate-600 dark:bg-navy-800 dark:text-navy-400' },
};

const DOC_LABELS: Record<string, string> = {
  recibo_pdv: 'Cupom PDV',
  etiqueta_produto: 'Etiqueta Produto',
  pedido: 'Pedido Venda',
  orcamento: 'Orçamento / Proposta',
  compra: 'Pedido Compra',
  ordem_producao: 'Ordem Produção',
  ficha_usuario: 'Ficha Usuário',
  teste: 'Página de Teste',
  relatorio: 'Relatório',
  generico: 'Genérico',
};

function fmtDataHora(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('pt-BR');
}

export default function ImpressaoPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const isGestor = user?.perfil === 'admin' || user?.perfil === 'gerente';

  const [aba, setAba] = useState<'fila' | 'terminais' | 'agentes' | 'auditoria'>('fila');
  const [resumo, setResumo] = useState<ResumoOperacionalImpressao | null>(null);
  const [localStatus, setLocalStatus] = useState<StatusAgenteLocal>({ ok: false });
  const [meuTerminal, setMeuTerminal] = useState(() => getPreferredTerminal());

  // Estado Aba Fila
  const [jobs, setJobs] = useState<JobCliente[]>([]);
  const [jobsTotal, setJobsTotal] = useState(0);
  const [jobsPage, setJobsPage] = useState(1);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [fStatus, setFStatus] = useState('');
  const [fDocType, setFDocType] = useState('');
  const [fTerminal, setFTerminal] = useState('');
  const [fReprintOnly, setFReprintOnly] = useState(false);
  const [fDe, setFDe] = useState('');
  const [fAte, setFAte] = useState('');
  const [fBusca, setFBusca] = useState('');

  // Detalhe / Reimpressão de Job
  const [jobDetalhe, setJobDetalhe] = useState<{ job: JobCliente; print_ir: Record<string, unknown> } | null>(null);
  const [reprintAlvo, setReprintAlvo] = useState<JobCliente | null>(null);
  const [reprintCopies, setReprintCopies] = useState(1);
  const [reprintMotivo, setReprintMotivo] = useState('');
  const [reprintTerminal, setReprintTerminal] = useState('');
  const [reprintKey, setReprintKey] = useState('');

  // Terminais & Impressoras
  const [terminais, setTerminais] = useState<TerminalConfigCliente[]>([]);
  const [impressorasDetectadas, setImpressorasDetectadas] = useState<string[]>([]);

  // Agentes
  const [agentes, setAgentes] = useState<AgenteRemotoCliente[]>([]);
  const [segredoUnico, setSegredoUnico] = useState<{ titulo: string; valor: string } | null>(null);

  // Auditoria
  const [auditoriaRows, setAuditoriaRows] = useState<Record<string, any>[]>([]);

  const carregarResumoELocal = useCallback(async () => {
    obterResumoImpressao().then(setResumo).catch(() => {});
    detectarAgenteLocal().then(setLocalStatus).catch(() => {});
    listarTerminaisImpressao()
      .then((r) => setTerminais(r.rows))
      .catch(() => {});
    listarImpressorasDetectadas()
      .then((r) => setImpressorasDetectadas(r.impressoras))
      .catch(() => {});
  }, []);

  const carregarJobs = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const r = await listarJobsImpressao({
        page: jobsPage,
        pageSize: 25,
        status: fStatus || undefined,
        doc_type: fDocType || undefined,
        terminal: fTerminal || undefined,
        reprint_only: fReprintOnly ? '1' : undefined,
        de: fDe || undefined,
        ate: fAte || undefined,
        q: fBusca.trim() || undefined,
      });
      setJobs(r.rows);
      setJobsTotal(r.total);
    } catch (e: any) {
      toastRef.current.error(e?.message || 'Erro ao carregar fila de impressão.');
    } finally {
      setLoadingJobs(false);
    }
  }, [jobsPage, fStatus, fDocType, fTerminal, fReprintOnly, fDe, fAte, fBusca]);

  const carregarAgentes = useCallback(async () => {
    if (!isGestor) return;
    try {
      const r = await listarAgentesImpressao();
      setAgentes(r.rows);
    } catch (e: any) {
      toastRef.current.error(e?.message || 'Erro ao carregar agentes.');
    }
  }, [isGestor]);

  const carregarAuditoria = useCallback(async () => {
    if (!isGestor) return;
    try {
      const r = await api.get<{ rows: Record<string, any>[] }>('/auditoria?page=1&pageSize=50&acao=imprimir');
      setAuditoriaRows(r.rows || []);
    } catch {
      setAuditoriaRows([]);
    }
  }, [isGestor]);

  useEffect(() => {
    carregarResumoELocal();
  }, [carregarResumoELocal]);

  useEffect(() => {
    if (aba === 'fila') carregarJobs();
    if (aba === 'agentes') carregarAgentes();
    if (aba === 'terminais') {
      carregarResumoELocal();
      if (isGestor) carregarAgentes();
    }
    if (aba === 'auditoria') carregarAuditoria();
  }, [aba, carregarJobs, carregarAgentes, carregarAuditoria, carregarResumoELocal, isGestor]);

  const todasImpressorasSugeridas = useMemo(() => {
    const s = new Set<string>(impressorasDetectadas);
    for (const l of localStatus.printers || []) s.add(l);
    return [...s];
  }, [impressorasDetectadas, localStatus.printers]);

  async function handleCancelarJob(j: JobCliente) {
    try {
      await cancelarImpressao(j.public_id);
      toast.success(`Job ${j.public_id.slice(0, 8)} cancelado.`);
      carregarJobs();
      carregarResumoELocal();
    } catch (e: any) {
      toast.error(e?.message || 'Não foi possível cancelar o job.');
    }
  }

  async function handleRetryJob(j: JobCliente) {
    try {
      await retentarImpressao(j.public_id);
      toast.success(`Job ${j.public_id.slice(0, 8)} reenfileirado.`);
      carregarJobs();
      carregarResumoELocal();
    } catch (e: any) {
      toast.error(e?.message || 'Não foi possível retentar o job.');
    }
  }

  async function handleConfirmarReprint() {
    if (!reprintAlvo) return;
    try {
      const r = await reimprimirJob(reprintAlvo.public_id, {
        copies: reprintCopies,
        motivo: reprintMotivo.trim() || undefined,
        terminal: reprintTerminal || undefined,
        idempotency_key: reprintKey,
      });
      toast.success(`Reimpressão criada: job ${r.job.public_id.slice(0, 8)} (origem ${reprintAlvo.public_id.slice(0, 8)}).`);
      setReprintAlvo(null);
      carregarJobs();
      carregarResumoELocal();
    } catch (e: any) {
      toast.error(e?.message || 'Falha na reimpressão.');
    }
  }

  async function handleParearEstaMaquina() {
    try {
      const { codigo } = await gerarCodigoPareamentoAgente({
        nome: 'Estação Local',
        terminal: meuTerminal || undefined,
      });
      const out = await parearAgenteLocalLoopback(codigo);
      toast.success(`Agente local pareado (${out.nome})!`);
      carregarResumoELocal();
      carregarAgentes();
    } catch (e: any) {
      toast.error(e?.message || 'Não foi possível parear automaticamente com 127.0.0.1.');
    }
  }

  return (
    <div className="p-4 sm:p-6 space-y-6">
      {/* Cabeçalho */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-navy-900 dark:text-white flex items-center gap-2">
            <Printer className="h-6 w-6 text-brand-600" />
            Central de Impressão Operacional
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-navy-300">
            Fila assíncrona auditável, configuração por terminal, agentes locais (ESC/POS, ZPL, EPL2) e contingência PDF/HTML.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs dark:border-navy-700 dark:bg-navy-900">
            <Monitor className="h-4 w-4 text-slate-500" />
            <span className="text-slate-600 dark:text-navy-300">Meu terminal:</span>
            <select
              aria-label="Selecionar meu terminal padrão"
              className="bg-transparent font-semibold text-navy-900 focus:outline-none dark:text-white"
              value={meuTerminal}
              onChange={(e) => {
                setMeuTerminal(e.target.value);
                setPreferredTerminal(e.target.value);
                toast.info(e.target.value ? `Terminal padrão desta estação: ${e.target.value}` : 'Usando roteamento automático da empresa.');
              }}
            >
              <option value="">Automático</option>
              {terminais.filter((t) => t.ativo).map((t) => (
                <option key={t.id} value={t.codigo}>
                  {t.codigo} ({t.nome})
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => {
              carregarResumoELocal();
              if (aba === 'fila') carregarJobs();
              if (aba === 'agentes') carregarAgentes();
              if (aba === 'auditoria') carregarAuditoria();
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Atualizar
          </button>
        </div>
      </div>

      {/* KPIs Operacionais */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="card p-3.5">
          <div className="text-xs text-slate-500 dark:text-navy-400">Na fila (QUEUED)</div>
          <div className="mt-1 text-2xl font-bold text-navy-900 dark:text-white">{resumo?.fila.queued ?? 0}</div>
        </div>
        <div className="card p-3.5">
          <div className="text-xs text-slate-500 dark:text-navy-400">Em voo (CLAIMED/PRINTING)</div>
          <div className="mt-1 text-2xl font-bold text-blue-600 dark:text-blue-400">
            {(resumo?.fila.claimed ?? 0) + (resumo?.fila.printing ?? 0)}
          </div>
        </div>
        <div className="card p-3.5">
          <div className="text-xs text-slate-500 dark:text-navy-400">Impressos (24h)</div>
          <div className="mt-1 text-2xl font-bold text-emerald-600 dark:text-emerald-400">{resumo?.fila.printed_24h ?? 0}</div>
        </div>
        <div className="card p-3.5">
          <div className="text-xs text-slate-500 dark:text-navy-400">Falhas ativas</div>
          <div className="mt-1 text-2xl font-bold text-red-600 dark:text-red-400">{resumo?.fila.failed ?? 0}</div>
        </div>
        <div className="card p-3.5">
          <div className="text-xs text-slate-500 dark:text-navy-400">Agentes online</div>
          <div className="mt-1 text-2xl font-bold text-navy-900 dark:text-white">
            {resumo?.agentes.online ?? 0} <span className="text-xs font-normal text-slate-500">/ {resumo?.agentes.ativos ?? 0}</span>
          </div>
        </div>
        <div className="card p-3.5">
          <div className="text-xs text-slate-500 dark:text-navy-400">Agente neste PC</div>
          <div className="mt-1 flex items-center gap-1.5 text-sm font-semibold">
            {localStatus.ok ? (
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                {localStatus.pareado ? 'Pareado' : 'Sem vínculo'}
              </span>
            ) : (
              <span className="text-slate-500 dark:text-navy-400">Não detectado</span>
            )}
          </div>
        </div>
      </div>

      {/* Navegação de Abas */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-2 dark:border-navy-800">
        <button
          type="button"
          onClick={() => setAba('fila')}
          className={`rounded-lg px-3.5 py-2 text-sm font-semibold transition ${
            aba === 'fila' ? 'bg-navy-900 text-white dark:bg-brand-600' : 'text-slate-600 hover:bg-slate-100 dark:text-navy-300 dark:hover:bg-navy-800'
          }`}
        >
          Fila & Histórico ({jobsTotal})
        </button>
        <button
          type="button"
          onClick={() => setAba('terminais')}
          className={`rounded-lg px-3.5 py-2 text-sm font-semibold transition ${
            aba === 'terminais' ? 'bg-navy-900 text-white dark:bg-brand-600' : 'text-slate-600 hover:bg-slate-100 dark:text-navy-300 dark:hover:bg-navy-800'
          }`}
        >
          Terminais & Impressoras ({terminais.length})
        </button>
        {isGestor && (
          <>
            <button
              type="button"
              onClick={() => setAba('agentes')}
              className={`rounded-lg px-3.5 py-2 text-sm font-semibold transition ${
                aba === 'agentes' ? 'bg-navy-900 text-white dark:bg-brand-600' : 'text-slate-600 hover:bg-slate-100 dark:text-navy-300 dark:hover:bg-navy-800'
              }`}
            >
              Agentes Locais ({agentes.length})
            </button>
            <button
              type="button"
              onClick={() => setAba('auditoria')}
              className={`rounded-lg px-3.5 py-2 text-sm font-semibold transition ${
                aba === 'auditoria' ? 'bg-navy-900 text-white dark:bg-brand-600' : 'text-slate-600 hover:bg-slate-100 dark:text-navy-300 dark:hover:bg-navy-800'
              }`}
            >
              Auditoria de Impressão
            </button>
          </>
        )}
      </div>

      {/* =================================================================== */}
      {/* ABA 1: FILA & HISTÓRICO                                             */}
      {/* =================================================================== */}
      {aba === 'fila' && (
        <div className="space-y-4">
          <div className="card p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
              <div>
                <label className="label text-xs">Busca rápida</label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    type="text"
                    placeholder="ID, venda:12, erro..."
                    className="input pl-8 text-xs"
                    value={fBusca}
                    onChange={(e) => {
                      setFBusca(e.target.value);
                      setJobsPage(1);
                    }}
                  />
                </div>
              </div>
              <div>
                <label className="label text-xs">Status</label>
                <select
                  className="input text-xs"
                  value={fStatus}
                  onChange={(e) => {
                    setFStatus(e.target.value);
                    setJobsPage(1);
                  }}
                >
                  <option value="">Todos</option>
                  <option value="QUEUED">Na fila (QUEUED)</option>
                  <option value="CLAIMED">Reservado (CLAIMED)</option>
                  <option value="PRINTING">Imprimindo (PRINTING)</option>
                  <option value="PRINTED">Impresso (PRINTED)</option>
                  <option value="FAILED">Falhou (FAILED)</option>
                  <option value="CANCELLED">Cancelado (CANCELLED)</option>
                </select>
              </div>
              <div>
                <label className="label text-xs">Tipo</label>
                <select
                  className="input text-xs"
                  value={fDocType}
                  onChange={(e) => {
                    setFDocType(e.target.value);
                    setJobsPage(1);
                  }}
                >
                  <option value="">Todos</option>
                  {Object.entries(DOC_LABELS).map(([k, lbl]) => (
                    <option key={k} value={k}>
                      {lbl}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label text-xs">Terminal</label>
                <input
                  type="text"
                  placeholder="Ex.: CAIXA-1"
                  className="input text-xs"
                  value={fTerminal}
                  onChange={(e) => {
                    setFTerminal(e.target.value);
                    setJobsPage(1);
                  }}
                />
              </div>
              <div>
                <label className="label text-xs">De</label>
                <input
                  type="date"
                  className="input text-xs"
                  value={fDe}
                  onChange={(e) => {
                    setFDe(e.target.value);
                    setJobsPage(1);
                  }}
                />
              </div>
              <div>
                <label className="label text-xs">Até</label>
                <input
                  type="date"
                  className="input text-xs"
                  value={fAte}
                  onChange={(e) => {
                    setFAte(e.target.value);
                    setJobsPage(1);
                  }}
                />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <label className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-navy-300">
                <input
                  type="checkbox"
                  checked={fReprintOnly}
                  onChange={(e) => {
                    setFReprintOnly(e.target.checked);
                    setJobsPage(1);
                  }}
                />
                Mostrar apenas reimpressões (reprint_of preenchido)
              </label>

              {isGestor && (resumo?.fila.orphan_leases ?? 0) > 0 && (
                <button
                  type="button"
                  className="btn-secondary text-xs text-amber-700"
                  onClick={async () => {
                    try {
                      const out = await executarManutencaoImpressao();
                      toast.success(`Manutenção concluída: ${out.reabertos} reaberto(s), ${out.falhados} encerrado(s).`);
                      carregarJobs();
                      carregarResumoELocal();
                    } catch (e: any) {
                      toast.error(e?.message || 'Erro na manutenção.');
                    }
                  }}
                >
                  <Wrench className="h-3.5 w-3.5" />
                  Recuperar {resumo?.fila.orphan_leases} lease(s) órfão(s)
                </button>
              )}
            </div>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-600 dark:border-navy-800 dark:bg-navy-900/60 dark:text-navy-300">
                <tr>
                  <th className="px-3 py-2.5">Job / Data</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Tipo / Documento</th>
                  <th className="px-3 py-2.5">Terminal / Impressora</th>
                  <th className="px-3 py-2.5">Cópias / Tent.</th>
                  <th className="px-3 py-2.5">Solicitante / Agente</th>
                  <th className="px-3 py-2.5 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                {loadingJobs ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                      Carregando fila de impressão...
                    </td>
                  </tr>
                ) : jobs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                      Nenhum job encontrado com os filtros informados.
                    </td>
                  </tr>
                ) : (
                  jobs.map((j) => {
                    const st = STATUS_BADGE[j.status] || { label: j.status, cls: 'bg-slate-100 text-slate-700' };
                    return (
                      <tr key={j.public_id} className="hover:bg-slate-50/70 dark:hover:bg-navy-800/40">
                        <td className="px-3 py-2.5">
                          <div className="font-mono font-semibold text-navy-900 dark:text-white">{j.public_id.slice(0, 8)}</div>
                          <div className="text-[11px] text-slate-500">{fmtDataHora(j.criado_em)}</div>
                          {j.reprint_of && (
                            <div className="mt-0.5 inline-block rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-800 dark:bg-purple-950/50 dark:text-purple-300">
                              Reimpressão de {String(j.reprint_of).slice(0, 8)}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${st.cls}`}>
                            {st.label}
                          </span>
                          {j.last_error && (
                            <div className="mt-1 max-w-[200px] truncate text-[11px] text-red-600 dark:text-red-400" title={j.last_error}>
                              {j.last_error_code ? `[${j.last_error_code}] ` : ''}
                              {j.last_error}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-navy-900 dark:text-white">{DOC_LABELS[j.doc_type] || j.doc_type}</div>
                          <div className="text-[11px] text-slate-500">{j.source_ref || j.source}</div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="font-medium">{j.terminal || 'Qualquer terminal'}</div>
                          <div className="text-[11px] text-slate-500">
                            {j.printer_name || '(padrão)'}
                            {j.printer_protocol ? ` · ${String(j.printer_protocol).toUpperCase()}` : ''}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div>{j.copies} cópia(s)</div>
                          <div className="text-[11px] text-slate-500">
                            Tent. {j.attempts ?? 0}/{j.max_attempts ?? 3}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div>{j.requested_by_nome || (j.requested_by ? `#${j.requested_by}` : '—')}</div>
                          {j.agent_nome && <div className="text-[11px] text-slate-500">Agente: {j.agent_nome}</div>}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="inline-flex flex-wrap justify-end gap-1">
                            <button
                              type="button"
                              className="btn-secondary !px-2 !py-1 text-[11px]"
                              title="Ver detalhes e PrintIR"
                              onClick={async () => {
                                try {
                                  const det = await detalheJobImpressao(j.public_id);
                                  setJobDetalhe(det);
                                } catch (e: any) {
                                  toast.error(e?.message || 'Erro ao abrir detalhes.');
                                }
                              }}
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </button>

                            <button
                              type="button"
                              className="btn-secondary !px-2 !py-1 text-[11px]"
                              title="Contingência PDF"
                              onClick={() => abrirContingenciaImpressao(`/api/print/jobs/${j.public_id}/pdf`).catch((e) => toast.error(e.message))}
                            >
                              <FileText className="h-3.5 w-3.5" />
                            </button>

                            {j.status === 'FAILED' && (
                              <button
                                type="button"
                                className="btn-secondary !px-2 !py-1 text-[11px] text-amber-700"
                                title="Tentar novamente"
                                onClick={() => handleRetryJob(j)}
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                              </button>
                            )}

                            {['PRINTED', 'FAILED', 'CANCELLED'].includes(j.status) && (
                              <button
                                type="button"
                                className="btn-secondary !px-2 !py-1 text-[11px] text-brand-700"
                                title="Reimprimir (cria novo job auditado)"
                                onClick={() => {
                                  setReprintAlvo(j);
                                  setReprintCopies(Math.min(10, Math.max(1, Number(j.copies) || 1)));
                                  setReprintTerminal(j.terminal || '');
                                  setReprintMotivo('');
                                  setReprintKey(novaChaveIdempotencia());
                                }}
                              >
                                <RefreshCw className="h-3.5 w-3.5" />
                              </button>
                            )}

                            {['QUEUED', 'CLAIMED', 'PRINTING'].includes(j.status) && (
                              <button
                                type="button"
                                className="btn-secondary !px-2 !py-1 text-[11px] text-red-600"
                                title="Cancelar job pendente"
                                onClick={() => handleCancelarJob(j)}
                              >
                                <XCircle className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {jobsTotal > 25 && (
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>
                Página {jobsPage} · Total {jobsTotal} registro(s)
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={jobsPage <= 1}
                  onClick={() => setJobsPage((p) => Math.max(1, p - 1))}
                >
                  Anterior
                </button>
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={jobsPage * 25 >= jobsTotal}
                  onClick={() => setJobsPage((p) => p + 1)}
                >
                  Próxima
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* =================================================================== */}
      {/* ABA 2: TERMINAIS & ROTEAMENTO MULTI-IMPRESSORA                      */}
      {/* =================================================================== */}
      {aba === 'terminais' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-slate-600 dark:text-navy-300">
              Configure múltiplas impressoras por terminal (recibo térmico ESC/POS, etiqueta ZPL/EPL2, documentos A4/PDF e contingência).
            </p>
            {isGestor && (
              <button type="button" className="btn-primary text-xs" onClick={() => navigate('/config/impressao/terminais/novo')}>
                <Plus className="h-4 w-4" />
                Novo terminal
              </button>
            )}
          </div>

          {todasImpressorasSugeridas.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs dark:border-navy-800 dark:bg-navy-900/50">
              <span className="font-semibold text-navy-900 dark:text-white">Impressoras reportadas pelos agentes: </span>
              <span className="text-slate-600 dark:text-navy-300">{todasImpressorasSugeridas.join(' · ')}</span>
              <span className="ml-2 text-[11px] text-slate-400">(status físico de papel/tinta depende do driver do SO e não é inventado)</span>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {terminais.length === 0 ? (
              <div className="card col-span-full p-8 text-center text-sm text-slate-500">
                Nenhum terminal específico cadastrado. Os jobs são distribuídos para qualquer agente ativo da empresa.
              </div>
            ) : (
              terminais.map((t) => (
                <div key={t.id} className="card p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-bold text-navy-900 dark:text-white">{t.codigo}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            t.ativo ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'
                          }`}
                        >
                          {t.ativo ? 'Ativo' : 'Inativo'}
                        </span>
                      </div>
                      <div className="text-xs text-slate-600 dark:text-navy-300">{t.nome}</div>
                    </div>
                    {isGestor && (
                      <div className="flex gap-1">
                        <button type="button" className="btn-secondary !px-2.5 !py-1 text-xs" onClick={() => navigate(`/config/impressao/terminais/${t.id}/editar`)}>
                          Editar
                        </button>
                        <button
                          type="button"
                          className="btn-secondary !px-2 !py-1 text-xs text-red-600"
                          title="Remover terminal"
                          onClick={async () => {
                            try {
                              await removerTerminalImpressao(t.id);
                              toast.success(`Terminal ${t.codigo} removido.`);
                              carregarResumoELocal();
                            } catch (e: any) {
                              toast.error(e?.message || 'Erro ao remover terminal.');
                            }
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-2.5 text-xs dark:bg-navy-800/60">
                    <div>
                      <span className="text-slate-500">Cupom PDV:</span>{' '}
                      <strong>{t.receipt_printer || t.default_printer || 'Padrão'}</strong> ({t.receipt_protocol.toUpperCase()} {t.receipt_width_cols} col)
                    </div>
                    <div>
                      <span className="text-slate-500">Etiquetas:</span>{' '}
                      <strong>{t.label_printer || t.default_printer || 'Padrão'}</strong> ({t.label_protocol.toUpperCase()})
                    </div>
                    <div>
                      <span className="text-slate-500">Documentos:</span>{' '}
                      <strong>{t.document_printer || t.default_printer || 'Contingência'}</strong> ({t.document_protocol.toUpperCase()})
                    </div>
                    <div>
                      <span className="text-slate-500">Agente:</span>{' '}
                      <strong>{t.agent_nome || 'Qualquer do terminal'}</strong>
                    </div>
                  </div>

                  {isGestor && (
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                      <span className="text-slate-500">
                        Auto-PDV: <strong>{t.auto_print_pdv ? 'Sim' : 'Não'}</strong> · Reimp. Operador:{' '}
                        <strong>{t.allow_operator_reprint ? 'Permitida' : 'Gerente'}</strong>
                      </span>
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          className="btn-secondary !px-2 !py-1 text-[11px]"
                          onClick={async () => {
                            try {
                              const r = await testarTerminalImpressao(t.id, 'recibo');
                              toast.success(`Teste de recibo enfileirado (${r.job.public_id.slice(0, 8)}).`);
                            } catch (e: any) {
                              toast.error(e?.message || 'Falha no teste.');
                            }
                          }}
                        >
                          <Play className="h-3 w-3" /> Teste Recibo
                        </button>
                        <button
                          type="button"
                          className="btn-secondary !px-2 !py-1 text-[11px]"
                          onClick={async () => {
                            try {
                              const r = await testarTerminalImpressao(t.id, 'etiqueta');
                              toast.success(`Teste de etiqueta enfileirado (${r.job.public_id.slice(0, 8)}).`);
                            } catch (e: any) {
                              toast.error(e?.message || 'Falha no teste.');
                            }
                          }}
                        >
                          <Play className="h-3 w-3" /> Teste Etiqueta
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* ABA 3: AGENTES LOCAIS (ADMIN / GERENTE)                             */}
      {/* =================================================================== */}
      {aba === 'agentes' && isGestor && (
        <div className="space-y-4">
          <div className="card flex flex-wrap items-center justify-between gap-4 p-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-navy-900 dark:text-white">
                <Activity className="h-4 w-4 text-brand-600" />
                Agente Local neste Computador (127.0.0.1:17831)
              </div>
              {localStatus.ok ? (
                <p className="text-xs text-slate-600 dark:text-navy-300">
                  Versão <strong>{localStatus.version}</strong> · {localStatus.pareado ? `Pareado (${localStatus.machine_id?.slice(0, 8)})` : 'Aguardando pareamento'} ·
                  Protocolos: {(localStatus.protocols || ['text', 'escpos', 'zpl', 'epl2']).join(', ').toUpperCase()}
                </p>
              ) : (
                <p className="text-xs text-slate-500 dark:text-navy-400">
                  Nenhum agente detectado em 127.0.0.1:17831 neste navegador. Você ainda pode gerar códigos para parear qualquer caixa da loja.
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {localStatus.ok && !localStatus.pareado && (
                <button type="button" className="btn-primary text-xs" onClick={handleParearEstaMaquina}>
                  <ShieldCheck className="h-4 w-4" />
                  Parear este computador com 1 clique
                </button>
              )}
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => navigate('/config/impressao/agentes/novo')}
              >
                <Plus className="h-4 w-4" />
                Gerar código de pareamento
              </button>
            </div>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-600 dark:border-navy-800 dark:bg-navy-900/60 dark:text-navy-300">
                <tr>
                  <th className="px-3 py-2.5">Agente / Máquina</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Terminal</th>
                  <th className="px-3 py-2.5">Versão / SO</th>
                  <th className="px-3 py-2.5">Último Heartbeat</th>
                  <th className="px-3 py-2.5">Impressoras Detectadas</th>
                  <th className="px-3 py-2.5 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                {agentes.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                      Nenhum agente pareado nesta empresa.
                    </td>
                  </tr>
                ) : (
                  agentes.map((a) => (
                    <tr key={a.id}>
                      <td className="px-3 py-2.5">
                        <div className="font-semibold text-navy-900 dark:text-white">{a.nome}</div>
                        <div className="font-mono text-[11px] text-slate-500">
                          {a.machine_id.slice(0, 12)}… · Prefixo {a.token_prefix}***
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        {a.status === 'revogado' ? (
                          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-800">Revogado</span>
                        ) : a.online ? (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">Online</span>
                        ) : (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Offline</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-mono">{a.terminal || 'Todos'}</td>
                      <td className="px-3 py-2.5">
                        {a.agent_version || '—'} · {a.platform || '—'}
                      </td>
                      <td className="px-3 py-2.5">{fmtDataHora(a.last_heartbeat_at)}</td>
                      <td className="px-3 py-2.5 max-w-[220px] truncate" title={(a.printers || []).join(', ')}>
                        {(a.printers || []).length ? a.printers.join(', ') : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="inline-flex gap-1">
                          <button
                            type="button"
                            className="btn-secondary !px-2 !py-1 text-[11px]"
                            onClick={() => navigate(`/config/impressao/agentes/${encodeURIComponent(a.machine_id)}/editar`)}
                          >
                            Editar
                          </button>
                          {a.status === 'ativo' ? (
                            <>
                              <button
                                type="button"
                                className="btn-secondary !px-2 !py-1 text-[11px]"
                                title="Rotacionar token da máquina"
                                onClick={async () => {
                                  try {
                                    const out = await rotacionarTokenAgenteImpressao(a.machine_id);
                                    setSegredoUnico({
                                      titulo: `Nova credencial emitida para ${a.nome}`,
                                      valor: out.token,
                                    });
                                    carregarAgentes();
                                  } catch (e: any) {
                                    toast.error(e?.message || 'Erro ao rotacionar credencial.');
                                  }
                                }}
                              >
                                <KeyRound className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                className="btn-secondary !px-2 !py-1 text-[11px] text-red-600"
                                title="Revogar agente imediatamente"
                                onClick={async () => {
                                  try {
                                    await revogarAgenteImpressao(a.machine_id);
                                    toast.success(`Agente ${a.nome} revogado.`);
                                    carregarAgentes();
                                    carregarResumoELocal();
                                  } catch (e: any) {
                                    toast.error(e?.message || 'Erro ao revogar agente.');
                                  }
                                }}
                              >
                                <Power className="h-3.5 w-3.5" />
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn-secondary !px-2 !py-1 text-[11px] text-emerald-700"
                              onClick={async () => {
                                try {
                                  const out = await reativarAgenteImpressao(a.machine_id);
                                  setSegredoUnico({
                                    titulo: `Agente ${a.nome} reativado com nova credencial`,
                                    valor: out.token,
                                  });
                                  carregarAgentes();
                                  carregarResumoELocal();
                                } catch (e: any) {
                                  toast.error(e?.message || 'Erro ao reativar agente.');
                                }
                              }}
                            >
                              Reativar
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* ABA 4: AUDITORIA DE IMPRESSÃO                                       */}
      {/* =================================================================== */}
      {aba === 'auditoria' && isGestor && (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-600 dark:border-navy-800 dark:bg-navy-900/60 dark:text-navy-300">
              <tr>
                <th className="px-3 py-2.5">Data/Hora</th>
                <th className="px-3 py-2.5">Ator</th>
                <th className="px-3 py-2.5">Recurso</th>
                <th className="px-3 py-2.5">Descrição Auditada</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {auditoriaRows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                    Nenhum evento de auditoria de impressão registrado ainda.
                  </td>
                </tr>
              ) : (
                auditoriaRows.map((ev) => (
                  <tr key={ev.id}>
                    <td className="px-3 py-2 whitespace-nowrap">{fmtDataHora(ev.criado_em)}</td>
                    <td className="px-3 py-2 font-medium">{ev.usuario || 'sistema'}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">{ev.recurso}</td>
                    <td className="px-3 py-2">{ev.descricao}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* =================================================================== */}
      {/* MODAIS OPERACIONAIS                                                 */}
      {/* =================================================================== */}

      {/* PainelInline Detalhes + PrintIR */}
      <PainelInline
        open={Boolean(jobDetalhe)}
        onClose={() => setJobDetalhe(null)}
        title={`Job ${jobDetalhe?.job.public_id.slice(0, 8) || ''}`}
        subtitle="Inspeção de metadados, rastreabilidade e contrato intermediário PrintIR"
        size="lg"
      >
        {jobDetalhe && (
          <div className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 dark:bg-navy-800">
              <div><strong>ID Público:</strong> {jobDetalhe.job.public_id}</div>
              <div><strong>Status:</strong> {jobDetalhe.job.status}</div>
              <div><strong>Documento:</strong> {jobDetalhe.job.source_ref || '—'}</div>
              <div><strong>Reimpressão de:</strong> {jobDetalhe.job.reprint_of || 'Original'}</div>
              {jobDetalhe.job.reprint_reason && (
                <div className="col-span-2"><strong>Motivo da reimpressão:</strong> {jobDetalhe.job.reprint_reason}</div>
              )}
              {jobDetalhe.job.last_error && (
                <div className="col-span-2 text-red-600">
                  <strong>Último erro:</strong> [{jobDetalhe.job.last_error_code}] {jobDetalhe.job.last_error}
                </div>
              )}
            </div>
            <div>
              <div className="mb-1 font-semibold">Contrato PrintIR v{String(jobDetalhe.print_ir.version)}:</div>
              <pre className="max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] text-slate-100">
                {JSON.stringify(jobDetalhe.print_ir, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </PainelInline>

      {/* PainelInline Reimpressão Auditada */}
      <PainelInline
        open={Boolean(reprintAlvo)}
        onClose={() => setReprintAlvo(null)}
        title="Reimpressão Auditada"
        subtitle="Cria um NOVO job vinculado ao original via reprint_of — o registro original permanece imutável."
      >
        {reprintAlvo && (
          <div className="space-y-4">
            <div className="rounded-lg bg-slate-50 p-3 text-xs dark:bg-navy-800">
              Job original: <strong className="font-mono">{reprintAlvo.public_id}</strong> ({DOC_LABELS[reprintAlvo.doc_type] || reprintAlvo.doc_type})
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Cópias (1 a 10)</label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  className="input"
                  value={reprintCopies}
                  onChange={(e) => setReprintCopies(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                />
              </div>
              <div>
                <label className="label">Terminal</label>
                <input
                  type="text"
                  className="input"
                  placeholder="Mesmo terminal"
                  value={reprintTerminal}
                  onChange={(e) => setReprintTerminal(e.target.value)}
                />
              </div>
            </div>
            <div>
              <label className="label">Motivo da reimpressão (opcional)</label>
              <input
                type="text"
                maxLength={240}
                className="input"
                placeholder="Ex.: bobina acabou no meio do corte"
                value={reprintMotivo}
                onChange={(e) => setReprintMotivo(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setReprintAlvo(null)}>
                Cancelar
              </button>
              <button type="button" className="btn-primary" onClick={handleConfirmarReprint}>
                <RefreshCw className="h-4 w-4" />
                Confirmar reimpressão
              </button>
            </div>
          </div>
        )}
      </PainelInline>

      {/* PainelInline Exibição Única de Token Rotacionado/Reativado */}
      <PainelInline
        open={Boolean(segredoUnico)}
        onClose={() => setSegredoUnico(null)}
        title={segredoUnico?.titulo || 'Credencial de Máquina'}
      >
        {segredoUnico && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Copie esta credencial agora. Por segurança, o servidor armazena apenas o hash SHA-256 e nunca voltará a exibir o token completo.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input type="text" readOnly className="input font-mono text-xs" value={segredoUnico.valor} />
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  navigator.clipboard?.writeText(segredoUnico.valor);
                  toast.success('Credencial copiada!');
                }}
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </PainelInline>
    </div>
  );
}
