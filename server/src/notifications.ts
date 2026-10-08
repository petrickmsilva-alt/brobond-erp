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
import { enviarEmail, smtpConfigurado } from './mail';
import { escopoDe, getStore, storeDoAtor, type EscopoOuAtor } from './services';
import { getResource } from './resources';
import { labelOf } from './store';

const fmtMoney = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Evento = 'estoque_minimo' | 'insumo_minimo' | 'op_concluida' | 'pedido_faturado' | 'compra_recebida' | 'estoque_zerado';

type NotifOpts = {
  assunto: string;
  html: string;
  evento: Evento;
};

/** Lista de e-mails que recebem notificações. */
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
    default:
      return false;
  }
}

/** Envia notificação para todos os destinatários configurados. */
async function enviar(opts: NotifOpts): Promise<void> {
  if (!habilitado(opts.evento)) return;
  const emails = destinatarios();
  if (!emails.length) return;

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

  for (const email of emails) {
    await enviarEmail({ to: email, assunto: opts.assunto, html: htmlBase }).catch((e: any) => {
      console.warn(`⚠️  Falha ao enviar notificação para ${email}:`, e?.message);
    });
  }
}

// ----------------------------------------------------------------------------
// Notificações específicas
// ----------------------------------------------------------------------------

/** Notifica quando produto está abaixo do estoque mínimo. */
export async function notificarEstoqueMinimo(produtoId: number, tamanhoId: number, local: string, quantidade: number, minimo: number): Promise<void> {
  const s = getStore();
  const produto = await s.findOneWhere(getResource('produtos')!, { id: produtoId });
  const tamanho = await s.findOneWhere(getResource('tamanhos')!, { id: tamanhoId });
  const nome = produto ? labelOf(getResource('produtos')!, produto) : `#${produtoId}`;
  const tam = tamanho ? String(tamanho.codigo) : '';

  await enviar({
    evento: 'estoque_minimo',
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
  });
}

/** Notifica quando insumo está abaixo do mínimo. */
export async function notificarInsumoMinimo(insumoId: number, quantidade: number, minimo: number): Promise<void> {
  const s = getStore();
  const insumo = await s.findOneWhere(getResource('insumos')!, { id: insumoId });
  const nome = insumo ? labelOf(getResource('insumos')!, insumo) : `#${insumoId}`;
  const un = insumo?.unidade || 'un';

  await enviar({
    evento: 'insumo_minimo',
    assunto: `⚠️ Insumo em alerta: ${nome}`,
    html: `
      <h3 style="color:#D97706;margin-top:0;">Insumo abaixo do mínimo</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:4px 0;color:#666;">Insumo:</td><td style="padding:4px 0;font-weight:bold;">${nome}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Saldo atual:</td><td style="padding:4px 0;color:#D97706;font-weight:bold;">${quantidade} ${un}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Mínimo:</td><td style="padding:4px 0;">${minimo} ${un}</td></tr>
      </table>
      <p style="margin-top:16px;">Verifique a necessidade de compra no módulo <strong>Compras</strong>.</p>`,
  });
}

/** Notifica quando OP é concluída. */
export async function notificarOPConcluida(ordemId: number, produtoId: number, totalPecas: number, usuario: string): Promise<void> {
  const s = getStore();
  const produto = await s.findOneWhere(getResource('produtos')!, { id: produtoId });
  const nome = produto ? labelOf(getResource('produtos')!, produto) : `#${produtoId}`;

  await enviar({
    evento: 'op_concluida',
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
  });
}

/** Notifica quando venda é faturada. */
export async function notificarVendaFaturada(vendaId: number, clienteId: number | null, total: number, usuario: string): Promise<void> {
  const s = getStore();
  const cliente = clienteId ? await s.findOneWhere(getResource('clientes')!, { id: clienteId }) : null;
  const nomeCliente = cliente ? labelOf(getResource('clientes')!, cliente) : 'Cliente não informado';

  await enviar({
    evento: 'pedido_faturado',
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
  });
}

/** Notifica quando compra é recebida. */
export async function notificarCompraRecebida(compraId: number, fornecedorId: number | null, total: number, usuario: string): Promise<void> {
  const s = getStore();
  const fornecedor = fornecedorId ? await s.findOneWhere(getResource('fornecedores')!, { id: fornecedorId }) : null;
  const nomeForn = fornecedor ? labelOf(getResource('fornecedores')!, fornecedor) : 'Fornecedor não informado';

  await enviar({
    evento: 'compra_recebida',
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
  });
}

/**
 * Verificação de estoques mínimos (dashboard admin ou cron).
 *
 * MULTIEMPRESA: com um escopo, a contagem é SÓ da empresa ativa — o resumo de
 * uma empresa nunca soma o estoque de outra. Sem escopo (cron de sistema), a
 * contagem é consolidada de propósito: é o panorama do grupo, não uma tela de
 * empresa.
 */
export async function verificarAlertasEstoque(escopo?: EscopoOuAtor): Promise<{ produtos: number; insumos: number }> {
  const s = escopo ? storeDoAtor(escopo) : getStore();
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
    destinatarios: destinatarios(),
    habilitados: {
      estoque_minimo: habilitado('estoque_minimo'),
      insumo_minimo: habilitado('insumo_minimo'),
      op_concluida: habilitado('op_concluida'),
      pedido_faturado: habilitado('pedido_faturado'),
      compra_recebida: habilitado('compra_recebida'),
    },
  };
}
