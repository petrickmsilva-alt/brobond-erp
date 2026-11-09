// ============================================================================
// LOGÍSTICA E ENVIOS — §13
//
// Três abas: envios existentes, gerar remessa a partir de um pedido, e a
// configuração do provedor.
//
// A regra de honestidade desta tela: **ela nunca finge que integrou.** Se o
// provedor não tem credencial, o servidor responde 503 com o motivo e a tela
// mostra o motivo — não uma cotação inventada. O provedor `manual` funciona de
// verdade sem credencial; Melhor Envio e Correios só operam com token/senha.
//
// Credenciais nunca aparecem inteiras: o servidor devolve o valor mascarado e
// apenas o booleano `*_configurado`. Esta tela não tem como vazar o token.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink, KeyRound, Package, RefreshCw, Search, Settings2, Truck, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatDateTime, formatMoney, formatNumber } from '../lib/format';
import type { ListResult } from '../lib/meta';
import { Alert, Badge, EmptyState, PainelInline, PageHeader, Spinner, useToast } from '../components/ui';
import { PageShell } from '../components/ui-kit-negocios';
import { useAuth } from '../auth/AuthContext';

type StatusEnvio = 'pendente' | 'cotado' | 'gerado' | 'postado' | 'em_transito' | 'entregue' | 'cancelado' | 'erro';

const ROTULO: Record<string, string> = {
  pendente: 'Pendente',
  cotado: 'Cotado',
  pronto_expedicao: 'Pronto p/ expedir',
  separacao: 'Em separação',
  embalada: 'Embalada',
  etiqueta_pendente: 'Etiqueta pendente',
  etiqueta_gerada: 'Etiqueta gerada',
  gerado: 'Gerado',
  postado: 'Postado',
  em_transito: 'Em trânsito',
  em_rota: 'Em rota',
  entregue: 'Entregue',
  tentativa_falha: 'Tentativa falhou',
  devolvido: 'Devolvido',
  extraviado: 'Extraviado',
  cancelado: 'Cancelado',
  erro: 'Erro',
};

const TOM: Record<string, 'slate' | 'blue' | 'amber' | 'green' | 'red'> = {
  pendente: 'slate',
  cotado: 'slate',
  pronto_expedicao: 'blue',
  separacao: 'blue',
  embalada: 'blue',
  etiqueta_pendente: 'amber',
  etiqueta_gerada: 'blue',
  gerado: 'blue',
  postado: 'blue',
  em_transito: 'amber',
  em_rota: 'amber',
  entregue: 'green',
  tentativa_falha: 'red',
  devolvido: 'red',
  extraviado: 'red',
  cancelado: 'slate',
  erro: 'red',
};

type Envio = {
  id: number;
  venda_id: number;
  provider: string | null;
  servico: string | null;
  provider_ref: string | null;
  codigo_rastreamento: string | null;
  etiqueta_url: string | null;
  status: StatusEnvio;
  custo: number;
  peso_g: number;
  volumes: number;
  cep_destino: string | null;
  prazo_dias: number | null;
  erro: string | null;
  criado_em: string;
};

type OpcaoFrete = {
  servico: string;
  provider: string;
  valor: number;
  valor_final: number;
  prazo_dias: number | null;
  frete_gratis_aplicado?: boolean;
};

type Cotacao = {
  venda_id: number;
  origem: { cep: string | null };
  destino: { cep: string | null };
  peso_g: number;
  volumes: number;
  valor_declarado: number;
  provedor: { slug: string; nome: string; ambiente: string };
  opcoes: OpcaoFrete[];
};

type Config = {
  provider: string;
  ambiente: 'homologacao' | 'producao';
  cep_origem: string | null;
  frete_gratis_acima: number;
  me_sandbox: boolean;
  me_token: string | null;
  me_token_configurado: boolean;
  correios_usuario: string | null;
  correios_codigo_administrativo: string | null;
  correios_senha: string | null;
  correios_senha_configurada: boolean;
  provedores: Array<{ slug: string; nome: string }>;
  aviso: string | null;
};

type EventoEnvio = { id: number; status: string | null; mensagem: string | null; criado_em: string };

// --- Motor de frete multicanal (modules/logistics) -------------------------
type ProviderMulticanal = {
  slug: string;
  nome: string;
  configurado: boolean;
  habilitado: boolean;
  motivo: string | null;
  capacidades: Record<string, boolean>;
};

type Indicadores = {
  modulo_habilitado: boolean;
  provider_padrao: string;
  contadores: Record<string, number>;
  atrasadas: number;
  ocorrencias: number;
  falhas_integracao: number;
  custo_previsto: number;
  custo_efetivo: number;
  lojas: { store_key: string; remessas: number }[];
  webhooks: Record<string, number>;
  providers: ProviderMulticanal[];
  gerado_em: string;
};

type RegraFrete = {
  id: number;
  nome: string;
  tipo: string;
  store_key: string | null;
  prioridade: number;
  ativo: boolean;
  condicoes: Record<string, unknown>;
  acoes: Record<string, unknown>;
};

type Remessa = {
  id: number;
  venda_id: number;
  provider: string | null;
  store_key: string | null;
  status: string;
  codigo_rastreamento: string | null;
  cep_destino: string | null;
  custo_previsto: number | null;
  custo_efetivo: number | null;
  prazo_dias: number | null;
  criado_em: string;
};

const FILTROS: Array<{ value: string; label: string }> = [
  { value: 'postado', label: 'Postados' },
  { value: 'em_transito', label: 'Em trânsito' },
  { value: 'entregue', label: 'Entregues' },
  { value: 'erro', label: 'Com erro' },
  { value: 'todos', label: 'Todos' },
];

export default function LogisticaPage() {
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.perfil === 'admin';

  const [aba, setAba] = useState<'envios' | 'gerar' | 'multicanal' | 'config'>('envios');
  const [carregando, setCarregando] = useState(true);
  const [envios, setEnvios] = useState<Envio[]>([]);
  const [filtro, setFiltro] = useState('postado');
  const [busca, setBusca] = useState('');
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [eventosDe, setEventosDe] = useState<Envio | null>(null);
  const [eventos, setEventos] = useState<EventoEnvio[]>([]);
  const [statusAberto, setStatusAberto] = useState<Envio | null>(null);
  const [novoStatus, setNovoStatus] = useState({ codigo_rastreamento: '', status: 'em_transito' });

  // Gerar remessa
  const [vendaId, setVendaId] = useState('');
  const [cotacao, setCotacao] = useState<Cotacao | null>(null);
  const [cotando, setCotando] = useState(false);
  const [erroCotacao, setErroCotacao] = useState('');

  // Configuração
  const [config, setConfig] = useState<Config | null>(null);
  const [form, setForm] = useState({
    provider: 'manual',
    ambiente: 'homologacao',
    cep_origem: '',
    frete_gratis_acima: '',
    me_token: '',
    me_sandbox: false,
    correios_usuario: '',
    correios_codigo_administrativo: '',
    correios_senha: '',
  });

  // Motor multicanal
  const [indicadores, setIndicadores] = useState<Indicadores | null>(null);
  const [regras, setRegras] = useState<RegraFrete[]>([]);
  const [tiposRegra, setTiposRegra] = useState<string[]>([]);
  const [remessas, setRemessas] = useState<Remessa[]>([]);
  const [carregandoMulticanal, setCarregandoMulticanal] = useState(false);
  const [erroMulticanal, setErroMulticanal] = useState('');
  const [filtroLoja, setFiltroLoja] = useState('');
  const [filtroProvider, setFiltroProvider] = useState('');
  const [buscaRemessa, setBuscaRemessa] = useState('');
  const [novaRegra, setNovaRegra] = useState({ nome: '', tipo: 'FRETE_GRATIS_VALOR', store_key: '', prioridade: '10', valor_minimo: '', percentual: '' });
  const [reprocessando, setReprocessando] = useState(false);
  const [reconciliando, setReconciliando] = useState(false);

  // -------------------------------------------------------------------------
  // Envios
  // -------------------------------------------------------------------------

  const carregarEnvios = useCallback(async () => {
    setCarregando(true);
    try {
      const f = filtro === 'todos' ? '' : `&f.status=${encodeURIComponent(filtro)}`;
      const d = await api.get<ListResult<Envio>>(`/envios?page=1&pageSize=50&sort=id&dir=desc${f}`);
      setEnvios(d.rows);
      setErro('');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os envios.');
    } finally {
      setCarregando(false);
    }
  }, [filtro]);

  useEffect(() => {
    if (aba === 'envios') void carregarEnvios();
  }, [aba, carregarEnvios]);

  const carregarConfig = useCallback(async () => {
    try {
      const c = await api.get<Config>('/logistica/config');
      setConfig(c);
      setForm((f) => ({
        ...f,
        provider: c.provider,
        ambiente: c.ambiente,
        cep_origem: c.cep_origem ?? '',
        frete_gratis_acima: c.frete_gratis_acima ? String(c.frete_gratis_acima) : '',
        me_sandbox: c.me_sandbox,
        correios_usuario: c.correios_usuario ?? '',
        correios_codigo_administrativo: c.correios_codigo_administrativo ?? '',
      }));
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível ler a configuração.');
    }
  }, []);

  useEffect(() => {
    if (aba === 'config') void carregarConfig();
  }, [aba, carregarConfig]);

  // -------------------------------------------------------------------------
  // Motor multicanal
  // -------------------------------------------------------------------------
  const carregarMulticanal = useCallback(async () => {
    setCarregandoMulticanal(true);
    setErroMulticanal('');
    try {
      const qs = filtroLoja ? `?store=${encodeURIComponent(filtroLoja)}` : '';
      const [ind, reg, rem] = await Promise.all([
        api.get<Indicadores>(`/logistics/painel${qs}`),
        api.get<{ regras: RegraFrete[]; tipos: string[] }>(`/logistics/rules${qs}`),
        api.get<ListResult<Remessa>>(`/logistics/shipments?page=1&pageSize=50${filtroLoja ? `&store=${encodeURIComponent(filtroLoja)}` : ''}${filtroProvider ? `&provider=${encodeURIComponent(filtroProvider)}` : ''}`),
      ]);
      setIndicadores(ind);
      setRegras(reg.regras);
      setTiposRegra(reg.tipos);
      setRemessas(rem.rows);
    } catch (e) {
      setErroMulticanal(e instanceof ApiError ? e.message : 'Não foi possível carregar o painel logístico.');
    } finally {
      setCarregandoMulticanal(false);
    }
  }, [filtroLoja, filtroProvider]);

  useEffect(() => {
    if (aba === 'multicanal') void carregarMulticanal();
  }, [aba, carregarMulticanal]);

  async function criarRegraFrete() {
    setOcupado(true);
    try {
      const condicoes: Record<string, unknown> = {};
      const acoes: Record<string, unknown> = {};
      if (novaRegra.valor_minimo) condicoes.valor_minimo = Number(novaRegra.valor_minimo);
      if (novaRegra.percentual) acoes.percentual = Number(novaRegra.percentual);
      await api.post('/logistics/rules', {
        nome: novaRegra.nome,
        tipo: novaRegra.tipo,
        store_key: novaRegra.store_key || null,
        prioridade: Number(novaRegra.prioridade) || 0,
        condicoes,
        acoes,
      });
      toast.success('Regra criada.');
      setNovaRegra({ nome: '', tipo: 'FRETE_GRATIS_VALOR', store_key: '', prioridade: '10', valor_minimo: '', percentual: '' });
      await carregarMulticanal();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Falha ao criar a regra.');
    } finally {
      setOcupado(false);
    }
  }

  async function alternarRegra(r: RegraFrete) {
    setOcupado(true);
    try {
      await api.put(`/logistics/rules/${r.id}`, { ativo: !r.ativo });
      await carregarMulticanal();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Falha ao atualizar a regra.');
    } finally {
      setOcupado(false);
    }
  }

  async function reprocessarWebhooks() {
    setReprocessando(true);
    try {
      const r = await api.post<{ recuperados: number }>('/logistics/webhooks/recuperar', {});
      toast.success(`${r.recuperados} entrega(s) reprocessada(s).`);
      await carregarMulticanal();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Falha ao reprocessar.');
    } finally {
      setReprocessando(false);
    }
  }

  async function reconciliar() {
    setReconciliando(true);
    try {
      const r = await api.post<{ analisados: number; corrigidas: number; requer_humano: number }>('/logistics/reconcile', { limite: 50 });
      toast.success(`Reconciliação: ${r.analisados} analisados, ${r.corrigidas} corrigidos, ${r.requer_humano} p/ humano.`);
      await carregarMulticanal();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Falha na reconciliação.');
    } finally {
      setReconciliando(false);
    }
  }

  const remessasVisiveis = useMemo(() => {
    const q = buscaRemessa.trim().toLowerCase();
    if (!q) return remessas;
    return remessas.filter((r) =>
      `${r.id} ${r.venda_id} ${r.codigo_rastreamento ?? ''} ${r.provider ?? ''} ${r.cep_destino ?? ''}`.toLowerCase().includes(q)
    );
  }, [remessas, buscaRemessa]);

  const CONTADOR_ROTULO: Record<string, string> = {
    pendente: 'Aguardando expedição',
    cotado: 'Cotados',
    pronto_expedicao: 'Prontos p/ expedir',
    separacao: 'Em separação',
    embalada: 'Embalados',
    etiqueta_pendente: 'Etiqueta pendente',
    etiqueta_gerada: 'Etiqueta gerada',
    gerado: 'Gerados',
    postado: 'Expedidos',
    em_transito: 'Em trânsito',
    em_rota: 'Em rota',
    entregue: 'Entregues',
    tentativa_falha: 'Tentativa falhou',
    devolvido: 'Devolvidos',
    extraviado: 'Extraviados',
    cancelado: 'Cancelados',
    erro: 'Com erro',
  };

  const visiveis = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return envios;
    return envios.filter((e) =>
      `${e.id} ${e.venda_id} ${e.codigo_rastreamento ?? ''} ${e.provider ?? ''} ${e.cep_destino ?? ''}`.toLowerCase().includes(q)
    );
  }, [envios, busca]);

  const abrirEventos = async (envio: Envio) => {
    setEventosDe(envio);
    try {
      const d = await api.get<ListResult<EventoEnvio> | EventoEnvio[]>(`/envios/${envio.id}/eventos`);
      setEventos(Array.isArray(d) ? d : d.rows);
    } catch {
      setEventos([]);
    }
  };

  const rastrear = async (envio: Envio) => {
    setOcupado(true);
    try {
      await api.post(`/envios/${envio.id}/rastrear`, {});
      toast.success('Rastreio consultado.');
      await carregarEnvios();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível rastrear.');
    } finally {
      setOcupado(false);
    }
  };

  const atualizarStatus = async () => {
    if (!statusAberto) return;
    setOcupado(true);
    try {
      await api.post(`/envios/${statusAberto.id}/status`, {
        status: novoStatus.status,
        codigo_rastreamento: novoStatus.codigo_rastreamento || undefined,
      });
      toast.success('Status atualizado.');
      setStatusAberto(null);
      await carregarEnvios();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível atualizar o status.');
    } finally {
      setOcupado(false);
    }
  };

  const cancelar = async (envio: Envio) => {
    setOcupado(true);
    try {
      await api.post(`/envios/${envio.id}/cancelar`, {});
      toast.success('Envio cancelado.');
      await carregarEnvios();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível cancelar.');
    } finally {
      setOcupado(false);
    }
  };

  // -------------------------------------------------------------------------
  // Cotação e geração
  // -------------------------------------------------------------------------

  const cotar = async () => {
    if (!Number(vendaId)) return;
    setCotando(true);
    setErroCotacao('');
    setCotacao(null);
    try {
      setCotacao(await api.get<Cotacao>(`/logistica/frete?venda_id=${Number(vendaId)}`));
    } catch (e) {
      // 503 = sem credencial. Não é bug: é o provedor dizendo que não opera.
      setErroCotacao(e instanceof ApiError ? e.message : 'Não foi possível cotar o frete.');
    } finally {
      setCotando(false);
    }
  };

  const gerar = async (servico?: string) => {
    if (!Number(vendaId)) return;
    setOcupado(true);
    setErroCotacao('');
    try {
      const r = await api.post<Envio & { idempotente?: boolean }>(`/vendas/${Number(vendaId)}/envio`, {
        servico: servico || undefined,
      });
      toast.success(
        r.idempotente
          ? `Envio #${r.id} já existia — nenhum duplicado foi criado.`
          : `Envio #${r.id} gerado (${ROTULO[r.status] ?? r.status}).`
      );
      setCotacao(null);
      setVendaId('');
      setAba('envios');
      await carregarEnvios();
    } catch (e) {
      setErroCotacao(e instanceof ApiError ? e.message : 'Não foi possível gerar o envio.');
    } finally {
      setOcupado(false);
    }
  };

  // -------------------------------------------------------------------------
  // Configuração
  // -------------------------------------------------------------------------

  const salvarConfig = async () => {
    setOcupado(true);
    try {
      const corpo: Record<string, unknown> = {
        provider: form.provider,
        ambiente: form.ambiente,
        cep_origem: form.cep_origem || null,
        frete_gratis_acima: Number(form.frete_gratis_acima || 0),
        me_sandbox: form.me_sandbox,
      };
      // Só envia credencial se o operador digitou alguma — vazio não limpa.
      if (form.me_token) corpo.me_token = form.me_token;
      if (form.correios_usuario) corpo.correios_usuario = form.correios_usuario;
      if (form.correios_codigo_administrativo) corpo.correios_codigo_administrativo = form.correios_codigo_administrativo;
      if (form.correios_senha) corpo.correios_senha = form.correios_senha;

      await api.put('/logistica/config', corpo);
      toast.success('Configuração salva.');
      setForm((f) => ({ ...f, me_token: '', correios_senha: '' }));
      await carregarConfig();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível salvar a configuração.');
    } finally {
      setOcupado(false);
    }
  };

  const credencialFaltando =
    config &&
    ((config.provider === 'melhor_envio' && !config.me_token_configurado) ||
      (config.provider === 'correios' && !config.correios_senha_configurada));

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <PageShell>
      <PageHeader
        title="Logística e envios"
        description="Cotação, geração de remessa, etiqueta e rastreio. Credenciais só em configuração segura — nunca no código."
        actions={
          <div className="flex gap-2">
            <button className={aba === 'envios' ? 'btn-primary' : 'btn-secondary'} onClick={() => setAba('envios')}>
              Envios
            </button>
            <button className={aba === 'gerar' ? 'btn-primary' : 'btn-secondary'} onClick={() => setAba('gerar')}>
              Gerar remessa
            </button>
            <button className={aba === 'multicanal' ? 'btn-primary' : 'btn-secondary'} onClick={() => setAba('multicanal')}>
              <Truck className="h-4 w-4" /> Multicanal
            </button>
            {isAdmin && (
              <button className={aba === 'config' ? 'btn-primary' : 'btn-secondary'} onClick={() => setAba('config')}>
                <Settings2 className="h-4 w-4" /> Configuração
              </button>
            )}
          </div>
        }
      />

      {erro && (
        <div className="mb-4">
          <Alert tone="red">{erro}</Alert>
        </div>
      )}

      {/* ---------------------------------------------------------- envios */}
      {aba === 'envios' && (
        <div className="space-y-3">
          <div className="card grid gap-2 p-3 sm:grid-cols-[1fr_200px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className="input pl-9"
                placeholder="Buscar por pedido, rastreio, CEP ou provedor"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
              />
            </div>
            <select className="input" value={filtro} onChange={(e) => setFiltro(e.target.value)}>
              {FILTROS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>

          <div className="card overflow-hidden">
            {carregando ? (
              <Spinner label="Carregando envios..." />
            ) : visiveis.length === 0 ? (
              <EmptyState
                icon={<Truck className="h-6 w-6" />}
                title="Nenhum envio"
                description="Gere uma remessa a partir de um pedido faturado."
                action={
                  <button className="btn-accent" onClick={() => setAba('gerar')}>
                    Gerar remessa
                  </button>
                }
              />
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-slate-100 text-left text-xs uppercase text-slate-400 dark:border-navy-700">
                  <tr>
                    <th className="px-3 py-2">#</th>
                    <th className="px-3 py-2">Pedido</th>
                    <th className="px-3 py-2">Provedor / serviço</th>
                    <th className="px-3 py-2">Rastreio</th>
                    <th className="px-2 py-2 text-right">Custo</th>
                    <th className="px-2 py-2 text-right">Peso</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {visiveis.map((e) => (
                    <tr key={e.id} className="border-b border-slate-50 dark:border-navy-800">
                      <td className="px-3 py-2 text-slate-400">{e.id}</td>
                      <td className="px-3 py-2">#{e.venda_id}</td>
                      <td className="px-3 py-2">
                        <div className="text-navy-900 dark:text-white">{e.provider ?? '—'}</div>
                        <div className="text-xs text-slate-400">{e.servico ?? '—'}</div>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{e.codigo_rastreamento ?? '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatMoney(e.custo)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-slate-500">
                        {formatNumber(e.peso_g)} g · {formatNumber(e.volumes)} vol
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={TOM[e.status] ?? 'slate'}>{ROTULO[e.status] ?? e.status}</Badge>
                        {e.erro && <div className="mt-0.5 max-w-48 truncate text-[11px] text-red-600" title={e.erro}>{e.erro}</div>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap justify-end gap-1">
                          {e.etiqueta_url && (
                            <a className="btn-icon" href={e.etiqueta_url} target="_blank" rel="noreferrer" title="Etiqueta">
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          )}
                          <button className="btn-icon" onClick={() => void abrirEventos(e)} title="Eventos">
                            <Package className="h-4 w-4" />
                          </button>
                          <button className="btn-icon" onClick={() => void rastrear(e)} title="Consultar rastreio" disabled={ocupado}>
                            <RefreshCw className="h-4 w-4" />
                          </button>
                          <button
                            className="btn-icon"
                            onClick={() => {
                              setStatusAberto(e);
                              setNovoStatus({ codigo_rastreamento: e.codigo_rastreamento ?? '', status: e.status });
                            }}
                            title="Atualizar status"
                          >
                            <Truck className="h-4 w-4" />
                          </button>
                          {!['cancelado', 'entregue'].includes(e.status) && (
                            <button className="btn-icon" onClick={() => void cancelar(e)} title="Cancelar" disabled={ocupado}>
                              <X className="h-4 w-4 text-red-500" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- gerar */}
      {aba === 'gerar' && (
        <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
          <div className="card p-4">
            <h3 className="mb-2 text-sm font-semibold text-navy-900 dark:text-white">Cotar frete do pedido</h3>
            <label className="label">
              Pedido (venda)
              <input
                type="number"
                min={1}
                className="input"
                value={vendaId}
                onChange={(e) => setVendaId(e.target.value)}
              />
            </label>
            <button className="btn-secondary mt-2 w-full" onClick={() => void cotar()} disabled={cotando || !Number(vendaId)}>
              {cotando ? 'Cotando…' : 'Cotar'}
            </button>
            <p className="mt-2 text-[11px] leading-snug text-slate-400">
              A cotação usa o CEP do cliente, o CEP de origem da empresa e os volumes/peso do pedido. Sem credencial, o
              provedor responde 503 e nada é inventado aqui.
            </p>
            {config && (
              <div className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-500 dark:border-navy-700 dark:text-navy-300">
                Provedor ativo: <strong>{config.provider}</strong> ({config.ambiente})
                {credencialFaltando && <span className="text-amber-600"> — sem credencial</span>}
              </div>
            )}
          </div>

          <div className="space-y-3">
            {erroCotacao && <Alert tone="amber">{erroCotacao}</Alert>}

            {cotacao && (
              <div className="card overflow-hidden">
                <div className="border-b border-slate-100 p-4 text-sm dark:border-navy-700">
                  <div className="font-semibold text-navy-900 dark:text-white">Pedido #{cotacao.venda_id}</div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-navy-300">
                    {cotacao.origem.cep ?? '—'} → {cotacao.destino.cep ?? '—'} · {formatNumber(cotacao.peso_g)} g ·{' '}
                    {formatNumber(cotacao.volumes)} volume(ns) · declarado {formatMoney(cotacao.valor_declarado)} ·{' '}
                    {cotacao.provedor.nome} ({cotacao.provedor.ambiente})
                  </div>
                </div>
                {cotacao.opcoes.length === 0 ? (
                  <EmptyState title="Nenhuma opção" description="O provedor não devolveu serviços para este trecho." />
                ) : (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase text-slate-400">
                      <tr>
                        <th className="px-4 py-2">Serviço</th>
                        <th className="px-2 py-2 text-right">Prazo</th>
                        <th className="px-2 py-2 text-right">Valor</th>
                        <th className="px-4 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {cotacao.opcoes.map((o) => (
                        <tr key={`${o.provider}-${o.servico}`} className="border-t border-slate-50 dark:border-navy-800">
                          <td className="px-4 py-2">
                            <div className="text-navy-900 dark:text-white">{o.servico}</div>
                            <div className="text-xs text-slate-400">{o.provider}</div>
                          </td>
                          <td className="px-2 py-2 text-right text-slate-500">
                            {o.prazo_dias ? `${o.prazo_dias} dia(s)` : '—'}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            {formatMoney(o.valor_final)}
                            {o.frete_gratis_aplicado && (
                              <div className="text-[10px] text-emerald-600">frete grátis (regra do ERP)</div>
                            )}
                            {o.frete_gratis_aplicado && (
                              <div className="text-[10px] text-slate-400 line-through">{formatMoney(o.valor)}</div>
                            )}
                          </td>
                          <td className="px-4 py-2 text-right">
                            <button className="btn-accent" onClick={() => void gerar(o.servico)} disabled={ocupado}>
                              Gerar
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- multicanal */}
      {aba === 'multicanal' && (
        <div className="space-y-4">
          {erroMulticanal && <Alert tone="red">{erroMulticanal}</Alert>}
          {indicadores && !indicadores.modulo_habilitado && (
            <Alert tone="amber">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Módulo logístico em <strong>modo seguro</strong> (LOGISTICS_ENABLED desligado). Nenhum operador externo é
                  chamado e as cotações retornam o motivo explícito — nada é simulado.
                </span>
              </div>
            </Alert>
          )}

          {/* Indicadores */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { k: 'pendente', label: 'Aguardando expedição' },
              { k: 'separacao', label: 'Em separação' },
              { k: 'postado', label: 'Expedidos' },
              { k: 'em_transito', label: 'Em trânsito' },
              { k: 'entregue', label: 'Entregues' },
            ].map((c) => (
              <div key={c.k} className="card p-3">
                <div className="text-xs uppercase text-slate-400">{c.label}</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums text-navy-900 dark:text-white">
                  {formatNumber(indicadores?.contadores?.[c.k] ?? 0)}
                </div>
              </div>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="card p-3">
              <div className="text-xs uppercase text-slate-400">Atrasadas</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-amber-600">{formatNumber(indicadores?.atrasadas ?? 0)}</div>
            </div>
            <div className="card p-3">
              <div className="text-xs uppercase text-slate-400">Ocorrências</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-navy-900 dark:text-white">{formatNumber(indicadores?.ocorrencias ?? 0)}</div>
            </div>
            <div className="card p-3">
              <div className="text-xs uppercase text-slate-400">Falhas de integração</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-red-600">{formatNumber(indicadores?.falhas_integracao ?? 0)}</div>
            </div>
            <div className="card p-3">
              <div className="text-xs uppercase text-slate-400">Custo previsto / efetivo</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-navy-900 dark:text-white">
                {formatMoney(indicadores?.custo_previsto ?? 0)} / {formatMoney(indicadores?.custo_efetivo ?? 0)}
              </div>
            </div>
          </div>

          {/* Operadores */}
          <div className="card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-navy-900 dark:text-white">Operadores</h3>
              <div className="flex flex-wrap gap-2">
                <select className="input" value={filtroLoja} onChange={(e) => setFiltroLoja(e.target.value)}>
                  <option value="">Todas as lojas</option>
                  <option value="RETAIL">RETAIL</option>
                  <option value="WHOLESALE">WHOLESALE</option>
                </select>
                <select className="input" value={filtroProvider} onChange={(e) => setFiltroProvider(e.target.value)}>
                  <option value="">Todos os operadores</option>
                  {(indicadores?.providers ?? []).map((p) => (
                    <option key={p.slug} value={p.slug}>
                      {p.nome}
                    </option>
                  ))}
                </select>
                <button className="btn-secondary" onClick={() => void carregarMulticanal()} disabled={carregandoMulticanal}>
                  <RefreshCw className="h-4 w-4" /> Atualizar
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {(indicadores?.providers ?? []).map((p) => (
                <div key={p.slug} className="rounded-lg border border-slate-100 px-3 py-2 text-xs dark:border-navy-700">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-navy-900 dark:text-white">{p.nome}</span>
                    <Badge tone={p.habilitado ? 'green' : 'slate'}>{p.habilitado ? 'habilitado' : 'desabilitado'}</Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-slate-400">
                    {Object.entries(p.capacidades ?? {})
                      .filter(([, v]) => v)
                      .map(([k]) => (
                        <span key={k} className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-navy-800">{k}</span>
                      ))}
                  </div>
                  {p.motivo && <div className="mt-1 max-w-64 text-[11px] text-amber-600">{p.motivo}</div>}
                </div>
              ))}
            </div>
          </div>

          {/* Remessas */}
          <div className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-3 dark:border-navy-700">
              <h3 className="text-sm font-semibold text-navy-900 dark:text-white">Remessas</h3>
              <div className="flex flex-wrap gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input className="input pl-9" placeholder="Buscar pedido, rastreio ou CEP" value={buscaRemessa} onChange={(e) => setBuscaRemessa(e.target.value)} />
                </div>
                <button className="btn-secondary" onClick={() => void reconciliar()} disabled={reconciliando}>
                  <RefreshCw className="h-4 w-4" /> Reconciliar
                </button>
                <button className="btn-secondary" onClick={() => void reprocessarWebhooks()} disabled={reprocessando}>
                  <RefreshCw className="h-4 w-4" /> Reprocessar webhooks
                </button>
              </div>
            </div>
            {carregandoMulticanal ? (
              <Spinner label="Carregando painel logístico..." />
            ) : remessasVisiveis.length === 0 ? (
              <EmptyState icon={<Truck className="h-6 w-6" />} title="Nenhuma remessa" description="As remessas criadas pelo motor multicanal aparecem aqui." />
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-slate-100 text-left text-xs uppercase text-slate-400 dark:border-navy-700">
                  <tr>
                    <th className="px-3 py-2">#</th>
                    <th className="px-3 py-2">Pedido</th>
                    <th className="px-3 py-2">Loja</th>
                    <th className="px-3 py-2">Operador</th>
                    <th className="px-3 py-2">Rastreio</th>
                    <th className="px-2 py-2 text-right">Previsto</th>
                    <th className="px-2 py-2 text-right">Efetivo</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {remessasVisiveis.map((r) => (
                    <tr key={r.id} className="border-b border-slate-50 dark:border-navy-800">
                      <td className="px-3 py-2 text-slate-400">{r.id}</td>
                      <td className="px-3 py-2">#{r.venda_id}</td>
                      <td className="px-3 py-2">{r.store_key ?? '—'}</td>
                      <td className="px-3 py-2">{r.provider ?? '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs">{r.codigo_rastreamento ?? '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{r.custo_previsto != null ? formatMoney(r.custo_previsto) : '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{r.custo_efetivo != null ? formatMoney(r.custo_efetivo) : '—'}</td>
                      <td className="px-3 py-2">
                        <Badge tone={TOM[r.status] ?? 'slate'}>{ROTULO[r.status] ?? r.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Regras de frete */}
          <div className="card p-4">
            <h3 className="mb-3 text-sm font-semibold text-navy-900 dark:text-white">Regras comerciais de frete</h3>
            <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <input className="input" placeholder="Nome da regra" value={novaRegra.nome} onChange={(e) => setNovaRegra((s) => ({ ...s, nome: e.target.value }))} />
              <select className="input" value={novaRegra.tipo} onChange={(e) => setNovaRegra((s) => ({ ...s, tipo: e.target.value }))}>
                {(tiposRegra.length ? tiposRegra : ['FRETE_GRATIS_VALOR', 'FRETE_SUBSIDIADO']).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select className="input" value={novaRegra.store_key} onChange={(e) => setNovaRegra((s) => ({ ...s, store_key: e.target.value }))}>
                <option value="">Todas as lojas</option>
                <option value="RETAIL">RETAIL</option>
                <option value="WHOLESALE">WHOLESALE</option>
              </select>
              <input className="input" placeholder="Prioridade" value={novaRegra.prioridade} onChange={(e) => setNovaRegra((s) => ({ ...s, prioridade: e.target.value }))} />
              <button className="btn-accent" onClick={() => void criarRegraFrete()} disabled={ocupado || novaRegra.nome.trim().length < 3}>
                Adicionar
              </button>
            </div>
            {regras.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-navy-300">Nenhuma regra cadastrada.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-slate-100 text-left text-xs uppercase text-slate-400 dark:border-navy-700">
                  <tr>
                    <th className="px-3 py-2">Nome</th>
                    <th className="px-3 py-2">Tipo</th>
                    <th className="px-3 py-2">Loja</th>
                    <th className="px-2 py-2 text-right">Prioridade</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {regras.map((r) => (
                    <tr key={r.id} className="border-b border-slate-50 dark:border-navy-800">
                      <td className="px-3 py-2">{r.nome}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">{r.tipo}</td>
                      <td className="px-3 py-2">{r.store_key ?? 'Todas'}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{r.prioridade}</td>
                      <td className="px-3 py-2">
                        <Badge tone={r.ativo ? 'green' : 'slate'}>{r.ativo ? 'ativa' : 'inativa'}</Badge>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button className="btn-ghost" onClick={() => void alternarRegra(r)} disabled={ocupado}>
                          {r.ativo ? 'Desativar' : 'Ativar'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- config */}
      {aba === 'config' && (
        <div className="space-y-4">
          {config?.aviso && (
            <Alert tone="amber">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{config.aviso}</span>
              </div>
            </Alert>
          )}

          {credencialFaltando && (
            <Alert tone="red">
              <div className="flex items-start gap-2">
                <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  O provedor <strong>{config?.provider}</strong> está ativo sem credencial. O servidor recusa a ativação
                  (409) — enquanto isso, use <strong>manual</strong> ou cadastre a credencial abaixo.
                </span>
              </div>
            </Alert>
          )}

          <div className="card p-4">
            <h3 className="mb-3 text-sm font-semibold text-navy-900 dark:text-white">Provedor</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="label">
                Provedor
                <select className="input" value={form.provider} onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}>
                  {(config?.provedores ?? []).map((p) => (
                    <option key={p.slug} value={p.slug}>
                      {p.nome} ({p.slug})
                    </option>
                  ))}
                </select>
              </label>
              <label className="label">
                Ambiente
                <select
                  className="input"
                  value={form.ambiente}
                  onChange={(e) => setForm((f) => ({ ...f, ambiente: e.target.value as 'homologacao' | 'producao' }))}
                >
                  <option value="homologacao">Homologação</option>
                  <option value="producao">Produção</option>
                </select>
              </label>
              <label className="label">
                CEP de origem
                <input
                  className="input"
                  placeholder="8 dígitos"
                  value={form.cep_origem}
                  onChange={(e) => setForm((f) => ({ ...f, cep_origem: e.target.value }))}
                />
              </label>
              <label className="label">
                Frete grátis acima de (0 = desligado)
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  className="input"
                  value={form.frete_gratis_acima}
                  onChange={(e) => setForm((f) => ({ ...f, frete_gratis_acima: e.target.value }))}
                />
              </label>
            </div>
          </div>

          <div className="card p-4">
            <h3 className="mb-1 text-sm font-semibold text-navy-900 dark:text-white">Melhor Envio</h3>
            <p className="mb-3 text-xs text-slate-500 dark:text-navy-300">
              Token{' '}
              {config?.me_token_configurado ? (
                <Badge tone="green">configurado ({config.me_token})</Badge>
              ) : (
                <Badge tone="slate">não configurado</Badge>
              )}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="label">
                Token (deixe em branco para manter)
                <input
                  type="password"
                  className="input"
                  autoComplete="off"
                  value={form.me_token}
                  onChange={(e) => setForm((f) => ({ ...f, me_token: e.target.value }))}
                />
              </label>
              <label className="label flex items-center gap-2 self-end pb-2">
                <input
                  type="checkbox"
                  checked={form.me_sandbox}
                  onChange={(e) => setForm((f) => ({ ...f, me_sandbox: e.target.checked }))}
                />
                Sandbox
              </label>
            </div>
          </div>

          <div className="card p-4">
            <h3 className="mb-1 text-sm font-semibold text-navy-900 dark:text-white">Correios (contrato corporativo)</h3>
            <p className="mb-3 text-xs text-slate-500 dark:text-navy-300">
              Senha{' '}
              {config?.correios_senha_configurada ? (
                <Badge tone="green">configurada ({config.correios_senha})</Badge>
              ) : (
                <Badge tone="slate">não configurada</Badge>
              )}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="label">
                Usuário
                <input
                  className="input"
                  value={form.correios_usuario}
                  onChange={(e) => setForm((f) => ({ ...f, correios_usuario: e.target.value }))}
                />
              </label>
              <label className="label">
                Código administrativo
                <input
                  className="input"
                  value={form.correios_codigo_administrativo}
                  onChange={(e) => setForm((f) => ({ ...f, correios_codigo_administrativo: e.target.value }))}
                />
              </label>
              <label className="label">
                Senha (deixe em branco para manter)
                <input
                  type="password"
                  className="input"
                  autoComplete="off"
                  value={form.correios_senha}
                  onChange={(e) => setForm((f) => ({ ...f, correios_senha: e.target.value }))}
                />
              </label>
            </div>
          </div>

          <div className="flex justify-end">
            <button className="btn-accent" onClick={() => void salvarConfig()} disabled={ocupado}>
              Salvar configuração
            </button>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- modais */}
      <PainelInline
        open={eventosDe !== null}
        onClose={() => setEventosDe(null)}
        title={`Eventos do envio #${eventosDe?.id ?? ''}`}
        subtitle={eventosDe?.codigo_rastreamento ?? undefined}
      >
        {eventos.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-navy-300">Sem eventos registrados.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {eventos.map((ev) => (
              <li key={ev.id} className="flex items-baseline justify-between gap-2">
                <span className="text-slate-600 dark:text-navy-200">
                  {ev.status ? <strong>{ROTULO[ev.status] ?? ev.status}</strong> : null}
                  {ev.mensagem ? ` — ${ev.mensagem}` : ''}
                </span>
                <span className="shrink-0 text-xs text-slate-400">{formatDateTime(ev.criado_em)}</span>
              </li>
            ))}
          </ul>
        )}
      </PainelInline>

      <PainelInline
        open={statusAberto !== null}
        onClose={() => setStatusAberto(null)}
        title={`Atualizar status do envio #${statusAberto?.id ?? ''}`}
        subtitle="Postado, em trânsito e entregue exigem rastreio ou referência do provedor — o banco recusa sem prova."
      >
        <div className="space-y-3">
          <label className="label">
            Status
            <select className="input" value={novoStatus.status} onChange={(e) => setNovoStatus((s) => ({ ...s, status: e.target.value }))}>
              {['gerado', 'postado', 'em_transito', 'entregue', 'erro'].map((s) => (
                <option key={s} value={s}>
                  {ROTULO[s] ?? s}
                </option>
              ))}
            </select>
          </label>
          <label className="label">
            Código de rastreamento
            <input
              className="input"
              value={novoStatus.codigo_rastreamento}
              onChange={(e) => setNovoStatus((s) => ({ ...s, codigo_rastreamento: e.target.value }))}
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setStatusAberto(null)}>
            Cancelar
          </button>
          <button className="btn-accent" onClick={() => void atualizarStatus()} disabled={ocupado}>
            Atualizar
          </button>
        </div>
      </PainelInline>
    </PageShell>
  );
}
