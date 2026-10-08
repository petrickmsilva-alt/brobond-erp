// ============================================================================
// HUB DE E-COMMERCE — CAMADA HTTP (Fase P3, §2-§7, §15-§17)
//
// Autenticado (gerente/admin), sempre na EMPRESA ATIVA do ator:
//
//   GET  /api/commerce/canais
//   POST /api/commerce/canais/:canal/testar
//   POST /api/commerce/canais/:canal/pedidos/importar
//   POST /api/commerce/canais/:canal/estoque/publicar
//   POST /api/commerce/canais/:canal/preco/publicar
//   GET  /api/commerce/logs
//   GET  /api/commerce/pedidos-externos
//   POST /api/commerce/retentativas/processar
//
// Público (assinatura do canal, corpo cru, antes do express.json):
//
//   POST /api/webhooks/comercio/:canal
//
// Em nenhuma resposta sai token/senha/segredo — os adaptadores devolvem apenas
// contadores, ids e mensagens.
// ============================================================================
import express, { type Request, type Response, type Router } from 'express';
import { currentUser } from './auth';
import { HttpError } from './errors';
import { escopoDoAtor } from './empresa';
import { getStore, RESOURCES, storeDoAtor } from './commerce/ponte';
import { CANAIS_COMERCIO, isCanalComercio, MAX_TENTATIVAS, proximaTentativaEm, type CanalComercio } from './commerce/contrato';
import { providerDe } from './commerce/registro';
import {
  contextoDoAtor,
  credencialDoUsuario,
  estadoDosCanais,
  importarPedidosDoCanal,
  listarLogsDeIntegracao,
  pendentesDeRetry,
  processarWebhookDoCanal,
  publicarEstoqueDoCanal,
  publicarPrecoDoCanal,
} from './commerce/hub';
import { connectorRepository } from '../../modules/connectors/core/connector.repository';

// ---------------------------------------------------------------------------
// Acesso: gerente e admin. Operador não opera integração de canal.
// ---------------------------------------------------------------------------
function atorDeIntegracao(req: Request) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') {
    throw new HttpError(403, 'Integrações de canal exigem perfil de gerente ou administrador.');
  }
  return actor;
}

function canalDaRota(req: Request): CanalComercio {
  const bruto = String(req.params.canal || '').toUpperCase();
  if (!isCanalComercio(bruto)) {
    throw new HttpError(404, `Canal desconhecido: "${req.params.canal}". Canais: ${CANAIS_COMERCIO.join(', ')}.`);
  }
  return bruto;
}

function contexto(req: Request, canal: CanalComercio, deps?: unknown) {
  const actor = atorDeIntegracao(req);
  return contextoDoAtor(canal, actor as any, deps);
}

// ---------------------------------------------------------------------------
// GET /api/commerce/canais — ficha dos canais + o que está configurado
// ---------------------------------------------------------------------------
export async function canaisComercio(req: Request, res: Response) {
  const actor = atorDeIntegracao(req);
  const escopo = escopoDoAtor(actor as any);
  const ctx = contextoDoAtor('MERCADOLIVRE', actor as any);
  const canais = await estadoDosCanais(ctx);
  const s = storeDoAtor(escopo);
  const mapeamentos = await s.list(RESOURCES.commerce_mapeamentos, { page: 1, pageSize: 1 });
  const pedidos = await s.list(RESOURCES.commerce_pedidos_externos, { page: 1, pageSize: 1 });
  const erros = await s.countWhere(RESOURCES.integration_logs, { status: 'erro' });
  res.json({ canais, mapeamentos: mapeamentos.total, pedidos_externos: pedidos.total, erros_pendentes: erros });
}

// ---------------------------------------------------------------------------
// POST /api/commerce/canais/:canal/testar — chamada real, sem gravar segredo
// ---------------------------------------------------------------------------
export async function testarCanalComercio(req: Request, res: Response) {
  const canal = canalDaRota(req);
  const ctx = contexto(req, canal);
  const credencial = await credencialDoUsuario(ctx.usuarioId, canal);
  const provider = providerDe(canal, ctx.deps);
  const inicio = Date.now();
  const resultado = await provider.testar({ credencial, requestId: ctx.escopo.empresaId + '-' + Date.now() });
  res.json({ canal, ok: resultado.ok, externo_id: resultado.externoId ?? null, mensagem: resultado.mensagem || null, duracao_ms: Date.now() - inicio });
}

// ---------------------------------------------------------------------------
// POST /api/commerce/canais/:canal/pedidos/importar — polling controlado
// ---------------------------------------------------------------------------
export async function importarPedidosComercio(req: Request, res: Response) {
  const canal = canalDaRota(req);
  const ctx = contexto(req, canal);
  const body = (req.body || {}) as Record<string, unknown>;
  const dias = Math.min(180, Math.max(1, Number(body.dias) || 30));
  const desde = body.desde ? new Date(String(body.desde)) : new Date(Date.now() - dias * 86400_000);
  if (Number.isNaN(desde.getTime())) throw new HttpError(400, 'Data inicial ("desde") inválida.');
  const limite = Math.min(200, Math.max(1, Number(body.limite) || 50));
  const resumo = await importarPedidosDoCanal(ctx, { desde, limite });
  res.json({ ok: true, ...resumo });
}

export async function publicarEstoqueComercio(req: Request, res: Response) {
  const canal = canalDaRota(req);
  const ctx = contexto(req, canal);
  const resumo = await publicarEstoqueDoCanal(ctx, { limite: Number((req.body || {}).limite) || 5000 });
  res.json({ ok: true, ...resumo });
}

export async function publicarPrecoComercio(req: Request, res: Response) {
  const canal = canalDaRota(req);
  const ctx = contexto(req, canal);
  const resumo = await publicarPrecoDoCanal(ctx, { limite: Number((req.body || {}).limite) || 5000 });
  res.json({ ok: true, ...resumo });
}

// ---------------------------------------------------------------------------
// GET /api/commerce/logs e /api/commerce/pedidos-externos
// ---------------------------------------------------------------------------
export async function listarLogsComercio(req: Request, res: Response) {
  const canalBruto = String(req.query.canal || '').toUpperCase();
  const canal = canalBruto && isCanalComercio(canalBruto) ? canalBruto : null;
  const ctx = contexto(req, canal || 'MERCADOLIVRE');
  const logs = await listarLogsDeIntegracao(ctx, { limite: Number(req.query.limite) || 50, canal: canal || undefined });
  const s = storeDoAtor(ctx.escopo);
  const pendentes = await pendentesDeRetry(ctx.escopo, 100);
  res.json({ logs, pendentes_retry: pendentes.length });
}

export async function listarPedidosExternosComercio(req: Request, res: Response) {
  const actor = atorDeIntegracao(req);
  const escopo = escopoDoAtor(actor as any);
  const canalBruto = String(req.query.canal || '').toUpperCase();
  const filtro: Record<string, unknown> = {};
  if (canalBruto) filtro.provider = canalBruto;
  const s = storeDoAtor(escopo);
  const out = await s.list(RESOURCES.commerce_pedidos_externos, {
    page: Math.max(1, Number(req.query.page) || 1),
    pageSize: Math.min(200, Math.max(1, Number(req.query.pageSize) || 50)),
    sort: 'id',
    dir: 'desc',
    filter: filtro,
  });
  // O payload bruto do canal pode conter dado pessoal completo: a listagem
  // devolve o essencial e sinaliza que existe payload guardado para auditoria.
  res.json({
    total: out.total,
    rows: out.rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      external_order_id: r.external_order_id,
      venda_id: r.venda_id,
      status_externo: r.status_externo,
      status_erp: r.status_erp,
      importado_em: r.importado_em,
      atualizado_em: r.atualizado_em,
      tem_payload: r.payload !== null && r.payload !== undefined,
    })),
  });
}

// ---------------------------------------------------------------------------
// POST /api/commerce/retentativas/processar (§16)
//
// Reprocessa SÓ o que é transitório e está vencido; cada passada incrementa a
// tentativa e reagenda com backoff. Ao bater o teto, a linha para de ser
// escolhida — nada de laço infinito. Operações cujo retry automático é
// inseguro (publicação de estoque) apenas reexecutam a publicação: a operação
// é idempotente por natureza (PUT de saldo).
// ---------------------------------------------------------------------------
export async function processarRetentativasComercio(req: Request, res: Response) {
  const actor = atorDeIntegracao(req);
  const escopo = escopoDoAtor(actor as any);
  const vencidas = await pendentesDeRetry(escopo, 20);
  const resultados: { id: number; provider: string; operacao: string; resultado: string }[] = [];
  const s = storeDoAtor(escopo);

  for (const log of vencidas) {
    const provider = String(log.provider || '');
    if (!isCanalComercio(provider)) {
      resultados.push({ id: Number(log.id), provider, operacao: String(log.operacao), resultado: 'canal desconhecido' });
      continue;
    }
    const tentativa = Number(log.tentativa || 1) + 1;
    const ctx = contextoDoAtor(provider, actor as any);
    try {
      if (String(log.operacao).startsWith('estoque.publicar')) {
        await publicarEstoqueDoCanal(ctx);
        resultados.push({ id: Number(log.id), provider, operacao: String(log.operacao), resultado: 'republicado' });
      } else if (String(log.operacao).startsWith('preco.publicar')) {
        await publicarPrecoDoCanal(ctx);
        resultados.push({ id: Number(log.id), provider, operacao: String(log.operacao), resultado: 'republicado' });
      } else {
        // pedido.importar / webhook / listarPedidos — a releitura do período é
        // idempotente: o vínculo (empresa, canal, id externo) barra duplicata.
        const resumo = await importarPedidosDoCanal(ctx, { desde: new Date(Date.now() - 7 * 86400_000), limite: 50 });
        resultados.push({ id: Number(log.id), provider, operacao: String(log.operacao), resultado: `${resumo.importados.length} novo(s), ${resumo.ignorados.length} já existente(s)` });
      }
      await s.update(RESOURCES.integration_logs, Number(log.id), { status: 'ok', erro: null, proxima_tentativa_em: null });
    } catch (e: any) {
      const transitorio = e?.transitorio !== false;
      const proxima = transitorio ? proximaTentativaEm(tentativa) : null;
      await s.update(RESOURCES.integration_logs, Number(log.id), {
        tentativa,
        erro: String(e?.message || 'falha').slice(0, 900),
        proxima_tentativa_em: proxima,
        status: transitorio ? 'erro' : 'nao_suportado',
      });
      resultados.push({ id: Number(log.id), provider, operacao: String(log.operacao), resultado: `falhou (tentativa ${tentativa}${proxima ? '' : `, limite ${MAX_TENTATIVAS} atingido`})` });
    }
  }
  res.json({ ok: true, processadas: resultados.length, resultados });
}

/** Chamado pelo agendador (cron) para manter os canais em dia. */
export async function retentativasPendentes(): Promise<number> {
  try {
    const s = getStore();
    const out = await s.list(RESOURCES.integration_logs, { page: 1, pageSize: 500, sort: 'id', dir: 'asc', filter: { status: 'erro' } });
    const agora = Date.now();
    return out.rows.filter((r) => {
      if (Number(r.tentativa) >= MAX_TENTATIVAS) return false;
      const alvo = r.proxima_tentativa_em ? Date.parse(String(r.proxima_tentativa_em)) : null;
      return alvo !== null && alvo <= agora;
    }).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// WEBHOOK PÚBLICO — /api/webhooks/comercio/:canal
//
// Sem sessão: a autenticação é a ASSINATURA do canal (quando ele assina) e a
// resolução do inquilino pelo identificador que o próprio canal envia
// (store_id/seller). Canal sem assinatura (Mercado Livre) exige token secreto
// na URL (`?t=`), comparado com `COMMERCE_WEBHOOK_TOKEN` — sem token
// configurado no servidor, a rota recusa (nunca "libera por padrão").
// ---------------------------------------------------------------------------
async function donoDoWebhook(canal: CanalComercio, payload: any, headers: Record<string, string | undefined>) {
  if (canal === 'WOOCOMMERCE') {
    // A loja do site é única por instalação: a empresa é configurada no
    // servidor (WOOCOMMERCE_EMPRESA_ID) e o padrão é a empresa 1.
    const empresaId = Number(process.env.WOOCOMMERCE_EMPRESA_ID || 1) || 1;
    return { usuarioId: 0, empresaId };
  }
  const bruto =
    canal === 'NUVEMSHOP'
      ? payload?.store_id ?? headers['x-linkedstore-store-id'] ?? headers['X-Linkedstore-Store-Id']
      : payload?.user_id ?? payload?.seller_id;
  const alvo = String(bruto ?? '').trim();
  if (!alvo) return null;
  let conector: Awaited<ReturnType<typeof connectorRepository.findByShopId>> = null;
  try {
    conector = await connectorRepository.findByShopId(canal, alvo);
  } catch {
    // Modo demonstração/banco indisponível: sem inquilino identificável o
    // webhook é aceito e ignorado — nunca gravado "em nome de ninguém".
    return null;
  }
  if (!conector) return null;
  let empresaId = 1;
  try {
    const usuario = await getStore().get(RESOURCES.usuarios, Number(conector.usuarioId));
    if (usuario && Number(usuario.empresa_id) > 0) empresaId = Number(usuario.empresa_id);
  } catch {
    // Sem o usuário, a empresa padrão é o recorte seguro: o ERP não inventa
    // acesso a outra empresa por causa de um webhook.
  }
  return { usuarioId: Number(conector.usuarioId), empresaId };
}

export async function webhookComercio(req: Request, res: Response) {
  const canalBruto = String(req.params.canal || '').toUpperCase();
  if (!isCanalComercio(canalBruto)) {
    res.status(404).json({ ok: false, erro: 'Canal desconhecido.' });
    return;
  }
  const canal = canalBruto;
  const corpoBruto = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String((req.body as any) || '');
  let payload: any = {};
  try {
    payload = JSON.parse(corpoBruto || '{}');
  } catch {
    res.status(400).json({ ok: false, erro: 'Corpo do webhook não é JSON.' });
    return;
  }

  const headers = req.headers as Record<string, string | undefined>;
  const provider = providerDe(canal);

  // Canal sem assinatura criptográfica: token secreto obrigatório na URL.
  if (canal === 'MERCADOLIVRE') {
    const esperado = String(process.env.COMMERCE_WEBHOOK_TOKEN || '').trim();
    const recebido = String(req.query.t || '').trim();
    if (!esperado || recebido !== esperado) {
      res.status(401).json({ ok: false, erro: 'Webhook não autorizado.' });
      return;
    }
    if (payload?.topic && !String(payload.topic).startsWith('orders')) {
      res.json({ ok: true, ignorado: 'tópico não suportado pelo ERP' });
      return;
    }
  }

  // ASSINATURA PRIMEIRO: a porta fecha antes de qualquer trabalho — e antes de
  // tentar identificar o inquilino (que pode nem estar disponível no momento).
  const assinaturaOk = provider.validarWebhook ? provider.validarWebhook(corpoBruto, headers, {}) : true;
  if (!assinaturaOk) {
    res.status(401).json({ ok: false, erro: 'Assinatura do webhook inválida.' });
    return;
  }

  const dono = await donoDoWebhook(canal, payload, headers);
  if (!dono) {
    // Sem inquilino identificado não se grava nada em nome de ninguém.
    res.status(202).json({ ok: true, ignorado: 'não foi possível identificar a empresa do canal' });
    return;
  }

  const ctx = contextoDoAtor(canal, { id: dono.usuarioId, name: `Webhook ${canal}`, empresa_id: dono.empresaId } as any);
  try {
    const resultado = await processarWebhookDoCanal(canal, corpoBruto, headers, ctx);
    res.json({ ok: true, ...resultado });
  } catch (e: any) {
    const status = e instanceof HttpError ? e.status : 502;
    res.status(status).json({ ok: false, erro: e?.message || 'Falha ao processar o webhook.' });
  }
}

/** Montado ANTES do express.json (a assinatura é sobre os bytes crus). */
export const publicCommerceRouter: Router = express.Router();
publicCommerceRouter.post('/api/webhooks/comercio/:canal', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  // Um canal indisponível não pode deixar a requisição pendurada: responde
  // 502 e o provedor reenvia depois (o ERP não perde o evento em silêncio).
  void webhookComercio(req, res).catch((e: any) => {
    if (!res.headersSent) res.status(e instanceof HttpError ? e.status : 502).json({ ok: false, erro: 'Falha ao processar o webhook.' });
  });
});
