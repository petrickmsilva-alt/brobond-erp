import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Search,
  UserPlus,
  UserRound,
  X,
} from 'lucide-react';
import { api } from '../../lib/api';
import {
  cnpjValido,
  cpfValido,
  formatDocumento,
  formatMoney,
  formatPhone,
  normalizePhone,
  soDigitos,
} from '../../lib/format';
import { Badge } from '../ui';
import type { ModoPessoaVenda } from './VendaCampos';

export type ClienteVendaRegistro = {
  id: number;
  nome: string;
  pessoa?: 'pf' | 'pj' | 'estrangeiro' | string | null;
  cnpj_cpf?: string | null;
  razao_social?: string | null;
  nome_fantasia?: string | null;
  rg_ie?: string | null;
  indicador_ie?: string | null;
  im?: string | null;
  suframa?: string | null;
  telefone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  cep?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  codigo_municipio?: string | null;
  uf?: string | null;
  limite_credito?: number | string | null;
  representante_id?: number | null;
  ativo?: boolean;
  [k: string]: unknown;
};

const INDICADOR_IE_LABEL: Record<string, string> = {
  '1': 'Contribuinte ICMS',
  '2': 'Contribuinte isento de IE',
  '9': 'Não contribuinte',
};

/** Infere se um registro de cliente deve operar no modo PF ou PJ. */
export function inferirModoPessoaCliente(c: Partial<ClienteVendaRegistro> | null | undefined): ModoPessoaVenda {
  if (!c) return 'pf';
  if (c.pessoa === 'pj') return 'pj';
  if (c.pessoa === 'pf') return 'pf';
  const dig = soDigitos(c.cnpj_cpf);
  return dig.length === 14 ? 'pj' : 'pf';
}

/** Normaliza o termo de busca: se o operador digitou documento/telefone com pontuação, envia só dígitos. */
export function normalizarTermoBuscaCliente(termo: string): string {
  const limpo = termo.trim();
  if (!limpo) return '';
  // Se contém apenas dígitos e separadores típicos de CPF, CNPJ ou telefone, envia os dígitos puros.
  if (/^[\d.\-/()\s+]+$/.test(limpo)) {
    const dig = soDigitos(limpo);
    if (dig.length >= 3) return dig;
  }
  return limpo;
}

/** Aviso imediato quando o usuário digita um CPF ou CNPJ com dígito verificador inválido. */
function validarDocumentoDigitadoNaBusca(termo: string, modo: ModoPessoaVenda): string | null {
  const limpo = termo.trim();
  if (!limpo) return null;
  const apenasPontuacaoDoc = /^[\d.\-/]+$/.test(limpo);
  if (!apenasPontuacaoDoc) return null;
  const dig = soDigitos(limpo);
  if (modo === 'pf') {
    const formatadoComoCpf = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(limpo);
    if (dig.length === 11 && (formatadoComoCpf || normalizePhone(dig) === null) && !cpfValido(dig)) {
      return 'CPF inválido — confira os dígitos verificadores (000.000.000-00).';
    }
  } else if (modo === 'pj') {
    if (dig.length === 14 && !cnpjValido(dig)) {
      return 'CNPJ inválido — confira os 14 dígitos verificadores (00.000.000/0000-00).';
    }
  }
  return null;
}

/** Pendências informativas para emissão futura de NF-e modelo 55 (baseadas no contrato de `fiscal.ts`). */
export function pendenciasFiscaisCliente(c: ClienteVendaRegistro | null, modo: ModoPessoaVenda): string[] {
  if (!c) return [];
  const pend: string[] = [];
  const doc = soDigitos(c.cnpj_cpf);
  if (modo === 'pf' && doc.length !== 11) pend.push('CPF não cadastrado');
  if (modo === 'pj' && doc.length !== 14) pend.push('CNPJ não cadastrado');
  if (modo === 'pj' && String(c.indicador_ie || '') === '1' && !String(c.rg_ie || '').trim()) {
    pend.push('Inscrição Estadual (IE) obrigatória para contribuinte ICMS');
  }
  if (!String(c.uf || '').trim() || !String(c.codigo_municipio || '').trim() || !String(c.logradouro || '').trim()) {
    pend.push('Endereço fiscal incompleto (logradouro, código IBGE ou UF) para NF-e 55');
  }
  return pend;
}

export function ClienteVendaSelector({
  id = 'venda-cliente-busca',
  modo,
  onAlternarModo,
  cliente,
  clienteLabelFallback,
  onSelecionar,
  onNavigate,
  disabled = false,
  erro,
}: {
  id?: string;
  modo: ModoPessoaVenda;
  onAlternarModo: (novo: ModoPessoaVenda) => void;
  cliente: ClienteVendaRegistro | null;
  clienteLabelFallback?: string | null;
  onSelecionar: (c: ClienteVendaRegistro | null) => void;
  onNavigate: (rota: string) => void;
  disabled?: boolean;
  erro?: string;
}) {
  const listboxId = useId();
  const erroId = `${id}-erro`;
  const avisoId = `${id}-aviso`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

  const [termo, setTermo] = useState('');
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [erroBusca, setErroBusca] = useState('');
  const [resultados, setResultados] = useState<ClienteVendaRegistro[]>([]);
  const [indiceAtivo, setIndiceAtivo] = useState(0);
  const [conflitoOutroModo, setConflitoOutroModo] = useState<ClienteVendaRegistro | null>(null);

  const avisoDoc = validarDocumentoDigitadoNaBusca(termo, modo);

  // Fecha a lista ao clicar fora do componente.
  useEffect(() => {
    const aoClicarFora = (ev: PointerEvent) => {
      if (!rootRef.current?.contains(ev.target as Node)) setAberto(false);
    };
    document.addEventListener('pointerdown', aoClicarFora);
    return () => document.removeEventListener('pointerdown', aoClicarFora);
  }, []);

  // Limpa resultados antigos ao trocar entre PF e PJ.
  useEffect(() => {
    seqRef.current += 1;
    setResultados([]);
    setConflitoOutroModo(null);
    setErroBusca('');
    setIndiceAtivo(0);
  }, [modo]);

  const buscarClientes = useCallback(
    async (bruto: string) => {
      const qEnvio = normalizarTermoBuscaCliente(bruto);
      const dig = soDigitos(bruto);
      const reqId = ++seqRef.current;
      setCarregando(true);
      setErroBusca('');
      setConflitoOutroModo(null);

      try {
        const params = new URLSearchParams();
        params.set('f.pessoa', modo);
        params.set('f.ativo', 'true');
        params.set('pageSize', '12');
        if (qEnvio) params.set('q', qEnvio);

        const promessaLista = api.get<{ rows?: ClienteVendaRegistro[] }>(`/clientes?${params.toString()}`);
        const promessaDocExato =
          (dig.length === 11 && cpfValido(dig)) || (dig.length === 14 && cnpjValido(dig))
            ? api
                .get<{ encontrado?: boolean; cliente?: ClienteVendaRegistro }>(
                  `/clientes/por-documento?documento=${encodeURIComponent(dig)}`
                )
                .catch(() => null)
            : Promise.resolve(null);

        const [lista, exato] = await Promise.all([promessaLista, promessaDocExato]);
        if (reqId !== seqRef.current) return;

        let linhas = Array.isArray(lista?.rows) ? [...lista.rows] : [];
        if (exato?.encontrado && exato.cliente) {
          const modoExato = inferirModoPessoaCliente(exato.cliente);
          if (modoExato !== modo) {
            setConflitoOutroModo(exato.cliente);
          } else if (!linhas.some((r) => r.id === exato.cliente!.id)) {
            linhas = [exato.cliente, ...linhas];
          }
        }

        setResultados(linhas);
        setIndiceAtivo(0);
      } catch (e: unknown) {
        if (reqId !== seqRef.current) return;
        setResultados([]);
        setErroBusca(e instanceof Error && e.message ? e.message : 'Não foi possível pesquisar clientes.');
      } finally {
        if (reqId === seqRef.current) setCarregando(false);
      }
    },
    [modo]
  );

  // Busca com debounce curto quando o usuário digita ou abre o combobox.
  useEffect(() => {
    if (!aberto || disabled || cliente) return;
    const timer = window.setTimeout(() => {
      void buscarClientes(termo);
    }, termo.trim() ? 160 : 0);
    return () => window.clearTimeout(timer);
  }, [aberto, buscarClientes, cliente, disabled, termo]);

  const confirmarSelecao = (escolhido: ClienteVendaRegistro) => {
    onSelecionar(escolhido);
    setTermo('');
    setResultados([]);
    setConflitoOutroModo(null);
    setAberto(false);
  };

  const limparCliente = () => {
    onSelecionar(null);
    setTermo('');
    setResultados([]);
    setConflitoOutroModo(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!aberto) {
        setAberto(true);
        return;
      }
      if (resultados.length > 0) {
        setIndiceAtivo((atual) => (atual + 1) % resultados.length);
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!aberto) {
        setAberto(true);
        return;
      }
      if (resultados.length > 0) {
        setIndiceAtivo((atual) => (atual - 1 + resultados.length) % resultados.length);
      }
      return;
    }
    if (e.key === 'Enter' && aberto && resultados[indiceAtivo]) {
      e.preventDefault();
      confirmarSelecao(resultados[indiceAtivo]);
      return;
    }
    if (e.key === 'Escape') {
      if (aberto) {
        e.preventDefault();
        setAberto(false);
      }
      return;
    }
    if (e.key === 'Tab') {
      setAberto(false);
    }
  };

  // Quando há um cliente selecionado (ou vínculo salvo vindo do pedido): exibe o card completo PF/PJ.
  if (cliente || clienteLabelFallback) {
    const ehPj = cliente ? inferirModoPessoaCliente(cliente) === 'pj' : modo === 'pj';
    const docFormatado = cliente?.cnpj_cpf ? formatDocumento(cliente.cnpj_cpf) : '';
    const tel = cliente?.telefone ? formatPhone(cliente.telefone) : '';
    const zap = cliente?.whatsapp && cliente.whatsapp !== cliente.telefone ? formatPhone(cliente.whatsapp) : '';
    const razao = String(cliente?.razao_social || cliente?.nome || clienteLabelFallback || '');
    const fantasia = String(cliente?.nome_fantasia || '');
    const indIe = cliente?.indicador_ie ? INDICADOR_IE_LABEL[String(cliente.indicador_ie)] || String(cliente.indicador_ie) : '';
    const cidadeUf = [cliente?.cidade, cliente?.uf].filter(Boolean).join('/');
    const enderecoResumo = [cliente?.logradouro, cliente?.numero, cliente?.bairro, cidadeUf].filter(Boolean).join(', ');
    const pendencias = cliente ? pendenciasFiscaisCliente(cliente, ehPj ? 'pj' : 'pf') : [];

    return (
      <div ref={rootRef} className="space-y-3">
        <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-navy-700 dark:bg-navy-800/40">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-navy-900 text-white dark:bg-brand-500 dark:text-navy-950">
                {ehPj ? <Building2 className="h-5 w-5" aria-hidden="true" /> : <UserRound className="h-5 w-5" aria-hidden="true" />}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-bold text-navy-900 dark:text-white">
                    {ehPj ? razao : String(cliente?.nome || clienteLabelFallback || '')}
                  </span>
                  <Badge tone={ehPj ? 'blue' : 'amber'}>
                    {ehPj ? 'Pessoa Jurídica (CNPJ)' : 'Pessoa Física (CPF)'}
                  </Badge>
                  {cliente?.ativo === false && <Badge tone="red">Inativo</Badge>}
                </div>

                {ehPj && fantasia && fantasia.toLowerCase() !== razao.toLowerCase() && (
                  <p className="mt-0.5 text-xs font-medium text-slate-600 dark:text-navy-200">
                    Nome fantasia: <strong className="text-slate-800 dark:text-white">{fantasia}</strong>
                  </p>
                )}

                <dl className="mt-2.5 grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <dt className="inline font-semibold text-slate-500 dark:text-navy-300">
                      {ehPj ? 'CNPJ: ' : 'CPF: '}
                    </dt>
                    <dd className="inline font-mono text-slate-800 dark:text-slate-100">
                      {docFormatado || 'Não informado'}
                    </dd>
                  </div>

                  {ehPj && (
                    <div>
                      <dt className="inline font-semibold text-slate-500 dark:text-navy-300">IE: </dt>
                      <dd className="inline font-mono text-slate-800 dark:text-slate-100">
                        {String(cliente?.rg_ie || '').trim() || (String(cliente?.indicador_ie) === '2' ? 'ISENTO' : 'Não informada')}
                      </dd>
                    </div>
                  )}

                  {ehPj && indIe && (
                    <div>
                      <dt className="inline font-semibold text-slate-500 dark:text-navy-300">ICMS: </dt>
                      <dd className="inline text-slate-800 dark:text-slate-100">{indIe}</dd>
                    </div>
                  )}

                  {ehPj && Boolean(cliente?.im) && (
                    <div>
                      <dt className="inline font-semibold text-slate-500 dark:text-navy-300">IM: </dt>
                      <dd className="inline font-mono text-slate-800 dark:text-slate-100">{String(cliente?.im)}</dd>
                    </div>
                  )}

                  {ehPj && Boolean(cliente?.suframa) && (
                    <div>
                      <dt className="inline font-semibold text-slate-500 dark:text-navy-300">SUFRAMA: </dt>
                      <dd className="inline font-mono text-slate-800 dark:text-slate-100">{String(cliente?.suframa)}</dd>
                    </div>
                  )}

                  {(tel || zap) && (
                    <div className="flex items-center gap-1">
                      <Phone className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                      <dd className="truncate text-slate-700 dark:text-slate-200">{[tel, zap].filter(Boolean).join(' · ')}</dd>
                    </div>
                  )}

                  {Boolean(cliente?.email) && (
                    <div className="flex items-center gap-1">
                      <Mail className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                      <dd className="truncate text-slate-700 dark:text-slate-200">{String(cliente?.email)}</dd>
                    </div>
                  )}

                  {enderecoResumo && (
                    <div className="flex items-center gap-1 sm:col-span-2">
                      <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                      <dd className="truncate text-slate-700 dark:text-slate-200">{enderecoResumo}</dd>
                    </div>
                  )}

                  {Number(cliente?.limite_credito || 0) > 0 && (
                    <div>
                      <dt className="inline font-semibold text-slate-500 dark:text-navy-300">Limite de crédito: </dt>
                      <dd className="inline font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                        {formatMoney(cliente?.limite_credito)}
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {cliente?.id && (
                <button
                  type="button"
                  className="btn-secondary !px-3 !py-1.5 text-xs"
                  onClick={() => onNavigate(`/clientes/${cliente.id}/editar`)}
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  Ver cadastro
                </button>
              )}
              {!disabled && (
                <button
                  type="button"
                  className="btn-secondary !px-3 !py-1.5 text-xs"
                  onClick={limparCliente}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  Trocar cliente
                </button>
              )}
            </div>
          </div>

          {cliente && (
            <div className="mt-3 border-t border-slate-200/80 pt-2.5 text-xs dark:border-navy-700">
              {pendencias.length === 0 ? (
                <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Cadastro fiscal apto para NF-e (modelo 55) e NFC-e (modelo 65).
                </span>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 text-amber-800 dark:text-amber-300">
                  <span className="inline-flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Atenção para NF-e 55: {pendencias.join('; ')}. (A venda comercial e a NFC-e continuam liberadas.)
                  </span>
                  {cliente.id && (
                    <button
                      type="button"
                      className="font-semibold underline hover:no-underline"
                      onClick={() => onNavigate(`/clientes/${cliente.id}/editar`)}
                    >
                      Completar dados do cliente
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Estado de busca e seleção de cliente existente (PF ou PJ)
  const rotuloBusca =
    modo === 'pf'
      ? 'Buscar cliente Pessoa Física (nome, CPF ou telefone)'
      : 'Buscar cliente Pessoa Jurídica (CNPJ, razão social ou nome fantasia)';
  const placeholderBusca =
    modo === 'pf'
      ? 'Digite nome, CPF (000.000.000-00 ou só números) ou telefone...'
      : 'Digite CNPJ (00.000.000/0000-00 ou só números), razão social ou nome fantasia...';

  const describedBy = [erro ? erroId : null, avisoDoc ? avisoId : null].filter(Boolean).join(' ') || undefined;
  const opcaoAtivaDomId =
    aberto && resultados[indiceAtivo] ? `${listboxId}-opt-${resultados[indiceAtivo].id}` : undefined;

  return (
    <div ref={rootRef} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="label !mb-0">
          {rotuloBusca} <span className="text-red-500">*</span>
        </label>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300"
          onClick={() => onNavigate('/clientes/novo')}
        >
          <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
          Cadastrar novo cliente
        </button>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <input
          ref={inputRef}
          id={id}
          name={id}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={aberto}
          aria-controls={listboxId}
          aria-activedescendant={opcaoAtivaDomId}
          aria-invalid={!!(erro || avisoDoc) || undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          disabled={disabled}
          placeholder={placeholderBusca}
          value={termo}
          onFocus={() => {
            if (!disabled) setAberto(true);
          }}
          onChange={(e) => {
            setTermo(e.target.value);
            setAberto(true);
          }}
          onKeyDown={onKeyDown}
          className={`input w-full pl-9 pr-9 ${
            erro || avisoDoc ? 'border-red-400 focus:border-red-500 focus:ring-red-200' : ''
          }`}
        />
        {carregando ? (
          <Loader2
            className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400"
            aria-label="Pesquisando clientes"
          />
        ) : termo ? (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            onClick={() => {
              setTermo('');
              inputRef.current?.focus();
            }}
            aria-label="Limpar busca de cliente"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}

        {aberto && !disabled && (
          <div
            id={listboxId}
            role="listbox"
            aria-label={modo === 'pf' ? 'Clientes Pessoa Física encontrados' : 'Clientes Pessoa Jurídica encontrados'}
            className="absolute z-40 mt-1 max-h-80 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl dark:border-navy-700 dark:bg-navy-900"
          >
            {carregando && resultados.length === 0 && (
              <div className="px-4 py-3 text-sm text-slate-500">Pesquisando clientes na empresa ativa…</div>
            )}

            {!carregando && erroBusca && (
              <div role="alert" className="px-4 py-3 text-sm text-red-600">
                {erroBusca}
              </div>
            )}

            {!carregando && conflitoOutroModo && (
              <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
                <p className="font-semibold">
                  Este documento já pertence a um cliente{' '}
                  {inferirModoPessoaCliente(conflitoOutroModo) === 'pj' ? 'Pessoa Jurídica (CNPJ)' : 'Pessoa Física (CPF)'}:{' '}
                  <strong>{String(conflitoOutroModo.razao_social || conflitoOutroModo.nome)}</strong>.
                </p>
                <button
                  type="button"
                  className="mt-1.5 font-bold text-brand-700 underline hover:no-underline dark:text-brand-300"
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => {
                    const novoModo = inferirModoPessoaCliente(conflitoOutroModo);
                    onAlternarModo(novoModo);
                    confirmarSelecao(conflitoOutroModo);
                  }}
                >
                  Alternar modalidade e selecionar este cliente (evitar duplicidade)
                </button>
              </div>
            )}

            {!carregando && !erroBusca && resultados.length === 0 && (
              <div className="px-4 py-3 text-sm text-slate-500 dark:text-navy-300">
                <p>
                  Nenhum cliente {modo === 'pf' ? 'Pessoa Física' : 'Pessoa Jurídica'} encontrado
                  {termo.trim() ? ` para “${termo.trim()}”` : ''}.
                </p>
                <button
                  type="button"
                  className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300"
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => onNavigate('/clientes/novo')}
                >
                  <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
                  Cadastrar em Clientes (sem duplicar)
                </button>
              </div>
            )}

            {resultados.map((item, idx) => {
              const ativo = idx === indiceAtivo;
              const ehItemPj = inferirModoPessoaCliente(item) === 'pj';
              const tituloPrincipal = ehItemPj ? String(item.razao_social || item.nome) : String(item.nome);
              const doc = item.cnpj_cpf ? formatDocumento(item.cnpj_cpf) : '';
              const tel = item.telefone ? formatPhone(item.telefone) : item.whatsapp ? formatPhone(item.whatsapp) : '';
              return (
                <button
                  key={item.id}
                  id={`${listboxId}-opt-${item.id}`}
                  type="button"
                  role="option"
                  aria-selected={ativo}
                  onMouseDown={(ev) => ev.preventDefault()}
                  onMouseEnter={() => setIndiceAtivo(idx)}
                  onClick={() => confirmarSelecao(item)}
                  className={`flex w-full items-start justify-between gap-3 border-b border-slate-100 px-4 py-2.5 text-left transition last:border-b-0 dark:border-navy-800 ${
                    ativo
                      ? 'bg-brand-50 text-navy-950 dark:bg-brand-500/15 dark:text-white'
                      : 'hover:bg-slate-50 dark:hover:bg-navy-800/60'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-navy-900 dark:text-white">
                      {tituloPrincipal}
                    </div>
                    {ehItemPj && item.nome_fantasia && String(item.nome_fantasia).toLowerCase() !== tituloPrincipal.toLowerCase() && (
                      <div className="truncate text-xs text-slate-600 dark:text-navy-200">
                        Fantasia: {String(item.nome_fantasia)}
                      </div>
                    )}
                    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500 dark:text-navy-300">
                      {doc && <span className="font-mono">{ehItemPj ? `CNPJ ${doc}` : `CPF ${doc}`}</span>}
                      {ehItemPj && Boolean(item.rg_ie) && <span className="font-mono">IE {String(item.rg_ie)}</span>}
                      {tel && <span>{tel}</span>}
                      {Boolean(item.email) && <span>{String(item.email)}</span>}
                      {(item.cidade || item.uf) && <span>{[item.cidade, item.uf].filter(Boolean).join('/')}</span>}
                    </div>
                  </div>
                  <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 dark:bg-navy-800 dark:text-navy-200">
                    #{item.id}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {avisoDoc && (
        <p id={avisoId} role="alert" className="text-xs font-medium text-amber-700 dark:text-amber-300">
          {avisoDoc}
        </p>
      )}
      {erro && (
        <p id={erroId} role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
          {erro}
        </p>
      )}
    </div>
  );
}
