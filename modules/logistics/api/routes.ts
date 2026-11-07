// ============================================================================
// MOTOR DE FRETE › API › ROTAS
//
// Todas as rotas:
//   • exigem identidade autenticada;
//   • recortam pela EMPRESA do ator (nunca a empresa do corpo da requisição);
//   • exigem o RECURSO (checkAccess) e, para gestão, perfil gerente/admin;
//   • devolvem diagnóstico SEM credencial — nenhuma resposta carrega token,
//     senha, URL com usuário/senha ou corpo remoto do operador;
//   • validam a LOJA contra o registry (RETAIL/WHOLESALE) — não há loja padrão
//     implícita.
//
// Montagem: `app.use('/api/logistics', logisticsRouter)` (ver index.ts).
// O router PÚBLICO de webhooks é montado à parte (antes do express.json).
// ============================================================================
import { type NextFunction, type Request, type Response, Router } from 'express';
import { currentUser } from '../../../server/src/auth';
import { checkAccess } from '../../../server/src/services';
import { getStore } from '../../../server/src/services';
import { getResource } from '../../../server/src/resources';
import { escopoDoAtor, empresaDoRegistroAudit, assertRegistroDaEmpresa } from '../../../server/src/empresa';
import { HttpError } from '../../../server/src/errors';
import { round2 } from '../../../server/src/utils';
import { parseId } from '../../../server/src/validate';
import { ehStoreKey, type StoreKey, type Modalidade } from '../domain/contract';
import { TIPOS_REGRA } from '../domain/rules';
import { carriers, carrier } from '../providers/contract';
import { registrarCarriers } from '../providers/registry';
import { mascararConfigCarrier, salvarConfigCarrier, obterConfigCarrier, type Ambiente } from '../infrastructure/config';
import { R_SHIPPING_RULES, R_QUOTES, R_PACKAGES, R_LABELS } from '../infrastructure/resources';
import { listarEntregas, contarEntregas, reenfileirarEntrega, recuperarEntregasPendentes } from '../infrastructure/webhookInbox';
import { cotarFrete, logisticsHabilitado, provedorPadrao, selecionarOpcao } from '../application/quotes';
import { criarRemessa, gerarEtiqueta, avancarStatusEnvio } from '../application/shipments';
import { sincronizarRastreio } from '../application/tracking';
import { reconciliarEmpresa } from '../application/reconciliation';
import { lojaDaVenda, enfileirarRastreioLoja } from '../integration/woocommerce';
import { auditarLogistica } from '../infrastructure/audit';
import { coletarIndicadores } from '../application/painel';
import type { Row } from '../../../server/src/store';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

export const logisticsRouter: Router = Router();

// Registro dos adaptadores (idempotente).
registrarCarriers();

function exigirGestao(req: Request) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') {
    throw new HttpError(403, 'Apenas gerentes e administradores operam o módulo logístico.');
  }
  return actor;
}

function exigirAdmin(req: Request) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Somente administradores alteram a configuração de transportadoras.');
  return actor;
}

function lojaOpcional(valor: unknown): StoreKey | null {
  if (valor === undefined || valor === null || valor === '') return null;
  const bruto = String(valor).trim().toUpperCase();
  if (!ehStoreKey(bruto)) throw new HttpError(400, 'Loja inválida. Use RETAIL ou WHOLESALE.');
  return bruto;
}

function empresaDoAtor(req: Request): number {
  return escopoDoAtor(currentUser(req)).empresaId;
}

// ----------------------------------------------------------------------------
// CONFIGURAÇÃO DE TRANSPORTADORAS
// ----------------------------------------------------------------------------
/** GET /api/logistics/providers — operadores registrados + capacidades + config (mascarada). */
export const listarProviders = async (req: Request, res: Response): Promise<void> => {
  const actor = exigirGestao(req);
  const empresaId = empresaDoAtor(req);
  res.setHeader('Cache-Control', 'private, no-store');
  const lista = await Promise.all(
    carriers().map(async (c) => {
      const cfg = await obterConfigCarrier(empresaId, c.slug);
      const disp = await c.disponivel(empresaId).catch(() => ({ configurado: false, habilitado: false, motivo: 'Falha ao avaliar disponibilidade.' }));
      return {
        slug: c.slug,
        nome: c.nome,
        doc_url: c.docUrl ?? null,
        capacidades: c.capacidades,
        credenciais: c.credenciais,
        configurado: disp.configurado,
        habilitado: disp.habilitado,
        motivo: disp.motivo,
        config: mascararConfigCarrier(cfg),
      };
    })
  );
  res.json({
    modulo_habilitado: logisticsHabilitado(),
    provider_padrao: provedorPadrao(),
    providers: lista.sort((a, b) => a.slug.localeCompare(b.slug)),
    ator: actor.perfil,
  });
};

/** PUT /api/logistics/providers/:slug — grava config/credenciais (cifradas). */
export const salvarProvider = async (req: Request, res: Response): Promise<void> => {
  const actor = exigirAdmin(req);
  const empresaId = empresaDoAtor(req);
  const slug = String(req.params.slug || '').toLowerCase().trim();
  const adapter = carrier(slug);
  if (!adapter) throw new HttpError(404, 'Operador não registrado.');
  const body = (req.body || {}) as Record<string, unknown>;
  const patch: { habilitado?: boolean; ambiente?: Ambiente; credenciais?: Record<string, string | null> } = {};
  if (body.habilitado !== undefined) patch.habilitado = !!body.habilitado;
  if (body.ambiente !== undefined) {
    const amb = String(body.ambiente).toLowerCase();
    if (amb !== 'homologacao' && amb !== 'producao') throw new HttpError(400, 'ambiente deve ser "homologacao" ou "producao".');
    patch.ambiente = amb;
  }
  if (body.credenciais && typeof body.credenciais === 'object') {
    patch.credenciais = {};
    for (const [k, v] of Object.entries(body.credenciais as Record<string, unknown>)) {
      patch.credenciais[k] = v === null || v === '' ? null : String(v);
    }
  }
  // Ativar um operador EXTERNO sem credencial obrigatória é recusado: a tela não
  // pode mostrar "integrado" para algo que vai falhar na primeira remessa.
  const cfgAtual = await obterConfigCarrier(empresaId, slug);
  const credenciaisFinal = { ...cfgAtual.credenciais, ...(patch.credenciais ?? {}) };
  if (patch.habilitado) {
    const faltando = adapter.credenciais.filter((c) => c.obrigatoria && !credenciaisFinal[c.chave]);
    if (faltando.length) {
      throw new HttpError(409, `Configure as credenciais obrigatórias do ${adapter.nome} antes de habilitá-lo: ${faltando.map((c) => c.label).join(', ')}.`, Object.fromEntries(faltando.map((c) => [c.chave, 'Obrigatório'])));
    }
  }
  const salvo = await salvarConfigCarrier(empresaId, slug, patch, actor.name);
  await auditarLogistica({ empresaId, entidade: 'provider_config', acao: 'configuracao', descricao: `Configuração do operador ${slug} atualizada`, dados: { habilitado: salvo.habilitado, ambiente: salvo.ambiente, credenciais: Object.keys(credenciaisFinal) }, usuarioId: actor.id });
  res.json({ ok: true, config: mascararConfigCarrier(salvo) });
};

/** POST /api/logistics/providers/:slug/health — health check (sem efeito colateral). */
export const healthProvider = async (req: Request, res: Response): Promise<void> => {
  exigirGestao(req);
  const empresaId = empresaDoAtor(req);
  const slug = String(req.params.slug || '').toLowerCase().trim();
  const adapter = carrier(slug);
  if (!adapter) throw new HttpError(404, 'Operador não registrado.');
  const disp = await adapter.disponivel(empresaId);
  res.json({ slug, configurado: disp.configurado, habilitado: disp.habilitado, motivo: disp.motivo, capacidades: adapter.capacidades });
};

// ----------------------------------------------------------------------------
// REGRAS COMERCIAIS
// ----------------------------------------------------------------------------
/** GET /api/logistics/rules */
export const listarRegras = async (req: Request, res: Response): Promise<void> => {
  exigirGestao(req);
  const empresaId = empresaDoAtor(req);
  const store = lojaOpcional(req.query.store);
  const s = getStore();
  const out = await s.list(R_SHIPPING_RULES(), { page: 1, pageSize: 500, filter: { empresa_id: empresaId }, sort: 'prioridade', dir: 'desc' });
  const regras = out.rows.filter((r) => !store || !r.store_key || r.store_key === store);
  res.json({ regras, tipos: TIPOS_REGRA });
};

/** POST /api/logistics/rules — cria regra. */
export const criarRegra = async (req: Request, res: Response): Promise<void> => {
  const actor = exigirGestao(req);
  const empresaId = empresaDoAtor(req);
  const body = (req.body || {}) as Record<string, unknown>;
  const nome = String(body.nome || '').trim();
  if (nome.length < 3) throw new HttpError(400, 'Informe o nome da regra.', { nome: 'Mínimo 3 caracteres' });
  const tipo = String(body.tipo || '').toUpperCase();
  if (!TIPOS_REGRA.includes(tipo as (typeof TIPOS_REGRA)[number])) throw new HttpError(400, `Tipo inválido. Use: ${TIPOS_REGRA.join(', ')}.`, { tipo: 'Inválido' });
  const store = lojaOpcional(body.store_key);
  const s = getStore();
  const regra = await s.insert(R_SHIPPING_RULES(), {
    empresa_id: empresaId,
    store_key: store,
    nome,
    descricao: body.descricao ? String(body.descricao).slice(0, 500) : null,
    tipo,
    prioridade: Number(body.prioridade) || 0,
    ativo: body.ativo !== false,
    condicoes: (body.condicoes && typeof body.condicoes === 'object' ? body.condicoes : {}) as Record<string, unknown>,
    acoes: (body.acoes && typeof body.acoes === 'object' ? body.acoes : {}) as Record<string, unknown>,
    inicio_em: body.inicio_em ? String(body.inicio_em) : null,
    fim_em: body.fim_em ? String(body.fim_em) : null,
    criado_por: actor.id,
  });
  await auditarLogistica({ empresaId, storeKey: store, entidade: 'regra', entidadeId: Number(regra.id), acao: 'criar', descricao: `Regra "${nome}" (${tipo}) criada`, dados: { tipo, prioridade: regra.prioridade }, usuarioId: actor.id });
  res.status(201).json({ ok: true, regra });
};

/** PUT /api/logistics/rules/:id */
export const atualizarRegra = async (req: Request, res: Response): Promise<void> => {
  const actor = exigirGestao(req);
  const empresaId = empresaDoAtor(req);
  const id = parseId(req.params.id);
  const s = getStore();
  const atual = await s.findOneWhere(R_SHIPPING_RULES(), { id, empresa_id: empresaId });
  if (!atual) throw new HttpError(404, 'Regra não encontrada.');
  const body = (req.body || {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (body.nome !== undefined) patch.nome = String(body.nome).slice(0, 200);
  if (body.descricao !== undefined) patch.descricao = body.descricao ? String(body.descricao).slice(0, 500) : null;
  if (body.tipo !== undefined) {
    const tipo = String(body.tipo).toUpperCase();
    if (!TIPOS_REGRA.includes(tipo as (typeof TIPOS_REGRA)[number])) throw new HttpError(400, 'Tipo inválido.');
    patch.tipo = tipo;
  }
  if (body.store_key !== undefined) patch.store_key = lojaOpcional(body.store_key);
  if (body.prioridade !== undefined) patch.prioridade = Number(body.prioridade) || 0;
  if (body.ativo !== undefined) patch.ativo = !!body.ativo;
  if (body.condicoes !== undefined) patch.condicoes = typeof body.condicoes === 'object' ? body.condicoes : {};
  if (body.acoes !== undefined) patch.acoes = typeof body.acoes === 'object' ? body.acoes : {};
  if (body.inicio_em !== undefined) patch.inicio_em = body.inicio_em ? String(body.inicio_em) : null;
  if (body.fim_em !== undefined) patch.fim_em = body.fim_em ? String(body.fim_em) : null;
  patch.atualizado_em = new Date().toISOString();
  const regra = await s.update(R_SHIPPING_RULES(), id, patch);
  await auditarLogistica({ empresaId, entidade: 'regra', entidadeId: id, acao: 'editar', descricao: `Regra #${id} atualizada`, dados: { campos: Object.keys(patch) }, usuarioId: actor.id });
  res.json({ ok: true, regra });
};

// ----------------------------------------------------------------------------
// COTAÇÃO
// ----------------------------------------------------------------------------
/** POST /api/logistics/quote — cota o frete de uma venda (backend revalida). */
export const cotarVenda = async (req: Request, res: Response): Promise<void> => {
  exigirGestao(req);
  const escopo = escopoDoAtor(currentUser(req));
  const body = (req.body || {}) as Record<string, unknown>;
  const vendaId = parseId(body.venda_id);
  const s = getStore();
  const venda = assertRegistroDaEmpresa(getResource('vendas')!, await s.get(getResource('vendas')!, vendaId), escopo);
  const empresaId = Number(venda.empresa_id) || escopo.empresaId;
  const { montarContextoVenda } = await import('../application/contexto');
  const ctx = await montarContextoVenda(empresaId, venda, {
    provider: body.provider ? String(body.provider) : null,
    modalidade: body.modalidade ? (String(body.modalidade).toUpperCase() as Modalidade) : undefined,
  });
  const resultado = await cotarFrete(ctx, { provider: ctx.providerSlug });
  const melhor = selecionarOpcao(resultado.opcoes, 'custo');
  res.json({
    estado: resultado.estado,
    motivo: resultado.motivo,
    quote_id: resultado.quote_id,
    provedor: { slug: resultado.provedor, nome: resultado.provedorNome },
    modalidade: resultado.modalidade,
    origem: ctx.origem,
    destino: ctx.destino,
    peso_g: ctx.pesoTotalG,
    volumes: ctx.volumes.length,
    valor_declarado: ctx.valorDeclarado,
    valida_ate: resultado.validaAte,
    referencia_externa: resultado.referenciaExterna,
    opcoes: resultado.opcoes,
    melhor_opcao: melhor,
  });
};

// ----------------------------------------------------------------------------
// REMESSAS
// ----------------------------------------------------------------------------
/** POST /api/logistics/shipments — cria remessa a partir de uma cotação. */
export const criarRemessaRota = async (req: Request, res: Response): Promise<void> => {
  exigirGestao(req);
  const escopo = escopoDoAtor(currentUser(req));
  const body = (req.body || {}) as Record<string, unknown>;
  const vendaId = parseId(body.venda_id);
  const s = getStore();
  const venda = assertRegistroDaEmpresa(getResource('vendas')!, await s.get(getResource('vendas')!, vendaId), escopo);
  const empresaId = Number(venda.empresa_id) || escopo.empresaId;

  // Localiza a cotação selecionada e REVALIDA no backend (nunca confia no valor do navegador).
  const quoteId = body.quote_id !== undefined ? Number(body.quote_id) : null;
  let cotacao: Row | null = null;
  if (quoteId) {
    cotacao = await s.findOneWhere(R_QUOTES(), { id: quoteId, empresa_id: empresaId });
    if (!cotacao) throw new HttpError(404, 'Cotação não encontrada para esta empresa.');
    if (String(cotacao.estado) !== 'OK') throw new HttpError(409, `A cotação selecionada não está válida (${cotacao.estado}). Cote novamente.`);
    if (cotacao.valida_ate && Date.parse(String(cotacao.valida_ate)) < Date.now()) throw new HttpError(409, 'A cotação selecionada expirou. Cote novamente.');
  }
  const opcoes = cotacao ? ((cotacao.opcoes as Row[]) ?? []) : [];
  const servicoEscolhido = body.servico ? String(body.servico) : null;
  const opcao = servicoEscolhido ? opcoes.find((o) => String(o.servico) === servicoEscolhido || String(o.codigo) === servicoEscolhido) : opcoes[0];
  if (cotacao && !opcao) throw new HttpError(400, 'Serviço escolhido não está entre as opções da cotação selecionada.');

  const { montarContextoVenda } = await import('../application/contexto');
  const ctx = await montarContextoVenda(empresaId, venda, {});
  const storeKey = await lojaDaVenda(empresaId, vendaId);
  const idempotencyKey = String(body.idempotency_key || req.header('idempotency-key') || `envio:venda:${vendaId}`).slice(0, 120);

  const resultado = await criarRemessa({
    empresaId,
    vendaId,
    storeKey,
    quoteId: cotacao ? Number(cotacao.id) : null,
    provider: String(cotacao?.provider || ctx.providerSlug),
    servico: opcao ? String(opcao.servico) : null,
    servicoNome: opcao ? String(opcao.nome) : null,
    modalidade: String(cotacao?.modalidade || ctx.modalidade),
    volumes: ctx.volumes,
    pesoTotalG: ctx.pesoTotalG,
    cepDestino: ctx.destino.cep,
    valorDeclarado: ctx.valorDeclarado,
    valorPedido: ctx.valorPedido,
    custoPrevisto: opcao ? Number(opcao.valor_final ?? opcao.valor ?? 0) : 0,
    prazoDias: opcao ? Number(opcao.prazo_dias) || null : null,
    idempotencyKey,
    usuarioId: currentUser(req).id ?? null,
    origemCep: ctx.origem.cep,
  });

  // Atualiza o frete/total da venda com o valor efetivo (regra do ERP).
  const custo = round2(Number(resultado.envio.custo || 0));
  const totalAtual = Number(venda.total || 0);
  const freteAtual = Number(venda.frete || 0);
  await s.update(getResource('vendas')!, vendaId, {
    envio_id: Number(resultado.envio.id),
    frete: custo > 0 ? custo : freteAtual,
    total: round2(totalAtual - freteAtual + (custo > 0 ? custo : freteAtual)),
  });

  res.status(resultado.idempotente ? 200 : 201).json({
    ok: true,
    idempotente: resultado.idempotente,
    pendente: !!resultado.pendente,
    envio: resultado.envio,
    mensagem: resultado.pendente ? 'A remessa não pôde ser gerada no operador; o envio ficou PENDENTE com o motivo — nada foi postado.' : resultado.idempotente ? 'Remessa já existente devolvida.' : 'Remessa criada.',
  });
};

/** GET /api/logistics/shipments — lista remessas com filtros. */
export const listarRemessas = async (req: Request, res: Response): Promise<void> => {
  exigirGestao(req);
  const empresaId = empresaDoAtor(req);
  const store = lojaOpcional(req.query.store);
  const status = req.query.status ? String(req.query.status) : null;
  const provider = req.query.provider ? String(req.query.provider) : null;
  const filtro: Record<string, unknown> = { empresa_id: empresaId };
  if (store) filtro.store_key = store;
  if (status) filtro.status = status;
  if (provider) filtro.provider = provider;
  const s = getStore();
  const out = await s.list(getResource('envios')!, {
    page: Number(req.query.page) || 1,
    pageSize: Math.min(200, Number(req.query.pageSize) || 50),
    filter: filtro,
    sort: 'criado_em',
    dir: 'desc',
  });
  res.json(out);
};

/** GET /api/logistics/shipments/:id — detalhe + volumes + etiquetas + eventos. */
export const detalharRemessa = async (req: Request, res: Response): Promise<void> => {
  exigirGestao(req);
  const escopo = escopoDoAtor(currentUser(req));
  const id = parseId(req.params.id);
  const s = getStore();
  const envio = assertRegistroDaEmpresa(getResource('envios')!, await s.get(getResource('envios')!, id), escopo);
  const empresaId = Number(envio.empresa_id);
  const [volumes, etiquetas, eventos] = await Promise.all([
    s.list(R_PACKAGES(), { page: 1, pageSize: 100, filter: { empresa_id: empresaId, envio_id: id }, sort: 'indice', dir: 'asc' }),
    s.list(R_LABELS(), { page: 1, pageSize: 50, filter: { empresa_id: empresaId, envio_id: id }, sort: 'id', dir: 'desc' }),
    s.list(getResource('envio_eventos')!, { page: 1, pageSize: 500, filter: { empresa_id: empresaId, envio_id: id }, sort: 'id', dir: 'asc' }),
  ]);
  res.json({ envio, volumes: volumes.rows, etiquetas: etiquetas.rows, eventos: eventos.rows });
};

/** POST /api/logistics/shipments/:id/status — avança status (não regride). */
export const avancarStatusRota = async (req: Request, res: Response): Promise<void> => {
  const actor = exigirGestao(req);
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const body = (req.body || {}) as Record<string, unknown>;
  const s = getStore();
  const envio = assertRegistroDaEmpresa(getResource('envios')!, await s.get(getResource('envios')!, id), escopo);
  const empresaId = Number(envio.empresa_id);
  const alvo = String(body.status || '').toLowerCase();
  const r = await avancarStatusEnvio(empresaId, id, alvo as never, { mensagem: body.mensagem ? String(body.mensagem).slice(0, 500) : undefined, codigo: body.codigo_rastreamento ? String(body.codigo_rastreamento) : undefined, origem: 'manual', usuarioId: actor.id ?? null });
  if (!r.ok) throw new HttpError(409, r.motivo || 'Transição não permitida.');
  await s.audit({ usuario_id: actor.id ?? null, usuario: actor.name, acao: 'editar', recurso: 'envios', registro_id: id, descricao: `Envio #${id}: status → ${r.status}`, dados: { para: r.status }, empresa_id: empresaDoRegistroAudit(getResource('envios')!, envio, actor) });
  res.json({ ok: true, status: r.status });
};

/** POST /api/logistics/shipments/:id/label — gera etiqueta (idempotente). */
export const gerarEtiquetaRota = async (req: Request, res: Response): Promise<void> => {
  const actor = exigirGestao(req);
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  const envio = assertRegistroDaEmpresa(getResource('envios')!, await s.get(getResource('envios')!, id), escopo);
  const empresaId = Number(envio.empresa_id);
  const chave = String((req.body?.idempotency_key as string) || req.header('idempotency-key') || `label:envio:${id}`).slice(0, 120);
  const r = await gerarEtiqueta(empresaId, id, chave, actor.id ?? null);
  res.status(r.ok ? 201 : 200).json({ ok: r.ok, idempotente: r.idempotente, etiqueta: r.etiqueta, motivo: r.motivo ?? null });
};

/** POST /api/logistics/shipments/:id/track — polling imediato do rastreio. */
export const rastrearRemessa = async (req: Request, res: Response): Promise<void> => {
  exigirGestao(req);
  const escopo = escopoDoAtor(currentUser(req));
  const id = parseId(req.params.id);
  const s = getStore();
  const envio = assertRegistroDaEmpresa(getResource('envios')!, await s.get(getResource('envios')!, id), escopo);
  const empresaId = Number(envio.empresa_id);
  const adapter = carrier(String(envio.provider));
  if (!adapter) throw new HttpError(404, 'Operador da remessa não está registrado.');
  const r = await sincronizarRastreio(empresaId, id, adapter);
  if (!r.ok) throw new HttpError(502, r.motivo || 'Falha ao consultar o operador.', { provedor: adapter.slug });
  res.json({ ok: true, gravados: r.gravados, ignorados: r.ignorados, status: r.statusFinal });
};

/** POST /api/logistics/shipments/:id/publish-tracking — enfileira publicação na loja. */
export const publicarRastreioRota = async (req: Request, res: Response): Promise<void> => {
  exigirGestao(req);
  const escopo = escopoDoAtor(currentUser(req));
  const id = parseId(req.params.id);
  const s = getStore();
  const envio = assertRegistroDaEmpresa(getResource('envios')!, await s.get(getResource('envios')!, id), escopo);
  const empresaId = Number(envio.empresa_id);
  const evento = await enfileirarRastreioLoja(empresaId, id);
  if (!evento) throw new HttpError(409, 'Esta remessa não está associada a uma loja WooCommerce (ou a loja não está configurada para esta empresa).');
  res.json({ ok: true, enfileirado: true, outbox_id: Number(evento.id) });
};

// ----------------------------------------------------------------------------
// WEBHOOKS (inbox)
// ----------------------------------------------------------------------------
/** GET /api/logistics/webhooks — entregas recebidas (inbox). */
export const listarWebhooks = async (req: Request, res: Response): Promise<void> => {
  exigirGestao(req);
  const empresaId = empresaDoAtor(req);
  const provider = req.query.provider ? String(req.query.provider) : undefined;
  const status = req.query.status ? String(req.query.status) : undefined;
  const entregas = await listarEntregas(empresaId, { provider, status });
  res.json({ entregas, contagem: contarEntregas(entregas) });
};

/** POST /api/logistics/webhooks/:id/reprocessar — re-enfileira uma entrega. */
export const reprocessarWebhook = async (req: Request, res: Response): Promise<void> => {
  const actor = exigirGestao(req);
  const empresaId = empresaDoAtor(req);
  const id = parseId(req.params.id);
  const ok = await reenfileirarEntrega(empresaId, id);
  if (!ok) throw new HttpError(404, 'Entrega de webhook não encontrada.');
  await auditarLogistica({ empresaId, entidade: 'webhook', entidadeId: id, acao: 'reprocessar', descricao: `Entrega #${id} re-enfileirada`, usuarioId: actor.id });
  res.json({ ok: true });
};

/** POST /api/logistics/webhooks/recuperar — recupera entregas presas. */
export const recuperarWebhooks = async (req: Request, res: Response): Promise<void> => {
  exigirGestao(req);
  const empresaId = empresaDoAtor(req);
  const r = await recuperarEntregasPendentes(empresaId);
  res.json({ ok: true, ...r });
};

// ----------------------------------------------------------------------------
// RECONCILIAÇÃO
// ----------------------------------------------------------------------------
/** POST /api/logistics/reconcile — reconcilia e corrige apenas as automáticas. */
export const reconciliarRota = async (req: Request, res: Response): Promise<void> => {
  exigirGestao(req);
  const empresaId = empresaDoAtor(req);
  const limite = Math.min(200, Number(req.body?.limite) || 50);
  const r = await reconciliarEmpresa(empresaId, limite);
  res.json({ ok: true, analisados: r.analisados, corrigidas: r.corrigidas, requer_humano: r.requerHumano, divergencias: r.divergencias });
};

// ----------------------------------------------------------------------------
// PAINEL
// ----------------------------------------------------------------------------
/** GET /api/logistics/painel — indicadores operacionais. */
export const painelLogistica = async (req: Request, res: Response): Promise<void> => {
  exigirGestao(req);
  const empresaId = empresaDoAtor(req);
  const store = lojaOpcional(req.query.store);
  res.setHeader('Cache-Control', 'private, no-store');
  const dados = await coletarIndicadores(empresaId, store);
  res.json(dados);
};

// ----------------------------------------------------------------------------
// MONTAGEM
// ----------------------------------------------------------------------------
logisticsRouter.get('/providers', wrap(listarProviders));
logisticsRouter.put('/providers/:slug', wrap(salvarProvider));
logisticsRouter.post('/providers/:slug/health', wrap(healthProvider));
logisticsRouter.get('/rules', wrap(listarRegras));
logisticsRouter.post('/rules', wrap(criarRegra));
logisticsRouter.put('/rules/:id', wrap(atualizarRegra));
logisticsRouter.post('/quote', wrap(cotarVenda));
logisticsRouter.get('/shipments', wrap(listarRemessas));
logisticsRouter.post('/shipments', wrap(criarRemessaRota));
logisticsRouter.get('/shipments/:id', wrap(detalharRemessa));
logisticsRouter.post('/shipments/:id/status', wrap(avancarStatusRota));
logisticsRouter.post('/shipments/:id/label', wrap(gerarEtiquetaRota));
logisticsRouter.post('/shipments/:id/track', wrap(rastrearRemessa));
logisticsRouter.post('/shipments/:id/publish-tracking', wrap(publicarRastreioRota));
logisticsRouter.get('/webhooks', wrap(listarWebhooks));
logisticsRouter.post('/webhooks/:id/reprocessar', wrap(reprocessarWebhook));
logisticsRouter.post('/webhooks/recuperar', wrap(recuperarWebhooks));
logisticsRouter.post('/reconcile', wrap(reconciliarRota));
logisticsRouter.get('/painel', wrap(painelLogistica));
