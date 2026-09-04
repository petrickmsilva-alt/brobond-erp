// ============================================================
// Chat Interno — mensagens entre usuários do sistema.
//
// GET  /api/chat/conversas           — lista conversas do usuário
// GET  /api/chat/:userId/mensagens   — mensagens com um usuário
// POST /api/chat/:userId/mensagens   — envia mensagem
// GET  /api/chat/nao-lidas           — count de mensagens não lidas
//
// Implementação simples (polling via API). Para WebSocket em tempo real,
// integrar socket.io ou SSE no futuro.
// ============================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getStore } from './services';
import { currentUser } from './auth';
import { parseId } from './validate';
import { getResource } from './resources';
import type { Row, Tx } from './store';

/** GET /api/chat/conversas — lista conversas (última mensagem de cada). */
export async function listConversas(req: Request, res: Response) {
  const actor = currentUser(req);
  const s = getStore();

  // Usa a tabela auditoria com recurso = 'chat' para armazenar mensagens
  const auditoria = getResource('auditoria')!;
  const mensagens = await s.list(auditoria, {
    page: 1,
    pageSize: 5000,
    sort: 'data',
    dir: 'desc',
    filter: { recurso: 'chat' },
  });

  // Agrupa por par de usuários
  const conversas = new Map<string, { com_usuario_id: number; com_usuario: string; ultima_msg: string; ultima_data: string; nao_lidas: number }>();

  for (const m of mensagens.rows) {
    const dados = (m.dados || {}) as Record<string, any>;
    const de = Number(dados.de_id);
    const para = Number(dados.para_id);
    if (de !== actor.id && para !== actor.id) continue;

    const outroId = de === actor.id ? para : de;
    const outroNome = String(dados.de_nome || 'Usuário');
    const key = String(Math.min(de, para)) + '-' + String(Math.max(de, para));

    if (!conversas.has(key)) {
      conversas.set(key, { com_usuario_id: outroId, com_usuario: outroNome, ultima_msg: String(dados.texto || ''), ultima_data: String(m.data), nao_lidas: 0 });
    }
    // Conta não lidas (mensagens recebidas não marcadas como lidas)
    if (para === actor.id && !dados.lido) {
      conversas.get(key)!.nao_lidas++;
    }
  }

  res.json([...conversas.values()].sort((a, b) => b.ultima_data.localeCompare(a.ultima_data)));
}

/** GET /api/chat/:userId/mensagens — mensagens com um usuário. */
export async function listMensagens(req: Request, res: Response) {
  const actor = currentUser(req);
  const outroId = parseId(req.params.userId);
  const s = getStore();

  const auditoria = getResource('auditoria')!;
  const mensagens = await s.list(auditoria, {
    page: 1,
    pageSize: 500,
    sort: 'data',
    dir: 'asc',
    filter: { recurso: 'chat' },
  });

  const chat = mensagens.rows.filter((m) => {
    const dados = (m.dados || {}) as Record<string, any>;
    const de = Number(dados.de_id);
    const para = Number(dados.para_id);
    return (de === actor.id && para === outroId) || (de === outroId && para === actor.id);
  });

  // Marca como lidas
  // (Em implementação completa, atualizaria o campo dados.lido)

  res.json(chat.map((m) => ({
    id: m.id,
    de: (m.dados as any)?.de_id === actor.id ? 'eu' : 'outro',
    de_id: Number((m.dados as any)?.de_id),
    de_nome: (m.dados as any)?.de_nome || '',
    texto: (m.dados as any)?.texto || '',
    data: m.data,
  })));
}

/** POST /api/chat/:userId/mensagens — envia mensagem. */
export async function sendMessage(req: Request, res: Response) {
  const actor = currentUser(req);
  const paraId = parseId(req.params.userId);
  const texto = String(req.body?.texto || '').trim();

  if (!texto) throw new HttpError(400, 'Mensagem não pode ser vazia.', { texto: 'Campo obrigatório' });
  if (texto.length > 2000) throw new HttpError(400, 'Mensagem muito longa (máx. 2000 caracteres).', { texto: 'Máximo de 2000 caracteres' });
  if (paraId === actor.id) throw new HttpError(400, 'Não é possível enviar mensagem para si mesmo.');

  const s = getStore();

  // Busca nome do destinatário
  const destinatario = await s.findOneWhere(getResource('usuarios')!, { id: paraId });
  if (!destinatario) throw new HttpError(404, 'Usuário não encontrado.');

  await s.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'criar',
    recurso: 'chat',
    registro_id: paraId,
    descricao: `Mensagem de ${actor.name} para ${destinatario.nome}`,
    dados: { de_id: actor.id, de_nome: actor.name, para_id: paraId, para_nome: destinatario.nome, texto, lido: false },
  });

  res.status(201).json({ ok: true });
}

/** GET /api/chat/nao-lidas — count total de mensagens não lidas. */
export async function countNaoLidas(req: Request, res: Response) {
  const actor = currentUser(req);
  const s = getStore();

  const auditoria = getResource('auditoria')!;
  const mensagens = await s.list(auditoria, {
    page: 1,
    pageSize: 5000,
    filter: { recurso: 'chat' },
  });

  let count = 0;
  for (const m of mensagens.rows) {
    const dados = (m.dados || {}) as Record<string, any>;
    if (Number(dados.para_id) === actor.id && !dados.lido) count++;
  }

  res.json({ count });
}
