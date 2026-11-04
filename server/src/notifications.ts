// ============================================================
// Módulo de Notificações — envia alertas por e-mail para eventos do sistema.
//
// Eventos notificados:
//   • estoque_minimo — produto abaixo do estoque mínimo
//   • insumo_minimo — insumo abaixo do mínimo
//   • op_concluida — ordem de fabricação concluída
//   • pedido_faturado — venda faturada
//   • compra_recebida — compra recebida
//   • estoque_zerado — produto com saldo zero
//
// Configuração (env):
//   NOTIFICAR_EMAILS=admin@brobond.com.br,gerente@brobond.com.br
//   NOTIFICAR_ESTOQUE_MIN=true  (padrão: true)
//   NOTIFICAR_OP_CONCLUIDA=true (padrão: false)
//   NOTIFICAR_PEDIDO=true       (padrão: false)
// ============================================================
import { enviarEmail, smtpConfigurado, verificarConexaoSmtp } from './mail';
import { destinosPorEmpresa } from './destinatariosEmpresa';
import { currentUser } from './auth';
import type { Request, Response } from 'express';
import { getStore } from './services';
import { getResource } from './resources';
import { labelOf } from './store';

const fmtMoney = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Evento =
  | 'estoque_minimo'
  | 'insumo_minimo'
  | 'op_concluida'
  | 'pedido_faturado'
  | 'compra_recebida'
  | 'estoque_zerado'
  | 'crm_lembrete';

type NotifOpts = {
  assunto: string;
  html: string;
  evento: Evento;
  /** Empresa dona dos dados do e-mail (obrigatória para envio). */
  empresaId?: number;
  /** Recursos cujos dados o e-mail contém: o destinatário precisa de leitura em todos. */
  recursos?: string[];
};

/**
 * Empresa dona do registro, lida SOMENTE da própria linha (R-12). Sem `empresa_id` válido,
 * devolve `undefined` e a notificação não é enviada: não há fallback para a lista global.
 */
function empresaDoRegistro(row: Record<string, unknown> | null | undefined): number | undefined {
  const id = Number(row?.empresa_id);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

/** Lista de e-mails configurada. É só um FILTRO de candidatos: nunca amplia destinatários. */
function destinatarios(): string[] {
  return (process.env.NOTIFICAR_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function habilitado(evento: Evento): boolean {
  switch (evento) {
    case 'estoque_minimo':
    case 'insumo_minimo':
    case 'estoque_zerado':
      return process.env.NOTIFICAR_ESTOQUE_MIN !== 'false';
    case 'op_concluida':
      return process.env.NOTIFICAR_OP_CONCLUIDA === 'true';
    case 'pedido_faturado':
    case 'compra_recebida':
      return process.env.NOTIFICAR_PEDIDO === 'true';
    // Lembrete de CRM é OPCIONAL e vem desligado: sem SMTP configurado, o
    // lembrete continua aparecendo na Agenda (hoje/atrasadas/próximas) e não
    // faz sentido carimbar "enviado" o que não foi enviado.
    case 'crm_lembrete':
      return process.env.NOTIFICAR_CRM_LEMBRETE === 'true';
    default:
      return false;
  }
}

/** Envio injetável (testes). Em produção, é o `enviarEmail` real. */
export type EnviadorNotificacao = (opts: { to: string; assunto: string; html: string }) => Promise<unknown>;

/**
 * Envia notificação SOMENTE para os destinatários autorizados da empresa de `opts.empresaId`
 * (R-12, Fase 4.2). Sem empresa explícita, não envia: a lista global (NOTIFICAR_EMAILS) não
 * recebe dados de negócio de nenhuma empresa.
 */
async function enviar(opts: NotifOpts, enviador: EnviadorNotificacao = enviarEmail): Promise<number> {
  if (!habilitado(opts.evento)) return 0;
  if (!(Number(opts.empresaId) > 0) || !opts.recursos?.length) {
    console.warn(`[notificacao] ${opts.evento}: sem empresa explícita ou recursos; não enviada.`);
    return 0;
  }
  const destino = (await destinosPorEmpresa(destinatarios(), opts.recursos)).find((d) => d.empresaId === Number(opts.empresaId));
  if (!destino || !destino.emails.length) return 0;

  const htmlBase = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1B2A4A;color:white;padding:16px 24px;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;font-size:18px;">🔔 BROBOND ERP</h2>
      </div>
      <div style="background:#fff;border:1px solid #e2e8f0;padding:24px;border-radius:0 0 8px 8px;">
        ${opts.html}
      </div>
      <p style="text-align:center;color:#999;font-size:11px;margin-top:12px;">
        Notificação automática do BROBOND ERP — ${new Date().toLocaleString('pt-BR')}
      </p>
    </div>`;

  let enviados = 0;
  for (const email of destino.emails) {
    try {
      await enviador({ to: email, assunto: opts.assunto, html: htmlBase });
      enviados += 1;
    } catch {
      console.warn('⚠️  Falha ao preparar notificação de e-mail.');
    }
  }
  return enviados;
}

// ----------------------------------------------------------------------------
// Notificações específicas
// ----------------------------------------------------------------------------

/** Notifica quando produto está abaixo do estoque mínimo. */
export async function notificarEstoqueMinimo(produtoId: number, tamanhoId: number, local: string, quantidade: number, minimo: number, enviador: EnviadorNotificacao = enviarEmail): Promise<void> {
  const s = getStore();
  const produto = await s.findOneWhere(getResource('produtos')!, { id: produtoId });
  const tamanho = await s.findOneWhere(getResource('tamanhos')!, { id: tamanhoId });
  const nome = produto ? labelOf(getResource('produtos')!, produto) : `#${produtoId}`;
  const tam = tamanho ? String(tamanho.codigo) : '';

  await enviar({
    evento: 'estoque_minimo',
    empresaId: empresaDoRegistro(produto),
    recursos: ['produtos', 'estoques'],
    assunto: `⚠️ Estoque mínimo: ${nome} (${tam}) em ${local}`,
    html: `
      <h3 style="color:#C53030;margin-top:0;">Estoque abaixo do mínimo</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:4px 0;color:#666;">Produto:</td><td style="padding:4px 0;font-weight:bold;">${nome}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Tamanho:</td><td style="padding:4px 0;">${tam || '—'}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Local:</td><td style="padding:4px 0;">${local}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Saldo atual:</td><td style="padding:4px 0;color:#C53030;font-weight:bold;">${quantidade}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Estoque mínimo:</td><td style="padding:4px 0;">${minimo}</td></tr>
      </table>
      <p style="margin-top:16px;">Acesse o módulo <strong>Estoque Físico</strong> para regularizar.</p>`,
  }, enviador);
}

/** Notifica quando insumo está abaixo do mínimo. */
export async function notificarInsumoMinimo(insumoId: number, quantidade: number, minimo: number, enviador: EnviadorNotificacao = enviarEmail): Promise<void> {
  const s = getStore();
  const insumo = await s.findOneWhere(getResource('insumos')!, { id: insumoId });
  const nome = insumo ? labelOf(getResource('insumos')!, insumo) : `#${insumoId}`;
  const un = insumo?.unidade || 'un';

  await enviar({
    evento: 'insumo_minimo',
    empresaId: empresaDoRegistro(insumo),
    recursos: ['insumos', 'estoque_insumos'],
    assunto: `⚠️ Insumo em alerta: ${nome}`,
    html: `
      <h3 style="color:#D97706;margin-top:0;">Insumo abaixo do mínimo</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:4px 0;color:#666;">Insumo:</td><td style="padding:4px 0;font-weight:bold;">${nome}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Saldo atual:</td><td style="padding:4px 0;color:#D97706;font-weight:bold;">${quantidade} ${un}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Mínimo:</td><td style="padding:4px 0;">${minimo} ${un}</td></tr>
      </table>
      <p style="margin-top:16px;">Verifique a necessidade de compra no módulo <strong>Compras</strong>.</p>`,
  }, enviador);
}

/** Notifica quando OP é concluída. */
export async function notificarOPConcluida(ordemId: number, produtoId: number, totalPecas: number, usuario: string, enviador: EnviadorNotificacao = enviarEmail): Promise<void> {
  const s = getStore();
  const produto = await s.findOneWhere(getResource('produtos')!, { id: produtoId });
  const nome = produto ? labelOf(getResource('produtos')!, produto) : `#${produtoId}`;

  await enviar({
    evento: 'op_concluida',
    empresaId: empresaDoRegistro(produto),
    recursos: ['produtos'],
    assunto: `✅ OP #${ordemId} concluída — ${totalPecas} peça(s)`,
    html: `
      <h3 style="color:#059669;margin-top:0;">Ordem de Fabricação Concluída</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:4px 0;color:#666;">OP:</td><td style="padding:4px 0;font-weight:bold;">#${ordemId}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Produto:</td><td style="padding:4px 0;">${nome}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Peças produzidas:</td><td style="padding:4px 0;font-weight:bold;">${totalPecas}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Concluída por:</td><td style="padding:4px 0;">${usuario}</td></tr>
      </table>
      <p style="margin-top:16px;">As peças já estão disponíveis no estoque (loja).</p>`,
  }, enviador);
}

/** Notifica quando venda é faturada. */
export async function notificarVendaFaturada(vendaId: number, clienteId: number | null, total: number, usuario: string, enviador: EnviadorNotificacao = enviarEmail): Promise<void> {
  const s = getStore();
  const venda = await s.findOneWhere(getResource('vendas')!, { id: vendaId });
  const cliente = clienteId ? await s.findOneWhere(getResource('clientes')!, { id: clienteId }) : null;
  const nomeCliente = cliente ? labelOf(getResource('clientes')!, cliente) : 'Cliente não informado';

  await enviar({
    evento: 'pedido_faturado',
    empresaId: empresaDoRegistro(venda),
    recursos: ['vendas', 'clientes'],
    assunto: `📦 Venda #${vendaId} faturada — R$ ${fmtMoney(total)}`,
    html: `
      <h3 style="color:#059669;margin-top:0;">Pedido de Venda Faturado</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:4px 0;color:#666;">Pedido:</td><td style="padding:4px 0;font-weight:bold;">#${vendaId}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Cliente:</td><td style="padding:4px 0;">${nomeCliente}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Total:</td><td style="padding:4px 0;font-weight:bold;font-size:16px;">R$ ${fmtMoney(total)}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Faturado por:</td><td style="padding:4px 0;">${usuario}</td></tr>
      </table>
      <p style="margin-top:16px;">As peças saíram do estoque automaticamente.</p>`,
  }, enviador);
}

/** Notifica quando compra é recebida. */
export async function notificarCompraRecebida(compraId: number, fornecedorId: number | null, total: number, usuario: string, enviador: EnviadorNotificacao = enviarEmail): Promise<void> {
  const s = getStore();
  const compra = await s.findOneWhere(getResource('compras')!, { id: compraId });
  const fornecedor = fornecedorId ? await s.findOneWhere(getResource('fornecedores')!, { id: fornecedorId }) : null;
  const nomeForn = fornecedor ? labelOf(getResource('fornecedores')!, fornecedor) : 'Fornecedor não informado';

  await enviar({
    evento: 'compra_recebida',
    empresaId: empresaDoRegistro(compra),
    recursos: ['compras', 'fornecedores'],
    assunto: `📥 Compra #${compraId} recebida — R$ ${fmtMoney(total)}`,
    html: `
      <h3 style="color:#2563EB;margin-top:0;">Pedido de Compra Recebido</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:4px 0;color:#666;">Compra:</td><td style="padding:4px 0;font-weight:bold;">#${compraId}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Fornecedor:</td><td style="padding:4px 0;">${nomeForn}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Total:</td><td style="padding:4px 0;font-weight:bold;font-size:16px;">R$ ${fmtMoney(total)}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Recebido por:</td><td style="padding:4px 0;">${usuario}</td></tr>
      </table>
      <p style="margin-top:16px;">Os insumos entraram no estoque e o custo médio foi atualizado.</p>`,
  }, enviador);
}

/** O canal de lembrete do CRM está ligado? (o agendador consulta ANTES de carimbar) */
export function crmLembreteHabilitado(): boolean {
  return habilitado('crm_lembrete');
}

/**
 * Lembrete de atividade do CRM (chamado pelo agendador, não pela tela).
 *
 * O disparo é IDEMPOTENTE por construção: quem chama já reivindicou a atividade
 * com `UPDATE ... WHERE lembrete_enviado_em IS NULL` (ver
 * `dispararLembretesCrm` em `crm.ts`). Aqui só resta notificar — e o canal é o
 * mesmo dos outros avisos do ERP (SMTP configurado em Configurações).
 *
 * Não carimba o lembrete: quem chama só confirma `lembrete_enviado_em` depois
 * de um retorno verdadeiro (entrega pedida ao canal).
 */
export async function notificarLembreteCrm(params: {
  empresaId: number;
  atividadeId: number;
  tipo: string;
  resumo: string;
  quando: unknown;
  prioridade: string;
  lead: string | null;
  oportunidade: string | null;
}, enviador: EnviadorNotificacao = enviarEmail): Promise<boolean> {
  if (enviador === enviarEmail && !smtpConfigurado()) return false;
  const quando = params.quando ? new Date(String(params.quando)) : null;
  const quandoTxt = quando && !Number.isNaN(quando.getTime()) ? quando.toLocaleString('pt-BR') : '—';
  const alvo = params.oportunidade ?? params.lead ?? 'sem vínculo';
  const enviados = await enviar({
    evento: 'crm_lembrete',
    empresaId: params.empresaId,
    recursos: ['crm_atividades'],
    assunto: `⏰ Lembrete CRM: ${params.tipo} — ${alvo}`,
    html: `
      <h3 style="color:#1B2A4A;margin-top:0;">Lembrete de atividade</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:4px 0;color:#666;">Atividade:</td><td style="padding:4px 0;font-weight:bold;">#${params.atividadeId} · ${params.tipo}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Vínculo:</td><td style="padding:4px 0;">${alvo}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Quando:</td><td style="padding:4px 0;">${quandoTxt}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Prioridade:</td><td style="padding:4px 0;">${params.prioridade}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Resumo:</td><td style="padding:4px 0;">${params.resumo || '—'}</td></tr>
      </table>
      <p style="margin-top:16px;">Abra <strong>CRM › Agenda</strong> para concluir ou remarcar.</p>`,
  }, enviador);
  return enviados > 0;
}

/** Verificação periódica de estoques mínimos (chamada pelo dashboard ou cron). */
export async function verificarAlertasEstoque(): Promise<{ produtos: number; insumos: number }> {
  const s = getStore();
  let produtos = 0;
  let insumos = 0;

  // Produtos abaixo do mínimo
  const estoques = await s.list(getResource('estoques')!, { page: 1, pageSize: 5000 });
  for (const e of estoques.rows) {
    if (Number(e.estoque_min) > 0 && Number(e.quantidade) <= Number(e.estoque_min)) {
      produtos++;
    }
  }

  // Insumos abaixo do mínimo
  const insumosEst = await s.list(getResource('estoque_insumos')!, { page: 1, pageSize: 2000 });
  for (const ei of insumosEst.rows) {
    if (Number(ei.estoque_min) > 0 && Number(ei.quantidade) <= Number(ei.estoque_min)) {
      insumos++;
    }
  }

  return { produtos, insumos };
}

/** Status do módulo de notificações (para a tela de Configurações). */
export function notificacoesStatus() {
  return {
    smtp_configurado: smtpConfigurado(),
    // R-12: a lista global não é exposta. Destinatários são por empresa (vínculo + vigência + RBAC).
    escopo_destinatarios: 'por_empresa',
    candidatos_configurados: destinatarios().length,
    habilitados: {
      estoque_minimo: habilitado('estoque_minimo'),
      insumo_minimo: habilitado('insumo_minimo'),
      op_concluida: habilitado('op_concluida'),
      pedido_faturado: habilitado('pedido_faturado'),
      compra_recebida: habilitado('compra_recebida'),
      crm_lembrete: habilitado('crm_lembrete'),
    },
  };
}

/** POST /api/admin/notificacoes/smtp/verificar — prova a conexão SMTP sem enviar e-mail. */
export async function verificarSmtpHandler(_req: Request, res: Response): Promise<void> {
  res.json(await verificarConexaoSmtp());
}

/**
 * POST /api/admin/notificacoes/smtp/teste — envia UMA mensagem de teste ao próprio
 * administrador (nunca a destinatário informado na requisição, para não virar envio arbitrário).
 */
export async function enviarTesteSmtpHandler(req: Request, res: Response): Promise<void> {
  const email = String(currentUser(req)?.email ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    res.status(400).json({ error: 'Sua conta não tem e-mail cadastrado para receber o teste.' });
    return;
  }
  const resultado = await enviarEmail({
    to: email,
    assunto: 'Teste de envio — Brobond ERP',
    html: '<p>Mensagem de teste de envio SMTP, solicitada por um administrador.</p>',
  });
  const [usuario, dominio] = email.split('@');
  res.json({ resultado, destino: `${usuario.slice(0, 2)}***@${dominio}` });
}
