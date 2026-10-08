// ============================================================================
// MULTIEMPRESA — API do seletor de empresa e das concessões de acesso.
//
//   GET    /api/empresas/ativa            — empresa ativa + opções do seletor
//   POST   /api/empresas/ativa            — troca a empresa da SESSÃO
//   GET    /api/usuarios/:id/empresas     — concessões de um usuário  (admin)
//   POST   /api/usuarios/:id/empresas     — concede acesso            (admin)
//   DELETE /api/usuarios/:id/empresas/:empresaId — revoga acesso      (admin)
//
// Trocar de empresa devolve um TOKEN NOVO com o claim `emp`. É isso que torna
// o seletor persistente na sessão sem guardar estado mutável no servidor — e
// é também o que impede alguém de "trocar de empresa" mexendo no localStorage:
// o claim é assinado e, ainda assim, revalidado contra `usuario_empresas` a
// cada requisição (empresasAcesso.ts).
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { currentUser, signToken } from './auth';
import { escopoDoAtor, exigirEmpresaPermitida } from './empresa';
import { empresasDoUsuario, invalidarCacheEmpresas } from './empresasAcesso';
import { getResource } from './resources';
import { getStore } from './services';
import { parseId } from './validate';
import type { Row } from './store';

function exigirAdmin(req: Request) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Apenas administradores administram o acesso a empresas.');
  return actor;
}

async function empresasPorId(ids: number[]): Promise<Map<number, Row>> {
  const r = getResource('empresas')!;
  const { rows } = await getStore().list(r, { page: 1, pageSize: 500 });
  const mapa = new Map<number, Row>();
  for (const row of rows) if (ids.includes(Number(row.id))) mapa.set(Number(row.id), row);
  return mapa;
}

/** GET /api/empresas/ativa — o que o seletor precisa desenhar. */
export async function empresaAtiva(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor as any);
  const mapa = await empresasPorId(escopo.permitidas);

  res.json({
    empresa_id: escopo.empresaId,
    empresa: mapa.get(escopo.empresaId)?.nome ?? null,
    consolidado: escopo.consolidado,
    pode_consolidar: actor.pode_consolidar === true,
    empresa_padrao: Number(actor.empresa_id) || null,
    empresas: escopo.permitidas.map((id) => ({
      id,
      nome: mapa.get(id)?.nome ?? `Empresa #${id}`,
      cnpj: mapa.get(id)?.cnpj ?? null,
      ativa: id === escopo.empresaId,
    })),
  });
}

/**
 * POST /api/empresas/ativa { empresa_id }
 *
 * Responde com um token novo. O cliente substitui o atual: a sessão (mesmo
 * `sid`, mesma validade) passa a operar na empresa escolhida.
 */
export async function trocarEmpresaAtiva(req: Request, res: Response) {
  const actor = currentUser(req);
  const alvo = Number((req.body as Record<string, unknown>)?.empresa_id);
  exigirEmpresaPermitida(actor as any, alvo);

  const empresa = (await empresasPorId([alvo])).get(alvo);
  if (!empresa) throw new HttpError(404, 'Empresa não encontrada.');
  if (empresa.ativo === false) throw new HttpError(409, `A empresa “${String(empresa.nome)}” está inativa.`);

  const sid = (req as any).sid as string | undefined;
  if (!sid) throw new HttpError(401, 'Sessão inválida. Entre novamente.');

  const token = signToken({ ...actor, empresa_sessao: alvo }, { sid, emp: alvo });

  await getStore().audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'seguranca',
    recurso: 'empresas',
    registro_id: alvo,
    descricao: `${actor.name} passou a operar na empresa “${String(empresa.nome)}”`,
    dados: { empresa_id: alvo },
    empresa_id: alvo,
  });

  res.json({ ok: true, token, empresa_id: alvo, empresa: empresa.nome });
}

/** GET /api/usuarios/:id/empresas — concessões vigentes. */
export async function listarEmpresasDoUsuario(req: Request, res: Response) {
  exigirAdmin(req);
  const usuarioId = parseId(req.params.id);
  const usuario = await getStore().findOneWhere(getResource('usuarios')!, { id: usuarioId });
  if (!usuario) throw new HttpError(404, 'Usuário não encontrado.');

  const padrao = Number(usuario.empresa_id) || 1;
  const ids = await empresasDoUsuario(usuarioId, padrao);
  const mapa = await empresasPorId(ids);

  res.json({
    usuario_id: usuarioId,
    empresa_padrao: padrao,
    pode_consolidar: usuario.pode_consolidar === true,
    empresas: ids.map((id) => ({
      id,
      nome: mapa.get(id)?.nome ?? `Empresa #${id}`,
      padrao: id === padrao,
    })),
  });
}

/** POST /api/usuarios/:id/empresas { empresa_id } — concede acesso. */
export async function concederEmpresa(req: Request, res: Response) {
  const actor = exigirAdmin(req);
  const usuarioId = parseId(req.params.id);
  const empresaId = Number((req.body as Record<string, unknown>)?.empresa_id);
  if (!Number.isInteger(empresaId) || empresaId <= 0) throw new HttpError(400, 'Informe a empresa.');

  const s = getStore();
  const [usuario, empresa] = await Promise.all([
    s.findOneWhere(getResource('usuarios')!, { id: usuarioId }),
    s.findOneWhere(getResource('empresas')!, { id: empresaId }),
  ]);
  if (!usuario) throw new HttpError(404, 'Usuário não encontrado.');
  if (!empresa) throw new HttpError(404, 'Empresa não encontrada.');

  const r = getResource('usuario_empresas')!;
  const existente = await s.findOneWhere(r, { usuario_id: usuarioId, empresa_id: empresaId });
  if (!existente) {
    await s.insert(r, { usuario_id: usuarioId, empresa_id: empresaId });
    await s.audit({
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao: 'seguranca',
      recurso: 'usuarios',
      registro_id: usuarioId,
      descricao: `Acesso à empresa “${String(empresa.nome)}” concedido a ${String(usuario.nome || usuario.email)}`,
      dados: { empresa_id: empresaId },
      empresa_id: empresaId,
    });
  }
  invalidarCacheEmpresas(usuarioId);
  res.status(existente ? 200 : 201).json({ ok: true, usuario_id: usuarioId, empresa_id: empresaId });
}

/** DELETE /api/usuarios/:id/empresas/:empresaId — revoga acesso. */
export async function revogarEmpresa(req: Request, res: Response) {
  const actor = exigirAdmin(req);
  const usuarioId = parseId(req.params.id);
  const empresaId = parseId(req.params.empresaId);

  const s = getStore();
  const usuario = await s.findOneWhere(getResource('usuarios')!, { id: usuarioId });
  if (!usuario) throw new HttpError(404, 'Usuário não encontrado.');

  // A empresa padrão não é revogável: deixaria o usuário sem lugar algum.
  if (Number(usuario.empresa_id || 1) === empresaId) {
    throw new HttpError(409, 'Esta é a empresa padrão do usuário. Troque a empresa padrão antes de revogar o acesso.');
  }

  const r = getResource('usuario_empresas')!;
  const vinculo = await s.findOneWhere(r, { usuario_id: usuarioId, empresa_id: empresaId });
  if (vinculo) {
    await s.remove(r, Number(vinculo.id));
    await s.audit({
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao: 'seguranca',
      recurso: 'usuarios',
      registro_id: usuarioId,
      descricao: `Acesso à empresa #${empresaId} revogado de ${String(usuario.nome || usuario.email)}`,
      dados: { empresa_id: empresaId },
      empresa_id: empresaId,
    });
  }
  invalidarCacheEmpresas(usuarioId);
  res.json({ ok: true });
}
