// ============================================================================
// CADASTRO DE PRODUTOS — página própria, no lugar do modal genérico.
//
// Fluxo: /produtos (lista) → /produtos/novo → /produtos/:id/editar.
//
// O formulário NÃO inventa campos: ele é montado a partir do metadado do
// recurso (`resources.produtos`) e organiza os campos existentes em seções
// profissionais. Todo campo do modal anterior continua aqui — a diferença é o
// espaço, as máscaras e a validação por campo.
//
// MÁSCARA + VALIDAÇÃO + NORMALIZAÇÃO (client/src/lib/produtos.ts):
//   SKU .................. texto, sem espaço acidental (caixa preservada)
//   Código de barras ..... só dígitos; 8/12/13/14
//   NCM .................. 8 dígitos, exibido 6205.20.00
//   CEST ................. 7 dígitos, exibido 28.038.00
//   CFOP ................. 4 dígitos
//   GTIN tributário ...... 8/12/13/14 dígitos
//   Custo/Preços ......... moeda BR (R$ 1.500,00)
//   Percentuais .......... 0,00 %
//   Quantidades .......... inteiro >= 0
//   Tags ................. lista por vírgula, sem espaços nas pontas
// O servidor revalida tudo (validatePayload) — o front só evita a ida e volta.
//
// GRADE E VARIAÇÕES: a grade é o campo `grade_id` de sempre. As variações já
// materializadas aparecem em painel próprio (leitura) e a geração reusa os
// endpoints existentes (/produtos/:id/variacoes/previa e POST .../variacoes),
// sem criar um segundo cadastro de tamanhos.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Boxes,
  CheckCircle2,
  ClipboardList,
  Layers,
  Loader2,
  Package,
  Percent,
  Ruler,
  Save,
  Shirt,
  Tag,
  Truck,
  Wallet,
  X,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeta, type Field, type Option, type PublicFile } from '../lib/meta';
import { maskMoneyInput, parseMoneyInput, soDigitos } from '../lib/format';
import {
  erroCest,
  erroCfop,
  erroCodigoBarras,
  erroEstoqueMax,
  erroGtinTributario,
  erroNcm,
  erroNome,
  erroSku,
  normalizarCest,
  normalizarNcm,
  normalizarPayloadProduto,
  normalizarSku,
  normalizarTags,
} from '../lib/produtos';
import { Alert, PageHeader, Spinner, useToast } from '../components/ui';
import { ImageField } from '../components/ImageField';
import { VariacoesProduto } from '../components/VariacoesProduto';

type Valores = Record<string, string>;

/** Ordem de exibição das seções — a MESMA nomenclatura declarada no recurso. */
const SECOES: { titulo: string; icon: typeof Tag }[] = [
  { titulo: 'Informações básicas', icon: Tag },
  { titulo: 'Identificação e catálogo', icon: BadgeCheck },
  { titulo: 'Classificação', icon: Layers },
  { titulo: 'Comercial', icon: Wallet },
  { titulo: 'Varejo e atacado', icon: Wallet },
  { titulo: 'Estoque e suprimento', icon: Boxes },
  { titulo: 'Logística', icon: Truck },
  { titulo: 'Fiscal', icon: Percent },
];

/** Campos cujo valor é formatado como moeda na digitação. */
const MONEY = new Set(['custo', 'preco_venda', 'preco_atacado', 'custo_habitual']);
/** Campos percentuais. */
const PERCENT = new Set(['icms_aliquota', 'pis_aliquota', 'cofins_aliquota', 'ipi_aliquota']);

function mascaraDoCampo(nome: string, tipo: string, bruto: string): string {
  if (MONEY.has(nome) || tipo === 'money') return maskMoneyInput(bruto);
  if (PERCENT.has(nome) || tipo === 'percent') return maskMoneyInput(bruto);
  switch (nome) {
    case 'sku':
      return bruto.replace(/\s{2,}/g, ' ');
    case 'codigo_barras':
    case 'gtin_tributario':
      return soDigitos(bruto).slice(0, 14);
    case 'ncm':
      return bruto.replace(/[^\d.]/g, '').slice(0, 10);
    case 'cest':
      return bruto.replace(/[^\d.]/g, '').slice(0, 10);
    case 'cfop_saida':
    case 'icms_cst':
    case 'pis_cst':
    case 'cofins_cst':
    case 'ipi_cst':
      return soDigitos(bruto).slice(0, tipo === 'text' ? 4 : 4);
    default:
      return bruto;
  }
}

/** Valor da linha da API → texto do formulário (com a máscara de exibição). */
function valoresDaLinha(fields: Field[], row: Record<string, any>): Valores {
  const out: Valores = {};
  for (const f of fields) {
    const v = row[f.name];
    if (v === null || v === undefined) {
      out[f.name] = f.type === 'boolean' ? 'false' : '';
      continue;
    }
    if (f.type === 'boolean') {
      out[f.name] = v ? 'true' : 'false';
    } else if (MONEY.has(f.name) || PERCENT.has(f.name) || f.type === 'money' || f.type === 'percent') {
      const n = Number(v);
      out[f.name] = Number.isFinite(n) ? maskMoneyInput(String(n).replace('.', ',')) : '';
    } else if (f.type === 'ref') {
      out[f.name] = String(v);
    } else {
      out[f.name] = String(v);
    }
  }
  return out;
}

function valoresIniciais(fields: Field[]): Valores {
  const out: Valores = {};
  for (const f of fields) {
    if (f.type === 'boolean') out[f.name] = f.default ? 'true' : 'false';
    else out[f.name] = f.default !== undefined && f.default !== null ? String(f.default) : '';
  }
  return out;
}

export default function ProdutoFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const meta = useMeta();
  const toast = useToast();
  const resource = meta.resources.produtos;

  const podeSalvar = editing ? resource.ops.update : resource.ops.create;

  const campos = useMemo(
    () => (resource.fields || []).filter((f) => f.form !== false && !f.readonly && f.type !== 'images' && f.type !== 'password'),
    [resource]
  );

  const [values, setValues] = useState<Valores>(() => valoresIniciais(campos));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [carregando, setCarregando] = useState(editing);
  const [erroCarregar, setErroCarregar] = useState('');
  const [salvoComSucesso, setSalvoComSucesso] = useState(false);
  const [registro, setRegistro] = useState<Record<string, any> | null>(null);
  const [fotos, setFotos] = useState<PublicFile[] | null>(null);
  const [options, setOptions] = useState<Record<string, Option[]>>({});
  const errorSummaryRef = useRef<HTMLDivElement>(null);

  // ---- opções dos campos de referência (categoria, grade, coleção, cor, fornecedor)
  const refs = useMemo(
    () => Array.from(new Set(campos.filter((f) => f.type === 'ref' && f.ref).map((f) => f.ref!))),
    [campos]
  );
  const refsKey = refs.join(',');
  useEffect(() => {
    let alive = true;
    Promise.all(
      refs.map((ref) => api.get<Option[]>(`/${ref}/options`).then((o) => [ref, o] as const).catch(() => [ref, []] as const))
    ).then((pares) => alive && setOptions(Object.fromEntries(pares)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refsKey]);

  // ---- carregar o registro (edição)
  const carregar = useCallback(async () => {
    if (!editing || !id) return;
    setCarregando(true);
    try {
      const row = await api.get<Record<string, any>>(`/produtos/${id}`);
      setRegistro(row);
      setValues(valoresDaLinha(campos, row));
      setFotos(Array.isArray(row.fotos) ? row.fotos : []);
      setErroCarregar('');
    } catch (e) {
      setErroCarregar(e instanceof ApiError ? e.message : 'Não foi possível abrir o produto.');
    } finally {
      setCarregando(false);
    }
  }, [editing, id, campos]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const setCampo = useCallback((nome: string, valor: string) => {
    setValues((v) => ({ ...v, [nome]: valor }));
    setErrors((e) => (e[nome] ? { ...e, [nome]: '' } : e));
    setFormError('');
  }, []);

  /** Normaliza um campo conhecido ao sair do campo (evita erro por formatação). */
  function normalizarCampo(nome: string) {
    setValues((v) => {
      const atual = v[nome] ?? '';
      let novo = atual;
      switch (nome) {
        case 'sku':
          novo = normalizarSku(atual);
          break;
        case 'ncm':
          novo = normalizarNcm(atual);
          break;
        case 'cest':
          novo = normalizarCest(atual);
          break;
        case 'tags':
          novo = normalizarTags(atual);
          break;
        default:
          break;
      }
      return novo === atual ? v : { ...v, [nome]: novo };
    });
  }

  /** Validação local espelhando o servidor — erro junto do campo, na hora. */
  function validar(): Record<string, string> {
    const errs: Record<string, string> = {};
    for (const f of campos) {
      if (!f.required) continue;
      if (!String(values[f.name] ?? '').trim()) errs[f.name] = `Informe ${f.label.toLowerCase()}.`;
    }
    const sku = erroSku(values.sku);
    if (sku) errs.sku = sku;
    const nome = erroNome(values.nome);
    if (nome) errs.nome = nome;
    const cb = erroCodigoBarras(values.codigo_barras);
    if (cb) errs.codigo_barras = cb;
    const ncm = erroNcm(values.ncm);
    if (ncm) errs.ncm = ncm;
    const cest = erroCest(values.cest);
    if (cest) errs.cest = cest;
    const cfop = erroCfop(values.cfop_saida);
    if (cfop) errs.cfop_saida = cfop;
    const gtin = erroGtinTributario(values.gtin_tributario);
    if (gtin) errs.gtin_tributario = gtin;
    const est = erroEstoqueMax(values.estoque_min, values.estoque_max);
    if (est) errs.estoque_max = est;
    return errs;
  }

  /** Payload completo: nenhum campo do recurso fica de fora. */
  function montarPayload(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of campos) {
      const bruto = String(values[f.name] ?? '');
      const vazio = bruto.trim() === '';
      if (f.type === 'boolean') {
        out[f.name] = values[f.name] === 'true';
        continue;
      }
      if (vazio) {
        out[f.name] = null;
        continue;
      }
      if (f.type === 'money' || f.type === 'percent' || MONEY.has(f.name) || PERCENT.has(f.name)) {
        out[f.name] = parseMoneyInput(bruto);
        continue;
      }
      if (f.type === 'integer') {
        const n = Number(soDigitos(bruto) || bruto);
        out[f.name] = Number.isFinite(n) ? n : null;
        continue;
      }
      if (f.type === 'ref') {
        const n = Number(bruto);
        out[f.name] = Number.isInteger(n) ? n : null;
        continue;
      }
      out[f.name] = bruto.trim();
    }
    return normalizarPayloadProduto(out);
  }

  async function salvar(destino: 'lista' | 'continuar') {
    setFormError('');
    const errs = validar();
    setErrors(errs);
    if (Object.keys(errs).length) {
      setFormError('Verifique os campos destacados — nada foi salvo e o que você digitou foi mantido.');
      requestAnimationFrame(() => {
        errorSummaryRef.current?.focus();
        document.getElementById(`prod-${Object.keys(errs)[0]}`)?.focus();
      });
      return;
    }
    setSaving(true);
    try {
      const payload = montarPayload();
      if (editing && id) {
        const salvo = await api.put<Record<string, any>>(`/produtos/${id}`, payload);
        setRegistro(salvo);
        setSalvoComSucesso(true);
        toast.success('Produto salvo com sucesso.');
        if (destino === 'continuar') {
          setSalvoComSucesso(false);
          await carregar();
        } else {
          navigate('/produtos');
        }
      } else {
        const criado = await api.post<Record<string, any>>('/produtos', payload);
        toast.success('Produto cadastrado com sucesso.');
        if (destino === 'continuar' && criado?.id) {
          navigate(`/produtos/${criado.id}/editar`);
        } else {
          navigate('/produtos');
        }
      }
    } catch (e) {
      const fe = e instanceof ApiError && e.fields ? e.fields : {};
      setErrors(fe);
      setFormError(e instanceof ApiError ? e.message : 'Não foi possível salvar. Tente novamente.');
      requestAnimationFrame(() => errorSummaryRef.current?.focus());
    } finally {
      setSaving(false);
    }
  }

  const titulo = editing ? 'Editar produto' : 'Novo produto';
  const descricao = editing
    ? 'Atualize os dados do produto. Os campos com * são obrigatórios.'
    : 'Preencha os dados do produto. Os campos com * são obrigatórios.';

  if (carregando) {
    return (
      <div className="p-4 sm:p-6">
        <Spinner label="Carregando produto..." />
      </div>
    );
  }

  if (erroCarregar) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title={titulo} description="Não foi possível abrir o cadastro." />
        <Alert tone="red">{erroCarregar}</Alert>
        <Link to="/produtos" className="btn-secondary mt-4 inline-flex">
          <ArrowLeft className="h-4 w-4" /> Voltar para a lista
        </Link>
      </div>
    );
  }

  // Agrupa os campos pelas seções declaradas no recurso, na ordem canônica.
  const porSecao = new Map<string, Field[]>();
  for (const f of campos) {
    const chave = f.section && SECOES.some((s) => s.titulo === f.section) ? f.section : 'Informações básicas';
    porSecao.set(chave, [...(porSecao.get(chave) ?? []), f]);
  }
  const secoes = SECOES.filter((s) => porSecao.has(s.titulo));

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <Shirt className="h-5 w-5" />
            </span>
            {titulo}
          </span>
        }
        description={descricao}
        actions={
          <>
            <Link to="/produtos" className="btn-secondary inline-flex">
              <ArrowLeft className="h-4 w-4" /> <span className="hidden sm:inline">Voltar</span>
            </Link>
            <button type="button" className="btn-secondary inline-flex" onClick={() => navigate('/produtos')} disabled={saving}>
              <X className="h-4 w-4" /> <span className="hidden sm:inline">Cancelar</span>
            </button>
            {!editing && (
              <button
                type="button"
                className="btn-secondary inline-flex"
                onClick={() => void salvar('continuar')}
                disabled={saving || !podeSalvar}
                title="Salvar e abrir o produto para anexar fotos e gerar variações"
              >
                <CheckCircle2 className="h-4 w-4" /> <span className="hidden md:inline">Salvar e continuar</span>
              </button>
            )}
            <button
              type="submit"
              form="form-produto"
              className="btn-primary inline-flex"
              disabled={saving || !podeSalvar || salvoComSucesso}
              title={podeSalvar ? undefined : 'Seu perfil não tem permissão para salvar produtos.'}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {editing ? 'Salvar alterações' : 'Salvar produto'}
            </button>
          </>
        }
      />

      {!podeSalvar && (
        <div className="mb-4">
          <Alert tone="amber">
            Seu perfil tem acesso somente de leitura a Produtos. Você pode revisar os dados, mas não salvar.
          </Alert>
        </div>
      )}

      {formError && (
        <div ref={errorSummaryRef} tabIndex={-1} className="mb-4 outline-none" role="alert" aria-live="assertive">
          <Alert tone="red">
            <span className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{formError}</span>
            </span>
          </Alert>
        </div>
      )}

      <form
        id="form-produto"
        className="space-y-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void salvar('lista');
        }}
      >
        {secoes.map(({ titulo: tituloSecao, icon: Icone }) => (
          <Secao key={tituloSecao} icon={Icone} titulo={tituloSecao}>
            {(porSecao.get(tituloSecao) ?? []).map((f) => (
              <CampoProduto
                key={f.name}
                field={f}
                valor={values[f.name] ?? ''}
                erro={errors[f.name]}
                opcoes={f.type === 'ref' && f.ref ? options[f.ref] : undefined}
                onChange={(v) => setCampo(f.name, v)}
                onBlur={() => normalizarCampo(f.name)}
              />
            ))}
          </Secao>
        ))}

        {/* ---------------- Fotos (só depois de salvar) ---------------- */}
        {editing && registro && resource.images && (
          <Secao icon={Package} titulo="Imagens">
            <div className="sm:col-span-2">
              <span className="label">Fotos do produto</span>
              <p className="mb-2 text-xs text-slate-400">
                Até {resource.images.max} fotos. A primeira é a principal e aparece na lista, no PDV e no catálogo.
              </p>
              <ImageField
                key={registro.id}
                resource={resource}
                recordId={Number(registro.id)}
                initial={fotos ?? undefined}
                canEdit={podeSalvar}
                onChange={(lista) => setFotos(lista)}
              />
            </div>
          </Secao>
        )}

        {/* ---------------- Grade e variações ---------------- */}
        {editing && registro && (
          <Secao icon={Ruler} titulo="Grade e variações">
            <div className="sm:col-span-2">
              <VariacoesProduto produto={registro} podeGerar={resource.ops.create} />
            </div>
          </Secao>
        )}

        {/* ---------------- Auditoria (somente leitura) ---------------- */}
        {editing && registro && (
          <Secao icon={ClipboardList} titulo="Informações adicionais">
            <div className="sm:col-span-2 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
              <Info rotulo="Registro" valor={`#${registro.id}`} />
              <Info rotulo="Criado em" valor={registro.criado_em ? new Date(String(registro.criado_em)).toLocaleString('pt-BR') : '—'} />
              <Info rotulo="Atualizado em" valor={registro.atualizado_em ? new Date(String(registro.atualizado_em)).toLocaleString('pt-BR') : '—'} />
            </div>
          </Secao>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-4">
          <button type="button" className="btn-secondary" onClick={() => navigate('/produtos')} disabled={saving}>
            <X className="h-4 w-4" /> Cancelar
          </button>
          <button type="submit" form="form-produto" className="btn-primary" disabled={saving || !podeSalvar || salvoComSucesso}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {editing ? 'Salvar alterações' : 'Salvar produto'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Secao({ icon: Icon, titulo, children }: { icon: typeof Tag; titulo: string; children: ReactNode }) {
  return (
    <section className="card p-4 sm:p-5">
      <h2 className="mb-4 flex items-center gap-2 border-b border-slate-100 pb-3 text-sm font-bold uppercase tracking-wide text-navy-800">
        <Icon className="h-4 w-4 text-navy-400" aria-hidden="true" />
        {titulo}
      </h2>
      <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function Info({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{rotulo}</dt>
      <dd className="font-medium text-slate-800">{valor}</dd>
    </div>
  );
}

/**
 * Um campo do cadastro. O tipo vem do metadado; a máscara e a validação vêm do
 * domínio (lib/produtos.ts). Labels, foco, aria e mensagem de erro por campo.
 */
function CampoProduto({
  field: f,
  valor,
  erro,
  opcoes,
  onChange,
  onBlur,
}: {
  field: Field;
  valor: string;
  erro?: string;
  opcoes?: Option[];
  onChange: (v: string) => void;
  onBlur: () => void;
}) {
  const id = `prod-${f.name}`;
  const idErro = erro ? `${id}-erro` : undefined;
  const idDica = !erro && f.hint ? `${id}-dica` : undefined;
  const wide = f.wide || f.type === 'textarea';
  const classe = `input ${erro ? 'input-error' : ''}`;
  const label = (
    <label htmlFor={id} className="label">
      {f.label}
      {f.required && (
        <span className="ml-0.5 text-red-500" aria-hidden="true">
          *
        </span>
      )}
      {f.required && <span className="sr-only"> (obrigatório)</span>}
    </label>
  );
  const ajuda = erro ? (
    <p id={idErro} className="mt-1 text-xs font-medium text-red-600" role="alert">
      {erro}
    </p>
  ) : f.hint ? (
    <p id={idDica} className="mt-1 text-xs text-slate-400 dark:text-navy-300">
      {f.hint}
    </p>
  ) : null;

  // ---- booleano
  if (f.type === 'boolean') {
    return (
      <div className="flex h-full flex-col justify-end">
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2.5">
          <input
            id={id}
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-navy-800 focus:ring-navy-500/30"
            checked={valor === 'true'}
            onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
            aria-describedby={idDica}
          />
          <span className="text-sm font-medium text-slate-700">{f.label}</span>
        </label>
        {ajuda}
      </div>
    );
  }

  // ---- select
  if (f.type === 'select') {
    return (
      <div className={wide ? 'sm:col-span-2' : ''}>
        {label}
        <select
          id={id}
          className={classe}
          value={valor}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          aria-invalid={erro ? true : undefined}
          aria-describedby={[idErro, idDica].filter(Boolean).join(' ') || undefined}
        >
          <option value="">{f.required ? 'Selecione...' : '— Nenhum —'}</option>
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {ajuda}
      </div>
    );
  }

  // ---- referência (categoria, grade, coleção, cor, fornecedor)
  if (f.type === 'ref') {
    const carregado = opcoes !== undefined;
    return (
      <div className={wide ? 'sm:col-span-2' : ''}>
        {label}
        <select
          id={id}
          className={classe}
          value={valor}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          disabled={!carregado}
          aria-invalid={erro ? true : undefined}
          aria-describedby={[idErro, idDica].filter(Boolean).join(' ') || undefined}
        >
          <option value="">{!carregado ? 'Carregando...' : opcoes.length === 0 ? 'Nenhum cadastrado' : f.required ? 'Selecione...' : '— Nenhum —'}</option>
          {opcoes?.map((o) => (
            <option key={o.value} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
        {ajuda}
      </div>
    );
  }

  // ---- área de texto
  if (f.type === 'textarea') {
    return (
      <div className="sm:col-span-2">
        {label}
        <textarea
          id={id}
          className={`${classe} min-h-[88px]`}
          value={valor}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          maxLength={f.maxLength}
          placeholder={f.placeholder}
          aria-invalid={erro ? true : undefined}
          aria-describedby={[idErro, idDica].filter(Boolean).join(' ') || undefined}
        />
        {ajuda}
      </div>
    );
  }

  // ---- entrada de texto/número com máscara
  const inputMode: 'numeric' | 'decimal' | undefined =
    f.type === 'integer' ? 'numeric' : f.type === 'money' || f.type === 'percent' || f.type === 'number' ? 'decimal' : undefined;
  const prefixo = MONEY.has(f.name) || f.type === 'money' ? 'R$' : undefined;
  const sufixo = PERCENT.has(f.name) || f.type === 'percent' ? '%' : undefined;

  return (
    <div className={wide ? 'sm:col-span-2' : ''}>
      {label}
      <div className="relative">
        {prefixo && <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-sm text-slate-400">{prefixo}</span>}
        <input
          id={id}
          type="text"
          inputMode={inputMode}
          className={`${classe} ${prefixo ? 'pl-9' : ''} ${sufixo ? 'pr-8' : ''}`}
          value={valor}
          onChange={(e) => onChange(mascaraDoCampo(f.name, f.type, e.target.value))}
          onBlur={onBlur}
          maxLength={f.maxLength}
          placeholder={f.placeholder}
          autoComplete="off"
          aria-invalid={erro ? true : undefined}
          aria-describedby={[idErro, idDica].filter(Boolean).join(' ') || undefined}
          required={f.required || undefined}
        />
        {sufixo && <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-sm text-slate-400">{sufixo}</span>}
      </div>
      {ajuda}
    </div>
  );
}
