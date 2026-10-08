// ============================================================================
// VARIAÇÕES DE PRODUTO — geração determinística de SKUs filhos.
//
// O cadastro de grades (`grades` / `grade_tamanhos` / `tamanhos`) e o de cores
// já existiam e continuam sendo a fonte: este módulo NÃO cria um segundo
// cadastro de tamanhos. Ele combina o que já está lá e materializa cada
// combinação como um PRODUTO FILHO, com um nível só de profundidade
// (garantido por CHECK na migration 0018).
//
// DETERMINÍSTICO quer dizer o que está escrito: a mesma entrada produz
// exatamente os mesmos SKUs, hoje e daqui a um ano. Nada de sequencial, nada
// de aleatório, nada de IA — `SKU-PAI` + cor + tamanho, normalizados.
//
//   PAI: CAM-POLO        grade P/M/G, cores AZUL e PRETO
//   →    CAM-POLO-AZUL-P, CAM-POLO-AZUL-M, CAM-POLO-AZUL-G,
//        CAM-POLO-PRETO-P, CAM-POLO-PRETO-M, CAM-POLO-PRETO-G
//
// IDEMPOTENTE: rodar de novo não duplica nada. A chave `variacao_chave` é
// única por pai (índice em 0018); quem já existe é reportado como "mantida".
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore, createRecord } from './services';
import { currentUser, type AuthUser } from './auth';
import { parseId } from './validate';
import type { Row, Tx } from './store';
import { assertRegistroDaEmpresa, escopoDoAtor } from './empresa';

const R_PRODUTOS = () => getResource('produtos')!;

/**
 * Normaliza um pedaço de SKU: sem acento, maiúsculo, só A–Z, 0–9 e hífen.
 * É o que torna o resultado previsível independentemente de como o usuário
 * digitou a cor ("Azul Marinho" e "azul marinho" dão AZUL-MARINHO).
 */
export function fatiaSku(valor: unknown): string {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type CombinacaoVariacao = {
  /** Identidade estável da variação dentro do pai (ex.: "COR:AZUL|TAM:M"). */
  chave: string;
  sku: string;
  nome: string;
  cor_id: number | null;
  cor: string | null;
  tamanho_id: number | null;
  tamanho: string | null;
};

/**
 * Produto cartesiano cores × tamanhos, em ordem estável.
 *
 * Função pura: dá para testar o resultado sem banco, e é ela que garante a
 * determinismo prometido acima.
 */
export function combinar(
  pai: { sku: string; nome: string },
  cores: { id: number | null; nome: string }[],
  tamanhos: { id: number | null; codigo: string }[]
): CombinacaoVariacao[] {
  const listaCores = cores.length ? cores : [{ id: null, nome: '' }];
  const listaTamanhos = tamanhos.length ? tamanhos : [{ id: null, codigo: '' }];
  const skuPai = fatiaSku(pai.sku);
  const saida: CombinacaoVariacao[] = [];

  for (const cor of listaCores) {
    for (const tam of listaTamanhos) {
      const partes = [skuPai, fatiaSku(cor.nome), fatiaSku(tam.codigo)].filter(Boolean);
      const chave = [cor.nome ? `COR:${fatiaSku(cor.nome)}` : '', tam.codigo ? `TAM:${fatiaSku(tam.codigo)}` : '']
        .filter(Boolean)
        .join('|');
      const sufixoNome = [cor.nome, tam.codigo].filter(Boolean).join(' ');
      saida.push({
        chave,
        sku: partes.join('-'),
        nome: sufixoNome ? `${pai.nome} ${sufixoNome}` : pai.nome,
        cor_id: cor.id,
        cor: cor.nome || null,
        tamanho_id: tam.id,
        tamanho: tam.codigo || null,
      });
    }
  }
  return saida;
}

/** Tamanhos da grade informada, ou da grade do produto, na ordem da grade. */
async function tamanhosDaGrade(gradeId: number | null, tx?: Tx): Promise<{ id: number; codigo: string }[]> {
  if (!gradeId) return [];
  const s = getStore();
  const vinculos = await s.list(
    getResource('grade_tamanhos')!,
    { page: 1, pageSize: 200, sort: 'ordem', dir: 'asc', filter: { grade_id: gradeId } },
    tx
  );
  const saida: { id: number; codigo: string }[] = [];
  for (const v of vinculos.rows) {
    const tam = await s.findOneWhere(getResource('tamanhos')!, { id: Number(v.tamanho_id) }, tx);
    if (tam) saida.push({ id: Number(tam.id), codigo: String(tam.codigo || '') });
  }
  return saida;
}

/** Campos que a variação herda do pai — tudo o que é do produto, não da peça. */
export const HERDADOS = [
  'categoria_id',
  'colecao_id',
  'fornecedor_id',
  'grade_id',
  'marca',
  'tipo',
  'condicao',
  'unidade',
  'producao',
  'descricao',
  'descricao_curta',
  'ncm',
  'cest',
  'origem',
  'cfop_saida',
  'icms_cst',
  'icms_aliquota',
  'pis_cst',
  'pis_aliquota',
  'cofins_cst',
  'cofins_aliquota',
  'ipi_cst',
  'ipi_aliquota',
  'peso_liquido_g',
  'peso_bruto_g',
  'largura_mm',
  'altura_mm',
  'profundidade_mm',
  'custo',
  'custo_habitual',
  'preco_venda',
  'preco_atacado',
  'estoque_min',
  'estoque_max',
] as const;

/**
 * GET /api/produtos/:id/variacoes/previa
 * Mostra exatamente o que seria criado — e o que já existe — sem criar nada.
 */
export async function previaVariacoes(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_PRODUTOS(), actor, 'read');
  const { pai, combinacoes, existentes } = await planejar(req, parseId(req.params.id));
  res.json({
    produto_pai: { id: pai.id, sku: pai.sku, nome: pai.nome },
    total: combinacoes.length,
    variacoes: combinacoes.map((c) => ({ ...c, ja_existe: existentes.has(c.chave) })),
    novas: combinacoes.filter((c) => !existentes.has(c.chave)).length,
  });
}

/** Resolve pai + combinações pedidas + variações já existentes. */
async function planejar(req: Request, produtoId: number) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const s = getStore();

  const pai = await s.get(R_PRODUTOS(), produtoId);
  if (!pai) throw new HttpError(404, 'Produto não encontrado.');
  assertRegistroDaEmpresa(R_PRODUTOS(), pai, escopo);
  if (pai.produto_pai_id) {
    throw new HttpError(409, 'Este produto já é uma variação. Variação de variação não existe — gere a partir do produto pai.');
  }
  if (!pai.sku) throw new HttpError(409, 'Defina o SKU do produto pai antes de gerar as variações — ele é a raiz dos SKUs filhos.');

  const corpo = (req.method === 'GET' ? req.query : req.body || {}) as Record<string, unknown>;

  const gradeId = corpo.grade_id !== undefined && corpo.grade_id !== '' ? Number(corpo.grade_id) : pai.grade_id ? Number(pai.grade_id) : null;
  let tamanhos = await tamanhosDaGrade(gradeId);

  // Subconjunto explícito de tamanhos (sem sair da grade).
  const pedidos = normalizarLista(corpo.tamanho_ids);
  if (pedidos.length) {
    const permitidos = new Set(tamanhos.map((t) => t.id));
    for (const id of pedidos) {
      if (!permitidos.has(id)) {
        throw new HttpError(400, `O tamanho #${id} não pertence à grade selecionada. Ajuste a grade antes de gerar as variações.`);
      }
    }
    tamanhos = tamanhos.filter((t) => pedidos.includes(t.id));
  }

  const coresIds = normalizarLista(corpo.cor_ids);
  const cores: { id: number | null; nome: string }[] = [];
  for (const id of coresIds) {
    const cor = await s.findOneWhere(getResource('cores')!, { id }, undefined);
    if (!cor) throw new HttpError(400, `Cor #${id} não encontrada.`);
    assertRegistroDaEmpresa(getResource('cores')!, cor, escopo);
    cores.push({ id: Number(cor.id), nome: String(cor.nome || '') });
  }

  if (!cores.length && !tamanhos.length) {
    throw new HttpError(400, 'Informe ao menos uma grade de tamanhos ou uma lista de cores para gerar variações.');
  }

  const combinacoes = combinar({ sku: String(pai.sku), nome: String(pai.nome || '') }, cores, tamanhos);

  const filhos = await s.list(R_PRODUTOS(), { page: 1, pageSize: 1000, filter: { produto_pai_id: produtoId } });
  const existentes = new Map(filhos.rows.map((f) => [String(f.variacao_chave || ''), f]));

  return { pai, combinacoes, existentes, escopo, actor };
}

function normalizarLista(valor: unknown): number[] {
  if (valor === undefined || valor === null || valor === '') return [];
  const bruto = Array.isArray(valor) ? valor : String(valor).split(',');
  const ids = bruto.map((v) => Number(String(v).trim())).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)];
}

/**
 * POST /api/produtos/:id/variacoes
 * Gera as variações que faltam. Rodar duas vezes não duplica nada.
 */
export async function gerarVariacoes(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_PRODUTOS(), actor, 'create');
  const produtoId = parseId(req.params.id);
  const { pai, combinacoes, existentes } = await planejar(req, produtoId);
  const s = getStore();

  const criadas: Row[] = [];
  const mantidas: { chave: string; sku: string; id: number }[] = [];

  for (const c of combinacoes) {
    const jaExiste = existentes.get(c.chave);
    if (jaExiste) {
      mantidas.push({ chave: c.chave, sku: String(jaExiste.sku), id: Number(jaExiste.id) });
      continue;
    }

    const payload: Record<string, unknown> = {
      sku: c.sku,
      nome: c.nome,
      formato: 'simples',
      cor_id: c.cor_id,
      cor: c.cor,
      ativo: true,
    };
    for (const campo of HERDADOS) {
      if (pai[campo] !== undefined && pai[campo] !== null) payload[campo] = pai[campo];
    }

    try {
      // Criação pelo serviço: validação, carimbo de empresa e auditoria de
      // sempre. O vínculo com o pai é gravado logo em seguida porque esses
      // três campos são `readonly` no formulário — ninguém os digita, e é
      // exatamente por isso que o CRUD genérico os descarta.
      const filho = await createRecord(R_PRODUTOS(), payload, actor, { req });
      const comVinculo =
        (await s.update(R_PRODUTOS(), Number(filho.id), {
          produto_pai_id: produtoId,
          variacao_chave: c.chave,
          variacao_tamanho_id: c.tamanho_id,
        })) ?? filho;
      criadas.push(comVinculo);
    } catch (e: any) {
      // SKU repetido com um produto que não é filho deste pai: o usuário
      // precisa saber QUAL, em vez de receber um 409 genérico no meio do lote.
      if (e?.status === 409) {
        throw new HttpError(
          409,
          `O SKU "${c.sku}" já existe nesta empresa e não é uma variação deste produto. ` +
            `As variações criadas até aqui foram mantidas (${criadas.length}). Ajuste o SKU conflitante e rode de novo.`
        );
      }
      throw e;
    }
  }

  // O pai passa a declarar que trabalha com variações.
  if (criadas.length && String(pai.formato || 'simples') !== 'variacao') {
    await s.update(R_PRODUTOS(), produtoId, { formato: 'variacao' });
  }

  if (criadas.length) {
    await s.audit({
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao: 'criar',
      recurso: 'produtos',
      registro_id: produtoId,
      descricao: `${criadas.length} variação(ões) gerada(s) a partir de ${pai.sku}${mantidas.length ? ` (${mantidas.length} já existiam)` : ''}`,
      dados: { criadas: criadas.map((p) => p.sku), mantidas: mantidas.map((m) => m.sku) },
    });
  }

  res.status(criadas.length ? 201 : 200).json({
    produto_pai: { id: Number(pai.id), sku: pai.sku },
    criadas: criadas.map((p) => ({ id: Number(p.id), sku: p.sku, nome: p.nome, variacao_chave: p.variacao_chave })),
    mantidas,
    total: combinacoes.length,
    mensagem: criadas.length
      ? `${criadas.length} variação(ões) criada(s).${mantidas.length ? ` ${mantidas.length} já existia(m) e foi(ram) mantida(s).` : ''}`
      : 'Nenhuma variação nova: todas as combinações pedidas já existem.',
  });
}

/** GET /api/produtos/:id/variacoes — as variações já materializadas. */
export async function listarVariacoes(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_PRODUTOS(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const produtoId = parseId(req.params.id);
  const s = getStore();

  const pai = await s.get(R_PRODUTOS(), produtoId);
  if (!pai) throw new HttpError(404, 'Produto não encontrado.');
  assertRegistroDaEmpresa(R_PRODUTOS(), pai, escopo);

  const filhos = await s.list(R_PRODUTOS(), { page: 1, pageSize: 1000, sort: 'sku', dir: 'asc', filter: { produto_pai_id: produtoId } });
  res.json({
    produto_pai: { id: Number(pai.id), sku: pai.sku, nome: pai.nome, formato: pai.formato ?? 'simples' },
    total: filhos.total,
    variacoes: filhos.rows.map((f) => ({
      id: Number(f.id),
      sku: f.sku,
      nome: f.nome,
      variacao_chave: f.variacao_chave,
      cor: f.cor ?? null,
      tamanho_id: f.variacao_tamanho_id ?? null,
      ativo: f.ativo,
    })),
  });
}
