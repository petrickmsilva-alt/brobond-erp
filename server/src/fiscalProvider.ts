// ============================================================================
// FiscalProvider — contrato de emissão de documento fiscal.
//
// REGRA QUE GOVERNA ESTE ARQUIVO INTEIRO:
//   O sistema NUNCA simula emissão como se fosse emissão real.
//
// Em termos concretos, isso significa que:
//   • só um provedor REAL, com credenciais REAIS, devolve `autorizado`;
//   • sem provedor configurado, a resposta é `nao_configurado` — um estado
//     explícito, que a UI mostra como "NÃO EMITIDA" e que NÃO baixa estoque,
//     não lança financeiro e não grava número de nota;
//   • o próprio banco recusa `status='autorizado'` sem chave + protocolo
//     (CHECK documentos_fiscais_autorizado_tem_prova, migration 0020). Mesmo
//     um bug nesta camada não consegue inventar uma nota.
//
// Trocar de provedor é implementar esta interface e registrar em
// `registrarFiscalProvider`. Focus NFe e PlugNotas já têm o adaptador; ambos
// precisam de credencial para sair do estado `nao_configurado`.
// ============================================================================
import type { Row } from './store';
import { decifrarSegredo } from './segredos';

/** Estado devolvido pelo provedor — espelha a máquina de estados do banco. */
export type StatusFiscal =
  | 'nao_configurado'
  | 'processando'
  | 'autorizado'
  | 'rejeitado'
  | 'cancelado'
  | 'inutilizado'
  | 'erro';

export type EmitenteFiscal = {
  cnpj: string;
  ie: string | null;
  razao_social: string;
  nome_fantasia: string | null;
  crt: string | null;
  endereco: EnderecoFiscal;
};

export type EnderecoFiscal = {
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  codigo_municipio: string | null;
  uf: string | null;
  pais: string;
};

export type DestinatarioFiscal = {
  documento: string;
  tipo: 'cpf' | 'cnpj' | null;
  nome: string;
  ie: string | null;
  indicador_ie: '1' | '2' | '9';
  email: string | null;
  telefone: string | null;
  endereco: EnderecoFiscal;
};

export type ItemFiscal = {
  numero: number;
  codigo: string;
  descricao: string;
  gtin: string | null;
  gtin_tributario: string | null;
  ncm: string | null;
  cest: string | null;
  cfop: string | null;
  origem: string;
  unidade: string;
  quantidade: number;
  /** Tudo em CENTAVOS — a mesma convenção do motor financeiro. */
  valor_unitario_cents: number;
  valor_total_cents: number;
  desconto_cents: number;
  icms_cst: string | null;
  csosn: string | null;
  icms_aliquota: number | null;
  icms_valor_cents: number;
  pis_cst: string | null;
  pis_aliquota: number | null;
  pis_valor_cents: number;
  cofins_cst: string | null;
  cofins_aliquota: number | null;
  cofins_valor_cents: number;
  ipi_cst: string | null;
  ipi_aliquota: number | null;
  ipi_valor_cents: number;
};

export type DocumentoFiscalPayload = {
  /** '55' NF-e | '65' NFC-e */
  modelo: '55' | '65';
  serie: number;
  numero: number;
  natureza_operacao: string;
  ambiente: 'homologacao' | 'producao';
  consumidor_final: boolean;
  emitente: EmitenteFiscal;
  destinatario: DestinatarioFiscal;
  itens: ItemFiscal[];
  frete_cents: number;
  desconto_cents: number;
  total_produtos_cents: number;
  total_cents: number;
  total_icms_cents: number;
  total_pis_cents: number;
  total_cofins_cents: number;
  total_ipi_cents: number;
  informacoes_complementares: string | null;
  /** Chave de idempotência — o provedor devolve o MESMO documento se repetir. */
  referencia: string;
};

export type RespostaFiscal = {
  status: StatusFiscal;
  /** Legível para o usuário final — aparece na tela e na auditoria. */
  mensagem: string;
  chave_acesso?: string | null;
  protocolo?: string | null;
  numero?: number | null;
  serie?: number | null;
  xml?: string | null;
  danfe_url?: string | null;
  provider_ref?: string | null;
  /** Resposta bruta do provedor, já sem segredos. */
  bruto?: Record<string, unknown> | null;
};

export type CredenciaisFiscais = {
  provider: string;
  token: string | null;
  base_url: string | null;
  ambiente: 'homologacao' | 'producao';
  cnpj: string;
};

export interface FiscalProvider {
  readonly nome: string;
  /** Há credenciais suficientes para falar com este provedor? */
  configurado(cred: CredenciaisFiscais): boolean;
  emitir(doc: DocumentoFiscalPayload, cred: CredenciaisFiscais): Promise<RespostaFiscal>;
  consultar(referencia: string, cred: CredenciaisFiscais): Promise<RespostaFiscal>;
  cancelar(referencia: string, justificativa: string, cred: CredenciaisFiscais): Promise<RespostaFiscal>;
  inutilizar(
    faixa: { serie: number; numero_inicial: number; numero_final: number; justificativa: string; modelo: '55' | '65' },
    cred: CredenciaisFiscais
  ): Promise<RespostaFiscal>;
}

// ---------------------------------------------------------------------------
// Provedor NULO — o padrão quando nada está configurado.
//
// Ele não emite, não finge que emitiu e não deixa dúvida sobre isso. É a
// implementação literal da regra "se não houver credenciais/provedor, o
// sistema deve retornar estado claramente NÃO EMITIDO".
// ---------------------------------------------------------------------------
const MSG_NAO_CONFIGURADO =
  'Emissão fiscal NÃO configurada: nenhum provedor (Focus NFe / PlugNotas) está ligado para esta empresa. ' +
  'O documento ficou registrado como NÃO EMITIDO — não há nota, não há chave e nada foi transmitido à SEFAZ. ' +
  'Configure o provedor, o certificado e o ambiente em Configurações Fiscais da empresa.';

export const provedorNulo: FiscalProvider = {
  nome: 'nenhum',
  configurado: () => false,
  async emitir() {
    return { status: 'nao_configurado', mensagem: MSG_NAO_CONFIGURADO };
  },
  async consultar() {
    return { status: 'nao_configurado', mensagem: MSG_NAO_CONFIGURADO };
  },
  async cancelar() {
    return { status: 'nao_configurado', mensagem: MSG_NAO_CONFIGURADO };
  },
  async inutilizar() {
    return { status: 'nao_configurado', mensagem: MSG_NAO_CONFIGURADO };
  },
};

// ---------------------------------------------------------------------------
// Utilidades compartilhadas pelos adaptadores HTTP
// ---------------------------------------------------------------------------
const TIMEOUT_MS = Number(process.env.FISCAL_TIMEOUT_MS) || 30_000;

/** Centavos → string decimal ("12345" → "123.45"), formato dos provedores. */
export function centsParaDecimal(cents: number): string {
  return (Math.round(cents) / 100).toFixed(2);
}

async function requisicao(
  url: string,
  init: RequestInit & { token?: string; auth?: 'basic' | 'header' }
): Promise<{ ok: boolean; status: number; corpo: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...((init.headers as Record<string, string>) || {}),
    };
    if (init.token) {
      headers.authorization =
        init.auth === 'basic' ? `Basic ${Buffer.from(`${init.token}:`).toString('base64')}` : init.token;
    }
    const resp = await fetch(url, { ...init, headers, signal: controller.signal });
    const texto = await resp.text();
    let corpo: any = null;
    try {
      corpo = texto ? JSON.parse(texto) : null;
    } catch {
      corpo = { raw: texto.slice(0, 2000) };
    }
    return { ok: resp.ok, status: resp.status, corpo };
  } finally {
    clearTimeout(timer);
  }
}

/** Remove do eco do provedor tudo que não deve dormir no nosso banco. */
export function semSegredos(obj: unknown): Record<string, unknown> | null {
  if (!obj || typeof obj !== 'object') return null;
  const proibidas = /token|senha|password|secret|certificad|csc|authorization/i;
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (proibidas.test(k)) continue;
    saida[k] = typeof v === 'object' && v !== null ? semSegredos(v) : v;
  }
  return saida;
}

// ---------------------------------------------------------------------------
// Focus NFe (https://focusnfe.com.br) — autenticação Basic com o token.
// ---------------------------------------------------------------------------
function baseFocus(cred: CredenciaisFiscais): string {
  if (cred.base_url) return cred.base_url.replace(/\/$/, '');
  return cred.ambiente === 'producao' ? 'https://api.focusnfe.com.br' : 'https://homologacao.focusnfe.com.br';
}

function statusDoFocus(corpo: any): StatusFiscal {
  switch (String(corpo?.status || '')) {
    case 'autorizado':
      return 'autorizado';
    case 'cancelado':
      return 'cancelado';
    case 'processando_autorizacao':
      return 'processando';
    case 'erro_autorizacao':
    case 'denegado':
      return 'rejeitado';
    default:
      return 'erro';
  }
}

export const focusNfe: FiscalProvider = {
  nome: 'focus',
  configurado: (cred) => Boolean(cred.token && cred.token.trim()),

  async emitir(doc, cred) {
    if (!this.configurado(cred)) return provedorNulo.emitir(doc, cred);
    const recurso = doc.modelo === '65' ? 'nfce' : 'nfe';
    const { ok, status, corpo } = await requisicao(
      `${baseFocus(cred)}/v2/${recurso}?ref=${encodeURIComponent(doc.referencia)}`,
      { method: 'POST', token: cred.token!, auth: 'basic', body: JSON.stringify(paraFocus(doc)) }
    );
    // 422 do Focus = rejeição de validação (erro do nosso lado, não da rede).
    if (!ok && status !== 422) {
      return { status: 'erro', mensagem: `Focus NFe respondeu HTTP ${status}: ${corpo?.mensagem || 'falha na comunicação'}`, bruto: semSegredos(corpo) };
    }
    const estado = statusDoFocus(corpo);
    return {
      status: estado,
      mensagem: String(corpo?.mensagem_sefaz || corpo?.mensagem || corpo?.erros?.[0]?.mensagem || 'Documento enviado ao Focus NFe.'),
      chave_acesso: corpo?.chave_nfe ? String(corpo.chave_nfe).replace(/\D/g, '') : null,
      protocolo: corpo?.protocolo ? String(corpo.protocolo) : null,
      numero: corpo?.numero ? Number(corpo.numero) : null,
      serie: corpo?.serie ? Number(corpo.serie) : null,
      danfe_url: corpo?.caminho_danfe ? `${baseFocus(cred)}${corpo.caminho_danfe}` : null,
      provider_ref: doc.referencia,
      bruto: semSegredos(corpo),
    };
  },

  async consultar(referencia, cred) {
    if (!this.configurado(cred)) return provedorNulo.consultar(referencia, cred);
    const { ok, status, corpo } = await requisicao(
      `${baseFocus(cred)}/v2/nfe/${encodeURIComponent(referencia)}?completa=1`,
      { method: 'GET', token: cred.token!, auth: 'basic' }
    );
    if (!ok && status !== 404) {
      return { status: 'erro', mensagem: `Focus NFe respondeu HTTP ${status} na consulta.`, bruto: semSegredos(corpo) };
    }
    return {
      status: statusDoFocus(corpo),
      mensagem: String(corpo?.mensagem_sefaz || corpo?.mensagem || 'Consulta concluída.'),
      chave_acesso: corpo?.chave_nfe ? String(corpo.chave_nfe).replace(/\D/g, '') : null,
      protocolo: corpo?.protocolo ? String(corpo.protocolo) : null,
      numero: corpo?.numero ? Number(corpo.numero) : null,
      serie: corpo?.serie ? Number(corpo.serie) : null,
      xml: typeof corpo?.xml === 'string' ? corpo.xml : null,
      danfe_url: corpo?.caminho_danfe ? `${baseFocus(cred)}${corpo.caminho_danfe}` : null,
      provider_ref: referencia,
      bruto: semSegredos(corpo),
    };
  },

  async cancelar(referencia, justificativa, cred) {
    if (!this.configurado(cred)) return provedorNulo.cancelar(referencia, justificativa, cred);
    const { ok, status, corpo } = await requisicao(`${baseFocus(cred)}/v2/nfe/${encodeURIComponent(referencia)}`, {
      method: 'DELETE',
      token: cred.token!,
      auth: 'basic',
      body: JSON.stringify({ justificativa }),
    });
    if (!ok) {
      return { status: 'erro', mensagem: `Focus NFe recusou o cancelamento (HTTP ${status}): ${corpo?.mensagem || ''}`.trim(), bruto: semSegredos(corpo) };
    }
    return {
      status: String(corpo?.status || '') === 'cancelado' ? 'cancelado' : 'processando',
      mensagem: String(corpo?.mensagem_sefaz || corpo?.mensagem || 'Cancelamento solicitado.'),
      protocolo: corpo?.protocolo ? String(corpo.protocolo) : null,
      bruto: semSegredos(corpo),
    };
  },

  async inutilizar(faixa, cred) {
    if (!this.configurado(cred)) return provedorNulo.inutilizar(faixa, cred);
    const { ok, status, corpo } = await requisicao(`${baseFocus(cred)}/v2/nfe/inutilizacao`, {
      method: 'POST',
      token: cred.token!,
      auth: 'basic',
      body: JSON.stringify({
        cnpj: cred.cnpj,
        serie: faixa.serie,
        numero_inicial: faixa.numero_inicial,
        numero_final: faixa.numero_final,
        justificativa: faixa.justificativa,
      }),
    });
    if (!ok) {
      return { status: 'erro', mensagem: `Focus NFe recusou a inutilização (HTTP ${status}): ${corpo?.mensagem || ''}`.trim(), bruto: semSegredos(corpo) };
    }
    return {
      status: corpo?.status === 'inutilizado' ? 'inutilizado' : 'processando',
      mensagem: String(corpo?.mensagem_sefaz || corpo?.mensagem || 'Inutilização solicitada.'),
      protocolo: corpo?.numero_protocolo ? String(corpo.numero_protocolo) : null,
      bruto: semSegredos(corpo),
    };
  },
};

/** Tradução do payload canônico para o formato do Focus NFe. */
export function paraFocus(doc: DocumentoFiscalPayload): Record<string, unknown> {
  const e = doc.emitente;
  const d = doc.destinatario;
  return {
    natureza_operacao: doc.natureza_operacao,
    data_emissao: new Date().toISOString(),
    tipo_documento: 1,
    finalidade_emissao: 1,
    consumidor_final: doc.consumidor_final ? 1 : 0,
    presenca_comprador: doc.modelo === '65' ? 1 : 9,
    serie: doc.serie,
    numero: doc.numero,
    cnpj_emitente: e.cnpj,
    inscricao_estadual_emitente: e.ie,
    nome_emitente: e.razao_social,
    nome_fantasia_emitente: e.nome_fantasia,
    regime_tributario_emitente: e.crt,
    logradouro_emitente: e.endereco.logradouro,
    numero_emitente: e.endereco.numero,
    bairro_emitente: e.endereco.bairro,
    municipio_emitente: e.endereco.cidade,
    codigo_municipio_emitente: e.endereco.codigo_municipio,
    uf_emitente: e.endereco.uf,
    cep_emitente: e.endereco.cep,
    [d.tipo === 'cpf' ? 'cpf_destinatario' : 'cnpj_destinatario']: d.documento,
    nome_destinatario: d.nome,
    inscricao_estadual_destinatario: d.ie,
    indicador_inscricao_estadual_destinatario: Number(d.indicador_ie),
    email_destinatario: d.email,
    telefone_destinatario: d.telefone,
    logradouro_destinatario: d.endereco.logradouro,
    numero_destinatario: d.endereco.numero,
    complemento_destinatario: d.endereco.complemento,
    bairro_destinatario: d.endereco.bairro,
    municipio_destinatario: d.endereco.cidade,
    codigo_municipio_destinatario: d.endereco.codigo_municipio,
    uf_destinatario: d.endereco.uf,
    cep_destinatario: d.endereco.cep,
    valor_frete: centsParaDecimal(doc.frete_cents),
    valor_desconto: centsParaDecimal(doc.desconto_cents),
    valor_produtos: centsParaDecimal(doc.total_produtos_cents),
    valor_total: centsParaDecimal(doc.total_cents),
    informacoes_adicionais_contribuinte: doc.informacoes_complementares,
    items: doc.itens.map((it) => ({
      numero_item: it.numero,
      codigo_produto: it.codigo,
      descricao: it.descricao,
      codigo_ncm: it.ncm,
      cest: it.cest,
      cfop: it.cfop,
      codigo_barras_comercial: it.gtin,
      codigo_barras_tributavel: it.gtin_tributario,
      unidade_comercial: it.unidade,
      quantidade_comercial: it.quantidade,
      valor_unitario_comercial: centsParaDecimal(it.valor_unitario_cents),
      unidade_tributavel: it.unidade,
      quantidade_tributavel: it.quantidade,
      valor_unitario_tributavel: centsParaDecimal(it.valor_unitario_cents),
      valor_bruto: centsParaDecimal(it.valor_total_cents),
      valor_desconto: centsParaDecimal(it.desconto_cents),
      icms_origem: it.origem,
      icms_situacao_tributaria: it.csosn || it.icms_cst,
      icms_aliquota: it.icms_aliquota,
      icms_valor: centsParaDecimal(it.icms_valor_cents),
      pis_situacao_tributaria: it.pis_cst,
      pis_aliquota_porcentual: it.pis_aliquota,
      pis_valor: centsParaDecimal(it.pis_valor_cents),
      cofins_situacao_tributaria: it.cofins_cst,
      cofins_aliquota_porcentual: it.cofins_aliquota,
      cofins_valor: centsParaDecimal(it.cofins_valor_cents),
      ipi_situacao_tributaria: it.ipi_cst,
      ipi_aliquota: it.ipi_aliquota,
      ipi_valor: centsParaDecimal(it.ipi_valor_cents),
    })),
  };
}

// ---------------------------------------------------------------------------
// PlugNotas (https://plugnotas.com.br) — autenticação por header `x-api-key`.
// ---------------------------------------------------------------------------
function basePlugNotas(cred: CredenciaisFiscais): string {
  if (cred.base_url) return cred.base_url.replace(/\/$/, '');
  return cred.ambiente === 'producao' ? 'https://api.plugnotas.com.br' : 'https://api.sandbox.plugnotas.com.br';
}

function statusDoPlugNotas(corpo: any): StatusFiscal {
  const s = String(corpo?.situacao || corpo?.status || '').toUpperCase();
  if (s.includes('CONCLUID') || s === 'AUTORIZADO') return 'autorizado';
  if (s.includes('CANCEL')) return 'cancelado';
  if (s.includes('PROCESS') || s.includes('PENDENTE')) return 'processando';
  if (s.includes('REJEIT') || s.includes('DENEG')) return 'rejeitado';
  return 'erro';
}

export const plugNotas: FiscalProvider = {
  nome: 'plugnotas',
  configurado: (cred) => Boolean(cred.token && cred.token.trim()),

  async emitir(doc, cred) {
    if (!this.configurado(cred)) return provedorNulo.emitir(doc, cred);
    const { ok, status, corpo } = await requisicao(`${basePlugNotas(cred)}/nfe`, {
      method: 'POST',
      headers: { 'x-api-key': cred.token! },
      body: JSON.stringify([paraPlugNotas(doc)]),
    });
    if (!ok) {
      return { status: 'erro', mensagem: `PlugNotas respondeu HTTP ${status}: ${corpo?.message || corpo?.error?.message || 'falha na comunicação'}`, bruto: semSegredos(corpo) };
    }
    const dados = corpo?.documents?.[0] ?? corpo;
    return {
      status: statusDoPlugNotas(dados),
      mensagem: String(dados?.message || corpo?.message || 'Documento enviado ao PlugNotas.'),
      chave_acesso: dados?.chave ? String(dados.chave).replace(/\D/g, '') : null,
      protocolo: dados?.protocolo ? String(dados.protocolo) : null,
      provider_ref: dados?.id ? String(dados.id) : doc.referencia,
      bruto: semSegredos(corpo),
    };
  },

  async consultar(referencia, cred) {
    if (!this.configurado(cred)) return provedorNulo.consultar(referencia, cred);
    const { ok, status, corpo } = await requisicao(`${basePlugNotas(cred)}/nfe/${encodeURIComponent(referencia)}`, {
      method: 'GET',
      headers: { 'x-api-key': cred.token! },
    });
    if (!ok && status !== 404) {
      return { status: 'erro', mensagem: `PlugNotas respondeu HTTP ${status} na consulta.`, bruto: semSegredos(corpo) };
    }
    return {
      status: statusDoPlugNotas(corpo),
      mensagem: String(corpo?.message || 'Consulta concluída.'),
      chave_acesso: corpo?.chave ? String(corpo.chave).replace(/\D/g, '') : null,
      protocolo: corpo?.protocolo ? String(corpo.protocolo) : null,
      xml: typeof corpo?.xml === 'string' ? corpo.xml : null,
      danfe_url: corpo?.danfe ? String(corpo.danfe) : null,
      provider_ref: referencia,
      bruto: semSegredos(corpo),
    };
  },

  async cancelar(referencia, justificativa, cred) {
    if (!this.configurado(cred)) return provedorNulo.cancelar(referencia, justificativa, cred);
    const { ok, status, corpo } = await requisicao(`${basePlugNotas(cred)}/nfe/${encodeURIComponent(referencia)}/cancelamento`, {
      method: 'POST',
      headers: { 'x-api-key': cred.token! },
      body: JSON.stringify({ justificativa }),
    });
    if (!ok) {
      return { status: 'erro', mensagem: `PlugNotas recusou o cancelamento (HTTP ${status}): ${corpo?.message || ''}`.trim(), bruto: semSegredos(corpo) };
    }
    return {
      status: statusDoPlugNotas(corpo),
      mensagem: String(corpo?.message || 'Cancelamento solicitado.'),
      protocolo: corpo?.protocolo ? String(corpo.protocolo) : null,
      bruto: semSegredos(corpo),
    };
  },

  async inutilizar(faixa, cred) {
    if (!this.configurado(cred)) return provedorNulo.inutilizar(faixa, cred);
    const { ok, status, corpo } = await requisicao(`${basePlugNotas(cred)}/nfe/inutilizacao`, {
      method: 'POST',
      headers: { 'x-api-key': cred.token! },
      body: JSON.stringify({
        cpfCnpj: cred.cnpj,
        serie: faixa.serie,
        numeroInicial: faixa.numero_inicial,
        numeroFinal: faixa.numero_final,
        justificativa: faixa.justificativa,
      }),
    });
    if (!ok) {
      return { status: 'erro', mensagem: `PlugNotas recusou a inutilização (HTTP ${status}): ${corpo?.message || ''}`.trim(), bruto: semSegredos(corpo) };
    }
    return {
      status: corpo?.protocolo ? 'inutilizado' : 'processando',
      mensagem: String(corpo?.message || 'Inutilização solicitada.'),
      protocolo: corpo?.protocolo ? String(corpo.protocolo) : null,
      bruto: semSegredos(corpo),
    };
  },
};

/** Tradução do payload canônico para o formato do PlugNotas. */
export function paraPlugNotas(doc: DocumentoFiscalPayload): Record<string, unknown> {
  const d = doc.destinatario;
  return {
    idIntegracao: doc.referencia,
    presencial: doc.modelo === '65',
    consumidorFinal: doc.consumidor_final,
    natureza: doc.natureza_operacao,
    emitente: { cpfCnpj: doc.emitente.cnpj, serie: doc.serie, numero: doc.numero },
    destinatario: {
      cpfCnpj: d.documento,
      razaoSocial: d.nome,
      inscricaoEstadual: d.ie,
      indicadorInscricaoEstadual: Number(d.indicador_ie),
      email: d.email,
      telefone: d.telefone,
      endereco: {
        cep: d.endereco.cep,
        logradouro: d.endereco.logradouro,
        numero: d.endereco.numero,
        complemento: d.endereco.complemento,
        bairro: d.endereco.bairro,
        municipio: d.endereco.cidade,
        codigoCidade: d.endereco.codigo_municipio,
        uf: d.endereco.uf,
      },
    },
    itens: doc.itens.map((it) => ({
      codigo: it.codigo,
      descricao: it.descricao,
      ncm: it.ncm,
      cest: it.cest,
      cfop: it.cfop,
      unidade: it.unidade,
      quantidade: it.quantidade,
      valorUnitario: Number(centsParaDecimal(it.valor_unitario_cents)),
      valorTotal: Number(centsParaDecimal(it.valor_total_cents)),
      origem: Number(it.origem),
      tributos: {
        icms: { cst: it.icms_cst, csosn: it.csosn, aliquota: it.icms_aliquota, valor: Number(centsParaDecimal(it.icms_valor_cents)) },
        pis: { cst: it.pis_cst, aliquota: it.pis_aliquota, valor: Number(centsParaDecimal(it.pis_valor_cents)) },
        cofins: { cst: it.cofins_cst, aliquota: it.cofins_aliquota, valor: Number(centsParaDecimal(it.cofins_valor_cents)) },
        ipi: { cst: it.ipi_cst, aliquota: it.ipi_aliquota, valor: Number(centsParaDecimal(it.ipi_valor_cents)) },
      },
    })),
    pagamento: { formaPagamento: '99', valor: Number(centsParaDecimal(doc.total_cents)) },
    informacoesAdicionais: { contribuinte: doc.informacoes_complementares },
  };
}

// ---------------------------------------------------------------------------
// Registro de provedores
// ---------------------------------------------------------------------------
const PROVIDERS = new Map<string, FiscalProvider>([
  [provedorNulo.nome, provedorNulo],
  [focusNfe.nome, focusNfe],
  [plugNotas.nome, plugNotas],
]);

/** Registra (ou substitui) um provedor — ponto de extensão e de teste. */
export function registrarFiscalProvider(provider: FiscalProvider): void {
  PROVIDERS.set(provider.nome, provider);
}

/** Provedor pelo nome. Desconhecido → provedor nulo (nunca emite). */
export function obterFiscalProvider(nome: string | null | undefined): FiscalProvider {
  return PROVIDERS.get(String(nome || 'nenhum')) ?? provedorNulo;
}

export function provedoresDisponiveis(): string[] {
  return [...PROVIDERS.keys()];
}

/**
 * Monta as credenciais a partir da configuração fiscal da empresa.
 * O token sai CIFRADO do banco e é decifrado aqui, no último momento.
 */
export function credenciaisDaEmpresa(config: Row, cnpjEmitente: unknown): CredenciaisFiscais {
  return {
    provider: String(config.provider || 'nenhum'),
    token: decifrarSegredo(config.provider_token_cifrado as string | null),
    base_url: config.provider_base_url ? String(config.provider_base_url) : null,
    ambiente: String(config.ambiente) === 'producao' ? 'producao' : 'homologacao',
    cnpj: String(cnpjEmitente ?? '').replace(/\D/g, ''),
  };
}
