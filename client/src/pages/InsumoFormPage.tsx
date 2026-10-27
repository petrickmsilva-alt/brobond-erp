// ============================================================================
// CADASTRO DE INSUMOS — PÁGINA do ERP (lista → página), sem modal e sem drawer.
//
// Fluxo canônico do BROBOND ERP (o MESMO de Cores, Coleções e Grades):
//
//   /insumos                → lista (tela principal)
//   /insumos/novo           → página "Novo insumo"
//   /insumos/:id/editar     → página "Editar insumo"
//
// Nada é sobreposto à lista: a inclusão/edição é uma rota normal, com o
// breadcrumb do shell, o `PageHeader` padrão e as ações Voltar / Cancelar /
// Salvar insumo.
//
// A página separa o que é DADO CADASTRAL do que é DADO CALCULADO:
//
//   EDITÁVEL (vai no POST/PUT)          CALCULADO (só leitura, vem do domínio)
//   ─────────────────────────           ─────────────────────────────────────
//   código · nome · categoria            estoque atual / mínimo / situação
//   unidade · fornecedor principal       última movimentação
//   ativo                                último preço de compra / última compra
//   custo médio (referência inicial)     custo médio (depois da 1ª compra)
//                                        utilização em ficha técnica
//
// REUTILIZA os componentes JÁ existentes do ERP — nenhum design system novo:
//   • `PageHeader`, `Alert`, `Badge`, `Spinner`, `useToast`  (components/ui)
//   • `RecordForm` dirigido pelos metadados de GET /api/meta
//   • `validarFormulario` / `toPayload` / `initialValues` (mesmas regras do
//     CRUD genérico — um campo nunca tem duas validações no ERP)
//   • `useRefOptions` (opções de fornecedor/categoria do endpoint `/options`)
//   • `lib/lista` e `lib/format` (rótulos e formatação, sem texto duplicado)
//
// CAMPOS CADASTRAIS — os que EXISTEM de verdade em `insumos` (db/schema.sql +
// migration 0041): codigo_insumo · nome · categoria_id · unidade ·
// fornecedor_id · ativo · custo_medio. NÃO existem (e por isso NÃO aparecem):
// NCM, descrição, marca, cor, imagem, estoque mínimo/máximo, localização.
// O estoque mínimo vive em `estoque_insumos` — é exibido como DADO CALCULADO e
// continua editável no módulo "Estoque de Insumos", como sempre.
//
// CUSTO MÉDIO: referência inicial editável. Depois da PRIMEIRA movimentação
// (compra/entrada) ele é formado pelo recebimento de compras: a página o mostra
// como dado calculado e o servidor recusa um PUT que tente alterá-lo. As
// escritas internas do custo continuam pelo store — o fluxo de compras não muda.
//
// Contrato da API: POST/PUT /api/insumos com
// { codigo_insumo, nome, categoria_id, unidade, fornecedor_id, ativo, custo_medio }.
// RBAC intacto: `insumos` é cadastro POR EMPRESA (sem `minPerfilEscrita`) e o
// servidor (checkAccess + validatePayload) continua sendo a autoridade.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Boxes, ClipboardList, Loader2, Package, Save, Wallet, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeta, type ResourceMeta, type Tone } from '../lib/meta';
import { Alert, Badge, PageHeader, Spinner, useToast } from '../components/ui';
import {
  fieldErrors,
  initialValues,
  RecordForm,
  toPayload,
  useRefOptions,
  validarFormulario,
  type FormValues,
} from '../components/RecordForm';
import { descricaoDoCadastro, rotuloEditar, rotuloNovo, rotuloSalvar } from '../lib/lista';
import { formatDate, formatMoney, formatNumber } from '../lib/format';
import { useAuth } from '../auth/AuthContext';

/**
 * Metadado de emergência: só existe para manter a ordem dos hooks estável
 * quando o recurso ainda não está no /api/meta (a tela avisa e não salva).
 */
const RECURSO_INDISPONIVEL: ResourceMeta = {
  key: 'insumos',
  label: 'Insumos',
  singular: 'Insumo',
  labelFields: ['nome'],
  fields: [],
  ops: { create: false, update: false, delete: false },
};

/** Situação do estoque (derivada no servidor) → tom e rótulo do Badge padrão. */
const SITUACAO_ESTOQUE: Record<string, { label: string; tone: Tone }> = {
  normal: { label: 'Normal', tone: 'green' },
  abaixo_minimo: { label: 'Abaixo do mínimo', tone: 'amber' },
  sem_estoque: { label: 'Sem estoque', tone: 'red' },
  sem_registro: { label: 'Sem movimentação', tone: 'slate' },
};

/** Linha rótulo → valor de um painel de DADOS CALCULADOS (somente leitura). */
function CampoDerivado({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-navy-300">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-navy-800 dark:text-navy-100">{children}</dd>
    </div>
  );
}

export default function InsumoFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const toast = useToast();
  const meta = useMeta();
  const { user } = useAuth();
  const resource = meta.resources['insumos'];
  const defaultLocal = meta.defaultLocal ?? null;

  // RBAC espelhado do servidor. `insumos` é cadastro POR EMPRESA: não declara
  // `minPerfilEscrita` (isso é do catálogo GLOBAL — categorias/cores/grades), e
  // este espelho continua genérico para o dia em que um piso for declarado.
  // Só controla o que aparece/habilita: a autorização real é da API.
  const perfilOkEscrita =
    !resource?.minPerfilEscrita ||
    user?.perfil === 'admin' ||
    (resource.minPerfilEscrita === 'gerente' && user?.perfil === 'gerente');
  const podeSalvar = perfilOkEscrita && !!resource && (editing ? resource.ops.update : resource.ops.create);

  const [values, setValues] = useState<FormValues>(() => (resource ? initialValues(resource, null, defaultLocal) : {}));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [carregando, setCarregando] = useState(editing);
  const [erroCarregar, setErroCarregar] = useState('');
  const [salvoComSucesso, setSalvoComSucesso] = useState(false);
  const [registro, setRegistro] = useState<Record<string, any> | null>(null);
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  // Opções do fornecedor/categoria: o hook usa o endpoint padrão de opções
  // (`/options`), o mesmo que o CRUD genérico usa — nenhum endpoint novo.
  const refOptions = useRefOptions(resource ?? RECURSO_INDISPONIVEL);

  // ---- carga do registro (edição) ----
  const carregar = useCallback(async () => {
    if (!editing || !id || !resource) return;
    setCarregando(true);
    try {
      const row = await api.get<Record<string, any>>(`/insumos/${id}`);
      setRegistro(row);
      setValues(initialValues(resource, row, defaultLocal));
      setErroCarregar('');
    } catch (e) {
      setErroCarregar(e instanceof ApiError ? e.message : 'Não foi possível abrir o insumo.');
    } finally {
      setCarregando(false);
    }
  }, [editing, id, resource, defaultLocal]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  function onChange(name: string, value: string | boolean | string[]) {
    setValues((v) => ({ ...v, [name]: value }));
    if (errors[name]) setErrors((e) => ({ ...e, [name]: '' }));
    setFormError('');
  }

  /** Salva no MESMO contrato do CRUD genérico (POST/PUT /insumos). */
  async function salvar() {
    if (saving || salvoComSucesso || !resource) return;
    setFormError('');

    const { errors: errs, formError: msg } = validarFormulario(resource, values, editing);
    setErrors(errs);
    if (msg) {
      setFormError(msg);
      requestAnimationFrame(() => {
        errorSummaryRef.current?.focus();
        document.getElementById(`f-${Object.keys(errs)[0]}`)?.focus();
      });
      return;
    }

    setSaving(true);
    try {
      const payload = toPayload(resource, values, editing);
      // Campos calculados NESTA tela (custo médio já formado por compra) não
      // voltam no PUT: quem forma o valor é o recebimento, não o formulário.
      for (const nome of camposSomenteLeitura) delete payload[nome];
      if (editing && id) {
        await api.put<Record<string, any>>(`/insumos/${id}`, payload);
        toast.success('Insumo salvo com sucesso.');
      } else {
        await api.post<Record<string, any>>('/insumos', payload);
        toast.success('Insumo cadastrado com sucesso.');
      }
      setSalvoComSucesso(true);
      // Salvar devolve a pessoa à lista (tela principal), como no restante do ERP.
      navigate('/insumos');
    } catch (e) {
      setErrors(fieldErrors(e));
      setFormError(e instanceof ApiError ? e.message : 'Não foi possível salvar. Tente novamente.');
      requestAnimationFrame(() => errorSummaryRef.current?.focus());
    } finally {
      setSaving(false);
    }
  }

  if (!resource) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title="Insumos" description="Cadastro de insumos da produção." />
        <Alert tone="red">O cadastro de Insumos não está disponível neste ambiente.</Alert>
        <Link to="/insumos" className="btn-secondary mt-4 inline-flex">
          <ArrowLeft className="h-4 w-4" /> Voltar para a lista
        </Link>
      </div>
    );
  }

  const titulo = editing ? rotuloEditar(resource.key, resource.singular) : rotuloNovo(resource.key, resource.singular);
  const nomeAtual = editing ? String(registro?.nome ?? values.nome ?? '').trim() : '';
  const descricao = editing
    ? nomeAtual
      ? `Alterando o insumo “${nomeAtual}”. Os campos com * são obrigatórios.`
      : 'Atualize os dados do insumo. Os campos com * são obrigatórios.'
    : descricaoDoCadastro(resource.key) ?? 'Preencha os dados do insumo. Os campos com * são obrigatórios.';
  // Rótulo do botão de salvar: na criação é "Salvar insumo" (rótulo do
  // recurso, em `client/src/lib/lista.ts`); na edição, "Salvar alterações" —
  // a mesma convenção já usada em Categorias e Clientes.
  const rotuloSalvarInsumo = editing ? 'Salvar alterações' : rotuloSalvar(resource.key);

  // ---- DADOS CALCULADOS (somente na edição; vêm do domínio, não do formulário) ----
  // Nada aqui é editável: saldo/mínimo/situação/última movimentação/custo médio
  // derivado são anotados pelo servidor a partir de `estoque_insumos`,
  // `movimentacoes_insumos` e do recebimento de compras. Se o insumo ainda não
  // tem histórico, o bloco correspondente simplesmente NÃO aparece — nada de
  // campo vazio só para preencher espaço.
  const temHistorico = registro?.estoque_tem_movimentacao === true;
  const estoqueTemDados = editing && registro != null && (registro.estoque_saldo != null || registro.estoque_min != null);
  const custoTemDados = editing && registro != null;
  const unidadeAtual = String(registro?.unidade ?? values.unidade ?? '').trim();
  const situacao = registro?.estoque_status ? SITUACAO_ESTOQUE[String(registro.estoque_status)] : undefined;
  const usoVinculado = Number(registro?.uso_vinculado ?? 0);
  const temUso = editing && registro != null && Number.isFinite(usoVinculado) && usoVinculado > 0;
  // Com histórico de compra o custo médio é CALCULADO: a página o mostra como
  // leitura e o servidor recusa um PUT que tente alterá-lo.
  const camposSomenteLeitura = temHistorico ? ['custo_medio'] : [];

  if (carregando) {
    return (
      <div className="p-4 sm:p-6">
        <Spinner label="Carregando insumo..." />
      </div>
    );
  }

  if (erroCarregar) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title={titulo} description="Não foi possível abrir o cadastro." />
        <Alert tone="red">{erroCarregar}</Alert>
        <Link to="/insumos" className="btn-secondary mt-4 inline-flex">
          <ArrowLeft className="h-4 w-4" /> Voltar para a lista
        </Link>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <Package className="h-5 w-5" />
            </span>
            {titulo}
          </span>
        }
        description={descricao}
        actions={
          <>
            {/* No celular o rótulo some e sobra o ícone: o aria-label mantém o
                nome acessível nos dois tamanhos de tela. */}
            <Link to="/insumos" className="btn-secondary inline-flex" aria-label="Voltar para a lista de insumos">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> <span className="hidden sm:inline">Voltar</span>
            </Link>
            <button
              type="button"
              className="btn-secondary inline-flex"
              onClick={() => navigate('/insumos')}
              disabled={saving}
              aria-label="Cancelar e voltar para a lista de insumos"
            >
              <X className="h-4 w-4" aria-hidden="true" /> <span className="hidden sm:inline">Cancelar</span>
            </button>
            <button
              type="submit"
              form={`form-${resource.key}`}
              className="btn-primary inline-flex"
              disabled={saving || !podeSalvar || salvoComSucesso}
              title={podeSalvar ? undefined : 'Seu perfil não tem permissão para salvar insumos.'}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {rotuloSalvarInsumo}
            </button>
          </>
        }
      />

      {!podeSalvar && (
        <div className="mb-4">
          <Alert tone="amber">
            Seu perfil tem acesso somente de leitura a Insumos. Você pode revisar os dados, mas não salvar.
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

      <section className="card p-4 sm:p-5">
        <h2 className="mb-4 flex items-center gap-2 border-b border-slate-100 pb-3 text-sm font-bold uppercase tracking-wide text-navy-800 dark:border-navy-800">
          <Package className="h-4 w-4 text-navy-400" aria-hidden="true" />
          Informações do insumo
        </h2>

        {/* O formulário é o MESMO componente dirigido por metadados: campos,
            obrigatoriedade e validações vêm de GET /api/meta. `hideActions`
            evita uma segunda barra de botões — a da página é a única. Os campos
            em `camposSomenteLeitura` (custo médio já formado por compra) são
            apresentados como leitura e não voltam no payload. */}
        <RecordForm
          resource={resource}
          values={values}
          errors={errors}
          onChange={onChange}
          onSubmit={() => void salvar()}
          onClear={() => {
            setValues(initialValues(resource, null, defaultLocal));
            setErrors({});
            setFormError('');
          }}
          editing={editing}
          busy={saving || !podeSalvar}
          refOptions={refOptions}
          autoFocus
          hideActions
          camposSomenteLeitura={camposSomenteLeitura}
        />

        {/* Rodapé de ações da página — mesma dupla de botões do cabeçalho,
            para telas longas e mobile. Submete o formulário pelo atributo
            `form`, sem duplicar a barra de ações dentro do form. */}
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-4 dark:border-navy-800">
          <button type="button" className="btn-secondary" onClick={() => navigate('/insumos')} disabled={saving}>
            <X className="h-4 w-4" /> Cancelar
          </button>
          <button
            type="submit"
            form={`form-${resource.key}`}
            className="btn-primary"
            disabled={saving || !podeSalvar || salvoComSucesso}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {rotuloSalvarInsumo}
          </button>
        </div>
      </section>

      {/* ---- DADOS CALCULADOS: só aparecem na edição e só com dado REAL ---- */}
      {editing && registro && (
        <div className="mt-5 space-y-5">
          {temHistorico && (
            <div>
              <Alert tone="blue">
                O custo médio é calculado pelo recebimento de compras e não pode ser editado aqui. Registre uma compra
                ou uma entrada para atualizá-lo.
              </Alert>
            </div>
          )}

          {/* ESTOQUE — saldo e mínimo vivem em `estoque_insumos`, agregados pelo
              servidor; nada é campo manual no cadastro. */}
          {estoqueTemDados && (
            <section className="card p-4 sm:p-5">
              <h2 className="mb-4 flex items-center gap-2 border-b border-slate-100 pb-3 text-sm font-bold uppercase tracking-wide text-navy-800 dark:border-navy-800">
                <Boxes className="h-4 w-4 text-navy-400" aria-hidden="true" />
                Estoque
              </h2>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
                <CampoDerivado label="Estoque atual">
                  {registro.estoque_saldo == null ? '—' : `${formatNumber(registro.estoque_saldo)}${unidadeAtual ? ` ${unidadeAtual}` : ''}`}
                </CampoDerivado>
                <CampoDerivado label="Estoque mínimo">
                  {registro.estoque_min == null ? '—' : `${formatNumber(registro.estoque_min)}${unidadeAtual ? ` ${unidadeAtual}` : ''}`}
                </CampoDerivado>
                <CampoDerivado label="Situação">
                  {situacao ? <Badge tone={situacao.tone}>{situacao.label}</Badge> : '—'}
                </CampoDerivado>
                <CampoDerivado label="Última movimentação">
                  {registro.ultima_movimentacao ? formatDate(registro.ultima_movimentacao) : '—'}
                  {registro.ultima_movimentacao_tipo && (
                    <span className="ml-1 text-xs font-normal text-slate-400">({registro.ultima_movimentacao_tipo})</span>
                  )}
                </CampoDerivado>
              </dl>
              <p className="mt-3 text-xs text-slate-400 dark:text-navy-300">
                Saldo e mínimo são mantidos pelo módulo Estoque de Insumos; aqui são apenas exibidos.
              </p>
            </section>
          )}

          {/* CUSTOS CALCULADOS — último preço/última compra derivados do recebimento. */}
          {custoTemDados && (
            <section className="card p-4 sm:p-5">
              <h2 className="mb-4 flex items-center gap-2 border-b border-slate-100 pb-3 text-sm font-bold uppercase tracking-wide text-navy-800 dark:border-navy-800">
                <Wallet className="h-4 w-4 text-navy-400" aria-hidden="true" />
                Custos calculados
              </h2>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
                <CampoDerivado label="Último preço de compra">
                  {registro.ultimo_custo_entrada == null ? '—' : formatMoney(registro.ultimo_custo_entrada)}
                </CampoDerivado>
                <CampoDerivado label="Custo médio">
                  {formatMoney(registro.custo_medio)}
                  {temHistorico && <span className="ml-1 text-xs font-normal text-slate-400">(calculado)</span>}
                </CampoDerivado>
                <CampoDerivado label="Última compra">
                  {registro.ultima_entrada_em ? formatDate(registro.ultima_entrada_em) : '—'}
                </CampoDerivado>
              </dl>
            </section>
          )}

          {/* ENGENHARIA / UTILIZAÇÃO — uso real do insumo na ficha técnica. */}
          {temUso && (
            <section className="card p-4 sm:p-5">
              <h2 className="mb-4 flex items-center gap-2 border-b border-slate-100 pb-3 text-sm font-bold uppercase tracking-wide text-navy-800 dark:border-navy-800">
                <ClipboardList className="h-4 w-4 text-navy-400" aria-hidden="true" />
                Engenharia / Utilização
              </h2>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
                <CampoDerivado label="Fichas técnicas">
                  {registro.uso_vinculado_label ?? `${usoVinculado}`}
                </CampoDerivado>
              </dl>
              <div className="mt-3">
                <Link to="/fichas" className="btn-secondary inline-flex text-xs">
                  Ver fichas técnicas
                </Link>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
