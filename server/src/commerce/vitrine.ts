// ============================================================================
// VITRINE PRÓPRIA — rotas PÚBLICAS /api/loja/* (checkout B2C).
//
// Regras inegociáveis desta tela:
//   • preço, estoque, cupom e total são calculados NO SERVIDOR (o front só
//     exibe; o preview existe para o carrinho revalidar a cada mudança);
//   • reserva de estoque ANTES da cobrança, no motor canônico;
//   • pagamento criado pelo backend via gateway (o front nunca confirma);
//   • idempotência por `chave_checkout` (reenvio do carrinho não duplica
//     pedido, reserva nem cobrança);
//   • frete vem do FreightProvider — "Frete não configurado" é resposta
//     honesta, nunca um valor inventado;
//   • falhou a cobrança → pedido ERRO + reservas/cupom liberados (o cliente
//     pode tentar de novo com um carrinho novo).
// ============================================================================
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { HttpError } from '../errors';
import { getStore } from '../services';
import { escopoDeSistema } from '../empresa';
import { getResource } from '../resources';
import { paymentEngine } from '../../../modules/payments/orchestration/payment-orchestrator';
import { availableMethods, candidates } from '../../../modules/payments/application/configuration';
import { METHODS, type PaymentMethod } from '../../../modules/payments/domain/payment';
import { criarReservaInterna, liberarReservaInterna } from '../estoqueTransferencia';
import { saldoVendavel } from '../estoqueCanonico';
import { attachImages } from '../uploads';
import { marketplaceSaleReference } from '../../../modules/connectors/ingestion/sales.service';
import { connectorCuid } from '../../../modules/connectors/core/id';
import { configuracaoFreteValida, cotarFrete } from './frete';
import { configDaLoja, freteDaConfig, exigirVitrine, responsavelCheckout } from './loja-base';
import { pagamentoDaLoja } from './estado-loja';
import { disponibilidadesPorTamanho, normalizarMetadados } from './catalogo';
import { montarVisaoDaSale, ORIGEM_CHECKOUT } from './pedidos';
import {
  avaliarCupomCodigo,
  consumirUsoCupom,
  descontoFinalDoCheckout,
  liberarUsoCupom,
  melhorPromocaoAtiva,
  normalizarCodigo,
} from './promocoes';
import type { Row } from '../store';
import { calcularTotaisCheckout, paraCentavos, precoEfetivo, round2 } from './regras';

const R_PRODUTOS = () => getResource('produtos')!;
const R_PROD_COM = () => getResource('commerce_produtos')!;
const R_PRECOS = () => getResource('commerce_precos')!;
const R_PUBLICACOES = () => getResource('commerce_publicacoes')!;
const R_PEDIDOS = () => getResource('commerce_pedidos')!;
const R_SALES = () => getResource('sales')!;
const R_SALE_ITEMS = () => getResource('sale_items')!;

// ----------------------------------------------------------------------------
// Estado da vitrine (PUBLISHED no canal BROBOND + produto ativo)
// ----------------------------------------------------------------------------

type VisiveisVitrine = {
  empresaId: number;
  visiveis: Map<number, Row>; // produto_id → produto
  projecoes: Map<number, Row>;
  precos: Map<string, Row>;
};

async function carregarVitrine(empresaId: number): Promise<VisiveisVitrine> {
  const s = getStore();
  const [produtos, projecoes, precos, publicacoes] = await Promise.all([
    s.list(R_PRODUTOS(), { page: 1, pageSize: 1000, filter: { empresa_id: empresaId }, sort: 'nome', dir: 'asc' }),
    s.list(R_PROD_COM(), { page: 1, pageSize: 2000, filter: { empresa_id: empresaId } }),
    s.list(R_PRECOS(), { page: 1, pageSize: 4000, filter: { empresa_id: empresaId, canal: 'BROBOND' } }),
    s.list(R_PUBLICACOES(), { page: 1, pageSize: 4000, filter: { empresa_id: empresaId, canal: 'BROBOND' } }),
  ]);
  const pubPpublished = new Set<number>();
  for (const p of publicacoes.rows) if (String(p.estado) === 'PUBLISHED') pubPpublished.add(Number(p.produto_id));
  const visiveis = new Map<number, Row>();
  const projMap = new Map<number, Row>();
  for (const pj of projecoes.rows) projMap.set(Number(pj.produto_id), pj);
  for (const prod of produtos.rows) {
    const pid = Number(prod.id);
    if (prod.ativo === false) continue;
    if (!projMap.has(pid)) continue;
    if (!pubPpublished.has(pid)) continue;
    visiveis.set(pid, prod);
  }
  const precoMap = new Map<string, Row>();
  for (const pr of precos.rows) precoMap.set(`${Number(pr.produto_id)}:${String(pr.canal)}`, pr);
  return { empresaId, visiveis, projecoes: projMap, precos: precoMap };
}

function precoPublico(produto: Row, precos: Map<string, Row>): { preco: number; preco_original: number | null; promocional: boolean } {
  const linha = precos.get(`${Number(produto.id)}:BROBOND`);
  const eff = precoEfetivo({
    base: Number(produto.preco_venda ?? 0),
    precoCanal: linha ? Number(linha.preco ?? 0) : null,
    precoPromoCanal: linha && linha.preco_promo != null ? Number(linha.preco_promo) : null,
    vigenciaInicio: (linha?.vigencia_inicio as string | null) ?? null,
    vigenciaFim: (linha?.vigencia_fim as string | null) ?? null,
  });
  const unidade = eff.promo ?? eff.preco;
  return { preco: round2(unidade), preco_original: eff.promo != null ? eff.preco : null, promocional: eff.promo != null };
}

// ----------------------------------------------------------------------------
// GET /api/loja/config — identidade + frete (subset seguro, sem internos)
// ----------------------------------------------------------------------------

export async function lojaConfigPublica(req: Request, res: Response) {
  const { empresaId, config } = await exigirVitrine();
  let responsavelOk = false;
  try { await responsavelCheckout(empresaId, config); responsavelOk = true; }
  catch (error) { if (!(error instanceof HttpError) || error.status !== 409) throw error; }
  res.json({
    loja_nome: config?.loja_nome ? String(config.loja_nome) : 'BROBOND',
    loja_descricao: config?.loja_descricao ? String(config.loja_descricao) : null,
    frete: {
      provedor: String(config?.frete_provedor || 'nenhum'),
      valor: config?.frete_valor != null ? Number(config.frete_valor) : 0,
      gratis_acima: config?.frete_gratis_acima != null ? Number(config.frete_gratis_acima) : null,
      prazo_dias: config?.frete_prazo_dias != null ? Number(config.frete_prazo_dias) : null,
      disponivel: configuracaoFreteValida(freteDaConfig(config)),
      ...(!configuracaoFreteValida(freteDaConfig(config)) ? { motivo: 'Frete não configurado' } : {}),
    },
    checkout_disponivel: responsavelOk && configuracaoFreteValida(freteDaConfig(config)) && (await pagamentoDaLoja(empresaId)).configurado,
    checkout_expira_minutos: config?.checkout_expira_minutos != null ? Number(config.checkout_expira_minutos) : 60,
  });
}

// ----------------------------------------------------------------------------
// GET /api/loja/produtos + /:slug — catálogo público (só PUBLISHED)
// ----------------------------------------------------------------------------

export async function lojaProdutosPublicos(req: Request, res: Response) {
  const { empresaId, visiveis, projecoes, precos } = await carregarVitrine(await exigirEmpresa());
  const q = String(req.query.q || '').trim().toLowerCase();
  const somenteDestaques = req.query.destaque === '1';
  const pagina = Math.max(1, Math.trunc(Number(req.query.page)) || 1);
  const tamanho = Math.max(1, Math.min(60, Math.trunc(Number(req.query.pageSize)) || 24));

  let lista = [...visiveis.values()].map((p) => ({ produto: p, proj: projecoes.get(Number(p.id))! }));
  if (somenteDestaques) lista = lista.filter((l) => l.produto.destaque === true);
  if (q) {
    lista = lista.filter((l) =>
      [l.produto.nome, l.produto.sku, l.proj?.resumo].some((v) => v && String(v).toLowerCase().includes(q))
    );
  }
  const fatia = lista.slice((pagina - 1) * tamanho, (pagina - 1) * tamanho + tamanho);
  await attachImages(getResource('produtos')!, fatia.map((l) => l.produto));
  res.json({
    empresa_id: empresaId,
    total: lista.length,
    produtos: fatia.map(({ produto, proj }) => {
      const preco = precoPublico(produto, precos);
      return {
        id: Number(produto.id),
        sku: String(produto.sku || ''),
        slug: String(proj.slug),
        nome: String(produto.nome || ''),
        resumo: proj.resumo ? String(proj.resumo) : produto.descricao_curta ? String(produto.descricao_curta) : null,
        destaque: produto.destaque === true,
        preco: preco.preco,
        preco_original: preco.preco_original,
        promocional: preco.promocional,
        foto_url: (produto as { foto_url?: string | null }).foto_url ?? null,
        fotos: (produto as { fotos?: unknown }).fotos ?? [],
      };
    }),
  });
}

async function exigirEmpresa(): Promise<number> {
  const { empresaId } = await exigirVitrine();
  return empresaId;
}

export async function lojaProdutoPublico(req: Request, res: Response) {
  const { empresaId, visiveis, projecoes, precos } = await carregarVitrine(await exigirEmpresa());
  const slug = String(req.params.slug || '').trim().toLowerCase();
  let produto: Row | null = null;
  let proj: Row | null = null;
  for (const [pid, p] of visiveis.entries()) {
    const pj = projecoes.get(pid);
    if (pj && String(pj.slug) === slug) {
      produto = p;
      proj = pj;
      break;
    }
  }
  if (!produto || !proj) throw new HttpError(404, 'Produto não encontrado.');
  await attachImages(getResource('produtos')!, [produto]);
  const preco = precoPublico(produto, precos);
  const disponibilidade = await disponibilidadesPorTamanho(escopoDeSistema(empresaId), Number(produto.id));
  res.json({
    empresa_id: empresaId,
    produto: {
      id: Number(produto.id),
      sku: String(produto.sku || ''),
      slug: String(proj.slug),
      nome: String(produto.nome || ''),
      resumo: proj.resumo ? String(proj.resumo) : null,
      descricao: String(produto.descricao || ''),
      destaque: produto.destaque === true,
      preco: preco.preco,
      preco_original: preco.preco_original,
      promocional: preco.promocional,
      foto_url: (produto as { foto_url?: string | null }).foto_url ?? null,
      fotos: (produto as { fotos?: unknown }).fotos ?? [],
      metadados: normalizarMetadados(proj.canal_metadados),
    },
    tamanhos: disponibilidade.map((d) => ({
      tamanho_id: d.tamanho_id,
      codigo: d.codigo,
      fisico: d.fisico,
      disponivel: d.disponivel,
      local: d.local,
      esgotado: d.disponivel <= 0,
    })),
  });
}

// ----------------------------------------------------------------------------
// Itens do carrinho — resolução canônica (preço/estoque/visibilidade)
// ----------------------------------------------------------------------------

type ItemResolvido = {
  produto_id: number;
  tamanho_id: number | null;
  quantidade: number;
  nome: string;
  sku: string;
  preco_unitario: number;
  preco_original: number | null;
  disponivel: number;
};

async function resolverItensCarrinho(
  empresaId: number,
  corpo: Record<string, unknown>
): Promise<ItemResolvido[]> {
  const bruto = Array.isArray(corpo.itens) ? corpo.itens : null;
  if (!bruto || !bruto.length) throw new HttpError(400, 'O carrinho está vazio.', { itens: 'Obrigatório' });
  if (bruto.length > 30) throw new HttpError(400, 'O carrinho aceita no máximo 30 linhas.');
  const { visiveis, projecoes, precos } = await carregarVitrine(empresaId);
  void projecoes;
  const out: ItemResolvido[] = [];
  const chaves = new Set<string>();
  for (const bruto2 of bruto) {
    const item = (bruto2 && typeof bruto2 === 'object' ? bruto2 : {}) as Record<string, unknown>;
    const produtoId = Number(item.produto_id);
    const quantidade = Number(item.quantidade);
    if (!Number.isSafeInteger(produtoId) || produtoId <= 0) throw new HttpError(400, 'Item do carrinho sem produto.', { itens: 'Inválido' });
    if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 99) {
      throw new HttpError(400, 'Quantidade inválida (1 a 99) no carrinho.', { itens: 'Quantidade inválida' });
    }
    const produto = visiveis.get(produtoId);
    if (!produto) {
      // mesma resposta do inexistente: nunca revelar produto de outro tenant
      throw new HttpError(409, 'Um dos itens não está mais disponível na vitrine.');
    }
    const tamanhoId = item.tamanho_id == null || item.tamanho_id === '' ? null : Number(item.tamanho_id);
    if (tamanhoId !== null && (!Number.isSafeInteger(tamanhoId) || tamanhoId <= 0)) throw new HttpError(400, 'Tamanho inválido no carrinho.');
    const chave = `${produtoId}:${tamanhoId ?? ''}`;
    if (chaves.has(chave)) throw new HttpError(400, 'Item duplicado no carrinho. Atualize a quantidade na mesma linha.');
    chaves.add(chave);
    const preco = precoPublico(produto, precos);
    if (!Number.isFinite(preco.preco) || preco.preco <= 0) throw new HttpError(409, 'Um dos itens está sem preço válido na vitrine.');
    const escopo = escopoDeSistema(empresaId);
    const grade = await disponibilidadesPorTamanho(escopo, produtoId);
    const comTamanho = grade.filter((g) => g.tamanho_id != null);
    if (comTamanho.length) {
      // produto com tamanhos: SEM exceção — item sem tamanho reservaria o
      // produto inteiro e o faturamento não saberia de onde sacar.
      if (tamanhoId == null) {
        throw new HttpError(400, `Selecione o tamanho de ${produto.nome}.`, { itens: 'Tamanho obrigatório' });
      }
      if (!comTamanho.some((g) => g.tamanho_id === tamanhoId)) {
        throw new HttpError(400, 'Tamanho indisponível para este produto.', { itens: 'Tamanho inválido' });
      }
    }
    let disponivel = 0;
    if (tamanhoId != null) {
      const saldo = await saldoVendavel(escopo, produtoId, tamanhoId, null);
      disponivel = Math.max(0, saldo.quantidade);
    } else {
      disponivel = grade.reduce((soma, c) => soma + Math.max(0, c.disponivel), 0);
    }
    out.push({
      produto_id: produtoId,
      tamanho_id: tamanhoId,
      quantidade,
      nome: String(produto.nome || ''),
      sku: String(produto.sku || ''),
      preco_unitario: preco.preco,
      preco_original: preco.preco_original,
      disponivel,
    });
  }
  return out;
}

// ----------------------------------------------------------------------------
// POST /api/loja/preview — revalidação do carrinho (preço/estoque/cupom/frete)
// ----------------------------------------------------------------------------

export async function lojaPreview(req: Request, res: Response) {
  const { empresaId } = await exigirVitrine();
  const quote = await quotePaymentMethods(empresaId, req);
  res.json(quote);
}
export async function quotePaymentMethods(empresaId: number, req: Request) {
  const config = await configDaLoja(empresaId);
  const corpo = (req.body || {}) as Record<string, unknown>;
  const itens = await resolverItensCarrinho(empresaId, corpo);
  const subtotal = round2(itens.reduce((soma, i) => soma + i.preco_unitario * i.quantidade, 0));

  const codigoCupom = corpo.cupom ? normalizarCodigo(corpo.cupom) : '';
  let cupom: Awaited<ReturnType<typeof avaliarCupomCodigo>> | null = null;
  if (codigoCupom) cupom = await avaliarCupomCodigo(empresaId, codigoCupom, subtotal);
  const promocao = await melhorPromocaoAtiva(empresaId, subtotal);
  const desconto = descontoFinalDoCheckout(subtotal, promocao, cupom);
  const frete = await cotarFrete(freteDaConfig(config), {
    subtotal,
    cep: corpo.cep ? String(corpo.cep) : null,
  });

  const total = calcularTotaisCheckout({ itens:itens.map(i=>({quantidade:i.quantidade,precoUnitario:i.preco_unitario})), frete:frete.disponivel?frete.valor:0, desconto:desconto.desconto }).total;
  const methods = frete.disponivel && itens.every(i=>i.disponivel>=i.quantidade) && total>0 ? await availableMethods({empresaId,amount:paraCentavos(total),currency:'BRL',country:'BR',channel:'OWN_STORE',installments:1}) : [];
  return {
    payment_methods: methods,
    itens: itens.map((i) => ({
      ...i,
      subtotal: round2(i.preco_unitario * i.quantidade),
      ok: i.disponivel >= i.quantidade,
      ...(i.disponivel < i.quantidade ? { aviso: `Só ${i.disponivel} em estoque.` } : {}),
    })),
    subtotal,
    cupom: codigoCupom
      ? {
          codigo: codigoCupom,
          valido: cupom?.ok === true,
          aplicado: desconto.origem === 'cupom',
          desconto: desconto.origem === 'cupom' ? desconto.desconto : 0,
          erro: cupom && !cupom.ok ? cupom.erro : desconto.cupomErro,
        }
      : null,
    promocao: promocao && desconto.origem === 'promocao' ? { nome: promocao.nome, desconto: desconto.desconto } : null,
    frete,
    desconto: desconto.desconto,
    desconto_origem: desconto.origem,
    totais: calcularTotaisCheckout({
      itens: itens.map((i) => ({ quantidade: i.quantidade, precoUnitario: i.preco_unitario })),
      frete: frete.disponivel ? frete.valor : 0,
      desconto: desconto.desconto,
    }),
    frete_indisponivel: !frete.disponivel,
    ...(frete.disponivel ? {} : { frete_motivo: frete.motivo }),
  };
}

// ----------------------------------------------------------------------------
// POST /api/loja/checkout — cria pedido + reserva + cobrança (idempotente)
// ----------------------------------------------------------------------------

async function respostaPedido(empresaId: number, sale: Row): Promise<Record<string, unknown>> {
  return montarVisaoDaSale(empresaId, sale, { publico: true });
}

export async function lojaCriarCheckout(req: Request, res: Response) {
  const { empresaId, config } = await exigirVitrine();
  const corpo = (req.body || {}) as Record<string, unknown>;
  const s = getStore();

  const chave = String(corpo.chave || '').trim();
  if (chave.length < 8 || chave.length > 64) {
    throw new HttpError(400, 'Chave de idempotência do carrinho inválida.', { chave: 'Obrigatória (8–64 caracteres)' });
  }

  // Idempotência: reenvio do mesmo carrinho devolve o MESMO pedido.
  const existente = await s.findOneWhere(R_PEDIDOS(), { empresa_id: empresaId, chave_checkout: chave });
  if (existente) {
    const sale = await s.findOneWhere(R_SALES(), { id: String(existente.sale_id), empresa_id: empresaId });
    if (sale) return res.status(200).json({ ok: true, idempotente: true, ...(await respostaPedido(empresaId, sale)) });
  }

  const comprador = (corpo.comprador && typeof corpo.comprador === 'object' ? corpo.comprador : {}) as Record<string, unknown>;
  const nome = String(comprador.nome || '').trim().slice(0, 120);
  const email = String(comprador.email || '').trim().toLowerCase().slice(0, 160);
  if (!nome) throw new HttpError(400, 'Informe o nome do comprador.', { comprador: 'Nome obrigatório' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'E-mail inválido.', { comprador: 'E-mail obrigatório' });

  const itens = await resolverItensCarrinho(empresaId, corpo);
  if (itens.some((i) => i.disponivel < i.quantidade)) throw new HttpError(409, 'Estoque insuficiente para um dos itens. Atualize o carrinho.');
  const subtotal = round2(itens.reduce((soma, i) => soma + i.preco_unitario * i.quantidade, 0));

  // FRETE: sem provedor configurado o checkout recusa com a mensagem exata.
  const frete = await cotarFrete(freteDaConfig(config), {
    subtotal,
    cep: corpo.endereco && typeof corpo.endereco === 'object' ? ((corpo.endereco as Record<string, unknown>).cep as string) ?? null : null,
  });
  if (!frete.disponivel) throw new HttpError(409, frete.motivo);

  const codigoCupom = corpo.cupom ? normalizarCodigo(corpo.cupom) : '';
  const cupom = codigoCupom ? await avaliarCupomCodigo(empresaId, codigoCupom, subtotal) : null;
  if (cupom && !cupom.ok) throw new HttpError(400, cupom.erro, { cupom: cupom.erro });
  const promocao = await melhorPromocaoAtiva(empresaId, subtotal);
  const desconto = descontoFinalDoCheckout(subtotal, promocao, cupom);
  const usarCupom = desconto.origem === 'cupom' && cupom && cupom.ok;

  const endereco = (corpo.endereco && typeof corpo.endereco === 'object' ? corpo.endereco : null) as Record<string, unknown> | null;
  const provedorFrete = String(config?.frete_provedor || 'nenhum');
  if (provedorFrete === 'manual') {
    const obrigatorio = ['rua', 'numero', 'bairro', 'cidade', 'uf', 'cep'].filter(
      (k) => !endereco || !String(endereco[k] || '').trim()
    );
    if (obrigatorio.length) {
      throw new HttpError(400, 'Informe o endereço de entrega completo para o frete por tabela.', {
        endereco: `Campos obrigatórios: ${obrigatorio.join(', ')}`,
      });
    }
  }

  const totais = calcularTotaisCheckout({
    itens: itens.map((i) => ({ quantidade: i.quantidade, precoUnitario: i.preco_unitario })),
    frete: frete.valor,
    desconto: desconto.desconto,
  });

  if (!Number.isFinite(totais.total) || totais.total <= 0) throw new HttpError(409, 'Total inválido para pagamento. Revise o carrinho.');

  const dono = await responsavelCheckout(empresaId, config);
  const escopo = escopoDeSistema(empresaId);
  const method = String(corpo.payment_method || 'PIX') as PaymentMethod;
  if (!METHODS.includes(method) || !(await candidates({empresaId, method, amount:paraCentavos(totais.total), currency:'BRL',country:'BR',channel:'OWN_STORE',installments:1})).length) throw new HttpError(409,'Método indisponível no Payment Engine.');
  const { externalOrderId, token } = gerarIdentificadores();

  const criado = await s.transaction(
    async (tx) => {
      // corrida do mesmo carrinho: outro request pode ter acabado de criar
      const repetido = await s.findOneWhere(R_PEDIDOS(), { empresa_id: empresaId, chave_checkout: chave }, tx);
      if (repetido) return { pedido: repetido, sale: await s.findOneWhere(R_SALES(), { id: String(repetido.sale_id), empresa_id: empresaId }, tx) };

      const agora = new Date().toISOString();
      const expiraEm = new Date(Date.now() + (Number(config?.checkout_expira_minutos) || 60) * 60_000).toISOString();
      const saleId = connectorCuid();
      const sale = await s.insert(
        R_SALES(),
        {
          id: saleId,
          reference: marketplaceSaleReference(empresaId, dono, 'BROBOND', externalOrderId),
          quantity: itens.reduce((soma, i) => soma + i.quantidade, 0),
          amount_cents: paraCentavos(totais.total),
          currency: 'BRL',
          status: 'PENDING',
          occurred_at: agora,
          channel: 'BROBOND',
          external_order_id: externalOrderId,
          usuario_id: dono,
          empresa_id: empresaId,
          buyer_name: nome,
          buyer_email: email,
        },
        tx
      );
      for (const item of itens) {
        await s.insert(
          R_SALE_ITEMS(),
          {
            id: connectorCuid(),
            sale_id: saleId,
            product_id: item.produto_id,
            size_id: item.tamanho_id,
            variacao_externa: null,
            quantity: item.quantidade,
            unit_price_cents: paraCentavos(item.preco_unitario),
            discount_cents: 0,
            subtotal_cents: paraCentavos(item.preco_unitario) * item.quantidade,
          },
          tx
        );
      }

      const pedido = await s.insert(
        R_PEDIDOS(),
        {
          empresa_id: empresaId,
          canal: 'BROBOND',
          pedido_externo: externalOrderId,
          sale_id: saleId,
          venda_id: null,
          cobranca_id: null,
          checkout_token: token,
          chave_checkout: chave,
          estado: 'AGUARDANDO_PAGAMENTO',
          pagamento_estado: 'PENDING',
          frete_valor: frete.valor,
          desconto: desconto.desconto,
          cupom_codigo: usarCupom && cupom && cupom.ok ? String(cupom.cupom.codigo || codigoCupom) : null,
          total: totais.total,
          comprador: { nome, email, telefone: comprador.telefone ? String(comprador.telefone).slice(0, 40) : null },
          endereco: endereco
            ? {
                rua: String(endereco.rua || '').slice(0, 160),
                numero: String(endereco.numero || '').slice(0, 20),
                complemento: endereco.complemento ? String(endereco.complemento).slice(0, 80) : null,
                bairro: String(endereco.bairro || '').slice(0, 80),
                cidade: String(endereco.cidade || '').slice(0, 80),
                uf: String(endereco.uf || '').slice(0, 2).toUpperCase(),
                cep: String(endereco.cep || '').replace(/\D/g, '').slice(0, 8),
              }
            : null,
          expira_em: expiraEm,
          pago_em: null,
          convertido_em: null,
          erro: null,
          criado_por: dono,
          criado_em: agora,
          atualizado_em: agora,
        },
        tx
      );

      // RESERVA ANTES da cobrança (motor canônico, mesma regra da venda).
      for (const item of itens) {
        try {
          await criarReservaInterna(
            escopo,
            {
              produto_id: item.produto_id,
              tamanho_id: item.tamanho_id,
              local_id: null,
              quantidade: item.quantidade,
              tipo: 'reserva',
              origem_recurso: ORIGEM_CHECKOUT,
              origem_id: Number(pedido.id),
              motivo: `Checkout ${externalOrderId}`,
              criado_por: dono,
            },
            tx
          );
        } catch (e) {
          if (e instanceof HttpError && e.status === 409) {
            throw new HttpError(409, `${item.nome}: ${e.message} Atualize o carrinho e tente novamente.`);
          }
          throw e;
        }
      }

      if (usarCupom && cupom && cupom.ok) {
        const consumido = await consumirUsoCupom(empresaId, codigoCupom, subtotal, tx);
        // Atribuição é um vínculo imutável ao mesmo checkout; sem duplicar a venda
        // ou inferir receita/comissão. Só existe se a parceria já estiver ativa.
        const { atribuirCheckoutCreator } = await import('../creators');
        await atribuirCheckoutCreator(empresaId, Number(consumido.id), Number(pedido.id), tx);
      }

      return { pedido, sale };
    },
    { isolation: 'serializable' }
  );

  if (!criado.sale) throw new HttpError(500, 'Pedido criado sem venda associada — contate o suporte.');

  // COBRANÇA via gateway (backend; falhou → desfaz reserva/cupom com estado ERRO).
  try {
    await paymentEngine.createForOrder(empresaId, Number(criado.pedido.id), method, `checkout:${criado.pedido.id}`, {taxId: comprador.documento ? String(comprador.documento).replace(/\D/g,'') : undefined});
  } catch (e) {
    await falharCheckout(empresaId, criado.pedido, criado.sale, e instanceof Error ? e.message : String(e));
    throw e instanceof HttpError ? e : new HttpError(502, 'Não foi possível iniciar o pagamento do pedido. Tente novamente.');
  }

  const saleFinal = (await s.findOneWhere(R_SALES(), { id: String(criado.sale.id), empresa_id: empresaId })) ?? criado.sale;
  res.status(201).json({ ok: true, ...(await respostaPedido(empresaId, saleFinal)) });
}

function gerarIdentificadores(): { externalOrderId: string; token: string } {
  return {
    externalOrderId: `LOJA-${connectorCuid().slice(-12).toUpperCase()}`,
    token: randomBytes(32).toString('hex'),
  };
}

/** Estado honesto quando a cobrança não nasceu: ERRO + tudo devolvido. */
async function falharCheckout(empresaId: number, pedido: Row, sale: Row, motivo: string): Promise<void> {
  const s = getStore();
  const escopo = escopoDeSistema(empresaId);
  await s.transaction(
    async (tx) => {
      const mudou = await s.tryUpdateIf(
        R_PEDIDOS(),
        Number(pedido.id),
        { estado: 'AGUARDANDO_PAGAMENTO' },
        { estado: 'ERRO', erro: motivo.slice(0, 400), atualizado_em: new Date().toISOString() },
        tx
      );
      if (!mudou) return;
      const reservas = await s.list(
        getResource('estoque_reservas')!,
        { page: 1, pageSize: 200, filter: { empresa_id: empresaId, origem_recurso: ORIGEM_CHECKOUT, origem_id: Number(pedido.id), status: 'ativa' } },
        tx
      );
      for (const r of reservas.rows) await liberarReservaInterna(escopo, Number(r.id), tx).catch(() => undefined);
      await liberarUsoCupom(empresaId, pedido.cupom_codigo ? String(pedido.cupom_codigo) : null, tx);
      if (String(sale.status) === 'PENDING') {
        await s.update(R_SALES(), sale.id as unknown as number, { status: 'CANCELLED' } as never, tx);
      }
    },
    { isolation: 'serializable' }
  );
}

// ----------------------------------------------------------------------------
// GET /api/loja/pedidos/:token — acompanhamento público (token = credencial)
// ----------------------------------------------------------------------------

export async function lojaPedidoPublico(req: Request, res: Response) {
  const { empresaId } = await exigirVitrine();
  const token = String(req.params.token || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(404, 'Pedido não encontrado.');
  const s = getStore();
  const pedido = await s.findOneWhere(R_PEDIDOS(), { checkout_token: token });
  // token de outro tenant (ou inexistente) → MESMA resposta 404
  if (!pedido || Number(pedido.empresa_id) !== empresaId) throw new HttpError(404, 'Pedido não encontrado.');
  const sale = await s.findOneWhere(R_SALES(), { id: String(pedido.sale_id), empresa_id: empresaId });
  if (!sale) throw new HttpError(404, 'Pedido não encontrado.');
  res.json({ ok: true, ...(await respostaPedido(empresaId, sale)) });
}
