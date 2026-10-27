// ============================================================================
// FUNDAÇÃO COMERCIAL — PÁGINA de cadastro/edição (LISTA → PÁGINA).
//
//   /<recurso>/novo         → "Novo <singular>"
//   /<recurso>/:id/editar   → "Editar <singular>"
//
// Nada é sobreposto à lista: rota normal, `PageHeader` padrão, ações Voltar /
// Cancelar / Salvar. O formulário é o `RecordForm` do ERP, dirigido pelos
// metadados — nenhum design system novo e nenhuma validação paralela: as
// regras do cliente (`validarFormulario`) são as MESMAS do CRUD, e a
// autoridade continua no servidor (`validatePayload` + regras de domínio em
// server/src/comercial.ts).
//
// Anti duplo-envio: `saving` desabilita o botão e ignora o segundo submit.
// Erros de campo voltam do servidor (400 `fields`) e são exibidos no campo.
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Save, X } from 'lucide-react';
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

/** Metadado de emergência apenas para manter a ordem dos hooks estável. */
const INDISPONIVEL: ResourceMeta = {
  key: 'indisponivel',
  label: 'Cadastro',
  singular: 'Registro',
  labelFields: ['id'],
  fields: [],
  ops: { create: false, update: false, delete: false },
};

export default function CadastroComercialFormPage({ recurso }: { recurso: string }) {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const toast = useToast();
  const meta = useMeta();
  const { user } = useAuth();
  const resource = meta.resources[recurso];
  const defaultLocal = meta.defaultLocal ?? null;

  const perfilOkEscrita = !resource?.minPerfilEscrita
    || user?.perfil === 'admin'
    || (resource.minPerfilEscrita === 'gerente' && user?.perfil === 'gerente');
  const podeSalvar = perfilOkEscrita && !!resource && (editing ? resource.ops.update : resource.ops.create);

  const [values, setValues] = useState<FormValues>(() => (resource ? initialValues(resource, null, defaultLocal) : {}));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [carregando, setCarregando] = useState(editing);
  const [erroCarregar, setErroCarregar] = useState('');
  const salvandoRef = useRef(false);

  const refOptions = useRefOptions(resource ?? INDISPONIVEL);

  // Carrega o registro a editar (uma leitura, empresa validada no servidor).
  useEffect(() => {
    if (!editing || !resource) return;
    let cancelado = false;
    setCarregando(true);
    api
      .get<Record<string, any>>(`/${recurso}/${id}`)
      .then((row) => {
        if (cancelado) return;
        setValues(initialValues(resource, row, defaultLocal));
        setErroCarregar('');
      })
      .catch((e) => {
        if (cancelado) return;
        setErroCarregar(e instanceof ApiError ? e.message : 'Não foi possível carregar o registro.');
      })
      .finally(() => {
        if (!cancelado) setCarregando(false);
      });
    return () => {
      cancelado = true;
    };
  }, [editing, id, recurso, resource, defaultLocal]);

  const onChange = useCallback((name: string, value: string | boolean | string[]) => {
    setValues((atual) => ({ ...atual, [name]: value }));
    setErrors((atual) => {
      if (!atual[name]) return atual;
      const { [name]: _removido, ...resto } = atual;
      return resto;
    });
  }, []);

  async function salvar() {
    if (!resource || !podeSalvar) return;
    if (salvandoRef.current) return; // anti duplo-envio
    const { errors: erros, formError: erroForm } = validarFormulario(resource, values, editing);
    setErrors(erros);
    setFormError(erroForm);
    if (erroForm || Object.keys(erros).length) return;

    salvandoRef.current = true;
    setSaving(true);
    try {
      const payload = toPayload(resource, values, editing);
      if (editing) await api.put(`/${recurso}/${id}`, payload);
      else await api.post(`/${recurso}`, payload);
      toast.success(editing ? `${resource.singular} atualizado(a).` : `${resource.singular} incluído(a).`);
      navigate(`/${recurso}`);
    } catch (e) {
      const err = e as ApiError;
      const campos = fieldErrors(err);
      setErrors(campos);
      setFormError(campos && Object.keys(campos).length ? '' : err.message || 'Não foi possível salvar.');
    } finally {
      salvandoRef.current = false;
      setSaving(false);
    }
  }

  if (!resource) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title="Cadastro indisponível" description="Este recurso não está disponível para o seu perfil." />
      </div>
    );
  }

  if (carregando) return <Spinner label={`Carregando ${resource.singular.toLowerCase()}...`} />;

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={editing ? rotuloEditar(recurso, resource.singular) : rotuloNovo(recurso, resource.singular)}
        description={descricaoDoCadastro(recurso) ?? resource.notice}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-secondary inline-flex" onClick={() => navigate(`/${recurso}`)}>
              <ArrowLeft className="h-4 w-4" /> Voltar
            </button>
            <button type="button" className="btn-secondary inline-flex" onClick={() => navigate(`/${recurso}`)} disabled={saving}>
              <X className="h-4 w-4" /> Cancelar
            </button>
            <button type="button" className="btn-accent inline-flex" onClick={() => void salvar()} disabled={!podeSalvar || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {rotuloSalvar(recurso)}
            </button>
          </div>
        }
      />

      {erroCarregar && (
        <div className="mb-4">
          <Alert tone="red">{erroCarregar}</Alert>
        </div>
      )}

      {!podeSalvar && (
        <div className="mb-4">
          <Alert tone="amber">
            Seu perfil não tem permissão para {editing ? 'alterar' : 'incluir'} neste cadastro. O servidor recusaria a gravação.
          </Alert>
        </div>
      )}

      {resource.notice && (
        <div className="mb-4">
          <Alert tone="blue">{resource.notice}</Alert>
        </div>
      )}

      <div className="card p-4 sm:p-6">
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
          busy={saving}
          refOptions={refOptions}
          hideActions
        />
        {formError && (
          <div className="mt-4">
            <Alert tone="red">{formError}</Alert>
          </div>
        )}
      </div>
    </div>
  );
}
