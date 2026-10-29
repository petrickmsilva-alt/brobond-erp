import type { Request, Response } from 'express';
import { currentUser } from './auth';
import { escopoDoAtor } from './empresa';
import { HttpError } from './errors';

/**
 * Estado das capacidades realmente presentes nesta instalação.
 *
 * A inspeção de resources, Store, SQL, migrations e Prisma não encontrou
 * persistência de creators, matches, contatos ou campanhas de creators.
 * crm_campanhas é aquisição CRM, NÃO uma campanha de creators.
 *
 * Este endpoint NÃO é uma listagem fictícia: não retorna rows, totais ou scores,
 * não consulta outros domínios e não oferece escrita/IA sem implementação.
 * Montado sob os mesmos guards de sessão e prontidão do restante da API.
 */
export function capacidadesCreators(req: Request, res: Response) {
  const actor = currentUser(req);
  if (!actor) throw new HttpError(401, 'Autenticação necessária.');
  if (actor.id <= 0 || !['operador', 'gerente', 'admin'].includes(actor.perfil)) {
    throw new HttpError(403, 'Você não tem permissão para esta ação.');
  }
  const escopo = escopoDoAtor(actor);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    empresa_id: escopo.empresaId,
    modulos: {
      creators: { estado: 'PENDENTE_DE_CONFIGURACAO', motivo: 'PERSISTENCIA_NAO_INSTALADA', fonte: null, consulta: false, criacao: false },
      'creator-matches': { estado: 'PENDENTE_DE_CONFIGURACAO', motivo: 'PERSISTENCIA_NAO_INSTALADA', fonte: null, consulta: false, recomendacao: false },
      'outreach-ai': { estado: 'PENDENTE_DE_CONFIGURACAO', motivo: 'PERSISTENCIA_NAO_INSTALADA', fonte: null, consulta: false, geracao: false, envio: false },
      campanhas: { estado: 'PENDENTE_DE_CONFIGURACAO', motivo: 'PERSISTENCIA_NAO_INSTALADA', fonte: null, consulta: false, criacao: false },
    },
  });
}
