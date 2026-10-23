// ============================================================================
// CADASTRO DE CLIENTES — página própria (PF/PJ), no lugar do modal.
//
// Fluxo: /clientes (lista) → /clientes/novo → /clientes/:id/editar.
//
// O formulário é dividido em seções (Dados cadastrais, Fiscal, Contato,
// Endereço, Comercial, Observações) e o tipo de pessoa (PF/PJ/estrangeiro)
// controla dinamicamente quais campos aparecem — nunca CPF e CNPJ juntos.
//
// Cada campo tem MÁSCARA + VALIDAÇÃO + NORMALIZAÇÃO: o payload que vai à API
// já sai sem máscara (documento/CEP/telefone em dígitos, moeda em número), e o
// servidor revalida tudo (services.validarRegrasCliente + validatePayload).
//
// Duplicidade de CPF/CNPJ é verificada por GET /api/clientes/por-documento
// (recortado pela empresa ativa) enquanto o usuário digita; a decisão final é
// do servidor (índice uq_clientes_documento_empresa + regra de serviço).
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CheckCircle2,
  CreditCard,
  Loader2,
  MapPin,
  Phone,
  Save,
  StickyNote,
  Store,
  User,
  Wallet,
  X,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeta, type Option } from '../lib/meta';
import {
  cpfValido,
  cnpjValido,
  erroTelefone,
  formatPhone,
  maskCep,
  maskDocumentoTipo,
  maskMoneyInput,
  maskPhone,
  normalizePhone,
  parseMoneyInput,
  soDigitos,
  UFS_BRASIL,
} from '../lib/format';
import { Alert, PageHeader, Spinner, useToast } from '../components/ui';

type Pessoa = 'pf' | 'pj' | 'estrangeiro';

type Valores = Record<string, string> & { ativo: string };

const PESSOAS: { valor: Pessoa; titulo: string; descricao: string; icon: typeof User }[] = [
  { valor: 'pf', titulo: 'Pessoa Física', descricao: 'Cadastro pessoal completo', icon: User },
  { valor: 'pj', titulo: 'Pessoa Jurídica', descricao: 'Dados da empresa e fiscais', icon: Building2 },
  { valor: 'estrangeiro', titulo: 'Estrangeiro', descricao: 'Cliente do exterior', icon: Store },
];

const TIPOS_CLIENTE = [
  { valor: 'loja', label: 'Loja' },
  { valor: 'atacadista', label: 'Atacadista' },
  { valor: 'varejo', label: 'Varejo' },
];

const INDICADORES_IE = [
  { valor: '1', label: '1 — Contribuinte de ICMS' },
  { valor: '2', label: '2 — Isento de Inscrição Estadual' },
  { valor: '9', label: '9 — Não contribuinte' },
];

function valoresIniciais(): Valores {
  return {
    pessoa: 'pj',
    cnpj_cpf: '',
    nome: '',
    razao_social: '',
    nome_fantasia: '',
    tipo: 'loja',
    rg_ie: '',
    indicador_ie: '9',
    im: '',
    suframa: '',
    cep: '',
    logradouro: '',
    numero: '',
    complemento: '',
    bairro: '',
    cidade: '',
    uf: '',
    codigo_municipio: '',
    telefone: '',
    whatsapp: '',
    email: '',
    limite_credito: '0,00',
    representante_id: '',
    observacoes: '',
    ativo: 'true',
  };
}

/** Linha da API → valores de formulário (com máscara de exibição). */
function valoresDaLinha(row: Record<string, any>): Valores {
  const v = valoresIniciais();
  const pessoa = (String(row.pessoa ?? 'pj') as Pessoa) || 'pj';
  v.pessoa = pessoa;
  v.cnpj_cpf = maskDocumentoTipo(soDigitos(row.cnpj_cpf ?? ''), pessoa);
  if (pessoa === 'pj') {
    v.razao_social = String(row.razao_social || row.nome || '');
    v.nome_fantasia = String(row.nome_fantasia || '');
    v.nome = '';
  } else {
    v.nome = String(row.nome || '');
  }
  v.tipo = String(row.tipo || 'loja');
  v.rg_ie = String(row.rg_ie || '');
  v.indicador_ie = String(row.indicador_ie || '9');
  v.im = String(row.im || '');
  v.suframa = String(row.suframa || '');
  v.cep = row.cep ? maskCep(soDigitos(row.cep)) : '';
  v.logradouro = String(row.logradouro || '');
  v.numero = String(row.numero || '');
  v.complemento = String(row.complemento || '');
  v.bairro = String(row.bairro || '');
  v.cidade = String(row.cidade || '');
  v.uf = String(row.uf || '');
  v.codigo_municipio = String(row.codigo_municipio || '');
  v.telefone = formatPhone(row.telefone);
  v.whatsapp = formatPhone(row.whatsapp);
  v.email = String(row.email || '');
  const limite = Number(row.limite_credito ?? 0);
  v.limite_credito = maskMoneyInput(Number.isFinite(limite) ? limite.toFixed(2).replace('.', ',') : '0,00');
  v.representante_id = row.representante_id != null && row.representante_id !== '' ? String(row.representante_id) : '';
  v.observacoes = String(row.observacoes || '');
  v.ativo = row.ativo === false ? 'false' : 'true';
  return v;
}

export default function ClienteFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const toast = useToast();
  const meta = useMeta();
  const resource = meta.resources['clientes'];

  const [carregando, setCarregando] = useState(editing);
  const [erroCarregar, setErroCarregar] = useState('');
  const [values, setValues] = useState<Valores>(valoresIniciais);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [salvoComSucesso, setSalvoComSucesso] = useState(false);
  const [vendedores, setVendedores] = useState<Option[] | null>(null);

  // Duplicidade de documento (aviso + atalho "Abrir cliente")
  const [dup, setDup] = useState<{ id: number; nome: string; cnpj_cpf: string } | null>(null);
  const [dupConsultando, setDupConsultando] = useState(false);

  // Busca de CEP (integração existente /api/cep/:cep — código IBGE incluso)
  const [cepBuscando, setCepBuscando] = useState(false);
  const [cepAviso, setCepAviso] = useState<string | null>(null);

  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const podeSalvar = !resource || (editing ? resource.ops.update : resource.ops.create);

  const pessoa = (values.pessoa || 'pj') as Pessoa;
  const ehPJ = pessoa === 'pj';
  const ehPF = pessoa === 'pf';

  // ---- carga ----
  useEffect(() => {
    if (!editing || !id) return;
    let alive = true;
    setCarregando(true);
    setErroCarregar('');
    api
      .get<Record<string, any>>(`/clientes/${id}`)
      .then((row) => {
        if (!alive) return;
        setValues(valoresDaLinha(row));
      })
      .catch((e) => {
        if (!alive) return;
        setErroCarregar(e instanceof ApiError ? e.message : 'Não foi possível carregar o cliente.');
      })
      .finally(() => alive && setCarregando(false));
    return () => {
      alive = false;
    };
  }, [editing, id]);

  // ---- vendedores (selector, nunca texto livre) ----
  useEffect(() => {
    let alive = true;
    api
      .get<Option[]>('/representantes/options')
      .then((o) => alive && setVendedores(o))
      .catch(() => alive && setVendedores([]));
    return () => {
      alive = false;
    };
  }, []);

  // ---- duplicidade de CPF/CNPJ (debounce enquanto digita) ----
  const digitosDoc = soDigitos(values.cnpj_cpf);
  const docCompleto = ehPF ? digitosDoc.length === 11 : ehPJ ? digitosDoc.length === 14 : false;
  const docValido = ehPF ? cpfValido(digitosDoc) : ehPJ ? cnpjValido(digitosDoc) : false;

  useEffect(() => {
    if (!docCompleto || !docValido) {
      setDup(null);
      return;
    }
    let alive = true;
    setDupConsultando(true);
    const t = window.setTimeout(() => {
      api
        .get<{ cliente: { id: number; nome: string; cnpj_cpf: string } | null }>(
          `/clientes/por-documento?doc=${digitosDoc}${editing && id ? `&ignorar_id=${id}` : ''}`
        )
        .then((d) => {
          if (!alive) return;
          setDup(d.cliente ? { id: Number(d.cliente.id), nome: String(d.cliente.nome), cnpj_cpf: String(d.cliente.cnpj_cpf) } : null);
        })
        .catch(() => {
          // Consulta de conveniência: o servidor barra a duplicidade ao salvar.
          if (alive) setDup(null);
        })
        .finally(() => alive && setDupConsultando(false));
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [digitosDoc, docCompleto, docValido, editing, id]);

  // ---- helpers ----
  const setCampo = useCallback((nome: string, valor: string) => {
    setValues((v) => ({ ...v, [nome]: valor }));
    setErrors((e) => (e[nome] ? { ...e, [nome]: '' } : e));
    setFormError('');
  }, []);

  function trocarPessoa(nova: Pessoa) {
    setValues((v) => {
      const digitos = soDigitos(v.cnpj_cpf);
      const cabe = nova === 'pf' ? digitos.length === 11 : nova === 'pj' ? digitos.length === 14 : false;
      return {
        ...v,
        pessoa: nova,
        // O documento só permanece se tiver o tamanho do NOVO tipo; trocar
        // PF↔PJ com um documento do tipo antigo limpa o campo (sem CPF e CNPJ
        // convivendo no mesmo formulário).
        cnpj_cpf: cabe ? maskDocumentoTipo(digitos, nova) : '',
      };
    });
    setErrors({});
    setDup(null);
    setFormError('');
  }

  /** Busca o CEP e completa só o que estiver vazio (não apaga o digitado). */
  async function buscarCep() {
    const digitos = soDigitos(values.cep);
    if (digitos.length !== 8) {
      setCepAviso('Informe os 8 dígitos do CEP.');
      return;
    }
    setCepBuscando(true);
    setCepAviso(null);
    try {
      const endereco = await api.get<Record<string, string | null>>(`/cep/${digitos}`);
      const mapa: Record<string, string | null | undefined> = {
        logradouro: endereco.logradouro,
        bairro: endereco.bairro,
        cidade: endereco.cidade,
        uf: endereco.uf,
        codigo_municipio: endereco.codigo_municipio,
        complemento: endereco.complemento,
      };
      let preenchidos = 0;
      setValues((v) => {
        const novo = { ...v };
        for (const [campo, valor] of Object.entries(mapa)) {
          if (!valor || String(novo[campo] ?? '').trim() !== '') continue;
          novo[campo] = String(valor);
          preenchidos += 1;
        }
        return novo;
      });
      setCepAviso(
        preenchidos
          ? `Endereço preenchido (${endereco.cidade}/${endereco.uf}).`
          : 'CEP encontrado — os campos já estavam preenchidos e foram mantidos.'
      );
    } catch (e) {
      setCepAviso(
        e instanceof ApiError && e.status === 404
          ? 'CEP não encontrado. Preencha o endereço manualmente.'
          : 'Não foi possível consultar o CEP agora. Preencha o endereço manualmente.'
      );
    } finally {
      setCepBuscando(false);
    }
  }

  /** Validação local espelhando a do servidor — erro perto do campo, na hora. */
  function validar(): Record<string, string> {
    const errs: Record<string, string> = {};
    const obrigatorio = (nome: string, rotulo: string) => {
      if (!String(values[nome] ?? '').trim()) errs[nome] = `Informe ${rotulo}.`;
    };

    if (ehPF) {
      obrigatorio('nome', 'o nome completo');
      if (digitosDoc && !cpfValido(digitosDoc)) errs.cnpj_cpf = 'CPF inválido.';
    } else if (ehPJ) {
      obrigatorio('razao_social', 'a razão social');
      if (digitosDoc && !cnpjValido(digitosDoc)) errs.cnpj_cpf = 'CNPJ inválido.';
    } else {
      obrigatorio('nome', 'o nome completo');
    }

    const email = values.email.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errs.email = 'E-mail inválido.';
    if (values.telefone.trim() && erroTelefone(values.telefone)) errs.telefone = erroTelefone(values.telefone)!;
    if (values.whatsapp.trim() && erroTelefone(values.whatsapp)) errs.whatsapp = erroTelefone(values.whatsapp)!;
    const cep = soDigitos(values.cep);
    if (values.cep.trim() && cep.length !== 8) errs.cep = 'CEP inválido (8 dígitos).';
    if (values.limite_credito.trim()) {
      const n = parseMoneyInput(values.limite_credito);
      if (n === null || n < 0) errs.limite_credito = 'Valor monetário inválido.';
    }
    return errs;
  }

  function montarPayload() {
    const doc = soDigitos(values.cnpj_cpf);
    const email = values.email.trim();
    const ehCadastroPj = ehPJ;
    return {
      pessoa,
      cnpj_cpf: doc && (ehPF || ehPJ) ? doc : null,
      // PJ: o nome de exibição do ERP segue sendo a razão social (labelFields e
      // PDV consultam `nome`); `razao_social` espelha o mesmo texto p/ a NF-e.
      nome: ehCadastroPj ? values.razao_social.trim() : values.nome.trim(),
      razao_social: ehCadastroPj ? values.razao_social.trim() || null : null,
      nome_fantasia: ehCadastroPj ? values.nome_fantasia.trim() || null : null,
      tipo: values.tipo,
      rg_ie: values.rg_ie.trim() || null,
      indicador_ie: ehCadastroPj ? values.indicador_ie : '9',
      im: ehCadastroPj ? values.im.trim() || null : null,
      suframa: ehCadastroPj ? values.suframa.trim() || null : null,
      cep: soDigitos(values.cep).length === 8 ? soDigitos(values.cep) : null,
      logradouro: values.logradouro.trim() || null,
      numero: values.numero.trim() || null,
      complemento: values.complemento.trim() || null,
      bairro: values.bairro.trim() || null,
      cidade: values.cidade.trim() || null,
      uf: values.uf ? values.uf.toUpperCase() : null,
      codigo_municipio: values.codigo_municipio.trim() || null,
      telefone: normalizePhone(values.telefone),
      whatsapp: normalizePhone(values.whatsapp),
      email: email || null,
      limite_credito: parseMoneyInput(values.limite_credito) ?? 0,
      representante_id: values.representante_id ? Number(values.representante_id) : null,
      observacoes: values.observacoes.trim() || null,
      ativo: values.ativo === 'true',
    };
  }

  async function salvar() {
    setFormError('');
    const errs = validar();
    setErrors(errs);
    if (Object.keys(errs).length) {
      setFormError('Verifique os campos destacados — nada foi salvo e o que você digitou foi mantido.');
      requestAnimationFrame(() => {
        errorSummaryRef.current?.focus();
        const primeiro = Object.keys(errs)[0];
        document.getElementById(`cli-${primeiro}`)?.focus();
      });
      return;
    }
    setSaving(true);
    try {
      const payload = montarPayload();
      if (editing && id) {
        await api.put(`/clientes/${id}`, payload);
        setSalvoComSucesso(true);
        toast.success('Cliente salvo com sucesso.');
        navigate('/clientes');
      } else {
        await api.post('/clientes', payload);
        setSalvoComSucesso(true);
        toast.success('Cliente cadastrado com sucesso.');
        navigate('/clientes');
      }
    } catch (e) {
      const fe = e instanceof ApiError && e.fields ? e.fields : {};
      setErrors(fe);
      const duplicado =
        (e instanceof ApiError && e.code === 'cliente_duplicado') ||
        (typeof fe.cnpj_cpf === 'string' && /Já existe/.test(fe.cnpj_cpf));
      if (duplicado) {
        // O servidor recusou por corrida/legado: busca o dono atual para o link.
        try {
          const d = await api.get<{ cliente: { id: number; nome: string; cnpj_cpf: string } | null }>(
            `/clientes/por-documento?doc=${soDigitos(values.cnpj_cpf)}${editing && id ? `&ignorar_id=${id}` : ''}`
          );
          if (d.cliente) setDup({ id: Number(d.cliente.id), nome: String(d.cliente.nome), cnpj_cpf: String(d.cliente.cnpj_cpf) });
        } catch {
          // segue só com a mensagem
        }
      }
      setFormError(e instanceof ApiError ? e.message : 'Não foi possível salvar. Tente novamente.');
      requestAnimationFrame(() => errorSummaryRef.current?.focus());
    } finally {
      setSaving(false);
    }
  }

  function cancelar() {
    navigate('/clientes');
  }

  const titulo = editing ? 'Editar cliente' : 'Novo cliente';
  const descricao = useMemo(
    () =>
      editing
        ? 'Atualize os dados cadastrais. Os campos com * são obrigatórios.'
        : 'Preencha os dados do cliente. Os campos com * são obrigatórios.',
    [editing]
  );

  if (carregando) {
    return (
      <div className="p-4 sm:p-6">
        <Spinner label="Carregando cliente..." />
      </div>
    );
  }

  if (erroCarregar) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title={titulo} description="Não foi possível abrir o cadastro." />
        <Alert tone="red">{erroCarregar}</Alert>
        <Link to="/clientes" className="btn-secondary mt-4 inline-flex">
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
              <Store className="h-5 w-5" />
            </span>
            {titulo}
          </span>
        }
        description={descricao}
        actions={
          <>
            <Link to="/clientes" className="btn-secondary inline-flex">
              <ArrowLeft className="h-4 w-4" /> <span className="hidden sm:inline">Voltar</span>
            </Link>
            <button type="button" className="btn-secondary inline-flex" onClick={cancelar} disabled={saving}>
              <X className="h-4 w-4" /> <span className="hidden sm:inline">Cancelar</span>
            </button>
            <button
              type="submit"
              form="form-cliente"
              className="btn-primary inline-flex"
              disabled={saving || !podeSalvar || salvoComSucesso}
              title={podeSalvar ? undefined : 'Seu perfil não tem permissão para salvar clientes.'}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {editing ? 'Salvar alterações' : 'Salvar cliente'}
            </button>
          </>
        }
      />

      {!podeSalvar && (
        <div className="mb-4">
          <Alert tone="amber">Seu perfil tem acesso somente de leitura a Clientes. Você pode revisar os dados, mas não salvar.</Alert>
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
        id="form-cliente"
        className="space-y-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void salvar();
        }}
      >
        {/* ---------------- DADOS CADASTRAIS ---------------- */}
        <Secao icon={User} titulo="Dados cadastrais">
          <fieldset className="sm:col-span-2">
            <legend className="label mb-1.5">
              Tipo de cliente <span className="ml-0.5 text-red-500">*</span>
            </legend>
            <div
              role="radiogroup"
              aria-label="Tipo de cliente"
              className="grid grid-cols-1 gap-2 sm:grid-cols-3"
            >
              {PESSOAS.map((op) => {
                const ativo = pessoa === op.valor;
                const Icone = op.icon;
                return (
                  <label
                    key={op.valor}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border-2 px-3.5 py-3 transition-colors focus-within:ring-2 focus-within:ring-navy-500/60 ${
                      ativo
                        ? 'border-navy-700 bg-navy-50/70 shadow-sm'
                        : 'border-slate-200 bg-white hover:border-navy-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="pessoa"
                      value={op.valor}
                      checked={ativo}
                      onChange={() => trocarPessoa(op.valor)}
                      className="sr-only"
                      aria-checked={ativo}
                    />
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                        ativo ? 'bg-navy-800 text-white' : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      <Icone className="h-4 w-4" />
                    </span>
                    <span>
                      <span className={`block text-sm font-semibold ${ativo ? 'text-navy-900' : 'text-slate-700'}`}>{op.titulo}</span>
                      <span className="mt-0.5 block text-xs text-slate-500">{op.descricao}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {(ehPF || ehPJ) && (
            <Campo
              nome="cnpj_cpf"
              rotulo={ehPF ? 'CPF' : 'CNPJ'}
              obrigatorio={false}
              placeholder={ehPF ? '000.000.000-00' : '00.000.000/0000-00'}
              inputMode="tel"
              autoComplete="off"
              maxLength={18}
              valor={values.cnpj_cpf}
              erro={errors.cnpj_cpf}
              dica={ehPF ? 'Com ou sem pontuação. O dígito verificador é conferido.' : 'Com ou sem pontuação. O dígito verificador é conferido.'}
              onChange={(v) => {
                setCampo('cnpj_cpf', maskDocumentoTipo(v, pessoa));
                setDup(null);
              }}
              abaixo={
                dup ? (
                  <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5" role="alert">
                    <p className="flex items-center gap-2 text-sm font-medium text-amber-900">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      Já existe um cliente cadastrado com este {ehPF ? 'CPF' : 'CNPJ'}.
                    </p>
                    <p className="mt-1 text-xs text-amber-800">
                      {dup.nome} — {dup.cnpj_cpf}
                    </p>
                    <Link
                      to={`/clientes/${dup.id}/editar`}
                      className="btn-secondary mt-2 inline-flex !border-amber-400 !bg-white !text-amber-900"
                    >
                      <Store className="h-4 w-4" /> Abrir cliente
                    </Link>
                  </div>
                ) : dupConsultando && docCompleto && docValido ? (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500" aria-live="polite">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Verificando duplicidade...
                  </p>
                ) : null
              }
            />
          )}

          {ehPJ ? (
            <>
              <Campo
                nome="razao_social"
                rotulo="Razão social"
                obrigatorio
                wide
                autoComplete="organization"
                maxLength={160}
                placeholder="Ex.: Comercial Exemplo LTDA"
                valor={values.razao_social}
                erro={errors.razao_social}
                onChange={(v) => setCampo('razao_social', v)}
              />
              <Campo
                nome="nome_fantasia"
                rotulo="Nome fantasia"
                maxLength={160}
                placeholder="Ex.: Loja do Zé"
                valor={values.nome_fantasia}
                erro={errors.nome_fantasia}
                onChange={(v) => setCampo('nome_fantasia', v)}
              />
            </>
          ) : (
            <Campo
              nome="nome"
              rotulo="Nome completo"
              obrigatorio
              wide
              autoComplete="name"
              maxLength={160}
              placeholder="Ex.: Maria da Silva"
              valor={values.nome}
              erro={errors.nome}
              onChange={(v) => setCampo('nome', v)}
            />
          )}
        </Secao>

        {/* ---------------- FISCAL ---------------- */}
        {!pessoa || ehPJ || ehPF ? (
          <Secao icon={CreditCard} titulo="Fiscal">
            {ehPF ? (
              <Campo
                nome="rg_ie"
                rotulo="RG"
                maxLength={30}
                placeholder="Ex.: 1.234.567 SSP/GO"
                valor={values.rg_ie}
                erro={errors.rg_ie}
                onChange={(v) => setCampo('rg_ie', v)}
              />
            ) : (
              <>
                <Campo
                  nome="rg_ie"
                  rotulo="Inscrição estadual"
                  maxLength={30}
                  placeholder="Ex.: 12.345.678-9"
                  dica="Documento fiscal estadual — sem máscara nacional única. Se for isento, informe ISENTO."
                  valor={values.rg_ie}
                  erro={errors.rg_ie}
                  onChange={(v) => setCampo('rg_ie', v)}
                />
                <CampoSelect
                  nome="indicador_ie"
                  rotulo="Indicador de IE"
                  obrigatorio
                  dica="Campo indIEDest da NF-e. Errar aqui é a rejeição mais comum em venda para empresa."
                  valor={values.indicador_ie}
                  erro={errors.indicador_ie}
                  onChange={(v) => setCampo('indicador_ie', v)}
                  opcoes={INDICADORES_IE}
                />
                <Campo
                  nome="im"
                  rotulo="Inscrição municipal"
                  maxLength={30}
                  valor={values.im}
                  erro={errors.im}
                  onChange={(v) => setCampo('im', v)}
                />
                <Campo
                  nome="suframa"
                  rotulo="SUFRAMA"
                  maxLength={20}
                  valor={values.suframa}
                  erro={errors.suframa}
                  onChange={(v) => setCampo('suframa', v)}
                />
              </>
            )}
          </Secao>
        ) : null}

        {/* ---------------- CONTATO ---------------- */}
        <Secao icon={Phone} titulo="Contato">
          <Campo
            nome="telefone"
            rotulo="Telefone"
            placeholder="+55 (__) ____-____"
            inputMode="tel"
            autoComplete="tel"
            maxLength={20}
            valor={values.telefone}
            erro={errors.telefone}
            dica="Fixo ou celular, com DDD. Aceita com ou sem pontuação."
            onChange={(v) => setCampo('telefone', maskPhone(v))}
          />
          <Campo
            nome="whatsapp"
            rotulo="Celular / WhatsApp"
            placeholder="+55 (__) _____-____"
            inputMode="tel"
            maxLength={20}
            valor={values.whatsapp}
            erro={errors.whatsapp}
            dica="Número usado nos envios de WhatsApp do ERP."
            onChange={(v) => setCampo('whatsapp', maskPhone(v))}
          />
          <Campo
            nome="email"
            rotulo="E-mail"
            type="email"
            wide
            autoComplete="email"
            maxLength={160}
            placeholder="cliente@empresa.com.br"
            valor={values.email}
            erro={errors.email}
            onChange={(v) => setCampo('email', v)}
          />
        </Secao>

        {/* ---------------- ENDEREÇO ---------------- */}
        <Secao icon={MapPin} titulo="Endereço">
          <Campo
            nome="cep"
            rotulo="CEP"
            placeholder="_____-___"
            inputMode="tel"
            autoComplete="postal-code"
            maxLength={9}
            valor={values.cep}
            erro={errors.cep}
            onChange={(v) => setCampo('cep', maskCep(v))}
            abaixo={
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary !px-2.5 !py-1.5 text-xs"
                  onClick={buscarCep}
                  disabled={cepBuscando}
                  title="Buscar o endereço a partir do CEP"
                >
                  {cepBuscando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPin className="h-3.5 w-3.5" />}
                  Buscar CEP
                </button>
                {cepAviso && <span className="text-xs text-slate-500">{cepAviso}</span>}
              </div>
            }
          />
          <Campo
            nome="numero"
            rotulo="Número"
            maxLength={20}
            placeholder="Ex.: 123"
            valor={values.numero}
            erro={errors.numero}
            onChange={(v) => setCampo('numero', v)}
          />
          <Campo
            nome="logradouro"
            rotulo="Logradouro"
            wide
            autoComplete="street-address"
            maxLength={160}
            placeholder="Ex.: Av. Independência"
            valor={values.logradouro}
            erro={errors.logradouro}
            onChange={(v) => setCampo('logradouro', v)}
          />
          <Campo
            nome="complemento"
            rotulo="Complemento"
            maxLength={80}
            placeholder="Ex.: Sala 4, Bloco B"
            valor={values.complemento}
            erro={errors.complemento}
            onChange={(v) => setCampo('complemento', v)}
          />
          <Campo
            nome="bairro"
            rotulo="Bairro"
            maxLength={80}
            valor={values.bairro}
            erro={errors.bairro}
            onChange={(v) => setCampo('bairro', v)}
          />
          <Campo
            nome="cidade"
            rotulo="Cidade"
            maxLength={80}
            autoComplete="address-level2"
            valor={values.cidade}
            erro={errors.cidade}
            onChange={(v) => setCampo('cidade', v)}
          />
          <CampoSelect
            nome="uf"
            rotulo="UF"
            placeholderOpcao="—"
            valor={values.uf}
            erro={errors.uf}
            onChange={(v) => setCampo('uf', v)}
            opcoes={UFS_BRASIL.map((uf) => ({ valor: uf, label: uf }))}
          />
          <Campo
            nome="codigo_municipio"
            rotulo="Código IBGE do município"
            inputMode="numeric"
            maxLength={7}
            dica="Obrigatório na NF-e. Preenchido pela busca de CEP."
            valor={values.codigo_municipio}
            erro={errors.codigo_municipio}
            onChange={(v) => setCampo('codigo_municipio', soDigitos(v).slice(0, 7))}
          />
        </Secao>

        {/* ---------------- COMERCIAL ---------------- */}
        <Secao icon={Wallet} titulo="Comercial">
          <CampoSelect
            nome="tipo"
            rotulo="Perfil de compra"
            valor={values.tipo}
            erro={errors.tipo}
            onChange={(v) => setCampo('tipo', v)}
            opcoes={TIPOS_CLIENTE}
          />
          <Campo
            nome="limite_credito"
            rotulo="Limite de crédito"
            inputMode="decimal"
            prefixo="R$"
            placeholder="0,00"
            dica="Zero = sem limite definido."
            valor={values.limite_credito}
            erro={errors.limite_credito}
            onChange={(v) => setCampo('limite_credito', maskMoneyInput(v))}
          />
          <CampoSelect
            nome="representante_id"
            rotulo="Vendedor padrão"
            valor={values.representante_id}
            erro={errors.representante_id}
            onChange={(v) => setCampo('representante_id', v)}
            opcoes={(vendedores ?? []).map((o) => ({ valor: String(o.value), label: o.label }))}
            carregando={vendedores === null}
            placeholderOpcao="— Nenhum —"
            dica="Representante responsável por este cliente."
          />
          {editing && (
            <CampoSelect
              nome="ativo"
              rotulo="Situação"
              valor={values.ativo}
              erro={errors.ativo}
              onChange={(v) => setCampo('ativo', v)}
              opcoes={[
                { valor: 'true', label: 'Ativo' },
                { valor: 'false', label: 'Inativo' },
              ]}
              dica="Prefira inativar a excluir clientes já usados em vendas."
            />
          )}
        </Secao>

        {/* ---------------- OBSERVAÇÕES ---------------- */}
        <Secao icon={StickyNote} titulo="Observações">
          <div className="sm:col-span-2">
            <label htmlFor="cli-observacoes" className="label">
              Observações
            </label>
            <textarea
              id="cli-observacoes"
              className="input min-h-[96px]"
              maxLength={2000}
              placeholder="Informações internas sobre o cliente..."
              value={values.observacoes}
              onChange={(e) => setCampo('observacoes', e.target.value)}
              aria-describedby="cli-observacoes-dica"
            />
            <p id="cli-observacoes-dica" className="mt-1 text-xs text-slate-400">
              Visível apenas internamente. Máximo de 2000 caracteres.
            </p>
          </div>
        </Secao>

        {/* Rodapé de ações — repete os botões para telas longas/mobile */}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-4">
          <button type="button" className="btn-secondary" onClick={cancelar} disabled={saving}>
            <X className="h-4 w-4" /> Cancelar
          </button>
          <button type="submit" className="btn-primary" disabled={saving || !podeSalvar || salvoComSucesso}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : salvoComSucesso ? <CheckCircle2 className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {editing ? 'Salvar alterações' : 'Salvar cliente'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Blocos de UI locais — seção em card e campos com label/erro acessíveis.
// ----------------------------------------------------------------------------

function Secao({ icon: Icon, titulo, children }: { icon: typeof User; titulo: string; children: ReactNode }) {
  return (
    <section
      aria-label={titulo}
      className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-navy-600 dark:bg-navy-800"
    >
      <h2 className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 text-xs font-bold uppercase tracking-wide text-navy-700 dark:border-navy-600 dark:text-navy-200">
        <Icon className="h-4 w-4" /> {titulo}
      </h2>
      <div className="grid grid-cols-1 gap-x-4 gap-y-4 p-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function Campo({
  nome,
  rotulo,
  valor,
  erro,
  onChange,
  obrigatorio,
  wide,
  type = 'text',
  placeholder,
  dica,
  inputMode,
  autoComplete,
  maxLength,
  prefixo,
  abaixo,
}: {
  nome: string;
  rotulo: string;
  valor: string;
  erro?: string;
  onChange: (v: string) => void;
  obrigatorio?: boolean;
  wide?: boolean;
  type?: string;
  placeholder?: string;
  dica?: string;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email';
  autoComplete?: string;
  maxLength?: number;
  prefixo?: string;
  abaixo?: ReactNode;
}) {
  const id = `cli-${nome}`;
  const idErro = erro ? `${id}-erro` : undefined;
  const idDica = !erro && dica ? `${id}-dica` : undefined;
  return (
    <div className={wide ? 'sm:col-span-2' : ''}>
      <label htmlFor={id} className="label">
        {rotulo}
        {obrigatorio && (
          <span className="ml-0.5 text-red-500" aria-hidden="true">
            *
          </span>
        )}
        {obrigatorio && <span className="sr-only"> (obrigatório)</span>}
      </label>
      <div className="relative">
        {prefixo && (
          <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-sm text-slate-400">{prefixo}</span>
        )}
        <input
          id={id}
          type={type}
          inputMode={inputMode}
          autoComplete={autoComplete}
          maxLength={maxLength}
          placeholder={placeholder}
          className={`input ${prefixo ? 'pl-9' : ''} ${erro ? 'input-error' : ''}`}
          value={valor}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={erro ? true : undefined}
          aria-describedby={[idErro, idDica].filter(Boolean).join(' ') || undefined}
          required={obrigatorio || undefined}
        />
      </div>
      {erro ? (
        <p id={idErro} className="mt-1 text-xs font-medium text-red-600" role="alert">
          {erro}
        </p>
      ) : dica ? (
        <p id={idDica} className="mt-1 text-xs text-slate-400 dark:text-navy-300">
          {dica}
        </p>
      ) : null}
      {abaixo}
    </div>
  );
}

function CampoSelect({
  nome,
  rotulo,
  valor,
  erro,
  onChange,
  opcoes,
  obrigatorio,
  dica,
  carregando,
  placeholderOpcao = 'Selecione...',
}: {
  nome: string;
  rotulo: string;
  valor: string;
  erro?: string;
  onChange: (v: string) => void;
  opcoes: { valor: string; label: string }[];
  obrigatorio?: boolean;
  dica?: string;
  carregando?: boolean;
  placeholderOpcao?: string;
}) {
  const id = `cli-${nome}`;
  const idErro = erro ? `${id}-erro` : undefined;
  const idDica = !erro && dica ? `${id}-dica` : undefined;
  return (
    <div>
      <label htmlFor={id} className="label">
        {rotulo}
        {obrigatorio && (
          <span className="ml-0.5 text-red-500" aria-hidden="true">
            *
          </span>
        )}
        {obrigatorio && <span className="sr-only"> (obrigatório)</span>}
      </label>
      <select
        id={id}
        className={`input ${erro ? 'input-error' : ''}`}
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={erro ? true : undefined}
        aria-describedby={[idErro, idDica].filter(Boolean).join(' ') || undefined}
        disabled={carregando}
      >
        <option value="">{carregando ? 'Carregando...' : placeholderOpcao}</option>
        {opcoes.map((o) => (
          <option key={o.valor} value={o.valor}>
            {o.label}
          </option>
        ))}
      </select>
      {erro ? (
        <p id={idErro} className="mt-1 text-xs font-medium text-red-600" role="alert">
          {erro}
        </p>
      ) : dica ? (
        <p id={idDica} className="mt-1 text-xs text-slate-400 dark:text-navy-300">
          {dica}
        </p>
      ) : null}
    </div>
  );
}
