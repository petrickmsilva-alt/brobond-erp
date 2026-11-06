// ============================================================================
// COMMERCE OS — OUTBOX (fila de sincronização com retry e backoff).
//
// At-least-once com chave única (empresa, tipo, chave): o registro não é
// duplicado, mas uma entrega externa pode ser repetida. Processadores REAIS:
//   • conversao     → ponte sales → vendas (retentativa até o item casar);
//   • publicacao    → fila de publicação do canal;
//   • sincronizacao → entrega externa: estoque WooCommerce (env) e eventos
//                     transacionais de notificação (acao='notificacao');
//   • alerta        → log estruturado (falhas que precisam de gente).
// O claim é CAS (PENDENTE → PROCESSANDO): duas varreduras não processam a
// mesma entrada duas vezes; entrada presa há 10min volta para a fila.
// ============================================================================
import { getStore, checkAccess } from '../services';
import { query } from '../db';
import { currentUser } from '../auth';
import { escopoDoAtor } from '../empresa';
import { HttpError } from '../errors';
import type { Request, Response } from 'express';
import { getResource } from '../resources';
import { escopoDeSistema } from '../empresa';
import { MAX_TENTATIVAS, backoffMs } from './regras';
import { randomUUID } from 'node:crypto';
import { log } from '../log';
import type { Row, Tx } from '../store';
import { requireJobLease, withCronIdempotency, withOptionalJobLease } from '../cronLock';
import type { ProcessoCronLock } from '../cronLock';

const R_OUTBOX = () => getResource('commerce_outbox')!;

// FECHAMENTO DO CICLO: este conjunto é o MESMO aceito por TODA a cadeia de
// migrations (0068 cria o CHECK, 0090 o reaplica ao reconstruir o schema).
// Introduzir um novo `tipo` aqui exigiria alterar migrations JÁ APLICADAS e
// quebraria a reaplicação da cadeia em bancos com dados (o ADD CONSTRAINT da
// 0090 recusa linhas fora do conjunto). Por isso eventos de comunicação usam
// `sincronizacao` + `payload.acao='notificacao'`, que é uma entrega externa,
// sem criar um segundo outbox e sem mexer em migration existente.
export type TipoOutbox = 'conversao' | 'publicacao' | 'sincronizacao' | 'alerta' | 'refund_devolucao';

/**
 * Enfileira um trabalho (idempotente pela chave). Se já existe, mantém a
 * entrada — o payload mais novo só entra se a anterior ainda estiver pendente.
 */
export async function enfileirarOutbox(
  empresaId: number,
  tipo: TipoOutbox,
  chave: string,
  payload: Record<string, unknown>,
  tx?: Tx
): Promise<Row> {
  const s = getStore();
  const existente = await s.findOneWhere(R_OUTBOX(), { empresa_id: empresaId, tipo, chave }, tx);
  if (existente) {
    const estado = String(existente.estado);
    if (estado === 'PENDENTE' || estado === 'ERRO') {
      // Não sobrescreve uma entrada que foi reivindicada depois da leitura.
      const atualizada = await s.tryUpdateIf(R_OUTBOX(), Number(existente.id),
        { empresa_id: empresaId, estado, tentativas: existente.tentativas ?? 0 },
        { payload, estado: 'PENDENTE', ...(estado === 'ERRO' ? { tentativas: 0 } : {}),
          ultimo_erro: null, proxima_tentativa_em: new Date().toISOString() }, tx);
      if (atualizada) return atualizada;
      return (await s.findOneWhere(R_OUTBOX(), { empresa_id: empresaId, tipo, chave }, tx)) ?? existente;
    }
    return existente;
  }
  // ON CONFLICT não aborta a transação do pedido em concorrência (ao contrário
  // de capturar um 23505 depois de INSERT, que deixa o tx do PostgreSQL falho).
  if (s.kind === 'postgres') {
    const sql = `INSERT INTO commerce_outbox (empresa_id, tipo, chave, payload, estado, tentativas, proxima_tentativa_em)
      VALUES ($1, $2, $3, $4::jsonb, 'PENDENTE', 0, now())
      ON CONFLICT (empresa_id, tipo, chave) DO NOTHING RETURNING *`;
    const params = [empresaId, tipo, chave, JSON.stringify(payload)];
    const result = tx ? await tx.query(sql, params) : await query(sql, params);
    if (result.rows[0]) return result.rows[0];
    const outra = await s.findOneWhere(R_OUTBOX(), { empresa_id: empresaId, tipo, chave }, tx);
    if (outra) return outra;
    // Em isolamento SERIALIZABLE uma corrida pode exigir retry da transação.
    throw new Error('Conflito ao enfileirar evento; repita a transação.');
  }
  return s.insert(R_OUTBOX(), {
    empresa_id: empresaId, tipo, chave, payload, estado: 'PENDENTE', tentativas: 0,
    proxima_tentativa_em: new Date().toISOString(), criado_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
  }, tx);
}

type Desfecho = { status: 'processado' | 'retry' | 'erro'; erro?: string };

async function processarEntrada(row: Row): Promise<Desfecho> {
  const s = getStore();
  const empresaId = Number(row.empresa_id);
  const tipo = String(row.tipo);
  const payload = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>;

  if (tipo === 'refund_devolucao') {
    const { processarRefundDevolucao } = await import('../devolucaoRefund');
    await processarRefundDevolucao(empresaId, Number(payload.devolucao_id));
    return { status: 'processado' };
  }

  if (tipo === 'alerta') {
    console.error('[commerce:outbox:alerta]', { empresa_id: empresaId, event_id: Number(row.id) });
    return { status: 'processado' };
  }

  // Compatibilidade com linhas `notificacao` porventura gravadas por uma versão
  // anterior já implantada: mesmo despacho, sem exigir novo valor no CHECK.
  if (tipo === 'notificacao') {
    const { processarEventoNotificacao } = await import('./notificacoes');
    // empresa da LINHA prevalece sobre o payload (isolamento entre empresas).
    const r = await processarEventoNotificacao({ ...payload, empresa_id: empresaId });
    return r.status === 'retry' ? { status: 'retry', erro: r.erro } : { status: 'processado' };
  }

  if (tipo === 'conversao') {
    const { converterPedidoSale } = await import('./pedidos');
    const saleId = String(payload.sale_id || '');
    if (!saleId) return { status: 'erro', erro: 'Conversão sem sale_id.' };
    const r = await converterPedidoSale(empresaId, saleId);
    if (r.estado === 'CONVERTIDO') return { status: 'processado' };
    if (r.estado === 'AGUARDANDO_CORRECAO') {
      // espera pessoa casar o item — o motivo honesto fica visível na fila
      return { status: 'retry', erro: r.pendencia ?? 'Item sem correspondência de produto — corrija a venda e reprocesse.' };
    }
    return { status: 'processado' };
  }

  if (tipo === 'publicacao') {
    const { processarPublicacao } = await import('./catalogo');
    const publicacaoId = Number(payload.publicacao_id);
    if (!Number.isInteger(publicacaoId) || publicacaoId <= 0) return { status: 'erro', erro: 'Publicação sem identificador válido.' };
    const pub = await s.findOneWhere(getResource('commerce_publicacoes')!, { id: publicacaoId, empresa_id: empresaId });
    if (!pub) return { status: 'erro', erro: 'Publicação não encontrada na empresa do evento.' };
    const resultado = await processarPublicacao(pub);
    if (resultado === 'processada') return { status: 'processado' };
    const atual = await s.findOneWhere(getResource('commerce_publicacoes')!, { id: publicacaoId, empresa_id: empresaId });
    if (resultado === 'ignorada' && atual?.estado === 'PUBLISHED') return { status: 'processado' };
    if (resultado === 'rejeitada') return { status: 'erro', erro: String(atual?.ultimo_erro || 'Publicação rejeitada pelo canal.') };
    return { status: 'retry', erro: String(atual?.ultimo_erro || 'Publicação ainda não concluída.') };
  }

  if (tipo === 'sincronizacao') {
    const acao = String(payload.acao || '');
    if (acao === 'notificacao') {
      // NOTIFICATION ORCHESTRATOR: import dinâmico evita ciclo com o módulo que
      // enfileira eventos. O pedido NUNCA espera por este processamento.
      const { processarEventoNotificacao } = await import('./notificacoes');
      // empresa da LINHA prevalece sobre o payload (isolamento entre empresas).
      const r = await processarEventoNotificacao({ ...payload, empresa_id: empresaId });
      return r.status === 'retry' ? { status: 'retry', erro: r.erro } : { status: 'processado' };
    }
    if (acao === 'woo-estoque') {
      // MULTI-LOJA: o payload carrega `store_key`. A loja é resolvida pela
      // config DELA (nunca a global) e a falha de uma não toca a outra — o
      // desfecho é gravado no estado daquela loja.
      if (row.store_key != null || typeof payload.store_key === 'string') {
        const { processarEventoStore } = await import('./woocommerce/outboxStore');
        const r = await processarEventoStore(payload, empresaId);
        if (r === 'ignorado') return { status: 'erro', erro: 'Loja desconhecida ou desabilitada para este evento.' };
        console.log(`[commerce:outbox] estoque multi-loja processado (${String(payload.store_key)})`);
        return { status: 'processado' };
      }
      const { enviarEstoqueLojaInterno, configLoja, empresaVinculadaWoo } = await import('../loja');
      if (!configLoja()) {
        return { status: 'erro', erro: 'WooCommerce não configurado (WOOCOMMERCE_URL/CK/CS) — sincronização recusada sem site alvo.' };
      }
      if (empresaVinculadaWoo() !== empresaId) return { status: 'erro', erro: 'WooCommerce não vinculado à empresa do evento.' };
      const saida = await enviarEstoqueLojaInterno(escopoDeSistema(empresaId), { id: null, name: 'Commerce outbox' });
      if (saida.nao_encontrados.length) return { status: 'erro', erro: `${saida.nao_encontrados.length} SKU(s) sem correspondência na loja; revise o cadastro.` };
      console.log(
        `[commerce:outbox] estoque woo enviado (${saida.total_atualizados} SKUs, ${saida.nao_encontrados.length} sem correspondência)`
      );
      return { status: 'processado' };
    }
    if (acao === 'woo-pedidos' || acao === 'woo-publicacao') {
      const { processarEventoStore } = await import('./woocommerce/outboxStore');
      const r = await processarEventoStore(payload, empresaId);
      if (r === 'ignorado') return { status: 'erro', erro: 'Loja desconhecida ou desabilitada para este evento.' };
      return { status: 'processado' };
    }
    return { status: 'erro', erro: 'Ação de sincronização desconhecida.' };
  }

  return { status: 'erro', erro: `Tipo de evento desconhecido: ${tipo || '(vazio)'}` };

}

/**
 * Processa entradas vencidas com claim CAS. `limite` por rodada (o cron
 * chama de novo — a fila é a autoridade, não o agendador).
 */
/**
 * R-4 (Fase 4.3): cada processo do cron só drena os tipos de evento que lhe pertencem.
 * Evento de tipo fora do processo permanece na fila para o processo dono (sem perda, sem duplicidade).
 */
export const TIPOS_OUTBOX_POR_PROCESSO = {
  pagamentos: ['refund_devolucao'],
  publicacoes: ['publicacao'],
  pedidos: ['conversao', 'notificacao', 'alerta', 'sincronizacao'],
} as const;

function jobDosTipos(tipos?: readonly string[]): ProcessoCronLock | null {
  if (!tipos?.length) return null;
  const set = new Set(tipos);
  const jobs = (Object.entries(TIPOS_OUTBOX_POR_PROCESSO) as [ProcessoCronLock, readonly string[]][]).filter(([, lista]) => lista.some((t) => set.has(t)));
  return jobs.length === 1 ? jobs[0][0] : null;
}

export async function processarOutbox(limite = 10, tipos?: readonly string[]): Promise<{ processados: number; erros: number }> {
  const vazio = { processados: 0, erros: 0 };
  const job = jobDosTipos(tipos);
  if (job) {
    const r = await requireJobLease(job, () => executarProcessarOutbox(limite, tipos), { busy: 'retry' });
    return r.result ?? vazio;
  }
  let total = { processados: 0, erros: 0 };
  for (const [nome, lista] of Object.entries(TIPOS_OUTBOX_POR_PROCESSO) as [ProcessoCronLock, readonly string[]][]) {
    const r = await requireJobLease(nome, () => executarProcessarOutbox(limite, lista), { busy: 'retry' });
    if (r.result) {
      total = { processados: total.processados + r.result.processados, erros: total.erros + r.result.erros };
    }
  }
  return total;
}

async function executarProcessarOutbox(limite = 10, tipos?: readonly string[]): Promise<{ processados: number; erros: number }> {
  const s = getStore();
  // job_id correlaciona todas as linhas desta varredura; event_id identifica
  // cada entrada. Nem o payload nem o segredo da integração entram no log.
  const jobId = randomUUID();
  const inicio = Date.now();
  const capacidade = Math.max(1, Math.min(100, Math.trunc(limite) || 10));
  const agora = Date.now();
  let candidatas: Row[];
  if (s.kind === 'postgres') {
    // Filtrar antes de LIMIT evita que pendências futuras escondam trabalhos
    // vencidos. A fila é global somente para este worker de sistema.
    const result = await query(`SELECT * FROM commerce_outbox
      WHERE ((estado = 'PENDENTE' AND (proxima_tentativa_em IS NULL OR proxima_tentativa_em <= now()))
         OR (estado = 'PROCESSANDO' AND atualizado_em < now() - interval '10 minutes')
         OR (estado = 'INDETERMINADO' AND (proxima_tentativa_em IS NULL OR proxima_tentativa_em <= now())))
        AND ($2::text[] IS NULL OR tipo = ANY($2::text[]))
      ORDER BY COALESCE(proxima_tentativa_em, atualizado_em), id LIMIT $1`, [capacidade, tipos ? [...tipos] : null]);
    candidatas = result.rows;
  } else {
    const pendentes = await s.list(R_OUTBOX(), { page: 1, pageSize: 10000, filter: { estado: 'PENDENTE' }, sort: 'id', dir: 'asc' });
    const presas = await s.list(R_OUTBOX(), { page: 1, pageSize: 10000, filter: { estado: 'PROCESSANDO' }, sort: 'id', dir: 'asc' });
    const indeterminadas = await s.list(R_OUTBOX(), { page: 1, pageSize: 10000, filter: { estado: 'INDETERMINADO' }, sort: 'id', dir: 'asc' });
    candidatas = [...pendentes.rows.filter((r) => !r.proxima_tentativa_em || Date.parse(String(r.proxima_tentativa_em)) <= agora),
      ...presas.rows.filter((r) => !r.atualizado_em || agora - Date.parse(String(r.atualizado_em)) > 10 * 60_000),
      ...indeterminadas.rows.filter((r) => !r.proxima_tentativa_em || Date.parse(String(r.proxima_tentativa_em)) <= agora)]
      .filter((r) => !tipos || tipos.includes(String(r.tipo)))
      .slice(0, capacidade);
  }

  let processados = 0;
  let erros = 0;
  for (const row of candidatas) {
    if (String(row.estado) === 'PROCESSANDO') {
      await s.tryUpdateIf(R_OUTBOX(), Number(row.id),
        { estado: 'PROCESSANDO', claim_versao: Number(row.claim_versao || 0), empresa_id: Number(row.empresa_id) },
        { estado: 'INDETERMINADO', ultimo_erro: 'Execução interrompida antes da confirmação; reconciliação necessária.',
          proxima_tentativa_em: new Date().toISOString(), atualizado_em: new Date().toISOString() });
      continue;
    }
    if (String(row.estado) === 'INDETERMINADO') {
      await withCronIdempotency(`outbox:reconciliar:${row.id}:${row.claim_versao}`, String(row.id), () => reconciliarLinhaIndeterminada(s, row, jobId));
      continue;
    }
    const processado = await withCronIdempotency(`outbox:${row.id}:${row.claim_versao}:${row.estado}`, String(row.id), () => processarLinhaOutbox(s, row, jobId));
    if (processado === 'processado') processados += 1;
    else if (processado === 'erro') erros += 1;
  }
  log.info('outbox_varredura', { job_id: jobId, candidatas: candidatas.length, processados, erros, latencia_ms: Date.now() - inicio });
  return { processados, erros };
}

async function processarLinhaOutbox(s: ReturnType<typeof getStore>, row: Row, jobId: string): Promise<'processado' | 'erro' | 'outro'> {
    const estadoAtual = String(row.estado);
    const reivindicado = await s.tryUpdateIf(
      R_OUTBOX(),
      Number(row.id),
      // Versão monotônica protege contra conclusão por worker com lease antigo,
      // inclusive depois de uma recuperação manual que zera tentativas.
      { estado: estadoAtual, claim_versao: Number(row.claim_versao || 0), empresa_id: Number(row.empresa_id) },
      { estado: 'PROCESSANDO', claim_versao: Number(row.claim_versao || 0) + 1, tentativas: Number(row.tentativas || 0) + 1 }
    );
    if (!reivindicado) return 'outro';

    const tentativas = Number(reivindicado.tentativas);
    const esperado = { estado: 'PROCESSANDO', claim_versao: Number(reivindicado.claim_versao), empresa_id: Number(row.empresa_id) };
    try {
      const desfecho = await processarEntrada(row);
      if (desfecho.status === 'processado') {
        const concluida = await s.tryUpdateIf(R_OUTBOX(), Number(row.id), esperado, {
          estado: 'PROCESSADO',
          tentativas,
          processado_em: new Date().toISOString(),
          ultimo_erro: null,
          proxima_tentativa_em: null,
        });
        return concluida ? 'processado' : 'outro';
      } else if (desfecho.status === 'erro') {
        const falha = await s.tryUpdateIf(R_OUTBOX(), Number(row.id), esperado, {
          estado: 'ERRO', ultimo_erro: String(desfecho.erro || 'Falha permanente').slice(0, 500),
          proxima_tentativa_em: null, atualizado_em: new Date().toISOString(),
        });
        return falha ? 'erro' : 'outro';
      } else {
        // retry com backoff — e ERRO honesto quando esgota
        const esgotou = tentativas >= MAX_TENTATIVAS;
        const motivo = desfecho.erro ?? 'falha sem detalhe';
        const falha = await s.tryUpdateIf(R_OUTBOX(), Number(row.id), esperado, {
          estado: esgotou ? 'ERRO' : 'PENDENTE',
          tentativas,
          ultimo_erro: esgotou
            ? `Tentativas esgotadas (${MAX_TENTATIVAS}): ${motivo}`
            : `Tentativa ${tentativas} falhou (${motivo}); próxima em ${Math.round(backoffMs(tentativas) / 1000)}s.`,
          proxima_tentativa_em: esgotou ? null : new Date(Date.now() + backoffMs(tentativas)).toISOString(),
          atualizado_em: new Date().toISOString(),
        });
        return esgotou && falha ? 'erro' : 'outro';
      }
    } catch (e) {
      const esgotou = tentativas >= MAX_TENTATIVAS;
      const mensagem = e instanceof HttpError ? e.message.slice(0, 500) : 'Falha ao processar evento; consulte a integração responsável.';
      const falha = await s.tryUpdateIf(R_OUTBOX(), Number(row.id), esperado, {
        estado: esgotou ? 'ERRO' : 'PENDENTE',
        tentativas,
        ultimo_erro: mensagem,
        proxima_tentativa_em: esgotou ? null : new Date(Date.now() + backoffMs(tentativas)).toISOString(),
        atualizado_em: new Date().toISOString(),
      });
      if (esgotou && falha) {
        log.error('outbox_entrada_esgotada', { job_id: jobId, event_id: Number(row.id), tipo: String(row.tipo), empresa_id: Number(row.empresa_id), tentativas, erro: mensagem });
        return 'erro';
      }
      return 'outro';
    }
}

async function diagnosticarIndeterminado(s: ReturnType<typeof getStore>, row: Row): Promise<'confirmado' | 'reenfileirar' | 'aguardar'> {
  const tipo = String(row.tipo);
  const empresaId = Number(row.empresa_id);
  const payload = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>;
  if (tipo === 'alerta') return 'confirmado';
  if (tipo === 'conversao') {
    const saleId = String(payload.sale_id || '');
    if (!saleId) return 'aguardar';
    const pedido = await s.findOneWhere(getResource('commerce_pedidos')!, { sale_id: saleId, empresa_id: empresaId });
    if (pedido && String(pedido.estado) === 'CONVERTIDO') return 'confirmado';
    if (pedido) return 'reenfileirar';
    return 'aguardar';
  }
  if (tipo === 'publicacao') {
    const publicacaoId = Number(payload.publicacao_id);
    if (!Number.isInteger(publicacaoId) || publicacaoId <= 0) return 'aguardar';
    const pub = await s.findOneWhere(getResource('commerce_publicacoes')!, { id: publicacaoId, empresa_id: empresaId });
    if (pub && String(pub.estado) === 'PUBLISHED') return 'confirmado';
    return 'aguardar';
  }
  if (tipo === 'refund_devolucao') {
    const devolucaoId = Number(payload.devolucao_id);
    if (!Number.isInteger(devolucaoId) || devolucaoId <= 0) return 'aguardar';
    const rec = getResource('commerce_devolucoes') || getResource('devolucoes');
    if (!rec) return 'aguardar';
    const dev = await s.findOneWhere(rec, { id: devolucaoId, empresa_id: empresaId });
    const estado = String(dev?.estado_refund ?? dev?.refund_status ?? dev?.estado ?? '');
    if (/refund|estorn/i.test(estado) && /ok|done|conclu|success|estornado/i.test(estado)) return 'confirmado';
    return 'aguardar';
  }
  return 'aguardar';
}

async function reconciliarLinhaIndeterminada(s: ReturnType<typeof getStore>, row: Row, jobId: string): Promise<'confirmado' | 'reenfileirado' | 'indeterminado'> {
  const diagnostico = await diagnosticarIndeterminado(s, row);
  const esperado = { estado: 'INDETERMINADO', claim_versao: Number(row.claim_versao || 0), empresa_id: Number(row.empresa_id) };
  const agora = new Date().toISOString();
  if (diagnostico === 'confirmado') {
    const ok = await s.tryUpdateIf(R_OUTBOX(), Number(row.id), esperado, {
      estado: 'PROCESSADO', processado_em: agora, ultimo_erro: null, proxima_tentativa_em: null, atualizado_em: agora,
    });
    if (ok) log.info('outbox_indeterminado_confirmado', { job_id: jobId, event_id: Number(row.id), tipo: String(row.tipo), empresa_id: Number(row.empresa_id) });
    return ok ? 'confirmado' : 'indeterminado';
  }
  if (diagnostico === 'reenfileirar') {
    const ok = await s.tryUpdateIf(R_OUTBOX(), Number(row.id), esperado, {
      estado: 'PENDENTE', tentativas: 0,
      ultimo_erro: 'Reconciliação: efeito local não confirmado; reenfileirado sem chamar provedor externo.',
      proxima_tentativa_em: agora, atualizado_em: agora,
    });
    if (ok) log.info('outbox_indeterminado_reenfileirado', { job_id: jobId, event_id: Number(row.id), tipo: String(row.tipo), empresa_id: Number(row.empresa_id) });
    return ok ? 'reenfileirado' : 'indeterminado';
  }
  await s.tryUpdateIf(R_OUTBOX(), Number(row.id), esperado, {
    ultimo_erro: 'Indeterminado: sem evidência local nem consulta de provedor; operador pode reenfileirar. Sem reenvio automático.',
    proxima_tentativa_em: new Date(Date.now() + 30 * 60_000).toISOString(),
    atualizado_em: agora,
  });
  log.info('outbox_indeterminado_aguardando', { job_id: jobId, event_id: Number(row.id), tipo: String(row.tipo), empresa_id: Number(row.empresa_id) });
  return 'indeterminado';
}

/** Recoloca um erro ou indeterminado da empresa ativa na fila, com auditoria transacional. */
export async function reprocessarOutbox(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_OUTBOX(), actor, 'read');
  const empresaId = escopoDoAtor(actor).empresaId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Evento inválido.');
  const s = getStore();
  const resultado = await s.transaction(async (tx) => {
    const antes = await s.findOneWhere(R_OUTBOX(), { id, empresa_id: empresaId }, tx);
    if (!antes) throw new HttpError(404, 'Evento não encontrado.');
    const estadoAntes = String(antes.estado);
    if (estadoAntes !== 'ERRO' && estadoAntes !== 'INDETERMINADO') {
      throw new HttpError(409, 'Somente eventos em erro ou indeterminados podem ser reenfileirados.');
    }
    const depois = await s.tryUpdateIf(R_OUTBOX(), id, { empresa_id: empresaId, estado: estadoAntes, tentativas: antes.tentativas },
      { estado: 'PENDENTE', tentativas: 0, ultimo_erro: null, proxima_tentativa_em: new Date().toISOString() }, tx);
    if (!depois) throw new HttpError(409, 'O evento mudou; atualize a fila.');
    await s.audit({ empresa_id: empresaId, usuario_id: actor.id, usuario: actor.name, acao: 'ajuste',
      recurso: 'commerce_outbox', registro_id: id, descricao: 'Evento reenfileirado manualmente',
      dados: { antes: { estado: antes.estado, tentativas: antes.tentativas, ultimo_erro: antes.ultimo_erro },
        depois: { estado: depois.estado, tentativas: depois.tentativas } } }, tx);
    return depois;
  });
  res.json({ id: Number(resultado.id), estado: resultado.estado });
}

/**
 * Rotina única chamada pelo `runScheduled`/cron: fila de publicação + outbox +
 * expiração de checkouts. Idempotente — rodar duas vezes não duplica efeito.
 */
export async function processarComercioAgendado(): Promise<{
  publicacoes: { processadas: number; falhas: number };
  outbox: { processados: number; erros: number };
  expirados: number;
  falhas: string[];
}> {
  const falhas: string[] = [];
  const { runPaymentJobs } = await import('../../../modules/payments/application/jobs');
  const { processarFilaPublicacoes } = await import('./catalogo');
  const { expirarCheckoutsPendentes } = await import('./pedidos');
  let publicacoes = { processadas: 0, falhas: 0 };
  const outbox = { processados: 0, erros: 0 };
  let expirados = 0;
  try {
    const pagamentos = await withOptionalJobLease('pagamentos', 30_000, async () => {
      const result = await runPaymentJobs();
      const n = await expirarCheckoutsPendentes();
      const o = await processarOutbox(10, TIPOS_OUTBOX_POR_PROCESSO.pagamentos);
      return { result, n, o };
    });
    if (!pagamentos.skipped && pagamentos.result) {
      if (pagamentos.result.result.failed) falhas.push('pagamentos');
      expirados += pagamentos.result.n;
      outbox.processados += pagamentos.result.o.processados;
      outbox.erros += pagamentos.result.o.erros;
      if (pagamentos.result.o.erros) falhas.push('reembolsos_devolucao');
    }
  } catch { falhas.push('pagamentos'); }
  try {
    const pubs = await withOptionalJobLease('publicacoes', 30_000, async () => {
      const fila = await processarFilaPublicacoes(20);
      const o = await processarOutbox(10, TIPOS_OUTBOX_POR_PROCESSO.publicacoes);
      return { fila, o };
    });
    if (!pubs.skipped && pubs.result) {
      publicacoes = pubs.result.fila;
      if (publicacoes.falhas) falhas.push('publicacoes');
      outbox.processados += pubs.result.o.processados;
      outbox.erros += pubs.result.o.erros;
      if (pubs.result.o.erros) falhas.push('outbox_publicacoes');
    }
  } catch { falhas.push('publicacoes'); }
  try {
    const peds = await withOptionalJobLease('pedidos', 30_000, async () => processarOutbox(10, TIPOS_OUTBOX_POR_PROCESSO.pedidos));
    if (!peds.skipped && peds.result) {
      outbox.processados += peds.result.processados;
      outbox.erros += peds.result.erros;
      if (peds.result.erros) falhas.push('outbox');
    }
  } catch { falhas.push('outbox'); }
  return { publicacoes, outbox, expirados, falhas };
}
