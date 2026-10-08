// ============================================================================
// IMPORTAÇÃO / MIGRAÇÃO DE DADOS (CSV e XLSX) — camada segura da Fase P3.
//
//   POST /api/importar/preview    { tipo, conteudo, nome? }   → valida TUDO, linha a linha
//   POST /api/importar/confirmar  { tipo, conteudo, nome?, ignorarErros? } → importa em UMA transação
//   GET  /api/importar/modelo?tipo=…                          → CSV-modelo do tipo
//   GET  /api/importar/lotes                                  → trilha dos lotes já executados
//
// Tipos (migração da especificação §10):
//   produtos · variacoes · composicoes (kit) · clientes · fornecedores ·
//   insumos · estoque (saldo inicial) · titulos (financeiro em aberto) ·
//   pedidos (histórico)
//
// REGRAS DE OURO — valem para todos os tipos:
//   • NÃO CONFIA NA EXTENSÃO: o conteúdo é lido como XLSX (base64) ou CSV e o
//     cabeçalho é VALIDADO — coluna obrigatória ausente devolve 400 dizendo
//     qual falta, antes de qualquer linha ser avaliada.
//   • ERRO POR LINHA, com número da linha do arquivo: "Linha 37: SKU inválido."
//   • NADA DE IMPORTAÇÃO SILENCIOSA: a confirmação é TUDO-OU-NADA por padrão
//     (uma linha com erro aborta a transação inteira). Para importar só o que
//     está válido, o chamador precisa pedir explicitamente `ignorarErros: true`
//     — e mesmo aí cada linha pulada volta com o motivo no relatório.
//   • IDEMPOTÊNCIA: reimportar o mesmo arquivo não duplica nada. A chave é a
//     identidade de cada entidade no ERP (SKU do produto, documento do
//     cliente/fornecedor, nome do insumo, saldo por produto×tamanho×local,
//     documento+parcela+vencimento do título, número do pedido) — o que já
//     existe volta como "ignorado", nunca como erro nem como cópia.
//   • RASTREABILIDADE: cada execução grava um LOTE (`importacoes_lotes`) com
//     empresa, usuário, arquivo, hash do conteúdo, contadores e o detalhe dos
//     erros. O saldo inicial e o título importado guardam `origem`,
//     `lote_importacao_id` e (no estoque) `custo_unitario`.
//   • MULTIEMPRESA: tudo nasce carimbado na empresa ativa do operador, e as
//     consultas de apoio (categoria, coleção, produto, tamanho, local…) são
//     recortadas por ela — o arquivo de uma empresa não alcança o cadastro
//     da outra.
// ============================================================================
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { HttpError } from './errors';
import { RESOURCES, getResource, type Resource } from './resources';
import { checkAccess, escopoDe, getDefaultLocal, getDefaultLocalInfo, getStore, storeDoAtor, toHttpError } from './services';
import { currentUser } from './auth';
import type { Payload, Row, Store, Tx } from './store';
import { parseCSV, parseNumeroTexto } from './csv';
import { validatePayload } from './validate';
import { combinar, HERDADOS } from './variacoes';
import { validarReferenciasDaEmpresa, type EscopoEmpresa } from './empresa';
import { recalcularTotal } from './itens';

export const TIPOS_IMPORTACAO = [
  'produtos',
  'variacoes',
  'composicoes',
  'clientes',
  'fornecedores',
  'insumos',
  'estoque',
  'titulos',
  'pedidos',
] as const;
export type TipoImportacao = (typeof TIPOS_IMPORTACAO)[number];

/** Tipo pertence à lista suportada? */
export function isTipoImportacao(valor: unknown): valor is TipoImportacao {
  return typeof valor === 'string' && (TIPOS_IMPORTACAO as readonly string[]).includes(valor);
}

// ----------------------------------------------------------------------------
// Contrato de cada tipo: colunas obrigatórias, exemplo e recurso de validação
// ----------------------------------------------------------------------------

type Contrato = {
  /** Grupos de apelidos: cada grupo exige AO MENOS UMA coluna presente. */
  obrigatorias: string[][];
  cabecalho: string[];
  exemplo: string[];
  recurso?: Resource;
  rotulo: string;
};

const CONTRATOS: Record<TipoImportacao, Contrato> = {
  produtos: {
    rotulo: 'produto',
    recurso: RESOURCES.produtos,
    obrigatorias: [['sku', 'referencia'], ['nome']],
    cabecalho: ['sku', 'nome', 'categoria', 'colecao', 'cor', 'codigo_barras', 'composicao', 'ncm', 'peso_g', 'custo', 'preco_venda', 'ativo'],
    exemplo: ['CAM-100', 'Camisa Polo Algodão', 'Camisa', 'Verão 2026', 'Azul marinho', '7891234567895', '100% algodão', '6205.20.00', '180', '28,50', '69,90', 'sim'],
  },
  variacoes: {
    rotulo: 'variação',
    recurso: RESOURCES.produtos,
    // O SKU do filho é DERIVADO pelo ERP (SKU-PAI-COR-TAMANHO) — nunca vem do arquivo.
    obrigatorias: [['sku_pai', 'produto', 'referencia_pai', 'sku'], ['tamanho', 'codigo', 'tam']],
    cabecalho: ['sku_pai', 'cor', 'tamanho', 'codigo_barras', 'preco_venda', 'preco_atacado', 'ativo'],
    exemplo: ['CAM-100', 'Azul marinho', 'M', '7891234567895', '69,90', '49,90', 'sim'],
  },
  composicoes: {
    rotulo: 'componente de kit',
    recurso: RESOURCES.produto_composicao,
    obrigatorias: [['sku_kit', 'kit', 'kit_sku'], ['sku_componente', 'componente', 'componente_sku', 'sku'], ['quantidade', 'qtd', 'quant']],
    cabecalho: ['sku_kit', 'sku_componente', 'quantidade'],
    exemplo: ['KIT-001', 'CAM-100', '1'],
  },
  clientes: {
    rotulo: 'cliente',
    recurso: RESOURCES.clientes,
    obrigatorias: [['nome', 'razao_social']],
    cabecalho: ['nome', 'cnpj_cpf', 'tipo', 'telefone', 'email', 'ativo'],
    exemplo: ['Loja do João', '12.345.678/0001-90', 'loja', '(11) 99999-0000', 'joao@exemplo.com', 'sim'],
  },
  fornecedores: {
    rotulo: 'fornecedor',
    recurso: RESOURCES.fornecedores,
    obrigatorias: [['nome', 'razao_social']],
    cabecalho: ['nome', 'cnpj', 'contato', 'telefone', 'email', 'ativo'],
    exemplo: ['Tecidos Brasil Ltda', '12.345.678/0001-90', 'Maria', '(11) 3333-0000', 'contato@tecidos.com', 'sim'],
  },
  insumos: {
    rotulo: 'insumo',
    recurso: RESOURCES.insumos,
    obrigatorias: [['nome']],
    cabecalho: ['nome', 'unidade', 'custo_medio', 'fornecedor', 'ativo'],
    exemplo: ['Tecido algodão penteado', 'm', '18,50', 'Tecidos Brasil Ltda', 'sim'],
  },
  estoque: {
    rotulo: 'saldo de estoque',
    recurso: RESOURCES.estoques,
    obrigatorias: [['produto', 'sku', 'referencia'], ['tamanho', 'codigo', 'tam'], ['quantidade', 'qtd', 'saldo']],
    cabecalho: ['produto', 'tamanho', 'local', 'quantidade', 'estoque_min', 'custo'],
    exemplo: ['CAM-100', 'M', 'loja', '150', '20', '28,50'],
  },
  titulos: {
    rotulo: 'título financeiro',
    recurso: RESOURCES.lancamentos_financeiros,
    obrigatorias: [['tipo'], ['valor'], ['vencimento'], ['descricao']],
    cabecalho: [
      'tipo',
      'cliente',
      'fornecedor',
      'documento_pessoa',
      'documento',
      'descricao',
      'valor',
      'vencimento',
      'parcela',
      'total_parcelas',
      'centro_custo',
      'categoria',
      'conta',
      'forma_pagamento',
      'observacoes',
    ],
    exemplo: ['receita', 'Loja do João', '', '12.345.678/0001-90', 'NF-1024', 'Parcela 1/3 — pedido 1024', '1.500,00', '2026-11-10', '1', '3', 'Loja', 'Vendas', 'Banco Inter', 'boleto', ''],
  },
  pedidos: {
    rotulo: 'pedido histórico',
    recurso: RESOURCES.vendas,
    obrigatorias: [['pedido', 'numero', 'order'], ['sku'], ['quantidade', 'qtd']],
    cabecalho: ['pedido', 'data', 'status', 'canal', 'cliente', 'cliente_documento', 'sku', 'tamanho', 'quantidade', 'preco_unitario', 'desconto', 'frete', 'fin_status', 'observacoes'],
    exemplo: ['1024', '2026-09-15', 'entregue', 'site_varejo', 'Loja do João', '12.345.678/0001-90', 'CAM-100', 'M', '2', '69,90', '0', '21,90', 'a_receber', 'Pedido migrado do sistema antigo'],
  },
};

// ----------------------------------------------------------------------------
// Leitura do arquivo (CSV ou XLSX) — sem confiar na extensão
// ----------------------------------------------------------------------------

/** Conteúdo é base64 de XLSX? */
function pareceXlsx(conteudo: string): boolean {
  // Assinatura ZIP ("PK\x03\x04") em base64 = "UEsDB".
  return conteudo.startsWith('UEsDB') || conteudo.startsWith('data:application/vnd.openxmlformats');
}

export function normalizarNomeColuna(c: unknown): string {
  return String(c ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function hashConteudo(conteudo: string): string {
  return createHash('sha256').update(conteudo).digest('hex');
}

export function validarCabecalho(tipo: TipoImportacao, colunasPresentes: string[]): string[] {
  const faltando: string[] = [];
  for (const grupo of CONTRATOS[tipo].obrigatorias) {
    if (!grupo.some((alias) => colunasPresentes.includes(alias))) faltando.push(grupo[0]);
  }
  return faltando;
}

/** Lê o arquivo enviado (CSV texto ou XLSX base64) e devolve linhas de objeto. */
export async function lerArquivo(body: Record<string, unknown>): Promise<{ linhas: Record<string, string>[]; colunas: string[] }> {
  const conteudo = String(body.conteudo ?? '').trim();
  const nome = String(body.nome ?? '').toLowerCase();
  if (!conteudo) throw new HttpError(400, 'Envie o conteúdo do arquivo (texto para CSV, base64 para XLSX).');
  if (nome.endsWith('.xlsx') || pareceXlsx(conteudo)) {
    let wb: ExcelJS.Workbook;
    try {
      const buf = Buffer.from(conteudo.replace(/^data:[^,]+,/, ''), 'base64');
      wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as any);
    } catch (e: any) {
      throw new HttpError(400, `Não foi possível ler o XLSX: ${e?.message || 'arquivo inválido'}`);
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new HttpError(400, 'A planilha XLSX está vazia.');
    const colunas = (ws.getRow(1).values as (string | number | null | undefined)[])
      .filter((_, i) => i > 0)
      .map((c) => normalizarNomeColuna(c));
    const linhas: Record<string, string>[] = [];
    ws.eachRow((row, num) => {
      if (num === 1) return;
      const obj: Record<string, string> = {};
      const vals = row.values as (string | number | Date | null | undefined)[];
      colunas.forEach((c, j) => {
        const raw = vals?.[j + 1];
        if (raw === undefined || raw === null || c === '') return;
        if (raw instanceof Date) obj[c] = raw.toISOString().slice(0, 10);
        else obj[c] = String(raw).trim();
      });
      // Linha totalmente vazia é ignorada (planilhas costumam ter sobra no fim).
      if (Object.values(obj).some((v) => String(v).trim() !== '')) linhas.push(obj);
    });
    return { linhas, colunas };
  }
  const tabela = parseCSV(conteudo);
  return { linhas: tabela.linhas, colunas: tabela.colunas };
}

// ----------------------------------------------------------------------------
// Conversões e validações de campo (erros por linha, em português)
// ----------------------------------------------------------------------------

const FALSOS = new Set(['', 'nao', 'não', 'n', 'false', '0', 'no', 'off']);

function booleano(v: string | undefined, padrao = true): boolean {
  if (v === undefined || v === null || v === '') return padrao;
  return !FALSOS.has(v.trim().toLowerCase());
}

/** Data aceita ISO (2026-10-08) ou brasileira (08/10/2026). Nada de "ontem". */
export function parseDataTexto(v: string | undefined | null, campo: string): string | null {
  const texto = String(v ?? '').trim();
  if (!texto) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (iso) {
    const [, a, m, d] = iso;
    const data = new Date(`${a}-${m}-${d}T00:00:00Z`);
    if (Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== texto) {
      throw new HttpError(400, `${campo}: data inexistente ("${texto}").`);
    }
    return texto;
  }
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto);
  if (br) {
    const [, d, m, a] = br;
    return parseDataTexto(`${a}-${m}-${d}`, campo);
  }
  throw new HttpError(400, `${campo}: use o formato AAAA-MM-DD ou DD/MM/AAAA (recebi "${texto}").`);
}

function exigido(valor: string | undefined, campo: string): string {
  const texto = String(valor ?? '').trim();
  if (!texto) throw new HttpError(400, `${campo}: campo obrigatório não informado.`);
  return texto;
}

/** Somente dígitos — a validação de CPF/CNPJ é do `document` do validate.ts. */
function somenteDigitos(valor?: string | null): string {
  return String(valor ?? '').replace(/\D/g, '');
}

class LinhaInvalida extends Error {
  campos?: Record<string, unknown>;
  constructor(mensagem: string, campos?: Record<string, unknown>) {
    super(mensagem);
    this.campos = campos;
  }
}

// ----------------------------------------------------------------------------
// Contexto da importação: empresa ativa + store recortado + índices de apoio
// ----------------------------------------------------------------------------

type Contexto = {
  tipo: TipoImportacao;
  empresaId: number;
  escopo: EscopoEmpresa;
  s: Store;
  actor: { id?: number | null; name?: string | null; perfil?: string };
  loteId: number | null;
  /** Cache de resoluções por execução (nome → id) para não repetir consultas. */
  cache: Map<string, number | null>;
};

/** Valor de uma coluna por lista de apelidos (o primeiro preenchido vence). */
function col(linha: Record<string, string>, ...apelidos: string[]): string | undefined {
  for (const a of apelidos) {
    const v = linha[a];
    if (v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

/** Busca com cache (evita N consultas iguais no mesmo lote). */
async function resolverId(ctx: Contexto, recurso: Resource, campo: string, valor: string): Promise<number | null> {
  const chave = `${recurso.key}:${campo}:${valor.toLowerCase()}`;
  if (ctx.cache.has(chave)) return ctx.cache.get(chave) ?? null;
  const row = await ctx.s.findOneWhere(recurso, { [campo]: valor });
  const id = row ? Number(row.id) : null;
  ctx.cache.set(chave, id);
  return id;
}

async function resolverPorNome(ctx: Contexto, recurso: Resource, valor: string): Promise<number | null> {
  return resolverId(ctx, recurso, 'nome', valor);
}

/** Produto pelo SKU (aceita o SKU exato ou o código de barras). */
async function produtoPorSku(ctx: Contexto, sku: string): Promise<Row | null> {
  const chave = `produto:${sku.toLowerCase()}`;
  const cacheado = ctx.cache.get(chave);
  if (cacheado === -1) return null;
  if (cacheado && cacheado > 0) return { id: cacheado };
  const direto = await ctx.s.findOneWhere(RESOURCES.produtos, { sku });
  if (direto) {
    ctx.cache.set(chave, Number(direto.id));
    return direto;
  }
  const porBarras = await ctx.s.findOneWhere(RESOURCES.produtos, { codigo_barras: sku });
  if (porBarras) {
    ctx.cache.set(chave, Number(porBarras.id));
    return porBarras;
  }
  ctx.cache.set(chave, -1);
  return null;
}

// ----------------------------------------------------------------------------
// Normalização → payload validado, por tipo (nada é gravado aqui)
// ----------------------------------------------------------------------------

async function normalizar(linha: Record<string, string>, ctx: Contexto): Promise<{ payload: Payload; chave?: string; vinculos?: Payload }> {
  const s = ctx.s;
  switch (ctx.tipo) {
    case 'produtos': {
      const categoria = col(linha, 'categoria', 'categoria_nome');
      let categoria_id: number | null = null;
      if (categoria) {
        categoria_id = await resolverPorNome(ctx, RESOURCES.categorias, categoria);
        if (!categoria_id) throw new LinhaInvalida(`Categoria "${categoria}" não encontrada — cadastre-a antes.`, { categoria: 'Não encontrada' });
      }
      const colecao = col(linha, 'colecao', 'colecao_nome');
      let colecao_id: number | null = null;
      if (colecao) {
        colecao_id = await resolverPorNome(ctx, RESOURCES.colecoes, colecao);
        if (!colecao_id) throw new LinhaInvalida(`Coleção "${colecao}" não encontrada — cadastre-a antes.`, { colecao: 'Não encontrada' });
      }
      return {
        payload: {
          sku: exigido(col(linha, 'sku', 'referencia'), 'SKU'),
          nome: exigido(col(linha, 'nome'), 'Nome'),
          categoria_id,
          colecao_id,
          cor: col(linha, 'cor'),
          codigo_barras: col(linha, 'codigo_barras', 'ean', 'gtin'),
          composicao: col(linha, 'composicao'),
          descricao: col(linha, 'descricao'),
          ncm: col(linha, 'ncm'),
          peso_g: parseNumeroTexto(col(linha, 'peso_g', 'peso')),
          custo: parseNumeroTexto(col(linha, 'custo', 'custo_unitario')),
          preco_venda: parseNumeroTexto(col(linha, 'preco_venda', 'preco', 'preco_sugerido')),
          ativo: booleano(col(linha, 'ativo'), true),
        },
      };
    }

    case 'variacoes': {
      const skuPai = exigido(col(linha, 'sku_pai', 'produto', 'referencia_pai', 'sku'), 'SKU do produto pai');
      const pai = await produtoPorSku(ctx, skuPai);
      if (!pai) throw new LinhaInvalida(`Produto pai "${skuPai}" não encontrado — importe os produtos primeiro.`, { sku_pai: 'SKU não encontrado' });
      const paiCompleto = await s.findOneWhere(RESOURCES.produtos, { id: Number(pai.id) });
      if (!paiCompleto) throw new LinhaInvalida(`Produto pai "${skuPai}" não encontrado.`);
      const tamanho = exigido(col(linha, 'tamanho', 'codigo', 'tam'), 'Tamanho');
      const cor = col(linha, 'cor') ?? '';
      // O SKU da variação segue a MESMA regra determinística do módulo de
      // variações (produto-pai + cor + tamanho) — quem decide é o ERP.
      const combinacao = combinar(
        { sku: String(paiCompleto.sku), nome: String(paiCompleto.nome) },
        cor ? [{ id: null, nome: cor }] : [],
        [{ id: null, codigo: tamanho }]
      )[0];
      const tamanhoId = await idDoTamanho(ctx, tamanho);
      // Herança do pai: a variação nasce com os mesmos dados fiscais, de custo
      // e de preço que o produto-pai — igual à geração de variações do ERP.
      const payload: Payload = {
        sku: combinacao.sku,
        nome: combinacao.nome,
        formato: 'simples',
        cor: cor || null,
        codigo_barras: col(linha, 'codigo_barras', 'ean', 'gtin'),
        preco_venda: parseNumeroTexto(col(linha, 'preco_venda', 'preco')) ?? Number(paiCompleto.preco_venda || 0),
        preco_atacado: parseNumeroTexto(col(linha, 'preco_atacado')) ?? Number(paiCompleto.preco_atacado || 0),
      };
      for (const campo of HERDADOS) {
        if (paiCompleto[campo] !== undefined && paiCompleto[campo] !== null && payload[campo] === undefined) {
          payload[campo] = paiCompleto[campo];
        }
      }
      return {
        payload,
        // `produto_pai_id`/`variacao_chave`/`variacao_tamanho_id` são readonly
        // no cadastro: quem grava é o servidor, logo depois do INSERT.
        vinculos: { produto_pai_id: Number(paiCompleto.id), variacao_chave: combinacao.chave, variacao_tamanho_id: tamanhoId },
        chave: combinacao.sku,
      };
    }

    case 'composicoes': {
      const skuKit = exigido(col(linha, 'sku_kit', 'kit', 'kit_sku'), 'SKU do kit');
      const skuComponente = exigido(col(linha, 'sku_componente', 'componente', 'componente_sku', 'sku'), 'SKU do componente');
      const kit = await produtoPorSku(ctx, skuKit);
      if (!kit) throw new LinhaInvalida(`Kit "${skuKit}" não encontrado — importe os produtos primeiro.`, { sku_kit: 'SKU não encontrado' });
      const componente = await produtoPorSku(ctx, skuComponente);
      if (!componente) throw new LinhaInvalida(`Componente "${skuComponente}" não encontrado.`, { sku_componente: 'SKU não encontrado' });
      const quantidade = parseNumeroTexto(col(linha, 'quantidade', 'qtd', 'quant'));
      if (quantidade === null || quantidade <= 0) throw new LinhaInvalida('Quantidade deve ser um número maior que zero.', { quantidade: 'Informe um número > 0' });
      return {
        payload: { produto_id: Number(kit.id), componente_id: Number(componente.id), quantidade },
        chave: `${skuKit}->${skuComponente}`,
      };
    }

    case 'clientes':
      return {
        payload: {
          nome: exigido(col(linha, 'nome', 'razao_social'), 'Nome/Razão social'),
          cnpj_cpf: col(linha, 'cnpj_cpf', 'cnpj', 'cpf', 'documento'),
          tipo: col(linha, 'tipo', 'tipo_cliente') || 'loja',
          telefone: col(linha, 'telefone', 'fone', 'whatsapp'),
          email: col(linha, 'email'),
          ativo: booleano(col(linha, 'ativo'), true),
        },
      };

    case 'fornecedores':
      return {
        payload: {
          nome: exigido(col(linha, 'nome', 'razao_social'), 'Nome/Razão social'),
          cnpj: col(linha, 'cnpj', 'cnpj_cpf', 'documento'),
          contato: col(linha, 'contato'),
          telefone: col(linha, 'telefone', 'fone'),
          email: col(linha, 'email'),
          ativo: booleano(col(linha, 'ativo'), true),
        },
      };

    case 'insumos': {
      const fornecedor = col(linha, 'fornecedor', 'fornecedor_nome');
      let fornecedor_id: number | null = null;
      if (fornecedor) {
        fornecedor_id = await resolverPorNome(ctx, RESOURCES.fornecedores, fornecedor);
        if (!fornecedor_id) throw new LinhaInvalida(`Fornecedor "${fornecedor}" não encontrado — cadastre-o antes.`, { fornecedor: 'Não encontrado' });
      }
      return {
        payload: {
          nome: exigido(col(linha, 'nome'), 'Nome'),
          unidade: (col(linha, 'unidade', 'und') || 'un').toLowerCase(),
          custo_medio: parseNumeroTexto(col(linha, 'custo_medio', 'custo', 'custo_unitario')),
          fornecedor_id,
          ativo: booleano(col(linha, 'ativo'), true),
        },
      };
    }

    case 'estoque': {
      const sku = exigido(col(linha, 'produto', 'sku', 'referencia'), 'SKU do produto');
      const produto = await produtoPorSku(ctx, sku);
      if (!produto) throw new LinhaInvalida(`Produto "${sku}" não encontrado — importe os produtos primeiro.`, { produto: 'SKU não encontrado' });
      const tamanhoCodigo = exigido(col(linha, 'tamanho', 'codigo', 'tam'), 'Tamanho');
      const tamanhoId = await idDoTamanho(ctx, tamanhoCodigo);
      if (!tamanhoId) throw new LinhaInvalida(`Tamanho "${tamanhoCodigo}" não encontrado.`, { tamanho: 'Código não encontrado' });
      const quantidade = parseNumeroTexto(col(linha, 'quantidade', 'qtd', 'saldo'));
      if (quantidade === null || quantidade < 0) throw new LinhaInvalida('Quantidade inválida — informe um número ≥ 0.', { quantidade: 'Informe um número ≥ 0' });
      const local = col(linha, 'local');
      let local_id: number | null = null;
      if (local) {
        local_id = await resolverPorNome(ctx, RESOURCES.locais, local);
        if (!local_id) throw new LinhaInvalida(`Local "${local}" não encontrado — cadastre-o no módulo Locais.`, { local: 'Não encontrado' });
      }
      const custo = parseNumeroTexto(col(linha, 'custo', 'custo_unitario'));
      return {
        payload: {
          produto_id: Number(produto.id),
          tamanho_id: tamanhoId,
          local: local || null,
          local_id,
          quantidade,
          estoque_min: parseNumeroTexto(col(linha, 'estoque_min', 'minimo')),
          custo,
        },
        chave: `${sku}|${tamanhoCodigo}|${(local || 'padrao').toLowerCase()}`,
      };
    }

    case 'titulos': {
      const tipoBruto = exigido(col(linha, 'tipo'), 'Tipo').toLowerCase();
      const receita = ['receita', 'a_receber', 'receber', 'cliente', 'entrada'].includes(tipoBruto);
      const despesa = ['despesa', 'a_pagar', 'pagar', 'fornecedor', 'saida', 'saída'].includes(tipoBruto);
      if (!receita && !despesa) {
        throw new LinhaInvalida(`Tipo inválido: use "receita" (a receber) ou "despesa" (a pagar) — recebi "${tipoBruto}".`, { tipo: 'receita | despesa' });
      }
      const valor = parseNumeroTexto(col(linha, 'valor', 'valor_total'));
      if (valor === null || valor <= 0) throw new LinhaInvalida('Valor deve ser um número maior que zero.', { valor: 'Informe um número > 0' });
      const vencimento = parseDataTexto(col(linha, 'vencimento', 'data_vencimento'), 'Vencimento');
      if (!vencimento) throw new LinhaInvalida('Vencimento é obrigatório.', { vencimento: 'Informe a data' });

      // Pessoa: por documento (preferencial) ou por nome.
      const documentoPessoa = somenteDigitos(col(linha, 'documento_pessoa', 'documento_cliente', 'documento_fornecedor'));
      const nomeCliente = col(linha, 'cliente');
      const nomeFornecedor = col(linha, 'fornecedor');
      let pessoa_tipo: string | null = null;
      let pessoa_id: number | null = null;
      if (receita || nomeCliente) {
        const alvo = documentoPessoa ? await s.findOneWhere(RESOURCES.clientes, { cnpj_cpf: col(linha, 'documento_pessoa') }) : null;
        const porNome = alvo ?? (nomeCliente ? await s.findOneWhere(RESOURCES.clientes, { nome: nomeCliente }) : null);
        if (!porNome && (documentoPessoa || nomeCliente)) {
          throw new LinhaInvalida(
            `Cliente "${nomeCliente || documentoPessoa}" não encontrado — importe os clientes antes dos títulos.`,
            { cliente: 'Não encontrado' }
          );
        }
        pessoa_tipo = porNome ? 'cliente' : null;
        pessoa_id = porNome ? Number(porNome.id) : null;
      } else if (despesa || nomeFornecedor) {
        const alvo = documentoPessoa ? await s.findOneWhere(RESOURCES.fornecedores, { cnpj: col(linha, 'documento_pessoa') }) : null;
        const porNome = alvo ?? (nomeFornecedor ? await s.findOneWhere(RESOURCES.fornecedores, { nome: nomeFornecedor }) : null);
        if (!porNome && (documentoPessoa || nomeFornecedor)) {
          throw new LinhaInvalida(
            `Fornecedor "${nomeFornecedor || documentoPessoa}" não encontrado — importe os fornecedores antes dos títulos.`,
            { fornecedor: 'Não encontrado' }
          );
        }
        pessoa_tipo = porNome ? 'fornecedor' : null;
        pessoa_id = porNome ? Number(porNome.id) : null;
      }

      const centro = col(linha, 'centro_custo', 'centro_de_custo');
      const centro_custo_id = centro ? await resolverPorNome(ctx, RESOURCES.centros_custo, centro) : null;
      if (centro && !centro_custo_id) throw new LinhaInvalida(`Centro de custo "${centro}" não encontrado.`, { centro_custo: 'Não encontrado' });
      const categoria = col(linha, 'categoria', 'categoria_nome');
      const categoria_id = categoria ? await resolverPorNome(ctx, RESOURCES.categorias_financeiras, categoria) : null;
      if (categoria && !categoria_id) throw new LinhaInvalida(`Categoria financeira "${categoria}" não encontrada.`, { categoria: 'Não encontrada' });
      const conta = col(linha, 'conta', 'conta_financeira');
      const conta_id = conta ? await resolverPorNome(ctx, RESOURCES.contas_financeiras, conta) : null;
      if (conta && !conta_id) throw new LinhaInvalida(`Conta "${conta}" não encontrada.`, { conta: 'Não encontrada' });

      const parcela = parseNumeroTexto(col(linha, 'parcela')) ?? 1;
      const totalParcelas = parseNumeroTexto(col(linha, 'total_parcelas', 'parcelas')) ?? 1;
      const documento = col(linha, 'documento', 'numero_documento', 'nf');
      return {
        payload: {
          data: vencimento,
          tipo: receita ? 'receita' : 'despesa',
          descricao: exigido(col(linha, 'descricao', 'historico'), 'Descrição'),
          valor,
          vencimento,
          parcela,
          total_parcelas: totalParcelas,
          centro_custo_id,
          categoria_id,
          conta_id,
          forma_pagamento: col(linha, 'forma_pagamento', 'forma'),
          documento: documento || null,
          pessoa_tipo,
          pessoa_id,
          // TÍTULO EM ABERTO: nunca nasce pago. Quem baixa é o financeiro,
          // com o recebimento real (§14).
          status: 'pendente',
          referencia_tipo: 'outro',
          observacoes: col(linha, 'observacoes', 'obs'),
        },
        chave: `${pessoa_tipo || 'sem'}:${pessoa_id || 0}:${documento || ''}:${parcela}:${vencimento}`,
      };
    }

    case 'pedidos': {
      const numero = exigido(col(linha, 'pedido', 'numero', 'order'), 'Número do pedido');
      const sku = exigido(col(linha, 'sku'), 'SKU');
      const produto = await produtoPorSku(ctx, sku);
      if (!produto) throw new LinhaInvalida(`SKU "${sku}" não encontrado — importe os produtos primeiro.`, { sku: 'SKU não encontrado' });
      const quantidade = parseNumeroTexto(col(linha, 'quantidade', 'qtd'));
      if (quantidade === null || quantidade <= 0) throw new LinhaInvalida('Quantidade deve ser um número maior que zero.', { quantidade: 'Informe um número > 0' });
      const preco = parseNumeroTexto(col(linha, 'preco_unitario', 'preco', 'valor_unitario'));
      if (preco === null || preco < 0) throw new LinhaInvalida('Preço unitário inválido.', { preco_unitario: 'Informe um número ≥ 0' });
      const data = parseDataTexto(col(linha, 'data', 'data_pedido'), 'Data do pedido') || new Date().toISOString().slice(0, 10);

      let clienteId: number | null = null;
      const docCliente = col(linha, 'cliente_documento', 'documento_cliente', 'cnpj_cpf', 'cnpj');
      const nomeCliente = col(linha, 'cliente', 'cliente_nome');
      if (docCliente) {
        const achou = await s.findOneWhere(RESOURCES.clientes, { cnpj_cpf: docCliente });
        clienteId = achou ? Number(achou.id) : null;
      }
      if (!clienteId && nomeCliente) {
        const achou = await resolverPorNome(ctx, RESOURCES.clientes, nomeCliente);
        clienteId = achou;
      }
      if (!clienteId) {
        throw new LinhaInvalida(
          `Cliente "${nomeCliente || docCliente || '(vazio)'}" não encontrado — importe os clientes antes do histórico de pedidos.`,
          { cliente: 'Não encontrado' }
        );
      }
      const tamanhoCodigo = col(linha, 'tamanho', 'tam', 'codigo');
      const tamanho_id = tamanhoCodigo ? await idDoTamanho(ctx, tamanhoCodigo) : null;
      if (tamanhoCodigo && !tamanho_id) throw new LinhaInvalida(`Tamanho "${tamanhoCodigo}" não encontrado.`, { tamanho: 'Código não encontrado' });

      const statusBruto = (col(linha, 'status') || 'entregue').toLowerCase();
      const status = ['cotacao', 'aberta', 'faturada', 'entregue', 'cancelada'].includes(statusBruto) ? statusBruto : 'entregue';
      const finStatus = (col(linha, 'fin_status', 'situacao_financeira') || 'a_receber').toLowerCase();
      if (!['a_receber', 'recebido', 'cancelado'].includes(finStatus)) {
        throw new LinhaInvalida(`Situação financeira inválida: use a_receber, recebido ou cancelado (recebi "${finStatus}").`, { fin_status: 'a_receber | recebido | cancelado' });
      }
      return {
        payload: {
          pedido: numero,
          data,
          status,
          fin_status: finStatus,
          cliente_id: clienteId,
          produto_id: Number(produto.id),
          tamanho_id,
          quantidade,
          preco_unitario: preco,
          desconto: parseNumeroTexto(col(linha, 'desconto')) ?? 0,
          frete: parseNumeroTexto(col(linha, 'frete')) ?? 0,
          canal_venda: col(linha, 'canal', 'canal_venda') || 'outro',
          pedido_cliente: `MIG-${numero}`,
          observacoes: col(linha, 'observacoes', 'obs') || 'Pedido importado do sistema anterior',
        },
        chave: numero,
      };
    }

    default:
      throw new LinhaInvalida('Tipo de importação inválido.');
  }
}

/** Tamanho pelo código (cacheado), dentro do escopo da empresa ativa. */
async function idDoTamanho(ctx: Contexto, codigo: string): Promise<number | null> {
  return resolverId(ctx, RESOURCES.tamanhos, 'codigo', codigo);
}

// ----------------------------------------------------------------------------
// Validação completa do arquivo (preview E confirmação usam a MESMA função)
// ----------------------------------------------------------------------------

type ErroLinha = { linha: number; mensagem: string; campos?: Record<string, unknown> };
type LinhaImportavel = {
  linha: number;
  /** Payload já validado (o que o CRUD aceitaria). */
  payload: Payload;
  /** Payload antes da validação — guarda campos internos que o CRUD não expõe. */
  bruto: Payload;
  /** Vínculos gravados depois do INSERT (campos readonly do produto-filho). */
  vinculos?: Payload;
  chave?: string;
};

export type Analise = {
  colunas: string[];
  total: number;
  validas: LinhaImportavel[];
  erros: ErroLinha[];
};

export async function analisar(tipo: TipoImportacao, linhas: Record<string, string>[], ctx: Contexto): Promise<Analise> {
  const validas: LinhaImportavel[] = [];
  const erros: ErroLinha[] = [];
  const recurso = CONTRATOS[tipo].recurso;
  for (let i = 0; i < linhas.length; i++) {
    const numeroLinha = i + 2; // linha 1 é o cabeçalho — a mensagem fala a língua do arquivo
    try {
      const { payload, chave, vinculos } = await normalizar(linhas[i], ctx);
      // A validação é a MESMA do CRUD: tipos, obrigatórios, CPF/CNPJ, e-mail, UF.
      // Em `pedidos` a linha é um ITEM (não uma venda inteira), então o payload
      // dela não passa por `validatePayload(vendas)` — os campos são validados
      // um a um na normalização, que é mais específica.
      const validado = recurso && tipo !== 'pedidos' ? validatePayload(recurso, payload, 'create') : (payload as Payload);
      validas.push({ linha: numeroLinha, payload: validado, bruto: payload, vinculos, chave });
    } catch (e: any) {
      const http = e instanceof LinhaInvalida ? null : toHttpError(e, recurso);
      erros.push({
        linha: numeroLinha,
        mensagem: e instanceof LinhaInvalida ? e.message : http ? http.message : 'Linha inválida.',
        campos: e instanceof LinhaInvalida ? e.campos : http?.fields,
      });
    }
  }
  return { colunas: linhas.length ? Object.keys(linhas[0]) : [], total: linhas.length, validas, erros };
}

// ----------------------------------------------------------------------------
// Gravação — idempotente por identidade de cada entidade
// ----------------------------------------------------------------------------

type ResultadoLinha = { status: 'importado' | 'ignorado' | 'atualizado'; motivo?: string; id?: number };

async function gravar(linha: LinhaImportavel, ctx: Contexto, tx: Tx): Promise<ResultadoLinha> {
  const s = ctx.s;
  const p = linha.payload;
  // Nenhuma referência cruza empresas: categoria/conta/centro/produto/
  // tamanho/cliente do arquivo precisam ser da MESMA empresa ativa (§18).
  if (CONTRATOS[ctx.tipo].recurso) {
    await validarReferenciasDaEmpresa(CONTRATOS[ctx.tipo].recurso!, p, ctx.escopo, (alvo, alvoId, t) => s.findOneWhere(alvo, { id: alvoId }, t), tx);
  }
  switch (ctx.tipo) {
    case 'produtos': {
      const existente = await s.findOneWhere(RESOURCES.produtos, { sku: String(p.sku) }, tx);
      if (existente) return { status: 'ignorado', motivo: `SKU ${p.sku} já cadastrado`, id: Number(existente.id) };
      const row = await s.insert(RESOURCES.produtos, p, tx);
      return { status: 'importado', id: Number(row.id) };
    }

    case 'variacoes': {
      const existente = await s.findOneWhere(RESOURCES.produtos, { sku: String(p.sku) }, tx);
      if (existente) return { status: 'ignorado', motivo: `variação ${p.sku} já existe`, id: Number(existente.id) };
      const row = await s.insert(RESOURCES.produtos, p, tx);
      const paiId = Number(linha.vinculos?.produto_pai_id || 0);
      if (paiId) {
        await s.update(RESOURCES.produtos, Number(row.id), { ...linha.vinculos }, tx);
        const pai = await s.findOneWhere(RESOURCES.produtos, { id: paiId }, tx);
        if (pai && String(pai.formato || 'simples') !== 'variacao') {
          await s.update(RESOURCES.produtos, paiId, { formato: 'variacao' }, tx);
        }
      }
      return { status: 'importado', id: Number(row.id) };
    }

    case 'composicoes': {
      const existente = await s.findOneWhere(
        RESOURCES.produto_composicao,
        { produto_id: p.produto_id, componente_id: p.componente_id },
        tx
      );
      if (existente) {
        if (Number(existente.quantidade) === Number(p.quantidade)) {
          return { status: 'ignorado', motivo: 'composição já cadastrada com a mesma quantidade', id: Number(existente.id) };
        }
        const row = await s.update(RESOURCES.produto_composicao, Number(existente.id), { quantidade: p.quantidade }, tx);
        return { status: 'atualizado', motivo: 'quantidade atualizada', id: row ? Number(row.id) : Number(existente.id) };
      }
      const row = await s.insert(RESOURCES.produto_composicao, p, tx);
      return { status: 'importado', id: Number(row.id) };
    }

    case 'clientes': {
      const documento = p.cnpj_cpf ? somenteDigitos(String(p.cnpj_cpf)) : '';
      if (documento) {
        const porDoc = await s.findOneWhere(RESOURCES.clientes, { cnpj_cpf: String(p.cnpj_cpf) }, tx);
        if (porDoc) return { status: 'ignorado', motivo: `documento ${p.cnpj_cpf} já cadastrado`, id: Number(porDoc.id) };
      }
      const porNome = await s.findOneWhere(RESOURCES.clientes, { nome: String(p.nome) }, tx);
      if (porNome) return { status: 'ignorado', motivo: `cliente "${p.nome}" já cadastrado`, id: Number(porNome.id) };
      const row = await s.insert(RESOURCES.clientes, p, tx);
      return { status: 'importado', id: Number(row.id) };
    }

    case 'fornecedores': {
      if (p.cnpj) {
        const porDoc = await s.findOneWhere(RESOURCES.fornecedores, { cnpj: String(p.cnpj) }, tx);
        if (porDoc) return { status: 'ignorado', motivo: `CNPJ ${p.cnpj} já cadastrado`, id: Number(porDoc.id) };
      }
      const porNome = await s.findOneWhere(RESOURCES.fornecedores, { nome: String(p.nome) }, tx);
      if (porNome) return { status: 'ignorado', motivo: `fornecedor "${p.nome}" já cadastrado`, id: Number(porNome.id) };
      const row = await s.insert(RESOURCES.fornecedores, p, tx);
      return { status: 'importado', id: Number(row.id) };
    }

    case 'insumos': {
      const existente = await s.findOneWhere(RESOURCES.insumos, { nome: String(p.nome) }, tx);
      if (existente) return { status: 'ignorado', motivo: `insumo "${p.nome}" já cadastrado`, id: Number(existente.id) };
      const row = await s.insert(RESOURCES.insumos, p, tx);
      return { status: 'importado', id: Number(row.id) };
    }

    case 'estoque': {
      const local = String(p.local || (await getDefaultLocal(tx)));
      const existente = await s.findOneWhere(
        RESOURCES.estoques,
        { produto_id: p.produto_id, tamanho_id: p.tamanho_id, local },
        tx
      );
      // SALDO INICIAL não sobrescreve saldo existente: quem já tem estoque
      // ajusta por MOVIMENTAÇÃO (com trilha), nunca por reimportação.
      if (existente) {
        return {
          status: 'ignorado',
          motivo: `saldo já existe para ${linha.chave} (local ${local}) — use uma movimentação para ajustar`,
          id: Number(existente.id),
        };
      }
      // Sem local no arquivo, vale o Local padrão — o mesmo que o CRUD usa.
      const localId = p.local_id ? Number(p.local_id) : ((await getDefaultLocalInfo(tx))?.id ?? null);
      const row = await s.insert(
        RESOURCES.estoques,
        {
          produto_id: p.produto_id,
          tamanho_id: p.tamanho_id,
          local,
          local_id: localId,
          quantidade: p.quantidade,
          estoque_min: p.estoque_min ?? null,
          origem: 'importacao',
          lote_importacao_id: ctx.loteId,
        },
        tx
      );
      // Estoque inicial SEMPRE vira movimento rastreável (§13): origem, lote,
      // usuário, custo quando informado e motivo legível no extrato do produto.
      if (Number(p.quantidade) !== 0) {
        await s.insert(
          RESOURCES.movimentacoes,
          {
            tipo: 'ajuste',
            produto_id: p.produto_id,
            tamanho_id: p.tamanho_id,
            local,
            quantidade: Number(p.quantidade),
            motivo: `Saldo inicial importado (${ctx.loteId ? `lote #${ctx.loteId}` : 'planilha'})`,
            origem: 'importacao',
            custo_unitario: linha.bruto.custo ?? null,
            lote_importacao_id: ctx.loteId,
            usuario_id: ctx.actor.id || null,
          },
          tx
        );
      }
      return { status: 'importado', id: Number(row.id) };
    }

    case 'titulos': {
      // Identidade do título = pessoa + documento + parcela + vencimento. É
      // por ela que a reimportação reconhece o que já entrou (§14) — nunca
      // pelo valor, que pode ter sido ajustado depois.
      const whereTitulo: Payload = {
        pessoa_tipo: linha.bruto.pessoa_tipo ?? null,
        pessoa_id: linha.bruto.pessoa_id ?? null,
        documento: p.documento ?? null,
        parcela: p.parcela,
        vencimento: p.vencimento,
      };
      const existente = await s.findOneWhere(RESOURCES.lancamentos_financeiros, whereTitulo, tx);
      if (existente) {
        return { status: 'ignorado', motivo: `título ${p.documento || linha.chave} (parcela ${p.parcela}) já importado`, id: Number(existente.id) };
      }
      const row = await s.insert(
        RESOURCES.lancamentos_financeiros,
        {
          ...p,
          pessoa_tipo: linha.bruto.pessoa_tipo ?? null,
          pessoa_id: linha.bruto.pessoa_id ?? null,
          origem: 'importacao',
          lote_importacao_id: ctx.loteId,
        },
        tx
      );
      return { status: 'importado', id: Number(row.id) };
    }

    case 'pedidos': {
      const referencia = String(p.pedido_cliente);
      const existente = await s.findOneWhere(RESOURCES.vendas, { pedido_cliente: referencia }, tx);
      if (existente) return { status: 'ignorado', motivo: `pedido ${p.pedido} já importado`, id: Number(existente.id) };
      return { status: 'importado' }; // gravado em bloco por `gravarPedidos`
    }

    default:
      throw new LinhaInvalida('Tipo de importação inválido.');
  }
}

/**
 * Pedidos históricos: cada pedido do arquivo vira UMA venda com seus itens.
 *
 * Não movimenta estoque de propósito — é histórico, não expedição. O vínculo
 * de idempotência é `vendas.pedido_cliente = "MIG-<número>"`, o mesmo padrão
 * já usado na importação da loja virtual ("WOO-<id>").
 */
async function gravarPedidos(linhas: LinhaImportavel[], ctx: Contexto, tx: Tx): Promise<{ resultados: Map<number, ResultadoLinha>; ids: number[] }> {
  const s = ctx.s;
  const resultados = new Map<number, ResultadoLinha>();
  const ids: number[] = [];
  const porPedido = new Map<string, LinhaImportavel[]>();
  for (const l of linhas) {
    const numero = String(l.payload.pedido);
    const lista = porPedido.get(numero) || [];
    lista.push(l);
    porPedido.set(numero, lista);
  }
  for (const [numero, doPedido] of porPedido) {
    const referencia = `MIG-${numero}`;
    const existente = await s.findOneWhere(RESOURCES.vendas, { pedido_cliente: referencia }, tx);
    if (existente) {
      for (const l of doPedido) resultados.set(l.linha, { status: 'ignorado', motivo: `pedido ${numero} já importado`, id: Number(existente.id) });
      continue;
    }
    const base = doPedido[0].payload;

    const venda = await s.insert(
      RESOURCES.vendas,
      {
        cliente_id: base.cliente_id,
        data: base.data,
        status: base.status,
        fin_status: base.fin_status,
        canal_venda: base.canal_venda,
        pedido_cliente: referencia,
        frete: base.frete,
        desconto: base.desconto,
        origem: 'importacao',
        lote_importacao_id: ctx.loteId,
        observacoes: base.observacoes,
      },
      tx
    );
    for (const l of doPedido) {
      const item = l.payload;
      await s.insert(
        RESOURCES.itens_venda,
        {
          venda_id: Number(venda.id),
          produto_id: item.produto_id,
          tamanho_id: item.tamanho_id,
          quantidade: item.quantidade,
          preco_unitario: item.preco_unitario,
          desconto_pct: 0,
          subtotal: Math.round(Number(item.quantidade) * Number(item.preco_unitario) * 100) / 100,
        },
        tx
      );
    }
    // O total é recalculado pela MESMA regra do módulo de itens — histórico
    // não inventa um total que o ERP não conseguiria reproduzir.
    await recalcularTotal('venda', Number(venda.id), tx);
    ids.push(Number(venda.id));
    for (const l of doPedido) resultados.set(l.linha, { status: 'importado', id: Number(venda.id) });
  }
  return { resultados, ids };
}

// ----------------------------------------------------------------------------
// Lote de importação (trilha)
// ----------------------------------------------------------------------------

function recursoLote(): Resource {
  return getResource('importacoes_lotes')!;
}

async function abrirLote(ctx: Contexto, meta: { arquivo?: string | null; hash?: string | null; total: number }): Promise<number | null> {
  if (!recursoLote()) return null;
  try {
    const row = await ctx.s.insert(recursoLote(), {
      usuario_id: ctx.actor.id || null,
      tipo: ctx.tipo,
      arquivo: meta.arquivo || null,
      origem_hash: meta.hash || null,
      total: meta.total,
      status: 'aberto',
      detalhes: {},
    });
    return Number(row.id);
  } catch (e) {
    // A trilha nunca pode impedir a importação; o pior caso é operar sem lote.
    console.warn('⚠️  Não foi possível abrir o lote de importação:', e instanceof Error ? e.message : e);
    return null;
  }
}

async function fecharLote(ctx: Contexto, loteId: number | null, resumo: Record<string, unknown>): Promise<void> {
  if (!loteId || !recursoLote()) return;
  try {
    await getStore().update(
      recursoLote(),
      loteId,
      {
        importados: Number(resumo.importados || 0),
        ignorados: Number(resumo.ignorados || 0),
        erros: Number(resumo.erros || 0),
        status: String(resumo.status || 'confirmado'),
        detalhes: resumo,
        concluido_em: new Date().toISOString(),
      },
      null
    );
  } catch (e) {
    console.warn('⚠️  Não foi possível fechar o lote de importação:', e instanceof Error ? e.message : e);
  }
}

// ----------------------------------------------------------------------------
// Handlers
// ----------------------------------------------------------------------------

function contexto(req: Request, tipo: TipoImportacao): Contexto {
  const actor = currentUser(req);
  const escopo = escopoDe(actor);
  return {
    tipo,
    empresaId: escopo.empresaId,
    escopo,
    s: storeDoAtor(escopo),
    actor: actor as Contexto['actor'],
    loteId: null,
    cache: new Map(),
  };
}

/** Somente gerente/admin importam, e a empresa precisa ser a que ele opera. */
function exigirPermissao(req: Request, tipo: TipoImportacao): Contexto {
  const actor = currentUser(req);
  if (actor.perfil === 'operador') throw new HttpError(403, 'Somente gerentes e administradores importam planilhas.');
  const recurso = CONTRATOS[tipo].recurso;
  if (recurso) checkAccess(recurso, actor, 'create');
  return contexto(req, tipo);
}

function lerTipo(body: Record<string, unknown>): TipoImportacao {
  const tipo = String(body?.tipo || '');
  if (!isTipoImportacao(tipo)) {
    throw new HttpError(400, `Tipo de importação inválido. Use: ${TIPOS_IMPORTACAO.join(', ')}.`);
  }
  return tipo;
}

export async function previewImportacao(req: Request, res: Response) {
  const body = (req.body || {}) as Record<string, unknown>;
  const tipo = lerTipo(body);
  const ctx = exigirPermissao(req, tipo);
  const recurso = CONTRATOS[tipo].recurso;
  try {
    const { linhas, colunas } = await lerArquivo(body);
    if (!linhas.length) throw new HttpError(400, 'A planilha está vazia ou sem linhas de dados.');
    const faltando = validarCabecalho(tipo, colunas);
    if (faltando.length) {
      throw new HttpError(
        400,
        `Cabeçalho inválido: coluna(s) obrigatória(s) ausente(s) — ${faltando.join(', ')}. Baixe o modelo em "Baixar modelo".`,
        Object.fromEntries(faltando.map((c) => [c, 'Coluna obrigatória']))
      );
    }
    const analise = await analisar(tipo, linhas, ctx);
    const chavesVistas = new Set<string>();
    const duplicadas: ErroLinha[] = [];
    for (const v of analise.validas) {
      if (!v.chave) continue;
      if (chavesVistas.has(v.chave)) {
        duplicadas.push({ linha: v.linha, mensagem: `Linha repetida no arquivo (${v.chave}).` });
      } else {
        chavesVistas.add(v.chave);
      }
    }
    res.json({
      tipo,
      total: analise.total,
      validas: analise.validas.length - duplicadas.length,
      erros: [...analise.erros, ...duplicadas].sort((a, b) => a.linha - b.linha),
      // A amostra serve à CONFERÊNCIA na tela. A gravação relê o arquivo e
      // revalida — payload vindo do navegador nunca é gravado direto.
      amostra: analise.validas.slice(0, 2000).map((v) => v.payload),
      colunas,
      recurso: recurso?.key || tipo,
      hash: hashConteudo(String(body.conteudo ?? '')),
      aviso: duplicadas.length ? 'Linhas repetidas dentro do arquivo não serão importadas duas vezes.' : null,
    });
  } catch (e) {
    throw toHttpError(e, recurso);
  }
}

export async function confirmarImportacao(req: Request, res: Response) {
  const body = (req.body || {}) as Record<string, unknown>;
  const tipo = lerTipo(body);
  const ctx = exigirPermissao(req, tipo);
  const recurso = CONTRATOS[tipo].recurso;
  const ignorarErros = body.ignorarErros === true;
  const arquivo = typeof body.nome === 'string' ? body.nome : null;

  try {
    // 1) A fonte da verdade é o ARQUIVO (ou as linhas enviadas por um cliente
    //    que já as normalizou), e ele é revalidado do zero aqui. Nada do que
    //    veio do navegador entra no banco sem passar pela validação de novo.
    let linhas: Record<string, string>[];
    let hash: string | null = null;
    if (typeof body.conteudo === 'string' && body.conteudo.trim()) {
      const lido = await lerArquivo(body);
      const faltando = validarCabecalho(tipo, lido.colunas);
      if (faltando.length) {
        throw new HttpError(400, `Cabeçalho inválido: coluna(s) obrigatória(s) ausente(s) — ${faltando.join(', ')}.`);
      }
      linhas = lido.linhas;
      hash = hashConteudo(String(body.conteudo));
    } else if (Array.isArray(body.linhas)) {
      // Compatibilidade: payloads já normalizados (o cliente antigo mandava a
      // amostra). A identidade de cada linha é recalculada pelo próprio ERP.
      linhas = (body.linhas as Record<string, unknown>[]).map((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [normalizarNomeColuna(k), v === null || v === undefined ? '' : String(v)])));
    } else {
      throw new HttpError(400, 'Envie o arquivo (`conteudo`) ou as linhas já normalizadas (`linhas`).');
    }
    if (!linhas.length) throw new HttpError(400, 'Nenhuma linha para importar.');

    const analise = await analisar(tipo, linhas, ctx);

    // 2) TUDO-OU-NADA por padrão: erro impede a gravação de qualquer linha.
    if (analise.erros.length && !ignorarErros) {
      throw new HttpError(
        422,
        `Importação abortada: ${analise.erros.length} linha(s) com erro e nada foi gravado. Corrija a planilha ou confirme com "importar somente linhas válidas".`,
        { erros: analise.erros, total: analise.total, validas: analise.validas.length }
      );
    }

    const loteId = await abrirLote(ctx, { arquivo, hash, total: analise.total });
    ctx.loteId = loteId;

    // 3) Tudo em UMA transação: ou o lote inteiro entra, ou nada entra.
    const execucao = await ctx.s.transaction(async (tx) => {
      const resultados: { linha: number; status: ResultadoLinha['status']; motivo?: string; id?: number }[] = [];
      const ids: number[] = [];
      let importados = 0;
      let ignorados = 0;
      let atualizados = 0;

      if (tipo === 'pedidos') {
        const { resultados: porLinha, ids: idsPedidos } = await gravarPedidos(analise.validas, ctx, tx);
        ids.push(...idsPedidos);
        for (const l of analise.validas) {
          const r = porLinha.get(l.linha) ?? { status: 'importado' as const };
          resultados.push({ linha: l.linha, ...r });
          if (r.status === 'importado') importados++;
          else ignorados++;
        }
      } else {
        for (const linha of analise.validas) {
          const r = await gravar(linha, ctx, tx);
          resultados.push({ linha: linha.linha, ...r });
          if (r.status === 'importado') importados++;
          else if (r.status === 'atualizado') atualizados++;
          else ignorados++;
          if (r.id && r.status !== 'ignorado') ids.push(r.id);
        }
      }
      return { resultados, ids, importados, ignorados, atualizados };
    });

    const resumo = {
      status: 'confirmado' as const,
      importados: execucao.importados,
      ignorados: execucao.ignorados,
      atualizados: execucao.atualizados,
      erros: analise.erros.length,
      linhas: execucao.resultados,
      ids: execucao.ids.slice(0, 500),
    };
    await fecharLote(ctx, loteId, resumo);
    await getStore().audit({
      usuario_id: ctx.actor.id || null,
      usuario: ctx.actor.name || null,
      acao: 'importar',
      recurso: recurso?.key || tipo,
      registro_id: null,
      descricao: `Importação de ${execucao.importados} ${CONTRATOS[tipo].rotulo}(s)${execucao.ignorados ? ` — ${execucao.ignorados} já existiam` : ''}${analise.erros.length ? ` — ${analise.erros.length} linha(s) com erro ignorada(s)` : ''}`,
      dados: { tipo, lote_id: loteId, importados: execucao.importados, ignorados: execucao.ignorados, erros: analise.erros.length, ids: execucao.ids.slice(0, 100) },
    });

    res.json({
      ok: true,
      lote_id: loteId,
      tipo,
      total: analise.total,
      importados: execucao.importados,
      atualizados: execucao.atualizados,
      ignorados: execucao.ignorados,
      erros: analise.erros,
      ignorados_detalhe: execucao.resultados.filter((r) => r.status === 'ignorado').map((r) => ({ linha: r.linha, motivo: r.motivo })),
      pulados: execucao.ignorados,
    });
  } catch (e) {
    throw toHttpError(e, recurso);
  }
}

/** GET /api/importar/lotes — trilha dos lotes da empresa ativa. */
export async function listarLotesImportacao(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil === 'operador') throw new HttpError(403, 'Somente gerentes e administradores veem os lotes de importação.');
  const escopo = escopoDe(actor);
  const s = storeDoAtor(escopo);
  const recurso = recursoLote();
  if (!recurso) {
    res.json({ lotes: [] });
    return;
  }
  const limite = Math.min(200, Math.max(1, Number(req.query.limite) || 50));
  const out = await s.list(recurso, { page: 1, pageSize: limite, sort: 'id', dir: 'desc' });
  res.json({ lotes: out.rows, total: out.total });
}

export async function modeloImportacao(req: Request, res: Response) {
  const tipoBruto = String(req.query.tipo || 'produtos');
  const tipo: TipoImportacao = isTipoImportacao(tipoBruto) ? tipoBruto : 'produtos';
  const modelo = CONTRATOS[tipo];
  const csv = `\uFEFF${modelo.cabecalho.join(';')}\r\n${modelo.exemplo.join(';')}`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="modelo-importacao-${tipo}.csv"`);
  res.end(csv);
}

// Exportado para os testes (o runner não passa pelo Express).
export const __importacaoInterna = { analisar, gravar, gravarPedidos, contexto, CONTRATOS };
