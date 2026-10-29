// ============================================================================
// COMMERCE OS — OUTBOX (fila de sincronização com retry e backoff).
//
// At-least-once com chave única (empresa, tipo, chave): o registro não é
// duplicado, mas uma entrega externa pode ser repetida. Processadores REAIS:
//   • conversao     → ponte sales → vendas (retentativa até o item casar);
//   • publicacao    → fila de publicação do canal;
//   • sincronizacao → envio de estoque ao WooCommerce (env);
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
import type { Row, Tx } from '../store';

const R_OUTBOX = () => getResource('commerce_outbox')!;

export type TipoOutbox = 'conversao' | 'publicacao' | 'sincronizacao' | 'alerta';

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

  if (tipo === 'alerta') {
    console.error('[commerce:outbox:alerta]', { empresa_id: empresaId, event_id: Number(row.id) });
    return { status: 'processado' };
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
    if (acao === 'woo-estoque') {
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
    return { status: 'erro', erro: 'Ação de sincronização desconhecida.' };
  }

  return { status: 'erro', erro: `Tipo de evento desconhecido: ${tipo || '(vazio)'}` };

}

/**
 * Processa entradas vencidas com claim CAS. `limite` por rodada (o cron
 * chama de novo — a fila é a autoridade, não o agendador).
 */
export async function processarOutbox(limite = 10): Promise<{ processados: number; erros: number }> {
  const s = getStore();
  const capacidade = Math.max(1, Math.min(100, Math.trunc(limite) || 10));
  const agora = Date.now();
  let candidatas: Row[];
  if (s.kind === 'postgres') {
    // Filtrar antes de LIMIT evita que pendências futuras escondam trabalhos
    // vencidos. A fila é global somente para este worker de sistema.
    const result = await query(`SELECT * FROM commerce_outbox
      WHERE (estado = 'PENDENTE' AND (proxima_tentativa_em IS NULL OR proxima_tentativa_em <= now()))
         OR (estado = 'PROCESSANDO' AND atualizado_em < now() - interval '10 minutes')
      ORDER BY COALESCE(proxima_tentativa_em, atualizado_em), id LIMIT $1`, [capacidade]);
    candidatas = result.rows;
  } else {
    const pendentes = await s.list(R_OUTBOX(), { page: 1, pageSize: 10000, filter: { estado: 'PENDENTE' }, sort: 'id', dir: 'asc' });
    const presas = await s.list(R_OUTBOX(), { page: 1, pageSize: 10000, filter: { estado: 'PROCESSANDO' }, sort: 'id', dir: 'asc' });
    candidatas = [...pendentes.rows.filter((r) => !r.proxima_tentativa_em || Date.parse(String(r.proxima_tentativa_em)) <= agora),
      ...presas.rows.filter((r) => !r.atualizado_em || agora - Date.parse(String(r.atualizado_em)) > 10 * 60_000)].slice(0, capacidade);
  }

  let processados = 0;
  let erros = 0;
  for (const row of candidatas) {
    const estadoAtual = String(row.estado);
    const reivindicado = await s.tryUpdateIf(
      R_OUTBOX(),
      Number(row.id),
      // Versão monotônica protege contra conclusão por worker com lease antigo,
      // inclusive depois de uma recuperação manual que zera tentativas.
      { estado: estadoAtual, claim_versao: Number(row.claim_versao || 0), empresa_id: Number(row.empresa_id) },
      { estado: 'PROCESSANDO', claim_versao: Number(row.claim_versao || 0) + 1, tentativas: Number(row.tentativas || 0) + 1 }
    );
    if (!reivindicado) continue;

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
        if (concluida) processados += 1;
      } else if (desfecho.status === 'erro') {
        const falha = await s.tryUpdateIf(R_OUTBOX(), Number(row.id), esperado, {
          estado: 'ERRO', ultimo_erro: String(desfecho.erro || 'Falha permanente').slice(0, 500),
          proxima_tentativa_em: null, atualizado_em: new Date().toISOString(),
        });
        if (falha) erros += 1;
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
        if (esgotou && falha) erros += 1;
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
      if (esgotou && falha) erros += 1;
    }
  }
  return { processados, erros };
}

/** Recoloca um erro da empresa ativa na fila, com auditoria transacional. */
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
    if (antes.estado !== 'ERRO') throw new HttpError(409, 'Somente eventos em erro podem ser reenfileirados.');
    const depois = await s.tryUpdateIf(R_OUTBOX(), id, { empresa_id: empresaId, estado: 'ERRO', tentativas: antes.tentativas },
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
  try { const result = await runPaymentJobs(); if (result.failed) falhas.push('pagamentos'); }
  catch { falhas.push('pagamentos'); }
  const { processarFilaPublicacoes } = await import('./catalogo');
  const { expirarCheckoutsPendentes } = await import('./pedidos');
  let publicacoes = { processadas: 0, falhas: 0 };
  let outbox = { processados: 0, erros: 0 };
  let expirados = 0;
  try { publicacoes = await processarFilaPublicacoes(20); if (publicacoes.falhas) falhas.push('publicacoes'); }
  catch { falhas.push('publicacoes'); }
  try { outbox = await processarOutbox(10); if (outbox.erros) falhas.push('outbox'); }
  catch { falhas.push('outbox'); }
  try { expirados = await expirarCheckoutsPendentes(); }
  catch { falhas.push('expiracao'); }
  return { publicacoes, outbox, expirados, falhas };
}
