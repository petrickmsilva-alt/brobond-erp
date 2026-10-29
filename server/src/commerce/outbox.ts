// ============================================================================
// COMMERCE OS — OUTBOX (fila de sincronização com retry e backoff).
//
// At-least-once com chave única (empresa, tipo, chave): nada some, nada
// duplica. Processadores REAIS:
//   • conversao     → ponte sales → vendas (retentativa até o item casar);
//   • publicacao    → fila de publicação do canal;
//   • sincronizacao → envio de estoque ao WooCommerce (env);
//   • alerta        → log estruturado (falhas que precisam de gente).
// O claim é CAS (PENDENTE → PROCESSANDO): duas varreduras não processam a
// mesma entrada duas vezes; entrada presa há 10min volta para a fila.
// ============================================================================
import { getStore } from '../services';
import { getResource } from '../resources';
import { escopoDeSistema } from '../empresa';
import { MAX_TENTATIVAS, backoffMs, type EstadoPublicacao } from './regras';
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
    if (String(existente.estado) === 'PENDENTE' || String(existente.estado) === 'ERRO') {
      return (
        (await s.update(
          R_OUTBOX(),
          Number(existente.id),
          {
            payload,
            estado: 'PENDENTE',
            ultimo_erro: null,
            proxima_tentativa_em: new Date().toISOString(),
          },
          tx
        )) ?? existente
      );
    }
    return existente;
  }
  try {
    return await s.insert(
      R_OUTBOX(),
      {
        empresa_id: empresaId,
        tipo,
        chave,
        payload,
        estado: 'PENDENTE',
        tentativas: 0,
        proxima_tentativa_em: new Date().toISOString(),
        criado_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      },
      tx
    );
  } catch (e) {
    // corrida com outro worker: a chave única garante uma entrada só
    const outra = await s.findOneWhere(R_OUTBOX(), { empresa_id: empresaId, tipo, chave }, tx);
    if (outra) return outra;
    throw e;
  }
}

type Desfecho = { status: 'processado' | 'retry' | 'ignorado'; erro?: string };

async function processarEntrada(row: Row): Promise<Desfecho> {
  const s = getStore();
  const empresaId = Number(row.empresa_id);
  const tipo = String(row.tipo);
  const payload = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>;

  if (tipo === 'alerta') {
    console.error('[commerce:outbox:alerta]', { empresa_id: empresaId, chave: String(row.chave), payload });
    return { status: 'processado' };
  }

  if (tipo === 'conversao') {
    const { converterPedidoSale } = await import('./pedidos');
    const saleId = String(payload.sale_id || '');
    if (!saleId) return { status: 'processado' };
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
    if (!publicacaoId) return { status: 'processado' };
    const pub = await s.findOneWhere(getResource('commerce_publicacoes')!, { id: publicacaoId, empresa_id: empresaId });
    if (!pub) return { status: 'processado' };
    const resultado = await processarPublicacao(pub);
    if (resultado === 'processada') return { status: 'processado' };
    if (resultado === 'ignorada') return { status: 'ignorado' };
    return { status: 'retry', erro: pub.ultimo_erro ? String(pub.ultimo_erro) : 'Falha na publicação do canal.' };
  }

  if (tipo === 'sincronizacao') {
    const acao = String(payload.acao || '');
    if (acao === 'woo-estoque') {
      const { enviarEstoqueLojaInterno, configLoja } = await import('../loja');
      if (!configLoja()) {
        await s.update(R_OUTBOX(), Number(row.id), {
          estado: 'ERRO',
          ultimo_erro: 'WooCommerce não configurado (WOOCOMMERCE_URL/CK/CS) — sincronização recusada sem site alvo.',
          atualizado_em: new Date().toISOString(),
        });
        return { status: 'ignorado' };
      }
      const saida = await enviarEstoqueLojaInterno(escopoDeSistema(empresaId), { id: null, name: 'Commerce outbox' });
      console.log(
        `[commerce:outbox] estoque woo enviado (${saida.total_atualizados} SKUs, ${saida.nao_encontrados.length} sem correspondência)`
      );
      return { status: 'processado' };
    }
    await s.update(R_OUTBOX(), Number(row.id), {
      estado: 'ERRO',
      ultimo_erro: `Ação de sincronização desconhecida: ${acao || '(vazia)'}`,
      atualizado_em: new Date().toISOString(),
    });
    return { status: 'ignorado' };
  }

  return { status: 'ignorado' };
}

/**
 * Processa entradas vencidas com claim CAS. `limite` por rodada (o cron
 * chama de novo — a fila é a autoridade, não o agendador).
 */
export async function processarOutbox(limite = 10): Promise<{ processados: number; erros: number }> {
  const s = getStore();
  const pendentes = await s.list(R_OUTBOX(), { page: 1, pageSize: limite * 3, filter: { estado: 'PENDENTE' }, sort: 'id', dir: 'asc' });
  const agora = Date.now();
  const candidatas = pendentes.rows.filter((r) => !r.proxima_tentativa_em || Date.parse(String(r.proxima_tentativa_em)) <= agora);

  // entradas presas (worker morreu) voltam para a fila em 10 minutos
  const presas = await s.list(R_OUTBOX(), { page: 1, pageSize: limite, filter: { estado: 'PROCESSANDO' }, sort: 'id', dir: 'asc' });
  for (const r of presas.rows) {
    const ultima = r.atualizado_em ? Date.parse(String(r.atualizado_em)) : 0;
    if (agora - ultima > 10 * 60_000) candidatas.push(r);
  }

  let processados = 0;
  let erros = 0;
  for (const row of candidatas.slice(0, limite)) {
    const estadoAtual = String(row.estado);
    const reivindicado = await s.tryUpdateIf(
      R_OUTBOX(),
      Number(row.id),
      { estado: estadoAtual },
      { estado: 'PROCESSANDO', atualizado_em: new Date().toISOString() }
    );
    if (!reivindicado) continue;

    const tentativas = Number(row.tentativas || 0) + 1;
    try {
      const desfecho = await processarEntrada(row);
      if (desfecho.status === 'processado') {
        await s.update(R_OUTBOX(), Number(row.id), {
          estado: 'PROCESSADO',
          tentativas,
          processado_em: new Date().toISOString(),
          ultimo_erro: null,
          proxima_tentativa_em: null,
        });
        processados += 1;
      } else if (desfecho.status === 'ignorado') {
        processados += 1;
      } else {
        // retry com backoff — e ERRO honesto quando esgota
        const esgotou = tentativas >= MAX_TENTATIVAS;
        const motivo = desfecho.erro ?? 'falha sem detalhe';
        await s.update(R_OUTBOX(), Number(row.id), {
          estado: esgotou ? 'ERRO' : 'PENDENTE',
          tentativas,
          ultimo_erro: esgotou
            ? `Tentativas esgotadas (${MAX_TENTATIVAS}): ${motivo}`
            : `Tentativa ${tentativas} falhou (${motivo}); próxima em ${Math.round(backoffMs(tentativas) / 1000)}s.`,
          proxima_tentativa_em: esgotou ? null : new Date(Date.now() + backoffMs(tentativas)).toISOString(),
          atualizado_em: new Date().toISOString(),
        });
        if (esgotou) erros += 1;
      }
    } catch (e) {
      const esgotou = tentativas >= MAX_TENTATIVAS;
      const mensagem = String(e instanceof Error ? e.message : e).slice(0, 500);
      await s
        .update(R_OUTBOX(), Number(row.id), {
          estado: esgotou ? 'ERRO' : 'PENDENTE',
          tentativas,
          ultimo_erro: mensagem,
          proxima_tentativa_em: esgotou ? null : new Date(Date.now() + backoffMs(tentativas)).toISOString(),
          atualizado_em: new Date().toISOString(),
        })
        .catch(() => undefined);
      if (esgotou) erros += 1;
    }
  }
  return { processados, erros };
}

/**
 * Rotina única chamada pelo `runScheduled`/cron: fila de publicação + outbox +
 * expiração de checkouts. Idempotente — rodar duas vezes não duplica efeito.
 */
export async function processarComercioAgendado(): Promise<{
  publicacoes: { processadas: number; falhas: number };
  outbox: { processados: number; erros: number };
  expirados: number;
}> {
  const { runPaymentJobs } = await import('../../../modules/payments/application/jobs');
  await runPaymentJobs().catch(() => undefined);
  const { processarFilaPublicacoes } = await import('./catalogo');
  const { expirarCheckoutsPendentes } = await import('./pedidos');
  const publicacoes = await processarFilaPublicacoes(20).catch(() => ({ processadas: 0, falhas: 0 }));
  const outbox = await processarOutbox(10).catch(() => ({ processados: 0, erros: 0 }));
  const expirados = await expirarCheckoutsPendentes().catch(() => 0);
  return { publicacoes, outbox, expirados };
}
