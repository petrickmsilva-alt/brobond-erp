// ============================================================================
// REPRESENTANTE 2.0 — REGRAS DO CADASTRO MESTRE
//
// Aqui vive o que é REGRA DE CADASTRO (e só isso):
//   • normalização canônica (código, documentos, CEP, UF, textos);
//   • código comercial único por empresa, gerado quando em branco;
//   • coerência PF × PJ (CPF OU CNPJ, nunca os dois) e dígito verificador;
//   • unicidade de CPF/CNPJ POR EMPRESA (mensagem amigável; o índice parcial
//     do banco é a garantia final);
//   • contato profissional e endereço estruturado coerentes;
//   • status × desligamento (quem está desligado não fica ativo para NOVAS
//     atribuições, mas nada é apagado);
//   • anotação de apresentação da listagem (equipe vigente e carteira).
//
// O QUE NÃO VIVE AQUI (e por que):
//   • território → domínio `territorios` (0041). O cadastro só REFERENCIA;
//   • equipe/hierarquia → `equipes_comerciais`/`equipe_membros`/
//     `representante_hierarquia` (0042). Nenhuma coluna duplicada;
//   • carteira → `representante_cliente` (0043), com vigência;
//   • metas → `metas` (0044); comissão → `planos_comissao`/`regras_comissao`/
//     `comissoes_apuradas` (0046). `comissao_pct` aqui é só o padrão de
//     referência do cadastro — não é motor de regra;
//   • histórico → trilha de auditoria (ANTES → EVENTO → DEPOIS), append-only.
//
// NÚMERO DE CONSULTAS: as anotações da listagem são feitas em LOTE (uma
// consulta por tabela envolvida, para a página inteira) — nunca uma por linha.
// ============================================================================
import { getResource } from './resources';
import type { Row, Store, Tx } from './store';
import { HttpError } from './errors';
import { apenasDigitos, cepNormalizado, cpfValido, cnpjValido, ufValida } from './documentos';
import { EMPRESA_PADRAO, type EscopoEmpresa } from './empresa';

/** Tipos de representante aceitos (o banco repete a lista no CHECK). */
export const TIPOS_REPRESENTANTE = [
  'INTERNO',
  'EXTERNO',
  'REPRESENTANTE_COMERCIAL',
  'SUPERVISOR',
  'COORDENADOR',
  'GERENTE',
  'PARCEIRO',
  'TERCEIRIZADO',
] as const;

export const TIPOS_PESSOA = ['PF', 'PJ'] as const;

export type TipoRepresentante = (typeof TIPOS_REPRESENTANTE)[number];
export type TipoPessoa = (typeof TIPOS_PESSOA)[number];

/** Prefixo do código comercial gerado quando o operador não informa um. */
export const PREFIXO_CODIGO = 'REP';

/** Espaços duplicados/bordas fora; nada além disso é reescrito. */
export function normalizarTexto(v: unknown): string {
  return String(v ?? '').trim().replace(/\s{2,}/g, ' ');
}

/** Código comercial: maiúsculo, sem espaços internos, separador `-` preservado. */
export function codigoNormalizado(v: unknown): string | null {
  const s = String(v ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  return s === '' ? null : s;
}

function diaISO(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const hojeISO = () => new Date().toISOString().slice(0, 10);

/** Campos de texto que só precisam perder espaços duplicados nas bordas. */
const TEXTOS_LIVRES = [
  'nome',
  'razao_social',
  'nome_fantasia',
  'cargo',
  'registro_profissional',
  'orgao_registro',
  'regiao',
  'logradouro',
  'numero',
  'complemento',
  'bairro',
  'cidade',
  'pais',
  'observacoes',
] as const;

// ----------------------------------------------------------------------------
// CÓDIGO COMERCIAL
// ----------------------------------------------------------------------------

/**
 * Próximo código livre da empresa no padrão `REP00001`.
 *
 * A conta é feita sobre os códigos JÁ existentes (uma consulta por empresa, sem
 * N+1) e considera também o id para não regerar um código que já pertence a um
 * registro legado sem `codigo`. O índice único parcial
 * `uq_representantes_empresa_codigo` é a garantia final contra corrida.
 */
export async function proximoCodigoRepresentante(s: Store, empresaId: number, tx?: Tx): Promise<string> {
  const r = getResource('representantes')!;
  const lista = await s.list(
    r,
    { page: 1, pageSize: 100_000, filter: { empresa_id: empresaId } },
    tx
  );
  let maior = 0;
  for (const row of lista.rows) {
    const codigo = String(row.codigo ?? '').trim().toUpperCase();
    const m = /^REP-?(\d+)$/.exec(codigo);
    if (m) {
      maior = Math.max(maior, Number(m[1]));
      continue;
    }
    maior = Math.max(maior, Number(row.id) || 0);
  }
  return `${PREFIXO_CODIGO}${String(maior + 1).padStart(5, '0')}`;
}

/** Representante da MESMA empresa com o código informado (comparação sem caixa). */
async function representantePorCodigo(
  s: Store,
  codigo: string,
  empresaId: number,
  excluirId: number | null,
  tx?: Tx
): Promise<Row | null> {
  const r = getResource('representantes')!;
  const alvo = codigo.trim().toUpperCase();
  const lista = await s.list(r, { page: 1, pageSize: 100_000, filter: { empresa_id: empresaId } }, tx);
  return (
    lista.rows.find(
      (row) =>
        Number(row.id) !== Number(excluirId ?? -1) &&
        String(row.codigo ?? '').trim().toUpperCase() === alvo
    ) ?? null
  );
}

/**
 * Representante da MESMA empresa com o mesmo documento (comparação por
 * dígitos — cadastro legado/importação pode guardar máscara).
 */
async function representantePorDocumento(
  s: Store,
  campo: 'cpf' | 'cnpj',
  digitos: string,
  empresaId: number,
  excluirId: number | null,
  tx?: Tx
): Promise<Row | null> {
  if (!digitos) return null;
  const r = getResource('representantes')!;
  const lista = await s.list(r, { page: 1, pageSize: 100_000, filter: { empresa_id: empresaId } }, tx);
  return (
    lista.rows.find(
      (row) => Number(row.id) !== Number(excluirId ?? -1) && apenasDigitos(row[campo]) === digitos
    ) ?? null
  );
}

// ----------------------------------------------------------------------------
// VALIDAÇÃO DO CADASTRO
// ----------------------------------------------------------------------------

export type OpcoesRepresentante = { body?: unknown; tx?: Tx };

/**
 * Valida e NORMALIZA o payload do representante (o objeto é mutado: o que entra
 * no banco é o formato canônico). `body` bruto permite distinguir "campo não
 * informado" de "campo informado vazio" — necessário para gerar código e para
 * a coerência de status.
 *
 * Roda nos dois caminhos (criação e edição) e antes de qualquer escrita, para
 * que planilha, integração e chamada direta à API tenham a mesma regra da tela.
 */
export async function validarRegrasRepresentante(
  s: Store,
  data: Row,
  before: Row | null,
  empresaId: number,
  opts: OpcoesRepresentante = {}
): Promise<void> {
  const body = (opts.body && typeof opts.body === 'object' ? opts.body : {}) as Record<string, unknown>;
  const informou = (campo: string) => Object.prototype.hasOwnProperty.call(body, campo);

  // ---- 1) Textos limpos ----------------------------------------------------
  for (const campo of TEXTOS_LIVRES) {
    if (typeof data[campo] === 'string') data[campo] = normalizarTexto(data[campo]);
  }

  // ---- 2) CÓDIGO COMERCIAL: único por empresa, gerado quando em branco -----
  const codigoInformado = data.codigo !== undefined ? codigoNormalizado(data.codigo) : null;
  const codigoAnterior = codigoNormalizado(before?.codigo);
  let codigo = data.codigo !== undefined ? codigoInformado : codigoAnterior;
  // Código é PRESERVADO: limpar o campo na edição não apaga o identificador
  // histórico; na criação em branco, o servidor gera o próximo.
  if (!codigo && before) codigo = codigoAnterior;
  if (!codigo) codigo = await proximoCodigoRepresentante(s, empresaId, opts.tx);
  if (codigo) {
    const colisao = await representantePorCodigo(s, codigo, empresaId, before ? Number(before.id) : null, opts.tx);
    if (colisao) {
      const msg = `Já existe um representante com o código “${codigo}” nesta empresa.`;
      throw new HttpError(409, msg, { codigo: 'Código já usado' }, 'representante_codigo_duplicado');
    }
  }
  data.codigo = codigo;

  // ---- 3) TIPO DE PESSOA × DOCUMENTO --------------------------------------
  const tipoPessoa = String(data.tipo_pessoa ?? before?.tipo_pessoa ?? 'PF').trim().toUpperCase();
  if (!(TIPOS_PESSOA as readonly string[]).includes(tipoPessoa)) {
    throw new HttpError(400, 'Tipo de pessoa inválido: use PF (pessoa física) ou PJ (pessoa jurídica).', {
      tipo_pessoa: 'Escolha PF ou PJ',
    });
  }
  data.tipo_pessoa = tipoPessoa;

  const cpf = data.cpf !== undefined ? apenasDigitos(data.cpf) : apenasDigitos(before?.cpf);
  const cnpj = data.cnpj !== undefined ? apenasDigitos(data.cnpj) : apenasDigitos(before?.cnpj);

  if (cpf && cnpj) {
    const msg = 'Informe CPF (pessoa física) ou CNPJ (pessoa jurídica) — não os dois.';
    throw new HttpError(400, msg, { cpf: msg, cnpj: msg }, 'representante_documento_ambiguo');
  }
  if (tipoPessoa === 'PF' && cnpj) {
    const msg = 'Pessoa física usa CPF. Remova o CNPJ ou mude o tipo de pessoa para jurídica.';
    throw new HttpError(400, msg, { cnpj: msg }, 'representante_documento_incoerente');
  }
  if (tipoPessoa === 'PJ' && cpf) {
    const msg = 'Pessoa jurídica usa CNPJ. Remova o CPF ou mude o tipo de pessoa para física.';
    throw new HttpError(400, msg, { cpf: msg }, 'representante_documento_incoerente');
  }
  if (cpf && !cpfValido(cpf)) {
    throw new HttpError(400, 'CPF inválido.', { cpf: 'CPF inválido.' }, 'representante_documento_invalido');
  }
  if (cnpj && !cnpjValido(cnpj)) {
    throw new HttpError(400, 'CNPJ inválido.', { cnpj: 'CNPJ inválido.' }, 'representante_documento_invalido');
  }
  if (tipoPessoa === 'PJ' && !cnpj) {
    const msg = 'Pessoa jurídica exige CNPJ válido. Informe o CNPJ ou mude o tipo de pessoa para física.';
    throw new HttpError(400, msg, { cnpj: 'CNPJ é obrigatório para PJ' }, 'representante_cnpj_obrigatorio');
  }
  // O documento nunca é gravado como "vazio": nulo é a ausência canônica.
  if (cpf) data.cpf = cpf;
  if (cnpj) data.cnpj = cnpj;

  // Unicidade POR EMPRESA — mensagem amigável (índice parcial é a garantia final).
  if (cpf) {
    const existente = await representantePorDocumento(s, 'cpf', cpf, empresaId, before ? Number(before.id) : null, opts.tx);
    if (existente) {
      const msg = 'Já existe um representante cadastrado com este CPF nesta empresa.';
      throw new HttpError(409, msg, { cpf: 'Já cadastrado' }, 'representante_duplicado');
    }
  }
  if (cnpj) {
    const existente = await representantePorDocumento(s, 'cnpj', cnpj, empresaId, before ? Number(before.id) : null, opts.tx);
    if (existente) {
      const msg = 'Já existe um representante cadastrado com este CNPJ nesta empresa.';
      throw new HttpError(409, msg, { cnpj: 'Já cadastrado' }, 'representante_cnpj_duplicado');
    }
  }

  // ---- 4) TIPO DE REPRESENTANTE -------------------------------------------
  const tipo = String(data.tipo_representante ?? before?.tipo_representante ?? 'REPRESENTANTE_COMERCIAL')
    .trim()
    .toUpperCase();
  if (!(TIPOS_REPRESENTANTE as readonly string[]).includes(tipo)) {
    throw new HttpError(400, 'Tipo de representante inválido.', {
      tipo_representante: 'Escolha um tipo da lista',
    });
  }
  data.tipo_representante = tipo;

  // ---- 5) REGISTRO PROFISSIONAL -------------------------------------------
  const registro = normalizarTexto(data.registro_profissional ?? before?.registro_profissional);
  const orgao = normalizarTexto(data.orgao_registro ?? before?.orgao_registro);
  if (orgao && !registro) {
    const msg = 'Informe o número do registro profissional ou deixe o órgão em branco.';
    throw new HttpError(400, msg, { registro_profissional: msg }, 'representante_registro_incompleto');
  }
  if (orgao) data.orgao_registro = orgao.toUpperCase();

  // ---- 6) DATA DE NASCIMENTO ----------------------------------------------
  const nascimento = diaISO(data.data_nascimento ?? before?.data_nascimento);
  if (nascimento) {
    const hoje = hojeISO();
    if (nascimento > hoje) {
      throw new HttpError(400, 'Data de nascimento não pode ser futura.', { data_nascimento: 'Data futura' });
    }
    if (nascimento < '1900-01-01') {
      throw new HttpError(400, 'Data de nascimento inválida.', { data_nascimento: 'Data inválida' });
    }
  }

  // ---- 7) ENDEREÇO ESTRUTURADO COERENTE -----------------------------------
  const v = (campo: string) => {
    const valor = data[campo] !== undefined ? data[campo] : before?.[campo];
    return valor === null || valor === undefined ? '' : String(valor).trim();
  };
  const cep = data.cep !== undefined ? cepNormalizado(data.cep) : cepNormalizado(before?.cep);
  if (data.cep !== undefined && String(data.cep ?? '').trim() !== '' && !cep) {
    throw new HttpError(400, 'CEP inválido (8 dígitos).', { cep: 'CEP inválido (8 dígitos).' });
  }
  const uf = String(data.uf !== undefined ? data.uf ?? '' : before?.uf ?? '').trim().toUpperCase();
  if (uf && !ufValida(uf)) {
    throw new HttpError(400, 'UF inválida (ex.: SP, MG, RS).', { uf: 'UF inválida (ex.: SP, MG, RS)' });
  }
  if (uf) data.uf = uf;

  const logradouro = v('logradouro');
  const cidade = v('cidade');
  const temDetalheSemRua = ['numero', 'complemento', 'bairro'].some((campo) => v(campo) !== '');
  if (temDetalheSemRua && !logradouro) {
    const msg = 'Informe o logradouro do endereço (número, complemento e bairro dependem dele).';
    throw new HttpError(400, msg, { logradouro: msg }, 'representante_endereco_incompleto');
  }
  if (logradouro && (!cidade || !uf)) {
    const msg = 'Endereço com logradouro exige cidade e UF.';
    throw new HttpError(400, msg, { cidade: 'Informe a cidade', uf: 'Informe a UF' }, 'representante_endereco_incompleto');
  }
  const algumEndereco = !!(cep || logradouro || cidade || uf || v('bairro') || v('numero') || v('complemento'));
  if (algumEndereco && !String(data.pais ?? before?.pais ?? '').trim()) data.pais = 'Brasil';

  // ---- 8) DATAS PROFISSIONAIS × STATUS ------------------------------------
  const admissao = diaISO(data.admissao ?? before?.admissao);
  const desligamento = diaISO(data.desligamento !== undefined ? data.desligamento : before?.desligamento);
  if (desligamento && admissao && desligamento < admissao) {
    const msg = 'A data de desligamento não pode ser anterior à admissão.';
    throw new HttpError(400, msg, { desligamento: msg }, 'representante_desligamento_invalido');
  }
  if (desligamento) {
    // Quem foi desligado não recebe NOVAS atribuições. Se o operador marcar
    // "ativo" na mesma gravação, é incoerência — recusa com orientação (nada
    // de desativar em silêncio nem de apagar a data).
    const ativoExplicito = data.ativo !== undefined && data.ativo !== null ? data.ativo === true : null;
    if (ativoExplicito === true) {
      const msg = 'Representante desligado não pode ficar ativo. Desmarque “Ativo” ou remova a data de desligamento.';
      throw new HttpError(409, msg, { ativo: msg, desligamento: msg }, 'representante_desligado_ativo');
    }
    data.ativo = false;
  } else if (informou('desligamento') && data.desligamento === null && before?.desligamento) {
    // Reverter o desligamento não reativa automaticamente: quem decide é o
    // operador (a vida funcional pode ter voltado por outro motivo).
    if (data.ativo === undefined) data.ativo = before.ativo === true;
  }

  // ---- 9) WHATSAPP: o cadastro não inventa número --------------------------
  // O WhatsApp é um telefone profissional; quando informado, passa pela mesma
  // validação de `phone` (validatePayload). Nada a completar aqui.
}

// ----------------------------------------------------------------------------
// APRESENTAÇÃO DA LISTAGEM (lote, sem N+1)
// ----------------------------------------------------------------------------

export type ResumoComercial = {
  equipes: { equipe_id: number; nome: string; papel: string; entrada: string | null; saida: string | null }[];
  carteira: { vigentes: number; total: number };
};

/**
 * Resumo comercial de VÁRIOS representantes em UMA consulta por tabela.
 *
 *   • equipes vigentes → `equipe_membros` (status ativo e sem saída) + nome da
 *     equipe em `equipes_comerciais`;
 *   • carteira → `representante_cliente`, contando vínculos VIGENTES (sem fim)
 *     e o total histórico.
 *
 * A verdade continua nos domínios próprios: isto é PROJEÇÃO de leitura para a
 * tela, nunca uma coluna nova em `representantes`.
 */
export async function resumosComerciais(
  s: Store,
  ids: number[],
  empresaId: number,
  tx?: Tx
): Promise<Map<number, ResumoComercial>> {
  const alvo = new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0));
  const out = new Map<number, ResumoComercial>();
  for (const id of alvo) out.set(id, { equipes: [], carteira: { vigentes: 0, total: 0 } });
  if (!alvo.size) return out;

  const rMembros = getResource('equipe_membros');
  const rEquipes = getResource('equipes_comerciais');
  const rCarteira = getResource('representante_cliente');
  if (!rMembros || !rEquipes || !rCarteira) return out;

  const [membros, equipes, carteira] = await Promise.all([
    s.list(rMembros, { page: 1, pageSize: 50_000, filter: { empresa_id: empresaId } }, tx),
    s.list(rEquipes, { page: 1, pageSize: 50_000, filter: { empresa_id: empresaId } }, tx),
    s.list(rCarteira, { page: 1, pageSize: 50_000, filter: { empresa_id: empresaId } }, tx),
  ]);

  const nomeEquipe = new Map(equipes.rows.map((e) => [Number(e.id), String(e.nome ?? `#${e.id}`)]));
  const hoje = hojeISO();
  for (const m of membros.rows) {
    const repId = Number(m.representante_id);
    const resumo = out.get(repId);
    if (!resumo) continue;
    // Vigente: status ativo e sem data de saída (histórico nunca é apagado).
    if (String(m.status ?? 'ativo') !== 'ativo' || diaISO(m.saida)) continue;
    resumo.equipes.push({
      equipe_id: Number(m.equipe_id),
      nome: nomeEquipe.get(Number(m.equipe_id)) ?? `#${m.equipe_id}`,
      papel: String(m.papel ?? 'membro'),
      entrada: diaISO(m.entrada),
      saida: diaISO(m.saida),
    });
  }
  for (const c of carteira.rows) {
    const repId = Number(c.representante_id);
    const resumo = out.get(repId);
    if (!resumo) continue;
    if (String(c.status ?? 'ativo') === 'cancelado') continue;
    resumo.carteira.total += 1;
    const fim = diaISO(c.fim);
    const inicio = diaISO(c.inicio);
    const vigente = (!fim || fim >= hoje) && (!inicio || inicio <= hoje) && String(c.status ?? 'ativo') === 'ativo';
    if (vigente) resumo.carteira.vigentes += 1;
  }
  return out;
}

/** Texto de apresentação: nomes das equipes vigentes (ou null). */
export function rotuloEquipes(resumo: ResumoComercial | undefined): string | null {
  if (!resumo || !resumo.equipes.length) return null;
  return resumo.equipes.map((e) => e.nome).join(' · ');
}

/**
 * Anota, nas linhas da página, os campos VIRTUAIS de apresentação:
 *   equipe_label          nomes das equipes vigentes
 *   equipe_ids            ids das equipes vigentes
 *   equipe_count          quantidade de equipes vigentes
 *   carteira_vinculos     vínculos de carteira vigentes
 *   carteira_historico    vínculos de carteira (todos, menos cancelados)
 *
 * Nada aqui é escrito no banco e nada substitui as fontes oficiais.
 */
export async function anotarComercialRepresentantes(
  s: Store,
  rows: Row[],
  escopo?: EscopoEmpresa
): Promise<void> {
  if (!rows.length) return;
  // A empresa de cada linha manda. No modo consolidado (sem `escopo`, leitura
  // multiempresa autorizada) as linhas podem ser de empresas diferentes: o
  // resumo é resolvido POR EMPRESA (poucas), nunca misturando a composição de
  // equipe nem a carteira de outra empresa.
  const porEmpresa = new Map<number, Row[]>();
  for (const row of rows) {
    const empresaId = escopo && !escopo.consolidado ? escopo.empresaId : Number(row.empresa_id ?? escopo?.empresaId ?? EMPRESA_PADRAO);
    const lista = porEmpresa.get(empresaId);
    if (lista) lista.push(row);
    else porEmpresa.set(empresaId, [row]);
  }

  for (const [empresaId, linhas] of porEmpresa) {
    const ids = linhas.map((row) => Number(row.id)).filter((n) => Number.isInteger(n) && n > 0);
    const resumos = await resumosComerciais(s, ids, empresaId);
    for (const row of linhas) {
      const resumo = resumos.get(Number(row.id));
      row.equipe_ids = resumo?.equipes.map((e) => e.equipe_id) ?? [];
      row.equipe_label = rotuloEquipes(resumo);
      row.equipe_count = resumo?.equipes.length ?? 0;
      row.carteira_vinculos = resumo?.carteira.vigentes ?? 0;
      row.carteira_historico = resumo?.carteira.total ?? 0;
    }
  }
}
