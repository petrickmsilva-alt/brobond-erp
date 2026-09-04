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
import { enviarEmail, smtpConfigurado } from './mail';
import { getStore } from './services';
import { getResource } from './resources';
import { labelOf } from './store';
import { HttpError } from './errors';
import type { Request, Response } from 'express';
import { currentUser } from './auth';

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

async function enviarRelatorio(assunto: string, html: string): Promise<void> {
  const emails = scheduleEmails();
  if (!emails.length) {
    console.log('[schedule] Nenhum e-mail configurado para relatórios agendados.');
    return;
  }

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
    await enviarEmail({ to: email, assunto: `📊 ${assunto}`, html: htmlBase }).catch((e: any) => {
      console.warn(`⚠️  Falha ao enviar relatório para ${email}:`, e?.message);
    });
  }
}

// ----------------------------------------------------------------------------
// Relatórios individuais
// ----------------------------------------------------------------------------

async function relatorioPosicaoEstoque(): Promise<void> {
  const s = getStore();
  const [produtos, estoques] = await Promise.all([
    s.list(getResource('produtos')!, { page: 1, pageSize: 2000 }),
    s.list(getResource('estoques')!, { page: 1, pageSize: 5000 }),
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

  await enviarRelatorio(`Posição de Estoque — ${new Date().toLocaleDateString('pt-BR')}`, html);
}

async function relatorioVendas(): Promise<void> {
  const s = getStore();
  const dias = getSchedule('VENDAS') === 'daily' ? 1 : 7;
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);
  const desdeStr = desde.toISOString().slice(0, 10);

  const vendas = await s.list(getResource('vendas')!, { page: 1, pageSize: 1000, sort: 'faturada_em', dir: 'desc' });
  const faturadas = vendas.rows.filter((v) => ['faturada', 'entregue'].includes(String(v.status)) && String(v.faturada_em || '').slice(0, 10) >= desdeStr);

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
        ${faturadas.slice(0, 10).map((v) => `<tr><td style="padding:4px 6px;border-bottom:1px solid #eee;">#${v.id}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;">${String(v.faturada_em || v.data || '').slice(0, 10)}</td><td style="padding:4px 6px;text-align:right;border-bottom:1px solid #eee;font-weight:bold;">R$ ${fmtMoney(Number(v.total || 0))}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;">${v.status}</td></tr>`).join('')}
      </tbody>
    </table>`;

  await enviarRelatorio(`Vendas — últimos ${dias} dia${dias > 1 ? 's' : ''}`, html);
}

async function relatorioAlertas(): Promise<void> {
  const s = getStore();
  const [estoques, insumosEst] = await Promise.all([
    s.list(getResource('estoques')!, { page: 1, pageSize: 5000 }),
    s.list(getResource('estoque_insumos')!, { page: 1, pageSize: 2000 }),
  ]);

  const produtos = await s.list(getResource('produtos')!, { page: 1, pageSize: 2000 });
  const insumos = await s.list(getResource('insumos')!, { page: 1, pageSize: 2000 });

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

  await enviarRelatorio(`Alertas de Estoque — ${new Date().toLocaleDateString('pt-BR')}`, html);
}

// ----------------------------------------------------------------------------
// Rotas
// ----------------------------------------------------------------------------

/** GET /api/admin/scheduled/run — executa todos os relatórios agendados (admin). */
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

  res.json({ ok: true, executados: resultados, smtp: smtpConfigurado() });
}

/** POST /api/admin/scheduled/cron — endpoint para cron externo. */
export async function cronScheduled(req: Request, res: Response) {
  // Autenticação por token secreto (CRON_SECRET env var)
  const token = String(req.headers.authorization || '').replace('Bearer ', '');
  const secret = process.env.CRON_SECRET || '';
  if (secret && token !== secret) {
    throw new HttpError(401, 'Token inválido.');
  }

  const resultados: string[] = [];
  if (deveExecutar(getSchedule('POSICAO_ESTOQUE'))) { await relatorioPosicaoEstoque(); resultados.push('estoque'); }
  if (deveExecutar(getSchedule('VENDAS'))) { await relatorioVendas(); resultados.push('vendas'); }
  if (deveExecutar(getSchedule('ALERTAS'))) { await relatorioAlertas(); resultados.push('alertas'); }

  res.json({ ok: true, executados: resultados });
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
  });
}
