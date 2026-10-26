// ============================================================================
// CADASTRO DE GRADES — PÁGINA do ERP (lista → página), sem modal, drawer ou overlay.
//
// Fluxo canônico do BROBOND ERP (o mesmo de Cadastros › Cores):
//
//   /grades                 → lista (tela principal, inalterada)
//   /grades/novo            → página "Nova grade"
//   /grades/:id/editar      → página "Editar grade"
//
// Grade é uma entidade ESTRUTURAL do catálogo: além de nome/descrição/status e
// das orientações de medição, ela tem uma relação muitos-para-muitos ORDENADA
// com os tamanhos (`grade_tamanhos.ordem`). Por isso a página tem seções — mas
// nenhum campo novo: tudo aqui são os campos reais do recurso `grades`
// (nome, descricao, instrucoes_medidas, ativo, tamanhos).
//
// Contrato INTACTO: POST/PUT /api/grades com
//   { nome, descricao, instrucoes_medidas, ativo, tamanhos: number[] }
// onde `tamanhos` é a lista de ids NA ORDEM desejada (ordem = posição, gravada
// pelo servidor em `grade_tamanhos.ordem`). RBAC também intacto: o espelho de
// `minPerfilEscrita` só esconde/desabilita botões — quem autoriza é a API.
//
// Reutiliza os componentes JÁ existentes do ERP (nenhum design system novo):
//   • `PageHeader`, `Alert`, `Badge`, `Spinner`, `useToast` (components/ui)
//   • `Switch` (components/ui-kit) — o mesmo status Ativo/Inativo de Categorias
//   • `initialValues` / `toPayload` / `validarFormulario` (RecordForm): as
//     MESMAS regras de validação do CRUD genérico — um campo nunca tem duas
//     validações no ERP
//   • `lib/lista` (rótulos/descrição do cadastro, sem texto duplicado)
//
// ORDENAÇÃO DOS TAMANHOS — por controles ↑ ↓ (e não drag-and-drop): o ERP não
// tem biblioteca de DnD e arrastar não é operável por teclado/leitor de tela.
// Os botões são acessíveis, têm nome explícito ("Mover P para cima") e valem
// tanto no mouse quanto no teclado; a ordem resultante é exatamente a mesma.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Grid3x3,
  Loader2,
  Ruler,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeta, type Option, type ResourceMeta } from '../lib/meta';
import { Alert, Badge, PageHeader, Spinner, useToast } from '../components/ui';
import { Switch } from '../components/ui-kit';
import {
  fieldErrors,
  initialValues,
  toPayload,
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
  key: 'grades',
  label: 'Grades',
  singular: 'Grade',
  labelFields: ['nome'],
  fields: [],
  ops: { create: false, update: false, delete: false },
};

/** Texto de um tamanho: o código do dicionário, ou o id quando ele não veio. */
function rotuloTamanho(opcoes: Option[] | null, id: string): string {
  if (!opcoes) return '...';
  const achado = opcoes.find((o) => String(o.value) === id);
  return achado ? String(achado.label) : `#${id}`;
}

/** "4 tamanhos selecionados" (com o singular correto). */
export function textoQuantidadeTamanhos(total: number): string {
  return `${total} ${total === 1 ? 'tamanho selecionado' : 'tamanhos selecionados'}`;
}

/** Total da prévia ("4 tamanhos"): o resumo do que a grade terá. */
export function textoTotalTamanhos(total: number): string {
  if (total === 0) return 'Nenhum tamanho';
  return `${total} ${total === 1 ? 'tamanho' : 'tamanhos'}`;
}

export default function GradeFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const toast = useToast();
  const meta = useMeta();
  const { user } = useAuth();
  const resource = meta.resources['grades'] ?? RECURSO_INDISPONIVEL;
  const defaultLocal = meta.defaultLocal ?? null;
  const disponivel = Boolean(meta.resources['grades']);

  // RBAC espelhado do servidor (SEC-04: catálogo compartilhado, escrita
  // gerente+). Só controla o que aparece/habilita: a autorização real é da API.
  const perfilOkEscrita =
    !resource.minPerfilEscrita ||
    user?.perfil === 'admin' ||
    (resource.minPerfilEscrita === 'gerente' && user?.perfil === 'gerente');
  const podeSalvar = perfilOkEscrita && disponivel && (editing ? resource.ops.update : resource.ops.create);

  const [values, setValues] = useState<FormValues>(() => initialValues(resource, null, defaultLocal));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [carregando, setCarregando] = useState(editing);
  const [erroCarregar, setErroCarregar] = useState('');
  const [registro, setRegistro] = useState<Record<string, any> | null>(null);
  const errorSummaryRef = useRef<HTMLDivElement>(null);

  // Dicionário de tamanhos (Cadastros › Tamanhos): as opções disponíveis para
  // compor a grade, já na ordem do próprio dicionário.
  const [opcoesTamanhos, setOpcoesTamanhos] = useState<Option[] | null>(null);
  const [erroTamanhos, setErroTamanhos] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .get<Option[]>('/tamanhos/options')
      .then((o) => {
        if (!alive) return;
        setOpcoesTamanhos(Array.isArray(o) ? o : []);
        setErroTamanhos('');
      })
      .catch((e) => {
        if (!alive) return;
        setOpcoesTamanhos([]);
        setErroTamanhos(e instanceof ApiError ? e.message : 'Não foi possível carregar os tamanhos cadastrados.');
      });
    return () => {
      alive = false;
    };
  }, []);

  // ---- carga do registro (edição) ----
  const carregar = useCallback(async () => {
    if (!editing || !id || !disponivel) return;
    setCarregando(true);
    try {
      const row = await api.get<Record<string, any>>(`/grades/${id}`);
      setRegistro(row);
      // `initialValues` lê `row.tamanhos` (ids na ordem gravada em
      // grade_tamanhos.ordem) — a ordem existente é preservada exatamente.
      setValues(initialValues(resource, row, defaultLocal));
      setErroCarregar('');
    } catch (e) {
      setErroCarregar(e instanceof ApiError ? e.message : 'Não foi possível abrir a grade.');
    } finally {
      setCarregando(false);
    }
  }, [editing, id, disponivel, resource, defaultLocal]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  function onChange(name: string, value: string | boolean | string[]) {
    setValues((v) => ({ ...v, [name]: value }));
    if (errors[name]) setErrors((e) => ({ ...e, [name]: '' }));
    setFormError('');
  }

  // --------------------------------------------------------------------------
  // TAMANHOS DA GRADE — seleção individual + ORDEM explícita
  // --------------------------------------------------------------------------
  const selecionados = useMemo(
    () => (Array.isArray(values.tamanhos) ? values.tamanhos.map(String) : []),
    [values.tamanhos]
  );

  /** Inclui um tamanho no FIM da ordem (ou remove, se já estava na grade). */
  function alternarTamanho(idTamanho: string) {
    if (!podeSalvar) return;
    // Nunca duplica: a inclusão só acontece quando o id não está na lista.
    const proximo = selecionados.includes(idTamanho)
      ? selecionados.filter((x) => x !== idTamanho)
      : [...selecionados, idTamanho];
    onChange('tamanhos', proximo);
  }

  function removerTamanho(idTamanho: string) {
    if (!podeSalvar) return;
    onChange(
      'tamanhos',
      selecionados.filter((x) => x !== idTamanho)
    );
  }

  /** Move o tamanho uma posição (a ordem É o domínio: grade_tamanhos.ordem). */
  function moverTamanho(idTamanho: string, direcao: -1 | 1) {
    if (!podeSalvar) return;
    const de = selecionados.indexOf(idTamanho);
    const para = de + direcao;
    if (de < 0 || para < 0 || para >= selecionados.length) return;
    const proximo = selecionados.slice();
    [proximo[de], proximo[para]] = [proximo[para], proximo[de]];
    onChange('tamanhos', proximo);
  }

  /** Salva no MESMO contrato do CRUD genérico (POST/PUT /grades). */
  async function salvar() {
    if (saving || !disponivel) return;
    setFormError('');

    const { errors: errs, formError: msg } = validarFormulario(resource, values, editing);
    setErrors(errs);
    if (msg) {
      // O resumo continua genérico (é o mesmo do CRUD do ERP); a frase específica
      // fica na seção "Tamanhos da grade", ao lado dos chips.
      setFormError(msg);
      requestAnimationFrame(() => {
        errorSummaryRef.current?.focus();
        const primeiro = Object.keys(errs)[0];
        if (primeiro === 'tamanhos') document.getElementById('grade-primeiro-tamanho')?.focus();
        else document.getElementById(`f-${primeiro}`)?.focus();
      });
      return;
    }

    setSaving(true);
    try {
      const payload = toPayload(resource, values, editing);
      if (editing && id) {
        const salvo = await api.put<Record<string, any>>(`/grades/${id}`, payload);
        setRegistro(salvo);
        toast.success('Grade salva com sucesso.');
      } else {
        await api.post<Record<string, any>>('/grades', payload);
        toast.success('Grade cadastrada com sucesso.');
      }
      // Salvar devolve a pessoa à lista (tela principal), como no restante do ERP.
      navigate('/grades');
    } catch (e) {
      setErrors(fieldErrors(e));
      setFormError(e instanceof ApiError ? e.message : 'Não foi possível salvar. Tente novamente.');
      requestAnimationFrame(() => errorSummaryRef.current?.focus());
    } finally {
      setSaving(false);
    }
  }

  if (!disponivel) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title="Grades" description="Grades de tamanhos do catálogo." />
        <Alert tone="red">O cadastro de Grades não está disponível neste ambiente.</Alert>
        <Link to="/grades" className="btn-secondary mt-4 inline-flex">
          <ArrowLeft className="h-4 w-4" /> Voltar para a lista
        </Link>
      </div>
    );
  }

  const titulo = editing ? rotuloEditar(resource.key, resource.singular) : rotuloNovo(resource.key, resource.singular);
  const nomeAtual = String(values.nome ?? '').trim();
  const descricao = editing
    ? nomeAtual
      ? `Alterando a grade “${nomeAtual}”. Os campos com * são obrigatórios.`
      : 'Atualize os dados da grade. Os campos com * são obrigatórios.'
    : descricaoDoCadastro(resource.key) ?? 'Preencha os dados da grade. Os campos com * são obrigatórios.';
  const rotuloSalvarGrade = rotuloSalvar(resource.key);

  // Limites/ajudas reais, vindos do metadado do recurso (nada inventado).
  const campoNome = resource.fields.find((f) => f.name === 'nome');
  const campoDescricao = resource.fields.find((f) => f.name === 'descricao');
  const campoInstrucoes = resource.fields.find((f) => f.name === 'instrucoes_medidas');
  const campoTamanhos = resource.fields.find((f) => f.name === 'tamanhos');
  const maxNome = campoNome?.maxLength ?? 60;
  const maxDescricao = campoDescricao?.maxLength ?? 160;
  const maxInstrucoes = campoInstrucoes?.maxLength ?? 600;

  if (carregando) {
    return (
      <div className="p-4 sm:p-6">
        <Spinner label="Carregando grade..." />
      </div>
    );
  }

  if (erroCarregar) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title={titulo} description="Não foi possível abrir o cadastro." />
        <Alert tone="red">{erroCarregar}</Alert>
        <Link to="/grades" className="btn-secondary mt-4 inline-flex">
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
              <Grid3x3 className="h-5 w-5" />
            </span>
            {titulo}
          </span>
        }
        description={descricao}
        actions={
          <>
            {/* No celular o rótulo some e sobra o ícone: o aria-label mantém o
                nome acessível nos dois tamanhos de tela. */}
            <Link to="/grades" className="btn-secondary inline-flex" aria-label="Voltar para a lista de grades">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> <span className="hidden sm:inline">Voltar</span>
            </Link>
            {editing && (
              // Integração com o módulo de medidas EXISTENTE (nada é recriado
              // aqui): a tabela da grade abre no fluxo atual, já na grade certa.
              <Link
                to={`/medidas?grade=${id}`}
                className="btn-secondary inline-flex"
                aria-label="Abrir a tabela de medidas desta grade"
              >
                <Ruler className="h-4 w-4" aria-hidden="true" /> <span className="hidden sm:inline">Tabela de medidas</span>
              </Link>
            )}
            <button
              type="button"
              className="btn-secondary inline-flex"
              onClick={() => navigate('/grades')}
              disabled={saving}
              aria-label="Cancelar e voltar para a lista de grades"
            >
              <X className="h-4 w-4" aria-hidden="true" /> <span className="hidden sm:inline">Cancelar</span>
            </button>
            <button
              type="submit"
              form={`form-${resource.key}`}
              className="btn-primary inline-flex"
              disabled={saving || !podeSalvar}
              title={podeSalvar ? undefined : 'Seu perfil não tem permissão para salvar grades.'}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {rotuloSalvarGrade}
            </button>
          </>
        }
      />

      {!podeSalvar && (
        <div className="mb-4">
          <Alert tone="amber">
            Seu perfil tem acesso somente de leitura a Grades. Você pode revisar os dados, mas não salvar.
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
        id={`form-${resource.key}`}
        className="space-y-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void salvar();
        }}
      >
        {/* ---------------------------------------------------------------- */}
        {/* 1. IDENTIFICAÇÃO DA GRADE                                         */}
        {/* ---------------------------------------------------------------- */}
        <section className="card p-4 sm:p-5" aria-labelledby="secao-identificacao">
          <h2
            id="secao-identificacao"
            className="mb-4 flex items-center gap-2 border-b border-slate-100 pb-3 text-sm font-bold uppercase tracking-wide text-navy-800 dark:border-navy-800"
          >
            <Grid3x3 className="h-4 w-4 text-navy-400" aria-hidden="true" />
            Identificação da grade
          </h2>

          <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="f-nome" className="label">
                Nome
                <span className="ml-0.5 text-red-500" aria-hidden="true">
                  *
                </span>
                <span className="sr-only"> (obrigatório)</span>
              </label>
              <input
                id="f-nome"
                type="text"
                className={`input ${errors.nome ? 'input-error' : ''}`}
                value={String(values.nome ?? '')}
                onChange={(e) => onChange('nome', e.target.value)}
                maxLength={maxNome}
                placeholder={campoNome?.placeholder ?? 'Camiseta PP-GG, Calça 36-48...'}
                autoComplete="off"
                autoFocus
                disabled={!podeSalvar}
                aria-invalid={errors.nome ? true : undefined}
                aria-describedby={errors.nome ? 'f-nome-erro' : 'f-nome-dica'}
                required
              />
              {errors.nome ? (
                <p id="f-nome-erro" className="mt-1 text-xs font-medium text-red-600" role="alert">
                  {errors.nome}
                </p>
              ) : (
                <p id="f-nome-dica" className="mt-1 text-xs text-slate-400">
                  Identifica a grade no catálogo, no estoque e na tabela de medidas. O nome não pode se repetir.
                </p>
              )}
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="f-descricao" className="label">
                Descrição
              </label>
              <textarea
                id="f-descricao"
                className={`input min-h-[72px] ${errors.descricao ? 'input-error' : ''}`}
                value={String(values.descricao ?? '')}
                onChange={(e) => onChange('descricao', e.target.value)}
                maxLength={maxDescricao}
                placeholder="Malha e camisaria básica"
                disabled={!podeSalvar}
                aria-invalid={errors.descricao ? true : undefined}
                aria-describedby={errors.descricao ? 'f-descricao-erro' : 'f-descricao-dica'}
              />
              {errors.descricao ? (
                <p id="f-descricao-erro" className="mt-1 text-xs font-medium text-red-600" role="alert">
                  {errors.descricao}
                </p>
              ) : (
                <p id="f-descricao-dica" className="mt-1 text-xs text-slate-400">
                  Opcional. Ajuda a identificar para quais peças esta grade serve.
                </p>
              )}
            </div>

            <div className="sm:col-span-2">
              <Switch
                id="f-ativo"
                label="Ativo"
                checked={Boolean(values.ativo)}
                onChange={(v) => onChange('ativo', v)}
                disabled={!podeSalvar}
                description={
                  values.ativo
                    ? 'Grade disponível para categorias, produtos e tabela de medidas.'
                    : 'Grade inativa: sai das listas de seleção, mas tamanhos, produtos e medidas são preservados.'
                }
              />
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* 2. TAMANHOS DA GRADE (relação ordenada grade × tamanho)           */}
        {/* ---------------------------------------------------------------- */}
        <section className="card p-4 sm:p-5" aria-labelledby="secao-tamanhos">
          <h2
            id="secao-tamanhos"
            className="mb-1 flex items-center gap-2 border-b border-slate-100 pb-3 text-sm font-bold uppercase tracking-wide text-navy-800 dark:border-navy-800"
          >
            <Ruler className="h-4 w-4 text-navy-400" aria-hidden="true" />
            Tamanhos da grade
            <span className="ml-auto normal-case tracking-normal text-muted">
              {campoTamanhos?.required ? 'obrigatório' : 'opcional'}
            </span>
          </h2>
          <p className="mb-4 mt-2 text-xs text-slate-500">
            Marque os tamanhos desta grade e defina a ordem em que eles aparecem no estoque, na tabela de medidas e no
            catálogo. A ordem é gravada em `grade_tamanhos`.
          </p>

          {erroTamanhos && (
            <div className="mb-4">
              <Alert tone="red">{erroTamanhos}</Alert>
            </div>
          )}

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {/* ---- disponíveis ---- */}
            <div>
              <h3 id="rotulo-disponiveis" className="label mb-2">
                Tamanhos disponíveis
              </h3>
              {opcoesTamanhos === null ? (
                <Spinner label="Carregando tamanhos..." />
              ) : opcoesTamanhos.length === 0 ? (
                <p className="text-sm text-brand-700">
                  Nenhum tamanho cadastrado. Cadastre primeiro em{' '}
                  <Link to="/tamanhos" className="font-semibold underline">
                    Tamanhos
                  </Link>
                  .
                </p>
              ) : (
                <div
                  id="grade-primeiro-tamanho"
                  tabIndex={-1}
                  className="flex flex-wrap gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-navy-500/40"
                  role="group"
                  aria-labelledby="rotulo-disponiveis"
                  aria-describedby="disponiveis-dica"
                >
                  {opcoesTamanhos.map((o) => {
                    const valor = String(o.value);
                    const ativo = selecionados.includes(valor);
                    // O nome acessível é só o código do tamanho: o estado vem de
                    // `aria-pressed` e a posição, da lista ordenada ao lado.
                    return (
                      <button
                        key={valor}
                        type="button"
                        onClick={() => alternarTamanho(valor)}
                        disabled={!podeSalvar || saving}
                        aria-pressed={ativo}
                        title={ativo ? `Remover ${o.label} da grade` : `Adicionar ${o.label} à grade`}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                          ativo
                            ? 'border-navy-700 bg-navy-800 text-white'
                            : 'border-slate-300 bg-white text-slate-600 hover:border-navy-500'
                        }`}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              )}
              <p id="disponiveis-dica" className="mt-2 text-xs text-slate-400">
                Clique para adicionar ao fim da sequência; clique de novo para remover.
              </p>
            </div>

            {/* ---- selecionados, com ordem explícita ---- */}
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 id="rotulo-selecionados" className="label mb-0">
                  Ordem dos tamanhos
                </h3>
                {/* Contagem ao vivo: muda junto com a seleção, sem recalcular nada. */}
                <span className="text-xs font-semibold text-navy-700" aria-live="polite">
                  {textoQuantidadeTamanhos(selecionados.length)}
                </span>
              </div>

              {errors.tamanhos && (
                <p id="tamanhos-erro" className="mb-2 text-xs font-medium text-red-600" role="alert">
                  {/* A REGRA vem do validador compartilhado (RecordForm); aqui só
                      muda a frase, para falar a língua deste cadastro. */}
                  {errors.tamanhos === 'Selecione ao menos um item'
                    ? 'Selecione ao menos um tamanho para a grade.'
                    : errors.tamanhos}
                </p>
              )}

              {selecionados.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-400">
                  Nenhum tamanho na grade ainda.
                </p>
              ) : (
                <ol
                  className="space-y-1.5"
                  aria-labelledby="rotulo-selecionados"
                  aria-describedby={errors.tamanhos ? 'tamanhos-erro' : 'selecionados-dica'}
                >
                  {selecionados.map((idTamanho, indice) => {
                    const codigo = rotuloTamanho(opcoesTamanhos, idTamanho);
                    return (
                      <li
                        key={idTamanho}
                        className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-navy-800 dark:bg-transparent"
                      >
                        {/* data-testid: mesmo recurso usado por ListaTabela/ListaCards —
                            trava a ordem que a pessoa vê (posição + código). */}
                        <span
                          data-testid="grade-ordem-numero"
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-navy-800 text-[11px] font-bold text-white"
                          aria-hidden="true"
                        >
                          {indice + 1}
                        </span>
                        <span
                          data-testid="grade-tamanho-codigo"
                          className="min-w-0 flex-1 truncate text-sm font-semibold text-navy-900"
                        >
                          {codigo}
                        </span>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            className="btn-icon"
                            onClick={() => moverTamanho(idTamanho, -1)}
                            disabled={!podeSalvar || saving || indice === 0}
                            title={`Mover ${codigo} para cima`}
                            aria-label={`Mover ${codigo} para cima`}
                          >
                            <ChevronUp className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            className="btn-icon"
                            onClick={() => moverTamanho(idTamanho, 1)}
                            disabled={!podeSalvar || saving || indice === selecionados.length - 1}
                            title={`Mover ${codigo} para baixo`}
                            aria-label={`Mover ${codigo} para baixo`}
                          >
                            <ChevronDown className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            className="btn-icon hover:!bg-red-50 hover:!text-red-600"
                            onClick={() => removerTamanho(idTamanho)}
                            disabled={!podeSalvar || saving}
                            title={`Remover ${codigo} da grade`}
                            aria-label={`Remover ${codigo} da grade`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
              <p id="selecionados-dica" className="mt-2 text-xs text-slate-400">
                Use ↑ ↓ para reordenar. A posição é a ordem real dos tamanhos desta grade.
              </p>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* 3. PREVIEW — reflexo ao vivo do que está no formulário            */}
        {/* ---------------------------------------------------------------- */}
        <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="secao-preview">
          <h2
            id="secao-preview"
            className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted"
          >
            Prévia da grade
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-navy-900">{nomeAtual || 'Grade sem nome'}</p>
              {selecionados.length ? (
                <p className="mt-1 flex flex-wrap items-center gap-1 text-sm text-slate-600">
                  {selecionados.map((idTamanho, indice) => (
                    <span key={idTamanho} className="inline-flex items-center gap-1">
                      {indice > 0 && <ArrowRight className="h-3 w-3 text-slate-300" aria-hidden="true" />}
                      <span className="rounded-md bg-navy-50 px-1.5 py-0.5 font-semibold text-navy-800">
                        {rotuloTamanho(opcoesTamanhos, idTamanho)}
                      </span>
                    </span>
                  ))}
                </p>
              ) : (
                <p className="mt-1 text-sm text-slate-400">Nenhum tamanho selecionado.</p>
              )}
            </div>
            <Badge tone={selecionados.length ? 'green' : 'slate'}>
              {textoTotalTamanhos(selecionados.length)}
            </Badge>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* 4. ORIENTAÇÕES DE MEDIÇÃO (`instrucoes_medidas`)                  */}
        {/* ---------------------------------------------------------------- */}
        <section className="card p-4 sm:p-5" aria-labelledby="secao-medicao">
          <h2
            id="secao-medicao"
            className="mb-4 flex items-center gap-2 border-b border-slate-100 pb-3 text-sm font-bold uppercase tracking-wide text-navy-800 dark:border-navy-800"
          >
            <Ruler className="h-4 w-4 text-navy-400" aria-hidden="true" />
            Orientações de medição
          </h2>

          <label htmlFor="f-instrucoes_medidas" className="label">
            Instruções para o cliente
          </label>
          <textarea
            id="f-instrucoes_medidas"
            className={`input min-h-[96px] ${errors.instrucoes_medidas ? 'input-error' : ''}`}
            value={String(values.instrucoes_medidas ?? '')}
            onChange={(e) => onChange('instrucoes_medidas', e.target.value)}
            maxLength={maxInstrucoes}
            placeholder={campoInstrucoes?.placeholder ?? 'Ex.: Meça a peça sobre uma superfície plana, sem esticar. Tolerância de ±1 cm.'}
            disabled={!podeSalvar}
            aria-invalid={errors.instrucoes_medidas ? true : undefined}
            aria-describedby={errors.instrucoes_medidas ? 'f-instrucoes-erro' : 'f-instrucoes-dica'}
          />
          {errors.instrucoes_medidas ? (
            <p id="f-instrucoes-erro" className="mt-1 text-xs font-medium text-red-600" role="alert">
              {errors.instrucoes_medidas}
            </p>
          ) : (
            <p id="f-instrucoes-dica" className="mt-1 text-xs text-slate-400">
              Estas orientações podem aparecer na tabela de medidas e no catálogo público.
            </p>
          )}

          {editing && registro && (
            <p className="mt-3 text-xs text-slate-500">
              Os valores da tabela (colunas × tamanhos) são editados no módulo{' '}
              <Link to={`/medidas?grade=${id}`} className="font-semibold text-navy-700 underline">
                Tabela de Medidas
              </Link>
              .
            </p>
          )}
        </section>

        {/* Rodapé de ações da página — mesma dupla do cabeçalho, para telas
            longas e mobile. Submete pelo atributo `form`, sem duplicar a barra
            de ações dentro do formulário. */}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-4 dark:border-navy-800">
          {editing && (
            <Link to={`/medidas?grade=${id}`} className="btn-secondary inline-flex mr-auto">
              <Ruler className="h-4 w-4" aria-hidden="true" /> Tabela de medidas
            </Link>
          )}
          <button type="button" className="btn-secondary" onClick={() => navigate('/grades')} disabled={saving}>
            <X className="h-4 w-4" /> Cancelar
          </button>
          <button
            type="submit"
            form={`form-${resource.key}`}
            className="btn-primary"
            disabled={saving || !podeSalvar}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {rotuloSalvarGrade}
          </button>
        </div>
      </form>
    </div>
  );
}
