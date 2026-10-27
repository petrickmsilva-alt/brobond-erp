// ============================================================================
// CADASTRO DE REPRESENTANTES — PÁGINA do ERP (lista → página), sem modal e sem drawer.
//
// Fluxo canônico do BROBOND ERP (o MESMO de Clientes, Fornecedores, Insumos,
// Cores, Coleções, Grades e Tamanhos):
//
//   /representantes                → lista (tela principal, RepresentantesPage)
//   /representantes/novo           → página "Novo representante"
//   /representantes/:id/editar     → página "Editar representante"
//
// Nada é sobreposto à lista: a inclusão/edição é uma rota normal, com o
// breadcrumb do shell (BROBOND ERP › Cadastros › Representantes › Novo/Editar),
// o `PageHeader` padrão e as ações Voltar / Cancelar / Salvar representante.
//
// REUTILIZA os componentes JÁ existentes do ERP — nenhum design system novo:
//   • `PageHeader`, `Alert`, `Spinner`, `useToast`  (components/ui)
//   • `RecordForm` dirigido pelos metadados de GET /api/meta — inclusive as
//     SEÇÕES do formulário (Identificação · Comercial · Acesso ao ERP ·
//     Contato · Situação profissional), declaradas nos próprios campos do
//     recurso no servidor
//   • `validarFormulario` / `toPayload` / `initialValues` (as MESMAS regras do
//     CRUD genérico — um campo nunca tem duas validações no ERP; a máscara de
//     CPF e a conferência do dígito verificador vêm do servidor)
//   • `lib/lista` (rótulos/descrição do cadastro, sem texto duplicado)
//
// CAMPOS — os que EXISTEM de verdade em `representantes` (db/schema.sql +
// migration 0021): nome, cpf, cargo, regiao, comissao_pct, usuario_id,
// telefone, whatsapp, email, admissao, desligamento, observacoes e ativo.
// NÃO existem (e por isso NÃO aparecem): salário, meta, limite de crédito,
// banco/PIX, comissão acumulada, vendas totais, foto, tabela de preço, código
// interno ou departamento.
//
// vendedor: `representantes` é a entidade OFICIAL de vendedor/funcionário —
// aqui não se cria outra. O vínculo com `usuarios` (`usuario_id`) é OPCIONAL e
// único por empresa (`uq_representantes_usuario_empresa`); a unicidade é do
// BANCO e a mensagem amigável vem traduzida do servidor.
//
// CPF: campo real com índice único por empresa (`uq_representantes_cpf_empresa`).
// A máscara é a compartilhada do ERP e a autoridade continua sendo a API — CPF
// duplicado volta 409 com o erro no campo, sem a tela inventar outra regra.
//
// COMISSÃO: `comissao_pct` (0–100%). O texto de apoio — "a comissão é paga
// sobre faturas efetivamente LIQUIDADAS, não sobre a venda criada" — vem do
// metadado do servidor. A lógica de apuração (comissoes.ts) NÃO é tocada.
//
// DESLIGAMENTO: preencher `desligamento` registra apenas a situação
// profissional; NÃO apaga vendas, comissões, clientes, propostas nem auditoria
// (nenhum DELETE/CASCADE é criado aqui).
//
// MULTIEMPRESA/RBAC: a página só reflete o metadado e as permissões recebidas;
// o servidor revalida tudo (checkAccess + validatePayload + empresa ativa).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Handshake, Loader2, Save, X } from 'lucide-react';
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
  key: 'representantes',
  label: 'Representantes',
  singular: 'Representante',
  labelFields: ['nome'],
  fields: [],
  ops: { create: false, update: false, delete: false },
};

export default function RepresentanteFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const toast = useToast();
  const meta = useMeta();
  const { user } = useAuth();
  const resource = meta.resources['representantes'];
  const defaultLocal = meta.defaultLocal ?? null;

  // RBAC espelhado do servidor. Representantes é cadastro POR EMPRESA: não
  // declara `minPerfilEscrita`; o espelho continua genérico para o dia em que
  // um piso for declarado. Só controla o que aparece/habilita: a autorização
  // real é da API.
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
  const [naoEncontrado, setNaoEncontrado] = useState(false);
  const [salvoComSucesso, setSalvoComSucesso] = useState(false);
  const [registro, setRegistro] = useState<Record<string, any> | null>(null);
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  // O recurso tem UM campo `ref` (`usuario_id` → usuarios): o hook usa o MESMO
  // contrato `/usuarios/options` do CRUD genérico. Quando o perfil não pode
  // listar usuários (a API responde 403), o select fica vazio e o vínculo
  // existente não é alterado — o hook já engole o erro.
  const refOptions = useRefOptions(resource ?? RECURSO_INDISPONIVEL);

  // ---- carga do registro (edição) ----
  const carregar = useCallback(async () => {
    if (!editing || !id || !resource) return;
    setCarregando(true);
    setNaoEncontrado(false);
    try {
      const row = await api.get<Record<string, any>>(`/representantes/${id}`);
      setRegistro(row);
      setValues(initialValues(resource, row, defaultLocal));
      setErroCarregar('');
    } catch (e) {
      // 404 = registro inexistente OU de outra empresa (multiempresa: o
      // servidor responde 404 antes de revelar a existência fora do tenant).
      // A tela trata os dois casos do mesmo jeito, com caminho de volta.
      if (e instanceof ApiError && e.status === 404) {
        setNaoEncontrado(true);
        return;
      }
      setErroCarregar(e instanceof ApiError ? e.message : 'Não foi possível abrir o representante.');
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

  /** Salva no MESMO contrato do CRUD genérico (POST/PUT /representantes). */
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
        await api.put<Record<string, any>>(`/representantes/${id}`, payload);
        toast.success('Representante salvo com sucesso.');
      } else {
        await api.post<Record<string, any>>('/representantes', payload);
        toast.success('Representante cadastrado com sucesso.');
      }
      setSalvoComSucesso(true);
      // Salvar devolve a pessoa à lista (tela principal), como no restante do ERP.
      navigate('/representantes');
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
        <PageHeader title="Representantes" description="Cadastro de representantes." />
        <Alert tone="red">O cadastro de Representantes não está disponível neste ambiente.</Alert>
        <Link to="/representantes" className="btn-secondary mt-4 inline-flex">
          <ArrowLeft className="h-4 w-4" /> Voltar para a lista
        </Link>
      </div>
    );
  }

  const titulo = editing ? rotuloEditar(resource.key, resource.singular) : rotuloNovo(resource.key, resource.singular);

  if (carregando) {
    return (
      <div className="p-4 sm:p-6">
        <Spinner label="Carregando representante..." />
      </div>
    );
  }

  // 404 (inexistente ou de outra empresa): a página continua sendo uma ROTA,
  // com caminho de volta — nenhum modal de erro.
  if (naoEncontrado) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title="Representante não encontrado" description="O registro não existe ou não pertence à empresa ativa." />
        <Alert tone="amber">
          Não encontramos este representante na empresa ativa. Ele pode ter sido excluído ou pertencer a outra empresa. Volte para a lista para escolher um
          registro válido.
        </Alert>
        <Link to="/representantes" className="btn-secondary mt-4 inline-flex">
          <ArrowLeft className="h-4 w-4" /> Voltar para a lista
        </Link>
      </div>
    );
  }

  if (erroCarregar) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title={titulo} description="Não foi possível abrir o cadastro." />
        <Alert tone="red">{erroCarregar}</Alert>
        <Link to="/representantes" className="btn-secondary mt-4 inline-flex">
          <ArrowLeft className="h-4 w-4" /> Voltar para a lista
        </Link>
      </div>
    );
  }

  const nomeAtual = editing ? String(registro?.nome ?? values.nome ?? '').trim() : '';
  const descricao = editing
    ? nomeAtual
      ? `Alterando o representante “${nomeAtual}”. Os campos com * são obrigatórios.`
      : 'Atualize os dados do representante. Os campos com * são obrigatórios.'
    : descricaoDoCadastro(resource.key) ?? 'Preencha os dados do representante. Os campos com * são obrigatórios.';
  // Rótulo do botão de salvar: na criação é "Salvar representante" (rótulo do
  // recurso, em `client/src/lib/lista.ts`); na edição, "Salvar alterações" —
  // a mesma convenção já usada em Fornecedores, Clientes e Insumos.
  const rotuloSalvarRepresentante = editing ? 'Salvar alterações' : rotuloSalvar(resource.key);

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <Handshake className="h-5 w-5" />
            </span>
            {titulo}
          </span>
        }
        description={descricao}
        actions={
          <>
            {/* No celular o rótulo some e sobra o ícone: o aria-label mantém o
                nome acessível nos dois tamanhos de tela. */}
            <Link to="/representantes" className="btn-secondary inline-flex" aria-label="Voltar para a lista de representantes">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> <span className="hidden sm:inline">Voltar</span>
            </Link>
            <button
              type="button"
              className="btn-secondary inline-flex"
              onClick={() => navigate('/representantes')}
              disabled={saving}
              aria-label="Cancelar e voltar para a lista de representantes"
            >
              <X className="h-4 w-4" aria-hidden="true" /> <span className="hidden sm:inline">Cancelar</span>
            </button>
            <button
              type="submit"
              form={`form-${resource.key}`}
              className="btn-primary inline-flex"
              disabled={saving || !podeSalvar || salvoComSucesso}
              title={podeSalvar ? undefined : 'Seu perfil não tem permissão para salvar representantes.'}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {rotuloSalvarRepresentante}
            </button>
          </>
        }
      />

      {!podeSalvar && (
        <div className="mb-4">
          <Alert tone="amber">
            Seu perfil tem acesso somente de leitura a Representantes. Você pode revisar os dados, mas não salvar.
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
          <Handshake className="h-4 w-4 text-navy-400" aria-hidden="true" />
          Dados do representante
        </h2>

        {/* O formulário é o MESMO componente dirigido por metadados: campos,
            obrigatoriedade, máscaras (CPF, telefone) e validações vêm de
            GET /api/meta. As seções (Identificação · Comercial · Acesso ao ERP ·
            Contato · Situação profissional) são declaradas nos campos do
            recurso e o RecordForm as agrupa — `hideActions` evita uma segunda
            barra de botões: a da página é a única. */}
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
          <button type="button" className="btn-secondary" onClick={() => navigate('/representantes')} disabled={saving}>
            <X className="h-4 w-4" /> Cancelar
          </button>
          <button
            type="submit"
            form={`form-${resource.key}`}
            className="btn-primary"
            disabled={saving || !podeSalvar || salvoComSucesso}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {rotuloSalvarRepresentante}
          </button>
        </div>
      </section>
    </div>
  );
}
