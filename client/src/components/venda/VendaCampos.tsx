import { useCallback, useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Building2, Calendar, RefreshCw, UserRound } from 'lucide-react';
import { api } from '../../lib/api';
import { hojeCivilIso, maskDataBR } from '../../lib/datas';
import { formatDate, formatMoney, maskMoneyInput, parseMoneyInput } from '../../lib/format';
import { Alert, Badge, Spinner } from '../ui';

export type ModoPessoaVenda = 'pf' | 'pj';

/** Formata um número (ou string numérica) como `R$ 1.500,00` para exibição em campo editável. */
export function formatarCampoMoeda(valor: unknown): string {
  const n = typeof valor === 'number' ? valor : parseMoneyInput(valor);
  if (n === null || !Number.isFinite(n)) return 'R$ 0,00';
  const seguro = Math.max(0, n);
  const mascarado = maskMoneyInput(seguro.toFixed(2).replace('.', ','));
  return `R$ ${mascarado || '0,00'}`;
}

/** Aplica máscara monetária mantendo o prefixo `R$ ` durante a digitação. */
export function maskMoedaComSimbolo(raw: string): string {
  const limpo = String(raw ?? '').trim();
  if (!limpo || limpo === 'R$' || limpo === 'R') return '';
  const m = maskMoneyInput(limpo);
  return m ? `R$ ${m}` : '';
}

/** Calcula prévia de parcelas em centavos inteiros (mesma regra de `dividirEmCentavos` no backend). */
export function previaParcelasReais(totalReais: number, qtdParcelas: number): number[] {
  const n = Math.max(1, Math.min(60, Math.trunc(Number(qtdParcelas) || 1)));
  const totalCentavos = Math.max(0, Math.round((Number(totalReais) || 0) * 100));
  if (totalCentavos === 0) return [0];
  if (totalCentavos < n) return [];
  const base = Math.floor(totalCentavos / n);
  const resto = totalCentavos - base * n;
  return Array.from({ length: n }, (_, i) => (i === 0 ? base + resto : base) / 100);
}

// ---------------------------------------------------------------------------
// Card de seção padronizado BroBond
// ---------------------------------------------------------------------------
export function SecaoVenda({
  etapa,
  titulo,
  subtitulo,
  direita,
  children,
}: {
  etapa: number;
  titulo: string;
  subtitulo?: string;
  direita?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="card p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3 dark:border-navy-800">
        <div className="flex items-start gap-3 min-w-0">
          <span
            aria-hidden="true"
            className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-navy-900 text-xs font-bold text-white dark:bg-brand-500 dark:text-navy-950"
          >
            {etapa}
          </span>
          <div className="min-w-0">
            <h2 id={headingId} className="text-base font-bold text-navy-900 dark:text-white">
              {titulo}
            </h2>
            {subtitulo && <p className="mt-0.5 text-xs text-slate-500 dark:text-navy-300">{subtitulo}</p>}
          </div>
        </div>
        {direita && <div className="flex flex-wrap items-center gap-2">{direita}</div>}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Seletor acessível de Modo de Cliente (PF — CPF / PJ — CNPJ)
// ---------------------------------------------------------------------------
const MODOS_PESSOA: Array<{
  valor: ModoPessoaVenda;
  titulo: string;
  documento: string;
  descricao: string;
  Icon: typeof UserRound;
}> = [
  {
    valor: 'pf',
    titulo: 'Pessoa Física',
    documento: 'CPF · 000.000.000-00',
    descricao: 'Consumidor final, venda varejo, busca por nome, CPF ou telefone.',
    Icon: UserRound,
  },
  {
    valor: 'pj',
    titulo: 'Pessoa Jurídica',
    documento: 'CNPJ · 00.000.000/0000-00',
    descricao: 'Empresa, lojista ou atacado, com Razão Social, Nome Fantasia e IE.',
    Icon: Building2,
  },
];

export function SeletorModoPessoa({
  valor,
  onChange,
  disabled = false,
}: {
  valor: ModoPessoaVenda;
  onChange: (novo: ModoPessoaVenda) => void;
  disabled?: boolean;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, atual: ModoPessoaVenda) => {
    if (disabled) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const proximo: ModoPessoaVenda = atual === 'pf' ? 'pj' : 'pf';
      onChange(proximo);
      const alvo = e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-modo-pessoa="${proximo}"]`);
      alvo?.focus();
    }
  };

  return (
    <div>
      <span id="rotulo-modo-cliente-venda" className="label">
        Modalidade do cliente <span className="text-red-500">*</span>
      </span>
      <div
        role="radiogroup"
        aria-labelledby="rotulo-modo-cliente-venda"
        className="mt-1 grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        {MODOS_PESSOA.map(({ valor: v, titulo, documento, descricao, Icon }) => {
          const ativo = valor === v;
          return (
            <button
              key={v}
              type="button"
              role="radio"
              data-modo-pessoa={v}
              aria-checked={ativo}
              tabIndex={ativo ? 0 : -1}
              disabled={disabled}
              onClick={() => !disabled && onChange(v)}
              onKeyDown={(e) => onKeyDown(e, v)}
              className={`flex items-start gap-3 rounded-xl border p-3.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60 ${
                ativo
                  ? 'border-brand-500 bg-brand-50/70 ring-2 ring-brand-500/25 dark:border-brand-400 dark:bg-brand-500/10'
                  : 'border-slate-200 bg-white hover:border-slate-300 dark:border-navy-700 dark:bg-navy-900 dark:hover:border-navy-600'
              }`}
            >
              <div
                className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                  ativo
                    ? 'bg-brand-500 text-white'
                    : 'bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-navy-200'
                }`}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-navy-900 dark:text-white">{titulo}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 dark:bg-navy-800 dark:text-navy-200">
                    {documento}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-navy-300">{descricao}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Campo de Data no padrão brasileiro dd/mm/aaaa
// ---------------------------------------------------------------------------
export function CampoDataVenda({
  id,
  rotulo,
  valorBr,
  onChangeBr,
  obrigatorio = false,
  disabled = false,
  erro,
  dica,
  mostrarAtalhoHoje = false,
}: {
  id: string;
  rotulo: string;
  valorBr: string;
  onChangeBr: (novoBr: string) => void;
  obrigatorio?: boolean;
  disabled?: boolean;
  erro?: string;
  dica?: string;
  mostrarAtalhoHoje?: boolean;
}) {
  const erroId = `${id}-erro`;
  const dicaId = `${id}-dica`;
  const desc = [erro ? erroId : null, dica ? dicaId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="label !mb-0">
          {rotulo}
          {obrigatorio && <span className="text-red-500"> *</span>}
        </label>
        {mostrarAtalhoHoje && !disabled && (
          <button
            type="button"
            className="text-[11px] font-semibold text-brand-700 hover:underline dark:text-brand-300"
            onClick={() => onChangeBr(maskDataBR(hojeCivilIso()))}
          >
            Hoje
          </button>
        )}
      </div>
      <div className="relative mt-1">
        <input
          id={id}
          name={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="dd/mm/aaaa"
          maxLength={10}
          disabled={disabled}
          value={valorBr}
          aria-invalid={!!erro || undefined}
          aria-describedby={desc}
          onChange={(e) => onChangeBr(maskDataBR(e.target.value))}
          className={`input w-full pr-9 tabular-nums ${erro ? 'border-red-400 focus:border-red-500 focus:ring-red-200' : ''}`}
        />
        <Calendar className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
      </div>
      {erro && (
        <p id={erroId} role="alert" className="mt-1 text-xs font-medium text-red-600 dark:text-red-400">
          {erro}
        </p>
      )}
      {!erro && dica && (
        <p id={dicaId} className="mt-1 text-xs text-slate-500 dark:text-navy-300">
          {dica}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Campo Monetário no padrão brasileiro R$ 1.500,00
// ---------------------------------------------------------------------------
export function CampoMoedaVenda({
  id,
  rotulo,
  valorTexto,
  onChangeTexto,
  obrigatorio = false,
  disabled = false,
  erro,
  dica,
}: {
  id: string;
  rotulo: string;
  valorTexto: string;
  onChangeTexto: (novo: string) => void;
  obrigatorio?: boolean;
  disabled?: boolean;
  erro?: string;
  dica?: string;
}) {
  const erroId = `${id}-erro`;
  const dicaId = `${id}-dica`;
  const desc = [erro ? erroId : null, dica ? dicaId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div>
      <label htmlFor={id} className="label">
        {rotulo}
        {obrigatorio && <span className="text-red-500"> *</span>}
      </label>
      <input
        id={id}
        name={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder="R$ 0,00"
        disabled={disabled}
        value={valorTexto}
        aria-invalid={!!erro || undefined}
        aria-describedby={desc}
        onChange={(e) => onChangeTexto(maskMoedaComSimbolo(e.target.value))}
        onBlur={() => {
          const n = parseMoneyInput(valorTexto);
          onChangeTexto(formatarCampoMoeda(n ?? 0));
        }}
        className={`input w-full tabular-nums ${erro ? 'border-red-400 focus:border-red-500 focus:ring-red-200' : ''}`}
      />
      {erro && (
        <p id={erroId} role="alert" className="mt-1 text-xs font-medium text-red-600 dark:text-red-400">
          {erro}
        </p>
      )}
      {!erro && dica && (
        <p id={dicaId} className="mt-1 text-xs text-slate-500 dark:text-navy-300">
          {dica}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Parcelas reais geradas no motor financeiro (`lancamentos_financeiros`)
// ---------------------------------------------------------------------------
const FORMA_LABEL: Record<string, string> = {
  pix: 'PIX',
  cartao_credito: 'Cartão de crédito',
  cartao_debito: 'Cartão de débito',
  boleto: 'Boleto',
  dinheiro: 'Dinheiro',
  transferencia: 'Transferência',
  outros: 'Outros',
};

export function ContasAReceberDaVenda({
  vendaId,
  pedidoStatus,
  finStatus,
  finParcelas,
  podeVerLancamentos,
}: {
  vendaId: number;
  pedidoStatus: string;
  finStatus: string;
  finParcelas: number;
  podeVerLancamentos: boolean;
}) {
  const [parcelas, setParcelas] = useState<
    Array<{
      id: number;
      parcela?: number;
      total_parcelas?: number;
      vencimento?: string | null;
      valor?: number | string;
      forma_pagamento?: string | null;
      status?: string | null;
    }>
  >([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    if (!podeVerLancamentos || !vendaId) return;
    setCarregando(true);
    setErro(null);
    try {
      const r = await api.get<{
        rows: Array<{
          id: number;
          parcela?: number;
          total_parcelas?: number;
          vencimento?: string | null;
          valor?: number | string;
          forma_pagamento?: string | null;
          status?: string | null;
        }>;
      }>(
        `/lancamentos_financeiros?f.referencia_tipo=venda&f.referencia_id=${vendaId}&pageSize=100`
      );
      const rows = [...(r?.rows || [])].sort((a, b) => Number(a.parcela || 1) - Number(b.parcela || 1));
      setParcelas(rows);
    } catch {
      // Silencioso quando mockado parcialmente em testes ou indisponível; o botão permite tentar de novo.
      setParcelas([]);
    } finally {
      setCarregando(false);
    }
  }, [podeVerLancamentos, vendaId]);

  useEffect(() => {
    void carregar();
  }, [carregar, pedidoStatus, finStatus, finParcelas]);

  if (!podeVerLancamentos) {
    return (
      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-600 dark:border-navy-700 dark:bg-navy-800/50 dark:text-navy-200">
        As parcelas de contas a receber são geradas automaticamente ao faturar a venda e acompanhadas pelo perfil gerencial em <strong>Financeiro → Lançamentos</strong>.
      </div>
    );
  }

  const total = parcelas.reduce((acc, p) => acc + Number(p.valor || 0), 0);
  const recebidas = parcelas.filter((p) => String(p.status) === 'confirmado');
  const totalRecebido = recebidas.reduce((acc, p) => acc + Number(p.valor || 0), 0);

  return (
    <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50/60 p-4 dark:border-navy-700 dark:bg-navy-800/40">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-navy-200">
          Contas a receber geradas no financeiro
        </h3>
        <button
          type="button"
          className="btn-icon !p-1"
          onClick={() => void carregar()}
          title="Recarregar parcelas"
          aria-label="Recarregar contas a receber"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {carregando && <Spinner label="Consultando parcelas..." />}
      {!carregando && erro && <Alert tone="red">{erro}</Alert>}

      {!carregando && !erro && parcelas.length === 0 && (
        <p className="mt-2 text-xs text-slate-500 dark:text-navy-300">
          {['faturada', 'entregue'].includes(pedidoStatus)
            ? 'Nenhum lançamento em aberto para esta venda (verifique se o valor total é maior que zero ou se a situação financeira está cancelada).'
            : 'Os lançamentos de contas a receber serão criados automaticamente assim que o pedido for finalizado/faturado.'}
        </p>
      )}

      {!carregando && !erro && parcelas.length > 0 && (
        <div className="mt-3">
          <div className="overflow-x-auto">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>Parcela</th>
                  <th>Vencimento</th>
                  <th className="text-right">Valor</th>
                  <th>Forma</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {parcelas.map((p) => (
                  <tr key={p.id}>
                    <td className="tabular-nums">
                      {p.parcela || 1}/{p.total_parcelas || 1}
                    </td>
                    <td>{p.vencimento ? formatDate(p.vencimento) : 'Não informado'}</td>
                    <td className="text-right font-semibold tabular-nums">{formatMoney(p.valor)}</td>
                    <td>{FORMA_LABEL[String(p.forma_pagamento || '')] || p.forma_pagamento || '—'}</td>
                    <td>
                      <Badge
                        tone={
                          String(p.status) === 'confirmado'
                            ? 'green'
                            : String(p.status) === 'cancelado'
                              ? 'red'
                              : 'amber'
                        }
                      >
                        {String(p.status || 'pendente')}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600 dark:text-navy-200">
            <span>
              Previsto: <strong className="tabular-nums">{formatMoney(total)}</strong>
            </span>
            <span>
              Recebido: <strong className="tabular-nums text-emerald-700 dark:text-emerald-400">{formatMoney(totalRecebido)}</strong>
            </span>
            <span>
              Em aberto: <strong className="tabular-nums">{formatMoney(Math.max(0, total - totalRecebido))}</strong>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
