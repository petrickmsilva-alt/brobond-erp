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
//           POST /api/admin/scheduled/cron — chamado por cron externo (ex.: cron-job.org)
// ============================================================
import { createHash, timingSafeEqual } from 'node:crypto';
import { coletarFalhasEntrega, htmlSecaoFalhasEntrega } from './alertasFalhas';
import { enviarEmail, smtpConfigurado } from './mail';
import { hasDatabaseUrl } from './db';
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
import { processarComercioAgendado } from './commerce/outbox';

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

export async function runScheduled(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Apenas administradores.');

  const resultados: string[] = [];

  if (deveExecutar(getSchedule('POSICAO_ESTOQUE'))) {
    await relatorioPosicaoEstoque();
    resultados.push('Posição de estoque');
  }
  if (deveExecutar(getSchedule('VENDAS'))) {
    await relatorioVendas();
    resultados.push('Vendas');
  }
  if (deveExecutar(getSchedule('ALERTAS'))) {
    await relatorioAlertas();
    resultados.push('Alertas');
  }
  const pedidos = await recuperarPedidosPendentes();
  if (pedidos > 0) resultados.push(`${pedidos} pedido(s) de marketplace recuperado(s)`);
  // CRM — lembretes de atividade: disparo IDEMPOTENTE pelo agendador que já
  // existe (nada de polling no navegador, nada de scheduler paralelo).
  const lembretes = await dispararLembretesCrm();
  if (lembretes.disparados > 0) resultados.push(`${lembretes.disparados} lembrete(s) de CRM`);

  // Motor 1. MEU NEGÓCIOS: margens e curva ABC sempre frescas — a rotina
  // roda junto com o cron de agendados (segunda via do ciclo contínuo).
  const motor = await atualizarMotorNegocios();
  if (motor.margens > 0 || motor.abc > 0) {
    resultados.push(`Motor MEU NEGÓCIOS: ${motor.margens} margem(ns), ${motor.abc} produto(s) na curva ABC`);
  }

  // BACKSTOP do Commerce OS: fila de publicação + outbox de sincronização +
  // expiração de checkouts pendentes (idempotente — rodar duas vezes não
  // duplica efeito nem religa reserva liberada).
  const commerce = await processarComercioAgendado();
  const comercioItens = [
    commerce.publicacoes.processadas,
    commerce.outbox.processados,
    commerce.expirados,
  ].reduce((a, b) => a + b, 0);
  if (comercioItens > 0 || commerce.outbox.erros > 0) {
    resultados.push(
      `Commerce: ${commerce.publicacoes.processadas} publicação(ões), ${commerce.outbox.processados} fila(s), ${commerce.expirados} expirado(s)${commerce.outbox.erros ? `, ${commerce.outbox.erros} erro(s)` : ''}`
    );
  }

  res.status(commerce.falhas.length ? 503 : 200).json({ ok: commerce.falhas.length === 0, executados: resultados, falhas_commerce: commerce.falhas, smtp: smtpConfigurado() });
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

/** POST /api/admin/scheduled/cron — endpoint para cron externo (montado antes da sessão, em index.ts). */
export async function cronScheduled(req: Request, res: Response) {
  // R-4 (Fase 4.2) — contrato do cron externo (ver docs/auditoria/fase-4-2-correcoes.md):
  // autentica SOMENTE por `Authorization: Bearer <CRON_SECRET>`; sem a variável, falha fechado (503);
  // não aceita sessão de usuário; não executa recorrências financeiras (fluxo próprio).
  if (!cronConfigurado()) throw new HttpError(503, 'Cron desativado: CRON_SECRET não configurado.');
  if (!cronAutorizado(req)) throw new HttpError(401, 'Token inválido.');

  const resultados: string[] = [];
  if (deveExecutar(getSchedule('POSICAO_ESTOQUE'))) { await relatorioPosicaoEstoque(); resultados.push('estoque'); }
  if (deveExecutar(getSchedule('VENDAS'))) { await relatorioVendas(); resultados.push('vendas'); }
  if (deveExecutar(getSchedule('ALERTAS'))) { await relatorioAlertas(); resultados.push('alertas'); }
  const pedidos = await recuperarPedidosPendentes();
  if (pedidos > 0) resultados.push(`${pedidos} pedido(s) de marketplace`);
  const lembretesCron = await dispararLembretesCrm();
  if (lembretesCron.disparados > 0) resultados.push(`${lembretesCron.disparados} lembrete(s) de CRM`);
  const commerceCron = await processarComercioAgendado();
  const comercioCron = commerceCron.publicacoes.processadas + commerceCron.outbox.processados + commerceCron.expirados;
  if (comercioCron > 0 || commerceCron.outbox.erros > 0) {
    resultados.push(`commerce: ${comercioCron} item(ns) da fila${commerceCron.outbox.erros ? `, ${commerceCron.outbox.erros} erro(s)` : ''}`);
  }

  res.status(commerceCron.falhas.length ? 503 : 200).json({ ok: commerceCron.falhas.length === 0, executados: resultados, falhas_commerce: commerceCron.falhas });
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
