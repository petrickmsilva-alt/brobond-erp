// ============================================================================
// CONTAGEM CÍCLICA ABC — SUPERFÍCIE SHARADA
// ----------------------------------------------------------------------------
// A lógica visual da Contagem Cíclica ABC (PLANEJADA → EM_CONTAGEM →
// CONFERIDA → APROVADA → cancelada/fechada) vive AQUI, em um único lugar, para
// ser usada por duas superfícies sem duplicar regra de negócio:
//
//   • `pages/InventarioModulePage.tsx` — Inventário (contagem física)
//   • `pages/ContagemCiclicaPage.tsx`    — Contagem Cíclica ABC (capacidade
//     própria da árvore Master, sob Estoque & Suprimentos → Estoque)
//
// Nenhuma regra de negócio foi reimplementada: as chamadas são as mesmas do
// servidor (`/inventarios/ciclicas`, `/inventarios/:id`, `/inventarios/:id/itens`,
// `/inventarios/:id/ciclica/*`, `/inventarios/:id/fechar`) e o saldo continua
// sendo o snapshot imutável de `estoques`, fechado pelo motor canônico.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ClipboardCheck, ClipboardList, Loader2, Lock, Plus, Save, Search } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { Alert, Badge, PageHeader, Spinner, useToast } from './ui';
import { Thumb } from './ImageField';
import { ProductSelector } from './ProductSelector';
import { formatDateTime, formatNumber } from '../lib/format';

export type Inv = Record<string, any> & { id: number };
export type ItemCont = Record<string, any> & { id: number };

/** Somente gerente/admin pode planejar, conferir, aprovar e fechar. */
export function podePlanejar(perfil?: string): boolean {
  return perfil === 'admin' || perfil === 'gerente';
}

export function CardResumo({ label, valor, tone }: { label: string; valor: string; tone?: 'amber' | 'green' }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 truncate text-lg font-bold tabular-nums ${tone === 'amber' ? 'text-amber-600' : tone === 'green' ? 'text-emerald-600' : 'text-navy-900'}`}>{valor}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Painel inline de planejamento de um novo plano cíclico (nunca modal)
// ---------------------------------------------------------------------------
export function PlanejarCiclicoPanel({
  open,
  onClose,
  locais,
  onCriado,
}: {
  open: boolean;
  onClose: () => void;
  locais: { value: number; label: string }[];
  onCriado: (inv: Inv) => void;
}) {
  const toast = useToast();
  const [plano, setPlano] = useState({ local_id: '', periodo_inicio: '', periodo_fim: '', data_planejada: '', responsavel_id: '', faixa_a: '80', faixa_b: '95' });
  const [criando, setCriando] = useState(false);

  useEffect(() => {
    if (open) setPlano({ local_id: '', periodo_inicio: '', periodo_fim: '', data_planejada: '', responsavel_id: '', faixa_a: '80', faixa_b: '95' });
  }, [open]);

  async function criar() {
    if (!plano.local_id || !plano.periodo_inicio || !plano.periodo_fim || !plano.data_planejada) return toast.error('Informe local, período ABC e data planejada.');
    setCriando(true);
    try {
      const inv = await api.post<Inv>('/inventarios/ciclicas', {
        ...plano,
        local_id: Number(plano.local_id),
        responsavel_id: plano.responsavel_id ? Number(plano.responsavel_id) : null,
        faixa_a: Number(plano.faixa_a),
        faixa_b: Number(plano.faixa_b),
        idempotency_key: crypto.randomUUID(),
      });
      toast.success(`Plano ABC #${inv.id} criado com snapshot do saldo de sistema.`);
      setPlano({ local_id: '', periodo_inicio: '', periodo_fim: '', data_planejada: '', responsavel_id: '', faixa_a: '80', faixa_b: '95' });
      onClose();
      onCriado(inv);
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível criar o plano cíclico.');
    } finally {
      setCriando(false);
    }
  }

  if (!open) return null;
  return (
    <section className="card mb-4 p-5">
      <h2 className="text-base font-semibold text-navy-900">Plano de contagem cíclica ABC</h2>
      <p className="mb-4 mt-1 text-sm text-slate-500">A classe é calculada pelas saídas registradas no local durante o período informado; faixas cumulativas configuráveis: A até o percentual informado, B até o segundo percentual, C restante; os valores usados ficam registrados no plano.</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block"><span className="label">Local</span><select className="input" value={plano.local_id} onChange={(e) => setPlano((v) => ({ ...v, local_id: e.target.value }))}><option value="">Selecione...</option>{locais.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
        <label className="block"><span className="label">Início do período ABC</span><input type="date" className="input" value={plano.periodo_inicio} onChange={(e) => setPlano((v) => ({ ...v, periodo_inicio: e.target.value }))} /></label>
        <label className="block"><span className="label">Fim do período ABC</span><input type="date" className="input" value={plano.periodo_fim} onChange={(e) => setPlano((v) => ({ ...v, periodo_fim: e.target.value }))} /></label>
        <label className="block"><span className="label">Data planejada</span><input type="date" className="input" value={plano.data_planejada} onChange={(e) => setPlano((v) => ({ ...v, data_planejada: e.target.value }))} /></label>
        <label className="block"><span className="label">Responsável (opcional; ID do usuário)</span><input type="number" min="1" className="input" value={plano.responsavel_id} onChange={(e) => setPlano((v) => ({ ...v, responsavel_id: e.target.value }))} /></label>
        <label className="block"><span className="label">Faixa acumulada A (%)</span><input type="number" min="0.01" max="99.98" step="0.01" className="input" value={plano.faixa_a} onChange={(e) => setPlano((v) => ({ ...v, faixa_a: e.target.value }))} /></label>
        <label className="block"><span className="label">Faixa acumulada B (%)</span><input type="number" min="0.02" max="99.99" step="0.01" className="input" value={plano.faixa_b} onChange={(e) => setPlano((v) => ({ ...v, faixa_b: e.target.value }))} /></label>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn-primary" onClick={criar} disabled={criando}>{criando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Criar plano e congelar saldos</button>
        <button className="btn-secondary" onClick={onClose}>Cancelar</button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Contagem de um inventário aberto (ciclica ou simples)
// ---------------------------------------------------------------------------
export function ContagemCiclicaView({ inventario, onBack }: { inventario: Inv; onBack: () => void }) {
  const toast = useToast();
  const { user } = useAuth();
  const podeFechar = podePlanejar(user?.perfil);
  const [registro, setRegistro] = useState(inventario);
  const id = registro.id;
  const aberto = registro.status === 'aberto';
  const ciclica = registro.modalidade === 'ciclica_abc';
  const contagemEditavel = aberto && !(ciclica && registro.contagem_status === 'APROVADA');

  const [itens, setItens] = useState<ItemCont[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [editado, setEditado] = useState<Map<number, string>>(new Map());
  const [salvando, setSalvando] = useState(false);
  const [fecharOpen, setFecharOpen] = useState(false);
  const [cancelarOpen, setCancelarOpen] = useState(false);
  const [fechando, setFechando] = useState(false);
  const [achadoOpen, setAchadoOpen] = useState(false);
  const [achado, setAchado] = useState<{ produto_id: string; tamanho_id: string; contado: string }>({ produto_id: '', tamanho_id: '', contado: '1' });
  const [tamanhos, setTamanhos] = useState<{ value: number; label: string }[]>([]);
  // No "achado", o tamanho precisa ser da grade do produto escolhido.
  const [tamanhosAchado, setTamanhosAchado] = useState<{ value: number; label: string }[] | null>(null);
  const [gradeAchado, setGradeAchado] = useState('');

  useEffect(() => {
    if (!achado.produto_id) {
      setTamanhosAchado(null);
      setGradeAchado('');
      return;
    }
    let alive = true;
    api
      .get<{ grade: { id: number; nome: string } | null; tamanhos: { id: number; codigo: string }[] }>(`/produtos/${achado.produto_id}/tamanhos`)
      .then((d) => {
        if (!alive) return;
        const lista = (d.tamanhos ?? []).map((t) => ({ value: t.id, label: t.codigo }));
        setTamanhosAchado(lista);
        setGradeAchado(d.grade?.nome ?? '');
        if (!lista.length) return;
        const validos = new Set(lista.map((t) => String(t.value)));
        setAchado((a) => (!a.tamanho_id || validos.has(String(a.tamanho_id)) ? a : { ...a, tamanho_id: '' }));
      })
      .catch(() => {
        if (!alive) return;
        setTamanhosAchado(null);
        setGradeAchado('');
      });
    return () => {
      alive = false;
    };
  }, [achado.produto_id]);

  const carregar = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [detail, rows] = await Promise.all([api.get<Inv>(`/inventarios/${id}`), api.get<ItemCont[]>(`/inventarios/${id}/itens`)]);
      setRegistro(detail);
      setItens(rows);
      setEditado(new Map());
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar a contagem.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    carregar();
    api.get<{ value: number; label: string }[]>('/tamanhos/options').then(setTamanhos).catch(() => {});
  }, [carregar]);

  const visiveis = useMemo(() => {
    if (!itens) return [];
    const term = q.trim().toLowerCase();
    return term ? itens.filter((i) => `${i.produto_id__label || ''} ${i.tamanho_id__label || ''}`.toLowerCase().includes(term)) : itens;
  }, [itens, q]);

  // Contagem agrupada por grade — mesma organização do Estoque Físico, para o
  // time conferir camiseta com camiseta e calça com calça.
  const grupos = useMemo(() => {
    const buckets = new Map<number, ItemCont[]>();
    for (const it of visiveis) {
      const gid = Number(it.produto_id__grade_id) || 0;
      const arr = buckets.get(gid);
      if (arr) arr.push(it);
      else buckets.set(gid, [it]);
    }
    const out = Array.from(buckets.entries()).map(([gradeId, doGrupo]) => ({
      gradeId,
      nome: gradeId === 0 ? 'Sem grade definida' : String(doGrupo[0].produto_id__grade_nome ?? `Grade #${gradeId}`),
      itens: doGrupo,
    }));
    return out.sort((a, b) => (a.gradeId === 0 ? 1 : b.gradeId === 0 ? -1 : a.nome.localeCompare(b.nome, 'pt-BR')));
  }, [visiveis]);

  function linhaContagem(it: ItemCont) {
    const saldo = Number(it.saldo_sistema || 0);
    const editVal = editado.get(it.id);
    const contado = editVal !== undefined ? (editVal === '' ? null : Number(editVal)) : it.contado === null || it.contado === undefined ? saldo : Number(it.contado);
    const dif = (contado ?? saldo) - saldo;
    return (
      <tr key={it.id} className={dif !== 0 ? 'bg-amber-50/60' : ''}>
        <td>
          <Thumb src={it.produto_id__foto} alt={it.produto_id__label || ''} size={32} />
        </td>
        <td className="font-medium text-slate-800">{it.produto_id__label || `#${it.produto_id}`}</td>
        <td className="text-center">{it.tamanho_id__label || (it.tamanho_id ? `#${it.tamanho_id}` : '—')}</td>
        {ciclica && <td className="text-center"><span className="font-semibold">{it.classificacao_abc || '—'}</span>{it.prioridade ? <span className="ml-1 text-xs text-slate-400">#{it.prioridade}</span> : null}</td>}
        <td className="text-right tabular-nums text-slate-600">{formatNumber(saldo)}</td>
        <td className="text-right">
          {contagemEditavel ? (
            <input
              type="number"
              min={0}
              className="input w-24 text-right"
              value={editVal !== undefined ? editVal : it.contado === null || it.contado === undefined ? '' : String(it.contado)}
              placeholder="—"
              onChange={(e) => {
                setEditado((m) => {
                  const n = new Map(m);
                  n.set(it.id, e.target.value);
                  return n;
                });
              }}
            />
          ) : (
            <span className="tabular-nums">{it.contado === null || it.contado === undefined ? saldo : formatNumber(it.contado)}</span>
          )}
        </td>
        <td className="text-right font-semibold tabular-nums">
          {dif === 0 ? <span className="text-slate-300">0</span> : dif > 0 ? <span className="text-emerald-600">+{dif}</span> : <span className="text-red-600">{dif}</span>}
        </td>
      </tr>
    );
  }

  const resumo = useMemo(() => {
    if (!itens) return null;
    let contados = 0;
    let divergencias = 0;
    let totalSistema = 0;
    let totalContado = 0;
    for (const it of itens) {
      const saldo = Number(it.saldo_sistema || 0);
      const cont = editado.has(it.id) ? Number(editado.get(it.id)) : it.contado === null || it.contado === undefined ? saldo : Number(it.contado);
      totalSistema += saldo;
      totalContado += cont;
      if (it.contado !== null && it.contado !== undefined) contados++;
      if (cont !== saldo) divergencias++;
    }
    return { itens: itens.length, contados, divergencias, totalSistema, totalContado };
  }, [itens, editado]);

  async function salvarContagem() {
    if (!editado.size) return;
    setSalvando(true);
    try {
      const mudancas = [...editado.entries()].map(([itemId, valor]) => ({ id: itemId, contado: valor === '' ? null : Number(valor) }));
      await api.put(`/inventarios/${id}/itens`, { itens: mudancas });
      toast.success(`${mudancas.length} linha(s) de contagem salva(s).`);
      setEditado(new Map());
      await carregar();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível salvar.');
    } finally {
      setSalvando(false);
    }
  }

  async function adicionarAchado() {
    if (!achado.produto_id) return toast.error('Selecione o produto.');
    if (!(Number(achado.contado) >= 0)) return toast.error('Informe a quantidade contada.');
    try {
      await api.put(`/inventarios/${id}/itens`, { itens: [{ produto_id: Number(achado.produto_id), tamanho_id: achado.tamanho_id ? Number(achado.tamanho_id) : null, contado: Number(achado.contado) }] });
      toast.success('Produto adicionado à contagem.');
      setAchadoOpen(false);
      setAchado({ produto_id: '', tamanho_id: '', contado: '1' });
      await carregar();
    } catch (e: any) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível adicionar.');
    }
  }

  async function conferir() {
    try { await api.post(`/inventarios/${id}/ciclica/conferir`, {}); toast.success('Contagem conferida.'); await carregar(); }
    catch (e: any) { toast.error(e.message || 'Não foi possível conferir a contagem.'); }
  }

  async function aprovar() {
    try { await api.post(`/inventarios/${id}/ciclica/aprovar`, {}); toast.success('Contagem aprovada. Agora os ajustes podem ser aplicados.'); await carregar(); }
    catch (e: any) { toast.error(e.message || 'Não foi possível aprovar a contagem.'); }
  }

  async function cancelar() {
    try { await api.post(`/inventarios/${id}/ciclica/cancelar`, {}); toast.success('Plano cancelado; nenhum ajuste foi aplicado.'); setCancelarOpen(false); await carregar(); }
    catch (e: any) { toast.error(e.message || 'Não foi possível cancelar o plano.'); }
  }

  async function fechar() {
    setFechando(true);
    try {
      const r = await api.post<{ ajustes: number }>(`/inventarios/${id}/fechar`, {});
      toast.success(`Inventário fechado: ${r.ajustes} ajuste(s) de estoque gerado(s).`);
      setFecharOpen(false);
      onBack();
    } catch (e: any) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível fechar.');
    } finally {
      setFechando(false);
    }
  }

  const idEsc = String(registro.id);
  if (loading && !itens) return <Spinner />;
  if (error && !itens)
    return (
      <div className="p-4 sm:p-6">
        <Alert tone="red">{error}</Alert>
        <button className="btn-secondary mt-4" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Voltar
        </button>
      </div>
    );

  return (
    <div className="p-4 pb-24 sm:p-6 md:pb-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <button className="btn-icon" onClick={onBack} aria-label="Voltar">
              <ArrowLeft className="h-4 w-4" />
            </button>
            <ClipboardList className="h-5 w-5 text-navy-600" />
            Contagem #{idEsc}
            {registro.contagem_status === 'CANCELADA' ? <Badge tone="red">Cancelada</Badge> : registro.status === 'aberto' ? <Badge tone="amber">{ciclica ? registro.contagem_status : 'Em contagem'}</Badge> : <Badge tone="green">Fechado</Badge>}
          </span>
        }
        description={`Local: ${registro.local_id__label || registro.local} · aberto ${formatDateTime(registro.aberto_em)}${registro.aberto_por ? ` por ${registro.aberto_por}` : ''}${ciclica ? ` · ABC ${registro.abc_periodo_inicio} a ${registro.abc_periodo_fim}` : ''}`}
        actions={
          <>
            {contagemEditavel && (
              <button className="btn-secondary" onClick={() => setAchadoOpen(true)}>
                <Plus className="h-4 w-4" /> Produto sem saldo
              </button>
            )}
            {contagemEditavel && (
              <button className="btn-primary" onClick={salvarContagem} disabled={salvando || !editado.size}>
                {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salvar contagem ({editado.size})
              </button>
            )}
            {aberto && ciclica && podeFechar && ['PLANEJADA', 'EM_CONTAGEM'].includes(String(registro.contagem_status)) && !editado.size && resumo && resumo.contados === resumo.itens && (
              <button className="btn-secondary" onClick={conferir}><ClipboardCheck className="h-4 w-4" /> Conferir</button>
            )}
            {aberto && ciclica && podeFechar && registro.contagem_status === 'CONFERIDA' && <button className="btn-secondary" onClick={aprovar}><Lock className="h-4 w-4" /> Aprovar ajustes</button>}
            {aberto && ciclica && podeFechar && registro.contagem_status !== 'APROVADA' && <button className="btn-secondary" onClick={() => setCancelarOpen(true)}>Cancelar plano</button>}
            {aberto && podeFechar && (!ciclica || registro.contagem_status === 'APROVADA') && (
              <button className="btn-accent" onClick={() => setFecharOpen(true)}><Lock className="h-4 w-4" /> Fechar e gerar ajustes</button>
            )}
          </>
        }
      />

      {!aberto && registro.fechado_em && (
        <div className="mb-4">
          <Alert tone="green">Fechado em {formatDateTime(registro.fechado_em)} por {registro.fechado_por || '—'}. Os ajustes já foram aplicados e a contagem não pode mais mudar.</Alert>
        </div>
      )}

      {ciclica && <div className="mb-4"><Alert tone="blue">Classe ABC baseada em quantidade de saídas registradas no período. Saldo de sistema é snapshot imutável; diferença exibida = contado − sistema. Ajustes só ocorrem após conferência e aprovação explícitas.</Alert></div>}
      {resumo && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <CardResumo label="Linhas" valor={formatNumber(resumo.itens)} />
          <CardResumo label="Contadas" valor={formatNumber(resumo.contados)} />
          <CardResumo label="Divergências" valor={formatNumber(resumo.divergencias)} tone={resumo.divergencias > 0 ? 'amber' : 'green'} />
          <CardResumo label="Sistema → Contado" valor={`${formatNumber(resumo.totalSistema)} → ${formatNumber(resumo.totalContado)}`} />
        </div>
      )}

      <div className="mb-3 flex items-center gap-3">
        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="input pl-9" placeholder="Buscar produto..." value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span className="ml-auto text-xs text-slate-500">
          {visiveis.length} de {itens?.length ?? 0} linha(s)
        </span>
      </div>

      {itens === null ? null : grupos.length === 0 ? (
        <div className="card p-10 text-center text-sm text-slate-400">Nenhuma linha de contagem neste filtro.</div>
      ) : (
        <div className="space-y-4">
          {grupos.map((g) => (
            <section key={g.gradeId} className="card overflow-hidden">
              <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 bg-slate-50/70 px-4 py-2.5">
                <ClipboardCheck className="h-4 w-4 shrink-0 text-navy-600" />
                <h2 className="text-sm font-semibold text-navy-900">{g.nome}</h2>
                <span className="text-xs text-slate-500">{g.itens.length} linha(s) de contagem</span>
                {g.gradeId === 0 && <span className="ml-auto text-xs text-amber-700">defina a grade dos produtos para agrupar a conferência</span>}
              </header>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="w-14">Foto</th>
                      <th>Produto</th>
                      <th className="text-center">Tam.</th>
                      {ciclica && <th className="text-center">ABC</th>}
                      <th className="text-right">Saldo no sistema</th>
                      <th className="text-right">Contado</th>
                      <th className="text-right">Diferença</th>
                    </tr>
                  </thead>
                  <tbody>{g.itens.map((it) => linhaContagem(it))}</tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}

      {contagemEditavel && (
        <button className="btn-primary fixed bottom-5 right-5 z-40 rounded-full px-4 py-3.5 shadow-modal md:hidden" onClick={salvarContagem} disabled={salvando || !editado.size}>
          {salvando ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
        </button>
      )}

      {achadoOpen && <section className="card mt-5 p-5"><h2 className="text-base font-semibold text-navy-900">Produto sem saldo no sistema</h2><p className="mb-4 mt-1 text-sm text-slate-500">Adiciona uma linha à contagem, com saldo de sistema zero.</p>
        <div className="space-y-4">
          <label className="block">
            <span className="label">Produto</span>
            <ProductSelector
              value={achado.produto_id}
              aria-label="Buscar produto para contagem"
              onChange={(_id, product) => setAchado((a) => ({
                ...a,
                produto_id: product ? String(product.produto_pai_id ?? product.id) : '',
                tamanho_id: product?.variacao_tamanho_id ? String(product.variacao_tamanho_id) : '',
              }))}
            />
          </label>
          <label className="block">
            <span className="label">Tamanho</span>
            {gradeAchado && (
              <span className="mb-1 block text-xs text-slate-500">
                Grade <strong className="font-semibold text-navy-700">{gradeAchado}</strong> — só os tamanhos dela.
              </span>
            )}
            <select className="input" value={achado.tamanho_id} onChange={(e) => setAchado((a) => ({ ...a, tamanho_id: e.target.value }))}>
              <option value="">Selecione...</option>
              {(tamanhosAchado ?? tamanhos).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Quantidade contada</span>
            <input type="number" min={0} className="input" value={achado.contado} onChange={(e) => setAchado((a) => ({ ...a, contado: e.target.value }))} />
          </label>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setAchadoOpen(false)}>Cancelar</button>
            <button className="btn-primary" onClick={adicionarAchado}>Adicionar</button>
          </div>
        </div>
      </section>}

      {cancelarOpen && <section className="card mt-5 border-red-200 bg-red-50/40 p-5"><h2 className="text-base font-semibold text-red-900">Cancelar plano cíclico?</h2><p className="mt-2 text-sm text-slate-700">O inventário será encerrado sem movimentações de ajuste. A trilha e o snapshot serão preservados.</p><div className="mt-4 flex gap-2"><button className="btn-secondary" onClick={() => setCancelarOpen(false)}>Voltar</button><button className="btn-danger" onClick={cancelar}>Confirmar cancelamento</button></div></section>}

      {fecharOpen && <section className="card mt-5 border-amber-200 bg-amber-50/40 p-5"><h2 className="text-base font-semibold text-navy-900">Confirmar fechamento</h2><p className="mt-2 text-sm text-slate-700">{resumo?.divergencias ?? 0} divergência(s) serão aplicadas ao estoque pelo motor de movimentação como ajustes do inventário. A ação é única e não pode ser desfeita.</p><div className="mt-4 flex gap-2"><button className="btn-secondary" onClick={() => setFecharOpen(false)}>Voltar</button><button className="btn-accent" onClick={fechar} disabled={fechando}>{fechando ? 'Fechando…' : 'Fechar e gerar ajustes'}</button></div></section>}
    </div>
  );
}
