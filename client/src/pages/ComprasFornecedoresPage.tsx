// ============================================================================
// COMPRAS — HOMOLOGAÇÃO DE FORNECEDOR (módulo /compras/fornecedores)
//
// Uma página, três perguntas do comprador:
//   1) QUEM PODE COMPRAR? — lista de fornecedores com o estado de homologação,
//      filtro por estado e pendências visíveis (documento vencido, categoria
//      não definida). Suspenso/bloqueado não recebe pedido novo — a regra vale
//      no servidor (POST /api/compras), não só nesta tela.
//   2) POR QUE ESTE FORNECEDOR ESTÁ NESTE ESTADO? — a ficha inline mostra a
//      trilha de homologação, os documentos com validade e o motivo do bloqueio.
//   3) ELE ENTREGA BEM? — desempenho CALCULADO de compras/itens/recebimentos
//      já existentes, com cada parcela do score explicada. Nada é digitado
//      aqui; a única nota humana é a avaliação manual (0–5) do cadastro.
//
// ZERO MODAL: a ficha abre como seção da própria página (ao lado/abaixo da
// lista) e as ações de estado são botões inline com motivo em campo de texto.
// Nenhum drawer, nenhuma sobreposição.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileText, Loader2, RefreshCw, ShieldAlert, TrendingUp } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { ListResult } from '../lib/meta';
import { Alert, Badge, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';
import { StatCard } from '../components/ui-kit-negocios';
import { formatDate } from '../lib/format';

type Status = 'pendente' | 'em_analise' | 'homologado' | 'suspenso' | 'bloqueado';

type Fornecedor = {
  id: number;
  nome: string;
  homologacao_status: Status;
  homologacao_categoria: string | null;
  validade_documentos: string | null;
  avaliacao_manual: number | null;
  homologacao_motivo: string | null;
};

type Documento = { id: number; tipo: string; numero: string | null; validade: string | null; situacao: string; vencido: boolean };
type Evento = { id: number; status_anterior: string | null; status_novo: string; motivo: string | null; criado_em: string; usuario_id: number | null };
type Ficha = {
  status: Status;
  proximos: Status[];
  pendencias: string[];
  documentos: Documento[];
  eventos: Evento[];
  categoria: string | null;
  motivo: string | null;
  homologado_em: string | null;
};
type Desempenho = {
  score: number;
  classificacao: string;
  fatores: { chave: string; label: string; pontos: number; detalhe: string }[];
  historico: { pedidos: number; recebidos: number; em_aberto: number; cancelados: number; ultimo_pedido: string | null; total_comprado: number; ticket_medio: number };
  prazo: { com_previsao: number; no_prazo: number; atraso_medio_dias: number | null };
  atendimento: { quantidade_pedida: number; quantidade_recebida: number; percentual: number | null };
  preco: { itens_comparaveis: number; indice: number | null };
  avaliacao_manual: number | null;
};

const STATUS: { value: Status; label: string; tom: 'amber' | 'blue' | 'green' | 'red' | 'slate' }[] = [
  { value: 'pendente', label: 'Pendente', tom: 'amber' },
  { value: 'em_analise', label: 'Em análise', tom: 'blue' },
  { value: 'homologado', label: 'Homologado', tom: 'green' },
  { value: 'suspenso', label: 'Suspenso', tom: 'red' },
  { value: 'bloqueado', label: 'Bloqueado', tom: 'red' },
];
const rotulo = (s: string) => STATUS.find((x) => x.value === s)?.label ?? s;
const tom = (s: string) => STATUS.find((x) => x.value === s)?.tom ?? 'slate';

const CATEGORIAS = [
  { value: 'materia_prima', label: 'Matéria-prima' },
  { value: 'embalagem', label: 'Embalagem' },
  { value: 'acabamento', label: 'Acabamento / beneficiamento' },
  { value: 'servico', label: 'Serviço' },
  { value: 'logistica', label: 'Logística / transporte' },
  { value: 'quimico', label: 'Químico' },
  { value: 'outro', label: 'Outro' },
];

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function ComprasFornecedoresPage() {
  const toast = useToast();
  const [lista, setLista] = useState<ListResult<Fornecedor> | null>(null);
  const [painel, setPainel] = useState<any>(null);
  const [filtro, setFiltro] = useState<'' | Status>('');
  const [busca, setBusca] = useState('');
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);

  const [selecionado, setSelecionado] = useState<number | null>(null);
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [desempenho, setDesempenho] = useState<Desempenho | null>(null);
  const [carregandoFicha, setCarregandoFicha] = useState(false);

  const [motivo, setMotivo] = useState('');
  const [categoria, setCategoria] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const query = new URLSearchParams({ page: '1', pageSize: '200', sort: 'nome', dir: 'asc' });
      if (filtro) query.set('f.homologacao_status', filtro);
      if (busca.trim()) query.set('q', busca.trim());
      const [fornecedores, resumo] = await Promise.all([
        api.get<ListResult<Fornecedor>>(`/fornecedores?${query.toString()}`),
        api.get<any>('/compras/painel').catch(() => null),
      ]);
      setLista(fornecedores);
      setPainel(resumo);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os fornecedores.');
    } finally {
      setCarregando(false);
    }
  }, [filtro, busca]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const abrir = useCallback(async (id: number) => {
    setSelecionado(id);
    setCarregandoFicha(true);
    setFicha(null);
    setDesempenho(null);
    setMotivo('');
    setCategoria('');
    try {
      const [f, d] = await Promise.all([
        api.get<Ficha>(`/compras/fornecedores/${id}/homologacao`),
        api.get<Desempenho>(`/compras/fornecedores/${id}/desempenho`).catch(() => null),
      ]);
      setFicha(f);
      setDesempenho(d);
      setCategoria(f.categoria ?? '');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível abrir a homologação.');
    } finally {
      setCarregandoFicha(false);
    }
  }, [toast]);

  async function mudarPara(status: Status) {
    if (!selecionado) return;
    if ((status === 'suspenso' || status === 'bloqueado') && !motivo.trim()) {
      toast.error('Informe o motivo da suspensão/bloqueio.');
      return;
    }
    setOcupado(true);
    try {
      await api.post(`/compras/fornecedores/${selecionado}/homologacao`, {
        status,
        motivo: motivo.trim() || undefined,
        categoria: categoria || undefined,
      });
      toast.success(`Homologação alterada para ${rotulo(status)}.`);
      setMotivo('');
      await abrir(selecionado);
      await carregar();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Não foi possível alterar a homologação.';
      toast.error(msg);
    } finally {
      setOcupado(false);
    }
  }

  const nomeSelecionado = useMemo(
    () => lista?.rows.find((f) => f.id === selecionado)?.nome ?? '',
    [lista, selecionado]
  );

  const vencendo = painel?.documentos_vencendo ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Homologação de fornecedores"
        description="Quem pode receber pedido de compra, por quê — e como cada fornecedor vem entregando, com números calculados das compras reais."
        actions={
          <button type="button" onClick={() => void carregar()} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <RefreshCw className="h-4 w-4" /> Atualizar
          </button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Pedidos em aberto" value={String(painel?.em_aberto ?? '—')} hint="Pendentes, aprovados e parciais." />
        <StatCard label="Fornecedores homologados" value={String(painel?.homologacao?.por_status?.homologado ?? '—')} hint="Aptos a receber pedido novo." />
        <StatCard label="Suspensos ou bloqueados" value={String((painel?.homologacao?.bloqueados ?? []).length)} hint="Não recebem pedido novo." />
        <StatCard label="Documentos vencendo (60 dias)" value={String(vencendo.length)} hint="Certidões a renovar antes do vencimento." />
      </div>

      {erro && <Alert tone="red">{erro}</Alert>}

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3">
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-600">Buscar</span>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Nome, documento ou e-mail"
            className="w-64 rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-600">Homologação</span>
          <select value={filtro} onChange={(e) => setFiltro(e.target.value as Status | '')} className="rounded-lg border border-slate-300 px-3 py-2">
            <option value="">Todos os estados</option>
            {STATUS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* ---------------- LISTA ---------------- */}
        <section className="rounded-xl border border-slate-200 bg-white">
          <header className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
            Fornecedores {lista ? `(${lista.total})` : ''}
          </header>
          {carregando ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : !lista || lista.rows.length === 0 ? (
            <EmptyState title="Nenhum fornecedor neste filtro" description="Cadastre fornecedores em Compras › Fornecedores para iniciar a homologação." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {lista.rows.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => void abrir(f.id)}
                    aria-current={selecionado === f.id ? 'true' : undefined}
                    className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 ${selecionado === f.id ? 'bg-slate-50' : ''}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-800">{f.nome}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <Badge tone={tom(f.homologacao_status)}>{rotulo(f.homologacao_status)}</Badge>
                        {f.homologacao_categoria && <span>{CATEGORIAS.find((c) => c.value === f.homologacao_categoria)?.label ?? f.homologacao_categoria}</span>}
                        {f.validade_documentos && <span>docs até {formatDate(f.validade_documentos)}</span>}
                      </span>
                    </span>
                    <span className="text-xs text-slate-400">{f.avaliacao_manual != null ? `nota ${f.avaliacao_manual}/5` : 'sem nota'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---------------- FICHA INLINE ---------------- */}
        <section className="rounded-xl border border-slate-200 bg-white">
          {!selecionado ? (
            <div className="px-4 py-10 text-center text-sm text-slate-500">
              Selecione um fornecedor na lista para ver a homologação, os documentos e o desempenho.
            </div>
          ) : carregandoFicha ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : !ficha ? (
            <div className="px-4 py-10 text-center text-sm text-slate-500">Não foi possível abrir a ficha deste fornecedor.</div>
          ) : (
            <div className="space-y-4 p-4">
              <header className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold text-slate-800">{nomeSelecionado}</h2>
                  <p className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                    <Badge tone={tom(ficha.status)}>{rotulo(ficha.status)}</Badge>
                    {ficha.categoria && <span>{CATEGORIAS.find((c) => c.value === ficha.categoria)?.label ?? ficha.categoria}</span>}
                    {ficha.homologado_em && <span>desde {formatDate(ficha.homologado_em)}</span>}
                  </p>
                </div>
                {desempenho && (
                  <div className="text-right">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                      <TrendingUp className="h-4 w-4 text-emerald-600" /> Score {desempenho.score}/100
                    </div>
                    <div className="text-xs text-slate-500">classificação: {desempenho.classificacao}</div>
                  </div>
                )}
              </header>

              {ficha.motivo && (
                <Alert tone="amber"><span className="font-semibold">Motivo do estado atual: </span>{String(ficha.motivo)}</Alert>
              )}

              {ficha.pendencias.length > 0 ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-amber-800">
                    <AlertTriangle className="h-4 w-4" /> Pendências para homologar
                  </div>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-800">
                    {ficha.pendencias.map((p) => <li key={p}>{p}</li>)}
                  </ul>
                </div>
              ) : ficha.status === 'homologado' ? (
                <p className="flex items-center gap-2 text-sm text-emerald-700">
                  <CheckCircle2 className="h-4 w-4" /> Documentação em ordem — nenhuma pendência aberta.
                </p>
              ) : null}

              {/* Documentos */}
              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700"><FileText className="h-4 w-4" /> Documentos</h3>
                {ficha.documentos.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    Nenhum documento cadastrado. Cadastre em Compras › Documentos do fornecedor (cada documento tem validade e situação próprias).
                  </p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
                      <tr><th className="py-1">Tipo</th><th className="py-1">Número</th><th className="py-1">Validade</th><th className="py-1">Situação</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {ficha.documentos.map((d) => (
                        <tr key={d.id}>
                          <td className="py-1.5 text-slate-700">{String(d.tipo).replace(/_/g, ' ')}</td>
                          <td className="py-1.5 text-slate-500">{d.numero ?? '—'}</td>
                          <td className={`py-1.5 ${d.vencido ? 'font-medium text-red-600' : 'text-slate-500'}`}>{d.validade ? formatDate(d.validade) : 'sem validade'}</td>
                          <td className="py-1.5">
                            <Badge tone={d.situacao === 'aprovado' ? (d.vencido ? 'red' : 'green') : d.situacao === 'reprovado' ? 'red' : 'amber'}>
                              {d.situacao === 'aprovado' && d.vencido ? 'aprovado (vencido)' : d.situacao}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Desempenho */}
              {desempenho && (
                <div>
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700"><TrendingUp className="h-4 w-4" /> Desempenho (calculado das compras)</h3>
                  <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    <div><span className="block text-xs text-slate-400">Pedidos</span>{desempenho.historico.pedidos}</div>
                    <div><span className="block text-xs text-slate-400">Recebidos</span>{desempenho.historico.recebidos}</div>
                    <div><span className="block text-xs text-slate-400">Total comprado</span>{brl(desempenho.historico.total_comprado)}</div>
                    <div><span className="block text-xs text-slate-400">Atraso médio</span>{desempenho.prazo.atraso_medio_dias != null ? `${desempenho.prazo.atraso_medio_dias} d` : '—'}</div>
                  </div>
                  <ul className="mt-2 space-y-1 text-sm">
                    {desempenho.fatores.map((f) => (
                      <li key={f.chave} className="flex items-start justify-between gap-3 rounded-lg bg-slate-50 px-3 py-1.5">
                        <span className="text-slate-600"><span className="font-medium text-slate-800">{f.label}</span> — {f.detalhe}</span>
                        <span className="whitespace-nowrap text-xs font-semibold text-slate-700">+{f.pontos}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Ações de estado (inline, sem sobreposição) */}
              {ficha.proximos.length > 0 && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700"><ShieldAlert className="h-4 w-4" /> Mudar homologação</h3>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="text-sm">
                      <span className="mb-1 block text-xs font-medium text-slate-600">Categoria de fornecimento</span>
                      <select value={categoria} onChange={(e) => setCategoria(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5">
                        <option value="">—</option>
                        {CATEGORIAS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                    </label>
                    <label className="min-w-[220px] flex-1 text-sm">
                      <span className="mb-1 block text-xs font-medium text-slate-600">Motivo (obrigatório para suspender/bloquear)</span>
                      <input value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={500} className="w-full rounded-lg border border-slate-300 px-2 py-1.5" placeholder="Ex.: atraso recorrente, certidão irregular" />
                    </label>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {ficha.proximos.map((st) => (
                      <button
                        key={st}
                        type="button"
                        disabled={ocupado}
                        onClick={() => void mudarPara(st)}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
                          st === 'homologado'
                            ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                            : st === 'suspenso' || st === 'bloqueado'
                              ? 'bg-red-600 text-white hover:bg-red-700'
                              : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        {ocupado && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {st === 'em_analise' ? 'Iniciar análise' : st === 'pendente' ? 'Voltar para pendente' : rotulo(st)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Trilha */}
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700">Trilha de homologação</h3>
                {ficha.eventos.length === 0 ? (
                  <p className="text-sm text-slate-500">Nenhuma transição registrada — o fornecedor está no estado inicial.</p>
                ) : (
                  <ol className="space-y-1 text-sm">
                    {ficha.eventos.map((e) => (
                      <li key={e.id} className="flex flex-wrap items-center gap-2 text-slate-600">
                        <span className="text-xs text-slate-400">{formatDate(e.criado_em)}</span>
                        <Badge tone={tom(e.status_anterior ?? 'pendente')}>{rotulo(e.status_anterior ?? 'pendente')}</Badge>
                        <span>→</span>
                        <Badge tone={tom(e.status_novo)}>{rotulo(e.status_novo)}</Badge>
                        {e.motivo && <span className="text-xs text-slate-500">“{e.motivo}”</span>}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      {vencendo.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">Documentos vencendo nos próximos 60 dias</h3>
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            {vencendo.map((d: any) => (
              <li key={d.documento_id} className="flex items-center justify-between gap-2">
                <span className="text-slate-600">{String(d.tipo).replace(/_/g, ' ')} · fornecedor #{d.fornecedor_id}</span>
                <Badge tone={d.vencido ? 'red' : 'amber'}>{formatDate(d.validade)}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
