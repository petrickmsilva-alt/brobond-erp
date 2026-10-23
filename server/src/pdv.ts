// ============================================================================
// PDV — PONTO DE VENDA (P1)
//
// Regra que governa o módulo inteiro:
//
//   **O frontend NÃO calcula o total. O servidor recalcula tudo.**
//
// O operador lê um código de barras (ou digita um SKU) e manda para o servidor
// uma linha com produto e quantidade. Aqui é resolvido:
//
//   • qual produto é aquele código (código de barras → SKU → id);
//   • qual preço vale (lista de preço vigente, senão a ficha);
//   • o desconto por item e o desconto do cupom;
//   • subtotal, frete, total;
//   • quanto falta pagar e quanto é troco.
//
// Um `total`, `subtotal` ou `preco_unitario` vindo no corpo da requisição é
// IGNORADO. Se o cliente mandar, a resposta devolve o valor do servidor ao lado
// do que foi enviado, para a divergência aparecer na tela — não para ser usada.
//
// O caixa tem abertura e fechamento. O fechamento compara o valor contado com o
// que o sistema esperava e grava a diferença: sem isso não existe conferência.
//
// A venda do PDV é a MESMA entidade `vendas` (canal_venda = 'pdv'): o ERP não
// ganhou um segundo motor de venda. Faturamento, baixa de estoque, comissão e
// contas a receber continuam vindo de `aplicarRegrasPedido` +
// `syncLancamentoVenda`, exatamente como no pedido de balcão.
//
// A emissão da NFC-e é um ato SEPARADO (`POST /api/vendas/:id/fiscal/emitir`),
// de propósito: o provedor fiscal tem a própria máquina de estados e pode
// demorar. Engolir a emissão dentro da transação da venda faria um timeout do
// provedor desfazer uma venda que já aconteceu no balcão.
// ============================================================================
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { PRINT_IR_VERSION, PRINT_LIMITS } from '../../packages/domain/src/print/print-ir';
import { HttpError } from './errors';
import { enviarHtmlSeguro, renderPrintIrHtml, renderPrintIrPdf } from './printFallback';
import { atorDeUsuario, auditarImpressao, enfileirarJob, jobPublico, MAX_COPIAS_REIMPRESSAO, R_JOBS } from './printJobs';
import { construirCupomPdvPrintIR } from './printTemplates';
import { resolverDestinoImpressao } from './printTerminals';
import { getResource, type Resource } from './resources';
import { checkAccess, checkFluxo, escopoDe, getStore, resolveLocal, toHttpError } from './services';
import { currentUser } from './auth';
import { assertRegistroDaEmpresa, type EscopoEmpresa, empresaDoRegistroAudit } from './empresa';
import { parseId } from './validate';
import { round2 } from './utils';
import { aplicarRegrasPedido } from './itens';
import { syncLancamentoVenda } from './financeiro';
import { precoDe } from './listasPreco';
import { chaveTamanho, localDaEmpresa, localPadraoDaEmpresa, locaisDeSaida, saldoPorTamanho, saldoVendavel } from './estoqueCanonico';
import type { Row, Tx } from './store';

export const R_CAIXA = () => getResource('pdv_caixas')!;
export const R_CAIXA_MOV = () => getResource('pdv_caixa_movimentos')!;
export const R_PAGAMENTO = () => getResource('pdv_pagamentos')!;

/** Lê pelo ID já no tenant — não consulta primeiro a linha global para depois filtrá-la. */
async function findInTenant(r: Resource, id: number, escopo: EscopoEmpresa, tx?: Tx): Promise<Row | null> {
  return getStore().findOneWhere(r, r.empresa ? { id, empresa_id: escopo.empresaId } : { id }, tx);
}

/**
 * UX-02.1 — contrato do PDV (evidência: resources.ts e pdv.test.ts):
 *
 *   • gerente/admin respondem pela gaveta: abrir, suprimento, sangria,
 *     fechamento e o resumo/livro completo do caixa;
 *   • operador VENDE em um caixa aberto da sua empresa. Para a tela funcionar,
 *     ele precisa apenas descobrir esse caixa aberto e ver a posição mínima
 *     para continuar a venda.
 *
 * Por isso a descoberta operacional abaixo não usa o CRUD/`read` gerencial de
 * `pdv_caixas`. Ela devolve somente caixas abertos do tenant, sem abrir a
 * gestão do caixa nem qualquer caixa fechado/histórico para o operador.
 */
function caixaAbertoParaOperacao(caixa: Row | null): Row | null {
  if (!caixa || String(caixa.status) !== 'aberto') return null;
  return caixa;
}

async function caixaAbertoDoAtor(req: Request, actor: Parameters<typeof escopoDe>[0]) {
  const escopo = escopoDe(actor as never);
  const numero = req.query.numero ? String(req.query.numero).slice(0, 40) : undefined;
  const s = getStore();
  const filtro: Record<string, unknown> = { empresa_id: escopo.empresaId, status: 'aberto' };
  if (numero) filtro.numero = numero;
  const caixa = caixaAbertoParaOperacao(await s.findOneWhere(R_CAIXA(), filtro));
  if (!caixa) return { caixa: null, resumo: null, escopo };
  // `resumoCaixa` já relê o caixa com o tenant no predicado.
  return { caixa, resumo: await resumoCaixa(Number(caixa.id), escopo), escopo };
}

const FORMAS = ['dinheiro', 'pix', 'cartao_credito', 'cartao_debito', 'vale', 'boleto', 'transferencia', 'outros'];

function num(v: unknown, padrao = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
}

// ----------------------------------------------------------------------------
// CAIXA — abertura, movimentos e fechamento
// ----------------------------------------------------------------------------

/** POST /api/pdv/caixas — abre o caixa. Um aberto por terminal. */
export async function abrirCaixa(req: Request, res: Response) {
  const actor = currentUser(req);
  checkFluxo(R_CAIXA(), actor);
  const escopo = escopoDe(actor);
  const body = (req.body || {}) as Record<string, unknown>;
  const numero = String(body.numero || body.terminal || 'CAIXA-1').trim().slice(0, 40);
  const valorAbertura = round2(Math.max(0, num(body.valor_abertura)));
  const s = getStore();
  try {
    const caixa = await s.transaction(async (tx) => {
      const aberto = await s.findOneWhere(R_CAIXA(), { empresa_id: escopo.empresaId, numero, status: 'aberto' }, tx);
      if (aberto) {
        throw new HttpError(409, `O caixa "${numero}" já está aberto (desde ${String(aberto.abertura_em).slice(0, 16)}). Feche-o antes de abrir outro.`);
      }
      const localData: Record<string, unknown> = {};
      if (body.local_id !== undefined) localData.local_id = body.local_id;
      if (body.local !== undefined) localData.local = String(body.local).slice(0, 60);
      await resolveLocal(localData, tx, escopo);
      const local = String(localData.local);
      const localId = Number(localData.local_id);
      const criado = await s.insert(
        R_CAIXA(),
        {
          empresa_id: escopo.empresaId,
          numero,
          usuario_id: actor.id || null,
          local,
          local_id: localId,
          abertura_em: new Date().toISOString(),
          valor_abertura: valorAbertura,
          status: 'aberto',
          observacoes: body.observacoes ? String(body.observacoes).slice(0, 500) : null,
        },
        tx
      );
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'criar', recurso: 'pdv_caixas', registro_id: Number(criado.id), descricao: `Caixa "${numero}" aberto com ${valorAbertura.toFixed(2)} de troco inicial`, dados: { numero, valor_abertura: valorAbertura, local }, empresa_id: empresaDoRegistroAudit(R_CAIXA(), criado, actor) },
        tx
      );
      return criado;
    }, { isolation: 'serializable' });
    res.status(201).json(caixa);
  } catch (e) {
    throw toHttpError(e, R_CAIXA());
  }
}

/** GET /api/pdv/caixas/aberto?numero= — o caixa aberto do terminal. */
export async function caixaAberto(req: Request, res: Response) {
  const actor = currentUser(req);
  // A venda exige `vendas:create`; a gaveta continua gerencial. A descoberta
  // é uma leitura operacional separada, limitada ao caixa aberto do tenant.
  checkAccess(getResource('vendas')!, actor, 'create');
  const { caixa, resumo } = await caixaAbertoDoAtor(req, actor);
  if (!caixa) return res.json({ caixa: null });
  res.json({ caixa, resumo });
}

/**
 * Dinheiro da venda que FICOU na gaveta.
 *
 * O troco é dinheiro do cliente: sai da gaveta no mesmo ato. O que pode ficar
 * é, no máximo, o que sobra da venda depois dos outros meios de pagamento
 * (cartão, pix, ...). O pagamento em dinheiro guardado pelo PDV já é o valor
 * LÍQUIDO (ver `venderPdv`), e esta conta é a mesma regra lida de volta — é ela
 * que mantém auditáveis as linhas gravadas antes da correção, quando a coluna
 * `valor` recebia o dinheiro ENTREGUE, incluindo o troco (a divergência de
 * R$ 15,00 reproduzida na auditoria ERP-COMMERCE-01).
 */
export function dinheiroNaGaveta(pagamentosDaVenda: Row[], totalDaVenda: unknown): { dinheiro: number; outros: number } {
  const recebido = round2(pagamentosDaVenda.reduce((acc, p) => acc + num(p.valor), 0));
  const emDinheiro = round2(
    pagamentosDaVenda.filter((p) => String(p.forma) === 'dinheiro').reduce((acc, p) => acc + num(p.valor), 0)
  );
  const outros = round2(recebido - emDinheiro);
  return { dinheiro: round2(Math.min(emDinheiro, Math.max(0, num(totalDaVenda) - outros))), outros };
}

/**
 * Posição do caixa: o que o sistema espera encontrar na gaveta.
 *
 * `esperado = abertura + dinheiro(líquido de troco) + suprimentos − sangrias`
 *
 * A derivação sai SOMENTE dos movimentos válidos do caixa: os pagamentos das
 * vendas vivas (`pdv_pagamentos`, filtrados pelo caixa) e os movimentos de
 * gaveta (`pdv_caixa_movimentos`). Venda cancelada não conta, e cada movimento
 * entra uma única vez — não existe uma segunda contabilidade de caixa.
 */
async function resumoCaixa(caixaId: number, escopo: EscopoEmpresa, tx?: Tx): Promise<Record<string, unknown>> {
  const s = getStore();
  const caixa = assertRegistroDaEmpresa(R_CAIXA(), await findInTenant(R_CAIXA(), caixaId, escopo, tx), escopo);
  const vendas = await s.list(
    getResource('vendas')!,
    { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId, pdv_caixa_id: caixaId }, sort: 'id', dir: 'asc' },
    tx
  );
  const pagamentos = await s.list(R_PAGAMENTO(), { page: 1, pageSize: 10000, filter: { empresa_id: escopo.empresaId, caixa_id: caixaId } }, tx);
  const movimentos = await s.list(R_CAIXA_MOV(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId, caixa_id: caixaId } }, tx);

  const porForma: Record<string, number> = {};
  const vendasVivas = vendas.rows.filter((v) => String(v.status) !== 'cancelada');
  const idsVivas = new Set(vendasVivas.map((v) => Number(v.id)));
  const porVenda = new Map<number, Row[]>();
  for (const p of pagamentos.rows) {
    const vendaId = Number(p.venda_id);
    if (!idsVivas.has(vendaId)) continue;
    const lista = porVenda.get(vendaId) ?? [];
    lista.push(p);
    porVenda.set(vendaId, lista);
  }
  let dinheiro = 0;
  let totalVendido = 0;
  for (const venda of vendasVivas) {
    const daVenda = porVenda.get(Number(venda.id)) ?? [];
    const conta = dinheiroNaGaveta(daVenda, venda.total);
    dinheiro = round2(dinheiro + conta.dinheiro);
    for (const p of daVenda) {
      const forma = String(p.forma);
      if (forma === 'dinheiro') continue;
      porForma[forma] = round2(num(porForma[forma]) + num(p.valor));
    }
    totalVendido = round2(totalVendido + num(venda.total));
  }
  // `por_forma.dinheiro` é o que FICOU na gaveta (líquido de troco). Só aparece
  // quando alguma venda/troca movimentou dinheiro — como antes.
  const houveDinheiro = pagamentos.rows.some(
    (p) => idsVivas.has(Number(p.venda_id)) && String(p.forma) === 'dinheiro'
  );
  if (houveDinheiro) porForma.dinheiro = dinheiro;
  let suprimentos = 0;
  let sangrias = 0;
  for (const m of movimentos.rows) {
    if (String(m.tipo) === 'suprimento') suprimentos = round2(suprimentos + num(m.valor));
    else sangrias = round2(sangrias + num(m.valor));
  }
  const emDinheiro = num(porForma.dinheiro);
  return {
    caixa_id: caixaId,
    status: String(caixa.status),
    quantidade_vendas: vendasVivas.length,
    quantidade_canceladas: vendas.rows.length - vendasVivas.length,
    total_vendido: totalVendido,
    por_forma: porForma,
    suprimentos,
    sangrias,
    valor_abertura: num(caixa.valor_abertura),
    // O que deveria estar na gaveta se nada saiu de forma não registrada.
    esperado_em_dinheiro: round2(num(caixa.valor_abertura) + emDinheiro + suprimentos - sangrias),
  };
}

/** GET /api/pdv/caixas/:id/resumo — posição/livro do caixa (gestão). */
export async function resumoCaixaHandler(req: Request, res: Response) {
  const actor = currentUser(req);
  // Não reutilizar a descoberta operacional aqui: este endpoint é o resumo
  // endereçável de qualquer caixa do tenant e permanece gerencial.
  checkAccess(R_CAIXA(), actor, 'read');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  assertRegistroDaEmpresa(R_CAIXA(), await findInTenant(R_CAIXA(), id, escopo), escopo);
  res.json(await resumoCaixa(id, escopo));
}

/** POST /api/pdv/caixas/:id/movimentos — suprimento (troco) ou sangria (gestão da gaveta). */
export async function movimentoCaixa(req: Request, res: Response) {
  const actor = currentUser(req);
  checkFluxo(R_CAIXA(), actor);
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const body = (req.body || {}) as Record<string, unknown>;
  const tipo = String(body.tipo || '').toLowerCase();
  if (tipo !== 'suprimento' && tipo !== 'sangria') {
    throw new HttpError(400, 'tipo deve ser "suprimento" ou "sangria".', { tipo: 'Inválido' });
  }
  const valor = round2(num(body.valor));
  if (!(valor > 0)) throw new HttpError(400, 'O valor deve ser maior que zero.', { valor: 'Deve ser > 0' });
  const s = getStore();
  const mov = await s.transaction(async (tx) => {
    const caixa = assertRegistroDaEmpresa(R_CAIXA(), await findInTenant(R_CAIXA(), id, escopo, tx), escopo);
    if (String(caixa.status) !== 'aberto') throw new HttpError(409, 'Este caixa já foi fechado.');
    const criado = await s.insert(
      R_CAIXA_MOV(),
      { empresa_id: escopo.empresaId, caixa_id: id, tipo, valor, motivo: body.motivo ? String(body.motivo).slice(0, 200) : null, usuario_id: actor.id || null },
      tx
    );
    await s.audit(
      { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'pdv_caixas', registro_id: id, descricao: `${tipo === 'suprimento' ? 'Suprimento' : 'Sangria'} de ${valor.toFixed(2)} no caixa #${id}`, dados: { tipo, valor }, empresa_id: empresaDoRegistroAudit(R_CAIXA(), caixa, actor) },
      tx
    );
    return criado;
  });
  res.status(201).json(mov);
}

/**
 * POST /api/pdv/caixas/:id/fechar — fecha o caixa.
 *
 * `valor_fechamento` é o que foi CONTADO. O servidor calcula o esperado e grava
 * a diferença — positiva ou negativa. Um caixa com diferença é fechado do mesmo
 * jeito (o dinheiro já está na gaveta), mas a divergência fica registrada e
 * auditada: fechar não apaga o fato.
 */
export async function fecharCaixa(req: Request, res: Response) {
  const actor = currentUser(req);
  // Fechar é ato de gestão da gaveta (checkFluxo → read de pdv_caixas).
  checkFluxo(R_CAIXA(), actor);
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const body = (req.body || {}) as Record<string, unknown>;
  if (body.valor_fechamento === undefined || body.valor_fechamento === null || body.valor_fechamento === '') {
    throw new HttpError(400, 'Informe o valor contado na gaveta (valor_fechamento).', { valor_fechamento: 'Obrigatório' });
  }
  const contado = round2(num(body.valor_fechamento));
  if (contado < 0) throw new HttpError(400, 'O valor contado não pode ser negativo.', { valor_fechamento: 'Deve ser ≥ 0' });
  const s = getStore();
  try {
    const fechamento = await s.transaction(async (tx) => {
      const caixa = assertRegistroDaEmpresa(R_CAIXA(), await findInTenant(R_CAIXA(), id, escopo, tx), escopo);
      if (String(caixa.status) !== 'aberto') throw new HttpError(409, 'Este caixa já está fechado.');
      const resumo = await resumoCaixa(id, escopo, tx);
      const esperado = num(resumo.esperado_em_dinheiro);
      const diferenca = round2(contado - esperado);
      // Justificativa da diferença (P2 §6): entra na trilha do fechamento.
      const justificativa = body.justificativa ? ` · justificativa: ${String(body.justificativa).slice(0, 300)}` : '';
      const observacoes = [body.observacoes ? String(body.observacoes).slice(0, 500) : caixa.observacoes ?? null, justificativa ? `Fechamento${justificativa}` : null].filter(Boolean).join('\n') || null;
      const fechado = await s.tryUpdateIf(
        R_CAIXA(),
        id,
        { status: 'aberto' },
        {
          status: 'fechado',
          fechamento_em: new Date().toISOString(),
          valor_fechamento: contado,
          valor_sistema: esperado,
          diferenca,
          fechado_por: actor.id || null,
          observacoes,
        },
        tx
      );
      if (!fechado) throw new HttpError(409, 'O caixa foi fechado por outra operação.');
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'pdv_caixas',
          registro_id: id,
          descricao: `Caixa #${id} fechado: contado ${contado.toFixed(2)}, esperado ${esperado.toFixed(2)}, diferença ${diferenca.toFixed(2)}`,
          empresa_id: empresaDoRegistroAudit(R_CAIXA(), caixa, actor),
          dados: { valor_fechamento: contado, valor_sistema: esperado, diferenca, vendas: resumo.quantidade_vendas },
        },
        tx
      );
      return { fechado, resumo, diferenca, esperado, contado };
    }, { isolation: 'serializable' });
    res.json({
      ok: true,
      caixa: fechamento.fechado,
      resumo: fechamento.resumo,
      diferenca: fechamento.diferenca,
      // Divergência não é erro do sistema: é um fato que a operação precisa ver.
      alerta: Math.abs(fechamento.diferenca) > 0.009 ? (fechamento.diferenca > 0 ? 'Sobra de caixa registrada.' : 'Falta de caixa registrada.') : null,
    });
  } catch (e) {
    throw toHttpError(e, R_CAIXA());
  }
}

// ----------------------------------------------------------------------------
// BUSCA POR CÓDIGO DE BARRAS / SKU
// ----------------------------------------------------------------------------

export type LinhaResolvida = {
  /** Produto que vai para `itens_venda.produto_id` (o PAI, se o código era de variação). */
  produto: Row;
  /** Tamanho resolvido. O estoque deste ERP é por produto+tamanho+local, então
   *  uma linha sem tamanho nunca conseguiria ser faturada. */
  tamanho_id: number | null;
  tamanho_codigo: string | null;
  /** SKU do que foi efetivamente lido (o da variação, quando é o caso). */
  sku: string;
  eh_variacao: boolean;
  preco: number;
  preco_tabela: number;
  lista_preco_id: number | null;
  lista_nome: string | null;
  codigo_lido: string | null;
  /** ESTOQUE VENDÁVEL do tamanho: o que esta venda consegue baixar no local escolhido. */
  disponivel: number;
  /** Local de onde `disponivel` sai (local de saída da venda, senão Local padrão). */
  local_id: number | null;
  local: string | null;
  /** ESTOQUE FÍSICO do tamanho (soma de todos os locais da empresa). */
  disponivel_fisico: number;
  /** Estoque no local de saída escolhido, sem o fallback do Local padrão. */
  disponivel_no_local: number;
};

/**
 * Tamanhos em que o produto tem célula de estoque nesta empresa.
 *
 * A agregação vem de `estoqueCanonico.ts` (empresa + produto + tamanho + local):
 * sem `localId` é o estoque físico do produto; com `localId` é a célula daquele
 * local. O PDV não monta uma segunda soma de `estoques`.
 */
async function tamanhosComEstoque(
  produtoId: number,
  escopo: EscopoEmpresa,
  tx?: Tx,
  opcoes: { localId?: number | null } = {}
): Promise<{ id: number; codigo: string; disponivel: number }[]> {
  const s = getStore();
  const porTamanho = await saldoPorTamanho(escopo, produtoId, { localId: opcoes.localId ?? null }, tx);
  const out: { id: number; codigo: string; disponivel: number }[] = [];
  for (const [chave, saldo] of porTamanho) {
    const tam = chave ? await s.findOneWhere(getResource('tamanhos')!, { id: chave }, tx) : null;
    out.push({ id: chave, codigo: tam ? String(tam.codigo ?? tam.nome ?? chave) : 'sem tamanho', disponivel: saldo.quantidade });
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * Resolve uma referência de produto: código de barras, SKU ou id.
 *
 * Exportada porque a venda do PDV e a busca usam exatamente o mesmo caminho —
 * uma venda não pode aceitar um código que a busca não acharia.
 *
 * Além do produto, resolve o TAMANHO. Não é preciosismo: o saldo deste ERP é
 * (produto, tamanho, local) e `itens_venda.tamanho_id` é obrigatório — uma linha
 * sem tamanho entraria no pedido e travaria no faturamento, deixando o operador
 * com um cupom que não fecha. Quando o código lido é de uma variação, o tamanho
 * vem dela e o produto vira o pai; quando não é, o tamanho precisa ser
 * informado ou ser único entre os que têm estoque.
 */
export async function resolverProduto(
  codigo: string,
  escopo: EscopoEmpresa,
  tx?: Tx,
  tamanhoPedido?: number | null,
  /**
   * Local de saída da venda. Quando informado, `disponivel` passa a ser o
   * ESTOQUE VENDÁVEL naquele local (com o mesmo fallback para o Local padrão
   * que o faturamento usa) — nunca a soma de todos os locais.
   */
  localSaidaId?: number | null
): Promise<LinhaResolvida> {
  const s = getStore();
  const limpo = String(codigo ?? '').trim();
  if (!limpo) throw new HttpError(400, 'Informe o código de barras, o SKU ou o id do produto.');
  const escopoFiltro = { empresa_id: escopo.empresaId };
  let lido =
    (await s.findOneWhere(getResource('produtos')!, { ...escopoFiltro, codigo_barras: limpo }, tx)) ||
    (await s.findOneWhere(getResource('produtos')!, { ...escopoFiltro, sku: limpo }, tx));
  if (!lido && /^\d+$/.test(limpo)) {
    const porId = await s.findOneWhere(getResource('produtos')!, { id: Number(limpo), empresa_id: escopo.empresaId }, tx);
    if (porId) lido = porId;
  }
  if (!lido) throw new HttpError(404, `Nenhum produto encontrado para "${limpo}" nesta empresa.`);
  if (lido.ativo === false) throw new HttpError(409, `O produto ${lido.sku} está inativo e não pode ser vendido.`);

  // O preço é SEMPRE o do que foi lido: a variação tem preço próprio e a lista
  // de preço pode cobri-lo.
  const resolvido = await precoDe(lido, escopo, tx);

  let produto = lido;
  // Variações geradas pelo cadastro usam `variacao_tamanho_id` (migration
  // 0018). `tamanho_id` permanece como fallback para registros legados.
  const tamanhoDaVariacao = lido.variacao_tamanho_id ?? lido.tamanho_id;
  let tamanhoId: number | null = tamanhoDaVariacao === null || tamanhoDaVariacao === undefined ? null : Number(tamanhoDaVariacao);
  const ehVariacao = Boolean(lido.produto_pai_id);
  const temLocalInformado = localSaidaId !== null && localSaidaId !== undefined && Number(localSaidaId) > 0;
  const localOperacional = temLocalInformado
    ? (await locaisDeSaida(escopo, Number(localSaidaId), tx)).preferido
    : await localPadraoDaEmpresa(escopo, tx);
  const localEfetivoId = localOperacional ? localOperacional.id : null;

  if (ehVariacao) {
    const pai = await s.findOneWhere(getResource('produtos')!, { id: Number(lido.produto_pai_id), empresa_id: escopo.empresaId }, tx);
    // O pai pode ter sido excluído ou pertencer a outra empresa: aí a linha não
    // tem para onde ir e é melhor recusar do que gravar um órfão.
    if (!pai) throw new HttpError(409, `A variação ${lido.sku} aponta para o produto-pai #${lido.produto_pai_id}, que não existe mais.`);
    assertRegistroDaEmpresa(getResource('produtos')!, pai, escopo);
    produto = pai;
  } else if (tamanhoPedido) {
    const tam = await s.get(getResource('tamanhos')!, Number(tamanhoPedido), tx);
    if (!tam) throw new HttpError(404, `O tamanho #${tamanhoPedido} não existe.`);
    assertRegistroDaEmpresa(getResource('tamanhos')!, tam, escopo);
    tamanhoId = Number(tam.id);
  } else {
    const opcoes = await tamanhosComEstoque(Number(lido.id), escopo, tx, { localId: localEfetivoId });
    if (opcoes.length === 1 && opcoes[0].id > 0) tamanhoId = opcoes[0].id;
    else if (opcoes.length > 1) {
      throw new HttpError(
        400,
        `O produto ${lido.sku} tem mais de um tamanho com estoque (${opcoes.map((o) => o.codigo).join(', ')}). Informe o tamanho da linha.`,
        { tamanho_id: 'Ambíguo' }
      );
    }
    // Nenhum tamanho com estoque: deixa null e o faturamento responde com a
    // falta real ("precisa de N, há 0"), que é a mensagem que o operador entende.
  }

  const tam = tamanhoId ? await s.findOneWhere(getResource('tamanhos')!, { id: tamanhoId }, tx) : null;
  const vendavel = localEfetivoId !== null
    ? await saldoVendavel(escopo, Number(produto.id), tamanhoId, localEfetivoId, tx)
    : null;
  // Sem local operacional cadastrado (ex.: empresa recém-criada em pré-onboarding)
  // a leitura cai no físico do tamanho; com local operacional, usa sempre a fonte
  // canônica única: Produto + tamanho + local operacional = disponível para venda.
  const fisico = vendavel
    ? vendavel.fisico
    : (await tamanhosComEstoque(Number(produto.id), escopo, tx))
        .filter((t) => t.id === chaveTamanho(tamanhoId))
        .reduce((acc, t) => acc + t.disponivel, 0);
  const disponivel = vendavel ? vendavel.quantidade : fisico;
  const disponivelNoLocal = vendavel
    ? vendavel.por_local.find((item) => item.local_id === localEfetivoId)?.quantidade ?? vendavel.quantidade
    : fisico;

  return {
    produto,
    tamanho_id: tamanhoId,
    tamanho_codigo: tam ? String(tam.codigo ?? tam.nome ?? tam.id) : null,
    sku: String(lido.sku ?? ''),
    eh_variacao: ehVariacao,
    preco: resolvido.preco,
    preco_tabela: resolvido.preco_tabela,
    lista_preco_id: resolvido.lista_id,
    lista_nome: resolvido.lista_nome,
    codigo_lido: limpo,
    disponivel,
    local_id: vendavel?.local_id ?? localEfetivoId,
    local: vendavel?.local ?? localOperacional?.nome ?? null,
    disponivel_fisico: fisico,
    disponivel_no_local: disponivelNoLocal,
  };
}

/**
 * Local de saída que a tela do PDV deve usar para disponibilidade: o `local_id`
 * pedido, senão o local do caixa aberto, senão o Local padrão da empresa.
 *
 * É o MESMO local que `venderPdv` debita — por isso a tela e o faturamento não
 * podem discordar. O `local_id` pedido é validado no tenant (404 se for de
 * outra empresa), nunca aceito como texto livre.
 */
async function localDeSaidaDaBusca(req: Request, escopo: EscopoEmpresa): Promise<number | null> {
  const raw = req.query.local_id;
  if (raw !== undefined && raw !== null && raw !== '') {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Filtro local_id inválido.');
    return (await localDaEmpresa(escopo, id)).id;
  }
  // Caixa aberto: só serve de referência quando é INEQUÍVOCO. Com duas
  // gavetas abertas (dois terminais), escolher "uma" abriria de novo a porta
  // para a tela mostrar o saldo de outro local — o defeito que este módulo
  // corrige. Nesse caso a referência é o Local padrão da empresa.
  const abertos = await getStore().list(
    R_CAIXA(),
    { page: 1, pageSize: 2, filter: { empresa_id: escopo.empresaId, status: 'aberto' } }
  );
  const caixa = abertos.total === 1 ? abertos.rows[0] : null;
  if (caixa && caixa.local_id !== null && caixa.local_id !== undefined && caixa.local_id !== '') {
    // Validado no tenant: um caixa apontando para local de outra empresa não
    // pode redirecionar a disponibilidade.
    return (await localDaEmpresa(escopo, Number(caixa.local_id))).id;
  }
  const { preferido } = await locaisDeSaida(escopo, null);
  return preferido.id;
}

/**
 * GET /api/pdv/buscar?codigo=789...&tamanho_id=&local_id=
 *
 * O que o leitor de código devolve à tela. `disponivel_no_tamanho` é o
 * ESTOQUE VENDÁVEL no local de saída (a célula que o faturamento baixa);
 * `estoque_fisico_no_tamanho` e `estoque_disponivel` são o físico (todos os
 * locais) e existem para a tela explicar a diferença — nunca para vender.
 */
export async function buscarProduto(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('produtos')!, actor, 'read');
  const escopo = escopoDe(actor);
  const codigo = String(req.query.codigo ?? req.query.q ?? req.query.sku ?? '');
  const tamanhoPedido = req.query.tamanho_id ? Number(req.query.tamanho_id) : null;
  const localId = await localDeSaidaDaBusca(req, escopo);
  const linha = await resolverProduto(codigo, escopo, undefined, tamanhoPedido, localId);
  // Físico do produto inteiro (todos os tamanhos, todos os locais) pela MESMA
  // agregação canônica. Não existe mais soma de `estoques` fora de
  // `estoqueCanonico.ts`: era assim que uma página truncada em 100 linhas
  // virava "disponível" na tela.
  const fisicoDoProduto = [...(await saldoPorTamanho(escopo, Number(linha.produto.id))).values()].reduce(
    (acc, item) => acc + item.quantidade,
    0
  );
  res.json({
    produto_id: Number(linha.produto.id),
    sku: linha.sku,
    sku_produto: linha.produto.sku,
    nome: linha.produto.nome,
    unidade: linha.produto.unidade ?? null,
    codigo_barras: linha.produto.codigo_barras ?? null,
    // O tamanho resolvido é devolvido à tela: é ele que a linha da venda vai
    // usar, e o operador precisa ver o que o leitor escolheu.
    tamanho_id: linha.tamanho_id,
    tamanho: linha.tamanho_codigo,
    eh_variacao: linha.eh_variacao,
    preco: linha.preco,
    preco_tabela: linha.preco_tabela,
    origem_preco: linha.lista_nome ? `Lista: ${linha.lista_nome}` : 'Ficha do produto',
    lista_preco_id: linha.lista_preco_id,
    // VENDÁVEL: a célula do local de saída (fallback Local padrão). É o número
    // que o operador pode vender de fato.
    disponivel_no_tamanho: linha.disponivel,
    local_id: linha.local_id,
    local: linha.local,
    disponivel_no_local: linha.disponivel_no_local,
    // FÍSICO: soma de todos os locais da empresa (inclui outros depósitos).
    estoque_fisico_no_tamanho: linha.disponivel_fisico,
    estoque_disponivel: fisicoDoProduto,
  });
}

// ----------------------------------------------------------------------------
// VENDA — o servidor recalcula tudo
// ----------------------------------------------------------------------------

type LinhaPdv = {
  codigo?: string;
  produto_id?: number;
  tamanho_id: number | null;
  quantidade: number;
  desconto_pct: number;
  /** Preço digitado pelo operador. É uma EXCEÇÃO e fica registrada. */
  preco_manual: number | null;
};

function normalizarLinhas(bruto: unknown): LinhaPdv[] {
  if (!Array.isArray(bruto) || !bruto.length) {
    throw new HttpError(400, 'Envie as linhas da venda em `itens`.');
  }
  return bruto.map((raw, index) => {
    const linha = (raw || {}) as Record<string, unknown>;
    const quantidade = Number(linha.quantidade ?? linha.qtd ?? 1);
    if (!Number.isFinite(quantidade) || quantidade <= 0) {
      throw new HttpError(400, `Linha ${index + 1}: a quantidade deve ser maior que zero.`, { [`itens[${index}].quantidade`]: 'Deve ser > 0' });
    }
    let desconto = Number(linha.desconto_pct ?? 0);
    if (!Number.isFinite(desconto)) desconto = 0;
    if (desconto < 0 || desconto > 100) {
      throw new HttpError(400, `Linha ${index + 1}: desconto_pct deve estar entre 0 e 100.`, { [`itens[${index}].desconto_pct`]: 'Entre 0 e 100' });
    }
    return {
      codigo: linha.codigo ?? linha.sku ?? linha.codigo_barras ? String(linha.codigo ?? linha.sku ?? linha.codigo_barras) : undefined,
      produto_id: linha.produto_id ? Number(linha.produto_id) : undefined,
      tamanho_id: linha.tamanho_id === undefined || linha.tamanho_id === null || linha.tamanho_id === '' ? null : Number(linha.tamanho_id),
      quantidade: round2(quantidade),
      desconto_pct: round2(desconto),
      preco_manual: linha.preco_manual === undefined || linha.preco_manual === null || linha.preco_manual === '' ? null : Number(linha.preco_manual),
    };
  });
}

type PagamentoEntrada = { forma: string; valor: number; valor_informado?: number; parcelas: number; nsu?: string | null; bandeira?: string | null };

function normalizarPagamentos(bruto: unknown): PagamentoEntrada[] {
  if (!Array.isArray(bruto)) throw new HttpError(400, 'pagamentos deve ser uma lista.', { pagamentos: 'Lista obrigatória' });
  return bruto.map((raw, index) => {
    const p = (raw || {}) as Record<string, unknown>;
    const forma = String(p.forma || '').toLowerCase();
    if (!FORMAS.includes(forma)) {
      throw new HttpError(400, `Pagamento ${index + 1}: forma "${forma}" não é aceita. Use ${FORMAS.join(', ')}.`, { [`pagamentos[${index}].forma`]: 'Inválida' });
    }
    const valor = round2(num(p.valor));
    if (!(valor > 0)) throw new HttpError(400, `Pagamento ${index + 1}: o valor deve ser maior que zero.`, { [`pagamentos[${index}].valor`]: 'Deve ser > 0' });
    const parcelas = Math.max(1, Math.trunc(num(p.parcelas, 1)));
    if (forma !== 'cartao_credito' && parcelas > 1) {
      throw new HttpError(400, `Pagamento ${index + 1}: só cartão de crédito aceita parcelamento.`, { [`pagamentos[${index}].parcelas`]: 'Apenas crédito' });
    }
    return { forma, valor, parcelas, nsu: p.nsu ? String(p.nsu).slice(0, 60) : null, bandeira: p.bandeira ? String(p.bandeira).slice(0, 30) : null };
  });
}

/**
 * POST /api/pdv/vendas
 *
 * Cria, paga e fatura a venda de balcão em UMA transação: pedido → estoque →
 * financeiro. Se qualquer parte falhar, nada fica pela metade.
 */
export async function venderPdv(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'create');
  const escopo = escopoDe(actor);
  const body = (req.body || {}) as Record<string, unknown>;
  const chaveIdempotencia =
    String(body.idempotency_key ?? req.header?.('idempotency-key') ?? '').trim().slice(0, 120) || null;
  const terminalSolicitado = body.terminal != null && String(body.terminal).trim() ? String(body.terminal).trim().slice(0, 60) : null;
  const autoImprimir = body.auto_imprimir !== false;
  const linhas = normalizarLinhas(body.itens ?? body.linhas);
  const pagamentos = normalizarPagamentos(body.pagamentos);
  const faturar = body.faturar !== false;
  const s = getStore();

  // Atalho idempotente antes de abrir nova escrita: refresh/timeout com a
  // mesma chave devolve a venda já confirmada sem duplicar baixa nem cupom.
  if (chaveIdempotencia) {
    const jaExiste = await s.findOneWhere(getResource('vendas')!, {
      empresa_id: escopo.empresaId,
      idempotency_key: chaveIdempotencia,
    });
    if (jaExiste) {
      const imp = await dispararImpressaoPosVendaPdv(Number(jaExiste.id), escopo, actor, {
        autoImprimir,
        terminalSolicitado,
        caixaId: jaExiste.pdv_caixa_id != null ? Number(jaExiste.pdv_caixa_id) : null,
      });
      res.status(200).json({
        ok: true,
        idempotente: true,
        venda_id: Number(jaExiste.id),
        venda: jaExiste,
        calculo: {
          subtotal_itens: round2(Number(jaExiste.total || 0) + Number(jaExiste.desconto || 0) - Number(jaExiste.frete || 0)),
          desconto: round2(Number(jaExiste.desconto || 0)),
          frete: round2(Number(jaExiste.frete || 0)),
          total: round2(Number(jaExiste.total || 0)),
          total_pago: round2(Number(jaExiste.pdv_valor_recebido ?? jaExiste.total ?? 0)),
          troco: round2(Number(jaExiste.pdv_troco ?? 0)),
        },
        impressao: imp,
        cupom_impressao: imp,
      });
      return;
    }
  }

  try {
    const resultado = await s.transaction(async (tx) => {
      if (chaveIdempotencia) {
        const existenteTx = await s.findOneWhere(
          getResource('vendas')!,
          { empresa_id: escopo.empresaId, idempotency_key: chaveIdempotencia },
          tx
        );
        if (existenteTx) {
          const caixaEx = existenteTx.pdv_caixa_id
            ? await findInTenant(R_CAIXA(), Number(existenteTx.pdv_caixa_id), escopo, tx)
            : null;
          return {
            idempotenteVenda: true,
            venda: existenteTx,
            subtotalItens: round2(Number(existenteTx.total || 0) + Number(existenteTx.desconto || 0) - Number(existenteTx.frete || 0)),
            descontoCupom: round2(Number(existenteTx.desconto || 0)),
            frete: round2(Number(existenteTx.frete || 0)),
            total: round2(Number(existenteTx.total || 0)),
            totalPago: round2(Number(existenteTx.pdv_valor_recebido ?? existenteTx.total ?? 0)),
            troco: round2(Number(existenteTx.pdv_troco ?? 0)),
            divergencias: [] as { linha: number; enviado: number | null; servidor: number }[],
            caixa: caixaEx || { id: existenteTx.pdv_caixa_id ?? null, numero: null },
            resolvidas: [] as { linha: LinhaPdv; info: LinhaResolvida; preco: number; subtotal: number }[],
            faturar: existenteTx.status === 'faturada',
          };
        }
      }
      // ---- caixa aberto é pré-condição: sem ele o fechamento não fecha ----
      let caixa: Row | null = null;
      if (body.caixa_id) {
        caixa = assertRegistroDaEmpresa(R_CAIXA(), await findInTenant(R_CAIXA(), Number(body.caixa_id), escopo, tx), escopo);
      } else {
        caixa = await s.findOneWhere(R_CAIXA(), { empresa_id: escopo.empresaId, status: 'aberto' }, tx);
      }
      if (!caixa) {
        throw new HttpError(409, 'Nenhum caixa aberto. Abra o caixa antes de vender no PDV.');
      }
      if (String(caixa.status) !== 'aberto') throw new HttpError(409, `O caixa "${caixa.numero}" está fechado.`);

      // ---- cliente (opcional no PDV — consumidor final é a regra) ----
      let clienteId: number | null = null;
      if (body.cliente_id !== undefined && body.cliente_id !== null && body.cliente_id !== '') {
        clienteId = Number(body.cliente_id);
        assertRegistroDaEmpresa(getResource('clientes')!, await findInTenant(getResource('clientes')!, clienteId, escopo, tx), escopo);
      }
      let representanteId: number | null = null;
      if (body.representante_id !== undefined && body.representante_id !== null && body.representante_id !== '') {
        representanteId = Number(body.representante_id);
        assertRegistroDaEmpresa(getResource('representantes')!, await findInTenant(getResource('representantes')!, representanteId, escopo, tx), escopo);
      }

      // ---- 1) local de saída: resolvido ANTES de precificar ----
      // A disponibilidade mostrada ao operador e a baixa do faturamento têm de
      // sair do MESMO local. Por isso o local é decidido aqui e viaja para
      // `resolverProduto`; o faturamento (`faturarVenda`) usa exatamente o mesmo
      // local de saída, com o mesmo fallback para o Local padrão.
      const localSaidaData: Record<string, unknown> = {};
      if (body.local_saida_id !== undefined) localSaidaData.local_id = body.local_saida_id;
      else if (body.local_saida !== undefined) localSaidaData.local = String(body.local_saida).slice(0, 60);
      else if (caixa.local_id !== null && caixa.local_id !== undefined) localSaidaData.local_id = caixa.local_id;
      else if (caixa.local) localSaidaData.local = String(caixa.local);
      await resolveLocal(localSaidaData, tx, escopo);
      const localSaida = String(localSaidaData.local);
      // E4.2.1: o ID resolvido é o canônico; o texto fica só para leitura/compatibilidade.
      const localSaidaId = Number(localSaidaData.local_id);

      // ---- 2) resolve cada linha: produto, TAMANHO, preço de lista, subtotal ----
      const resolvidas: { linha: LinhaPdv; info: LinhaResolvida; preco: number; subtotal: number }[] = [];
      let subtotalItens = 0;
      const divergencias: { linha: number; enviado: number | null; servidor: number }[] = [];
      for (let i = 0; i < linhas.length; i++) {
        const linha = linhas[i];
        const info = linha.codigo
          ? await resolverProduto(linha.codigo, escopo, tx, linha.tamanho_id, localSaidaId)
          : await resolverProduto(String(linha.produto_id), escopo, tx, linha.tamanho_id, localSaidaId);
        // O código lido tem que apontar para o produto informado. Aceitamos o
        // pai OU a própria variação: as duas formas de referir a mesma peça.
        if (linha.produto_id && Number(info.produto.id) !== linha.produto_id && Number(info.produto.produto_pai_id ?? 0) !== linha.produto_id) {
          throw new HttpError(400, `Linha ${i + 1}: o código lido aponta para o produto ${info.produto.sku}, não para o #${linha.produto_id}.`);
        }
        const precoServidor = info.preco;
        const precoManual = linha.preco_manual;
        const preco = precoManual !== null && Number.isFinite(precoManual) && precoManual >= 0 ? round2(precoManual) : precoServidor;
        if (precoManual !== null && round2(precoManual) !== precoServidor) {
          divergencias.push({ linha: i + 1, enviado: round2(precoManual), servidor: precoServidor });
        }
        const subtotal = round2(linha.quantidade * preco * (1 - linha.desconto_pct / 100));
        subtotalItens = round2(subtotalItens + subtotal);
        resolvidas.push({ linha, info, preco, subtotal });
      }

      // ---- 2) desconto e frete do cupom: números do servidor ----
      let descontoCupom = round2(Math.max(0, num(body.desconto)));
      if (subtotalItens > 0 && descontoCupom > subtotalItens) {
        throw new HttpError(400, `O desconto (${descontoCupom.toFixed(2)}) não pode ser maior que o subtotal (${subtotalItens.toFixed(2)}).`, { desconto: 'Maior que o subtotal' });
      }
      const descontoPctCupom = num(body.desconto_pct);
      if (descontoPctCupom > 0) {
        if (descontoPctCupom > 100) throw new HttpError(400, 'desconto_pct deve estar entre 0 e 100.', { desconto_pct: 'Entre 0 e 100' });
        descontoCupom = round2(descontoCupom + (subtotalItens * descontoPctCupom) / 100);
        if (descontoCupom > subtotalItens) descontoCupom = subtotalItens;
      }
      const frete = round2(Math.max(0, num(body.frete)));
      const total = round2(Math.max(0, subtotalItens - descontoCupom + frete));

      // ---- 3) pagamentos: o servidor confere se cobre o total ----
      const totalPago = round2(pagamentos.reduce((acc, p) => acc + p.valor, 0));
      const emDinheiro = round2(pagamentos.filter((p) => p.forma === 'dinheiro').reduce((acc, p) => acc + p.valor, 0));
      const emOutros = round2(totalPago - emDinheiro);
      if (totalPago < total - 0.009) {
        throw new HttpError(400, `Pagamento insuficiente: total ${total.toFixed(2)}, recebido ${totalPago.toFixed(2)}. Faltam ${(total - totalPago).toFixed(2)}.`, { pagamentos: 'Insuficiente' });
      }
      // Troco só faz sentido em dinheiro; nas demais formas, valor = total.
      if (emOutros > total - emDinheiro + 0.009 && emDinheiro === 0) {
        throw new HttpError(400, `Pagamento excede o total (${totalPago.toFixed(2)} > ${total.toFixed(2)}). Só dinheiro gera troco.`, { pagamentos: 'Excede o total' });
      }
      const troco = round2(Math.max(0, totalPago - total));
      // Troco é dinheiro: não existe troco pago com cartão/pix. Mais do que uma
      // validação, isto é o que impede o movimento de caixa de virar negativo.
      if (troco > emDinheiro + 0.009) {
        throw new HttpError(
          400,
          `O troco (${troco.toFixed(2)}) não pode ser maior que o dinheiro recebido (${emDinheiro.toFixed(2)}). Registre a devolução em dinheiro como sangria ou ajuste os valores recebidos.`,
          { pagamentos: 'Troco maior que o dinheiro' }
        );
      }

      /**
       * O MOVIMENTO de caixa vale o efeito LÍQUIDO na gaveta: o dinheiro
       * ENTREGUE menos o troco DEVOLVIDO. O troco é do cliente — não fica na
       * gaveta e não pode virar receita em dinheiro.
       *
       * Era aqui a origem da divergência de R$ 15,00 da auditoria
       * ERP-COMMERCE-01: a coluna `valor` recebia os 30,00 entregues em uma
       * venda de 25,00 paga com troco de 15,00, e o resumo somava 30,00 de
       * dinheiro onde só havia 15,00 na gaveta. O valor entregue e o troco
       * continuam no contrato da resposta (`calculo.total_pago`/`troco`) e na
       * auditoria da venda; o MOVIMENTO guarda o que de fato entrou no caixa.
       */
      const pagamentosParaCaixa: PagamentoEntrada[] = [];
      let trocoACompensar = troco;
      for (const p of pagamentos) {
        let valorNoCaixa = p.valor;
        if (p.forma === 'dinheiro' && trocoACompensar > 0.009) {
          const abate = Math.min(valorNoCaixa, trocoACompensar);
          valorNoCaixa = round2(valorNoCaixa - abate);
          trocoACompensar = round2(trocoACompensar - abate);
        }
        // O troco pode consumir toda a linha em dinheiro (cliente devolveu tudo
        // o que entregou): aí não existe movimento — `pdv_pagamentos.valor` é
        // CHECK > 0 e zero não movimenta gaveta nenhuma.
        if (valorNoCaixa <= 0.009) continue;
        pagamentosParaCaixa.push({ ...p, valor: valorNoCaixa, valor_informado: p.valor });
      }

      // ---- 4) grava o pedido (local de saída já resolvido no passo 1) ----
      const venda = await s.insert(
        getResource('vendas')!,
        {
          empresa_id: escopo.empresaId,
          cliente_id: clienteId,
          representante_id: representanteId,
          data: new Date().toISOString().slice(0, 10),
          status: 'aberta',
          canal_venda: 'pdv',
          pdv_caixa_id: Number(caixa.id),
          pdv_operador_id: actor.id || null,
          pdv_valor_recebido: totalPago,
          pdv_troco: troco,
          idempotency_key: chaveIdempotencia,
          local_saida: localSaida,
          local_saida_id: localSaidaId,
          desconto: descontoCupom,
          frete,
          total,
          fin_forma_pagamento: pagamentos.length === 1 ? pagamentos[0].forma : 'outros',
          fin_parcelas: pagamentos.length === 1 ? pagamentos[0].parcelas : 1,
          fin_status: faturar ? 'recebido' : 'a_receber',
          fin_recebido_em: faturar ? new Date().toISOString().slice(0, 10) : null,
          observacoes: body.observacoes ? String(body.observacoes).slice(0, 2000) : null,
        },
        tx
      );

      for (const r of resolvidas) {
        await s.insert(
          getResource('itens_venda')!,
          {
            empresa_id: escopo.empresaId,
            venda_id: Number(venda.id),
            produto_id: Number(r.info.produto.id),
            // O tamanho RESOLVIDO (variação, informado ou único com estoque) —
            // nunca o que a tela mandou: é ele que o faturamento usa para achar
            // o saldo, e `itens_venda.tamanho_id` é obrigatório neste ERP.
            tamanho_id: r.info.tamanho_id ?? null,
            quantidade: r.linha.quantidade,
            preco_unitario: r.preco,
            desconto_pct: r.linha.desconto_pct,
            subtotal: r.subtotal,
            lista_preco_id: r.info.lista_preco_id,
            preco_tabela: r.info.preco_tabela,
          },
          tx
        );
      }

      // O movimento de caixa é gravado por `pagamentosParaCaixa`: mesmo
      // pagamento (NSU, bandeira, parcelas), valor = efeito líquido na gaveta.
      for (const p of pagamentosParaCaixa) {
        await s.insert(
          R_PAGAMENTO(),
          {
            empresa_id: escopo.empresaId,
            venda_id: Number(venda.id),
            caixa_id: Number(caixa.id),
            forma: p.forma,
            valor: p.valor,
            valor_informado: p.valor_informado ?? p.valor,
            parcelas: p.parcelas,
            nsu: p.nsu ?? null,
            bandeira: p.bandeira ?? null,
          },
          tx
        );
      }

      // ---- 5) faturamento: estoque + comissão + financeiro ----
      let faturada: Row = venda;
      if (faturar) {
        const patch = { status: 'faturada' };
        faturada = (await s.tryUpdateIf(getResource('vendas')!, Number(venda.id), { status: 'aberta' }, patch, tx)) || venda;
        await aplicarRegrasPedido('venda', venda, faturada, patch, { id: actor.id || null, name: actor.name }, tx, escopo);
        const depois = (await findInTenant(getResource('vendas')!, Number(venda.id), escopo, tx)) || faturada;
        await syncLancamentoVenda(venda, depois, patch, { id: actor.id || null, name: actor.name }, tx);
        faturada = depois;
      }

      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'criar',
          recurso: 'vendas',
          registro_id: Number(venda.id),
          descricao: `Venda PDV #${venda.id} — ${resolvidas.length} item(ns), total ${total.toFixed(2)}, pago ${totalPago.toFixed(2)}${troco ? `, troco ${troco.toFixed(2)}` : ''}`,
          empresa_id: empresaDoRegistroAudit(getResource('vendas')!, venda, actor),
          dados: { caixa_id: caixa.id, subtotal_itens: subtotalItens, desconto: descontoCupom, frete, total, total_pago: totalPago, troco, divergencias, faturada: faturar },
        },
        tx
      );

      return { idempotenteVenda: false, venda: faturada, subtotalItens, descontoCupom, frete, total, totalPago, troco, divergencias, caixa, resolvidas, faturar };
    }, { isolation: 'serializable' });

    // P2: Impressão automática NÃO BLOQUEANTE e FORA da transação da venda.
    // Se a impressora estiver offline ou houver erro ao enfileirar, a venda
    // já está gravada e faturada — nunca desfaz nem duplica venda.
    const impressao = await dispararImpressaoPosVendaPdv(Number(resultado.venda.id), escopo, actor, {
      autoImprimir,
      terminalSolicitado,
      caixaNumero: resultado.caixa?.numero ? String(resultado.caixa.numero) : null,
    });

    res.status(resultado.idempotenteVenda ? 200 : 201).json({
      ok: true,
      ...(resultado.idempotenteVenda ? { idempotente: true } : {}),
      venda_id: Number(resultado.venda.id),
      venda: resultado.venda,
      caixa: { id: resultado.caixa.id, numero: resultado.caixa.numero },
      // O servidor manda de volta a conta que ELE fez — é esta que vale.
      calculo: {
        subtotal_itens: resultado.subtotalItens,
        desconto: resultado.descontoCupom,
        frete: resultado.frete,
        total: resultado.total,
        total_pago: resultado.totalPago,
        troco: resultado.troco,
      },
      itens: resultado.resolvidas.map((r, i) => ({
        linha: i + 1,
        produto_id: Number(r.info.produto.id),
        sku: r.info.sku,
        sku_produto: r.info.produto.sku,
        nome: r.info.produto.nome,
        tamanho_id: r.info.tamanho_id,
        tamanho: r.info.tamanho_codigo,
        eh_variacao: r.info.eh_variacao,
        quantidade: r.linha.quantidade,
        preco_unitario: r.preco,
        desconto_pct: r.linha.desconto_pct,
        subtotal: r.subtotal,
        preco_tabela: r.info.preco_tabela,
        // Vendável no local de saída (o mesmo que o faturamento baixa).
        disponivel_antes: r.info.disponivel,
        disponivel_fisico: r.info.disponivel_fisico,
        local_saida_id: r.info.local_id,
        local_saida: r.info.local,
        origem_preco: r.info.lista_nome ? `Lista: ${r.info.lista_nome}` : 'Ficha do produto',
      })),
      divergencias_de_preco: resultado.divergencias,
      fiscal: {
        elegivel: resultado.faturar,
        modelo: '65',
        endpoint: `/api/vendas/${resultado.venda.id}/fiscal/emitir`,
        mensagem: 'Para emitir a NFC-e, chame o endpoint acima. A venda já está gravada e faturada independentemente da emissão.',
      },
      impressao,
      cupom_impressao: impressao,
    });
  } catch (e) {
    // Corrida em Postgres (23505) na mesma idempotency_key de venda:
    if (chaveIdempotencia && !(e instanceof HttpError)) {
      const vencedora = await s.findOneWhere(getResource('vendas')!, {
        empresa_id: escopo.empresaId,
        idempotency_key: chaveIdempotencia,
      }).catch(() => null);
      if (vencedora) {
        const imp = await dispararImpressaoPosVendaPdv(Number(vencedora.id), escopo, actor, {
          autoImprimir,
          terminalSolicitado,
        });
        res.status(200).json({
          ok: true,
          idempotente: true,
          venda_id: Number(vencedora.id),
          venda: vencedora,
          calculo: {
            subtotal_itens: round2(Number(vencedora.total || 0) + Number(vencedora.desconto || 0) - Number(vencedora.frete || 0)),
            desconto: round2(Number(vencedora.desconto || 0)),
            frete: round2(Number(vencedora.frete || 0)),
            total: round2(Number(vencedora.total || 0)),
            total_pago: round2(Number(vencedora.pdv_valor_recebido ?? vencedora.total ?? 0)),
            troco: round2(Number(vencedora.pdv_troco ?? 0)),
          },
          impressao: imp,
          cupom_impressao: imp,
        });
        return;
      }
    }
    throw toHttpError(e, getResource('vendas')!);
  }
}

/**
 * POST /api/pdv/vendas/:id/cancelar — cancelamento controlado.
 *
 * Controlado significa: motivo obrigatório, auditoria, e recusa quando a venda
 * já tem documento fiscal autorizado (aí o caminho é o cancelamento da nota,
 * não o sumiço da venda).
 */
export async function cancelarVendaPdv(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'update');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const motivo = String((req.body || {}).motivo || '').trim();
  if (motivo.length < 5) {
    throw new HttpError(400, 'Informe o motivo do cancelamento (mínimo 5 caracteres).', { motivo: 'Mínimo 5 caracteres' });
  }
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const venda = assertRegistroDaEmpresa(getResource('vendas')!, await findInTenant(getResource('vendas')!, id, escopo, tx), escopo);
      if (String(venda.status) === 'cancelada') throw new HttpError(409, 'Esta venda já está cancelada.');

      // P2 §6 — caixa fechado é histórico imutável. Cancelar uma venda de um
      // caixa FECHADO reescreve o resumo já conferido (esperado × contado ×
      // diferença): proibido, salvo permissão administrativa EXPLÍCITA — e
      // ainda assim com auditoria marcando a retroatividade.
      if (venda.pdv_caixa_id) {
        const caixa = assertRegistroDaEmpresa(R_CAIXA(), await findInTenant(R_CAIXA(), Number(venda.pdv_caixa_id), escopo, tx), escopo);
        if (String(caixa.status) === 'fechado') {
          if (actor.perfil !== 'admin') {
            throw new HttpError(
              409,
              `A venda #${id} pertence ao caixa "${caixa.numero}", fechado em ${String(caixa.fechamento_em || '').slice(0, 16)}. Alteração retroativa em caixa fechado exige perfil administrador.`
            );
          }
          await s.audit(
            {
              usuario_id: actor.id || null,
              usuario: actor.name,
              acao: 'editar',
              recurso: 'pdv_caixas',
              registro_id: Number(caixa.id),
              descricao: `ATENÇÃO: cancelamento RETROATIVO da venda #${id} no caixa fechado "${caixa.numero}" autorizado por administrador (${actor.name})`,
              empresa_id: empresaDoRegistroAudit(R_CAIXA(), caixa, actor),
              dados: { venda_id: id, retroativo: true, fechamento_em: caixa.fechamento_em },
            },
            tx
          );
        }
      }

      const docVivo = await s.list(
        getResource('documentos_fiscais')!,
        { page: 1, pageSize: 5, filter: { empresa_id: escopo.empresaId, venda_id: id, status: 'autorizado' } },
        tx
      );
      if (docVivo.rows.length) {
        throw new HttpError(
          409,
          `Esta venda tem documento fiscal autorizado (nº ${docVivo.rows[0].numero}, chave ${docVivo.rows[0].chave_acesso}). Cancele a nota antes de cancelar a venda.`,
          { documento_fiscal_id: docVivo.rows[0].id }
        );
      }
      const antes = venda;
      const cancelada = await s.tryUpdateIf(getResource('vendas')!, id, { status: venda.status }, { status: 'cancelada' }, tx);
      if (!cancelada) throw new HttpError(409, 'A venda mudou durante o cancelamento. Recarregue e tente de novo.');
      // Estorno de estoque + financeiro pelo MESMO caminho do pedido de balcão.
      await aplicarRegrasPedido('venda', antes, cancelada, { status: 'cancelada' }, { id: actor.id || null, name: actor.name }, tx, escopo);
      const depois = (await findInTenant(getResource('vendas')!, id, escopo, tx)) || cancelada;
      await syncLancamentoVenda(antes, depois, { status: 'cancelada' }, { id: actor.id || null, name: actor.name }, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'vendas', registro_id: id, descricao: `Venda PDV #${id} cancelada — motivo: ${motivo}`, dados: { motivo, caixa_id: antes.pdv_caixa_id ?? null }, empresa_id: empresaDoRegistroAudit(getResource('vendas')!, venda, actor) },
        tx
      );
      return depois;
    }, { isolation: 'serializable' });
    res.json({ ok: true, venda: out, mensagem: 'Venda cancelada, estoque estornado e financeiro revertido.' });
  } catch (e) {
    throw toHttpError(e, getResource('vendas')!);
  }
}

/** GET /api/pdv/vendas/:id/pagamentos */
export async function pagamentosVenda(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  assertRegistroDaEmpresa(getResource('vendas')!, await findInTenant(getResource('vendas')!, id, escopo), escopo);
  const out = await s.list(R_PAGAMENTO(), { page: 1, pageSize: 100, filter: { empresa_id: escopo.empresaId, venda_id: id }, sort: 'id', dir: 'asc' });
  res.json(out.rows);
}

// ============================================================================
// P2 — Impressão Automática Não-Bloqueante, Reimpressão Auditada e Contingência
// ============================================================================

export function chaveCupomAutomaticoPdv(vendaId: number): string {
  return `recibo:pdv:venda:${vendaId}`;
}

export async function dispararImpressaoPosVendaPdv(
  vendaId: number,
  escopo: ReturnType<typeof escopoDe>,
  actor: ReturnType<typeof currentUser>,
  opts: {
    autoImprimir?: boolean;
    terminalSolicitado?: string | null;
    caixaNumero?: string | null;
    caixaId?: number | null;
  } = {}
): Promise<Record<string, unknown>> {
  const fallbackHtmlUrl = `/api/pdv/vendas/${vendaId}/cupom/html`;
  const fallbackPdfUrl = `/api/pdv/vendas/${vendaId}/cupom/pdf`;
  if (opts.autoImprimir === false) {
    return {
      enfileirado: false,
      job_public_id: null,
      status: 'desativado',
      idempotente: false,
      erro: null,
      fallback_html_url: fallbackHtmlUrl,
      fallback_pdf_url: fallbackPdfUrl,
    };
  }
  try {
    const doc = await construirCupomPdvPrintIR(vendaId, escopo);
    const dest = await resolverDestinoImpressao(escopo.empresaId, 'recibo', {
      terminal: opts.terminalSolicitado || undefined,
    });
    // Se não houve terminal explícito, tenta casar configuração do número do caixa
    const destCaixa = !opts.terminalSolicitado && !dest.terminalConfig && (opts.caixaNumero || doc.caixaNumero)
      ? await resolverDestinoImpressao(escopo.empresaId, 'recibo', { terminal: opts.caixaNumero || doc.caixaNumero || undefined })
      : null;
    const efetivo = destCaixa?.terminalConfig ? destCaixa : dest;

    if (!efetivo.autoPrintPdv) {
      return {
        enfileirado: false,
        job_public_id: null,
        status: 'desativado',
        idempotente: false,
        erro: null,
        fallback_mode: efetivo.fallbackMode,
        fallback_html_url: fallbackHtmlUrl,
        fallback_pdf_url: fallbackPdfUrl,
      };
    }

    const { job, idempotente } = await enfileirarJob(escopo.empresaId, atorDeUsuario(actor), {
      docType: 'recibo_pdv',
      source: 'pdv',
      sourceRef: doc.sourceRef,
      terminal: opts.terminalSolicitado || (efetivo.terminalConfig ? efetivo.terminal : null),
      printerName: efetivo.printerName,
      copies: efetivo.copiesDefault,
      priority: 30,
      content: doc.blocks,
      metadata: {
        ...doc.metadata,
        protocol: efetivo.protocol === 'text' ? 'text' : 'escpos',
        widthCols: efetivo.widthCols,
      },
      idempotencyKey: chaveCupomAutomaticoPdv(vendaId),
      maxAttempts: 3,
    });

    return {
      enfileirado: true,
      job_public_id: String(job.public_id),
      job_id: job.public_id,
      status: String(job.status),
      job_status: job.status,
      idempotente,
      erro: null,
      terminal: job.terminal ?? null,
      printer_name: job.printer_name ?? null,
      protocol: efetivo.protocol === 'text' ? 'text' : 'escpos',
      fallback_mode: efetivo.fallbackMode,
      fallback_html_url: fallbackHtmlUrl,
      fallback_pdf_url: fallbackPdfUrl,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 200) : 'Falha ao enfileirar cupom';
    console.warn(`[print:pdv] falha não-bloqueante ao enfileirar cupom da venda #${vendaId}: ${msg}`);
    return {
      enfileirado: false,
      job_public_id: null,
      status: 'falha_enfileiramento',
      idempotente: false,
      erro: msg,
      fallback_html_url: fallbackHtmlUrl,
      fallback_pdf_url: fallbackPdfUrl,
    };
  }
}

/**
 * POST /api/pdv/vendas/:id/cupom — garante/consulta o job inicial idempotente
 * do cupom da venda (jamais duplica se já enfileirado ou impresso).
 */
export async function emitirCupomPdvHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  const escopo = escopoDe(actor);
  const vendaId = parseId(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;

  const doc = await construirCupomPdvPrintIR(vendaId, escopo);
  const s = getStore();
  // Se o cupom automático já existe na fila para esta venda, devolve-o sem
  // exigir hash idêntico caso o operador mude apenas parâmetros de tela.
  const jaCriado = await s.findOneWhere(R_JOBS(), {
    empresa_id: escopo.empresaId,
    idempotency_key: chaveCupomAutomaticoPdv(vendaId),
  });
  if (jaCriado) {
    res.status(200).json({
      job: jobPublico(jaCriado),
      idempotente: true,
      fallback_html_url: `/api/pdv/vendas/${vendaId}/cupom/html`,
      fallback_pdf_url: `/api/pdv/vendas/${vendaId}/cupom/pdf`,
    });
    return;
  }

  const dest = await resolverDestinoImpressao(escopo.empresaId, 'recibo', {
    terminal: body.terminal != null ? String(body.terminal) : undefined,
    printerName: body.printer_name != null ? String(body.printer_name) : undefined,
  });

  const { job, idempotente } = await enfileirarJob(escopo.empresaId, atorDeUsuario(actor), {
    docType: 'recibo_pdv',
    source: 'pdv',
    sourceRef: doc.sourceRef,
    terminal: body.terminal != null ? dest.terminal : (dest.terminalConfig ? dest.terminal : null),
    printerName: dest.printerName,
    copies: dest.copiesDefault,
    priority: 30,
    content: doc.blocks,
    metadata: {
      ...doc.metadata,
      protocol: dest.protocol === 'text' ? 'text' : 'escpos',
      widthCols: dest.widthCols,
    },
    idempotencyKey: chaveCupomAutomaticoPdv(vendaId),
    maxAttempts: 3,
  });

  res.status(idempotente ? 200 : 201).json({
    job: jobPublico(job),
    idempotente,
    fallback_html_url: `/api/pdv/vendas/${vendaId}/cupom/html`,
    fallback_pdf_url: `/api/pdv/vendas/${vendaId}/cupom/pdf`,
  });
}

/**
 * POST /api/pdv/vendas/:id/reimprimir — reimpressão explícita, autenticada,
 * validada por permissão e integralmente auditada (`reprint_of`, motivo,
 * terminal, venda associada, solicitante e timestamp).
 */
export async function reimprimirCupomPdvHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  const escopo = escopoDe(actor);
  const vendaId = parseId(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const s = getStore();

  const venda = assertRegistroDaEmpresa(
    getResource('vendas')!,
    await findInTenant(getResource('vendas')!, vendaId, escopo),
    escopo
  );
  const caixa = venda.pdv_caixa_id ? await findInTenant(R_CAIXA(), Number(venda.pdv_caixa_id), escopo) : null;

  const doc = await construirCupomPdvPrintIR(vendaId, escopo);
  const termPed = body.terminal != null && String(body.terminal).trim() ? String(body.terminal).trim() : null;
  const dest = await resolverDestinoImpressao(escopo.empresaId, 'recibo', {
    terminal: termPed || doc.caixaNumero || undefined,
    printerName: body.printer_name != null ? String(body.printer_name) : undefined,
  });

  // Controle de permissão fina na reimpressão do PDV:
  //   • admin e gerente podem reimprimir qualquer venda da empresa;
  //   • operador respeita `allowOperatorReprint` do terminal e só reimprime
  //     vendas do seu próprio caixa/operação.
  if (actor.perfil === 'operador') {
    if (!dest.allowOperatorReprint) {
      throw new HttpError(403, 'Reimpressão neste terminal exige autorização de gerente ou administrador.');
    }
    const donoOperador = Number(venda.pdv_operador_id || caixa?.usuario_id || 0);
    if (donoOperador > 0 && donoOperador !== actor.id) {
      throw new HttpError(403, 'Operador só pode reimprimir cupons emitidos no próprio caixa/operação.');
    }
  }

  const copies = body.copies !== undefined ? Number(body.copies) : 1;
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIAS_REIMPRESSAO) {
    throw new HttpError(400, `Número de cópias na reimpressão deve estar entre 1 e ${MAX_COPIAS_REIMPRESSAO}.`);
  }

  const motivo = String(body.motivo ?? body.reprint_reason ?? '').trim().slice(0, 240) || null;
  const anteriores = await s.list(R_JOBS(), {
    page: 1,
    pageSize: 5,
    filter: { empresa_id: escopo.empresaId, source_ref: `venda:${vendaId}` },
    sort: 'criado_em',
    dir: 'desc',
  });
  const jobOriginal = anteriores.rows[0] ?? null;
  const reprintOf = jobOriginal ? String(jobOriginal.reprint_of || jobOriginal.public_id) : `venda:${vendaId}`;

  const chave =
    String(body.idempotency_key ?? req.header('idempotency-key') ?? '').trim().slice(0, PRINT_LIMITS.idempotencyKeyMax) ||
    `reprint:pdv:venda:${vendaId}:${randomUUID()}`;

  const terminalFinal = termPed || (dest.terminalConfig ? dest.terminal : (jobOriginal?.terminal as string) || null);
  const { job, idempotente } = await enfileirarJob(
    escopo.empresaId,
    atorDeUsuario(actor),
    {
      docType: 'recibo_pdv',
      source: 'pdv',
      sourceRef: doc.sourceRef,
      terminal: terminalFinal,
      printerName: dest.printerName || ((jobOriginal?.printer_name as string) ?? null),
      copies,
      priority: 25,
      content: doc.blocks,
      metadata: {
        ...doc.metadata,
        protocol: dest.protocol === 'text' ? 'text' : 'escpos',
        widthCols: dest.widthCols,
        reprint: true,
        ...(motivo ? { reprint_reason: motivo } : {}),
      },
      idempotencyKey: chave,
      maxAttempts: 3,
    },
    { reprintOf, reprintReason: motivo }
  );

  if (!idempotente) {
    await auditarImpressao(
      atorDeUsuario(actor),
      'print.pdv.reprinted',
      job,
      motivo ? `Reimpressão do cupom PDV #${vendaId} (${motivo})` : `Reimpressão do cupom PDV #${vendaId}`,
      {
        venda_id: vendaId,
        caixa_id: venda.pdv_caixa_id ?? null,
        terminal: terminalFinal,
        reprint_of: reprintOf,
        motivo: motivo ?? undefined,
        copies,
      }
    );
  }

  res.status(idempotente ? 200 : 201).json({
    job: jobPublico(job),
    idempotente,
    reprint_of: reprintOf,
    fallback_html_url: `/api/pdv/vendas/${vendaId}/cupom/html`,
    fallback_pdf_url: `/api/pdv/vendas/${vendaId}/cupom/pdf`,
  });
}

/** GET /api/pdv/vendas/:id/cupom/html — contingência HTML 80mm do cupom PDV. */
export async function cupomPdvHtmlHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  const escopo = escopoDe(actor);
  const vendaId = parseId(req.params.id);
  const doc = await construirCupomPdvPrintIR(vendaId, escopo);
  const html = await renderPrintIrHtml(
    {
      version: PRINT_IR_VERSION,
      jobId: randomUUID(),
      tenantId: String(escopo.empresaId),
      companyId: String(escopo.empresaId),
      requestedBy: { userId: actor.id || null, userName: actor.name },
      source: 'pdv',
      docType: 'recibo_pdv',
      related: doc.related,
      copies: 1,
      priority: 0,
      content: doc.blocks,
      metadata: doc.metadata,
      idempotencyKey: `fallback:pdv:venda:${vendaId}`,
      createdAt: new Date().toISOString(),
    },
    { title: `Cupom PDV #${vendaId}` }
  );
  enviarHtmlSeguro(res, html);
}

/** GET /api/pdv/vendas/:id/cupom/pdf — contingência PDF 80mm do cupom PDV. */
export async function cupomPdvPdfHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  const escopo = escopoDe(actor);
  const vendaId = parseId(req.params.id);
  const doc = await construirCupomPdvPrintIR(vendaId, escopo);
  await renderPrintIrPdf(
    {
      version: PRINT_IR_VERSION,
      jobId: randomUUID(),
      tenantId: String(escopo.empresaId),
      companyId: String(escopo.empresaId),
      requestedBy: { userId: actor.id || null, userName: actor.name },
      source: 'pdv',
      docType: 'recibo_pdv',
      related: doc.related,
      copies: 1,
      priority: 0,
      content: doc.blocks,
      metadata: doc.metadata,
      idempotencyKey: `fallback:pdv:venda:${vendaId}`,
      createdAt: new Date().toISOString(),
    },
    res,
    `cupom-pdv-${vendaId}.pdf`
  );
}
