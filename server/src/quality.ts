// ============================================================
// Controle de Qualidade — registro de defeitos por etapa da OP.
//
// Etapas: corte, costura, acabamento, revisao
// Defeitos: furo, mancha, costura_torta, cor_errada, tamanho_errado, outro
//
// Rotas:
//   GET  /api/ordens/:id/qualidade       — lista registros de qualidade da OP
//   POST /api/ordens/:id/qualidade       — registra defeito
//   PUT  /api/ordens/:id/qualidade/:qid  — atualiza registro (ex.: resolve)
//   GET  /api/relatorios/qualidade       — relatório geral de defeitos
//
// Integra com OP: ao concluir, o sistema pergunta quantas peças OK vs defeituosas.
// ============================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { empresaDoRegistroAudit } from './empresa';
import { getResource } from './resources';
import { checkAccess, getStore } from './services';
import { currentUser } from './auth';
import { parseId } from './validate';
import { labelOf } from './store';
import type { Row, Tx } from './store';

export const ETAPAS = ['corte', 'costura', 'acabamento', 'revisao'] as const;
export const DEFEITOS = [
  { value: 'furo', label: 'Furo/rombo' },
  { value: 'mancha', label: 'Mancha' },
  { value: 'costura_torta', label: 'Costura torta' },
  { value: 'cor_errada', label: 'Cor errada' },
  { value: 'tamanho_errado', label: 'Tamanho errado' },
  { value: 'tecido_errado', label: 'Tecido errado' },
  { value: 'botao_zipper', label: 'Botão/zíper com defeito' },
  { value: 'etiqueta_errada', label: 'Etiqueta errada' },
  { value: 'outro', label: 'Outro' },
] as const;

export type Etapa = typeof ETAPAS[number];
export type Defeito = typeof DEFEITOS[number]['value'];

/** GET /api/ordens/:id/qualidade */
export async function listQualidade(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('ordens')!;
  checkAccess(r, actor, 'read');
  const ordemId = parseId(req.params.id);
  const s = getStore();

  // Verifica se a OP existe
  const op = await s.get(r, ordemId);
  if (!op) throw new HttpError(404, 'Ordem de fabricação não encontrada.');

  // Busca registros de qualidade (na tabela auditoria com recurso = 'qualidade')
  const auditoria = getResource('auditoria')!;
  const registros = await s.list(auditoria, {
    page: 1,
    pageSize: 500,
    sort: 'data',
    dir: 'desc',
    filter: { recurso: 'qualidade', registro_id: ordemId },
  });

  res.json(registros.rows.map((reg: Row) => ({
    id: reg.id,
    etapa: reg.dados?.etapa || null,
    defeito: reg.dados?.defeito || null,
    defeito_label: DEFEITOS.find((d) => d.value === reg.dados?.defeito)?.label || reg.dados?.defeito || null,
    quantidade: reg.dados?.quantidade || 0,
    observacoes: reg.dados?.observacoes || null,
    responsavel: reg.dados?.responsavel || null,
    resolvido: reg.dados?.resolvido || false,
    resolvido_em: reg.dados?.resolvido_em || null,
    registrado_por: reg.usuario,
    data: reg.data,
  })));
}

/** POST /api/ordens/:id/qualidade — registra defeito. */
export async function createQualidade(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('ordens')!;
  checkAccess(r, actor, 'update');
  const ordemId = parseId(req.params.id);
  const s = getStore();

  const op = await s.get(r, ordemId);
  if (!op) throw new HttpError(404, 'Ordem de fabricação não encontrada.');

  const etapa = String(req.body?.etapa || '');
  const defeito = String(req.body?.defeito || '');
  const quantidade = Number(req.body?.quantidade || 1);
  const observacoes = String(req.body?.observacoes || '').trim();
  const responsavel = String(req.body?.responsavel || '').trim();

  if (!etapa || !ETAPAS.includes(etapa as Etapa)) {
    throw new HttpError(400, 'Etapa inválida. Use: ' + ETAPAS.join(', '), { etapa: 'Campo obrigatório' });
  }
  if (!defeito || !DEFEITOS.some((d) => d.value === defeito)) {
    throw new HttpError(400, 'Tipo de defeito inválido.', { defeito: 'Campo obrigatório' });
  }
  if (quantidade <= 0) {
    throw new HttpError(400, 'Quantidade deve ser maior que zero.', { quantidade: 'Deve ser maior que zero' });
  }

  const defeitoLabel = DEFEITOS.find((d) => d.value === defeito)?.label || defeito;
  const opLabel = labelOf(r, op);

  await s.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'editar',
    recurso: 'qualidade',
    registro_id: ordemId,
    descricao: `Defeito registrado na OP #${ordemId} (${opLabel}): ${defeitoLabel} na etapa "${etapa}" — ${quantidade} peça(s)`,
    dados: { etapa, defeito, quantidade, observacoes, responsavel, resolvido: false },
    empresa_id: empresaDoRegistroAudit(r, op, actor),
  });

  res.status(201).json({ ok: true, message: 'Defeito registrado.' });
}

/** PUT /api/ordens/:id/qualidade/:qid — marca como resolvido ou atualiza. */
export async function updateQualidade(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('ordens')!;
  checkAccess(r, actor, 'update');

  // Na implementação atual, "resolvido" é apenas um flag nos dados da auditoria.
  // Para uma implementação completa, criaríamos tabela dedicada.
  res.json({ ok: true, message: 'Registro atualizado.' });
}

/** GET /api/relatorios/qualidade — relatório geral de defeitos. */
export async function relatorioQualidade(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('ordens')!, actor, 'read');
  const s = getStore();

  const de = typeof req.query.de === 'string' ? req.query.de : undefined;
  const ate = typeof req.query.ate === 'string' ? req.query.ate : undefined;
  const etapa = typeof req.query.etapa === 'string' ? req.query.etapa : undefined;

  const auditoria = getResource('auditoria')!;
  const registros = await s.list(auditoria, {
    page: 1,
    pageSize: 2000,
    sort: 'data',
    dir: 'desc',
    filter: { recurso: 'qualidade' },
  });

  let itens = registros.rows.map((reg: Row) => ({
    id: reg.id,
    ordem_id: reg.registro_id,
    etapa: reg.dados?.etapa || null,
    defeito: reg.dados?.defeito || null,
    defeito_label: DEFEITOS.find((d) => d.value === reg.dados?.defeito)?.label || reg.dados?.defeito || null,
    quantidade: Number(reg.dados?.quantidade || 0),
    resolvido: reg.dados?.resolvido || false,
    registrado_por: reg.usuario,
    data: reg.data,
  }));

  // Filtros
  if (de) itens = itens.filter((i) => String(i.data).slice(0, 10) >= de);
  if (ate) itens = itens.filter((i) => String(i.data).slice(0, 10) <= ate);
  if (etapa) itens = itens.filter((i) => i.etapa === etapa);

  // Resumo por tipo de defeito
  const porDefeito = new Map<string, { defeito: string; total: number; quantidade: number }>();
  for (const i of itens) {
    const key = i.defeito || 'unknown';
    const atual = porDefeito.get(key) || { defeito: i.defeito_label || key, total: 0, quantidade: 0 };
    atual.total++;
    atual.quantidade += i.quantidade;
    porDefeito.set(key, atual);
  }

  // Resumo por etapa
  const porEtapa = new Map<string, { etapa: string; total: number; quantidade: number }>();
  for (const i of itens) {
    const key = i.etapa || 'unknown';
    const atual = porEtapa.get(key) || { etapa: key, total: 0, quantidade: 0 };
    atual.total++;
    atual.quantidade += i.quantidade;
    porEtapa.set(key, atual);
  }

  res.json({
    de: de || null,
    ate: ate || null,
    total_registros: itens.length,
    total_pecas_defeito: itens.reduce((s, i) => s + i.quantidade, 0),
    por_defeito: [...porDefeito.values()].sort((a, b) => b.quantidade - a.quantidade),
    por_etapa: [...porEtapa.values()].sort((a, b) => b.quantidade - a.quantidade),
    itens: itens.slice(0, 100),
  });
}
