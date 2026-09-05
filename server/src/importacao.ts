// ============================================================
// Fase 5 — Importação por planilha (admin/gerente).
//
//   POST /api/importar/preview    { tipo, conteudo, nome? }  → valida linha a linha
//   POST /api/importar/confirmar  { tipo, linhas: [...] }    → importa em transação
//   GET  /api/importar/modelo?tipo=produtos                  → CSV-modelo
//
// Tipos: produtos | clientes | fornecedores | insumos | estoque
// O CSV pode vir com ";" ou "," e com XLSX (base64) quando o servidor tem exceljs.
// A validação usa a MESMA validatePayload do CRUD; a confirmação importa em
// UMA transação e audita "Importação de N registros".
// ============================================================
import type { Request, Response } from 'express';
import ExcelJS from 'exceljs';
import { HttpError } from './errors';
import { RESOURCES, getResource, type Resource } from './resources';
import { checkAccess, createRecord, getDefaultLocal, getStore, toHttpError } from './services';
import { currentUser } from './auth';
import type { Payload } from './store';
import { parseCSV, parseNumeroTexto } from './csv';
import { validatePayload } from './validate';

type TipoImportacao = 'produtos' | 'clientes' | 'fornecedores' | 'insumos' | 'estoque';

function recursoDoTipo(tipo: TipoImportacao): Resource {
  switch (tipo) {
    case 'produtos':
      return RESOURCES.produtos;
    case 'clientes':
      return RESOURCES.clientes;
    case 'fornecedores':
      return RESOURCES.fornecedores;
    case 'insumos':
      return RESOURCES.insumos;
    default:
      return RESOURCES.estoques;
  }
}

/** Lê o arquivo enviado (CSV texto ou XLSX base64) e devolve linhas de objeto. */
async function lerArquivo(body: Record<string, unknown>): Promise<Record<string, string>[]> {
  const conteudo = String(body.conteudo ?? '').trim();
  const nome = String(body.nome ?? '').toLowerCase();
  if (!conteudo) throw new HttpError(400, 'Envie o conteúdo do arquivo (base64 para XLSX, texto para CSV).');
  if (nome.endsWith('.xlsx') || /^[-_a-zA-Z0-9+/]+=*$/.test(conteudo.slice(0, 200))) {
    try {
      const buf = Buffer.from(conteudo.replace(/^data:[^,]+,/, ''), 'base64');
      const wb = new ExcelJS.Workbook();
      await (wb.xlsx.load(buf as any));
      const ws = wb.worksheets[0];
      if (!ws) throw new HttpError(400, 'A planilha XLSX está vazia.');
      const colunas = (ws.getRow(1).values as (string | number | null | undefined)[]).filter((_, i) => i > 0);
      const linhas: Record<string, string>[] = [];
      ws.eachRow((row, num) => {
        if (num === 1) return;
        const obj: Record<string, string> = {};
        const vals = row.values as (string | number | Date | null | undefined)[];
        colunas.forEach((c: any, j) => {
          const raw = vals?.[j + 1];
          if (raw === undefined || raw === null) return;
          const chave = String(c || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
          if (raw instanceof Date) obj[chave] = raw.toISOString().slice(0, 10);
          else obj[chave] = String(raw).trim();
        });
        linhas.push(obj);
      });
      return linhas;
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, `Não foi possível ler o XLSX: ${e?.message || 'arquivo inválido'}`);
    }
  }
  return parseCSV(conteudo).linhas;
}

const FALSOS = new Set(['', 'nao', 'não', 'n', 'false', '0', 'no', 'off']);

function booleano(v: string | undefined, padrao = true): boolean {
  if (v === undefined || v === null || v === '') return padrao;
  return !FALSOS.has(v.trim().toLowerCase());
}

// ----------------------------------------------------------------------------
// Normalização por tipo: converte linhas da planilha em payloads da API
// (ex.: "categoria" pelo nome → categoria_id; SKU → produto_id no saldo).
// ----------------------------------------------------------------------------
async function normalizarLinha(tipo: TipoImportacao, linha: Record<string, string>): Promise<Payload> {
  const s = getStore();
  const get = (...chaves: string[]): string | undefined => {
    for (const c of chaves) if (linha[c] !== undefined && linha[c] !== '') return linha[c];
    return undefined;
  };
  if (tipo === 'produtos') {
    const categoria = get('categoria', 'categoria_nome');
    let categoria_id: number | null = null;
    if (categoria) {
      const c = await s.findOneWhere(RESOURCES.categorias, { nome: categoria });
      if (!c) throw new HttpError(400, `Categoria "${categoria}" não encontrada — cadastre-a antes.`, { categoria: 'Não encontrada' });
      categoria_id = Number(c.id);
    }
    const colecao = get('colecao', 'colecao_nome');
    let colecao_id: number | null = null;
    if (colecao) {
      const c = await s.findOneWhere(RESOURCES.colecoes, { nome: colecao });
      if (!c) throw new HttpError(400, `Coleção "${colecao}" não encontrada — cadastre-a antes.`, { colecao: 'Não encontrada' });
      colecao_id = Number(c.id);
    }
    return {
      sku: get('sku', 'referencia') || '',
      nome: get('nome') || '',
      categoria_id,
      colecao_id,
      cor: get('cor'),
      codigo_barras: get('codigo_barras', 'ean', 'gtin'),
      composicao: get('composicao'),
      descricao: get('descricao'),
      ncm: get('ncm'),
      peso_g: parseNumeroTexto(get('peso_g', 'peso')),
      custo: parseNumeroTexto(get('custo', 'custo_unitario')),
      preco_venda: parseNumeroTexto(get('preco_venda', 'preco', 'preco_sugerido')),
      ativo: booleano(get('ativo'), true),
    };
  }
  if (tipo === 'clientes') {
    return {
      nome: get('nome', 'razao_social') || '',
      cnpj_cpf: get('cnpj_cpf', 'cnpj', 'cpf', 'documento'),
      tipo: get('tipo', 'tipo_cliente') || 'loja',
      telefone: get('telefone', 'fone', 'whatsapp'),
      email: get('email'),
      ativo: booleano(get('ativo'), true),
    };
  }
  if (tipo === 'fornecedores') {
    return {
      nome: get('nome', 'razao_social') || '',
      cnpj: get('cnpj', 'cnpj_cpf'),
      contato: get('contato'),
      telefone: get('telefone', 'fone'),
      email: get('email'),
      ativo: booleano(get('ativo'), true),
    };
  }
  if (tipo === 'insumos') {
    const fornecedor = get('fornecedor', 'fornecedor_nome');
    let fornecedor_id: number | null = null;
    if (fornecedor) {
      const f = await s.findOneWhere(RESOURCES.fornecedores, { nome: fornecedor });
      if (!f) throw new HttpError(400, `Fornecedor "${fornecedor}" não encontrado — cadastre-o antes.`, { fornecedor: 'Não encontrado' });
      fornecedor_id = Number(f.id);
    }
    return {
      nome: get('nome') || '',
      unidade: (get('unidade', 'und') || 'un').toLowerCase(),
      custo_medio: parseNumeroTexto(get('custo_medio', 'custo', 'custo_unitario')),
      fornecedor_id,
      ativo: booleano(get('ativo'), true),
    };
  }
  // estoque — saldo inicial: linhas produto × tamanho (SKU ou código do produto)
  const produto = await s.findOneWhere(RESOURCES.produtos, { sku: get('produto', 'sku', 'referencia') || '' });
  if (!produto) throw new HttpError(400, `Produto "${get('produto', 'sku', 'referencia')}" não encontrado — importe os produtos primeiro.`, { produto: 'SKU não encontrado' });
  const tamanho = await s.findOneWhere(RESOURCES.tamanhos, { codigo: get('tamanho', 'codigo', 'tam') || '' });
  if (!tamanho) throw new HttpError(400, `Tamanho "${get('tamanho', 'codigo', 'tam')}" não encontrado.`, { tamanho: 'Código não encontrado' });
  return {
    produto_id: Number(produto.id),
    tamanho_id: Number(tamanho.id),
    local: get('local') || (await getDefaultLocal()),
    quantidade: parseNumeroTexto(get('quantidade', 'qtd', 'saldo')),
    estoque_min: parseNumeroTexto(get('estoque_min', 'minimo')),
  };
}

// ----------------------------------------------------------------------------
// Handlers
// ----------------------------------------------------------------------------
export async function previewImportacao(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil === 'operador') throw new HttpError(403, 'Somente gerentes e administradores importam planilhas.');
  checkAccess(RESOURCES.produtos, actor, 'create');
  const tipo = String(req.body?.tipo || '') as TipoImportacao;
  if (!['produtos', 'clientes', 'fornecedores', 'insumos', 'estoque'].includes(tipo)) {
    throw new HttpError(400, 'Tipo de importação inválido. Use produtos, clientes, fornecedores, insumos ou estoque.');
  }
  const recurso = recursoDoTipo(tipo);
  const s = getStore();
  try {
    const linhas = await lerArquivo((req.body || {}) as Record<string, unknown>);
    if (!linhas.length) throw new HttpError(400, 'A planilha está vazia ou sem linhas de dados.');
    const validas: Payload[] = [];
    const erros: { linha: number; mensagem: string; campos?: Record<string, string> }[] = [];
    for (let i = 0; i < linhas.length; i++) {
      try {
        const payload = await normalizarLinha(tipo, linhas[i]);
        const validated = validatePayload(recurso, payload, 'create');
        // O saldo inicial de estoque também precisa de valores válidos
        if (tipo === 'estoque') {
          if (!validated.produto_id || !validated.tamanho_id) throw new HttpError(400, 'Produto e tamanho são obrigatórios.');
          if (validated.quantidade === null || validated.quantidade === undefined || Number(validated.quantidade) < 0) {
            throw new HttpError(400, 'Quantidade inválida.', { quantidade: 'Informe um número ≥ 0' });
          }
          if (validated.local) {
            const local = String(validated.local).trim();
            const existe = await s.findOneWhere(RESOURCES.locais, { nome: local });
            if (!existe) throw new HttpError(400, `Local "${local}" não encontrado — cadastre-o no módulo Locais.`, { local: 'Não encontrado' });
          }
        }
        validas.push(validated);
      } catch (e: any) {
        const h = toHttpError(e, recurso);
        erros.push({ linha: i + 2, mensagem: h.message, campos: h.fields });
      }
    }
    res.json({
      tipo,
      total: linhas.length,
      validas: validas.length,
      erros,
      amostra: validas.slice(0, 5000),
      colunas: Object.keys(linhas[0] || {}),
    });
  } catch (e) {
    throw toHttpError(e, recurso);
  }
}

export async function confirmarImportacao(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil === 'operador') throw new HttpError(403, 'Somente gerentes e administradores importam planilhas.');
  const tipo = String(req.body?.tipo || '') as TipoImportacao;
  if (!['produtos', 'clientes', 'fornecedores', 'insumos', 'estoque'].includes(tipo)) {
    throw new HttpError(400, 'Tipo de importação inválido.');
  }
  const recurso = recursoDoTipo(tipo);
  const linhas = Array.isArray((req.body || {}).linhas) ? ((req.body || {}).linhas as Payload[]) : [];
  if (!linhas.length) throw new HttpError(400, 'Nenhuma linha para importar.');
  checkAccess(recurso, actor, 'create');
  const s = getStore();
  const etiqueta: Record<TipoImportacao, string> = { produtos: 'produtos', clientes: 'clientes', fornecedores: 'fornecedores', insumos: 'insumos', estoque: 'saldos iniciais de estoque' };
  try {
    const result = await s.transaction(async (tx) => {
      let importados = 0;
      let pulados = 0;
      const ids: number[] = [];
      for (const payload of linhas) {
        try {
          const validated = validatePayload(recurso, payload, 'create');
          if (tipo === 'estoque') {
            validated.local = String(validated.local || (await getDefaultLocal(tx)));
          }
          const row = await s.insert(recurso, validated, tx);
          if (tipo === 'estoque' && Number(row.quantidade) !== 0) {
            await s.insert(
              RESOURCES.movimentacoes,
              { tipo: 'ajuste', produto_id: row.produto_id, tamanho_id: row.tamanho_id, local: row.local, quantidade: Number(row.quantidade), motivo: 'Importação de saldo inicial', usuario_id: actor.id || null },
              tx
            );
          }
          ids.push(Number(row.id));
          importados++;
        } catch {
          pulados++;
        }
      }
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'importar',
          recurso: tipo === 'estoque' ? 'estoques' : tipo,
          registro_id: null,
          descricao: `Importação de ${importados} ${etiqueta[tipo]}${pulados ? ` (${pulados} linha(s) ignoradas por já existirem ou estarem inválidas)` : ''}`,
          dados: { tipo, importados, pulados, ids: ids.slice(0, 100) },
        },
        tx
      );
      return { importados, pulados };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    throw toHttpError(e, recurso);
  }
}

export async function modeloImportacao(req: Request, res: Response) {
  const tipo = String(req.query.tipo || 'produtos') as TipoImportacao;
  const MOD: Record<TipoImportacao, { cab: string[]; ex: string[] }> = {
    produtos: {
      cab: ['sku', 'nome', 'categoria', 'colecao', 'cor', 'codigo_barras', 'composicao', 'ncm', 'peso_g', 'custo', 'preco_venda', 'ativo'],
      ex: ['CAM-100', 'Camisa Polo Algodão', 'Camisa', 'Verão 2026', 'Azul marinho', '7891234567895', '100% algodão', '6205.20.00', '180', '28,50', '69,90', 'sim'],
    },
    clientes: {
      cab: ['nome', 'cnpj_cpf', 'tipo', 'telefone', 'email', 'ativo'],
      ex: ['Loja do João', '12.345.678/0001-90', 'loja', '(11) 99999-0000', 'joao@exemplo.com', 'sim'],
    },
    fornecedores: {
      cab: ['nome', 'cnpj', 'contato', 'telefone', 'email', 'ativo'],
      ex: ['Tecidos Brasil Ltda', '12.345.678/0001-90', 'Maria', '(11) 3333-0000', 'contato@tecidos.com', 'sim'],
    },
    insumos: {
      cab: ['nome', 'unidade', 'custo_medio', 'fornecedor', 'ativo'],
      ex: ['Tecido algodão penteado', 'm', '18,50', 'Tecidos Brasil Ltda', 'sim'],
    },
    estoque: {
      cab: ['produto', 'tamanho', 'local', 'quantidade', 'estoque_min'],
      ex: ['CAM-100', 'M', 'almoxarifado', '150', '20'],
    },
  };
  const modelo = MOD[tipo] || MOD.produtos;
  const csv = `\uFEFF${modelo.cab.join(';')}\r\n${modelo.ex.join(';')}`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="modelo-importacao-${tipo}.csv"`);
  res.end(csv);
}
