import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ClipboardCheck, ClipboardList, Loader2, Lock, Plus, RefreshCw, Save, Search } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { Alert, Badge, ConfirmDialog, Modal, PageHeader, Spinner, useToast } from '../components/ui';
import { Thumb } from '../components/ImageField';
import { formatDateTime, formatNumber } from '../lib/format';

type Inv = Record<string, any> & { id: number };
type ItemCont = Record<string, any> & { id: number };

export default function InventarioModulePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const toast = useToast();
  const podeFechar = user?.perfil === 'admin' || user?.perfil === 'gerente';

  const [lista, setLista] = useState<Inv[] | null>(null);
  const [aberto, setAberto] = useState<Inv | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [novoOpen, setNovoOpen] = useState(false);
  const [locais, setLocais] = useState<{ value: number; label: string }[]>([]);
  const [novo, setNovo] = useState({ local_id: '', observacoes: '' });
  const [criando, setCriando] = useState(false);

  const carregarLista = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await api.get<{ rows: Inv[] }>('/inventarios?pageSize=100&sort=id&dir=desc');
      setLista(d.rows);
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar inventários.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregarLista();
    api
      .get<{ value: number; label: string }[]>('/locais/options')
      .then(setLocais)
      .catch(() => {});
  }, [carregarLista]);

  async function abrirNovo() {
    if (!novo.local_id) return toast.error('Selecione o local da contagem.');
    setCriando(true);
    try {
      const criado = await api.post<Inv>('/inventarios', { local_id: Number(novo.local_id), observacoes: novo.observacoes || null });
      toast.success(`Inventário #${criado.id} aberto em “${criado.local || novo.local_id}”. Registre as contagens.`);
      setNovoOpen(false);
      setNovo({ local_id: '', observacoes: '' });
      await carregarLista();
      await abrirDetalhe(criado.id);
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível abrir o inventário.');
    } finally {
      setCriando(false);
    }
  }

  const abrirDetalhe = useCallback(async (id: number) => {
    setLoading(true);
    setError('');
    try {
      const inv = await api.get<Inv>(`/inventarios/${id}`);
      setAberto(inv);
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar o inventário.');
    } finally {
      setLoading(false);
    }
  }, []);

  if (aberto) return <ContagemView inventario={aberto} onBack={() => { setAberto(null); carregarLista(); }} />;

  return (
    <div className="p-4 pb-24 sm:p-6 md:pb-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <ClipboardCheck className="h-5 w-5" />
            </span>
            Inventário
          </span>
        }
        description="Contagem física por local. Ao fechar, o sistema gera os ajustes de estoque automaticamente (uma única vez)."
        actions={
          <>
            <button className="btn-secondary" onClick={carregarLista} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
            </button>
            <button className="btn-accent" onClick={() => setNovoOpen(true)}>
              <Plus className="h-4 w-4" /> Abrir contagem
            </button>
          </>
        }
      />

      {error && <Alert tone="red">{error}</Alert>}
      {!lista && !error && <Spinner />}

      {lista && lista.length === 0 && !error && (
        <div className="card p-10 text-center text-sm text-slate-400">
          <ClipboardList className="mx-auto mb-3 h-8 w-8 text-slate-300" />
          Nenhuma contagem ainda. Clique em “Abrir contagem”, escolha o local e registre as quantidades contadas.
        </div>
      )}

      {lista && lista.length > 0 && (
        <div className="card overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Local</th>
                <th>Status</th>
                <th>Aberto</th>
                <th>Fechado</th>
                <th className="text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((inv) => (
                <tr key={inv.id}>
                  <td className="font-mono text-xs text-slate-400">#{inv.id}</td>
                  <td className="font-medium text-slate-800">{inv.local_id__label || inv.local}</td>
                  <td>
                    {inv.status === 'aberto' ? <Badge tone="amber">Em contagem</Badge> : <Badge tone="green">Fechado</Badge>}
                  </td>
                  <td className="text-slate-500">{formatDateTime(inv.aberto_em)}</td>
                  <td className="text-slate-500">{inv.fechado_em ? formatDateTime(inv.fechado_em) : '—'}</td>
                  <td className="text-right">
                    <button className="btn-secondary !py-1.5 text-xs" onClick={() => abrirDetalhe(inv.id)}>
                      {inv.status === 'aberto' ? 'Continuar contagem' : 'Ver resultado'} <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={novoOpen} onClose={() => setNovoOpen(false)} title="Abrir contagem" subtitle="O saldo do sistema é congelado neste momento (foto instantânea)." size="sm">
        <div className="space-y-4">
          <label className="block">
            <span className="label">Local</span>
            <select className="input" value={novo.local_id} onChange={(e) => setNovo((n) => ({ ...n, local_id: e.target.value }))}>
              <option value="">Selecione o local...</option>
              {locais.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Observações (opcional)</span>
            <textarea className="input" rows={2} value={novo.observacoes} onChange={(e) => setNovo((n) => ({ ...n, observacoes: e.target.value }))} />
          </label>
          <Alert tone="blue">Somente gerentes e administradores podem fechar a contagem e gerar os ajustes.</Alert>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setNovoOpen(false)}>Cancelar</button>
            <button className="btn-primary" onClick={abrirNovo} disabled={criando}>
              {criando && <Loader2 className="h-4 w-4 animate-spin" />} Abrir e congelar saldos
            </button>
          </div>
        </div>
      </Modal>

      {!aberto && (
        <button className="btn-accent fixed bottom-5 right-5 z-40 rounded-full px-4 py-3.5 shadow-modal md:hidden" onClick={() => setNovoOpen(true)} aria-label="Abrir contagem">
          <Plus className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contagem de um inventário aberto
// ---------------------------------------------------------------------------
function ContagemView({ inventario, onBack }: { inventario: Inv; onBack: () => void }) {
  const toast = useToast();
  const { user } = useAuth();
  const podeFechar = user?.perfil === 'admin' || user?.perfil === 'gerente';
  const id = inventario.id;
  const aberto = inventario.status === 'aberto';

  const [itens, setItens] = useState<ItemCont[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [editado, setEditado] = useState<Map<number, string>>(new Map());
  const [salvando, setSalvando] = useState(false);
  const [fecharOpen, setFecharOpen] = useState(false);
  const [fechando, setFechando] = useState(false);
  const [achadoOpen, setAchadoOpen] = useState(false);
  const [achado, setAchado] = useState<{ produto_id: string; tamanho_id: string; contado: string }>({ produto_id: '', tamanho_id: '', contado: '1' });
  const [produtos, setProdutos] = useState<{ value: number; label: string }[]>([]);
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
      const [, rows] = await Promise.all([api.get<Inv>(`/inventarios/${id}`), api.get<ItemCont[]>(`/inventarios/${id}/itens`)]);
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
    api.get<{ value: number; label: string }[]>('/produtos/options').then(setProdutos).catch(() => {});
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
        <td className="text-center">{it.tamanho_id__label || `#${it.tamanho_id}`}</td>
        <td className="text-right tabular-nums text-slate-600">{formatNumber(saldo)}</td>
        <td className="text-right">
          {aberto ? (
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
    if (!achado.produto_id || !achado.tamanho_id) return toast.error('Selecione o produto e o tamanho.');
    if (!(Number(achado.contado) >= 0)) return toast.error('Informe a quantidade contada.');
    try {
      await api.put(`/inventarios/${id}/itens`, { itens: [{ produto_id: Number(achado.produto_id), tamanho_id: Number(achado.tamanho_id), contado: Number(achado.contado) }] });
      toast.success('Produto adicionado à contagem.');
      setAchadoOpen(false);
      setAchado({ produto_id: '', tamanho_id: '', contado: '1' });
      await carregar();
    } catch (e: any) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível adicionar.');
    }
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

  const idEsc = String(inventario.id);
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
            {inventario.status === 'aberto' ? <Badge tone="amber">Em contagem</Badge> : <Badge tone="green">Fechado</Badge>}
          </span>
        }
        description={`Local: ${inventario.local_id__label || inventario.local} · aberto ${formatDateTime(inventario.aberto_em)}${inventario.aberto_por ? ` por ${inventario.aberto_por}` : ''}`}
        actions={
          <>
            {aberto && (
              <button className="btn-secondary" onClick={() => setAchadoOpen(true)}>
                <Plus className="h-4 w-4" /> Produto sem saldo
              </button>
            )}
            {aberto && (
              <button className="btn-primary" onClick={salvarContagem} disabled={salvando || !editado.size}>
                {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salvar contagem ({editado.size})
              </button>
            )}
            {aberto && podeFechar && (
              <button className="btn-accent" onClick={() => setFecharOpen(true)}>
                <Lock className="h-4 w-4" /> Fechar e gerar ajustes
              </button>
            )}
          </>
        }
      />

      {!aberto && inventario.fechado_em && (
        <div className="mb-4">
          <Alert tone="green">Fechado em {formatDateTime(inventario.fechado_em)} por {inventario.fechado_por || '—'}. Os ajustes já foram aplicados e a contagem não pode mais mudar.</Alert>
        </div>
      )}

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

      {aberto && (
        <button className="btn-primary fixed bottom-5 right-5 z-40 rounded-full px-4 py-3.5 shadow-modal md:hidden" onClick={salvarContagem} disabled={salvando || !editado.size}>
          {salvando ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
        </button>
      )}

      <Modal open={achadoOpen} onClose={() => setAchadoOpen(false)} title="Produto sem saldo no sistema" subtitle="Adiciona uma linha de contagem mesmo sem estoque registrado." size="sm">
        <div className="space-y-4">
          <label className="block">
            <span className="label">Produto</span>
            <select className="input" value={achado.produto_id} onChange={(e) => setAchado((a) => ({ ...a, produto_id: e.target.value }))}>
              <option value="">Selecione...</option>
              {produtos.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
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
      </Modal>

      <ConfirmDialog
        open={fecharOpen}
        title="Fechar inventário e gerar ajustes?"
        danger
        confirmLabel="Fechar e ajustar"
        busy={fechando}
        onCancel={() => setFecharOpen(false)}
        onConfirm={fechar}
        message={
          <p>
            As <strong>{resumo?.divergencias ?? 0} divergência(s)</strong> serão aplicadas ao estoque como movimentações de ajuste com motivo “Inventário #{idEsc}”. Esta ação só pode ser feita uma vez.
          </p>
        }
      />
    </div>
  );
}

function CardResumo({ label, valor, tone }: { label: string; valor: string; tone?: 'amber' | 'green' }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 truncate text-lg font-bold tabular-nums ${tone === 'amber' ? 'text-amber-600' : tone === 'green' ? 'text-emerald-600' : 'text-navy-900'}`}>{valor}</div>
    </div>
  );
}
