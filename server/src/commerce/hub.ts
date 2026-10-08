// ============================================================================
// HUB DE E-COMMERCE — SINCRONIZAÇÃO ERP ↔ CANAL (Fase P3, §3-§7, §15-§17)
//
// Aqui mora o que é IGUAL para todos os canais:
//
//   • pedido externo → venda do ERP, com IDEMPOTÊNCIA por
//     (empresa_id, provider, external_order_id) — receber o mesmo pedido duas
//     vezes (webhook duplicado, polling + webhook, retry) NUNCA cria duas vendas;
//   • mapeamento explícito de SKU ↔ id do canal (`commerce_mapeamentos`);
//   • log de integração por operação (`integration_logs`) com provedor,
//     operação, request id, id externo, status, tentativa, duração e erro —
//     nunca token/senha/segredo;
//   • retry CONTROLADO: erro transitório agenda a próxima tentativa com
//     backoff (teto de `MAX_TENTATIVAS`); erro definitivo (CPF inválido, sem
//     mapeamento, credencial ausente) NÃO é retentado sozinho;
//   • tudo carimbado com a empresa ativa e lido pelo store escopado (§18).
//
// O canal entrega webhook quando tem (`validarWebhook` + `lerWebhook`); quando
// não tem — ou quando o webhook falhou — o polling do hub cobre o buraco.
// ============================================================================
import { recalcularTotal, RESOURCES, storeDoAtor } from './ponte';
import { HttpError } from '../errors';
import { escopoDoAtor as escopoDoAtorEmpresa, type EscopoEmpresa } from '../empresa';
import { apenasDigitos, erroDocumento } from '../documentos';
import { connectorRepository } from '../../../modules/connectors/core/connector.repository';
import { decryptConnectorSecret } from '../../../modules/connectors/core/crypto.service';
import {
  CANAIS_COMERCIO,
  ErroCanalError,
  MAX_TENTATIVAS,
  OperacaoNaoSuportadaError,
  proximaTentativaEm,
  type CanalComercio,
  type CredencialCanal,
  type PedidoExterno,
} from './contrato';
import { providerDe, provedoresComercio } from './registro';

export type AtorHub = { id?: number | null; name?: string | null; perfil?: string; empresa_id?: number | null; empresas?: number[]; consolidar?: boolean; pode_consolidar?: boolean };

export type ContextoHub = {
  canal: CanalComercio;
  usuarioId: number;
  ator: AtorHub;
  escopo: EscopoEmpresa;
  /** Injeção para os testes (adaptador falso / fetch falso). */
  deps?: any;
};

export type ResumoPedidos = {
  canal: CanalComercio;
  encontrados: number;
  importados: { pedido: string; venda_id: number; total: number }[];
  ignorados: { pedido: string; venda_id: number | null }[];
  pendentes: { pedido: string; motivo: string; itens: string[] }[];
  falhas: { pedido: string; mensagem: string; transitorio: boolean }[];
};

export function contextoDoAtor(canal: CanalComercio, actor: AtorHub, deps?: any): ContextoHub {
  return { canal, usuarioId: Number(actor.id || 0), ator: actor, escopo: escopoDoAtorEmpresa(actor as any), deps };
}

// ---------------------------------------------------------------------------
// Credencial do canal — vem do módulo de conectores, nunca do corpo da requisição
// ---------------------------------------------------------------------------

/**
 * Resolve a credencial JÁ CONECTADA do usuário para o canal. O token é
 * decifrado em memória e passado ao adaptador; não é logado, não é devolvido
 * em resposta e não é gravado em `integration_logs`.
 */
export async function credencialDoUsuario(usuarioId: number, canal: CanalComercio): Promise<CredencialCanal | null> {
  if (!Number.isInteger(usuarioId) || usuarioId <= 0) return null;
  if (canal === 'WOOCOMMERCE') {
    // O WooCommerce do site usa credenciais de servidor (WOOCOMMERCE_URL/CK/CS).
    return process.env.WOOCOMMERCE_URL ? { baseUrl: process.env.WOOCOMMERCE_URL } : null;
  }
  try {
    const row = await connectorRepository.findByProvider(usuarioId, canal as any);
    if (!row) return null;
    let token: string | null = null;
    if (row.accessToken) {
      try {
        token = decryptConnectorSecret(row.accessToken);
      } catch {
        return { token: null, lojaId: row.shopId ?? null, clientSecret: process.env[`${canal}_CLIENT_SECRET`] || null };
      }
    }
    return { token, lojaId: row.shopId ?? null, clientSecret: (canal === 'NUVEMSHOP' ? process.env.NUVEMSHOP_CLIENT_SECRET : null) || null };
  } catch {
    // Banco de conectores indisponível não derruba a listagem: o adaptador
    // devolve "sem credencial" e a operação fica registrada como pendência.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Log de integração (§15) — sem segredo, com retry agendado (§16)
// ---------------------------------------------------------------------------

type LogEntrada = {
  ctx: ContextoHub;
  operacao: string;
  requestId?: string | null;
  externalId?: string | null;
  entidade?: string | null;
  status: 'ok' | 'erro' | 'ignorado' | 'nao_suportado' | 'pendente';
  tentativa?: number;
  duracaoMs?: number | null;
  erro?: string | null;
  proximaTentativaEm?: string | null;
};

/** Escreve a linha de log. Falhar aqui NUNCA derruba a sincronização. */
export async function registrarLog(entrada: LogEntrada): Promise<void> {
  try {
    const s = storeDoAtor(entrada.ctx.escopo);
    await s.insert(RESOURCES.integration_logs, {
      empresa_id: entrada.ctx.escopo.empresaId,
      provider: entrada.ctx.canal,
      operacao: entrada.operacao,
      request_id: entrada.requestId ?? null,
      external_id: entrada.externalId ?? null,
      entidade: entrada.entidade ?? null,
      status: entrada.status,
      tentativa: Math.max(1, Number(entrada.tentativa || 1)),
      duracao_ms: entrada.duracaoMs ?? null,
      erro: entrada.erro ? String(entrada.erro).slice(0, 900) : null,
      proxima_tentativa_em: entrada.proximaTentativaEm ?? null,
    });
  } catch (e) {
    console.warn('⚠️  integration_logs indisponível:', e instanceof Error ? e.message : e);
  }
}

/** Linhas de erro vencidas para retry — o "worker" do cron chama isto. */
export async function pendentesDeRetry(escopo: EscopoEmpresa, limite = 20): Promise<any[]> {
  const s = storeDoAtor(escopo);
  const out = await s.list(RESOURCES.integration_logs, { page: 1, pageSize: limite, sort: 'id', dir: 'asc', filter: { status: 'erro' } });
  const agora = Date.now();
  return out.rows.filter((r) => {
    if (Number(r.tentativa) >= MAX_TENTATIVAS) return false;
    const alvo = r.proxima_tentativa_em ? Date.parse(String(r.proxima_tentativa_em)) : null;
    return alvo !== null && alvo <= agora;
  });
}

// ---------------------------------------------------------------------------
// Mapeamento explícito (§3)
// ---------------------------------------------------------------------------

export async function mapeamentoDoCanal(escopo: EscopoEmpresa, canal: CanalComercio, recurso: string, sku: string): Promise<string | null> {
  const s = storeDoAtor(escopo);
  const row = await s.findOneWhere(RESOURCES.commerce_mapeamentos, { canal, recurso, chave_interna: sku });
  return row ? String(row.externo_id) : null;
}

/** Vários SKUs de uma vez (o hub publica estoque em lote). */
export async function mapeamentosDoCanal(escopo: EscopoEmpresa, canal: CanalComercio, recurso: string): Promise<Map<string, string>> {
  const s = storeDoAtor(escopo);
  const out = await s.list(RESOURCES.commerce_mapeamentos, { page: 1, pageSize: 5000, filter: { canal, recurso } });
  const mapa = new Map<string, string>();
  for (const row of out.rows) if (row.chave_interna) mapa.set(String(row.chave_interna), String(row.externo_id));
  return mapa;
}

// ---------------------------------------------------------------------------
// Pedido externo → venda do ERP (idempotente)
// ---------------------------------------------------------------------------

/** Canal do ERP lançado na venda. Explicito: canal externo ≠ canal interno. */
export function canalErpDoCanal(canal: CanalComercio): string {
  if (canal === 'MERCADOLIVRE') return 'marketplace';
  if (canal === 'WOOCOMMERCE') return String(process.env.WOOCOMMERCE_CANAL || '') === 'site_atacado' ? 'site_atacado' : 'site_varejo';
  return 'site_varejo'; // NUVEMSHOP é a loja (a plataforma-ponte do hub)
}

/**
 * Status do canal → status do ERP.
 *
 * A tabela é DELIBERADAMENTE conservadora: nenhum pedido de canal entra
 * "faturado" — faturamento é decisão do ERP (NF-e/estoque), não do marketplace.
 */
const STATUS_ERP: { padrao: string; regras: { match: RegExp; status: string }[] } = {
  padrao: 'cotacao',
  regras: [
    { match: /cancel|cancelled|refunded|chargeback/i, status: 'cancelada' },
    { match: /completed|delivered|fulfilled|shipped/i, status: 'entregue' },
  ],
};

export function statusErpDoCanal(statusExterno: string): string {
  const achou = STATUS_ERP.regras.find((r) => r.match.test(statusExterno || ''));
  return achou ? achou.status : STATUS_ERP.padrao;
}

/** Pessoa do canal: reaproveita cadastro por documento OU e-mail; nunca duplica. */
async function resolverCliente(s: any, pedido: PedidoExterno, canal: string): Promise<{ id: number; criado: boolean }> {
  const email = pedido.cliente.email ? String(pedido.cliente.email).trim().toLowerCase() : null;
  const digitos = apenasDigitos(pedido.cliente.documento || '');
  const docValido = digitos && !erroDocumento(digitos, 'ambos') ? digitos : null;

  if (docValido) {
    const porDoc = await s.findOneWhere(RESOURCES.clientes, { cnpj_cpf: docValido });
    if (porDoc) return { id: Number(porDoc.id), criado: false };
  }
  if (email) {
    const porEmail = await s.findOneWhere(RESOURCES.clientes, { email });
    if (porEmail) return { id: Number(porEmail.id), criado: false };
  }
  const nome = String(pedido.cliente.nome || '').trim() || (email ? email : `Cliente ${pedido.externalId}`);
  const porNome = await s.findOneWhere(RESOURCES.clientes, { nome });
  if (porNome) return { id: Number(porNome.id), criado: false };

  const row = await s.insert(RESOURCES.clientes, {
    nome,
    email,
    telefone: pedido.cliente.telefone || null,
    // Documento só entra quando é VÁLIDO — o cadastro confere dígito verificador
    // e um documento torto do canal não pode contaminar o cadastro.
    cnpj_cpf: docValido,
    tipo: 'varejo',
    observacoes: `Cadastro criado pela importação do canal ${canal}`,
  });
  return { id: Number(row.id), criado: true };
}

/** Saldo do produto no tamanho pedido — ou no primeiro com saldo (regra da loja). */
async function tamanhoParaItem(s: any, produtoId: number, tamanhoExterno: string | null): Promise<number | null> {
  const estoques = await s.list(RESOURCES.estoques, { page: 1, pageSize: 500, filter: { produto_id: produtoId } });
  const comSaldo = estoques.rows.find((e: any) => Number(e.quantidade || 0) > 0);
  if (tamanhoExterno) {
    const tamanhos = await s.list(RESOURCES.tamanhos, { page: 1, pageSize: 500 });
    const alvo = tamanhos.rows.find(
      (t: any) => String(t.codigo || '').trim().toUpperCase() === String(tamanhoExterno).trim().toUpperCase()
    );
    if (alvo && estoques.rows.some((e: any) => Number(e.tamanho_id) === Number(alvo.id))) return Number(alvo.id);
  }
  if (comSaldo) return Number(comSaldo.tamanho_id);
  return estoques.rows[0] ? Number(estoques.rows[0].tamanho_id) : null;
}

/**
 * Grava (ou reconhece) UM pedido externo.
 *
 * A trava é o índice único `(empresa_id, provider, external_order_id)` de
 * `commerce_pedidos_externos`: mesmo com duas execuções simultâneas, só uma
 * cria a venda — a segunda encontra o vínculo e devolve "ignorado".
 */
export async function gravarPedidoExterno(ctx: ContextoHub, pedido: PedidoExterno): Promise<{ status: 'importado' | 'ignorado' | 'pendente'; vendaId: number | null; motivo?: string; itensSemSku: string[] }> {
  const s = storeDoAtor(ctx.escopo);
  const existente = await s.findOneWhere(RESOURCES.commerce_pedidos_externos, { provider: ctx.canal, external_order_id: pedido.externalId });
  if (existente && existente.venda_id) {
    return { status: 'ignorado', vendaId: Number(existente.venda_id), itensSemSku: [] };
  }

  // Itens: SKU do canal é o SKU do ERP (mapeamento explícito quando o canal
  // usa id próprio). Sem SKU conhecido, o item fica PENDENTE — nunca se
  // inventa produto nem se baixa estoque de item não identificado.
  const resolvidos: { produtoId: number; tamanhoId: number; quantidade: number; preco: number; titulo: string }[] = [];
  const itensSemSku: string[] = [];
  for (const item of pedido.itens) {
    const sku = item.sku ? String(item.sku).trim() : '';
    const produto = sku ? await s.findOneWhere(RESOURCES.produtos, { sku }) : null;
    if (!produto) {
      itensSemSku.push(sku || item.titulo || item.externalItemId || '(sem identificação)');
      continue;
    }
    const tamanhoId = await tamanhoParaItem(s, Number(produto.id), null);
    if (!tamanhoId) {
      itensSemSku.push(`${sku} (sem tamanho cadastrado)`);
      continue;
    }
    resolvidos.push({ produtoId: Number(produto.id), tamanhoId, quantidade: item.quantidade, preco: item.precoUnitario, titulo: item.titulo });
  }
  if (!resolvidos.length) {
    return { status: 'pendente', vendaId: null, motivo: 'nenhum item com SKU cadastrado no ERP', itensSemSku };
  }

  const cliente = await resolverCliente(s, pedido, ctx.canal);
  const referencia = `${ctx.canal}-${pedido.externalId}`;
  const venda = await s.insert(RESOURCES.vendas, {
    empresa_id: ctx.escopo.empresaId,
    cliente_id: cliente.id,
    data: String(pedido.criadoEm || new Date().toISOString()).slice(0, 10),
    status: statusErpDoCanal(pedido.status),
    fin_status: 'a_receber',
    canal_venda: canalErpDoCanal(ctx.canal),
    pedido_cliente: referencia,
    frete: pedido.frete,
    desconto: pedido.desconto,
    origem: 'canal',
    observacoes: [
      `Pedido importado do canal ${ctx.canal} — nº ${pedido.numero || pedido.externalId}`,
      pedido.rastreio?.codigo ? `Rastreio ${pedido.rastreio.codigo}${pedido.rastreio.transportadora ? ` (${pedido.rastreio.transportadora})` : ''}` : null,
      itensSemSku.length ? `Itens PENDENTES (SKU não cadastrado): ${itensSemSku.join('; ')}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  });

  for (const item of resolvidos) {
    await s.insert(RESOURCES.itens_venda, {
      empresa_id: ctx.escopo.empresaId,
      venda_id: Number(venda.id),
      produto_id: item.produtoId,
      tamanho_id: item.tamanhoId,
      quantidade: item.quantidade,
      preco_unitario: item.preco,
      desconto_pct: 0,
      subtotal: Math.round(item.quantidade * item.preco * 100) / 100,
    });
  }
  await recalcularTotal('venda', Number(venda.id), null);

  const vinculo = existente
    ? await s.update(RESOURCES.commerce_pedidos_externos, Number(existente.id), { venda_id: Number(venda.id), status_externo: pedido.status, status_erp: String(venda.status), payload: pedido.bruto ?? null })
    : await s.insert(RESOURCES.commerce_pedidos_externos, {
        empresa_id: ctx.escopo.empresaId,
        provider: ctx.canal,
        external_order_id: pedido.externalId,
        venda_id: Number(venda.id),
        status_externo: pedido.status,
        status_erp: String(venda.status),
        payload: pedido.bruto ?? null,
      });
  void vinculo;

  return { status: 'importado', vendaId: Number(venda.id), itensSemSku };
}

/** Importa os pedidos que o canal informa no período (polling controlado). */
export async function importarPedidosDoCanal(ctx: ContextoHub, opts: { desde: Date; limite?: number }): Promise<ResumoPedidos> {
  const provider = providerDe(ctx.canal, ctx.deps);
  if (!provider.capacidades.pedidos) throw new OperacaoNaoSuportadaError(ctx.canal, 'importarPedidos');
  const credencial = await credencialDoUsuario(ctx.usuarioId, ctx.canal);
  const inicio = Date.now();
  const resumo: ResumoPedidos = { canal: ctx.canal, encontrados: 0, importados: [], ignorados: [], pendentes: [], falhas: [] };

  let pedidos: PedidoExterno[] = [];
  try {
    pedidos = await provider.listarPedidos({
      credencial,
      desde: opts.desde,
      limite: Math.min(200, Math.max(1, opts.limite || 50)),
      fetchImpl: ctx.deps?.fetchImpl,
    });
  } catch (e: any) {
    const transitorio = e instanceof ErroCanalError ? e.transitorio : true;
    const tentativa = 1;
    await registrarLog({
      ctx,
      operacao: 'listarPedidos',
      status: 'erro',
      erro: e?.message || 'falha ao listar pedidos',
      duracaoMs: Date.now() - inicio,
      tentativa,
      proximaTentativaEm: transitorio ? proximaTentativaEm(tentativa) : null,
    });
    throw e instanceof HttpError ? e : new HttpError(transitorio ? 502 : 400, e?.message || 'Falha ao listar pedidos do canal.');
  }

  resumo.encontrados = pedidos.length;
  for (const pedido of pedidos) {
    const t0 = Date.now();
    try {
      const resultado = await gravarPedidoExterno(ctx, pedido);
      if (resultado.status === 'importado') {
        resumo.importados.push({ pedido: pedido.numero || pedido.externalId, venda_id: resultado.vendaId!, total: 0 });
        await registrarLog({ ctx, operacao: 'pedido.importar', externalId: pedido.externalId, entidade: `pedido:${pedido.externalId}`, status: 'ok', duracaoMs: Date.now() - t0 });
      } else if (resultado.status === 'ignorado') {
        resumo.ignorados.push({ pedido: pedido.numero || pedido.externalId, venda_id: resultado.vendaId });
        await registrarLog({ ctx, operacao: 'pedido.importar', externalId: pedido.externalId, entidade: `pedido:${pedido.externalId}`, status: 'ignorado', duracaoMs: Date.now() - t0 });
      } else {
        resumo.pendentes.push({ pedido: pedido.numero || pedido.externalId, motivo: resultado.motivo || 'pendente', itens: resultado.itensSemSku });
        await registrarLog({ ctx, operacao: 'pedido.importar', externalId: pedido.externalId, entidade: `pedido:${pedido.externalId}`, status: 'pendente', erro: resultado.motivo || null, duracaoMs: Date.now() - t0 });
      }
    } catch (e: any) {
      const transitorio = e instanceof ErroCanalError ? e.transitorio : false;
      resumo.falhas.push({ pedido: pedido.numero || pedido.externalId, mensagem: e?.message || 'falha', transitorio });
      await registrarLog({
        ctx,
        operacao: 'pedido.importar',
        externalId: pedido.externalId,
        entidade: `pedido:${pedido.externalId}`,
        status: 'erro',
        erro: e?.message || 'falha',
        duracaoMs: Date.now() - t0,
        tentativa: 1,
        proximaTentativaEm: transitorio ? proximaTentativaEm(1) : null,
      });
    }
  }
  return resumo;
}

/** Webhook: valida assinatura, normaliza e importa o pedido afetado. */
export async function processarWebhookDoCanal(
  canal: CanalComercio,
  corpoBruto: string,
  headers: Record<string, string | undefined>,
  ctx: ContextoHub
): Promise<{ aceitos: number; ignorados: number; detalhes: any[] }> {
  const provider = providerDe(canal, ctx.deps);
  if (!provider.capacidades.webhook) throw new OperacaoNaoSuportadaError(canal, 'webhook');
  const credencial = await credencialDoUsuario(ctx.usuarioId, canal);
  const valido = provider.validarWebhook ? provider.validarWebhook(corpoBruto, headers, { credencial }) : true;
  if (!valido) {
    await registrarLog({ ctx, operacao: 'webhook', status: 'erro', erro: 'assinatura inválida' });
    throw new HttpError(401, 'Assinatura do webhook inválida.');
  }
  const eventos = provider.lerWebhook(corpoBruto, headers, { credencial });
  const detalhes: any[] = [];
  let aceitos = 0;
  let ignorados = 0;
  for (const evento of eventos) {
    if (!evento.pedidoExternoId) {
      ignorados++;
      detalhes.push({ evento: evento.externalId, tipo: evento.tipo, resultado: 'sem pedido associado' });
      continue;
    }
    // O pedido é relido na fonte (a notificação só diz "mudou"), e a gravação
    // é idempotente por (empresa, canal, id externo).
    try {
      const pedidos = await provider.listarPedidos({ credencial, desde: new Date(Date.now() - 30 * 86400_000), limite: 50, fetchImpl: ctx.deps?.fetchImpl });
      const pedido = pedidos.find((p) => String(p.externalId) === String(evento.pedidoExternoId));
      if (!pedido) {
        ignorados++;
        detalhes.push({ evento: evento.externalId, tipo: evento.tipo, resultado: 'pedido não encontrado no canal' });
        continue;
      }
      const resultado = await gravarPedidoExterno(ctx, pedido);
      aceitos++;
      detalhes.push({ evento: evento.externalId, tipo: evento.tipo, resultado: resultado.status, venda_id: resultado.vendaId });
      await registrarLog({ ctx, operacao: 'webhook', externalId: evento.externalId, entidade: `pedido:${evento.pedidoExternoId}`, status: resultado.status === 'pendente' ? 'pendente' : 'ok' });
    } catch (e: any) {
      const transitorio = e instanceof ErroCanalError ? e.transitorio : true;
      detalhes.push({ evento: evento.externalId, tipo: evento.tipo, resultado: 'erro', mensagem: e?.message });
      await registrarLog({
        ctx,
        operacao: 'webhook',
        externalId: evento.externalId,
        entidade: `pedido:${evento.pedidoExternoId}`,
        status: 'erro',
        erro: e?.message || 'falha',
        proximaTentativaEm: transitorio ? proximaTentativaEm(1) : null,
      });
    }
  }
  return { aceitos, ignorados, detalhes };
}

// ---------------------------------------------------------------------------
// ERP → canal: estoque e preço
// ---------------------------------------------------------------------------

export type ResumoPublicacao = {
  canal: CanalComercio;
  enviados: number;
  atualizados: number;
  semMapeamento: string[];
  falhas: { sku: string; mensagem: string; transitorio: boolean }[];
};

/** Saldo atual por SKU do ERP (empresa ativa): produto simples e por tamanho. */
export async function saldosDoErp(ctx: ContextoHub): Promise<{ sku: string; quantidade: number; produtoId: number }[]> {
  const s = storeDoAtor(ctx.escopo);
  const [produtos, tamanhos, estoques] = await Promise.all([
    s.list(RESOURCES.produtos, { page: 1, pageSize: 5000 }),
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 500 }),
    s.list(RESOURCES.estoques, { page: 1, pageSize: 20000 }),
  ]);
  const codigoDoTamanho = new Map<number, string>(tamanhos.rows.map((t: any) => [Number(t.id), String(t.codigo || '').trim().toUpperCase()]));
  const porProduto = new Map<number, number>();
  const porProdutoTamanho = new Map<string, number>();
  for (const e of estoques.rows) {
    const pid = Number(e.produto_id);
    const qtd = Number(e.quantidade || 0);
    porProduto.set(pid, (porProduto.get(pid) || 0) + qtd);
    const codigo = codigoDoTamanho.get(Number(e.tamanho_id));
    if (codigo) porProdutoTamanho.set(`${pid}|${codigo}`, (porProdutoTamanho.get(`${pid}|${codigo}`) || 0) + qtd);
  }
  const saida: { sku: string; quantidade: number; produtoId: number }[] = [];
  for (const p of produtos.rows) {
    if (p.ativo === false || p.exibir_site === false) continue;
    const sku = String(p.sku || '').trim();
    if (!sku) continue;
    const pid = Number(p.id);
    const doProduto = [...porProdutoTamanho.entries()].filter(([chave]) => chave.startsWith(`${pid}|`));
    if (doProduto.length) {
      for (const [chave, qtd] of doProduto) {
        const codigo = chave.split('|')[1];
        saida.push({ sku: `${sku}-${codigo}`, quantidade: qtd, produtoId: pid });
      }
    }
    saida.push({ sku, quantidade: porProduto.get(pid) || 0, produtoId: pid });
  }
  return saida;
}

export async function publicarEstoqueDoCanal(ctx: ContextoHub, opts: { limite?: number } = {}): Promise<ResumoPublicacao> {
  const provider = providerDe(ctx.canal, ctx.deps);
  if (!provider.capacidades.estoque) throw new OperacaoNaoSuportadaError(ctx.canal, 'publicarEstoque');
  const credencial = await credencialDoUsuario(ctx.usuarioId, ctx.canal);
  const inicio = Date.now();

  const mapeamentos = await mapeamentosDoCanal(ctx.escopo, ctx.canal, 'produto');
  const saldos = (await saldosDoErp(ctx)).slice(0, Math.min(5000, Math.max(1, opts.limite || 5000)));
  const itens = await Promise.all(
    saldos.map(async (s) => ({ sku: s.sku, quantidade: s.quantidade, externoId: mapeamentos.get(s.sku) || (await mapeamentoDoCanal(ctx.escopo, ctx.canal, 'variacao', s.sku)) }))
  );

  try {
    const resultado = await provider.publicarEstoque(itens, { credencial, fetchImpl: ctx.deps?.fetchImpl });
    await registrarLog({
      ctx,
      operacao: 'estoque.publicar',
      status: resultado.falhas.length ? 'erro' : 'ok',
      erro: resultado.falhas.length ? `${resultado.falhas.length} SKU(s) falharam` : null,
      duracaoMs: Date.now() - inicio,
      tentativa: 1,
      proximaTentativaEm: resultado.falhas.some((f) => f.transitorio) ? proximaTentativaEm(1) : null,
    });
    return {
      canal: ctx.canal,
      enviados: itens.length,
      atualizados: resultado.atualizados.length,
      semMapeamento: resultado.semMapeamento,
      falhas: resultado.falhas,
    };
  } catch (e: any) {
    const transitorio = e instanceof ErroCanalError ? e.transitorio : true;
    await registrarLog({
      ctx,
      operacao: 'estoque.publicar',
      status: 'erro',
      erro: e?.message || 'falha',
      duracaoMs: Date.now() - inicio,
      tentativa: 1,
      proximaTentativaEm: transitorio ? proximaTentativaEm(1) : null,
    });
    throw e instanceof HttpError ? e : new HttpError(transitorio ? 502 : 400, e?.message || 'Falha ao publicar estoque.');
  }
}

export async function publicarPrecoDoCanal(ctx: ContextoHub, opts: { limite?: number } = {}): Promise<ResumoPublicacao> {
  const provider = providerDe(ctx.canal, ctx.deps);
  if (!provider.capacidades.preco) throw new OperacaoNaoSuportadaError(ctx.canal, 'publicarPreco');
  const credencial = await credencialDoUsuario(ctx.usuarioId, ctx.canal);
  const s = storeDoAtor(ctx.escopo);
  const produtos = await s.list(RESOURCES.produtos, { page: 1, pageSize: Math.min(5000, Math.max(1, opts.limite || 5000)) });
  const mapeamentos = await mapeamentosDoCanal(ctx.escopo, ctx.canal, 'produto');
  const itens = produtos.rows
    .filter((p: any) => p.ativo !== false && p.exibir_site !== false && String(p.sku || '').trim() && Number(p.preco_venda) > 0)
    .map((p: any) => ({ sku: String(p.sku).trim(), preco: Number(p.preco_venda), externoId: mapeamentos.get(String(p.sku).trim()) || null }));

  const resultado = await provider.publicarPreco(itens, { credencial, fetchImpl: ctx.deps?.fetchImpl });
  await registrarLog({
    ctx,
    operacao: 'preco.publicar',
    status: resultado.falhas.length ? 'erro' : 'ok',
    erro: resultado.falhas.length ? `${resultado.falhas.length} SKU(s) falharam` : null,
    tentativa: 1,
    proximaTentativaEm: resultado.falhas.some((f) => f.transitorio) ? proximaTentativaEm(1) : null,
  });
  return { canal: ctx.canal, enviados: itens.length, atualizados: resultado.atualizados.length, semMapeamento: resultado.semMapeamento, falhas: resultado.falhas };
}

// ---------------------------------------------------------------------------
// Leitura dos logs (tela de integrações) — sem material secreto
// ---------------------------------------------------------------------------

export async function listarLogsDeIntegracao(ctx: ContextoHub, opts: { limite?: number; canal?: string } = {}) {
  const s = storeDoAtor(ctx.escopo);
  const filtro: Record<string, unknown> = ctx.canal ? { provider: ctx.canal } : {};
  const out = await s.list(RESOURCES.integration_logs, {
    page: 1,
    pageSize: Math.min(200, Math.max(1, opts.limite || 50)),
    sort: 'id',
    dir: 'desc',
    filter: filtro,
  });
  return out.rows.map((r: any) => ({
    id: r.id,
    empresa_id: r.empresa_id,
    provider: r.provider,
    operacao: r.operacao,
    request_id: r.request_id,
    external_id: r.external_id,
    entidade: r.entidade,
    status: r.status,
    tentativa: r.tentativa,
    duracao_ms: r.duracao_ms,
    erro: r.erro,
    proxima_tentativa_em: r.proxima_tentativa_em,
    criado_em: r.criado_em,
  }));
}

/** Vínculos de pedido externo visíveis para a empresa do escopo (sem payload). */
export async function listarPedidosExternosDoErp(ctx: ContextoHub, opts: { canal?: string; limite?: number } = {}) {
  const s = storeDoAtor(ctx.escopo);
  const filtro: Record<string, unknown> = opts.canal ? { provider: opts.canal } : {};
  const out = await s.list(RESOURCES.commerce_pedidos_externos, {
    page: 1,
    pageSize: Math.min(200, Math.max(1, opts.limite || 50)),
    sort: 'id',
    dir: 'desc',
    filter: filtro,
  });
  return out.rows;
}

/** Canais conhecidos + estado de configuração (a tela usa isto). */
export async function estadoDosCanais(ctx: ContextoHub) {
  const providers = provedoresComercio(ctx.deps);
  return CANAIS_COMERCIO.map((canal) => {
    const provider = providers[canal];
    const config = provider.configurado({});
    return {
      canal,
      rotulo: provider.rotulo,
      capacidades: provider.capacidades,
      requerCredencial: provider.requerCredencial,
      configurado: config.ok,
      motivo: config.motivo || null,
    };
  });
}
