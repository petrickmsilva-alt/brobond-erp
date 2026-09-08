import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ArrowLeftRight, Barcode, Boxes, ClipboardList, Cog, Pencil, Printer, Shirt, Tag, Wallet } from 'lucide-react';
import { api } from '../lib/api';
import { useMeta, type PublicFile } from '../lib/meta';
import { useAuth } from '../auth/AuthContext';
import { formatDate, formatDateTime, formatMoney, formatNumber } from '../lib/format';
import { Alert, Badge, Modal, PageHeader, Spinner, useToast } from '../components/ui';
import { ColorDot, ImageField, Lightbox } from '../components/ImageField';
import { fieldErrors, initialValues, RecordForm, toPayload, useRefOptions, type FormValues } from '../components/RecordForm';
import { ApiError } from '../lib/api';
import { LabelSheet } from '../components/LabelSheet';

type Detail = {
  produto: Record<string, any> & { fotos: PublicFile[] };
  estoque: {
    totalPecas: number;
    abaixoMinimo: number;
    valor: number;
    colunas: { id: number; codigo: string }[];
    grade: { local: string; total: number; celulas: { tamanho_id: number; quantidade: number; estoque_min: number; estoque_id: number | null }[] }[];
  };
  grade: { id: number; nome: string } | null;
  movimentacoes: Record<string, any>[];
  ordens: { abertas: Record<string, any>[]; recentes: Record<string, any>[] };
  custo: { ficha: Record<string, any> | null; custoBase: number; custoFicha: number; custoTotal: number; margem: number; precoSugerido: number | null; precoVenda: number; margemReal: number | null };
};

const MOV_TONE: Record<string, 'green' | 'red' | 'amber'> = { entrada: 'green', saida: 'red', ajuste: 'amber' };
const MOV_LABEL: Record<string, string> = { entrada: 'Entrada', saida: 'Saída', ajuste: 'Ajuste' };
const OP_TONE: Record<string, 'slate' | 'blue' | 'green' | 'red'> = { planejada: 'slate', em_producao: 'blue', concluida: 'green', cancelada: 'red' };
const OP_LABEL: Record<string, string> = { planejada: 'Planejada', em_producao: 'Em produção', concluida: 'Concluída', cancelada: 'Cancelada' };

export default function ProductDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const meta = useMeta();
  const { user } = useAuth();
  const toast = useToast();
  const resource = meta.resources.produtos;
  const canEdit = resource.ops.update;

  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState<PublicFile | null>(null);
  const [labels, setLabels] = useState(false);

  // edição inline (modal)
  const [formOpen, setFormOpen] = useState(false);
  const [values, setValues] = useState<FormValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const refOptions = useRefOptions(resource, formOpen ? 1 : 0);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Detail>(`/produtos/${id}/detalhe`));
      setError('');
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar');
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  function openEdit() {
    if (!data) return;
    setValues(initialValues(resource, data.produto));
    setErrors({});
    setFormError('');
    setFormOpen(true);
  }

  async function save() {
    if (!data) return;
    setSaving(true);
    setFormError('');
    try {
      await api.put(`/produtos/${data.produto.id}`, toPayload(resource, values, true));
      toast.success('Produto salvo.');
      setFormOpen(false);
      await load();
    } catch (e: any) {
      setErrors(fieldErrors(e));
      setFormError(e instanceof ApiError ? e.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }

  if (error)
    return (
      <div className="p-4 sm:p-6">
        <Alert tone="red">{error}</Alert>
        <Link to="/produtos" className="btn-secondary mt-4">
          <ArrowLeft className="h-4 w-4" /> Voltar para Produtos
        </Link>
      </div>
    );
  if (!data) return <Spinner />;

  const p = data.produto;
  const fotos = p.fotos || [];
  const principal = fotos[0];
  const corLabel = p.cor_id__label || p.cor || null;
  const corHex = p.cor_id__color || null;

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <Shirt className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block truncate">{p.nome}</span>
              <span className="block font-mono text-xs font-normal text-slate-500">
                {p.sku}
                {p.codigo_barras ? ` · EAN ${p.codigo_barras}` : ''}
              </span>
            </span>
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            {p.categoria_id__label && <Badge tone="blue">{p.categoria_id__label}</Badge>}
            {p.colecao_id__label && <Badge tone="slate">{p.colecao_id__label}</Badge>}
            {corLabel && (
              <span className="text-sm text-slate-600">
                <ColorDot hex={corHex} label={corLabel} />
              </span>
            )}
            {p.ativo === false && <Badge tone="red">Inativo</Badge>}
          </span>
        }
        actions={
          <>
            <button className="btn-secondary" onClick={() => navigate('/produtos')}>
              <ArrowLeft className="h-4 w-4" /> <span className="hidden sm:inline">Produtos</span>
            </button>
            <button className="btn-secondary" onClick={() => setLabels(true)} title="Imprimir etiquetas com código de barras">
              <Printer className="h-4 w-4" /> Etiquetas
            </button>
            {canEdit && (
              <button className="btn-primary" onClick={openEdit}>
                <Pencil className="h-4 w-4" /> Editar
              </button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Coluna esquerda: fotos + dados */}
        <div className="space-y-4">
          <section className="card overflow-hidden">
            <div className="aspect-square w-full bg-slate-100">
              {principal ? (
                <img src={principal.url} alt={p.nome} className="h-full w-full cursor-zoom-in object-cover" onClick={() => setZoom(principal)} />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-300">
                  <Shirt className="h-12 w-12" />
                  <span className="text-sm">Sem foto</span>
                </div>
              )}
            </div>
            <div className="p-3">
              <ImageField resource={resource} recordId={p.id} initial={fotos} canEdit={canEdit} onChange={() => load()} compact />
            </div>
          </section>

          <section className="card p-4">
            <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
              <Tag className="h-4 w-4 text-navy-400" /> Dados do produto
            </h2>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Item label="Custo unitário" value={formatMoney(p.custo)} />
              <Item label="Preço de venda" value={formatMoney(p.preco_venda)} strong />
              <Item label="Composição" value={p.composicao} />
              <Item label="Peso" value={p.peso_g ? `${formatNumber(p.peso_g)} g` : null} />
              <Item label="NCM" value={p.ncm} mono />
              <Item label="Código de barras" value={p.codigo_barras} mono />
              <Item label="Cadastrado em" value={formatDate(p.criado_em)} />
              <Item label="Atualizado em" value={p.atualizado_em ? formatDate(p.atualizado_em) : null} />
            </dl>
            {p.descricao && <p className="mt-3 whitespace-pre-line border-t border-slate-100 pt-3 text-sm text-slate-600">{p.descricao}</p>}
          </section>
        </div>

        {/* Coluna direita */}
        <div className="space-y-4 lg:col-span-2">
          {/* KPIs */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi icon={Boxes} label="Peças em estoque" value={formatNumber(data.estoque.totalPecas)} />
            <Kpi icon={Wallet} label="Valor em estoque" value={formatMoney(data.estoque.valor)} />
            <Kpi icon={AlertTriangle} label="Abaixo do mínimo" value={formatNumber(data.estoque.abaixoMinimo)} tone={data.estoque.abaixoMinimo > 0 ? 'red' : 'green'} />
            <Kpi icon={Cog} label="OPs abertas" value={formatNumber(data.ordens.abertas.length)} />
          </div>

          {/* Grade de estoque */}
          <section className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
                <Boxes className="h-4 w-4 text-navy-400" /> Grade de estoque
                {data.grade && (
                  <span className="inline-flex items-center rounded bg-navy-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-navy-600">
                    {data.grade.nome}
                  </span>
                )}
              </h2>
              <Link to="/movimentacoes" className="btn-secondary !py-1 text-xs">
                <ArrowLeftRight className="h-3.5 w-3.5" /> Lançar movimentação
              </Link>
            </div>
            {data.estoque.grade.length === 0 ? (
              <p className="p-6 text-center text-sm text-slate-400">Nenhum saldo registrado para este produto.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Local</th>
                      {data.estoque.colunas.map((c) => (
                        <th key={c.id} className="text-center">
                          {c.codigo}
                        </th>
                      ))}
                      <th className="text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.estoque.grade.map((g) => (
                      <tr key={g.local}>
                        <td className="font-medium capitalize text-slate-800">{g.local}</td>
                        {g.celulas.map((c) => {
                          const low = c.estoque_min > 0 && c.quantidade <= c.estoque_min;
                          return (
                            <td key={c.tamanho_id} className="text-center tabular-nums">
                              <span className={`inline-block min-w-[2.5rem] rounded px-1.5 py-0.5 ${low ? 'bg-red-50 font-bold text-red-700' : c.quantidade === 0 ? 'text-slate-300' : 'font-medium text-slate-800'}`} title={c.estoque_min ? `Mínimo: ${c.estoque_min}` : undefined}>
                                {c.quantidade}
                              </span>
                            </td>
                          );
                        })}
                        <td className="text-right font-bold tabular-nums text-navy-900">{g.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Custo */}
          <section className="card p-4">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
                <ClipboardList className="h-4 w-4 text-navy-400" /> Custo e margem
              </h2>
              <Link to="/fichas" className="text-xs font-medium text-navy-700 hover:underline">
                {data.custo.ficha ? 'Ver ficha técnica' : 'Criar ficha técnica'}
              </Link>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
              <Item label="Custo do produto" value={formatMoney(data.custo.custoBase)} />
              <Item label="Mão de obra + indiretos" value={data.custo.ficha ? formatMoney(data.custo.custoFicha) : '— (sem ficha)'} />
              <Item label="Custo total" value={formatMoney(data.custo.custoTotal)} strong />
              <Item label="Margem da ficha" value={data.custo.ficha ? `${formatNumber(data.custo.margem)}%` : null} />
              <Item label="Preço sugerido" value={data.custo.precoSugerido !== null ? formatMoney(data.custo.precoSugerido) : null} />
              <Item label="Preço de venda atual" value={formatMoney(data.custo.precoVenda)} strong />
              <Item label="Margem real sobre a venda" value={data.custo.margemReal !== null ? `${formatNumber(data.custo.margemReal)}%` : null} tone={data.custo.margemReal !== null ? (data.custo.margemReal < 0 ? 'red' : data.custo.margemReal < 20 ? 'amber' : 'green') : undefined} />
            </dl>
          </section>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {/* Movimentações */}
            <section className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
                  <ArrowLeftRight className="h-4 w-4 text-navy-400" /> Últimas movimentações
                </h2>
              </div>
              {data.movimentacoes.length === 0 ? (
                <p className="p-6 text-center text-sm text-slate-400">Nenhuma movimentação.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {data.movimentacoes.map((m) => (
                    <li key={m.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                      <Badge tone={MOV_TONE[m.tipo] || 'slate'}>{MOV_LABEL[m.tipo] || m.tipo}</Badge>
                      <span className="w-14 text-right font-bold tabular-nums">{m.tipo === 'saida' ? '−' : m.quantidade < 0 ? '' : '+'}{formatNumber(Math.abs(m.quantidade))}</span>
                      <span className="text-slate-500">{m.tamanho_id__label}</span>
                      <span className="capitalize text-slate-500">{m.local}</span>
                      <span className="ml-auto whitespace-nowrap text-xs text-slate-400">{formatDateTime(m.data)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* OPs */}
            <section className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
                  <Cog className="h-4 w-4 text-navy-400" /> Ordens de fabricação
                </h2>
                <Link to="/ordens" className="text-xs font-medium text-navy-700 hover:underline">
                  Ver todas
                </Link>
              </div>
              {data.ordens.recentes.length === 0 ? (
                <p className="p-6 text-center text-sm text-slate-400">Nenhuma OP para este produto.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {data.ordens.recentes.map((o) => (
                    <li key={o.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                      <span className="font-mono text-xs text-slate-400">#{o.id}</span>
                      <Badge tone={OP_TONE[o.status] || 'slate'}>{OP_LABEL[o.status] || o.status}</Badge>
                      <span className="font-medium">{formatNumber(o.quantidade)} un.</span>
                      <span className="text-slate-500">{o.tamanho_id__label}</span>
                      <span className="ml-auto whitespace-nowrap text-xs text-slate-400">{o.previsao ? `prev. ${formatDate(o.previsao)}` : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      </div>

      {zoom && <Lightbox file={zoom} files={fotos} onClose={() => setZoom(null)} onNav={setZoom} />}

      <Modal open={formOpen} onClose={() => !saving && setFormOpen(false)} title="Editar produto" subtitle={`Registro #${p.id}`} size="lg">
        {formError && (
          <div className="mb-4">
            <Alert tone="red">{formError}</Alert>
          </div>
        )}
        <RecordForm
          resource={resource}
          values={values}
          errors={errors}
          onChange={(n, v) => {
            setValues((s) => ({ ...s, [n]: v }));
            if (errors[n]) setErrors((e) => ({ ...e, [n]: '' }));
          }}
          onSubmit={save}
          onClear={() => setValues(initialValues(resource, null))}
          editing
          busy={saving}
          refOptions={refOptions}
        />
      </Modal>

      <LabelSheet open={labels} onClose={() => setLabels(false)} produto={p} tamanhos={data.estoque.colunas} grade={data.estoque.grade} user={user?.name} />

      {!p.codigo_barras && (
        <p className="mt-4 flex items-center gap-1.5 text-xs text-slate-400">
          <Barcode className="h-3.5 w-3.5" /> Dica: cadastre o código de barras (EAN) para que as etiquetas saiam com o código comercial em vez do SKU interno.
        </p>
      )}
    </div>
  );
}

function Item({ label, value, strong, mono, tone }: { label: string; value: unknown; strong?: boolean; mono?: boolean; tone?: 'red' | 'amber' | 'green' }) {
  const empty = value === null || value === undefined || value === '';
  const color = tone === 'red' ? 'text-red-700' : tone === 'amber' ? 'text-amber-700' : tone === 'green' ? 'text-emerald-700' : 'text-slate-800';
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`${strong ? 'font-bold' : 'font-medium'} ${mono ? 'font-mono text-xs' : ''} ${empty ? 'text-slate-300' : color}`}>{empty ? '—' : String(value)}</dd>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, tone }: { icon: typeof Boxes; label: string; value: string; tone?: 'red' | 'green' }) {
  const accent = tone === 'red' ? 'bg-red-600' : tone === 'green' ? 'bg-emerald-600' : 'bg-navy-800';
  return (
    <div className="card flex items-center gap-3 p-3">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white ${accent}`}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="truncate text-xs text-slate-500">{label}</div>
        <div className="text-base font-bold text-navy-900">{value}</div>
      </div>
    </div>
  );
}
