// ============================================================================
// CATEGORIAS DE INSUMOS — PÁGINA do ERP (lista → página), sem modal e drawer.
//
// Fluxo canônico do BROBOND ERP (o MESMO de Cores, Coleções, Categorias e
// Insumos):
//
//   /categorias-insumos              → lista (tela principal)
//   /categorias-insumos/novo         → página "Nova categoria"
//   /categorias-insumos/:id/editar   → página "Editar categoria"
//
// A taxonomia é PRÓPRIA do insumo (matéria-prima, aviamentos, identidade de
// marca, embalagem...), separada da categoria do PRODUTO ACABADO: agrupar
// matéria-prima por tipo de peça não faria sentido. Admite UM nível de
// categoria-pai para agrupar sem inflar o cadastro.
//
// REUTILIZA os componentes JÁ existentes do ERP — nenhum design system novo:
//   • `PageHeader`, `Alert`, `Spinner`, `useToast`  (components/ui)
//   • `RecordForm` dirigido pelos metadados de GET /api/meta
//   • `validarFormulario` / `toPayload` / `initialValues` / `useRefOptions`
//     (as MESMAS regras do CRUD genérico — um campo nunca tem duas validações)
//
// Contrato da API: POST/PUT /api/categorias_insumos com
// { nome, descricao, pai_id, ativo }. RBAC intacto: cadastro POR EMPRESA (sem
// `minPerfilEscrita`) e o servidor (checkAccess + validatePayload) é a
// autoridade — a UI só reflete o que a API autoriza.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Layers, Loader2, Save, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeta, type ResourceMeta } from '../lib/meta';
import { Alert, PageHeader, Spinner, useToast } from '../components/ui';
import {
  fieldErrors,
  initialValues,
  RecordForm,
  toPayload,
  useRefOptions,
  validarFormulario,
  type FormValues,
} from '../components/RecordForm';
import { useAuth } from '../auth/AuthContext';

const RECURSO_INDISPONIVEL: ResourceMeta = {
  key: 'categorias_insumos',
  label: 'Categorias de Insumos',
  singular: 'Categoria de insumo',
  labelFields: ['nome'],
  fields: [],
  ops: { create: false, update: false, delete: false },
};

const BASE = '/categorias-insumos';

export default function CategoriaInsumoFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const toast = useToast();
  const meta = useMeta();
  const { user } = useAuth();
  const resource = meta.resources['categorias_insumos'];
  const defaultLocal = meta.defaultLocal ?? null;

  // RBAC espelhado do servidor. Cadastro POR EMPRESA: sem `minPerfilEscrita`.
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
  const refOptions = useRefOptions(resource ?? RECURSO_INDISPONIVEL);

  const carregar = useCallback(async () => {
    if (!editing || !id || !resource) return;
    setCarregando(true);
    try {
      const row = await api.get<Record<string, any>>(`/categorias_insumos/${id}`);
      setRegistro(row);
      setValues(initialValues(resource, row, defaultLocal));
      setErroCarregar('');
    } catch (e) {
      setErroCarregar(e instanceof ApiError ? e.message : 'Não foi possível abrir a categoria.');
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
      if (editing && id) {
        await api.put<Record<string, any>>(`/categorias_insumos/${id}`, payload);
        toast.success('Categoria salva com sucesso.');
      } else {
        await api.post<Record<string, any>>('/categorias_insumos', payload);
        toast.success('Categoria cadastrada com sucesso.');
      }
      setSalvoComSucesso(true);
      navigate(BASE);
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
        <PageHeader title="Categorias de Insumos" description="Cadastro das categorias de insumo." />
        <Alert tone="red">O cadastro de Categorias de Insumos não está disponível neste ambiente.</Alert>
        <Link to={BASE} className="btn-secondary mt-4 inline-flex">
          <ArrowLeft className="h-4 w-4" /> Voltar para a lista
        </Link>
      </div>
    );
  }

  const titulo = editing ? 'Editar categoria de insumo' : 'Nova categoria de insumo';
  const nomeAtual = editing ? String(registro?.nome ?? values.nome ?? '').trim() : '';
  const descricao = editing
    ? nomeAtual
      ? `Alterando a categoria “${nomeAtual}”. Os campos com * são obrigatórios.`
      : 'Atualize os dados da categoria. Os campos com * são obrigatórios.'
    : 'Preencha os dados da categoria de insumo. Os campos com * são obrigatórios.';
  const rotuloSalvar = editing ? 'Salvar alterações' : 'Salvar categoria';

  if (carregando) {
    return (
      <div className="p-4 sm:p-6">
        <Spinner label="Carregando categoria..." />
      </div>
    );
  }

  if (erroCarregar) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title={titulo} description="Não foi possível abrir o cadastro." />
        <Alert tone="red">{erroCarregar}</Alert>
        <Link to={BASE} className="btn-secondary mt-4 inline-flex">
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
              <Layers className="h-5 w-5" />
            </span>
            {titulo}
          </span>
        }
        description={descricao}
        actions={
          <>
            <Link to={BASE} className="btn-secondary inline-flex" aria-label="Voltar para a lista de categorias de insumos">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> <span className="hidden sm:inline">Voltar</span>
            </Link>
            <button
              type="button"
              className="btn-secondary inline-flex"
              onClick={() => navigate(BASE)}
              disabled={saving}
              aria-label="Cancelar e voltar para a lista de categorias de insumos"
            >
              <X className="h-4 w-4" aria-hidden="true" /> <span className="hidden sm:inline">Cancelar</span>
            </button>
            <button
              type="submit"
              form={`form-${resource.key}`}
              className="btn-primary inline-flex"
              disabled={saving || !podeSalvar || salvoComSucesso}
              title={podeSalvar ? undefined : 'Seu perfil não tem permissão para salvar categorias de insumo.'}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {rotuloSalvar}
            </button>
          </>
        }
      />

      {!podeSalvar && (
        <div className="mb-4">
          <Alert tone="amber">
            Seu perfil tem acesso somente de leitura a Categorias de Insumos. Você pode revisar os dados, mas não salvar.
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
          <Layers className="h-4 w-4 text-navy-400" aria-hidden="true" />
          Dados da categoria
        </h2>

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
        />

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-4 dark:border-navy-800">
          <button type="button" className="btn-secondary" onClick={() => navigate(BASE)} disabled={saving}>
            <X className="h-4 w-4" /> Cancelar
          </button>
          <button
            type="submit"
            form={`form-${resource.key}`}
            className="btn-primary"
            disabled={saving || !podeSalvar || salvoComSucesso}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {rotuloSalvar}
          </button>
        </div>
      </section>
    </div>
  );
}
