// ============================================================================
// FASE 8 — ALERTAS CONFIGURÁVEIS (AI CONTROL TOWER).
//
// Este módulo transforma INDICADOR em AÇÃO: responde "o que exige atenção
// agora, com qual severidade, quem já viu e o que já foi resolvido?". Ele é a
// camada de LEITURA e NOTIFICAÇÃO — NÃO é um motor de operação:
//
//   • os detectores leem apenas documentos CANÔNICOS do ERP (estoque canônico,
//     vendas, financeiro, fila/outbox, pedidos omnichannel, tickets, divergências
//     da Fase 6). Nenhum número é inventado: quando não há dado, não há alerta;
//   • alertar NÃO é agir: nenhum detector altera preço, estoque, pagamento,
//     pedido, financeiro ou campanha. A recomendação de correção é texto;
//   • a ocorrência é idempotente por `fingerprint` (UNIQUE por empresa): a mesma
//     ocorrência REABRE quando volta a existir e é RESOLVIDA quando deixa de ser
//     detectada — a trilha não empilha linhas nem esconde recaída;
//   • deduplicação de NOTIFICAÇÃO por `frequencia_minima_min`; silenciamento por
//     `silenciado_ate` (regra ou ocorrência) suprime o aviso, não a evidência.
//
// Multiempresa: toda função exige `empresaId` e recorta por ele. Nada cruza
// empresa; a Control Tower monta a visão de UMA empresa.
// ============================================================================
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { currentUser } from './auth';
import { escopoDoAtor, escopoDeSistema } from './empresa';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, checkFluxoEscrita, getStore } from './services';
import { disponibilidadesPorTamanho } from './commerce/catalogo';
import type { Row, Tx } from './store';

type S = ReturnType<typeof getStore>;

export const DOMINIOS_ALERTA = [
  'estoque', 'vendas', 'financeiro', 'operacao', 'atendimento', 'marketing', 'integracoes',
] as const;
export type DominioAlerta = (typeof DOMINIOS_ALERTA)[number];

export const SEVERIDADES_ALERTA = ['baixa', 'media', 'alta', 'critica'] as const;
export type SeveridadeAlerta = (typeof SEVERIDADES_ALERTA)[number];

const RANK: Record<SeveridadeAlerta, number> = { baixa: 0, media: 1, alta: 2, critica: 3 };

export type Ocorrencia = {
  chave: string;
  titulo: string;
  detalhe: string;
  evidencia: Record<string, unknown>;
  severidade?: SeveridadeAlerta;
};

export type Detector = {
  chave: string;
  nome: string;
  dominio: DominioAlerta;
  severidade: SeveridadeAlerta;
  /** Limiares default (unidade definida pelo próprio detector). */
  limiar: Record<string, number>;
  detectar: (ctx: ContextoDeteccao) => Promise<Ocorrencia[]>;
};

export type ContextoDeteccao = {
  s: S;
  empresaId: number;
  limiar: Record<string, number>;
  agora: Date;
};

function num(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

async function listarTudo(s: S, key: string, empresaId: number, filtro: Record<string, unknown> = {}, tx?: Tx): Promise<Row[]> {
  const r = getResource(key)!;
  const p = await s.list(r, { page: 1, pageSize: 50_000, filter: { ...filtro, empresa_id: empresaId } }, tx);
  return p.rows;
}

function periodoDe(iso: unknown): string {
  const d = iso ? new Date(String(iso)) : new Date();
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}

function periodoAnterior(agora: Date): { atual: string; anterior: string } {
  const atual = `${agora.getUTCFullYear()}-${String(agora.getUTCMonth() + 1).padStart(2, '0')}`;
  const d = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 1, 1));
  const anterior = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return { atual, anterior };
}

const LIMITE_CANDIDATOS_ESTOQUE = 2000;

// ----------------------------------------------------------------------------
// DETECTORES — cada um lê um documento canônico real e devolve ocorrências.
// ----------------------------------------------------------------------------

const detRupturaEstoque: Detector = {
  chave: 'ruptura_estoque',
  nome: 'Ruptura de estoque com venda recente',
  dominio: 'estoque',
  severidade: 'alta',
  limiar: { janela_vendas_dias: 30, maximo_produtos: LIMITE_CANDIDATOS_ESTOQUE },
  async detectar({ s, empresaId, limiar, agora }) {
    const produtos = await listarTudo(s, 'produtos', empresaId);
    const vendas = await listarTudo(s, 'vendas', empresaId);
    const itens = await listarTudo(s, 'itens_venda', empresaId);
    const limite = agora.getTime() - num(limiar.janela_vendas_dias, 30) * 86_400_000;
    const vendasRecentes = new Set(
      vendas.filter((v) => ['faturada', 'entregue'].includes(String(v.status)) && new Date(String(v.faturada_em || v.data || 0)).getTime() >= limite).map((v) => Number(v.id)),
    );
    const produtosComVenda = new Set(itens.filter((it) => vendasRecentes.has(Number(it.venda_id))).map((it) => Number(it.produto_id)));
    const candidatos = produtos
      .filter((p) => p.ativo !== false && produtosComVenda.has(Number(p.id)))
      .slice(0, num(limiar.maximo_produtos, LIMITE_CANDIDATOS_ESTOQUE));
    const ocorrencias: Ocorrencia[] = [];
    for (const p of candidatos) {
      let disponivel: number;
      try {
        const linhas = await disponibilidadesPorTamanho(escopoDeSistema(empresaId), Number(p.id));
        disponivel = linhas.reduce((acc, l) => acc + Math.max(0, Number(l.disponivel || 0)), 0);
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) break; // empresa sem local de estoque ativo: saldo indeterminado
        throw e;
      }
      if (disponivel > 0) continue;
      ocorrencias.push({
        chave: `produto:${Number(p.id)}`,
        titulo: `Ruptura: ${String(p.nome)}`,
        detalhe: `Produto ativo com venda nos últimos ${num(limiar.janela_vendas_dias, 30)} dias e disponibilidade zerada.`,
        evidencia: { produto_id: Number(p.id), sku: p.sku ?? null, disponivel },
      });
    }
    return ocorrencias;
  },
};

const detAbaixoMinimo: Detector = {
  chave: 'estoque_abaixo_minimo',
  nome: 'Estoque abaixo do mínimo',
  dominio: 'estoque',
  severidade: 'media',
  limiar: { maximo_produtos: LIMITE_CANDIDATOS_ESTOQUE },
  async detectar({ s, empresaId, limiar }) {
    const estoques = await listarTudo(s, 'estoques', empresaId);
    const produtos = await listarTudo(s, 'produtos', empresaId);
    const produtoPorId = new Map(produtos.map((p) => [Number(p.id), p]));
    const porProduto = new Map<number, { saldo: number; minimo: number }>();
    for (const e of estoques) {
      const pid = Number(e.produto_id);
      if (!pid) continue;
      const acc = porProduto.get(pid) ?? { saldo: 0, minimo: 0 };
      acc.saldo += Number(e.quantidade || 0);
      acc.minimo = Math.max(acc.minimo, Number(e.estoque_min || 0));
      porProduto.set(pid, acc);
    }
    const ocorrencias: Ocorrencia[] = [];
    let n = 0;
    for (const [pid, acc] of porProduto) {
      if (n >= num(limiar.maximo_produtos, LIMITE_CANDIDATOS_ESTOQUE)) break;
      const produto = produtoPorId.get(pid);
      if (!produto || produto.ativo === false) continue;
      if (acc.minimo <= 0 || acc.saldo >= acc.minimo) continue;
      n++;
      ocorrencias.push({
        chave: `produto:${pid}`,
        titulo: `Estoque baixo: ${String(produto.nome)}`,
        detalhe: `Saldo ${acc.saldo} abaixo do mínimo ${acc.minimo}.`,
        evidencia: { produto_id: pid, saldo: acc.saldo, minimo: acc.minimo },
      });
    }
    return ocorrencias;
  },
};

const detQuedaVendas: Detector = {
  chave: 'queda_vendas',
  nome: 'Queda de vendas mês a mês',
  dominio: 'vendas',
  severidade: 'alta',
  limiar: { queda_pct: 30, minimo_receita_anterior: 1000 },
  async detectar({ s, empresaId, limiar, agora }) {
    const { atual, anterior } = periodoAnterior(agora);
    const vendas = (await listarTudo(s, 'vendas', empresaId)).filter((v) => ['faturada', 'entregue'].includes(String(v.status)));
    const soma = (periodo: string) => vendas.filter((v) => periodoDe(v.faturada_em || v.data) === periodo).reduce((a, v) => a + Number(v.total || 0), 0);
    const receitaAtual = soma(atual);
    const receitaAnterior = soma(anterior);
    const piso = num(limiar.minimo_receita_anterior, 1000);
    // Sem base anterior confiável não há queda a declarar (evita alerta artificial).
    if (receitaAnterior < piso) return [];
    const queda = ((receitaAnterior - receitaAtual) / receitaAnterior) * 100;
    if (queda < num(limiar.queda_pct, 30)) return [];
    return [{
      chave: `periodo:${atual}`,
      titulo: `Queda de vendas em ${atual}`,
      detalhe: `Receita caiu ${queda.toFixed(1)}% frente a ${anterior} (${receitaAnterior.toFixed(2)} → ${receitaAtual.toFixed(2)}).`,
      evidencia: { periodo: atual, receita_atual: receitaAtual, receita_anterior: receitaAnterior, queda_pct: Number(queda.toFixed(2)) },
    }];
  },
};

const detMargemBaixa: Detector = {
  chave: 'margem_baixa',
  nome: 'Margem abaixo do limite',
  dominio: 'financeiro',
  severidade: 'media',
  limiar: { margem_minima_pct: 15 },
  async detectar({ s, empresaId, limiar, agora }) {
    const periodo = periodoAnterior(agora).atual;
    const vendas = (await listarTudo(s, 'vendas', empresaId)).filter((v) => ['faturada', 'entregue'].includes(String(v.status)) && periodoDe(v.faturada_em || v.data) === periodo);
    if (!vendas.length) return [];
    const produtos = await listarTudo(s, 'produtos', empresaId);
    const custoPorProduto = new Map(produtos.map((p) => [Number(p.id), Number(p.custo || 0)]));
    const itens = await listarTudo(s, 'itens_venda', empresaId);
    const idsVenda = new Set(vendas.map((v) => Number(v.id)));
    const receita = vendas.reduce((a, v) => a + Number(v.total || 0), 0);
    const cmv = itens.filter((it) => idsVenda.has(Number(it.venda_id)))
      .reduce((a, it) => a + Number(it.quantidade || 0) * (custoPorProduto.get(Number(it.produto_id)) ?? 0), 0);
    if (receita <= 0) return [];
    const margemPct = ((receita - cmv) / receita) * 100;
    if (margemPct >= num(limiar.margem_minima_pct, 15)) return [];
    return [{
      chave: `periodo:${periodo}`,
      titulo: `Margem de ${margemPct.toFixed(1)}% em ${periodo}`,
      detalhe: `Margem abaixo do limite de ${num(limiar.margem_minima_pct, 15)}%.`,
      evidencia: { periodo, receita, cmv, margem_pct: Number(margemPct.toFixed(2)) },
    }];
  },
};

const detInadimplencia: Detector = {
  chave: 'inadimplencia',
  nome: 'Contas a receber vencidas',
  dominio: 'financeiro',
  severidade: 'alta',
  limiar: { valor_minimo: 0 },
  async detectar({ s, empresaId, limiar, agora }) {
    const lancamentos = await listarTudo(s, 'lancamentos_financeiros', empresaId, { tipo: 'receita', status: 'pendente' });
    const hoje = agora.toISOString().slice(0, 10);
    const vencidos = lancamentos.filter((l) => l.vencimento && String(l.vencimento) < hoje);
    const total = vencidos.reduce((a, l) => a + Number(l.valor || 0), 0);
    if (!vencidos.length || total <= num(limiar.valor_minimo, 0)) return [];
    return [{
      chave: 'receber:vencidos',
      titulo: `${vencidos.length} título(s) a receber vencido(s)`,
      detalhe: `Total vencido em contas a receber: ${total.toFixed(2)}.`,
      evidencia: { titulos: vencidos.length, valor_vencido: total, mais_antigo: vencidos.map((l) => String(l.vencimento)).sort()[0] ?? null },
    }];
  },
};

const detFalhaIntegracao: Detector = {
  chave: 'falha_integracao',
  nome: 'Falha de integração (fila/notificação)',
  dominio: 'integracoes',
  severidade: 'alta',
  limiar: {},
  async detectar({ s, empresaId }) {
    const outbox = await listarTudo(s, 'commerce_outbox', empresaId);
    const notif = await listarTudo(s, 'commerce_notificacoes', empresaId);
    const porTipo = new Map<string, number>();
    for (const o of outbox) {
      const estado = String(o.estado || '').toUpperCase();
      if (estado !== 'ERRO' && estado !== 'FALHA') continue;
      const tipo = String(o.tipo || 'evento');
      porTipo.set(`fila:${tipo}`, (porTipo.get(`fila:${tipo}`) || 0) + 1);
    }
    for (const n of notif) {
      const estado = String(n.estado || '').toUpperCase();
      if (estado !== 'ERRO') continue;
      const canal = String(n.canal || 'canal');
      porTipo.set(`notificacao:${canal}`, (porTipo.get(`notificacao:${canal}`) || 0) + 1);
    }
    return [...porTipo.entries()].map(([chave, total]) => ({
      chave,
      titulo: `Falha de integração: ${chave.split(':')[1]}`,
      detalhe: `${total} item(ns) em erro na origem ${chave.split(':')[0]}.`,
      evidencia: { origem: chave.split(':')[0], referencia: chave.split(':')[1], total },
    }));
  },
};

const detPedidosParados: Detector = {
  chave: 'pedidos_parados',
  nome: 'Pedidos omnichannel parados',
  dominio: 'operacao',
  severidade: 'media',
  limiar: { horas_aguardando: 24 },
  async detectar({ s, empresaId, limiar, agora }) {
    const pedidos = await listarTudo(s, 'commerce_pedidos', empresaId);
    const limite = agora.getTime() - num(limiar.horas_aguardando, 24) * 3_600_000;
    const ocorrencias: Ocorrencia[] = [];
    for (const p of pedidos) {
      const estado = String(p.estado || '').toUpperCase();
      const ref = String(p.pedido_externo || p.id);
      if (estado === 'ERRO' || estado === 'AGUARDANDO_CORRECAO') {
        ocorrencias.push({ chave: `pedido:${ref}`, titulo: `Pedido ${ref} em ${estado}`, detalhe: `Pedido externo do canal ${String(p.canal || '')} exige correção.`, evidencia: { pedido_externo: ref, canal: p.canal ?? null, estado } });
        continue;
      }
      const criado = new Date(String(p.criado_em || 0)).getTime();
      if (estado === 'AGUARDANDO_PAGAMENTO' && Number.isFinite(criado) && criado < limite) {
        ocorrencias.push({ chave: `pedido:${ref}`, titulo: `Pedido ${ref} aguardando pagamento`, detalhe: `Parado há mais de ${num(limiar.horas_aguardando, 24)}h aguardando pagamento.`, evidencia: { pedido_externo: ref, canal: p.canal ?? null, criado_em: p.criado_em ?? null } });
      }
    }
    return ocorrencias;
  },
};

const detSlaAtendimento: Detector = {
  chave: 'sla_atendimento',
  nome: 'SLA de atendimento estourado',
  dominio: 'atendimento',
  severidade: 'alta',
  limiar: {},
  async detectar({ s, empresaId, agora }) {
    const tickets = await listarTudo(s, 'service_tickets', empresaId);
    const abertos = tickets.filter((t) => ['aberto', 'em_atendimento', 'aguardando_cliente'].includes(String(t.status)));
    const estourados = abertos.filter((t) => t.prazo_resolucao_em && new Date(String(t.prazo_resolucao_em)).getTime() < agora.getTime());
    return estourados.map((t) => ({
      chave: `ticket:${Number(t.id)}`,
      titulo: `Ticket ${String(t.numero ?? t.id)} com SLA estourado`,
      detalhe: `Prazo de resolução vencido em ${String(t.prazo_resolucao_em)}.`,
      evidencia: { ticket_id: Number(t.id), numero: t.numero ?? null, status: t.status, prazo_resolucao_em: t.prazo_resolucao_em ?? null, prioridade: t.prioridade ?? null },
    }));
  },
};

const detDivergenciaConciliacao: Detector = {
  chave: 'divergencia_conciliacao',
  nome: 'Divergência de reconciliação multicanal',
  dominio: 'integracoes',
  severidade: 'alta',
  limiar: { severidade_minima: 2 },
  async detectar({ s, empresaId, limiar }) {
    const divergencias = await listarTudo(s, 'commerce_reconciliacao', empresaId, { status: 'ABERTA' });
    const piso = num(limiar.severidade_minima, 2);
    return divergencias
      .filter((d) => (RANK[(String(d.severidade) as SeveridadeAlerta)] ?? 0) >= piso)
      .map((d) => ({
        chave: `divergencia:${String(d.fingerprint)}`,
        titulo: `Divergência ${String(d.categoria)} em ${String(d.canal)}`,
        detalhe: String(d.detalhe || ''),
        severidade: String(d.severidade) as SeveridadeAlerta,
        evidencia: { canal: d.canal ?? null, categoria: d.categoria ?? null, tipo: d.tipo ?? null, referencia: d.referencia ?? null, divergencia_id: Number(d.id) },
      }));
  },
};

export const DETECTORES: Detector[] = [
  detRupturaEstoque,
  detAbaixoMinimo,
  detQuedaVendas,
  detMargemBaixa,
  detInadimplencia,
  detFalhaIntegracao,
  detPedidosParados,
  detSlaAtendimento,
  detDivergenciaConciliacao,
];

const DETECTOR_POR_CHAVE = new Map(DETECTORES.map((d) => [d.chave, d]));

/** Identidade lógica da ocorrência — estável entre execuções. */
export function fingerprintAlerta(regraChave: string, chave: string): string {
  return createHash('sha256').update(`${regraChave}|${chave}`).digest('hex').slice(0, 48);
}

// ----------------------------------------------------------------------------
// AVALIAÇÃO — detecta, persiste (idempotente), fecha o que deixou de existir.
// ----------------------------------------------------------------------------

export type ResultadoAvaliacao = {
  empresa_id: number;
  regras_avaliadas: number;
  detectadas: number;
  abertas: number;
  reabertas: number;
  mantidas: number;
  resolvidas: number;
  a_notificar: number;
  por_dominio: Record<string, number>;
  por_severidade: Record<string, number>;
  gerado_em: string;
};

/** Regras ativas da empresa; ausência de regra explícita = detector ativo com defaults. */
async function regrasEfetivas(s: S, empresaId: number, tx?: Tx): Promise<Array<{ detector: Detector; regra: Row | null; limiar: Record<string, number>; severidade: SeveridadeAlerta; frequencia: number; silenciadoAte: string | null }>> {
  const regras = await listarTudo(s, 'alert_rules', empresaId, {}, tx);
  const porChave = new Map(regras.map((r) => [String(r.chave), r]));
  const efetivas: Array<{ detector: Detector; regra: Row | null; limiar: Record<string, number>; severidade: SeveridadeAlerta; frequencia: number; silenciadoAte: string | null }> = [];
  for (const detector of DETECTORES) {
    const regra = porChave.get(detector.chave) ?? null;
    if (regra && regra.ativo === false) continue;
    const limiar = { ...detector.limiar, ...((regra?.limiar as Record<string, number>) ?? {}) };
    const severidade = (regra?.severidade ? String(regra.severidade) : detector.severidade) as SeveridadeAlerta;
    efetivas.push({
      detector,
      regra,
      limiar,
      severidade,
      frequencia: num(regra?.frequencia_minima_min, 0),
      silenciadoAte: regra?.silenciado_ate ? String(regra.silenciado_ate) : null,
    });
  }
  return efetivas;
}

/**
 * Avalia TODOS os detectores da empresa: grava/atualiza ocorrências por
 * fingerprint, resolve as que deixaram de ser detectadas e audita. Não envia
 * mensagem externa — apenas marca o que WOULD ser notificado (dedup/silêncio).
 */
export async function avaliarAlertas(
  empresaId: number,
  opts: { ator?: { id?: number | null; name?: string | null }; detectores?: string[] } = {},
): Promise<ResultadoAvaliacao> {
  const s = getStore();
  const agora = new Date();
  const efetivas = (await regrasEfetivas(s, empresaId)).filter((e) => !opts.detectores || opts.detectores.includes(e.detector.chave));

  const porDominio: Record<string, number> = {};
  const porSeveridade: Record<string, number> = {};
  let detectadas = 0;
  let abertas = 0;
  let reabertas = 0;
  let mantidas = 0;
  let aNotificar = 0;
  const vistos = new Set<string>();

  const resultado = await s.transaction(async (tx) => {
    for (const ef of efetivas) {
      const ocorrencias = await ef.detector.detectar({ s, empresaId, limiar: ef.limiar, agora });
      for (const oc of ocorrencias) {
        const severidade = (oc.severidade ?? ef.severidade) as SeveridadeAlerta;
        const fingerprint = fingerprintAlerta(ef.detector.chave, oc.chave);
        vistos.add(fingerprint);
        detectadas++;
        porDominio[ef.detector.dominio] = (porDominio[ef.detector.dominio] || 0) + 1;
        porSeveridade[severidade] = (porSeveridade[severidade] || 0) + 1;
        const existente = await s.findOneWhere(getResource('alert_events')!, { empresa_id: empresaId, fingerprint }, tx);
        const silenciadoAte = ef.silenciadoAte && new Date(ef.silenciadoAte).getTime() > agora.getTime() ? ef.silenciadoAte : null;
        const ultimaNotif = existente?.ultima_notificacao_em ? new Date(String(existente.ultima_notificacao_em)).getTime() : 0;
        const janela = ef.frequencia * 60_000;
        const podeNotificar = !silenciadoAte && (janela <= 0 || agora.getTime() - ultimaNotif >= janela);
        if (podeNotificar) aNotificar++;
        const base: Record<string, unknown> = {
          empresa_id: empresaId,
          regra_id: ef.regra ? Number(ef.regra.id) : null,
          regra_chave: ef.detector.chave,
          dominio: ef.detector.dominio,
          severidade,
          titulo: oc.titulo.slice(0, 300),
          detalhe: oc.detalhe.slice(0, 1000),
          evidencia: oc.evidencia,
          fingerprint,
          ultima_deteccao: agora.toISOString(),
          atualizado_em: agora.toISOString(),
          ...(podeNotificar ? { ultima_notificacao_em: agora.toISOString() } : {}),
          ...(silenciadoAte ? { silenciado_ate: silenciadoAte } : {}),
        };
        if (!existente) {
          await s.insert(getResource('alert_events')!, { ...base, status: 'ABERTO', ocorrencias: 1, primeira_deteccao: agora.toISOString() }, tx);
          abertas++;
        } else {
          const status = String(existente.status || 'ABERTO');
          if (status === 'RESOLVIDO' || status === 'SILENCIADO') {
            // Reabre: a correção não pode esconder recaída.
            await s.update(getResource('alert_events')!, Number(existente.id), { ...base, status: 'ABERTO', ocorrencias: 1, resolvido_em: null, resolvido_por: null, resolucao: null }, tx);
            reabertas++;
          } else {
            await s.update(getResource('alert_events')!, Number(existente.id), { ...base, ocorrencias: Number(existente.ocorrencias || 1) + 1 }, tx);
            mantidas++;
          }
        }
      }
    }
    // Resolve os alertas ABERTOS/CIENTE que NÃO foram detectados nesta rodada.
    const abertos = await listarTudo(s, 'alert_events', empresaId, {}, tx);
    let resolvidas = 0;
    for (const a of abertos) {
      if (!['ABERTO', 'CIENTE'].includes(String(a.status))) continue;
      if (vistos.has(String(a.fingerprint))) continue;
      await s.update(getResource('alert_events')!, Number(a.id), { status: 'RESOLVIDO', resolvido_em: agora.toISOString(), resolucao: 'Deixou de ser detectado na avaliação.', atualizado_em: agora.toISOString() }, tx);
      resolvidas++;
    }
    await s.audit({
      empresa_id: empresaId, usuario_id: opts.ator?.id ?? null, usuario: opts.ator?.name ?? null,
      acao: 'ajuste', recurso: 'alert_events', registro_id: null,
      descricao: 'Avaliação de alertas executada',
      dados: { detectadas, abertas, reabertas, mantidas, resolvidas, a_notificar: aNotificar },
    }, tx);
    return { resolvidas };
  });

  return {
    empresa_id: empresaId,
    regras_avaliadas: efetivas.length,
    detectadas,
    abertas,
    reabertas,
    mantidas,
    resolvidas: resultado.resolvidas,
    a_notificar: aNotificar,
    por_dominio: porDominio,
    por_severidade: porSeveridade,
    gerado_em: agora.toISOString(),
  };
}

// ----------------------------------------------------------------------------
// PAINEL — visão agregada do que exige atenção (lê o que foi persistido).
// ----------------------------------------------------------------------------
export type FiltrosPainelAlerta = { dominio?: DominioAlerta | null; severidade?: SeveridadeAlerta | null; status?: string | null };

export type PainelAlertas = {
  empresa_id: number;
  filtros: FiltrosPainelAlerta;
  totais: { abertos: number; cientes: number; resolvidos: number; silenciados: number; por_dominio: Record<string, number>; por_severidade: Record<string, number> };
  alertas: Array<Record<string, unknown>>;
  catálogo: Array<{ chave: string; nome: string; dominio: string; severidade: string; limiar: Record<string, number> }>;
  gerado_em: string;
};

export async function painelAlertas(empresaId: number, filtros: FiltrosPainelAlerta = {}): Promise<PainelAlertas> {
  const s = getStore();
  const todos = await listarTudo(s, 'alert_events', empresaId, {});
  const contagem = (st: string) => todos.filter((a) => String(a.status) === st).length;
  const porDominio: Record<string, number> = {};
  const porSeveridade: Record<string, number> = {};
  for (const a of todos.filter((x) => ['ABERTO', 'CIENTE'].includes(String(x.status)))) {
    porDominio[String(a.dominio)] = (porDominio[String(a.dominio)] || 0) + 1;
    porSeveridade[String(a.severidade)] = (porSeveridade[String(a.severidade)] || 0) + 1;
  }
  const filtrados = todos
    .filter((a) => !filtros.dominio || String(a.dominio) === filtros.dominio)
    .filter((a) => !filtros.severidade || String(a.severidade) === filtros.severidade)
    .filter((a) => !filtros.status || String(a.status) === filtros.status)
    .sort((a, b) => (RANK[(String(b.severidade) as SeveridadeAlerta)] ?? 0) - (RANK[(String(a.severidade) as SeveridadeAlerta)] ?? 0)
      || String(b.ultima_deteccao).localeCompare(String(a.ultima_deteccao)));
  return {
    empresa_id: empresaId,
    filtros,
    totais: {
      abertos: contagem('ABERTO'), cientes: contagem('CIENTE'), resolvidos: contagem('RESOLVIDO'), silenciados: contagem('SILENCIADO'),
      por_dominio: porDominio, por_severidade: porSeveridade,
    },
    alertas: filtrados.slice(0, 500).map((a) => ({
      id: Number(a.id),
      regra_chave: String(a.regra_chave || ''),
      dominio: String(a.dominio || ''),
      severidade: String(a.severidade || ''),
      titulo: String(a.titulo || ''),
      detalhe: String(a.detalhe || ''),
      evidencia: a.evidencia ?? {},
      status: String(a.status || ''),
      ocorrencias: Number(a.ocorrencias || 1),
      primeira_deteccao: a.primeira_deteccao ?? null,
      ultima_deteccao: a.ultima_deteccao ?? null,
      reconhecido_em: a.reconhecido_em ?? null,
      resolvido_em: a.resolvido_em ?? null,
      silenciado_ate: a.silenciado_ate ?? null,
    })),
    catálogo: DETECTORES.map((d) => ({ chave: d.chave, nome: d.nome, dominio: d.dominio, severidade: d.severidade, limiar: d.limiar })),
    gerado_em: new Date().toISOString(),
  };
}

// ----------------------------------------------------------------------------
// TRANSIÇÕES de um alerta: reconhecer, resolver, silenciar (idempotentes).
// ----------------------------------------------------------------------------
async function alertaDaEmpresa(s: S, empresaId: number, id: number): Promise<Row> {
  const row = await s.findOneWhere(getResource('alert_events')!, { id, empresa_id: empresaId });
  if (!row) throw new HttpError(404, 'Alerta não encontrado nesta empresa.');
  return row;
}

export async function reconhecerAlerta(empresaId: number, id: number, ator: { id?: number | null; name?: string | null }): Promise<Row> {
  const s = getStore();
  const atual = await alertaDaEmpresa(s, empresaId, id);
  if (String(atual.status) === 'CIENTE' || String(atual.status) === 'RESOLVIDO') return atual;
  const row = await s.transaction(async (tx) => {
    const r = await s.update(getResource('alert_events')!, id, { status: 'CIENTE', reconhecido_por: ator.id ?? null, reconhecido_em: new Date().toISOString(), atualizado_em: new Date().toISOString() }, tx);
    await s.audit({ empresa_id: empresaId, usuario_id: ator.id ?? null, usuario: ator.name ?? null, acao: 'editar', recurso: 'alert_events', registro_id: id, descricao: 'Alerta reconhecido', dados: { status: 'CIENTE' } }, tx);
    return r ?? atual;
  });
  return row;
}

export async function resolverAlerta(empresaId: number, id: number, resolucao: string, ator: { id?: number | null; name?: string | null }): Promise<Row> {
  const s = getStore();
  const atual = await alertaDaEmpresa(s, empresaId, id);
  if (String(atual.status) === 'RESOLVIDO') return atual;
  const texto = String(resolucao || '').trim();
  if (!texto) throw new HttpError(400, 'Informe a resolução do alerta.');
  const row = await s.transaction(async (tx) => {
    const r = await s.update(getResource('alert_events')!, id, { status: 'RESOLVIDO', resolucao: texto.slice(0, 1000), resolvido_por: ator.id ?? null, resolvido_em: new Date().toISOString(), atualizado_em: new Date().toISOString() }, tx);
    await s.audit({ empresa_id: empresaId, usuario_id: ator.id ?? null, usuario: ator.name ?? null, acao: 'editar', recurso: 'alert_events', registro_id: id, descricao: 'Alerta resolvido', dados: { resolucao: texto.slice(0, 200) } }, tx);
    return r ?? atual;
  });
  return row;
}

export async function silenciarAlerta(empresaId: number, id: number, ateIso: string, ator: { id?: number | null; name?: string | null }): Promise<Row> {
  const s = getStore();
  const atual = await alertaDaEmpresa(s, empresaId, id);
  const ate = new Date(String(ateIso));
  if (Number.isNaN(ate.getTime())) throw new HttpError(400, 'Data de silenciamento inválida.');
  const row = await s.transaction(async (tx) => {
    const r = await s.update(getResource('alert_events')!, id, { status: 'SILENCIADO', silenciado_ate: ate.toISOString(), atualizado_em: new Date().toISOString() }, tx);
    await s.audit({ empresa_id: empresaId, usuario_id: ator.id ?? null, usuario: ator.name ?? null, acao: 'editar', recurso: 'alert_events', registro_id: id, descricao: 'Alerta silenciado', dados: { silenciado_ate: ate.toISOString() } }, tx);
    return r ?? atual;
  });
  return row;
}

// ----------------------------------------------------------------------------
// HANDLERS HTTP
// ----------------------------------------------------------------------------
export async function avaliarAlertasHandler(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('alert_events')!, actor, 'read');
  const escopo = escopoDoAtor(actor);
  const body = (req.body ?? {}) as Row;
  const detectores = Array.isArray(body.detectores) ? body.detectores.map((d) => String(d)) : undefined;
  if (detectores) {
    for (const d of detectores) {
      if (!DETECTOR_POR_CHAVE.has(d)) throw new HttpError(400, `Detector inválido: ${d}.`, { detectores: [...DETECTOR_POR_CHAVE.keys()] });
    }
  }
  res.status(201).json(await avaliarAlertas(escopo.empresaId, { ator: { id: actor.id ?? null, name: actor.name ?? null }, detectores }));
}

export async function painelAlertasHandler(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('alert_events')!, actor, 'read');
  const escopo = escopoDoAtor(actor);
  const q = req.query;
  const dominio = q.dominio ? (String(q.dominio).toLowerCase() as DominioAlerta) : null;
  if (dominio && !DOMINIOS_ALERTA.includes(dominio)) throw new HttpError(400, 'Domínio inválido.', { dominios: DOMINIOS_ALERTA });
  const severidade = q.severidade ? (String(q.severidade).toLowerCase() as SeveridadeAlerta) : null;
  if (severidade && !SEVERIDADES_ALERTA.includes(severidade)) throw new HttpError(400, 'Severidade inválida.', { severidades: SEVERIDADES_ALERTA });
  const status = q.status ? String(q.status).toUpperCase() : null;
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(await painelAlertas(escopo.empresaId, { dominio, severidade, status }));
}

// AUD-01: `alert_events` tem `ops.update = false` — o CRUD genérico (PUT
// /api/alert_events) NÃO pode editar uma ocorrência, e isso permanece fechado.
// Reconhecer/resolver/silenciar são ENDPOINTS DE FLUXO: o caminho legítimo para
// a transição. Por isso usam `checkFluxoEscrita`, que confere a MESMA alçada do
// checkAccess (autenticação, minPerfil gerente/admin, RBAC comercial,
// minPerfilEscrita) sem consultar `ops`. O CRUD genérico continua bloqueado.
export async function reconhecerAlertaHandler(req: Request, res: Response) {
  const actor = currentUser(req);
  checkFluxoEscrita(getResource('alert_events')!, actor, 'update');
  const escopo = escopoDoAtor(actor);
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'Alerta inválido.');
  res.json(await reconhecerAlerta(escopo.empresaId, id, { id: actor.id ?? null, name: actor.name ?? null }));
}

export async function resolverAlertaHandler(req: Request, res: Response) {
  const actor = currentUser(req);
  checkFluxoEscrita(getResource('alert_events')!, actor, 'update');
  const escopo = escopoDoAtor(actor);
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'Alerta inválido.');
  const body = (req.body ?? {}) as Row;
  res.json(await resolverAlerta(escopo.empresaId, id, String(body.resolucao || ''), { id: actor.id ?? null, name: actor.name ?? null }));
}

export async function silenciarAlertaHandler(req: Request, res: Response) {
  const actor = currentUser(req);
  checkFluxoEscrita(getResource('alert_events')!, actor, 'update');
  const escopo = escopoDoAtor(actor);
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'Alerta inválido.');
  const body = (req.body ?? {}) as Row;
  res.json(await silenciarAlerta(escopo.empresaId, id, String(body.silenciado_ate || ''), { id: actor.id ?? null, name: actor.name ?? null }));
}
