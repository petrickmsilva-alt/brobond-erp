// ============================================================================
// REGISTRO — página genérica de NOVO / EDITAR para TODOS os recursos do ERP.
//
// Regra de produto do BROBOND ERP (definitiva):
//
//      LISTA  →  NOVO (/recurso/novo)  →  EDIÇÃO (/recurso/:id/editar)
//
// Nenhum cadastro do ERP abre em modal, drawer, sheet ou qualquer superfície
// sobreposta. Este arquivo é o destino único das rotas `/novo` e `/:id/editar`
// dos recursos que não têm formulário dedicado (clientes, produtos, vendas,
// categorias, cores, coleções, tamanhos, grades, insumos, fornecedores e
// representantes continuam em páginas próprias, mais ricas no domínio deles).
//
// O QUE ESTA PÁGINA NÃO FAZ
//   • não inventa campos: o formulário vem do MESMO contrato (`/api/meta`) que
//     o servidor usa para validar (`server/src/resources.ts`);
//   • não decide autorização: os botões refletem `ops` + `minPerfilEscrita`,
//     mas quem autoriza é a API (RBAC do servidor);
//   • não faz validação "paralela": usa `validarFormulario`, a regra
//     compartilhada com as demais páginas de cadastro.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Loader2, Plus, Save, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeta, type Option, type ResourceMeta } from '../lib/meta';
import { Alert, PageHeader, Spinner, useToast } from '../components/ui';
import { ImageField } from '../components/ImageField';
import {
  fieldErrors,
  initialValues,
  normalizarCamposCor,
  RecordForm,
  toPayload,
  useRefOptions,
  validarFormulario,
  type FormValues,
} from '../components/RecordForm';
import { useAuth } from '../auth/AuthContext';
import type { Module } from '../modules';

export type ModoRegistro = 'novo' | 'editar';

export default function RegistroPage({ module, modo }: { module: Module; modo: ModoRegistro }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const meta = useMeta();
  const { user } = useAuth();
  const resource = module.resource ? meta.resources[module.resource] : undefined;
  const editing = modo === 'editar';
  const registroId = Number(id);

  const defaultLocal = meta?.defaultLocal ?? null;
  const basePath = module.path;
  const listPath = basePath;

  const [values, setValues] = useState<FormValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [carregando, setCarregando] = useState(editing);
  const [erroCarregar, setErroCarregar] = useState('');
  const [opcoesKey, setOpcoesKey] = useState(0);
  const [registro, setRegistro] = useState<Record<string, any> | null>(null);
  const [conviteLink, setConviteLink] = useState('');
  const resumoErros = useRef<HTMLDivElement>(null);

  const refOptions = useRefOptions(resource ?? ({ fields: [] } as unknown as ResourceMeta), opcoesKey);

  // RBAC espelhado (a autorização real é do servidor).
  const perfilOkEscrita =
    !resource?.minPerfilEscrita ||
    user?.perfil === 'admin' ||
    (resource.minPerfilEscrita === 'gerente' && user?.perfil === 'gerente');
  const podeGravar = !!resource && perfilOkEscrita && (editing ? resource.ops.update : resource.ops.create);

  // ---- carga do registro (edição) ----
  const carregar = useCallback(async () => {
    if (!editing || !resource) return;
    if (!Number.isInteger(registroId) || registroId <= 0) {
      setErroCarregar('Registro inválido.');
      setCarregando(false);
      return;
    }
    setCarregando(true);
    try {
      const row = await api.get<Record<string, any>>(`/${resource.key}/${registroId}`);
      setRegistro(row);
      setValues(initialValues(resource, row, defaultLocal));
      setErroCarregar('');
    } catch (e) {
      setErroCarregar(e instanceof ApiError ? e.message : 'Não foi possível abrir o registro.');
    } finally {
      setCarregando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, registroId, resource?.key]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // ---- valores iniciais (novo) ----
  useEffect(() => {
    if (editing || !resource) return;
    setValues(initialValues(resource, null, defaultLocal));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, resource?.key]);

  // ---- movimentações: o tamanho deve pertencer à grade do produto ----
  const gradeAware = resource?.key === 'movimentacoes';
  const produtoDoFormulario = gradeAware ? String(values.produto_id ?? '') : '';
  const [tamanhosDaGrade, setTamanhosDaGrade] = useState<Option[] | null>(null);
  const [gradeDoFormulario, setGradeDoFormulario] = useState('');
  useEffect(() => {
    if (!gradeAware || !produtoDoFormulario) {
      setTamanhosDaGrade(null);
      setGradeDoFormulario('');
      return;
    }
    let alive = true;
    api
      .get<{ grade: { id: number; nome: string } | null; tamanhos: { id: number; codigo: string }[] }>(`/produtos/${produtoDoFormulario}/tamanhos`)
      .then((d) => {
        if (!alive) return;
        const lista = (d.tamanhos ?? []).map((t) => ({ value: t.id, label: t.codigo }));
        setTamanhosDaGrade(lista);
        setGradeDoFormulario(d.grade?.nome ?? '');
        if (!lista.length) return;
        const validos = new Set(lista.map((t) => t.value));
        setValues((v) => {
          const atual = Number(String(v.tamanho_id ?? ''));
          if (!atual || validos.has(atual)) return v;
          return { ...v, tamanho_id: '' };
        });
      })
      .catch(() => {
        if (!alive) return;
        setTamanhosDaGrade(null);
        setGradeDoFormulario('');
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gradeAware, produtoDoFormulario]);

  const refOptionsForm = useMemo(
    () => (gradeAware && tamanhosDaGrade && tamanhosDaGrade.length ? { ...refOptions, tamanhos: tamanhosDaGrade } : refOptions),
    [gradeAware, tamanhosDaGrade, refOptions]
  );

  function onChange(name: string, value: string | boolean | string[]) {
    setValues((v) => ({ ...v, [name]: value }));
    setErrors((e) => (e[name] ? { ...e, [name]: '' } : e));
    setFormError('');
  }

  function limpar() {
    setValues(initialValues(resource ?? ({ fields: [] } as unknown as ResourceMeta), null, defaultLocal));
    setErrors({});
    setFormError('');
    setOpcoesKey((k) => k + 1);
  }

  async function salvar() {
    if (!resource) return;
    setFormError('');
    const valores = normalizarCamposCor(resource, values);
    if (valores !== values) setValues(valores);
    const { errors: errs, formError: msg } = validarFormulario(resource, valores, editing);
    setErrors(errs);
    if (msg) {
      setFormError(msg);
      resumoErros.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    setSaving(true);
    try {
      const payload = toPayload(resource, valores, editing);
      if (editing) {
        await api.put(`/${resource.key}/${registroId}`, payload);
        toast.success(`${resource.singular} salvo(a) com sucesso.`);
        navigate(`${listPath}/${registroId}/editar`, { replace: true });
        await carregar();
        return;
      }
      const criado = await api.post<Record<string, any>>(`/${resource.key}`, payload);
      toast.success(`${resource.singular} incluído(a) com sucesso.`);
      // Convite de acesso sem SMTP: o link volta na resposta e é exibido AQUI,
      // na própria página (nunca em modal).
      if (criado?.convite_link) {
        setConviteLink(String(criado.convite_link));
        return;
      }
      if (criado?.id && (resource.images || resource.detail)) {
        // Registro com fotos ou com detalhe próprio: segue para a página do
        // registro recém-criado (onde se anexam fotos / itens).
        navigate(`/${resource.key}/${criado.id}`);
        return;
      }
      if (criado?.id) {
        navigate(`${listPath}/${criado.id}/editar`, { replace: true });
        return;
      }
      navigate(listPath);
    } catch (e) {
      setErrors(fieldErrors(e));
      setFormError(e instanceof ApiError ? e.message : 'Não foi possível salvar. Tente novamente.');
      resumoErros.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } finally {
      setSaving(false);
    }
  }

  if (!resource) return <Spinner label="Carregando recurso..." />;

  // Título no vocabulário do cadastro (sem inventar gênero gramatical a partir
  // do singular): "Novo cadastro: Origem" / "Editar Origem".
  const titulo = editing ? `Editar ${resource.singular}` : `Novo cadastro: ${resource.singular}`;

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={titulo}
        description={
          editing
            ? `Registro #${registroId} — ${module.label}`
            : `Cadastro de ${resource.singular.toLowerCase()} em página própria. Os campos com * são obrigatórios.`
        }
        actions={
          <>
            <Link className="btn-secondary" to={listPath}>
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Voltar à lista</span>
            </Link>
            {podeGravar && (
              <button className="btn-accent" onClick={() => void salvar()} disabled={saving || carregando}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : editing ? <Save className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                {editing ? 'Salvar alterações' : `Incluir ${resource.singular}`}
              </button>
            )}
          </>
        }
      />

      {!podeGravar && (
        <div className="mb-4">
          <Alert tone="amber">
            Seu perfil não tem permissão de {editing ? 'edição' : 'cadastro'} neste módulo. A tela é somente leitura e a API recusaria o mesmo envio.
          </Alert>
        </div>
      )}

      {erroCarregar && (
        <div className="mb-4">
          <Alert tone="red">{erroCarregar}</Alert>
        </div>
      )}

      {carregando ? (
        <Spinner label="Carregando registro..." />
      ) : (
        <div className="mx-auto max-w-4xl">
          <div ref={resumoErros} />
          {formError && (
            <div className="mb-4">
              <Alert tone="red">{formError}</Alert>
            </div>
          )}

          {conviteLink && (
            // Convite de acesso recém-criado (sem SMTP configurado): exibido na
            // própria página, para copiar e entregar ao usuário. Uma única vez.
            <div className="mb-4 space-y-3 rounded-xl border border-navy-200 bg-navy-50 p-4">
              <Alert tone="blue">
                Usuário criado. Este ambiente não tem SMTP configurado — entregue o link abaixo ao usuário. Ele vale por <strong>48 horas</strong> e só pode ser usado uma vez.
              </Alert>
              <div className="flex flex-wrap gap-2">
                <input className="input flex-1 font-mono text-xs" readOnly value={conviteLink} onFocus={(e) => e.currentTarget.select()} />
                <button
                  className="btn-secondary"
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(conviteLink);
                    toast.success('Link do convite copiado.');
                  }}
                >
                  Copiar
                </button>
                <Link className="btn-primary" to={listPath}>
                  Concluído
                </Link>
              </div>
            </div>
          )}

          {gradeAware && produtoDoFormulario && (
            <p className="mb-3 rounded-md bg-navy-50 px-3 py-2 text-xs text-navy-700">
              {gradeDoFormulario ? (
                <>
                  Grade do produto: <strong className="font-semibold">{gradeDoFormulario}</strong>. O campo Tamanho lista apenas estes tamanhos.
                </>
              ) : (
                <>Este produto ainda não tem grade definida — a lista mostra todos os tamanhos cadastrados.</>
              )}
            </p>
          )}

          {resource.images && editing && registro && (
            <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
              <span className="label">Fotos</span>
              <ImageField key={registro.id} resource={resource} recordId={Number(registro.id)} initial={registro.fotos} canEdit={podeGravar} onChange={() => void carregar()} />
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
            <RecordForm
              resource={resource}
              values={values}
              errors={errors}
              onChange={onChange}
              onSubmit={() => void salvar()}
              onClear={limpar}
              editing={editing}
              busy={saving || !podeGravar}
              refOptions={refOptionsForm}
              autoFocus={false}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <Link className="btn-secondary" to={listPath}>
              <X className="h-4 w-4" /> Cancelar
            </Link>
            {registro && (
              <span className="text-xs text-slate-400">
                <AlertTriangle className="mr-1 inline h-3 w-3" />
                As alterações ficam registradas na auditoria do ERP (quem, quando, antes e depois).
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
