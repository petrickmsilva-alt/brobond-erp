// ============================================================
// SUPRIMENTOS — entrada de NF-e (XML) e inteligência de SKU.
//
// A importação é deliberadamente transacional: fornecedor, de-para,
// cabeçalho/itens da compra, estoque, custo e contas a pagar só são
// confirmados juntos. Qualquer item sem casamento ou tamanho válido aborta
// a operação inteira.
// ============================================================
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { currentUser, type AuthUser } from './auth';
import { checkAccess, getDefaultLocal, getStore } from './services';
import { assertRegistroDaEmpresa, escopoDoAtor, type EscopoEmpresa, empresaDoRegistroAudit } from './empresa';
import { getResource } from './resources';
import { parseId } from './validate';
import type { Row } from './store';
import { aplicarRegrasPedido } from './itens';
import { syncLancamentoCompra, syncLancamentoVenda } from './financeiro';
import { aplicarEntradaDeCompra } from './custoRecebimento';
import { round2, round3 } from './utils';

const compras = getResource('compras')!;
const itensCompra = getResource('itens_compra')!;
const fornecedores = getResource('fornecedores')!;
const produtos = getResource('produtos')!;
const tamanhos = getResource('tamanhos')!;
const locais = getResource('locais')!;
const mappings = getResource('produto_fornecedor_skus')!;
const imports = getResource('importacoes_nfe')!;

export type XmlFiscalItem = {
  numero: number;
  codigoFornecedor: string;
  descricao: string;
  ean: string | null;
  ncm: string | null;
  cfop: string | null;
  unidade: string | null;
  quantidade: number;
  valorUnitario: number;
  valorProduto: number;
  frete: number;
  desconto: number;
  impostos: {
    icms: Record<string, string | null>;
    ipi: Record<string, string | null>;
    pis: Record<string, string | null>;
    cofins: Record<string, string | null>;
  };
  textoTamanho: string | null;
};

type ParsedNfe = {
  chaveAcesso: string;
  numero: string | null;
  serie: string | null;
  emitenteCnpj: string | null;
  emitenteNome: string | null;
  emissao: string | null;
  totalNota: number;
  frete: number;
  desconto: number;
  itens: XmlFiscalItem[];
  duplicatas: { numero: string | null; vencimento: string | null; valor: number }[];
};

type MappingInput = {
  produto_id?: number;
  sku?: string;
  tamanho_id?: number;
  tamanho?: string;
};

type ImportBody = {
  local?: string;
  local_id?: number;
  tamanho_id?: number;
  tamanho?: string;
  fornecedor_id?: number;
  de_para?: Record<string, MappingInput | number | string> | { codigo_fornecedor: string; produto_id?: number; sku?: string; tamanho_id?: number; tamanho?: string }[];
  mapeamentos?: ImportBody['de_para'];
};

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Leitura namespace-agnostic de uma tag simples no XML da NF-e. */
function tag(xml: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escaped}\\s*>`, 'i');
  const found = re.exec(xml)?.[1];
  return found === undefined ? null : decodeXml(found.trim());
}

function attr(xml: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i');
  return re.exec(xml)?.[1] ?? null;
}

function numberXml(value: string | null | undefined, scale = 2): number {
  if (value === null || value === undefined || value === '') return 0;
  const text = String(value).trim().replace(/\s/g, '');
  // NF-e usa ponto decimal. A aceitação de vírgula deixa o parser tolerante
  // a XMLs de fornecedores que exportam números no formato brasileiro.
  const parsed = text.includes('.') ? Number(text.replace(/,/g, '')) : Number(text.replace(',', '.'));
  if (!Number.isFinite(parsed)) return 0;
  return scale === 3 ? round3(parsed) : round2(parsed);
}

function digits(value: string | null | undefined): string {
  return String(value || '').replace(/\D/g, '');
}

function fiscalFields(scope: string, names: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of names) out[name] = tag(scope, name);
  return out;
}

function parseXml(xml: string): ParsedNfe {
  const clean = xml.replace(/^\uFEFF/, '');
  if (!/<(?:[A-Za-z_][\w.-]*:)?(?:NFe|infNFe|nfeProc|procNFe)\b/i.test(clean)) {
    throw new HttpError(422, 'O arquivo não parece ser uma NF-e XML válida.');
  }
  const inf = tag(clean, 'infNFe') || clean;
  const ide = tag(inf, 'ide') || '';
  const emit = tag(inf, 'emit') || '';
  const total = tag(inf, 'ICMSTot') || tag(inf, 'total') || '';
  const chave = digits(attr(inf, 'Id') || attr(clean, 'Id'));
  const dets = [...clean.matchAll(/<(?:[A-Za-z_][\w.-]*:)?det\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?det\s*>/gi)].map((m) => m[1]);
  if (!dets.length) throw new HttpError(422, 'A NF-e não contém itens de produto.');

  const itens = dets.map((det, index) => {
    const p = tag(det, 'prod') || det;
    const imposto = tag(det, 'imposto') || '';
    const icms = tag(imposto, 'ICMS') || '';
    const ipi = tag(imposto, 'IPI') || '';
    const pis = tag(imposto, 'PIS') || '';
    const cofins = tag(imposto, 'COFINS') || '';
    const textoLivre = tag(p, 'infAdProd') || tag(det, 'infAdProd');
    return {
      numero: Number(attr(det, 'nItem') || index + 1),
      codigoFornecedor: tag(p, 'cProd') || '',
      descricao: tag(p, 'xProd') || '',
      ean: tag(p, 'cEAN') || tag(p, 'cEANTrib'),
      ncm: tag(p, 'NCM'),
      cfop: tag(p, 'CFOP'),
      unidade: tag(p, 'uCom') || tag(p, 'uTrib'),
      quantidade: numberXml(tag(p, 'qCom') || tag(p, 'qTrib'), 3),
      valorUnitario: numberXml(tag(p, 'vUnCom') || tag(p, 'vUnTrib')),
      valorProduto: numberXml(tag(p, 'vProd')),
      frete: numberXml(tag(p, 'vFrete')),
      desconto: numberXml(tag(p, 'vDesc')),
      impostos: {
        icms: fiscalFields(icms, ['orig', 'CST', 'CSOSN', 'modBC', 'vBC', 'pICMS', 'vICMS', 'pFCP', 'vFCP']),
        ipi: fiscalFields(ipi, ['cEnq', 'CST', 'vBC', 'pIPI', 'vIPI']),
        pis: fiscalFields(pis, ['CST', 'vBC', 'pPIS', 'vPIS']),
        cofins: fiscalFields(cofins, ['CST', 'vBC', 'pCOFINS', 'vCOFINS']),
      },
      textoTamanho: textoLivre,
    } satisfies XmlFiscalItem;
  });

  const duplicatas = [...clean.matchAll(/<(?:[A-Za-z_][\w.-]*:)?dup\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?dup\s*>/gi)].map((m) => {
    const d = m[1];
    return { numero: tag(d, 'nDup'), vencimento: tag(d, 'dVenc'), valor: numberXml(tag(d, 'vDup')) };
  });
  const dhEmi = tag(ide, 'dhEmi') || tag(ide, 'dEmi');
  return {
    chaveAcesso: chave || createHash('sha256').update(clean, 'utf8').digest('hex'),
    numero: tag(ide, 'nNF'),
    serie: tag(ide, 'serie'),
    emitenteCnpj: digits(tag(emit, 'CNPJ') || tag(emit, 'CPF')) || null,
    emitenteNome: tag(emit, 'xNome') || tag(emit, 'xFant'),
    emissao: dhEmi ? dhEmi.slice(0, 10) : null,
    totalNota: numberXml(tag(total, 'vNF')) || round2(itens.reduce((sum, item) => sum + item.valorProduto, 0)),
    frete: numberXml(tag(total, 'vFrete')) || round2(itens.reduce((sum, item) => sum + item.frete, 0)),
    desconto: numberXml(tag(total, 'vDesc')) || round2(itens.reduce((sum, item) => sum + item.desconto, 0)),
    itens,
    duplicatas,
  };
}

function multipartParts(body: Buffer, contentType: string): { name: string; filename: string | null; value: Buffer }[] {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundaryMatch) throw new HttpError(400, 'Multipart inválido: boundary ausente.');
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const parts: { name: string; filename: string | null; value: Buffer }[] = [];
  let start = body.indexOf(boundary);
  while (start >= 0) {
    const next = body.indexOf(boundary, start + boundary.length);
    if (next < 0) break;
    const chunk = body.subarray(start + boundary.length, next);
    const trimmed = chunk.subarray(chunk.indexOf(Buffer.from('\r\n')) + 2);
    const headerEnd = trimmed.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd >= 0) {
      const header = trimmed.subarray(0, headerEnd).toString('utf8');
      let value = trimmed.subarray(headerEnd + 4);
      if (value.subarray(-2).equals(Buffer.from('\r\n'))) value = value.subarray(0, -2);
      const disposition = /content-disposition:\s*form-data;\s*([^\r\n]+)/i.exec(header)?.[1] || '';
      const name = /(?:^|;)\s*name="([^"]+)"/i.exec(disposition)?.[1] || '';
      const filename = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)?.[1] ?? null;
      if (name) parts.push({ name, filename, value });
    }
    if (body.subarray(next, next + boundary.length + 2).toString() === `${boundary.toString()}--`) break;
    start = next;
  }
  return parts;
}

function requestInput(req: Request): { xml: string; input: ImportBody } {
  // O valor de boundary é case-sensitive; só a detecção do tipo deve ser
  // normalizada, não o header inteiro.
  const rawContentType = String(req.headers['content-type'] || '');
  const contentType = rawContentType.toLowerCase();
  let xml = '';
  const input: ImportBody = {};
  if (contentType.includes('multipart/form-data')) {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const parts = multipartParts(raw, rawContentType);
    const file = parts.find((p) => p.name === 'file' || p.name === 'arquivo' || !!p.filename);
    if (file) xml = file.value.toString('utf8');
    for (const part of parts) {
      if (part.filename) continue;
      const value = part.value.toString('utf8');
      if (part.name === 'mapeamentos' || part.name === 'de_para') {
        try { (input as any)[part.name] = JSON.parse(value); } catch { throw new HttpError(400, `${part.name} deve ser um JSON válido.`); }
      } else if (part.name === 'local_id' || part.name === 'tamanho_id' || part.name === 'fornecedor_id') {
        (input as any)[part.name] = Number(value);
      } else if (part.name in input || ['local', 'tamanho'].includes(part.name)) {
        (input as any)[part.name] = value;
      }
    }
  } else if (Buffer.isBuffer(req.body)) {
    xml = req.body.toString('utf8');
  } else if (typeof req.body?.xml === 'string') {
    xml = req.body.xml;
    Object.assign(input, req.body);
  }
  if (!xml.trim()) throw new HttpError(400, 'Envie o XML no campo file/arquivo ou no corpo da requisição.');
  return { xml, input };
}

function mappingEntries(input: ImportBody): Map<string, MappingInput> {
  const source = input.mapeamentos ?? input.de_para;
  const out = new Map<string, MappingInput>();
  if (!source) return out;
  if (Array.isArray(source)) {
    for (const item of source) {
      if (!item || typeof item !== 'object' || !String((item as any).codigo_fornecedor || '').trim()) continue;
      const { codigo_fornecedor, ...mapping } = item as any;
      out.set(String(codigo_fornecedor), mapping);
    }
  } else {
    for (const [code, value] of Object.entries(source)) {
      if (typeof value === 'number' || typeof value === 'string') out.set(code, { produto_id: Number(value) || undefined, sku: typeof value === 'string' ? value : undefined });
      else if (value && typeof value === 'object') out.set(code, value as MappingInput);
    }
  }
  return out;
}

function sizeFromText(text: string | null, sizeRows: Row[]): Row | null {
  if (!text) return null;
  const haystack = String(text);
  const ordered = [...sizeRows].sort((a, b) => String(b.codigo || '').length - String(a.codigo || '').length);
  for (const size of ordered) {
    const code = String(size.codigo || '');
    if (code && new RegExp(`(?:^|[\\s./_-])${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\\s./_-])`, 'i').test(haystack)) return size;
  }
  return null;
}

function asMapping(value: MappingInput | undefined): MappingInput {
  return value || {};
}

async function resolveLocal(input: ImportBody, tx: any): Promise<string> {
  const s = getStore();
  if (input.local_id) {
    const local = await s.findOneWhere(locais, { id: Number(input.local_id) }, tx);
    if (!local) throw new HttpError(400, 'O armazém informado não existe.');
    if (local.ativo === false) throw new HttpError(409, 'O armazém informado está inativo.');
    return String(local.nome);
  }
  if (input.local && String(input.local).trim()) {
    const nome = String(input.local).trim();
    const local = await s.findOneWhere(locais, { nome }, tx);
    if (!local) throw new HttpError(400, `O armazém "${nome}" não está cadastrado.`);
    if (local.ativo === false) throw new HttpError(409, `O armazém "${nome}" está inativo.`);
    return nome;
  }
  return getDefaultLocal(tx);
}

/**
 * MULTIEMPRESA: o fornecedor é procurado e criado DENTRO da empresa ativa.
 * Sem o filtro, uma NF-e importada na Empresa B casava com o fornecedor da
 * Empresa A pelo CNPJ — e a compra nascia apontando para um cadastro alheio.
 */
async function resolveSupplier(parsed: ParsedNfe, input: ImportBody, escopo: EscopoEmpresa, tx: any): Promise<Row> {
  const s = getStore();
  if (input.fornecedor_id) {
    const supplier = await s.get(fornecedores, Number(input.fornecedor_id), tx);
    return assertRegistroDaEmpresa(fornecedores, supplier, escopo);
  }
  const all = await s.list(fornecedores, { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } }, tx);
  const cnpj = digits(parsed.emitenteCnpj);
  const found = all.rows.find((row) => digits(row.cnpj) === cnpj && cnpj);
  if (found) return found;
  if (!parsed.emitenteNome) throw new HttpError(422, 'A NF-e não informa a razão social do fornecedor.');
  return s.insert(fornecedores, { empresa_id: escopo.empresaId, nome: parsed.emitenteNome, cnpj: parsed.emitenteCnpj, ativo: true }, tx);
}

async function resolveProductAndSize(
  item: XmlFiscalItem,
  supplierId: number,
  input: ImportBody,
  mapping: MappingInput,
  escopo: EscopoEmpresa,
  tx: any
): Promise<{ produto: Row; tamanho: Row }> {
  const s = getStore();
  // MULTIEMPRESA: o de-para só casa com produto da empresa ativa. Sem isso, um
  // SKU igual cadastrado em outra empresa era aceito e o estoque subia lá.
  const productRows = (await s.list(produtos, { page: 1, pageSize: 10000, filter: { empresa_id: escopo.empresaId } }, tx)).rows;
  const sizeRows = (await s.list(tamanhos, { page: 1, pageSize: 1000 }, tx)).rows;
  const code = item.codigoFornecedor;
  const stored = await s.findOneWhere(mappings, { fornecedor_id: supplierId, codigo_fornecedor: code }, tx);
  const selected = mapping.produto_id || (mapping.sku ? productRows.find((p) => String(p.sku) === String(mapping.sku))?.id : undefined) || stored?.produto_id;
  let product = selected ? productRows.find((p) => Number(p.id) === Number(selected)) : undefined;
  if (!product) product = productRows.find((p) => String(p.sku) === code || (item.ean && digits(p.codigo_barras) === digits(item.ean)));
  if (!product) {
    throw new HttpError(422, `Não foi possível fazer o de-para do SKU do fornecedor "${code || '(vazio)'}".`, { codigo_fornecedor: code, descricao: item.descricao });
  }

  const sizeId = mapping.tamanho_id || stored?.tamanho_id || input.tamanho_id;
  let size = sizeId ? sizeRows.find((t) => Number(t.id) === Number(sizeId)) : undefined;
  if (!size) {
    const requestedCode = mapping.tamanho || input.tamanho;
    size = sizeRows.find((t) => requestedCode && String(t.codigo).toLowerCase() === String(requestedCode).toLowerCase());
  }
  if (!size) size = sizeFromText(item.textoTamanho || item.descricao || item.codigoFornecedor, sizeRows) || undefined;
  if (!size && sizeRows.length === 1) size = sizeRows[0];
  if (!size) {
    throw new HttpError(422, `Informe o tamanho para o SKU "${code}" no de-para (tamanho_id/tamanho).`, { codigo_fornecedor: code });
  }
  if (mapping.tamanho_id && !size) throw new HttpError(400, `O tamanho ${mapping.tamanho_id} não existe.`);
  return { produto: product, tamanho: size };
}

async function upsertMapping(supplierId: number, code: string, productId: number, sizeId: number, empresaId: number, tx: any) {
  const s = getStore();
  const current = await s.findOneWhere(mappings, { fornecedor_id: supplierId, codigo_fornecedor: code }, tx);
  if (current) {
    if (Number(current.produto_id) !== productId || (current.tamanho_id && Number(current.tamanho_id) !== sizeId)) {
      throw new HttpError(409, `O de-para "${code}" já aponta para outro produto/tamanho. Corrija o cadastro antes de importar.`);
    }
    return current;
  }
  return s.insert(mappings, { empresa_id: empresaId, fornecedor_id: supplierId, codigo_fornecedor: code, produto_id: productId, tamanho_id: sizeId }, tx);
}

export async function importarXmlCompra(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(compras, actor, 'create');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const { xml, input } = requestInput(req);
  const parsed = parseXml(xml);
  const hash = createHash('sha256').update(xml, 'utf8').digest('hex');
  const s = getStore();
  const result = await s.transaction(async (tx) => {
    const already = await s.findOneWhere(imports, { chave_acesso: parsed.chaveAcesso }, tx);
    if (already) {
      throw new HttpError(409, `A NF-e ${parsed.numero || parsed.chaveAcesso} já foi importada.`, { compra_id: already.compra_id, importacao_id: already.id });
    }
    const supplier = await resolveSupplier(parsed, input, escopo, tx);
    const local = await resolveLocal(input, tx);
    const requestedMappings = mappingEntries(input);
    const resolved: { item: XmlFiscalItem; product: Row; size: Row; code: string; mapping: MappingInput }[] = [];
    for (const item of parsed.itens) {
      if (!item.codigoFornecedor) throw new HttpError(422, `O item ${item.numero} não possui cProd.`);
      if (!(item.quantidade > 0) || !Number.isInteger(item.quantidade)) throw new HttpError(422, `A quantidade do item ${item.numero} deve ser um número inteiro positivo para entrada de produto.`);
      const mapping = asMapping(requestedMappings.get(item.codigoFornecedor));
      const pair = await resolveProductAndSize(item, Number(supplier.id), input, mapping, escopo, tx);
      resolved.push({ item, product: pair.produto, size: pair.tamanho, code: item.codigoFornecedor, mapping });
    }

    const total = parsed.totalNota || round2(resolved.reduce((sum, line) => sum + line.item.quantidade * line.item.valorUnitario, 0) + parsed.frete - parsed.desconto);
    const compra = await s.insert(compras, {
      empresa_id: escopo.empresaId,
      fornecedor_id: Number(supplier.id),
      data: parsed.emissao || new Date().toISOString(),
      status: 'recebido',
      total,
      // vFrete vem do XML. Antes só entrava somado no `total` e a coluna
      // `frete` ficava zerada — o rateio de custo não tinha de onde sair.
      frete: round2(parsed.frete || 0),
      nota_fiscal: parsed.numero,
      local_entrada: local,
      observacoes: `NF-e importada${parsed.chaveAcesso ? ` — chave ${parsed.chaveAcesso}` : ''}${parsed.serie ? ` — série ${parsed.serie}` : ''}`,
      fin_vencimento: parsed.duplicatas[0]?.vencimento || parsed.emissao || new Date().toISOString().slice(0, 10),
      fin_parcelas: Math.max(1, parsed.duplicatas.length || 1),
      fin_parcelas_detalhes: parsed.duplicatas.map((dup, index) => ({ parcela: index + 1, numero: dup.numero, vencimento: dup.vencimento, valor: dup.valor })),
      fin_status: 'a_pagar',
    }, tx);

    const createdItems: Row[] = [];
    for (const line of resolved) {
      const unit = line.item.valorUnitario || (line.item.quantidade ? round2(line.item.valorProduto / line.item.quantidade) : 0);
      const item = await s.insert(itensCompra, {
        empresa_id: escopo.empresaId,
        compra_id: Number(compra.id),
        produto_id: Number(line.product.id),
        tamanho_id: Number(line.size.id),
        insumo_id: null,
        codigo_fornecedor: line.code,
        quantidade: round3(line.item.quantidade),
        preco_unitario: unit,
        unidade: line.item.unidade,
        ncm: line.item.ncm,
        cfop: line.item.cfop,
        dados_fiscais: line.item.impostos,
        local: local,
      }, tx);
      createdItems.push(item);
      await upsertMapping(Number(supplier.id), line.code, Number(line.product.id), Number(line.size.id), escopo.empresaId, tx);
    }

    // REGRA CANÔNICA DE CUSTO (server/src/custoRecebimento.ts). Esta função
    // tinha a terceira cópia da média ponderada (`updateReplacementCost`) e não
    // rateava o frete da NF-e. Agora é a mesma rotina do recebimento total e do
    // parcial: custo efetivo, movimentação com custo, custo médio e auditoria.
    //
    // Continua sendo aplicada AQUI, dentro desta transação, e não pelo
    // recebimento genérico — chamar os dois dobraria o saldo.
    await aplicarEntradaDeCompra({
      compraId: Number(compra.id),
      empresaId: escopo.empresaId,
      recebimentoId: null,
      linhas: createdItems.map((item) => ({
        item_compra_id: Number(item.id),
        insumo_id: null,
        produto_id: Number(item.produto_id),
        tamanho_id: Number(item.tamanho_id),
        quantidade: round3(Number(item.quantidade)),
        preco_unitario: Number(item.preco_unitario),
        local,
      })),
      freteTotal: round2(Number(compra.frete || parsed.frete || 0)),
      actor: { id: actor.id || null, name: actor.name },
      motivo: `NF-e ${parsed.numero || parsed.chaveAcesso} — Compra #${compra.id}`,
      tx,
      escopo,
    });
    await s.update(compras, Number(compra.id), { recebida_em: new Date().toISOString() }, tx);
    const after = (await s.get(compras, Number(compra.id), tx)) || compra;
    await syncLancamentoCompra(null, after, { status: 'recebido' }, { id: actor.id || null, name: actor.name }, tx);
    const imported = await s.insert(imports, {
      empresa_id: escopo.empresaId,
      chave_acesso: parsed.chaveAcesso,
      xml_hash: hash,
      compra_id: Number(compra.id),
      fornecedor_id: Number(supplier.id),
      numero: parsed.numero,
      serie: parsed.serie,
      usuario_id: actor.id || null,
      dados_fiscais: { total: parsed.totalNota, frete: parsed.frete, desconto: parsed.desconto, itens: parsed.itens, duplicatas: parsed.duplicatas },
    }, tx);
    await s.audit({
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao: 'criar',
      recurso: 'compras',
      registro_id: Number(compra.id),
      descricao: `NF-e ${parsed.numero || parsed.chaveAcesso} importada — ${resolved.length} produto(s), entrada em "${local}"`,
      dados: { importacao_id: imported.id, chave_acesso: parsed.chaveAcesso, compra_id: compra.id, itens: createdItems.map((item) => item.id) },
      empresa_id: empresaDoRegistroAudit(compras, compra, actor),
    }, tx);
    return { compra, imported, supplier, local, resolved, parsed };
  }, { isolation: 'serializable' });

  res.status(201).json({
    ok: true,
    compra_id: result.compra.id,
    importacao_id: result.imported.id,
    fornecedor: { id: result.supplier.id, nome: result.supplier.nome, cnpj: result.supplier.cnpj || null },
    local: result.local,
    nota: { chave_acesso: result.parsed.chaveAcesso, numero: result.parsed.numero, serie: result.parsed.serie, emissao: result.parsed.emissao, total: result.parsed.totalNota },
    itens: result.resolved.map(({ item, product, size }) => ({
      numero: item.numero,
      codigo_fornecedor: item.codigoFornecedor,
      produto_id: product.id,
      sku: product.sku,
      tamanho_id: size.id,
      tamanho: size.codigo,
      quantidade: item.quantidade,
      custo_unitario: item.valorUnitario,
      fiscal: { ncm: item.ncm, cfop: item.cfop, impostos: item.impostos },
    })),
    financeiro: { parcelas: result.parsed.duplicatas.length || 1, total: result.parsed.totalNota },
  });
}

export function packingCheckBody(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, 'Informe um array de códigos de barras lidos pelo operador.');
  if (!value.every((code) => typeof code === 'string')) throw new HttpError(400, 'Todos os códigos lidos devem ser strings.');
  return value as string[];
}

function byteKey(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex');
}

function sameBarcodeMultiset(expected: string[], received: string[]): boolean {
  if (expected.length !== received.length) return false;
  const counts = new Map<string, number>();
  for (const code of expected) counts.set(byteKey(code), (counts.get(byteKey(code)) || 0) + 1);
  for (const code of received) {
    const key = byteKey(code);
    const count = counts.get(key) || 0;
    if (!count) return false;
    counts.set(key, count - 1);
  }
  return [...counts.values()].every((count) => count === 0);
}

export async function packingCheck(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id ?? req.body?.venda_id ?? req.body?.vendaId);
  const received = packingCheckBody(Array.isArray(req.body) ? req.body : req.body?.barcodes ?? req.body?.codigos_barras ?? req.body?.codigos ?? req.body?.codigos_lidos);
  const s = getStore();
  const result = await s.transaction(async (tx) => {
    // MULTIEMPRESA: 404 (e não 403) quando o pedido é de outra empresa —
    // confirmar que o id existe lá já seria vazamento.
    const venda = assertRegistroDaEmpresa(getResource('vendas')!, await s.findOneWhere(getResource('vendas')!, { id }, tx), escopo);
    if (['faturada', 'entregue'].includes(String(venda.status))) throw new HttpError(409, 'Este pedido já foi liberado para faturamento.');
    if (String(venda.status) === 'cancelada') throw new HttpError(409, 'Pedido cancelado não pode passar pela conferência.');
    const items = await s.list(getResource('itens_venda')!, { page: 1, pageSize: 10000, filter: { venda_id: id, empresa_id: escopo.empresaId }, sort: 'id', dir: 'asc' }, tx);
    const productRows = (await s.list(produtos, { page: 1, pageSize: 10000, filter: { empresa_id: escopo.empresaId } }, tx)).rows;
    const byId = new Map(productRows.map((product) => [Number(product.id), product]));
    const expected: string[] = [];
    const missing: { produto_id: number; sku: string | null; quantidade: number }[] = [];
    for (const item of items.rows) {
      const product = byId.get(Number(item.produto_id));
      const code = product?.codigo_barras;
      if (typeof code !== 'string' || !code.length) {
        missing.push({ produto_id: Number(item.produto_id), sku: product?.sku || null, quantidade: Number(item.quantidade) });
      } else {
        for (let n = 0; n < Number(item.quantidade); n++) expected.push(code);
      }
    }
    if (missing.length) throw new HttpError(409, 'Não é possível conferir: há itens do pedido sem código de barras cadastrado.', { itens_sem_codigo: missing });
    if (!sameBarcodeMultiset(expected, received)) {
      // A divergência fica registrada MESMO com a conferência abortada — é
      // justamente o caso abortado que a operação precisa investigar depois.
      const faltando = expected.filter((code) => !received.includes(code));
      const sobrando = received.filter((code) => !expected.includes(code));
      const divergencia = await s.insert(getResource('divergencias_conferencia')!, {
        empresa_id: escopo.empresaId,
        venda_id: id,
        esperado: expected,
        lido: received,
        faltando,
        sobrando,
        usuario_id: actor.id || null,
      }, tx);
      await s.audit({
        usuario_id: actor.id || null,
        usuario: actor.name,
        acao: 'editar',
        recurso: 'vendas',
        registro_id: id,
        descricao: `Venda #${id}: divergência na conferência (packing check)`,
        empresa_id: empresaDoRegistroAudit(getResource('vendas')!, venda, actor),
        dados: { divergencia_id: divergencia.id, faltando, sobrando },
      }, tx);
      throw new HttpError(422, 'A conferência física não coincide byte a byte com os itens do pedido. Nenhuma baixa foi realizada.', {
        divergencia_id: divergencia.id,
        esperado: expected,
        lidos: received,
        faltando,
        sobrando,
        quantidade_esperada: expected.length,
        quantidade_lida: received.length,
      });
    }
    // A atualização condicionada evita duas conferências concorrentes. O
    // primeiro processo segura a linha; o segundo só prossegue se ela ainda
    // estiver aberta. A baixa de estoque e o status estão na mesma transação.
    const updated = await s.tryUpdateIf(getResource('vendas')!, id, { status: venda.status }, { status: 'faturada' }, tx);
    if (!updated) throw new HttpError(409, 'O pedido mudou durante a conferência. Recarregue e tente novamente.');
    await aplicarRegrasPedido('venda', venda, updated, { status: 'faturada' }, { id: actor.id || null, name: actor.name }, tx);
    const after = (await s.get(getResource('vendas')!, id, tx)) || updated;
    await syncLancamentoVenda(venda, after, { status: 'faturada' }, { id: actor.id || null, name: actor.name }, tx);
    return after;
  }, { isolation: 'serializable' });
  res.json({ ok: true, venda_id: id, status: result.status, faturada_em: result.faturada_em, mensagem: 'Conferência aprovada; pedido liberado para faturamento e estoque baixado.' });
}
