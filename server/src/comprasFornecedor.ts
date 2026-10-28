// ============================================================================
// COMPRAS 3.0 — HOMOLOGAÇÃO DE FORNECEDOR
//
// O QUE ESTE MÓDULO É
// Um PROCESSO sobre o cadastro de fornecedor que já existe — não um segundo
// cadastro. O estado vive em `fornecedores.homologacao_status` (migration
// 0053), os documentos em `fornecedor_documentos` e a trilha em
// `fornecedor_homologacao_eventos`.
//
// MÁQUINA DE ESTADOS (vocabulário fechado)
//   PENDENTE → EM_ANALISE → HOMOLOGADO → SUSPENSO → BLOQUEADO
//   • suspenso/bloqueado exigem MOTIVO (o banco também confere);
//   • só ADMIN tira um fornecedor de BLOQUEADO — desbloqueio é decisão de
//     alçada, não de conveniência;
//   • HOMOLOGADO exige categoria de fornecimento e nenhum documento
//     aprovado vencido: homologar com certidão vencida é o oposto do processo.
//
// O QUE ESTE MÓDULO **NÃO** FAZ
//   • não cria pedido de compra (nenhuma ação automática de compra);
//   • não apaga fornecedor nem documento (estado, não DELETE);
//   • não grava número de desempenho em coluna: prazo, atendimento e preço
//     são CALCULADOS a partir de compras/itens/recebimentos que já existem.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource, HOMOLOGACAO_STATUS } from './resources';
import { checkAccess, escopoDe, getStore } from './services';
import { currentUser } from './auth';
import { assertRegistroDaEmpresa } from './empresa';
import { parseId } from './validate';
import { round2 } from './utils';
import type { Row, Store, Tx } from './store';

const R_FORNECEDOR = () => getResource('fornecedores')!;
const R_DOC = () => getResource('fornecedor_documentos')!;
const R_EVENTO = () => getResource('fornecedor_homologacao_eventos')!;
const R_COMPRA = () => getResource('compras')!;
const R_ITEM_COMPRA = () => getResource('itens_compra')!;

export const STATUS_HOMOLOGACAO = ['pendente', 'em_analise', 'homologado', 'suspenso', 'bloqueado'] as const;
export type StatusHomologacao = (typeof STATUS_HOMOLOGACAO)[number];

/**
 * Transições permitidas. A chave de saída manda: nada aqui "pula" de pendente
 * para homologado sem passar por análise — homologar é o resultado de um
 * processo, não de um clique único na criação.
 */
const TRANSICOES: Record<StatusHomologacao, StatusHomologacao[]> = {
  pendente: ['em_analise', 'bloqueado'],
  em_analise: ['homologado', 'pendente', 'bloqueado'],
  homologado: ['suspenso', 'bloqueado', 'em_analise'],
  suspenso: ['em_analise', 'homologado', 'bloqueado'],
  bloqueado: ['em_analise'],
};

const LABEL: Record<StatusHomologacao, string> = {
  pendente: 'Pendente',
  em_analise: 'Em análise',
  homologado: 'Homologado',
  suspenso: 'Suspenso',
  bloqueado: 'Bloqueado',
};

function statusDe(v: unknown): StatusHomologacao | null {
  const s = String(v ?? '').trim().toLowerCase();
  return (STATUS_HOMOLOGACAO as readonly string[]).includes(s) ? (s as StatusHomologacao) : null;
}

function exigirGestor(actor: { perfil?: string }) {
  if (actor.perfil !== 'gerente' && actor.perfil !== 'admin') {
    throw new HttpError(403, 'Apenas gerentes e administradores mudam a homologação de um fornecedor.');
  }
}

const hoje = (): string => new Date().toISOString().slice(0, 10);
const vencido = (data: unknown): boolean => {
  if (!data) return false;
  const iso = String(data).slice(0, 10);
  return iso < hoje();
};

async function registrarEvento(
  s: Store,
  tx: Tx,
  dados: { empresaId: number; fornecedorId: number; de: string | null; para: string; motivo?: string | null; usuarioId: number | null }
): Promise<void> {
  await s.insert(
    R_EVENTO(),
    {
      empresa_id: dados.empresaId,
      fornecedor_id: dados.fornecedorId,
      status_anterior: dados.de,
      status_novo: dados.para,
      motivo: dados.motivo ? String(dados.motivo).slice(0, 500) : null,
      usuario_id: dados.usuarioId,
    },
    tx
  );
}

/** Documentos do fornecedor com o vencimento DERIVADO (nunca gravado). */
export async function documentosDoFornecedor(s: Store, fornecedorId: number, tx?: Tx): Promise<Row[]> {
  const lista = await s.list(R_DOC(), { page: 1, pageSize: 500, filter: { fornecedor_id: fornecedorId } }, tx);
  return lista.rows
    .map((d: Row): Row => ({
      ...d,
      vencido: d.situacao === 'aprovado' ? vencido(d.validade) : false,
      dias_para_vencer: d.validade ? Math.round((new Date(String(d.validade)).getTime() - new Date(hoje()).getTime()) / 86400000) : null,
    }))
    .sort((a: Row, b: Row) => String(a.validade ?? '9999-12-31').localeCompare(String(b.validade ?? '9999-12-31')));
}

/**
 * Pendências que impedem a homologação. A lista é o que o comprador precisa
 * resolver — não um "não pode" seco.
 */
export function pendenciasParaHomologar(fornecedor: Row, documentos: Row[]): string[] {
  const pendencias: string[] = [];
  if (!fornecedor.homologacao_categoria) {
    pendencias.push('Defina a categoria de fornecimento (o que este fornecedor fornece).');
  }
  if (!documentos.length) {
    pendencias.push('Cadastre ao menos um documento do fornecedor (contrato, cartão CNPJ ou certidão).');
  }
  const aprovadosVencidos = documentos.filter((d) => d.situacao === 'aprovado' && d.vencido);
  if (aprovadosVencidos.length) {
    pendencias.push(`Documento(s) aprovado(s) e vencido(s): ${aprovadosVencidos.map((d) => String(d.tipo)).join(', ')}.`);
  }
  const reprovados = documentos.filter((d) => d.situacao === 'reprovado');
  if (reprovados.length) {
    pendencias.push(`Documento(s) reprovado(s) impedem a homologação: ${reprovados.map((d) => String(d.tipo)).join(', ')}.`);
  }
  return pendencias;
}

// ----------------------------------------------------------------------------
// GET /api/compras/fornecedores/:id/homologacao
// ----------------------------------------------------------------------------
export async function homologacaoDoFornecedor(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = R_FORNECEDOR();
  checkAccess(r, actor, 'read');
  const escopo = escopoDe(actor);
  const s = getStore();
  const id = parseId(req.params.id);
  const fornecedor = assertRegistroDaEmpresa(
    r,
    await s.findOneWhere(r, { id, empresa_id: escopo.empresaId }),
    escopo
  );
  const documentos = await documentosDoFornecedor(s, id);
  const eventos = await s.list(R_EVENTO(), { page: 1, pageSize: 200, filter: { fornecedor_id: id }, sort: 'criado_em', dir: 'desc' });
  const status = (statusDe(fornecedor.homologacao_status) ?? 'pendente') as StatusHomologacao;
  return res.json({
    fornecedor: { id: Number(fornecedor.id), nome: fornecedor.nome, status, label: LABEL[status] },
    // `status` no topo é o atalho que a tela usa; vive no fornecedor, não aqui.
    status,
    categoria: fornecedor.homologacao_categoria ?? null,
    avaliacao_manual: fornecedor.avaliacao_manual ?? null,
    validade_documentos: fornecedor.validade_documentos ?? null,
    homologado_em: fornecedor.homologado_em ?? null,
    motivo: fornecedor.homologacao_motivo ?? null,
    proximos: TRANSICOES[status],
    pendencias: pendenciasParaHomologar(fornecedor, documentos),
    documentos,
    eventos: eventos.rows,
  });
}

// ----------------------------------------------------------------------------
// POST /api/compras/fornecedores/:id/homologacao
// ----------------------------------------------------------------------------
export async function alterarHomologacao(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = R_FORNECEDOR();
  checkAccess(r, actor, 'update');
  exigirGestor(actor);
  const escopo = escopoDe(actor);
  const s = getStore();
  const id = parseId(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const alvo = statusDe(body.status);
  if (!alvo) {
    throw new HttpError(400, 'Informe o novo status de homologação.', {
      status: `Use um destes: ${STATUS_HOMOLOGACAO.join(', ')}.`,
    });
  }

  const resultado = await s.transaction(async (tx: Tx) => {
    const fornecedor = assertRegistroDaEmpresa(
      r,
      await s.findOneWhere(r, { id, empresa_id: escopo.empresaId }, tx),
      escopo
    );
    const atual = (statusDe(fornecedor.homologacao_status) ?? 'pendente') as StatusHomologacao;
    const motivo = body.motivo === undefined ? null : String(body.motivo ?? '').trim() || null;

    if (alvo === atual) {
      // Idempotência: repetir o mesmo estado não cria evento nem erro.
      return { fornecedor, status: atual, alterado: false };
    }
    if (!TRANSICOES[atual as StatusHomologacao].includes(alvo)) {
      throw new HttpError(422, `Não é possível ir de ${LABEL[atual]} para ${LABEL[alvo]}.`, {
        status: atual === 'bloqueado'
          ? 'Somente um administrador desbloqueia um fornecedor bloqueado — e ele volta para Em análise.'
          : `A partir de ${LABEL[atual]} o próximo estado pode ser: ${TRANSICOES[atual as StatusHomologacao].map((x) => LABEL[x]).join(', ')}.`,
      });
    }
    if (atual === 'bloqueado' && actor.perfil !== 'admin') {
      throw new HttpError(403, 'Somente um administrador tira um fornecedor do estado Bloqueado.');
    }
    if ((alvo === 'suspenso' || alvo === 'bloqueado') && !motivo) {
      throw new HttpError(400, 'Informe o motivo da suspensão/bloqueio.', { motivo: 'Obrigatório' });
    }

    const documentos = await documentosDoFornecedor(s, id, tx);
    if (alvo === 'homologado') {
      const pendencias = pendenciasParaHomologar(
        {
          ...fornecedor,
          homologacao_categoria: body.categoria ?? fornecedor.homologacao_categoria,
        },
        documentos
      );
      if (pendencias.length) {
        throw new HttpError(422, `Não é possível homologar: ${pendencias[0]}`, { pendencias: pendencias.join(' ') });
      }
    }

    const patch: Record<string, unknown> = {
      homologacao_status: alvo,
      homologacao_atualizada_em: new Date().toISOString(),
    };
    if (body.categoria !== undefined) patch.homologacao_categoria = body.categoria || null;
    if (body.responsavel_id !== undefined) patch.homologacao_responsavel_id = body.responsavel_id || null;
    if (body.validade_documentos !== undefined) patch.validade_documentos = body.validade_documentos || null;
    if (body.avaliacao_manual !== undefined) {
      const nota = body.avaliacao_manual === null || body.avaliacao_manual === '' ? null : Number(body.avaliacao_manual);
      if (nota !== null && (!Number.isFinite(nota) || nota < 0 || nota > 5)) {
        throw new HttpError(400, 'A avaliação manual vai de 0 a 5.', { avaliacao_manual: 'Entre 0 e 5' });
      }
      patch.avaliacao_manual = nota;
    }
    if (alvo === 'homologado') {
      patch.homologado_em = fornecedor.homologado_em ?? new Date().toISOString();
      patch.homologacao_motivo = null;
    } else {
      patch.homologacao_motivo = motivo ?? fornecedor.homologacao_motivo ?? null;
    }

    const atualizado = await s.update(r, id, patch, tx);
    await registrarEvento(s, tx, {
      empresaId: escopo.empresaId,
      fornecedorId: id,
      de: atual,
      para: alvo,
      motivo,
      usuarioId: actor.id ?? null,
    });
    return { fornecedor: atualizado ?? fornecedor, status: alvo, alterado: true };
  });

  return res.json({
    fornecedor_id: id,
    status: resultado.status,
    label: LABEL[resultado.status],
    alterado: resultado.alterado,
    proximos: TRANSICOES[resultado.status as StatusHomologacao],
  });
}

// ----------------------------------------------------------------------------
// DESEMPENHO DO FORNECEDOR — só dados que JÁ existem
//
// Cada fator é explicável: o número não cai do céu, ele é a soma ponderada de
// evidências contábeis (pedido, recebimento, preço). Nada é gravado.
// ----------------------------------------------------------------------------
export type FatorDesempenho = { chave: string; label: string; pontos: number; detalhe: string };

export async function desempenhoDoFornecedor(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = R_FORNECEDOR();
  checkAccess(r, actor, 'read');
  const escopo = escopoDe(actor);
  const s = getStore();
  const id = parseId(req.params.id);
  const fornecedor = assertRegistroDaEmpresa(
    r,
    await s.findOneWhere(r, { id, empresa_id: escopo.empresaId }),
    escopo
  );

  const compras: Row[] = (await s.list(R_COMPRA(), { page: 1, pageSize: 2000, filter: { empresa_id: escopo.empresaId, fornecedor_id: id } })).rows;
  const recebidas = compras.filter((c) => ['parcial', 'recebido'].includes(String(c.status)));
  const canceladas = compras.filter((c) => String(c.status) === 'cancelado');
  const emAberto = compras.filter((c) => ['pendente', 'aprovado'].includes(String(c.status)));

  // Prazo: só é medido onde existe previsão E recebimento — sem inventar dado.
  const comPrazo = recebidas.filter((c) => c.previsao_entrega && c.recebida_em);
  const atrasos = comPrazo.map((c) => {
    const previsto = new Date(String(c.previsao_entrega));
    const real = new Date(String(c.recebida_em));
    return Math.round((real.getTime() - previsto.getTime()) / 86400000);
  });
  const noPrazo = atrasos.filter((d) => d <= 0).length;
  const atrasoMedio = atrasos.length ? round2(atrasos.reduce((a, b) => a + b, 0) / atrasos.length) : null;

  // Atendimento: quantidade recebida ÷ pedida nos itens já recebidos.
  const compraIds = new Set(recebidas.map((c) => Number(c.id)));
  const itens: Row[] = compraIds.size
    ? (await s.list(R_ITEM_COMPRA(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } })).rows.filter((i: Row) => compraIds.has(Number(i.compra_id)))
    : [];
  const pedida = itens.reduce((a, i) => a + Number(i.quantidade ?? 0), 0);
  const entregue = itens.reduce((a, i) => a + Number(i.quantidade_recebida ?? 0), 0);
  const atendimento = pedida > 0 ? round2((entregue / pedida) * 100) : null;

  // Preço: quanto o fornecedor cobra vs. a média do MESMO insumo em outros
  // fornecedores, no mesmo período — evidência, não opinião.
  const todosItens: Row[] = (await s.list(R_ITEM_COMPRA(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } })).rows;
  const mediaPorInsumo = new Map<number, { soma: number; n: number }>();
  for (const it of todosItens) {
    const insumoId = Number(it.insumo_id ?? 0);
    if (!insumoId) continue;
    const acc = mediaPorInsumo.get(insumoId) ?? { soma: 0, n: 0 };
    acc.soma += Number(it.preco_unitario ?? 0);
    acc.n += 1;
    mediaPorInsumo.set(insumoId, acc);
  }
  let comparaveis = 0;
  let razaoPreco = 0;
  for (const it of itens) {
    const insumoId = Number(it.insumo_id ?? 0);
    const media = mediaPorInsumo.get(insumoId);
    const preco = Number(it.preco_unitario ?? 0);
    if (!insumoId || !media || media.n < 2 || preco <= 0) continue;
    const mediaTodos = media.soma / media.n;
    if (mediaTodos <= 0) continue;
    razaoPreco += preco / mediaTodos;
    comparaveis += 1;
  }
  const indicePreco = comparaveis ? round2((razaoPreco / comparaveis) * 100) : null;

  const fatores: FatorDesempenho[] = [];
  let pontos = 0;
  const somar = (chave: string, label: string, valor: number, detalhe: string) => {
    const v = Math.max(0, Math.round(valor));
    pontos += v;
    fatores.push({ chave, label, pontos: v, detalhe });
  };

  if (comPrazo.length >= 1) {
    const pct = (noPrazo / comPrazo.length) * 40;
    somar('prazo', 'Pontualidade', pct, `${noPrazo} de ${comPrazo.length} entrega(s) no prazo${atrasoMedio !== null ? `; atraso médio ${atrasoMedio} dia(s)` : ''}.`);
  } else {
    fatores.push({ chave: 'prazo', label: 'Pontualidade', pontos: 0, detalhe: 'Sem entrega com previsão registrada — nada a medir ainda.' });
  }
  if (atendimento !== null) {
    somar('atendimento', 'Atendimento do pedido', (atendimento / 100) * 30, `${atendimento}% da quantidade pedida foi efetivamente recebida.`);
  } else {
    fatores.push({ chave: 'atendimento', label: 'Atendimento do pedido', pontos: 0, detalhe: 'Nenhum item recebido ainda.' });
  }
  if (indicePreco !== null) {
    // Índice 100 = na média. Abaixo disso é melhor; acima, pior.
    const nota = indicePreco <= 100 ? 20 : Math.max(0, 20 - (indicePreco - 100) * 0.4);
    somar('preco', 'Competitividade de preço', nota, `Preço médio em ${indicePreco}% da média dos demais fornecedores do mesmo insumo.`);
  } else {
    fatores.push({ chave: 'preco', label: 'Competitividade de preço', pontos: 0, detalhe: 'Sem preço comparável (o insumo precisa ter mais de um fornecedor).' });
  }
  const pctCanceladas = compras.length ? (canceladas.length / compras.length) * 100 : 0;
  somar('cancelamento', 'Pedidos cancelados', Math.max(0, 10 - pctCanceladas), `${canceladas.length} cancelamento(s) em ${compras.length} pedido(s).`);

  const score = Math.max(0, Math.min(100, Math.round(pontos)));
  const classificacao = score >= 80 ? 'confiavel' : score >= 60 ? 'atenção' : score >= 40 ? 'monitorar' : 'critico';

  return res.json({
    fornecedor: { id: Number(fornecedor.id), nome: fornecedor.nome, homologacao_status: fornecedor.homologacao_status ?? 'pendente' },
    score,
    classificacao,
    fatores,
    historico: {
      pedidos: compras.length,
      recebidos: recebidas.length,
      em_aberto: emAberto.length,
      cancelados: canceladas.length,
      ultimo_pedido: compras.map((c) => c.data).filter(Boolean).sort().at(-1) ?? null,
      total_comprado: round2(compras.filter((c) => String(c.status) !== 'cancelado').reduce((a, c) => a + Number(c.total ?? 0), 0)),
      ticket_medio: compras.length ? round2(compras.reduce((a, c) => a + Number(c.total ?? 0), 0) / compras.length) : 0,
    },
    prazo: { com_previsao: comPrazo.length, no_prazo: noPrazo, atraso_medio_dias: atrasoMedio },
    atendimento: { quantidade_pedida: pedida, quantidade_recebida: entregue, percentual: atendimento },
    preco: { itens_comparaveis: comparaveis, indice: indicePreco },
    avaliacao_manual: fornecedor.avaliacao_manual ?? null,
  });
}

// ----------------------------------------------------------------------------
// PAINEL DE COMPRAS — o que exige decisão hoje
// ----------------------------------------------------------------------------
export async function painelDeCompras(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = R_COMPRA();
  checkAccess(r, actor, 'read');
  const s = getStore();
  const escopo = escopoDe(actor);
  const compras: Row[] = (await s.list(r, { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } })).rows;
  const fornecedores: Row[] = (await s.list(R_FORNECEDOR(), { page: 1, pageSize: 2000, filter: { empresa_id: escopo.empresaId } })).rows;
  const documentos: Row[] = (await s.list(R_DOC(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } })).rows;

  const porStatus = new Map<string, number>();
  for (const c of compras) porStatus.set(String(c.status ?? 'pendente'), (porStatus.get(String(c.status ?? 'pendente')) ?? 0) + 1);
  const porHomologacao = new Map<string, number>();
  for (const f of fornecedores) {
    const st = String(f.homologacao_status ?? 'pendente');
    porHomologacao.set(st, (porHomologacao.get(st) ?? 0) + 1);
  }

  const emAberto = compras.filter((c) => ['pendente', 'aprovado', 'parcial'].includes(String(c.status)));
  const proximasEntregas = emAberto
    .filter((c) => c.previsao_entrega)
    .sort((a, b) => String(a.previsao_entrega).localeCompare(String(b.previsao_entrega)))
    .slice(0, 10)
    .map((c) => ({
      compra_id: Number(c.id),
      fornecedor_id: c.fornecedor_id ?? null,
      previsao_entrega: c.previsao_entrega,
      total: Number(c.total ?? 0),
      atrasada: String(c.previsao_entrega).slice(0, 10) < hoje(),
    }));

  const limite = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const documentosVencendo = documentos
    .filter((d) => d.validade && String(d.validade).slice(0, 10) <= limite)
    .sort((a, b) => String(a.validade).localeCompare(String(b.validade)))
    .slice(0, 20)
    .map((d: Row) => ({
      documento_id: Number(d.id),
      fornecedor_id: Number(d.fornecedor_id),
      tipo: d.tipo,
      validade: d.validade,
      vencido: vencido(d.validade),
      situacao: d.situacao,
    }));

  const bloqueados = fornecedores
    .filter((f) => ['bloqueado', 'suspenso'].includes(String(f.homologacao_status)))
    .map((f) => ({ id: Number(f.id), nome: f.nome, status: f.homologacao_status, motivo: f.homologacao_motivo ?? null }));

  return res.json({
    regra: 'Nenhum indicador aqui é gravado: todos são derivados de compras, itens e cadastro de fornecedores.',
    pedidos: { total: compras.length, por_status: Object.fromEntries(porStatus) },
    homologacao: {
      por_status: Object.fromEntries(porHomologacao),
      legenda: Object.fromEntries(HOMOLOGACAO_STATUS.map((o) => [o.value, o.label])),
      bloqueados,
    },
    proximas_entregas: proximasEntregas,
    documentos_vencendo: documentosVencendo,
    em_aberto: emAberto.length,
  });
}
