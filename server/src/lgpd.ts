// ============================================================================
// FASE 7 — LGPD: DIREITO DO TITULAR (PORTABILIDADE E TRANSPARÊNCIA).
//
// Reúne, em UM retorno, tudo o que a empresa ativa guarda sobre o cliente, para
// atender ao direito de acesso/portabilidade do titular (LGPD art. 18). NÃO cria
// tabela nem segundo cadastro: lê os documentos canônicos já existentes e é
// recortado por `empresa_id` (o titular de uma empresa não enxerga dado de
// outra). Cada exportação é auditada — quem exportou, quando e sobre quem.
//
// O retorno é SOMENTE LEITURA e não altera nada. Anonimização/exclusão são
// processos jurídicos com prazo de retenção e NÃO são executados por aqui: a
// estrutura entrega a visão completa e deixa a decisão registrada.
// ============================================================================
import type { Request, Response } from 'express';
import { getStore, checkAccess, escopoDe } from './services';
import { getResource } from './resources';
import { currentUser } from './auth';
import { foraDaCarteira } from './empresa';
import { HttpError } from './errors';
import type { Row } from './store';

type S = ReturnType<typeof getStore>;

async function listar(s: S, key: string, empresaId: number, filtro: Record<string, unknown> = {}): Promise<Row[]> {
  const r = getResource(key)!;
  const p = await s.list(r, { page: 1, pageSize: 50_000, filter: { ...filtro, empresa_id: empresaId } });
  return p.rows;
}

/**
 * Exporta os dados pessoais do cliente (direito de acesso/portabilidade).
 * Multiempresa: o cliente e TODAS as leituras são recortados pela empresa ativa;
 * cliente de outra empresa devolve 404 (nunca 403 — não se confirma existência).
 */
export async function exportarDadosTitular(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('clientes')!, actor, 'read');
  const escopo = escopoDe(actor);
  const clienteId = Number(req.params.id);
  if (!Number.isSafeInteger(clienteId) || clienteId < 1) throw new HttpError(400, 'Cliente inválido.');
  const s = getStore();
  const empresaId = escopo.empresaId;

  const cliente = await s.findOneWhere(getResource('clientes')!, { id: clienteId, empresa_id: empresaId });
  // 404 (nunca 403) para cliente de outra empresa. Representante só exporta a
  // própria carteira — o recorte é do servidor, não do cliente HTTP.
  if (!cliente || foraDaCarteira(getResource('clientes')!, cliente, escopo)) {
    throw new HttpError(404, 'Cliente não encontrado nesta empresa.');
  }

  const [consents, preferences, vendas, tickets, devolucoes, leads, pontos] = await Promise.all([
    listar(s, 'customer_consents', empresaId, { cliente_id: clienteId }),
    listar(s, 'customer_preferences', empresaId, { cliente_id: clienteId }),
    listar(s, 'vendas', empresaId, { cliente_id: clienteId }),
    listar(s, 'service_tickets', empresaId, { cliente_id: clienteId }),
    listar(s, 'devolucoes', empresaId, { cliente_id: clienteId }),
    listar(s, 'crm_leads', empresaId, { cliente_id: clienteId }),
    listar(s, 'loyalty_movements', empresaId, { cliente_id: clienteId }),
  ]);

  // Contato/identificação: só os campos pessoais do cadastro (sem dado fiscal
  // irrelevante ao titular e sem campos internos de sistema).
  const dadosCadastrais = {
    id: clienteId, nome: cliente.nome ?? null, razao_social: cliente.razao_social ?? null,
    nome_fantasia: cliente.nome_fantasia ?? null, cnpj_cpf: cliente.cnpj_cpf ?? null,
    email: cliente.email ?? null, telefone: cliente.telefone ?? null, whatsapp: cliente.whatsapp ?? null,
    tipo: cliente.tipo ?? null,
  };

  await s.audit({
    empresa_id: empresaId, usuario_id: actor.id || null, usuario: actor.name || null,
    acao: 'exportar', recurso: 'clientes', registro_id: clienteId,
    descricao: 'Exportação de dados do titular (LGPD)', dados: { cliente_id: clienteId },
  });

  res.json({
    finalidade: 'Atendimento ao direito de acesso e portabilidade do titular (LGPD art. 18).',
    titular: dadosCadastrais,
    consentimentos: consents.map((c) => ({ finalidade: c.finalidade, concedido: c.concedido, atualizado_em: c.atualizado_em ?? c.criado_em ?? null })),
    preferencias: preferences.map((p) => ({ canal_preferido: p.canal_preferido ?? null, idioma: p.idioma ?? null, observacoes: p.observacoes ?? null })),
    compras: vendas.map((v) => ({ id: Number(v.id), status: v.status, total: v.total, canal: v.canal ?? null, data: v.faturada_em ?? v.data ?? null })),
    atendimentos: tickets.map((t) => ({ id: Number(t.id), numero: t.numero ?? null, assunto: t.assunto ?? null, status: t.status, canal: t.canal ?? null, criado_em: t.criado_em ?? null })),
    devolucoes: devolucoes.map((d) => ({ id: Number(d.id), numero: d.numero ?? null, status: d.status, motivo: d.motivo ?? null, criado_em: d.criado_em ?? null })),
    oportunidades: leads.map((l) => ({ id: Number(l.id), nome: l.nome ?? null, canal: l.canal ?? null, status: l.status ?? null })),
    fidelidade: pontos.map((m) => ({ id: Number(m.id), tipo: m.tipo, pontos: m.pontos, expira_em: m.expira_em ?? null, criado_em: m.criado_em ?? null })),
    limitacoes: [
      'A exportação reflete os dados da EMPRESA ATIVA do solicitante; dados em outras empresas não são acessíveis por este endpoint.',
      'Anonimização e exclusão seguem processo jurídico e prazo de retenção — não são executadas automaticamente por esta rota.',
    ],
    gerado_em: new Date().toISOString(),
  });
}
