// ============================================================================
// CADASTRO DE CATEGORIAS — página própria, no lugar do modal genérico.
//
// Fluxo: /categorias (lista) → /categorias/novo → /categorias/:id/editar.
//
// O formulário NÃO inventa campos nem endpoints: usa o contrato existente do
// recurso `categorias` (nome, descricao, grade_id, ativo) em GET/POST/PUT
// /api/categorias. O servidor revalida tudo (validatePayload + RBAC gerente+);
// o front só evita a ida e volta com validação local e mensagens por campo.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Layers, Loader2, Save, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeta, type Option } from '../lib/meta';
import { Alert, PageHeader, Spinner, useToast } from '../components/ui';
import { Switch } from '../components/ui-kit';
import { useAuth } from '../auth/AuthContext';

type Valores = { nome: string; descricao: string; grade_id: string; ativo: string };

const VALORES_INICIAIS: Valores = { nome: '', descricao: '', grade_id: '', ativo: 'true' };

/** Linha da API → valores do formulário. */
function valoresDaLinha(row: Record<string, any>): Valores {
  return {
    nome: String(row.nome ?? ''),
    descricao: String(row.descricao ?? ''),
    grade_id: row.grade_id === null || row.grade_id === undefined || row.grade_id === '' ? '' : String(row.grade_id),
    ativo: row.ativo === false ? 'false' : 'true',
  };
}

export default function CategoriaFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const toast = useToast();
  const meta = useMeta();
  const { user } = useAuth();
  const resource = meta.resources['categorias'];

  // Espelha o RBAC do servidor (SEC-04: catálogo compartilhado, escrita gerente+)
  // para não exibir um botão que receberia 403. A autorização real é a API.
  const perfilOkEscrita = !resource?.minPerfilEscrita
    || user?.perfil === 'admin'
    || (resource.minPerfilEscrita === 'gerente' && user?.perfil === 'gerente');
  const podeSalvar = perfilOkEscrita && !!resource && (editing ? resource.ops.update : resource.ops.create);

  const [values, setValues] = useState<Valores>(VALORES_INICIAIS);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [carregando, setCarregando] = useState(editing);
  const [erroCarregar, setErroCarregar] = useState('');
  const [salvoComSucesso, setSalvoComSucesso] = useState(false);
  const [registro, setRegistro] = useState<Record<string, any> | null>(null);
  const [grades, setGrades] = useState<Option[] | null>(null);
  const errorSummaryRef = useRef<HTMLDivElement>(null);

  // ---- grades existentes (campo `grade_id`, ref `grades`) ----
  useEffect(() => {
    let alive = true;
    api
      .get<Option[]>('/grades/options')
      .then((o) => alive && setGrades(o))
      .catch(() => alive && setGrades([]));
    return () => {
      alive = false;
    };
  }, []);

  // ---- carga do registro (edição) ----
  const carregar = useCallback(async () => {
    if (!editing || !id) return;
    setCarregando(true);
    try {
      const row = await api.get<Record<string, any>>(`/categorias/${id}`);
      setRegistro(row);
      setValues(valoresDaLinha(row));
      setErroCarregar('');
    } catch (e) {
      setErroCarregar(e instanceof ApiError ? e.message : 'Não foi possível abrir a categoria.');
    } finally {
      setCarregando(false);
    }
  }, [editing, id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const setCampo = useCallback((nome: keyof Valores, valor: string) => {
    setValues((v) => ({ ...v, [nome]: valor }));
    setErrors((e) => (e[nome] ? { ...e, [nome]: '' } : e));
    setFormError('');
  }, []);

  /** Validação local espelhando o servidor — erro junto do campo, na hora. */
  function validar(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!values.nome.trim()) errs.nome = 'Informe o nome da categoria.';
    else if (resource?.fields.find((f) => f.name === 'nome')?.maxLength && values.nome.trim().length > (resource.fields.find((f) => f.name === 'nome')!.maxLength as number)) {
      errs.nome = `Máximo de ${resource.fields.find((f) => f.name === 'nome')!.maxLength} caracteres.`;
    }
    const maxDesc = resource?.fields.find((f) => f.name === 'descricao')?.maxLength;
    if (maxDesc && values.descricao.trim().length > maxDesc) errs.descricao = `Máximo de ${maxDesc} caracteres.`;
    return errs;
  }

  /** Payload no contrato do recurso: nome/descricao texto, grade_id inteiro, ativo booleano. */
  function montarPayload(): Record<string, unknown> {
    const grade = values.grade_id.trim();
    return {
      nome: values.nome.trim(),
      descricao: values.descricao.trim() === '' ? null : values.descricao.trim(),
      grade_id: grade === '' ? null : Number(grade),
      ativo: values.ativo === 'true',
    };
  }

  async function salvar() {
    if (saving || salvoComSucesso) return;
    setFormError('');
    const errs = validar();
    setErrors(errs);
    if (Object.keys(errs).length) {
      setFormError('Verifique os campos destacados — nada foi salvo e o que você digitou foi mantido.');
      requestAnimationFrame(() => {
        errorSummaryRef.current?.focus();
        document.getElementById(`cat-${Object.keys(errs)[0]}`)?.focus();
      });
      return;
    }
    setSaving(true);
    try {
      const payload = montarPayload();
      if (editing && id) {
        const salvo = await api.put<Record<string, any>>(`/categorias/${id}`, payload);
        setRegistro(salvo);
        setSalvoComSucesso(true);
        toast.success('Categoria salva com sucesso.');
      } else {
        await api.post<Record<string, any>>('/categorias', payload);
        toast.success('Categoria cadastrada com sucesso.');
      }
      navigate('/categorias');
    } catch (e) {
      const fe = e instanceof ApiError && e.fields ? e.fields : {};
      setErrors(fe);
      setFormError(e instanceof ApiError ? e.message : 'Não foi possível salvar. Tente novamente.');
      requestAnimationFrame(() => errorSummaryRef.current?.focus());
    } finally {
      setSaving(false);
    }
  }

  const titulo = editing ? 'Editar categoria' : 'Nova categoria';
  const nomeAtual = editing ? String(registro?.nome ?? values.nome ?? '').trim() : '';
  const descricao = editing
    ? nomeAtual
      ? `Alterando a categoria “${nomeAtual}”. Os campos com * são obrigatórios.`
      : 'Atualize os dados da categoria. Os campos com * são obrigatórios.'
    : 'Preencha os dados da categoria. Os campos com * são obrigatórios.';
  const maxNome = resource?.fields.find((f) => f.name === 'nome')?.maxLength ?? 60;
  const maxDescricao = resource?.fields.find((f) => f.name === 'descricao')?.maxLength ?? 160;
  const placeholderNome = resource?.fields.find((f) => f.name === 'nome')?.placeholder;
  const dicaGrade = 'A grade será usada como padrão para novos produtos desta categoria e poderá ser sobrescrita no produto.';

  const erroNomeId = errors.nome ? 'cat-nome-erro' : undefined;
  const erroDescricaoId = errors.descricao ? 'cat-descricao-erro' : undefined;

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
        <Link to="/categorias" className="btn-secondary mt-4 inline-flex">
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
            <Link to="/categorias" className="btn-secondary inline-flex">
              <ArrowLeft className="h-4 w-4" /> <span className="hidden sm:inline">Voltar</span>
            </Link>
            <button type="button" className="btn-secondary inline-flex" onClick={() => navigate('/categorias')} disabled={saving}>
              <X className="h-4 w-4" /> <span className="hidden sm:inline">Cancelar</span>
            </button>
            <button
              type="submit"
              form="form-categoria"
              className="btn-primary inline-flex"
              disabled={saving || !podeSalvar || salvoComSucesso}
              title={podeSalvar ? undefined : 'Seu perfil não tem permissão para salvar categorias.'}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {editing ? 'Salvar alterações' : 'Salvar categoria'}
            </button>
          </>
        }
      />

      {!podeSalvar && (
        <div className="mb-4">
          <Alert tone="amber">
            Seu perfil tem acesso somente de leitura a Categorias. Você pode revisar os dados, mas não salvar.
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
        id="form-categoria"
        className="space-y-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void salvar();
        }}
      >
        <section className="card p-4 sm:p-5">
          <h2 className="mb-4 flex items-center gap-2 border-b border-slate-100 pb-3 text-sm font-bold uppercase tracking-wide text-navy-800">
            <Layers className="h-4 w-4 text-navy-400" aria-hidden="true" />
            Dados da categoria
          </h2>

          <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
            {/* ---- Nome (obrigatório) ---- */}
            <div className="sm:col-span-2">
              <label htmlFor="cat-nome" className="label">
                Nome
                <span className="ml-0.5 text-red-500" aria-hidden="true">
                  *
                </span>
                <span className="sr-only"> (obrigatório)</span>
              </label>
              <input
                id="cat-nome"
                type="text"
                className={`input ${errors.nome ? 'input-error' : ''}`}
                value={values.nome}
                onChange={(e) => setCampo('nome', e.target.value)}
                maxLength={maxNome}
                placeholder={placeholderNome}
                autoComplete="off"
                autoFocus
                disabled={!podeSalvar}
                aria-invalid={errors.nome ? true : undefined}
                aria-describedby={erroNomeId}
                required
              />
              {errors.nome ? (
                <p id={erroNomeId} className="mt-1 text-xs font-medium text-red-600" role="alert">
                  {errors.nome}
                </p>
              ) : (
                <p className="mt-1 text-xs text-slate-400">Ex.: Camisa, Camiseta, Calça, Bermuda...</p>
              )}
            </div>

            {/* ---- Descrição (opcional) ---- */}
            <div className="sm:col-span-2">
              <label htmlFor="cat-descricao" className="label">
                Descrição
              </label>
              <input
                id="cat-descricao"
                type="text"
                className={`input ${errors.descricao ? 'input-error' : ''}`}
                value={values.descricao}
                onChange={(e) => setCampo('descricao', e.target.value)}
                maxLength={maxDescricao}
                placeholder="Camisas sociais e casuais"
                autoComplete="off"
                disabled={!podeSalvar}
                aria-invalid={errors.descricao ? true : undefined}
                aria-describedby={erroDescricaoId ?? 'cat-descricao-dica'}
              />
              {errors.descricao ? (
                <p id={erroDescricaoId} className="mt-1 text-xs font-medium text-red-600" role="alert">
                  {errors.descricao}
                </p>
              ) : (
                <p id="cat-descricao-dica" className="mt-1 text-xs text-slate-400">
                  Opcional. Ajuda a identificar a categoria nas listas e na busca.
                </p>
              )}
            </div>

            {/* ---- Grade padrão ---- */}
            <div>
              <label htmlFor="cat-grade" className="label">
                Grade padrão
              </label>
              <select
                id="cat-grade"
                className="input"
                value={values.grade_id}
                onChange={(e) => setCampo('grade_id', e.target.value)}
                disabled={!podeSalvar || grades === null}
                aria-describedby="cat-grade-dica"
              >
                <option value="">
                  {grades === null ? 'Carregando...' : grades.length === 0 ? 'Nenhuma grade cadastrada' : '— Nenhuma —'}
                </option>
                {(grades ?? []).map((o) => (
                  <option key={o.value} value={String(o.value)}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p id="cat-grade-dica" className="mt-1 text-xs text-slate-400">
                {dicaGrade}
              </p>
            </div>

            {/* ---- Ativo ---- */}
            <div className="flex h-full flex-col justify-end">
              <Switch
                id="cat-ativo"
                checked={values.ativo === 'true'}
                onChange={(v) => setCampo('ativo', v ? 'true' : 'false')}
                disabled={!podeSalvar}
                label="Ativo"
                description="Categorias inativas não aparecem nos seletores de novos produtos."
              />
            </div>
          </div>
        </section>

        {/* Rodapé de ações — repete os botões para telas longas/mobile */}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-4">
          <button type="button" className="btn-secondary" onClick={() => navigate('/categorias')} disabled={saving}>
            <X className="h-4 w-4" /> Cancelar
          </button>
          <button type="submit" form="form-categoria" className="btn-primary" disabled={saving || !podeSalvar || salvoComSucesso}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {editing ? 'Salvar alterações' : 'Salvar categoria'}
          </button>
        </div>
      </form>
    </div>
  );
}
