// ============================================================================
// CADASTRO DE COLEÇÕES — PÁGINA do ERP (lista → página), sem drawer e sem modal.
//
// Fluxo canônico do BROBOND ERP (o MESMO de Cores, Categorias, Produtos):
//
//   /colecoes              → lista (tela principal, inalterada)
//   /colecoes/novo         → página "Nova coleção"
//   /colecoes/:id/editar   → página "Editar coleção"
//
// Nada é sobreposto à lista: a inclusão/edição é uma rota normal, com o
// breadcrumb do shell (BROBOND ERP › Cadastros › Coleções › Novo/Editar), o
// `PageHeader` padrão e as ações Voltar / Cancelar / Salvar coleção.
//
// Reutiliza os componentes JÁ existentes do ERP — nenhum design system novo:
//   • `PageHeader`, `Alert`, `Spinner`, `useToast`  (components/ui)
//   • `RecordForm` dirigido pelos metadados de GET /api/meta
//   • `validarFormulario` / `toPayload` (mesmas regras do CRUD genérico — um
//     campo nunca tem duas validações no ERP)
//   • `lib/lista` (rótulos/descrição do cadastro, sem texto duplicado)
//
// O contrato da API é o MESMO: POST/PUT /api/colecoes com
// { nome, temporada, ano, ativo }. O RBAC também: `colecoes` é cadastro POR
// EMPRESA (sem `minPerfilEscrita`) e o servidor (checkAccess + validatePayload)
// continua sendo a autoridade — a UI só reflete o que a API autoriza.
// ============================================================================
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
import { descricaoDoCadastro, rotuloEditar, rotuloNovo, rotuloSalvar } from '../lib/lista';
import { useAuth } from '../auth/AuthContext';

/**
 * Metadado de emergência: só existe para manter a ordem dos hooks estável
 * quando o recurso ainda não está no /api/meta (a tela avisa e não salva).
 */
const RECURSO_INDISPONIVEL: ResourceMeta = {
  key: 'colecoes',
  label: 'Coleções',
  singular: 'Coleção',
  labelFields: ['nome'],
  fields: [],
  ops: { create: false, update: false, delete: false },
};

export default function ColecaoFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const toast = useToast();
  const meta = useMeta();
  const { user } = useAuth();
  const resource = meta.resources['colecoes'];
  const defaultLocal = meta.defaultLocal ?? null;

  // RBAC espelhado do servidor. `colecoes` é cadastro POR EMPRESA: não declara
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
  // O recurso não tem campos de referência hoje; o hook mantém a página correta
  // caso um `ref` seja declarado no metadado no futuro (nenhuma chamada extra
  // acontece quando não há refs).
  const refOptions = useRefOptions(resource ?? RECURSO_INDISPONIVEL);

  // ---- carga do registro (edição) ----
  const carregar = useCallback(async () => {
    if (!editing || !id || !resource) return;
    setCarregando(true);
    try {
      const row = await api.get<Record<string, any>>(`/colecoes/${id}`);
      setRegistro(row);
      setValues(initialValues(resource, row, defaultLocal));
      setErroCarregar('');
    } catch (e) {
      setErroCarregar(e instanceof ApiError ? e.message : 'Não foi possível abrir a coleção.');
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

  /** Salva no MESMO contrato do CRUD genérico (POST/PUT /colecoes). */
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
        await api.put<Record<string, any>>(`/colecoes/${id}`, payload);
        toast.success('Coleção salva com sucesso.');
      } else {
        await api.post<Record<string, any>>('/colecoes', payload);
        toast.success('Coleção cadastrada com sucesso.');
      }
      setSalvoComSucesso(true);
      // Salvar devolve a pessoa à lista (tela principal), como no restante do ERP.
      navigate('/colecoes');
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
        <PageHeader title="Coleções" description="Cadastro de coleções do catálogo." />
        <Alert tone="red">O cadastro de Coleções não está disponível neste ambiente.</Alert>
        <Link to="/colecoes" className="btn-secondary mt-4 inline-flex">
          <ArrowLeft className="h-4 w-4" /> Voltar para a lista
        </Link>
      </div>
    );
  }

  const titulo = editing ? rotuloEditar(resource.key, resource.singular) : rotuloNovo(resource.key, resource.singular);
  const nomeAtual = editing ? String(registro?.nome ?? values.nome ?? '').trim() : '';
  const descricao = editing
    ? nomeAtual
      ? `Alterando a coleção “${nomeAtual}”. Os campos com * são obrigatórios.`
      : 'Atualize os dados da coleção. Os campos com * são obrigatórios.'
    : descricaoDoCadastro(resource.key) ?? 'Preencha os dados da coleção. Os campos com * são obrigatórios.';
  const rotuloSalvarColecao = rotuloSalvar(resource.key);

  if (carregando) {
    return (
      <div className="p-4 sm:p-6">
        <Spinner label="Carregando coleção..." />
      </div>
    );
  }

  if (erroCarregar) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title={titulo} description="Não foi possível abrir o cadastro." />
        <Alert tone="red">{erroCarregar}</Alert>
        <Link to="/colecoes" className="btn-secondary mt-4 inline-flex">
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
            {/* No celular o rótulo some e sobra o ícone: o aria-label mantém o
                nome acessível nos dois tamanhos de tela. */}
            <Link to="/colecoes" className="btn-secondary inline-flex" aria-label="Voltar para a lista de coleções">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> <span className="hidden sm:inline">Voltar</span>
            </Link>
            <button
              type="button"
              className="btn-secondary inline-flex"
              onClick={() => navigate('/colecoes')}
              disabled={saving}
              aria-label="Cancelar e voltar para a lista de coleções"
            >
              <X className="h-4 w-4" aria-hidden="true" /> <span className="hidden sm:inline">Cancelar</span>
            </button>
            <button
              type="submit"
              form={`form-${resource.key}`}
              className="btn-primary inline-flex"
              disabled={saving || !podeSalvar || salvoComSucesso}
              title={podeSalvar ? undefined : 'Seu perfil não tem permissão para salvar coleções.'}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {rotuloSalvarColecao}
            </button>
          </>
        }
      />

      {!podeSalvar && (
        <div className="mb-4">
          <Alert tone="amber">
            Seu perfil tem acesso somente de leitura a Coleções. Você pode revisar os dados, mas não salvar.
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
          Informações da coleção
        </h2>

        {/* O formulário é o MESMO componente dirigido por metadados: campos,
            obrigatoriedade e validações vêm de GET /api/meta. `hideActions`
            evita uma segunda barra de botões — a da página é a única. */}
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

        {/* Rodapé de ações da página — mesma dupla de botões do cabeçalho,
            para telas longas e mobile. Submete o formulário pelo atributo
            `form`, sem duplicar a barra de ações dentro do form. */}
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-4 dark:border-navy-800">
          <button type="button" className="btn-secondary" onClick={() => navigate('/colecoes')} disabled={saving}>
            <X className="h-4 w-4" /> Cancelar
          </button>
          <button
            type="submit"
            form={`form-${resource.key}`}
            className="btn-primary"
            disabled={saving || !podeSalvar || salvoComSucesso}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {rotuloSalvarColecao}
          </button>
        </div>
      </section>
    </div>
  );
}
