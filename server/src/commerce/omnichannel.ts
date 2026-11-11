// ============================================================================
// COMMERCE & OMNICHANNEL (FASE 6) — RECONCILIAÇÃO MULTICANAL UNIFICADA.
//
// Este módulo é a camada de LEITURA e CONCILIAÇÃO do núcleo comercial: ele
// responde "quais divergências existem agora, em QUALQUER canal, por empresa,
// com gravidade e ação recomendada?". NÃO é um segundo motor comercial:
//
//   • reusa os documentos canônicos do ERP (`commerce_publicacoes`,
//     `commerce_precos`, `commerce_pedidos`, `commerce_produtos`,
//     `commerce_outbox`, `estoques` via o mecanismo canônico);
//   • NÃO sobrescreve dado canônico: a divergência é PROVA, não fonte de
//     verdade. A classificação AUTOMATICA diz que a correção é SEGURA, não que
//     ela já foi feita;
//   • reusa a reconciliação ERP × loja do WooCommerce (migração 0101) — as
//     divergências dela são AGRUPADAS no painel, não recalculadas aqui.
//
// Multiempresa: toda função exige `empresaId` e recorta por ele. Nada cruza
// empresa. A identidade lógica da divergência é o `fingerprint` (UNIQUE por
// empresa): a mesma ocorrência reabre quando volta a existir, em vez de
// empilhar linhas — e o que deixou de ser detectado é fechado como CORRIGIDA.
// ============================================================================
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { currentUser } from '../auth';
import { escopoDoAtor, escopoDeSistema } from '../empresa';
import { HttpError } from '../errors';
import { getResource } from '../resources';
import { checkAccess, getStore } from '../services';
import { disponibilidadesPorTamanho } from './catalogo';
import type { Row, Tx } from '../store';

type S = ReturnType<typeof getStore>;

/** Canais do núcleo comercial. O vocabulário é o MESMO de `commerce_publicacoes`. */
export const CANAIS_OMNICHANNEL = [
  'BROBOND',
  'MERCADOLIVRE',
  'NUVEMSHOP',
  'WOOCOMMERCE',
  'INSTAGRAM_SHOPPING',
  'MERCADOPAGO',
] as const;
export type CanalOmni = (typeof CANAIS_OMNICHANNEL)[number];

export const CATEGORIAS_OMNI = ['CATALOGO', 'PRECO', 'ESTOQUE', 'PEDIDOS', 'CONECTOR'] as const;
export type CategoriaOmni = (typeof CATEGORIAS_OMNI)[number];

export const CLASSIFICACOES_OMNI = ['LEGITIMA', 'AUTOMATICA', 'HUMANA'] as const;
export type ClassificacaoOmni = (typeof CLASSIFICACOES_OMNI)[number];

export const SEVERIDADES_OMNI = ['baixa', 'media', 'alta', 'critica'] as const;
export type SeveridadeOmni = (typeof SEVERIDADES_OMNI)[number];

const RANK_SEVERIDADE: Record<SeveridadeOmni, number> = { baixa: 0, media: 1, alta: 2, critica: 3 };

export type DivergenciaOmni = {
  canal: CanalOmni;
  store_key?: string | null;
  categoria: CategoriaOmni;
  tipo: string;
  classificacao: ClassificacaoOmni;
  severidade: SeveridadeOmni;
  produto_id?: number | null;
  sku?: string | null;
  referencia?: string | null;
  detalhe: string;
  acao_recomendada?: string | null;
  dados?: Record<string, unknown> | null;
};

/** Identidade lógica da divergência — estável entre execuções. */
export function fingerprintOmni(d: DivergenciaOmni): string {
  const chave = [
    d.canal,
    d.store_key ?? '',
    d.categoria,
    d.tipo,
    d.produto_id ?? '',
    d.sku ?? '',
    d.referencia ?? '',
  ].join('|');
  return createHash('sha256').update(chave).digest('hex').slice(0, 48);
}

const R_RECONCILIACAO = () => getResource('commerce_reconciliacao')!;

function chaveFingerprint(d: DivergenciaOmni): string {
  return fingerprintOmni(d);
}

// ----------------------------------------------------------------------------
// DETECÇÃO — compara o que o ERP TEM com o que o canal REGISTRA.
//
// A leitura externa (chamar a loja) NÃO acontece aqui: sem credencial
// homologada, o ERP não pode afirmar o estado do canal. O que este reconciliador
// detecta são divergências OBSERVÁVEIS no próprio registro operacional do ERP —
// publicação que falhou, pedido que entrou em erro, estoque zerado ainda
// publicado, produto publicado sem preço vendável. É honesto: cada linha
// aponta para um documento real que pode ser conferido na tela.
// ----------------------------------------------------------------------------
async function listarTudo(s: S, key: string, empresaId: number, filtro: Record<string, unknown> = {}, tx?: Tx): Promise<Row[]> {
  const r = getResource(key)!;
  const p = await s.list(r, { page: 1, pageSize: 50_000, filter: { ...filtro, empresa_id: empresaId } }, tx);
  return p.rows;
}

/**
 * Disponibilidade VENDÁVEL canônica de um produto (físico − reservado/empenhado/bloqueado).
 * Devolve `null` quando a empresa ainda não tem local de estoque ativo — nesse
 * caso o saldo é INDETERMINADO (a empresa está em configuração) e a detecção de
 * estoque é pulada, em vez de gerar divergência falsa ou abortar a rodada.
 */
async function disponibilidadeDoProduto(empresaId: number, produtoId: number, tx?: Tx): Promise<number | null> {
  try {
    const linhas = await disponibilidadesPorTamanho(escopoDeSistema(empresaId), produtoId, tx);
    return linhas.reduce((acc, l) => acc + Math.max(0, Number(l.disponivel || 0)), 0);
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) return null;
    throw e;
  }
}

/**
 * Detecta as divergências do núcleo comercial para uma empresa. Pura leitura:
 * NÃO escreve nada e NÃO chama rede. O resultado é determinístico para o mesmo
 * estado do banco (o que permite fechar/reabrir por fingerprint).
 */
export async function detectarDivergencias(s: S, empresaId: number, tx?: Tx): Promise<DivergenciaOmni[]> {
  const divergencias: DivergenciaOmni[] = [];
  const agora = Date.now();
  const LIMITE_PUBLICACAO_TRAVADA_MS = 24 * 60 * 60 * 1000;

  const publicacoes = await listarTudo(s, 'commerce_publicacoes', empresaId, {}, tx);
  const produtos = await listarTudo(s, 'produtos', empresaId, {}, tx);
  const precos = await listarTudo(s, 'commerce_precos', empresaId, {}, tx);
  const pedidos = await listarTudo(s, 'commerce_pedidos', empresaId, {}, tx);
  const outbox = await listarTudo(s, 'commerce_outbox', empresaId, {}, tx);
  const vitrines = await listarTudo(s, 'commerce_produtos', empresaId, {}, tx);

  const produtoPorId = new Map(produtos.map((p) => [Number(p.id), p]));
  const vitrinePorProduto = new Set(vitrines.map((v) => Number(v.produto_id)));
  const precoPorChave = new Set(precos.map((p) => `${Number(p.produto_id)}|${String(p.canal)}`));

  // --- CONECTOR: evento da fila que precisa de gente ---------------------------
  // Só ERRO é falha técnica definitiva. BLOQUEADO é PENDÊNCIA DE CONFIGURAÇÃO
  // (SMTP/Meta ausente) e OBSOLETO é aviso sem efeito — nenhum dos dois é
  // "falha de sincronização". O painel precisa dizer a verdade de cada um.
  for (const o of outbox) {
    const estado = String(o.estado || '').toUpperCase();
    if (estado === 'OBSOLETO') continue; // encerrado com trilha: não é pendência
    const referencia = String(o.chave || o.id);
    const dados = { tipo: o.tipo ?? null, tentativas: Number(o.tentativas || 0), ultimo_erro: o.ultimo_erro ?? null };
    if (estado === 'BLOQUEADO') {
      divergencias.push({
        canal: 'BROBOND', categoria: 'CONECTOR', tipo: 'outbox_bloqueado',
        classificacao: 'HUMANA', severidade: 'media', referencia,
        detalhe: `Evento da fila "${String(o.tipo || '')}" aguarda CONFIGURAÇÃO do provedor de notificação (não é falha de sincronização).`,
        acao_recomendada: 'Definir as variáveis do canal (SMTP/WhatsApp) e reconciliar a fila; o evento volta sozinho.',
        dados,
      });
      continue;
    }
    if (estado !== 'ERRO' && estado !== 'FALHA') continue;
    divergencias.push({
      canal: 'BROBOND',
      categoria: 'CONECTOR',
      tipo: 'outbox_erro',
      classificacao: 'HUMANA',
      severidade: 'alta',
      referencia,
      detalhe: `Evento da fila "${String(o.tipo || '')}" em ERRO após ${Number(o.tentativas || 0)} tentativa(s).`,
      acao_recomendada: 'Conferir o último erro do evento e reprocessar pela fila.',
      dados,
    });
  }

  // --- CATALOGO: publicação com erro / rejeitada / travada -------------------
  for (const pub of publicacoes) {
    const estado = String(pub.estado || '').toUpperCase();
    const canal = String(pub.canal || '') as CanalOmni;
    const produtoId = pub.produto_id == null ? null : Number(pub.produto_id);
    const produto = produtoId == null ? null : produtoPorId.get(produtoId);
    const sku = produto ? (produto.sku == null ? null : String(produto.sku)) : null;
    const base = { canal, categoria: 'CATALOGO' as const, produto_id: produtoId, sku };

    if (estado === 'REJECTED') {
      divergencias.push({
        ...base, tipo: 'publicacao_rejeitada', classificacao: 'HUMANA', severidade: 'alta',
        referencia: String(pub.id),
        detalhe: `Publicação rejeitada pelo canal ${canal}.`,
        acao_recomendada: 'Revisar o payload e corrigir o motivo da rejeição antes de republicar.',
        dados: { ultimo_erro: pub.ultimo_erro ?? null, versao: Number(pub.versao || 0) },
      });
    } else if (estado === 'ERROR') {
      divergencias.push({
        ...base, tipo: 'publicacao_erro', classificacao: 'HUMANA', severidade: 'alta',
        referencia: String(pub.id),
        detalhe: `Publicação em erro no canal ${canal}.`,
        acao_recomendada: 'Conferir o erro e reprocessar a publicação.',
        dados: { ultimo_erro: pub.ultimo_erro ?? null, tentativas: Number(pub.tentativas || 0) },
      });
    } else if (['QUEUED', 'PUBLISHING', 'UPDATE_QUEUED'].includes(estado)) {
      const ref = pub.atualizado_em ?? pub.criado_em;
      const t = ref ? new Date(String(ref)).getTime() : NaN;
      if (!Number.isNaN(t) && agora - t > LIMITE_PUBLICACAO_TRAVADA_MS) {
        divergencias.push({
          ...base, tipo: 'publicacao_travada', classificacao: 'AUTOMATICA', severidade: 'media',
          referencia: String(pub.id),
          detalhe: `Publicação presa em "${estado}" há mais de 24h no canal ${canal}.`,
          acao_recomendada: 'Reenfileirar a publicação (operação idempotente).',
          dados: { estado, versao: Number(pub.versao || 0) },
        });
      }
    }

    // PRECO: publicado no canal, mas sem preço vendável no ERP (nem override).
    if (estado === 'PUBLISHED' && produtoId != null) {
      const temOverride = precoPorChave.has(`${produtoId}|${canal}`);
      const precoErp = Number(produto?.preco_venda || 0);
      if (!temOverride && precoErp <= 0) {
        divergencias.push({
          canal, categoria: 'PRECO', tipo: 'preco_indisponivel', classificacao: 'HUMANA', severidade: 'alta',
          produto_id: produtoId, sku, referencia: String(pub.id),
          detalhe: `Produto publicado no canal ${canal} sem preço vendável (ERP e override vazios).`,
          acao_recomendada: 'Definir o preço de venda no ERP ou um override por canal.',
          dados: { preco_venda: precoErp, override: false },
        });
      }
    }
  }

  // --- CATALOGO: produto publicado no site sem vitrine -----------------------
  const canaisPublicadosPorProduto = new Map<number, Set<string>>();
  for (const pub of publicacoes) {
    if (String(pub.estado || '').toUpperCase() !== 'PUBLISHED') continue;
    const pid = Number(pub.produto_id);
    if (!pid) continue;
    if (!canaisPublicadosPorProduto.has(pid)) canaisPublicadosPorProduto.set(pid, new Set());
    canaisPublicadosPorProduto.get(pid)!.add(String(pub.canal || ''));
  }
  for (const [pid, canais] of canaisPublicadosPorProduto) {
    if (canais.has('BROBOND') && !vitrinePorProduto.has(pid)) {
      const produto = produtoPorId.get(pid);
      divergencias.push({
        canal: 'BROBOND', categoria: 'CATALOGO', tipo: 'vitrine_ausente', classificacao: 'AUTOMATICA', severidade: 'media',
        produto_id: pid, sku: produto ? (produto.sku == null ? null : String(produto.sku)) : null, referencia: null,
        detalhe: 'Produto publicado no site próprio sem registro de vitrine.',
        acao_recomendada: 'Regenerar a vitrine do produto (operação idempotente).',
        dados: { produto_id: pid },
      });
    }
  }

  // --- ESTOQUE: produto publicado no canal com estoque zerado ----------------
  for (const [pid, canais] of canaisPublicadosPorProduto) {
    const disponivel = await disponibilidadeDoProduto(empresaId, pid, tx);
    if (disponivel === null || disponivel > 0) continue; // sem local de estoque o saldo é indeterminado
    const produto = produtoPorId.get(pid);
    if (produto && String(produto.ativo) === 'false') continue; // inativo é outra história
    for (const canal of canais) {
      divergencias.push({
        canal: canal as CanalOmni, categoria: 'ESTOQUE', tipo: 'estoque_zerado_publicado', classificacao: 'LEGITIMA', severidade: 'baixa',
        produto_id: pid, sku: produto ? (produto.sku == null ? null : String(produto.sku)) : null, referencia: null,
        detalhe: `Produto publicado no canal ${canal} com estoque disponível zerado.`,
        acao_recomendada: 'Repor estoque ou despublicar; a loja mostrará o produto sem estoque.',
        dados: { disponivel },
      });
    }
  }

  // --- PEDIDOS: pedido em erro ou expirado sem fechamento --------------------
  for (const p of pedidos) {
    const estado = String(p.estado || '').toUpperCase();
    const canal = String(p.canal || '') as CanalOmni;
    const pedidoExterno = p.pedido_externo == null ? null : String(p.pedido_externo);
    if (estado === 'ERRO' || estado === 'AGUARDANDO_CORRECAO') {
      divergencias.push({
        canal, categoria: 'PEDIDOS', tipo: 'pedido_erro', classificacao: 'HUMANA', severidade: 'alta',
        referencia: pedidoExterno,
        detalhe: `Pedido externo em "${estado}" no canal ${canal}.`,
        acao_recomendada: 'Conferir o motivo e corrigir o pedido antes de reprocessar.',
        dados: { erro: p.erro ?? null, estado },
      });
    } else if (estado === 'AGUARDANDO_PAGAMENTO' && p.expira_em) {
      const t = new Date(String(p.expira_em)).getTime();
      if (!Number.isNaN(t) && t < agora) {
        divergencias.push({
          canal, categoria: 'PEDIDOS', tipo: 'pedido_expirado_nao_fechado', classificacao: 'AUTOMATICA', severidade: 'media',
          referencia: pedidoExterno,
          detalhe: 'Pedido com pagamento expirado e ainda aguardando pagamento.',
          acao_recomendada: 'Transicionar o pedido para EXPIRADO (transição de estado idempotente).',
          dados: { expira_em: String(p.expira_em) },
        });
      }
    }
  }

  return divergencias;
}

// ----------------------------------------------------------------------------
// PERSISTÊNCIA — idempotente por fingerprint (reabre; nunca empilha).
// ----------------------------------------------------------------------------
async function registrarDivergencia(s: S, empresaId: number, d: DivergenciaOmni, tx?: Tx): Promise<'aberta' | 'reaberta' | 'mantida'> {
  const fingerprint = chaveFingerprint(d);
  const existente = await s.findOneWhere(R_RECONCILIACAO(), { empresa_id: empresaId, fingerprint }, tx);
  const base: Record<string, unknown> = {
    empresa_id: empresaId,
    canal: d.canal,
    store_key: d.store_key ?? null,
    categoria: d.categoria,
    tipo: d.tipo,
    classificacao: d.classificacao,
    severidade: d.severidade,
    produto_id: d.produto_id ?? null,
    sku: d.sku ?? null,
    referencia: d.referencia ?? null,
    detalhe: d.detalhe.slice(0, 1000),
    acao_recomendada: d.acao_recomendada ? d.acao_recomendada.slice(0, 500) : null,
    dados: d.dados ?? null,
    fingerprint,
    atualizado_em: new Date().toISOString(),
  };
  if (!existente) {
    await s.insert(R_RECONCILIACAO(), { ...base, status: 'ABERTA' }, tx);
    return 'aberta';
  }
  const status = String(existente.status || 'ABERTA');
  if (status === 'ABERTA') {
    // Atualiza o detalhe (o mesmo fingerprint pode ganhar informação nova).
    await s.update(R_RECONCILIACAO(), Number(existente.id), base, tx);
    return 'mantida';
  }
  // CORRIGIDA/IGNORADA que voltou a existir: reabre (a correção não pode esconder recaída).
  await s.update(R_RECONCILIACAO(), Number(existente.id), { ...base, status: 'ABERTA', resolucao: null, resolvida_em: null }, tx);
  return 'reaberta';
}

/**
 * Fecha as divergências abertas que NÃO foram detectadas nesta rodada. É o que
 * mantém o painel honesto: o que deixou de existir não fica aberto para sempre.
 * Respeita o canal informado para não fechar divergências de um canal que não
 * foi reconciliado nesta execução.
 */
export async function fecharDivergenciasAusentes(
  s: S,
  empresaId: number,
  canal: CanalOmni,
  fingerprintsDetectados: Set<string>,
  tx?: Tx
): Promise<number> {
  const abertas = await listarTudo(s, 'commerce_reconciliacao', empresaId, { canal, status: 'ABERTA' }, tx);
  let fechadas = 0;
  for (const a of abertas) {
    if (fingerprintsDetectados.has(String(a.fingerprint))) continue;
    await s.update(R_RECONCILIACAO(), Number(a.id), { status: 'CORRIGIDA', resolvida_em: new Date().toISOString(), resolucao: 'Deixou de ser detectada na reconciliação.' }, tx);
    fechadas++;
  }
  return fechadas;
}

export type ResultadoReconciliacaoOmni = {
  empresa_id: number;
  canais: CanalOmni[];
  detectadas: number;
  abertas: number;
  reabertas: number;
  mantidas: number;
  fechadas: number;
  por_canal: Record<string, number>;
  por_categoria: Record<string, number>;
  por_severidade: Record<string, number>;
  gerado_em: string;
};

/**
 * Roda a reconciliação multicanal da empresa: detecta, persiste (idempotente),
 * fecha o que deixou de existir e audita. NÃO altera nenhum dado canônico.
 */
export async function reconciliarOmnichannel(
  empresaId: number,
  opts: { canais?: readonly CanalOmni[]; ator?: { id?: number | null; name?: string | null } } = {}
): Promise<ResultadoReconciliacaoOmni> {
  const s = getStore();
  const canais = opts.canais ?? CANAIS_OMNICHANNEL;
  const detectadas = await detectarDivergencias(s, empresaId);
  const alvo = detectadas.filter((d) => canais.includes(d.canal));

  const porCanal: Record<string, number> = {};
  const porCategoria: Record<string, number> = {};
  const porSeveridade: Record<string, number> = {};
  let abertas = 0;
  let reabertas = 0;
  let mantidas = 0;

  const resultado = await s.transaction(async (tx) => {
    const vistos = new Set<string>();
    for (const d of alvo) {
      vistos.add(chaveFingerprint(d));
      const r = await registrarDivergencia(s, empresaId, d, tx);
      if (r === 'aberta') abertas++;
      else if (r === 'reaberta') reabertas++;
      else mantidas++;
      porCanal[d.canal] = (porCanal[d.canal] || 0) + 1;
      porCategoria[d.categoria] = (porCategoria[d.categoria] || 0) + 1;
      porSeveridade[d.severidade] = (porSeveridade[d.severidade] || 0) + 1;
    }
    let fechadas = 0;
    for (const canal of canais) {
      fechadas += await fecharDivergenciasAusentes(s, empresaId, canal, vistos, tx);
    }
    await s.audit({
      empresa_id: empresaId, usuario_id: opts.ator?.id ?? null, usuario: opts.ator?.name ?? null,
      acao: 'ajuste', recurso: 'commerce_reconciliacao', registro_id: null,
      descricao: 'Reconciliação multicanal executada',
      dados: { detectadas: alvo.length, abertas, reabertas, mantidas, fechadas, canais },
    }, tx);
    return { abertas, reabertas, mantidas, fechadas };
  });

  return {
    empresa_id: empresaId,
    canais: [...canais],
    detectadas: alvo.length,
    abertas: resultado.abertas,
    reabertas: resultado.reabertas,
    mantidas: resultado.mantidas,
    fechadas: resultado.fechadas,
    por_canal: porCanal,
    por_categoria: porCategoria,
    por_severidade: porSeveridade,
    gerado_em: new Date().toISOString(),
  };
}

// ----------------------------------------------------------------------------
// PAINEL OPERACIONAL — visão agregada, sem recalcular (lê o que foi persistido).
// ----------------------------------------------------------------------------
export type FiltrosPainelOmni = {
  canal?: CanalOmni | null;
  categoria?: CategoriaOmni | null;
  severidade?: SeveridadeOmni | null;
  status?: string | null;
};

export type PainelOmnichannel = {
  empresa_id: number;
  filtros: FiltrosPainelOmni;
  totais: { abertas: number; por_categoria: Record<string, number>; por_canal: Record<string, number>; por_severidade: Record<string, number> };
  /** Divergências do registro multicanal (ERP × estado registrado). */
  divergencias: Array<Record<string, unknown>>;
  /** Divergências do WooCommerce multi-loja (migração 0101), agrupadas por loja. */
  woocommerce_lojas: Array<{ store_key: string; abertas: number; por_categoria: Record<string, number> }>;
  saude_conectores: Array<{ canal: string; divergencias_abertas: number; pior_severidade: SeveridadeOmni | null; outbox_pendente: number; outbox_erro: number; outbox_bloqueado: number; outbox_obsoleto: number; ultimo_erro: string | null }>;
  gerado_em: string;
};

function piorSeveridade(sevs: SeveridadeOmni[]): SeveridadeOmni | null {
  if (!sevs.length) return null;
  return sevs.reduce((a, b) => (RANK_SEVERIDADE[a] >= RANK_SEVERIDADE[b] ? a : b));
}

/** Monta o painel operacional de sincronização multicanal. */
export async function painelOmnichannel(empresaId: number, filtros: FiltrosPainelOmni = {}): Promise<PainelOmnichannel> {
  const s = getStore();
  const todas = await listarTudo(s, 'commerce_reconciliacao', empresaId, {});
  const abertas = todas.filter((d) => String(d.status || 'ABERTA') === 'ABERTA');

  const porCategoria: Record<string, number> = {};
  const porCanal: Record<string, number> = {};
  const porSeveridade: Record<string, number> = {};
  for (const d of abertas) {
    porCategoria[String(d.categoria)] = (porCategoria[String(d.categoria)] || 0) + 1;
    porCanal[String(d.canal)] = (porCanal[String(d.canal)] || 0) + 1;
    porSeveridade[String(d.severidade)] = (porSeveridade[String(d.severidade)] || 0) + 1;
  }

  const filtradas = abertas
    .filter((d) => !filtros.canal || String(d.canal) === filtros.canal)
    .filter((d) => !filtros.categoria || String(d.categoria) === filtros.categoria)
    .filter((d) => !filtros.severidade || String(d.severidade) === filtros.severidade)
    .sort((a, b) => RANK_SEVERIDADE[(String(b.severidade) as SeveridadeOmni)] - RANK_SEVERIDADE[(String(a.severidade) as SeveridadeOmni)]);

  // WooCommerce multi-loja: agrega as divergências da 0101 (reuso, não recálculo).
  const wooDivergencias = await listarTudo(s, 'woocommerce_reconciliacao_divergencias', empresaId, { status: 'ABERTA' }).catch(() => []);
  const wooPorLoja = new Map<string, { store_key: string; abertas: number; por_categoria: Record<string, number> }>();
  for (const d of wooDivergencias) {
    const store = String(d.store_key || 'RETAIL');
    if (!wooPorLoja.has(store)) wooPorLoja.set(store, { store_key: store, abertas: 0, por_categoria: {} });
    const acc = wooPorLoja.get(store)!;
    acc.abertas++;
    acc.por_categoria[String(d.categoria)] = (acc.por_categoria[String(d.categoria)] || 0) + 1;
  }

  // Saúde por conector: divergências abertas + estado da fila.
  // A fila é desdobrada em três leituras honestas — PENDENTE/PROCESSANDO
  // (em curso), ERRO (falha técnica) e BLOQUEADO (configuração pendente).
  // OBSOLETO não entra: é histórico encerrado, não pendência.
  const outbox = await listarTudo(s, 'commerce_outbox', empresaId, {});
  const outboxPorCanal = new Map<string, { pendente: number; erro: number; bloqueado: number; obsoleto: number; ultimo_erro: string | null }>();
  for (const o of outbox) {
    const estado = String(o.estado || '').toUpperCase();
    const canal = 'BROBOND';
    if (!outboxPorCanal.has(canal)) outboxPorCanal.set(canal, { pendente: 0, erro: 0, bloqueado: 0, obsoleto: 0, ultimo_erro: null });
    const acc = outboxPorCanal.get(canal)!;
    if (estado === 'PENDENTE' || estado === 'PROCESSANDO') acc.pendente++;
    if (estado === 'ERRO' || estado === 'FALHA') {
      acc.erro++;
      if (!acc.ultimo_erro && o.ultimo_erro) acc.ultimo_erro = String(o.ultimo_erro).slice(0, 200);
    }
    if (estado === 'BLOQUEADO') acc.bloqueado++;
    if (estado === 'OBSOLETO') acc.obsoleto++;
  }
  const saudeConectores = CANAIS_OMNICHANNEL.map((canal) => {
    const doCanal = abertas.filter((d) => String(d.canal) === canal);
    const fila = outboxPorCanal.get(canal);
    return {
      canal,
      divergencias_abertas: doCanal.length,
      pior_severidade: piorSeveridade(doCanal.map((d) => String(d.severidade) as SeveridadeOmni)),
      outbox_pendente: fila?.pendente ?? 0,
      outbox_erro: fila?.erro ?? 0,
      outbox_bloqueado: fila?.bloqueado ?? 0,
      outbox_obsoleto: fila?.obsoleto ?? 0,
      ultimo_erro: fila?.ultimo_erro ?? null,
    };
  });

  return {
    empresa_id: empresaId,
    filtros,
    totais: { abertas: abertas.length, por_categoria: porCategoria, por_canal: porCanal, por_severidade: porSeveridade },
    divergencias: filtradas.slice(0, 500).map((d) => ({
      id: Number(d.id),
      canal: String(d.canal || ''),
      store_key: d.store_key ? String(d.store_key) : null,
      categoria: String(d.categoria || ''),
      tipo: String(d.tipo || ''),
      classificacao: String(d.classificacao || ''),
      severidade: String(d.severidade || ''),
      produto_id: d.produto_id == null ? null : Number(d.produto_id),
      sku: d.sku ? String(d.sku) : null,
      referencia: d.referencia ? String(d.referencia) : null,
      detalhe: String(d.detalhe || ''),
      acao_recomendada: d.acao_recomendada ? String(d.acao_recomendada) : null,
      detectada_em: d.detectada_em ? String(d.detectada_em) : null,
    })),
    woocommerce_lojas: [...wooPorLoja.values()],
    saude_conectores: saudeConectores,
    gerado_em: new Date().toISOString(),
  };
}

// ----------------------------------------------------------------------------
// HANDLERS HTTP (montados em index.ts)
// ----------------------------------------------------------------------------
function escopoDe(req: Request) {
  return escopoDoAtor(currentUser(req));
}

/** POST /api/commerce/omnichannel/reconciliar — roda a reconciliação multicanal. */
export async function reconciliarOmnichannelHandler(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('commerce_reconciliacao')!, actor, 'read');
  const escopo = escopoDe(req);
  const body = (req.body ?? {}) as Row;
  const canaisBrutos = body.canais;
  let canais: readonly CanalOmni[] | undefined;
  if (Array.isArray(canaisBrutos) && canaisBrutos.length) {
    canais = canaisBrutos.map((c) => {
      const v = String(c).toUpperCase() as CanalOmni;
      if (!CANAIS_OMNICHANNEL.includes(v)) throw new HttpError(400, `Canal inválido: ${c}.`, { canais: CANAIS_OMNICHANNEL });
      return v;
    });
  }
  const resultado = await reconciliarOmnichannel(escopo.empresaId, { canais, ator: { id: actor.id ?? null, name: actor.name ?? null } });
  res.status(201).json(resultado);
}

/** GET /api/commerce/omnichannel/painel — painel operacional de sincronização. */
export async function painelOmnichannelHandler(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('commerce_reconciliacao')!, actor, 'read');
  const escopo = escopoDe(req);
  const q = req.query;
  const canal = q.canal ? (String(q.canal).toUpperCase() as CanalOmni) : null;
  if (canal && !CANAIS_OMNICHANNEL.includes(canal)) throw new HttpError(400, 'Canal inválido.', { canais: CANAIS_OMNICHANNEL });
  const categoria = q.categoria ? (String(q.categoria).toUpperCase() as CategoriaOmni) : null;
  if (categoria && !CATEGORIAS_OMNI.includes(categoria)) throw new HttpError(400, 'Categoria inválida.', { categorias: CATEGORIAS_OMNI });
  const severidade = q.severidade ? (String(q.severidade).toLowerCase() as SeveridadeOmni) : null;
  if (severidade && !SEVERIDADES_OMNI.includes(severidade)) throw new HttpError(400, 'Severidade inválida.', { severidades: SEVERIDADES_OMNI });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(await painelOmnichannel(escopo.empresaId, { canal, categoria, severidade }));
}
