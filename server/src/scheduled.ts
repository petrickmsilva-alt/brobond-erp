// ============================================================
// Relatórios Agendados — envia relatórios por e-mail periodicamente.
//
// Agendamentos suportados:
//   • POSICAO_ESTOQUE — posição de estoque valorizada (diário/semanal)
//   • VENDAS_PERIODO — vendas faturadas no período (diário/semanal)
//   • ALERTAS — itens abaixo do mínimo (diário)
//   • PRODUCAO — OPs concluídas no período (semanal)
//
// Configuração (env):
//   SCHEDULE_EMAILS=admin@brobond.com.br
//   SCHEDULE_POSICAO_ESTOQUE=daily     (daily | weekly | off)
//   SCHEDULE_VENDAS=weekly
//   SCHEDULE_ALERTAS=daily
//   SCHEDULE_PRODUCAO=weekly
//
// Execução: GET /api/admin/scheduled/run (admin) — executa manualmente
//           POST /api/admin/scheduled/cron — cron externo: processo `relatorios`
//           POST /api/admin/scheduled/cron/:processo — um processo por chamada (pagamentos, publicacoes, pedidos, crm)
//           Recorrências financeiras NÃO são processo de cron (ver financeiro.ts).
// ============================================================
import { createHash, timingSafeEqual } from 'node:crypto';
import { coletarFalhasEntrega, htmlSecaoFalhasEntrega } from './alertasFalhas';
import { enviarEmail, smtpConfigurado } from './mail';
import { hasDatabaseUrl, isDbConnected } from './db';
import { instagramConnectorService, saleIngestionService } from '../../modules/connectors/index';
import { getStore } from './services';
import { getResource } from './resources';
import { aplicarFiltroEmpresa, type EscopoEmpresa } from './empresa';
import { destinosPorEmpresa, type DestinoEmpresa } from './destinatariosEmpresa';
import { labelOf } from './store';
import { HttpError } from './errors';
import { atualizarMotorNegocios } from './negocios';
import type { Request, Response } from 'express';
import { currentUser } from './auth';
import { diaISO } from './utils';
import { dispararLembretesCrm } from './crm';
import { processarOutbox, TIPOS_OUTBOX_POR_PROCESSO } from './commerce/outbox';
import {
  acquireCronLease,
  leaseMsForTimeout,
  releaseCronLease,
  runWithCronLease,
  startCronHeartbeat,
  withCronIdempotency,
  type CronLease,
} from './cronLock';

const fmtMoney = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNumber = (n: number) => n.toLocaleString('pt-BR');

function scheduleEmails(): string[] {
  return (process.env.SCHEDULE_EMAILS || process.env.NOTIFICAR_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function getSchedule(tipo: string): string {
  return (process.env[`SCHEDULE_${tipo}`] || 'off').toLowerCase();
}

/** Verifica se é dia de executar (daily = sempre; weekly = segunda-feira). */
function deveExecutar(frequencia: string): boolean {
  if (frequencia === 'off') return false;
  if (frequencia === 'daily') return true;
  if (frequencia === 'weekly') return new Date().getDay() === 1; // Segunda
  return false;
}

/** Envio injetável (testes). Em produção, é o `enviarEmail` real. */
export type EnviadorRelatorio = (opts: { to: string; assunto: string; html: string }) => Promise<unknown>;

/** Recorte do servidor para leitura de um relatório (mesmo padrão das rotas: `aplicarFiltroEmpresa`). */
function escopoDaEmpresa(empresaId: number): EscopoEmpresa {
  return { empresaId, consolidado: false, permitidas: [empresaId] };
}

async function listarDaEmpresa(
  chave: string,
  empresaId: number,
  pageSize: number,
  extra: { sort?: string; dir?: 'asc' | 'desc' } = {},
) {
  const r = getResource(chave)!;
  return getStore().list(r, {
    page: 1,
    pageSize,
    ...extra,
    filter: aplicarFiltroEmpresa(r, undefined, escopoDaEmpresa(empresaId)),
  });
}

async function enviarRelatorio(assunto: string, html: string, enviar: EnviadorRelatorio, emails: string[]): Promise<void> {
  if (!emails.length) return;

  const htmlBase = `
    <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;">
      <div style="background:#1B2A4A;color:white;padding:16px 24px;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;font-size:18px;">📊 BROBOND ERP — Relatório</h2>
      </div>
      <div style="background:#fff;border:1px solid #e2e8f0;padding:24px;border-radius:0 0 8px 8px;">
        ${html}
      </div>
      <p style="text-align:center;color:#999;font-size:11px;margin-top:12px;">
        Relatório automático do BROBOND ERP — ${new Date().toLocaleString('pt-BR')}
      </p>
    </div>`;

  for (const email of emails) {
    await enviar({ to: email, assunto: `📊 ${assunto}`, html: htmlBase }).catch(() => {
      console.warn('⚠️  Falha ao preparar relatório por e-mail.');
    });
  }
}

// ----------------------------------------------------------------------------
// Relatórios individuais
// ----------------------------------------------------------------------------

export async function relatorioPosicaoEstoque(enviar: EnviadorRelatorio = enviarEmail): Promise<void> {
  const destinos = await destinosPorEmpresa(scheduleEmails(), ['estoques', 'produtos']);
  if (!destinos.length) return logSemDestinatario('posição de estoque');
  for (const destino of destinos) await gerarPosicaoEstoque(destino, enviar);
}

async function gerarPosicaoEstoque(destino: DestinoEmpresa, enviar: EnviadorRelatorio): Promise<void> {
  await withCronIdempotency(`relatorios:posicao:${destino.empresaId}:${diaISO(new Date())}`, String(destino.empresaId), () => emitirPosicaoEstoque(destino, enviar));
}

async function emitirPosicaoEstoque(destino: DestinoEmpresa, enviar: EnviadorRelatorio): Promise<void> {
  const [produtos, estoques] = await Promise.all([
    listarDaEmpresa('produtos', destino.empresaId, 2000),
    listarDaEmpresa('estoques', destino.empresaId, 5000),
  ]);

  let valorTotal = 0;
  let pecasTotal = 0;
  const porProduto = new Map<number, { nome: string; pecas: number; valor: number }>();

  for (const e of estoques.rows) {
    const pid = Number(e.produto_id);
    const p = produtos.rows.find((x) => Number(x.id) === pid);
    const qtd = Number(e.quantidade || 0);
    const custo = Number(p?.custo || 0);
    valorTotal += qtd * custo;
    pecasTotal += qtd;
    const atual = porProduto.get(pid) || { nome: p ? labelOf(getResource('produtos')!, p) : `#${pid}`, pecas: 0, valor: 0 };
    atual.pecas += qtd;
    atual.valor += qtd * custo;
    porProduto.set(pid, atual);
  }

  const top = [...porProduto.values()].sort((a, b) => b.valor - a.valor).slice(0, 15);

  const html = `
    <h3 style="color:#1B2A4A;margin-top:0;">📦 Posição de Estoque</h3>
    <div style="display:flex;gap:16px;margin:16px 0;">
      <div style="flex:1;background:#f7f9fc;padding:12px;border-radius:8px;text-align:center;">
        <div style="font-size:24px;font-weight:bold;color:#1B2A4A;">R$ ${fmtMoney(valorTotal)}</div>
        <div style="font-size:12px;color:#666;">Valor total</div>
      </div>
      <div style="flex:1;background:#f7f9fc;padding:12px;border-radius:8px;text-align:center;">
        <div style="font-size:24px;font-weight:bold;color:#1B2A4A;">${fmtNumber(pecasTotal)}</div>
        <div style="font-size:12px;color:#666;">Peças em estoque</div>
      </div>
      <div style="flex:1;background:#f7f9fc;padding:12px;border-radius:8px;text-align:center;">
        <div style="font-size:24px;font-weight:bold;color:#1B2A4A;">${porProduto.size}</div>
        <div style="font-size:12px;color:#666;">Produtos diferentes</div>
      </div>
    </div>
    <h4 style="color:#333;">Top 15 produtos por valor</h4>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr style="background:#f7f9fc;"><th style="padding:6px;text-align:left;">Produto</th><th style="padding:6px;text-align:right;">Peças</th><th style="padding:6px;text-align:right;">Valor</th></tr></thead>
      <tbody>
        ${top.map((p) => `<tr><td style="padding:4px 6px;border-bottom:1px solid #eee;">${p.nome}</td><td style="padding:4px 6px;text-align:right;border-bottom:1px solid #eee;">${p.pecas}</td><td style="padding:4px 6px;text-align:right;border-bottom:1px solid #eee;font-weight:bold;">R$ ${fmtMoney(p.valor)}</td></tr>`).join('')}
      </tbody>
    </table>`;

  await enviarRelatorio(`Posição de Estoque — ${new Date().toLocaleDateString('pt-BR')}`, html, enviar, destino.emails);
}

export async function relatorioVendas(enviar: EnviadorRelatorio = enviarEmail): Promise<void> {
  const destinos = await destinosPorEmpresa(scheduleEmails(), ['vendas']);
  if (!destinos.length) return logSemDestinatario('vendas');
  for (const destino of destinos) await gerarVendas(destino, enviar);
}

async function gerarVendas(destino: DestinoEmpresa, enviar: EnviadorRelatorio): Promise<void> {
  await withCronIdempotency(`relatorios:vendas:${destino.empresaId}:${diaISO(new Date())}`, String(destino.empresaId), () => emitirVendas(destino, enviar));
}

async function emitirVendas(destino: DestinoEmpresa, enviar: EnviadorRelatorio): Promise<void> {
  const dias = getSchedule('VENDAS') === 'daily' ? 1 : 7;
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);
  const desdeStr = desde.toISOString().slice(0, 10);

  const vendas = await listarDaEmpresa('vendas', destino.empresaId, 1000, { sort: 'faturada_em', dir: 'desc' });
  const faturadas = vendas.rows.filter((v) => ['faturada', 'entregue'].includes(String(v.status)) && diaISO(v.faturada_em) >= desdeStr);

  const totalVendas = faturadas.reduce((s, v) => s + Number(v.total || 0), 0);
  const totalComissao = faturadas.reduce((s, v) => s + Number(v.comissao_valor || 0), 0);

  const html = `
    <h3 style="color:#059669;margin-top:0;">💰 Vendas Faturadas — últimos ${dias} dia${dias > 1 ? 's' : ''}</h3>
    <div style="display:flex;gap:16px;margin:16px 0;">
      <div style="flex:1;background:#f0fdf4;padding:12px;border-radius:8px;text-align:center;">
        <div style="font-size:24px;font-weight:bold;color:#059669;">R$ ${fmtMoney(totalVendas)}</div>
        <div style="font-size:12px;color:#666;">Total faturado</div>
      </div>
      <div style="flex:1;background:#f0fdf4;padding:12px;border-radius:8px;text-align:center;">
        <div style="font-size:24px;font-weight:bold;color:#059669;">${faturadas.length}</div>
        <div style="font-size:12px;color:#666;">Pedidos</div>
      </div>
      <div style="flex:1;background:#f0fdf4;padding:12px;border-radius:8px;text-align:center;">
        <div style="font-size:24px;font-weight:bold;color:#059669;">R$ ${fmtMoney(totalComissao)}</div>
        <div style="font-size:12px;color:#666;">Comissões</div>
      </div>
    </div>
    <h4 style="color:#333;">Últimos pedidos</h4>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr style="background:#f7f9fc;"><th style="padding:6px;text-align:left;">#</th><th style="padding:6px;text-align:left;">Data</th><th style="padding:6px;text-align:right;">Total</th><th style="padding:6px;text-align:left;">Status</th></tr></thead>
      <tbody>
        ${faturadas.slice(0, 10).map((v) => `<tr><td style="padding:4px 6px;border-bottom:1px solid #eee;">#${v.id}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;">${diaISO(v.faturada_em || v.data)}</td><td style="padding:4px 6px;text-align:right;border-bottom:1px solid #eee;font-weight:bold;">R$ ${fmtMoney(Number(v.total || 0))}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;">${v.status}</td></tr>`).join('')}
      </tbody>
    </table>`;

  await enviarRelatorio(`Vendas — últimos ${dias} dia${dias > 1 ? 's' : ''}`, html, enviar, destino.emails);
}

export async function relatorioAlertas(enviar: EnviadorRelatorio = enviarEmail): Promise<void> {
  const destinos = await destinosPorEmpresa(scheduleEmails(), [
    'estoques', 'estoque_insumos', 'produtos', 'insumos', 'commerce_outbox', 'commerce_notificacoes',
  ]);
  if (!destinos.length) return logSemDestinatario('alertas');
  for (const destino of destinos) await gerarAlertas(destino, enviar);
}

function logSemDestinatario(relatorio: string): void {
  // Sem dados e sem destinatário identificado: nada é lido para envio nem enviado. Só contagem no log.
  console.log(`[schedule] ${relatorio}: nenhuma empresa com destinatário autorizado identificado; nada enviado.`);
}

async function gerarAlertas(destino: DestinoEmpresa, enviar: EnviadorRelatorio): Promise<void> {
  await withCronIdempotency(`relatorios:alertas:${destino.empresaId}:${diaISO(new Date())}`, String(destino.empresaId), () => emitirAlertas(destino, enviar));
}

async function emitirAlertas(destino: DestinoEmpresa, enviar: EnviadorRelatorio): Promise<void> {
  const [estoques, insumosEst, produtos, insumos] = await Promise.all([
    listarDaEmpresa('estoques', destino.empresaId, 5000),
    listarDaEmpresa('estoque_insumos', destino.empresaId, 2000),
    listarDaEmpresa('produtos', destino.empresaId, 2000),
    listarDaEmpresa('insumos', destino.empresaId, 2000),
  ]);

  const alertasProd = estoques.rows
    .filter((e) => Number(e.estoque_min) > 0 && Number(e.quantidade) <= Number(e.estoque_min))
    .map((e) => {
      const p = produtos.rows.find((x) => Number(x.id) === Number(e.produto_id));
      return { nome: p ? labelOf(getResource('produtos')!, p) : `#${e.produto_id}`, qtd: Number(e.quantidade), min: Number(e.estoque_min), local: e.local };
    });

  const alertasIns = insumosEst.rows
    .filter((ei) => Number(ei.estoque_min) > 0 && Number(ei.quantidade) <= Number(ei.estoque_min))
    .map((ei) => {
      const ins = insumos.rows.find((x) => Number(x.id) === Number(ei.insumo_id));
      return { nome: ins ? labelOf(getResource('insumos')!, ins) : `#${ei.insumo_id}`, qtd: Number(ei.quantidade), min: Number(ei.estoque_min) };
    });

  const html = `
    <h3 style="color:#D97706;margin-top:0;">⚠️ Alertas de Estoque</h3>
    ${alertasProd.length > 0 ? `
      <h4 style="color:#C53030;">🔴 Produtos abaixo do mínimo (${alertasProd.length})</h4>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:#fef2f2;"><th style="padding:6px;text-align:left;">Produto</th><th style="padding:6px;text-align:left;">Local</th><th style="padding:6px;text-align:right;">Saldo</th><th style="padding:6px;text-align:right;">Mínimo</th></tr></thead>
        <tbody>
          ${alertasProd.slice(0, 20).map((a) => `<tr><td style="padding:4px 6px;border-bottom:1px solid #eee;">${a.nome}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;">${a.local}</td><td style="padding:4px 6px;text-align:right;border-bottom:1px solid #eee;color:#C53030;font-weight:bold;">${a.qtd}</td><td style="padding:4px 6px;text-align:right;border-bottom:1px solid #eee;">${a.min}</td></tr>`).join('')}
        </tbody>
      </table>` : '<p style="color:#059669;">✅ Nenhum produto abaixo do mínimo.</p>'}
    ${alertasIns.length > 0 ? `
      <h4 style="color:#D97706;margin-top:16px;">🟡 Insumos abaixo do mínimo (${alertasIns.length})</h4>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:#fffbeb;"><th style="padding:6px;text-align:left;">Insumo</th><th style="padding:6px;text-align:right;">Saldo</th><th style="padding:6px;text-align:right;">Mínimo</th></tr></thead>
        <tbody>
          ${alertasIns.slice(0, 20).map((a) => `<tr><td style="padding:4px 6px;border-bottom:1px solid #eee;">${a.nome}</td><td style="padding:4px 6px;text-align:right;border-bottom:1px solid #eee;color:#D97706;font-weight:bold;">${a.qtd}</td><td style="padding:4px 6px;text-align:right;border-bottom:1px solid #eee;">${a.min}</td></tr>`).join('')}
        </tbody>
      </table>` : ''}`;

  // Fase 7 (P2-08): falhas de envio entram no mesmo relatório. Falha isolada não derruba o alerta de estoque.
  let secaoFalhas = '';
  let temFalhas = false;
  try {
    const falhas = await coletarFalhasEntrega(new Date(), { empresaId: destino.empresaId });
    temFalhas = falhas.total > 0;
    secaoFalhas = htmlSecaoFalhasEntrega(falhas);
  } catch (erro) {
    console.error('[schedule] Falha ao ler falhas de envio para o relatório:', String((erro as Error)?.message ?? erro).slice(0, 200));
  }

  await enviarRelatorio(
    `Alertas de Estoque${temFalhas ? ' e Falhas de Envio' : ''} — ${new Date().toLocaleDateString('pt-BR')}`,
    html + secaoFalhas,
    enviar,
    destino.emails,
  );
}

// ----------------------------------------------------------------------------
// Rotas
// ----------------------------------------------------------------------------

/** GET /api/admin/scheduled/run — executa todos os relatórios agendados (admin). */
/**
 * Varredura de recuperação da ingestão de marketplace: reprocessa os
 * webhooks que ficaram pendentes (provedor fora do ar, token em
 * renovação, reinício do processo no meio da gravação). Nunca lança — o
 * agendador não pode cair por causa de um conector.
 *
 * São DUAS varreduras independentes, em dois `try` separados de
 * propósito: o Instagram tem motor próprio (`instagramConnectorService`,
 * fora do despachante genérico) e uma falha dele não pode impedir a
 * recuperação do Mercado Livre / Mercado Pago / Nuvemshop — nem o
 * contrário.
 */
async function recuperarPedidosPendentes(): Promise<number> {
  if (!hasDatabaseUrl()) return 0;

  let total = 0;

  try {
    const { processed } = await saleIngestionService.processPendingSaleEvents({ limit: 50 });
    total += processed;
  } catch (e: any) {
    console.warn('⚠️  Varredura de pedidos pendentes falhou:', e?.message || e);
  }

  try {
    const { processed } = await instagramConnectorService.processPendingEvents({ limit: 50 });
    total += processed;
  } catch (e: any) {
    console.warn('⚠️  Varredura de eventos pendentes do Instagram falhou:', e?.message || e);
  }

  return total;
}

/**
 * R-4 (Fase 4.3) — processos do cron, cada um com responsabilidade delimitada.
 *
 * Cada processo é executado SOZINHO por `executarProcessoCron`: uma falha em um não interrompe os
 * outros; não há processo que chame outro; e o relatório (`relatorios`) não dispara nenhum efeito
 * financeiro, de publicação, de pedido ou de CRM. Recorrências financeiras NÃO são processo de cron:
 * só existem na rota administrativa com confirmação explícita (financeiro.ts, `cronRecorrencias`).
 *
 * Autenticação: todos os processos usam o mesmo contrato de `CRON_SECRET` (Bearer) e nenhum aceita
 * sessão de usuário. Não há segredo por processo, para não criar variável nova sem aprovação.
 */
export type ProcessoCron = 'relatorios' | 'pagamentos' | 'publicacoes' | 'pedidos' | 'crm';

export interface ResultadoExecutorCron {
  itens: number;
  detalhes: string[];
  falhas: string[];
}

export interface ResultadoProcessoCron extends ResultadoExecutorCron {
  processo: ProcessoCron;
  ok: boolean;
  status: number;
  inicio: string;
  fim: string;
  /** Motivo quando ok=false: timeout, erro (exceção no executor) ou ja_em_execucao (409). */
  motivo?: 'timeout' | 'erro' | 'ja_em_execucao';
}

/** Relatórios agendados: estoque, vendas e alertas (com a seção de falhas de envio). Cada um isolado. */
async function executarRelatoriosCron(): Promise<ResultadoExecutorCron> {
  const detalhes: string[] = [];
  const falhas: string[] = [];
  const tentar = async (nome: string, rotulo: string, fn: () => Promise<void>) => {
    try { await fn(); detalhes.push(rotulo); } catch { falhas.push(nome); }
  };
  if (deveExecutar(getSchedule('POSICAO_ESTOQUE'))) await tentar('relatorio_estoque', 'Posição de estoque', () => relatorioPosicaoEstoque());
  if (deveExecutar(getSchedule('VENDAS'))) await tentar('relatorio_vendas', 'Vendas', () => relatorioVendas());
  if (deveExecutar(getSchedule('ALERTAS'))) await tentar('relatorio_alertas', 'Alertas e falhas de envio', () => relatorioAlertas());
  return { itens: detalhes.length, detalhes, falhas };
}

/** Sincronização de pagamentos, expiração de checkouts e reembolsos de devolução (fila `pagamentos`). */
async function executarPagamentosCron(): Promise<ResultadoExecutorCron> {
  const falhas: string[] = [];
  let itens = 0;
  try {
    const { runPaymentJobs } = await import('../../modules/payments/application/jobs');
    const r = await runPaymentJobs();
    itens += Number(r.synchronized) || 0;
    itens += Number(r.reconciliados) || 0;
    if (r.failed) falhas.push('sincronizacao_pagamentos');
  } catch { falhas.push('sincronizacao_pagamentos'); }
  try {
    const { expirarCheckoutsPendentes } = await import('./commerce/pedidos');
    itens += Number(await expirarCheckoutsPendentes()) || 0;
  } catch { falhas.push('expiracao_checkout'); }
  try {
    const o = await processarOutbox(10, TIPOS_OUTBOX_POR_PROCESSO.pagamentos);
    itens += o.processados;
    if (o.erros) falhas.push('reembolsos_devolucao');
  } catch { falhas.push('reembolsos_devolucao'); }
  return { itens, detalhes: [], falhas };
}

/** Fila de publicações (respeita a suspensão ML/Nuvemshop) e publicações pendentes na outbox. */
async function executarPublicacoesCron(): Promise<ResultadoExecutorCron> {
  const falhas: string[] = [];
  let itens = 0;
  try {
    const { processarFilaPublicacoes } = await import('./commerce/catalogo');
    const p = await processarFilaPublicacoes(20);
    itens += p.processadas;
    if (p.falhas) falhas.push('fila_publicacoes');
  } catch { falhas.push('fila_publicacoes'); }
  try {
    const o = await processarOutbox(10, TIPOS_OUTBOX_POR_PROCESSO.publicacoes);
    itens += o.processados;
    if (o.erros) falhas.push('outbox_publicacoes');
  } catch { falhas.push('outbox_publicacoes'); }
  return { itens, detalhes: [], falhas };
}

/**
 * Multi-loja: enfileira, para CADA loja habilitada, a sincronização de estoque
 * e a importação incremental de pedidos. Nenhuma chamada de rede aqui — quem
 * fala com a loja é o worker do outbox. O enfileiramento é idempotente pela
 * chave por loja, então repetir o cron não acumula eventos. Devolve 0 quando o
 * modo multi-loja está desligado.
 *
 * Também RECUPERA entregas de webhook presas (gravadas mas nunca enfileiradas,
 * ou em erro): o webhook é a via rápida, o polling é a contingência. As duas
 * vias convivem sem duplicar — a chave idempotente e a importação por loja
 * arbitram.
 */
async function enfileirarSincronizacaoMultiLoja(): Promise<number> {
  const { multiStoreHabilitado } = await import('./commerce/woocommerce/registry');
  if (!multiStoreHabilitado()) return 0;
  const { lojasDaEmpresa, enfileirarPedidosDaLoja, enfileirarEstoqueDaLoja } = await import('./commerce/woocommerce/outboxStore');
  const { recuperarEntregasPendentes } = await import('./commerce/woocommerce/webhookInbox');
  let enfileirados = 0;
  for (const { cfg, empresaId } of lojasDaEmpresa()) {
    // Uma loja indisponível não derruba as demais: o erro fica naquela loja.
    try {
      await enfileirarEstoqueDaLoja(empresaId, cfg.store_key);
      await enfileirarPedidosDaLoja(empresaId, cfg.store_key);
      await recuperarEntregasPendentes(empresaId, cfg.store_key);
      enfileirados += 1;
    } catch { /* segue para a próxima loja */ }
  }
  return enfileirados;
}

/**
 * Reconciliação periódica (contingência): compara ERP × loja por loja e
 * registra divergências. NÃO escreve nas lojas e não corrige nada — apenas
 * detecta e classifica; a correção é decisão do operador pelo painel.
 *
 * Throttle por loja: só reconcilia quando `ultima_reconciliacao_em` está mais
 * velha que `WOOCOMMERCE_RECONCILIACAO_INTERVALO_MIN` (default 60 min), então o
 * cron pode rodar com a frequência que for sem multiplicar chamadas à API. O
 * erro de uma loja fica registrado naquela loja e não interrompe a outra.
 */
async function reconciliarMultiLojaSeVencida(): Promise<number> {
  const { multiStoreHabilitado } = await import('./commerce/woocommerce/registry');
  if (!multiStoreHabilitado()) return 0;
  const intervaloMin = Math.max(5, Number(process.env.WOOCOMMERCE_RECONCILIACAO_INTERVALO_MIN) || 60);
  const { lojasDaEmpresa } = await import('./commerce/woocommerce/outboxStore');
  const { estadoDaStore } = await import('./commerce/woocommerce/estado');
  const { reconciliarLojaCompleta } = await import('./commerce/woocommerce/reconciliacao');
  let detectadas = 0;
  for (const { cfg, empresaId } of lojasDaEmpresa()) {
    try {
      const estado = await estadoDaStore(empresaId, cfg.store_key);
      const ultima = estado.ultima_reconciliacao_em ? Date.parse(estado.ultima_reconciliacao_em) : 0;
      if (ultima && Date.now() - ultima < intervaloMin * 60_000) continue;
      const r = await reconciliarLojaCompleta(cfg, empresaId);
      detectadas += r.detectadas;
    } catch { /* a loja falhou; as outras seguem */ }
  }
  return detectadas;
}

/**
 * Polling de rastreio (contingência quando o operador não envia webhook).
 * Consulta o operador para as remessas vivas que já têm código e não foram
 * atualizadas dentro do intervalo configurado. Desligado por padrão (exige o
 * motor ligado). Uma remessa que falha não interrompe as demais.
 */
async function pollRastreioLogistica(): Promise<number> {
  const { logisticsHabilitado, intervaloPollMin } = await import('../../modules/logistics/application/quotes');
  if (!logisticsHabilitado()) return 0;
  const intervaloMin = intervaloPollMin();
  if (intervaloMin <= 0) return 0;
  const { carrier, CARRIER_NULO } = await import('../../modules/logistics/providers/contract');
  const { registrarCarriers } = await import('../../modules/logistics/providers/registry');
  const { sincronizarRastreio } = await import('../../modules/logistics/application/tracking');
  registrarCarriers();
  const R_ENVIO = getResource('envios')!;
  const envios = (await getStore().list(R_ENVIO, { page: 1, pageSize: 500, sort: 'atualizado_em', dir: 'asc' })).rows;
  const limite = Date.now() - intervaloMin * 60_000;
  let atualizados = 0;
  for (const envio of envios) {
    const status = String(envio.status);
    if (['entregue', 'cancelado', 'extraviado', 'pendente'].includes(status)) continue;
    if (!envio.codigo_rastreamento) continue;
    const ultimo = Date.parse(String(envio.atualizado_em || envio.criado_em || ''));
    if (Number.isFinite(ultimo) && ultimo > limite) continue;
    try {
      const adapter = carrier(String(envio.provider)) ?? CARRIER_NULO;
      const r = await sincronizarRastreio(Number(envio.empresa_id), Number(envio.id), adapter);
      if (r.ok && r.gravados > 0) atualizados += 1;
    } catch { /* a remessa falhou; as outras seguem */ }
  }
  return atualizados;
}

/**
 * Reconciliação logística periódica (contingência): compara as remessas vivas
 * de cada empresa com o operador e corrige SOMENTE divergências seguras
 * (AUTOMATICAS). Divergências financeiras/ambíguas ficam para decisão humana.
 *
 * Desligada por padrão: só roda com `LOGISTICS_RECONCILIATION_ENABLED` ligado e
 * o motor habilitado. Uma empresa indisponível não interrompe as demais, e o
 * módulo logístico NUNCA derruba a sincronização das lojas.
 */
async function reconciliarLogisticaSeHabilitada(): Promise<number> {
  const { reconciliacaoHabilitada } = await import('../../modules/logistics/application/quotes');
  if (!reconciliacaoHabilitada()) return 0;
  const { reconciliarEmpresa } = await import('../../modules/logistics/application/reconciliation');
  const empresas = (await getStore().list(getResource('empresas')!, { page: 1, pageSize: 1000 })).rows;
  let corrigidas = 0;
  for (const empresa of empresas) {
    try {
      const r = await reconciliarEmpresa(Number(empresa.id), 50);
      corrigidas += r.corrigidas;
    } catch { /* a empresa falhou; as outras seguem */ }
  }
  return corrigidas;
}

/** Recuperação de pedidos de marketplace e eventos de pedido (conversão, notificação, sincronização). */
async function executarPedidosCron(): Promise<ResultadoExecutorCron> {
  const falhas: string[] = [];
  let itens = 0;
  try { itens += await recuperarPedidosPendentes(); } catch { falhas.push('recuperacao_marketplace'); }
  try {
    itens += await enfileirarSincronizacaoMultiLoja();
  } catch { /* multi-loja desligado ou indisponível: o fluxo single-store segue */ }
  try {
    const o = await processarOutbox(10, TIPOS_OUTBOX_POR_PROCESSO.pedidos);
    itens += o.processados;
    if (o.erros) falhas.push('eventos_pedido');
  } catch { falhas.push('eventos_pedido'); }
  // Contingência: reconciliação periódica (throttled por loja) — detecta o que o
  // webhook/polling não alcançaram. Nunca escreve nas lojas.
  try { itens += await reconciliarMultiLojaSeVencida(); } catch { falhas.push('reconciliacao_multi_loja'); }
  // Contingência logística: reconcilia remessas com o operador (desligada por
  // padrão). Uma falha aqui NÃO derruba a sincronização das lojas.
  try { itens += await reconciliarLogisticaSeHabilitada(); } catch { falhas.push('reconciliacao_logistica'); }
  // Polling de rastreio: contingência quando o operador não envia webhook.
  try { itens += await pollRastreioLogistica(); } catch { falhas.push('poll_rastreio_logistica'); }
  return { itens, detalhes: [], falhas };
}

/** Lembretes de CRM. Com o canal desligado, não grava nem envia (guarda em crm.ts). */
async function executarCrmCron(): Promise<ResultadoExecutorCron> {
  const r = await dispararLembretesCrm();
  return { itens: r.disparados, detalhes: r.canal === 'desabilitado' ? ['canal de lembrete desabilitado'] : [], falhas: [] };
}

/**
 * Registro dos processos. É um objeto mutável de propósito: os testes substituem executores
 * por registradores (sem efeito externo). Não há entrada para recorrências financeiras.
 */
export const processosCron: Record<ProcessoCron, () => Promise<ResultadoExecutorCron>> = {
  relatorios: executarRelatoriosCron,
  pagamentos: executarPagamentosCron,
  publicacoes: executarPublicacoesCron,
  pedidos: executarPedidosCron,
  crm: executarCrmCron,
};

export function isProcessoCron(nome: string): nome is ProcessoCron {
  return Object.prototype.hasOwnProperty.call(processosCron, nome);
}

/** Trava por instância: impede execução concorrente do mesmo processo (409). */
const emExecucao = new Set<ProcessoCron>();

/** Somente testes multiprocessos: mantém o lease o tempo suficiente para a disputa. */
let holdDeTesteMs = 0;
export function definirHoldDeTesteCron(ms: number): void {
  holdDeTesteMs = process.env.NODE_ENV === 'test' && Number.isInteger(ms) && ms >= 0 && ms <= 10_000 ? ms : 0;
}

/**
 * Timeout padrão por processo (Ordem Final, 2.1). Sobrescrevível por CRON_TIMEOUT_<PROCESSO>_MS
 * (inteiro entre 10 000 e 1 800 000 ms; valor inválido usa o padrão).
 */
export const TIMEOUT_PADRAO_MS: Record<ProcessoCron, number> = {
  relatorios: 300_000,
  pagamentos: 240_000,
  publicacoes: 300_000,
  pedidos: 240_000,
  crm: 120_000,
};

export function timeoutProcessoMs(processo: ProcessoCron): number {
  const bruto = process.env[`CRON_TIMEOUT_${processo.toUpperCase()}_MS`];
  if (bruto !== undefined && /^\d+$/.test(bruto.trim())) {
    const n = Number(bruto.trim());
    if (Number.isInteger(n) && n >= 10_000 && n <= 1_800_000) return n;
  }
  return TIMEOUT_PADRAO_MS[processo];
}

function recusaEmExecucao(processo: ProcessoCron, inicio: Date): ResultadoProcessoCron {
  const recusa: ResultadoProcessoCron = { processo, ok: false, status: 409, itens: 0, detalhes: [], falhas: [processo], inicio: inicio.toISOString(), fim: new Date().toISOString(), motivo: 'ja_em_execucao' };
  console.warn(JSON.stringify({ evento: 'cron_processo_recusado', processo, motivo: 'ja_em_execucao' }));
  return recusa;
}

/**
 * Executa UM processo, com trava local, lock distribuído (PostgreSQL), timeout e registro.
 * - Timeout: a resposta sai com 503 (motivo `timeout`), mas a TRAVA só é liberada quando o trabalho
 *   realmente termina. Assim um timeout nunca abre espaço para execução concorrente do mesmo processo.
 * - Com DATABASE_URL, a exclusão entre instâncias é arbitrada em `cron_job_locks`. Sem banco, permanece
 *   só a trava do processo (modo demonstração).
 * - O registro (log estruturado) não contém payloads, e-mails, tokens nem mensagens de erro brutas.
 * `opcoes.limiteMs` existe somente para testes.
 */
export async function executarProcessoCron(
  processo: ProcessoCron,
  opcoes: { limiteMs?: number } = {}
): Promise<ResultadoProcessoCron> {
  const inicio = new Date();
  if (emExecucao.has(processo)) return recusaEmExecucao(processo, inicio);
  emExecucao.add(processo);
  const limite = opcoes.limiteMs ?? timeoutProcessoMs(processo);

  if (!hasDatabaseUrl() && process.env.NODE_ENV === 'production') {
    emExecucao.delete(processo);
    console.error(JSON.stringify({ evento: 'cron_operacao_bloqueada_sem_postgres', processo }));
    return { processo, ok: false, status: 503, itens: 0, detalhes: [], falhas: [processo], inicio: inicio.toISOString(), fim: new Date().toISOString(), motivo: 'erro' };
  }

  if (hasDatabaseUrl() && !isDbConnected()) {
    emExecucao.delete(processo);
    console.error(JSON.stringify({ evento: 'cron_operacao_bloqueada_banco_indisponivel', processo }));
    return { processo, ok: false, status: 503, itens: 0, detalhes: [], falhas: [processo], inicio: inicio.toISOString(), fim: new Date().toISOString(), motivo: 'erro' };
  }

  let lease: CronLease | null = null;
  if (hasDatabaseUrl()) {
    try {
      lease = await acquireCronLease(processo, leaseMsForTimeout(limite));
    } catch {
      emExecucao.delete(processo);
      console.error(JSON.stringify({ evento: 'cron_processo_falhou', processo, tipo: 'Error', motivo: 'lock_indisponivel' }));
      return { processo, ok: false, status: 503, itens: 0, detalhes: [], falhas: [processo], inicio: inicio.toISOString(), fim: new Date().toISOString(), motivo: 'erro' };
    }
    if (!lease) {
      emExecucao.delete(processo);
      return recusaEmExecucao(processo, inicio);
    }
  }

  let stopHeartbeat = () => {};
  if (lease) stopHeartbeat = startCronHeartbeat(lease, () => undefined);

  const trabalho = (async () => {
    try {
      if (process.env.NODE_ENV === 'test' && holdDeTesteMs >= 50) {
        await new Promise((r) => setTimeout(r, holdDeTesteMs));
      }
      const run = () => processosCron[processo]();
      return lease ? await runWithCronLease(lease, run) : await run();
    } finally {
      stopHeartbeat();
      if (lease) await releaseCronLease(lease).catch(() => undefined);
      emExecucao.delete(processo);
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const limitado = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), limite);
  });
  const desfecho = await Promise.race([
    trabalho.then((r) => ({ kind: 'ok' as const, r }), () => ({ kind: 'erro' as const })),
    limitado,
  ]);
  if (timer) clearTimeout(timer);

  let resultado: ResultadoProcessoCron;
  if (desfecho.kind === 'ok') {
    const falhas = desfecho.r.falhas;
    resultado = { processo, ok: falhas.length === 0, status: falhas.length ? 503 : 200, itens: desfecho.r.itens, detalhes: desfecho.r.detalhes, falhas, inicio: inicio.toISOString(), fim: new Date().toISOString() };
  } else if (desfecho.kind === 'erro') {
    // Só o tipo do erro vai para o registro: mensagem bruta pode conter dados do provedor.
    console.error(JSON.stringify({ evento: 'cron_processo_falhou', processo, tipo: 'Error' }));
    resultado = { processo, ok: false, status: 503, itens: 0, detalhes: [], falhas: [processo], inicio: inicio.toISOString(), fim: new Date().toISOString(), motivo: 'erro' };
  } else {
    console.error(JSON.stringify({ evento: 'cron_processo_timeout', processo, limite_ms: limite }));
    resultado = { processo, ok: false, status: 503, itens: 0, detalhes: [], falhas: [processo], inicio: inicio.toISOString(), fim: new Date().toISOString(), motivo: 'timeout' };
  }
  console.info(JSON.stringify({ evento: 'cron_processo', processo, ok: resultado.ok, status: resultado.status, motivo: resultado.motivo ?? null, itens: resultado.itens, falhas: resultado.falhas, inicio: resultado.inicio, fim: resultado.fim }));
  return resultado;
}

/** GET /api/admin/scheduled/run — sessão de administrador. Executa SOMENTE relatórios e o motor de negócios. */
export async function runScheduled(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Apenas administradores.');

  const relatorios = await executarProcessoCron('relatorios');
  const resultados = [...relatorios.detalhes];

  // Motor 1. MEU NEGÓCIOS: margens e curva ABC. Cálculo derivado, sem efeito externo.
  const motor = await atualizarMotorNegocios();
  if (motor.margens > 0 || motor.abc > 0) {
    resultados.push(`Motor MEU NEGÓCIOS: ${motor.margens} margem(ns), ${motor.abc} produto(s) na curva ABC`);
  }

  res.status(relatorios.ok ? 200 : 503).json({
    ok: relatorios.ok,
    executados: resultados,
    falhas: relatorios.falhas,
    // Os demais processos não rodam nesta rota. Cada um tem endpoint próprio, protegido por CRON_SECRET.
    processos_fora_desta_rota: ['pagamentos', 'publicacoes', 'pedidos', 'crm'],
    smtp: smtpConfigurado(),
  });
}

/** O cron só funciona com CRON_SECRET definido. Sem a variável, nada é executado. */
export function cronConfigurado(): boolean {
  return (process.env.CRON_SECRET || '').length > 0;
}

/** Compara o Bearer com CRON_SECRET em tempo constante (hashes de tamanho fixo). */
export function cronAutorizado(req: Request): boolean {
  const esperado = process.env.CRON_SECRET || '';
  if (!esperado) return false;
  const cabecalho = String(req.headers?.authorization || '');
  const recebido = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : '';
  if (!recebido) return false;
  const a = createHash('sha256').update(recebido).digest();
  const b = createHash('sha256').update(esperado).digest();
  return timingSafeEqual(a, b);
}

/** Resposta de autenticação do cron. Falha fechada: 503 sem a variável, 401 sem token válido. */
function recusarCron(req: Request, res: Response): boolean {
  if (!cronConfigurado()) {
    res.status(503).json({ ok: false, error: 'Cron desativado: CRON_SECRET não configurado.' });
    return true;
  }
  if (!cronAutorizado(req)) {
    res.status(401).json({ ok: false, error: 'Token inválido.' });
    return true;
  }
  return false;
}

async function cronPara(req: Request, res: Response, processo: string): Promise<void> {
  if (recusarCron(req, res)) return;
  if (!isProcessoCron(processo)) {
    res.status(404).json({ ok: false, error: 'Processo de cron desconhecido.' });
    return;
  }
  const r = await executarProcessoCron(processo);
  res.status(r.status).json({ ok: r.ok, processo: r.processo, itens: r.itens, detalhes: r.detalhes, falhas: r.falhas, inicio: r.inicio, fim: r.fim, ...(r.motivo ? { motivo: r.motivo } : {}) });
}

/** POST /api/admin/scheduled/cron — compatibilidade: executa SOMENTE o processo `relatorios`. */
export async function cronScheduled(req: Request, res: Response) {
  return cronPara(req, res, 'relatorios');
}

/** POST /api/admin/scheduled/cron/:processo — um processo por chamada (montado antes da sessão, em index.ts). */
export async function cronProcesso(req: Request, res: Response) {
  return cronPara(req, res, String(req.params?.processo ?? ''));
}

/** GET /api/admin/scheduled/status — mostra config e próximo agendamento. */
export async function scheduledStatus(_req: Request, res: Response) {
  res.json({
    smtp_configurado: smtpConfigurado(),
    destinatarios: scheduleEmails(),
    agendamentos: {
      posicao_estoque: getSchedule('POSICAO_ESTOQUE'),
      vendas: getSchedule('VENDAS'),
      alertas: getSchedule('ALERTAS'),
      producao: getSchedule('PRODUCAO'),
    },
    crm_lembretes: {
      canal_habilitado: process.env.NOTIFICAR_CRM_LEMBRETE === 'true',
      idempotente: true,
      marcador: 'crm_atividades.lembrete_enviado_em',
      executa_em: 'run (admin) e cron (CRON_SECRET)',
    },
  });
}
