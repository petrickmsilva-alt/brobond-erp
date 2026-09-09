// ============================================================
// Administração de usuários — gestão profissional de acesso (ERP):
//   • Convite por token (e-mail): o usuário define a PRÓPRIA senha.
//   • Senha temporária gerada pelo servidor, exibida UMA única vez.
//   • Reset do MFA de um usuário (por administrador, com reautenticação).
//   • Ciclo de vida: ativar/desativar (com motivo), bloqueio manual ou
//     automático, desbloqueio, expiração, revogação de sessão individual
//     ou total, troca forçada de senha.
//   • Painel: resumo gerencial (KPIs + alertas) e ficha do usuário
//     (segurança, sessões, acessos e trilha de auditoria).
//   • Nenhuma senha trafega em texto puro além da exibição única; nenhuma
//     senha é recuperável depois (hash Argon2id irreversível).
// ============================================================
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { HttpError } from './errors';
import { currentUser, exigirReautenticacao, hashPassword, hashResetToken, gerarResetToken, validarSenhaNova, invalidateUserCache, clientIp, contaBloqueada, sidAtual } from './auth';
import { getStore } from './services';
import { RESOURCES } from './resources';
import { smtpConfigurado, enviarEmail } from './mail';
import { revogarTodas, revogarUma } from './sessoes';
import { lerRegistro, restantesRegistro } from './mfaBackup';
import { exigirRateLimit, registrarFalha } from './security';
import { obterPolitica, validarSenhaUsuario, vencimentoSenha } from './politicaSenha';
import { enviarArquivo, type ColunaExport } from './export';

const CONVITE_TTL_HORAS = Number(process.env.INVITE_TTL_HOURS) || 48;

/** Certificação de acessos vale por 12 meses; depois pede recertificação. */
export const CERTIFICACAO_VALIDADE_DIAS = 365;

/** Conta ativa com senha que nunca foi certificada ou venceu a validade. */
function precisaCertificar(u: Record<string, any>, agoraMs: number): boolean {
  if (!u.acesso_certificado_em) return true;
  const ms = new Date(String(u.acesso_certificado_em)).getTime();
  return !Number.isFinite(ms) || agoraMs - ms > CERTIFICACAO_VALIDADE_DIAS * 24 * 3600_000;
}

/** Disparo de webhooks (fire-and-forget — nunca derruba a ação). */
function notificar(evento: string, dados: Record<string, unknown>): void {
  void import('./webhooks')
    .then((m) => m.disparar(evento, dados))
    .catch(() => undefined);
}

function dadosConta(row: Record<string, any>, actor: { name?: string }, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    usuario_id: Number(row.id),
    nome: String(row.nome || ''),
    email: String(row.email || ''),
    perfil: String(row.perfil || ''),
    por: String(actor?.name || ''),
    ...extra,
  };
}

/** Gera uma senha temporária forte (sem caracteres ambíguos). */
export function gerarSenhaTemporaria(bytes = 12): string {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*';
  const buf = randomBytes(bytes);
  let out = '';
  for (const b of buf) out += alfabeto[b % alfabeto.length];
  // Garante as classes mínimas da política.
  if (!/[a-z]/.test(out)) out = 'a' + out.slice(1);
  if (!/[A-Z]/.test(out)) out = out.slice(0, -1) + 'K';
  if (!/\d/.test(out)) out = out.slice(0, -2) + '7' + out.slice(-1);
  return out;
}

/** Grava o convite (hash + expiração) e envia o e-mail. Devolve o link apenas sem SMTP (dev). */
export async function gerarConvite(row: Record<string, any>, actor: { id: number; name: string } | null, tx?: any): Promise<string | undefined> {
  const store = getStore();
  const token = gerarResetToken();
  const expira = new Date(Date.now() + CONVITE_TTL_HORAS * 3600_000).toISOString();
  await store.update(
    RESOURCES.usuarios,
    Number(row.id),
    { convite_token_hash: hashResetToken(token), convite_expira_em: expira, trocar_senha: true },
    tx
  );
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  const link = `${base}/convite/${token}`;
  await enviarEmail({
    to: String(row.email),
    assunto: 'BROBOND ERP — convite de acesso',
    html: `Olá ${String(row.nome || '')}! Você foi convidado(a) para acessar o BROBOND ERP.<br/><br/>Abra o link abaixo (válido por ${CONVITE_TTL_HORAS} horas) para definir a sua senha:<br/><a href="${link}">${link}</a><br/><br/>Se você não esperava este convite, ignore este e-mail.`,
  });
  await store
    .audit({
      usuario_id: actor?.id || null,
      usuario: actor?.name || 'sistema',
      acao: 'convite',
      recurso: 'usuarios',
      registro_id: Number(row.id),
      descricao: `Convite de acesso enviado para ${String(row.email)} (válido por ${CONVITE_TTL_HORAS} h)`,
    })
    .catch(() => undefined);
  return smtpConfigurado() ? undefined : link;
}

/** GET /api/convites/:token — valida o convite (dados mínimos para a tela). */
export async function infoConvite(req: Request, res: Response) {
  const token = String(req.params.token || '').trim();
  const store = getStore();
  const row = await store.findOneWhere(RESOURCES.usuarios, { convite_token_hash: hashResetToken(token) });
  if (!row || row.ativo === false) return res.status(404).json({ error: 'Convite inválido. Peça um novo convite ao administrador.' });
  const expirado = !row.convite_expira_em || new Date(String(row.convite_expira_em)).getTime() < Date.now();
  res.json({ nome: String(row.nome || ''), email: String(row.email), expirado });
}

/** POST /api/convites/aceitar — { token, senha }: o usuário define a própria senha. */
export async function aceitarConvite(req: Request, res: Response) {
  const token = String(req.body?.token ?? '').trim();
  const senha = String(req.body?.senha ?? '');
  if (!token || !senha) throw new HttpError(400, 'Envie o token do convite e a nova senha.');
  const ip = clientIp(req);
  await exigirRateLimit('convite', ip);
  const store = getStore();
  const row = await store.findOneWhere(RESOURCES.usuarios, { convite_token_hash: hashResetToken(token) });
  if (!row || row.ativo === false) {
    await registrarFalha('convite', ip);
    throw new HttpError(400, 'Convite inválido ou já utilizado. Peça um novo convite ao administrador.');
  }
  if (!row.convite_expira_em || new Date(String(row.convite_expira_em)).getTime() < Date.now()) {
    throw new HttpError(400, 'Este convite expirou. Peça um novo convite ao administrador.');
  }
  // Primeira senha: vale a política configurável (sem histórico — não há anterior).
  const erro = await validarSenhaUsuario(senha, { email: String(row.email) }, true);
  if (erro) throw new HttpError(400, erro, { senha: erro });
  const versao = Number(row.token_versao || 0) + 1;
  await store.update(RESOURCES.usuarios, Number(row.id), {
    senha_hash: await hashPassword(senha),
    convite_token_hash: null,
    convite_expira_em: null,
    trocar_senha: false,
    senha_provisoria: false,
    senha_definida_em: new Date().toISOString(),
    token_versao: versao,
  });
  await revogarTodas(Number(row.id));
  await store
    .audit({
      usuario_id: Number(row.id),
      usuario: String(row.nome || row.email),
      acao: 'convite',
      recurso: 'usuarios',
      registro_id: Number(row.id),
      descricao: `Convite aceito — ${String(row.email)} definiu a própria senha`,
      dados: { metodo: 'convite' },
    })
    .catch(() => undefined);
  invalidateUserCache(Number(row.id));
  res.json({ ok: true });
}

/** POST /api/usuarios/:id/reenviar-convite — novo token + e-mail (admin). */
export async function reenviarConvite(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Apenas administradores reenviam convites.');
  const store = getStore();
  const row = await store.findOneWhere(RESOURCES.usuarios, { id: Number(req.params.id) });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  if (row.senha_hash) throw new HttpError(409, 'Este usuário já definiu a senha. Use "Gerar senha temporária" para redefinir o acesso.');
  const link = await gerarConvite(row, actor);
  notificar('usuario.convite_enviado', dadosConta(row, actor));
  res.json({ ok: true, ...(link ? { convite_link: link } : {}) });
}

/**
 * POST /api/usuarios/:id/senha-temporária — admin gera senha temporária.
 * Requer reautenticação recente. A senha aparece UMA única vez na resposta
 * (Cache-Control: no-store); o banco guarda apenas o hash Argon2id, e todas
 * as sessões anteriores do usuário são derrubadas.
 */
export async function senhaTemporaria(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Apenas administradores geram senhas temporárias.');
  exigirReautenticacao(req);
  const store = getStore();
  const row = await store.findOneWhere(RESOURCES.usuarios, { id: Number(req.params.id) });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  if (row.ativo === false) throw new HttpError(409, 'Usuário desativado: reative-o antes de gerar uma senha temporária.');
  if (Number(row.id) === Number(actor.id)) throw new HttpError(400, 'Use "Trocar senha" nas Configurações para a sua própria senha.');

  const senha = gerarSenhaTemporaria();
  const versao = Number(row.token_versao || 0) + 1;
  await store.update(RESOURCES.usuarios, Number(row.id), {
    senha_hash: await hashPassword(senha),
    trocar_senha: true,
    senha_provisoria: true,
    senha_definida_em: new Date().toISOString(),
    convite_token_hash: null,
    convite_expira_em: null,
    token_versao: versao,
  });
  const sessoes = await revogarTodas(Number(row.id));
  await store.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'senha',
    recurso: 'usuarios',
    registro_id: Number(row.id),
    descricao: `Senha temporária gerada para ${String(row.email)} (exibição única)${sessoes ? ` — ${sessoes} sessão(ões) encerrada(s)` : ''}`,
    dados: { metodo: 'senha_temporaria', sessoes_encerradas: sessoes },
  });
  invalidateUserCache(Number(row.id));
  notificar('usuario.senha_temporaria', dadosConta(row, actor, { sessoes_encerradas: sessoes }));
  res.setHeader('Cache-Control', 'no-store');
  // Única exibição: a senha NÃO é armazenada em texto puro nem logada.
  res.json({ senha_temporaria: senha, trocar_senha: true, sessoes_encerradas: sessoes });
}

/** Remove segredos de um registro de usuário antes de devolver na API. */
function sanitizarUsuario(row: Record<string, any>): Record<string, any> {
  const out = { ...row };
  delete out.senha_hash;
  delete out.senha_historico;
  delete out.mfa_secret;
  delete out.convite_token_hash;
  delete out.reset_token_hash;
  delete out.mfa_backup_hashes;
  delete out.preferencias;
  return out;
}

/** Status consolidado da conta (mesma regra de services.anotarStatusSenha). */
function statusConta(row: Record<string, any>): { status_conta: string; convite_expirado: boolean; conta_bloqueada: boolean; acesso_expirado: boolean } {
  const agora = Date.now();
  const convite_expirado = row.convite_expira_em ? new Date(String(row.convite_expira_em)).getTime() < agora : false;
  const conta_bloqueada = row.bloqueio_manual === true || (!!row.bloqueado_ate && new Date(String(row.bloqueado_ate)).getTime() > agora);
  const acesso_expirado = !!row.acesso_expira_em && new Date(String(row.acesso_expira_em)).getTime() < agora;
  const status_conta =
    row.ativo === false
      ? 'inativo'
      : conta_bloqueada
        ? 'bloqueado'
        : acesso_expirado
          ? 'expirado'
          : !row.senha_definida_em
            ? convite_expirado
              ? 'convite_expirado'
              : 'convite_pendente'
            : row.trocar_senha
              ? 'provisoria'
              : 'ativo';
  return { status_conta, convite_expirado, conta_bloqueada, acesso_expirado };
}

function exigirAdmin(actor: { perfil: string }, acao: string): void {
  if (actor.perfil !== 'admin') throw new HttpError(403, `Apenas administradores ${acao}.`);
}

function parseIdParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'ID de usuário inválido.');
  return id;
}

/**
 * GET /api/usuarios/resumo — painel gerencial do módulo (admin).
 * KPIs + alertas acionáveis (admin sem MFA, convite expirado, bloqueios,
 * acessos vencidos/a vencer, contas paradas). Tudo calculado sobre a lista
 * completa — a tabela de usuários é pequena (< milhares) em qualquer ERP.
 */
export async function resumoUsuarios(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdmin(actor, 'veem o resumo de usuários.');
  const store = getStore();
  const agora = Date.now();
  const hoje = new Date().toISOString().slice(0, 10);
  const ha30d = agora - 30 * 24 * 3600_000;
  const em7d = agora + 7 * 24 * 3600_000;

  const todos = await store.list(RESOURCES.usuarios, { page: 1, pageSize: 5000, sort: 'nome', dir: 'asc' });
  const rows = todos.rows;
  const politica = await obterPolitica();

  const t = {
    total: rows.length,
    ativos: 0,
    inativos: 0,
    admins: 0,
    gerentes: 0,
    operadores: 0,
    convites_pendentes: 0,
    convites_expirados: 0,
    troca_pendente: 0,
    mfa_ativos: 0,
    bloqueados: 0,
    acesso_expirado: 0,
    sem_login_30d: 0,
    logins_hoje: 0,
    falhas_24h: 0,
    senhas_expiradas: 0,
    senhas_a_vencer: 0,
    nao_certificados: 0,
    sessoes_ativas: 0 as number | null,
  };
  const alertas: { tipo: string; usuario_id: number; nome: string; email: string; detalhe: string }[] = [];

  for (const u of rows) {
    const st = statusConta(u);
    const ativo = u.ativo !== false;
    if (ativo) t.ativos++;
    else t.inativos++;
    if (u.perfil === 'admin') t.admins++;
    else if (u.perfil === 'gerente') t.gerentes++;
    else t.operadores++;
    if (u.mfa_ativado_em) t.mfa_ativos++;
    if (st.status_conta === 'convite_pendente') t.convites_pendentes++;
    if (st.status_conta === 'convite_expirado') {
      t.convites_expirados++;
      if (ativo) alertas.push({ tipo: 'convite_expirado', usuario_id: Number(u.id), nome: String(u.nome || ''), email: String(u.email || ''), detalhe: 'Convite venceu — reenvie para liberar o acesso.' });
    }
    if (st.status_conta === 'provisoria') t.troca_pendente++;
    if (st.conta_bloqueada) {
      t.bloqueados++;
      alertas.push({ tipo: 'bloqueado', usuario_id: Number(u.id), nome: String(u.nome || ''), email: String(u.email || ''), detalhe: String(u.motivo_bloqueio || 'Bloqueio temporário por tentativas incorretas.') });
    }
    if (st.acesso_expirado) {
      t.acesso_expirado++;
      if (ativo) alertas.push({ tipo: 'acesso_expirado', usuario_id: Number(u.id), nome: String(u.nome || ''), email: String(u.email || ''), detalhe: 'Acesso temporário venceu — renove ou desative a conta.' });
    } else if (u.acesso_expira_em && new Date(String(u.acesso_expira_em)).getTime() < em7d && ativo) {
      alertas.push({ tipo: 'acesso_a_vencer', usuario_id: Number(u.id), nome: String(u.nome || ''), email: String(u.email || ''), detalhe: `Acesso vence em ${new Date(String(u.acesso_expira_em)).toLocaleDateString('pt-BR')}.` });
    }
    if (u.perfil === 'admin' && ativo && !u.mfa_ativado_em) {
      alertas.push({ tipo: 'admin_sem_mfa', usuario_id: Number(u.id), nome: String(u.nome || ''), email: String(u.email || ''), detalhe: 'Administrador sem MFA — obrigatório para este perfil.' });
    }
    // Onda 4: vencimento de senha (política) + pendências de certificação.
    if (ativo && u.senha_definida_em) {
      const venc = vencimentoSenha(u, politica, agora);
      if (venc.expirada) {
        t.senhas_expiradas++;
        alertas.push({ tipo: 'senha_expirada', usuario_id: Number(u.id), nome: String(u.nome || ''), email: String(u.email || ''), detalhe: 'Senha vencida pela política — a troca é cobrada no próximo acesso.' });
      } else if (venc.venceEmDias !== null && venc.venceEmDias <= 7) {
        t.senhas_a_vencer++;
        alertas.push({ tipo: 'senha_a_vencer', usuario_id: Number(u.id), nome: String(u.nome || ''), email: String(u.email || ''), detalhe: `Senha vence em ${venc.venceEmDias} dia(s).` });
      }
      if (precisaCertificar(u, agora)) t.nao_certificados++;
    }
    const loginMs = u.ultimo_login ? new Date(String(u.ultimo_login)).getTime() : 0;
    if (String(u.ultimo_login || '').slice(0, 10) === hoje) t.logins_hoje++;
    if (ativo && u.senha_definida_em && (!loginMs || loginMs < ha30d)) t.sem_login_30d++;
  }

  // Sessões ativas totais (só quando a base é pequena, para não estourar queries).
  if (rows.length <= 200) {
    let totalSessoes = 0;
    for (const u of rows) {
      try {
        totalSessoes += (await store.listSessoesAtivas(Number(u.id))).length;
      } catch { /* indiferente */ }
    }
    t.sessoes_ativas = totalSessoes;
  } else {
    t.sessoes_ativas = null;
  }

  // Série de acessos dos últimos 7 dias (gráfico do painel) + falhas 24h.
  // Sai direto da trilha de auditoria; limitada a 2 mil eventos por tipo
  // (muito acima do volume real de logins de um ERP).
  const serie_logins_7d: { dia: string; logins: number; falhas: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    serie_logins_7d.push({ dia: new Date(agora - i * 86400000).toISOString().slice(0, 10), logins: 0, falhas: 0 });
  }
  const porDia = new Map(serie_logins_7d.map((d) => [d.dia, d]));
  try {
    const [ok, falhas] = await Promise.all([
      store.list(RESOURCES.auditoria, { page: 1, pageSize: 2000, sort: 'data', dir: 'desc', filter: { acao: 'login' } }),
      store.list(RESOURCES.auditoria, { page: 1, pageSize: 2000, sort: 'data', dir: 'desc', filter: { acao: 'login_falha' } }),
    ]);
    for (const e of ok.rows) {
      const b = porDia.get(String(e.data).slice(0, 10));
      if (b) b.logins++;
    }
    let f24 = 0;
    for (const e of falhas.rows) {
      const b = porDia.get(String(e.data).slice(0, 10));
      if (b) b.falhas++;
      if (agora - new Date(String(e.data)).getTime() < 86400000) f24++;
    }
    t.falhas_24h = f24;
  } catch { /* gráfico vazio não pode quebrar o painel */ }

  // Alertas mais graves primeiro.
  const peso: Record<string, number> = { admin_sem_mfa: 0, bloqueado: 1, senha_expirada: 2, acesso_expirado: 3, convite_expirado: 4, acesso_a_vencer: 5, senha_a_vencer: 6 };
  alertas.sort((a, b) => (peso[a.tipo] ?? 9) - (peso[b.tipo] ?? 9));
  res.json({ totais: t, alertas: alertas.slice(0, 50), serie_logins_7d });
}

/**
 * GET /api/usuarios/:id/atividade — ficha do usuário (admin): dados
 * sanitizados + status, sessões ativas, últimos acessos, trilha sobre a
 * conta e estatísticas de uso.
 */
export async function atividadeUsuario(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdmin(actor, 'veem a ficha de usuários.');
  const store = getStore();
  const id = parseIdParam(req);
  const row = await store.findOneWhere(RESOURCES.usuarios, { id });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  const vencSenha = vencimentoSenha(row, await obterPolitica());

  const [sessoes, historico, acessos, acessosAmplos] = await Promise.all([
    store.listSessoesAtivas(id).catch((): never[] => []),
    store.list(RESOURCES.auditoria, { page: 1, pageSize: 50, sort: 'data', dir: 'desc', filter: { recurso: 'usuarios', registro_id: id } }).catch(() => ({ rows: [], total: 0 })),
    store.list(RESOURCES.auditoria, { page: 1, pageSize: 20, sort: 'data', dir: 'desc', filter: { usuario_id: id, acao: 'login' } }).catch(() => ({ rows: [], total: 0 })),
    store.list(RESOURCES.auditoria, { page: 1, pageSize: 500, sort: 'data', dir: 'desc', filter: { usuario_id: id } }).catch(() => ({ rows: [], total: 0 })),
  ]);

  let criador: { id: number; nome: string; email: string } | null = null;
  if (row.criado_por) {
    try {
      const c = await store.findOneWhere(RESOURCES.usuarios, { id: Number(row.criado_por) });
      if (c) criador = { id: Number(c.id), nome: String(c.nome || ''), email: String(c.email || '') };
    } catch { /* indiferente */ }
  }

  const ha30d = Date.now() - 30 * 24 * 3600_000;
  const eventos30d = (acessosAmplos.rows || []).filter((e: Record<string, any>) => new Date(String(e.data)).getTime() >= ha30d);
  const logins30d = eventos30d.filter((e: Record<string, any>) => e.acao === 'login').length;

  res.json({
    usuario: {
      ...sanitizarUsuario(row),
      ...statusConta(row),
      mfa_backup_restantes: restantesRegistro(lerRegistro(row.mfa_backup_hashes)),
      senha_expira_em: vencSenha.expiraEm,
      senha_vence_em_dias: vencSenha.venceEmDias,
      senha_expirada: vencSenha.expirada,
    },
    criador,
    sessoes: (sessoes as Record<string, any>[]).map((s) => ({
      sid: String(s.id),
      criada_em: s.criada_em,
      expira_em: s.expira_em,
      ip: s.ip,
      user_agent: s.user_agent,
    })),
    historico: historico.rows,
    historico_total: historico.total,
    acessos: acessos.rows,
    acessos_total: acessos.total,
    estatisticas: {
      logins_30d: logins30d,
      eventos_30d: eventos30d.length,
      tentativas_falhas: Number(row.tentativas_falhas || 0),
      ultimo_falha_em: row.ultimo_falha_em || null,
      sessoes_ativas: (sessoes as unknown[]).length,
    },
  });
}

/** GET /api/usuarios/:id/sessoes — sessões ativas de um usuário (admin). */
export async function sessoesUsuario(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdmin(actor, 'veem sessões de usuários.');
  const store = getStore();
  const id = parseIdParam(req);
  const row = await store.findOneWhere(RESOURCES.usuarios, { id });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  const sessoes = await store.listSessoesAtivas(id);
  res.json({
    usuario: { id: Number(row.id), nome: String(row.nome || ''), email: String(row.email || '') },
    sessoes: sessoes.map((s) => ({ sid: s.id, criada_em: s.criada_em, expira_em: s.expira_em, ip: s.ip, user_agent: s.user_agent })),
  });
}

/**
 * POST /api/usuarios/:id/desativar — { motivo } desliga o acesso na hora:
 * marca trilha (quem/quando/por quê), derruba TODAS as sessões e invalida
 * os tokens. Exige reautenticação. Não vale para si mesmo nem para o
 * último administrador ativo.
 */
export async function desativarUsuario(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdmin(actor, 'desativam usuários.');
  exigirReautenticacao(req);
  const store = getStore();
  const id = parseIdParam(req);
  const row = await store.findOneWhere(RESOURCES.usuarios, { id });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  if (Number(row.id) === Number(actor.id)) throw new HttpError(400, 'Você não pode desativar o seu próprio usuário.');
  if (row.ativo === false) throw new HttpError(400, 'Este usuário já está desativado.');
  const motivo = String(req.body?.motivo ?? '').trim().slice(0, 300);
  if (!motivo) throw new HttpError(400, 'Informe o motivo da desativação.', { motivo: 'Campo obrigatório' });

  if (row.perfil === 'admin') {
    const lista = await store.list(RESOURCES.usuarios, { page: 1, pageSize: 1000, filter: { perfil: 'admin', ativo: true } });
    const outros = lista.rows.filter((u: Record<string, any>) => Number(u.id) !== Number(row.id));
    if (!outros.length) throw new HttpError(400, 'Este é o único administrador ativo. Cadastre outro administrador antes.');
  }

  const versao = Number(row.token_versao || 0) + 1;
  await store.update(RESOURCES.usuarios, id, {
    ativo: false,
    desativado_por: actor.name,
    desativado_em: new Date().toISOString(),
    desativado_motivo: motivo,
    token_versao: versao,
  });
  const sessoes = await revogarTodas(id);
  await store.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'seguranca',
    recurso: 'usuarios',
    registro_id: id,
    descricao: `${String(row.nome || row.email)} DESATIVADO por ${actor.name} — motivo: ${motivo}${sessoes ? ` (${sessoes} sessão(ões) encerrada(s))` : ''}`,
    dados: { motivo, sessoes_encerradas: sessoes },
  });
  invalidateUserCache(id);
  notificar('usuario.desativado', dadosConta(row, actor, { motivo, sessoes_encerradas: sessoes }));
  res.json({ ok: true, sessoes_encerradas: sessoes });
}

/**
 * POST /api/usuarios/:id/ativar — religa o acesso: limpa trilha de
 * desativação, bloqueio e falhas. Se a conta nunca teve senha, gera um
 * convite novo automaticamente. Exige reautenticação.
 */
export async function ativarUsuario(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdmin(actor, 'reativam usuários.');
  exigirReautenticacao(req);
  const store = getStore();
  const id = parseIdParam(req);
  const row = await store.findOneWhere(RESOURCES.usuarios, { id });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  if (row.ativo !== false) throw new HttpError(400, 'Este usuário já está ativo.');

  await store.update(RESOURCES.usuarios, id, {
    ativo: true,
    desativado_por: null,
    desativado_em: null,
    desativado_motivo: null,
    bloqueado_ate: null,
    bloqueio_manual: false,
    motivo_bloqueio: null,
    tentativas_falhas: 0,
    ultimo_falha_em: null,
  });
  await store.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'seguranca',
    recurso: 'usuarios',
    registro_id: id,
    descricao: `${String(row.nome || row.email)} REATIVADO por ${actor.name}`,
  });
  invalidateUserCache(id);

  // Conta que nunca teve senha: o acesso só existe com um convite novo.
  let convite_link: string | undefined;
  if (!row.senha_hash && !row.senha_definida_em) {
    const atual = (await store.findOneWhere(RESOURCES.usuarios, { id })) ?? row;
    convite_link = await gerarConvite(atual, actor);
  }
  notificar('usuario.ativado', dadosConta(row, actor));
  if (convite_link) notificar('usuario.convite_enviado', dadosConta(row, actor));
  res.json({ ok: true, ...(convite_link ? { convite_link } : {}) });
}

/** POST /api/usuarios/:id/desbloquear — limpa bloqueio (manual ou temporário) e falhas. */
export async function desbloquearUsuario(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdmin(actor, 'desbloqueiam usuários.');
  const store = getStore();
  const id = parseIdParam(req);
  const row = await store.findOneWhere(RESOURCES.usuarios, { id });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  if (!contaBloqueada(row) && !Number(row.tentativas_falhas || 0)) throw new HttpError(400, 'Este usuário não está bloqueado.');

  const eraManual = row.bloqueio_manual === true;
  await store.update(RESOURCES.usuarios, id, {
    bloqueado_ate: null,
    bloqueio_manual: false,
    motivo_bloqueio: null,
    tentativas_falhas: 0,
    ultimo_falha_em: null,
  });
  await store.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'bloqueio',
    recurso: 'usuarios',
    registro_id: id,
    descricao: `${String(row.nome || row.email)} DESBLOQUEADO por ${actor.name} (bloqueio ${eraManual ? 'manual removido' : 'temporário e falhas zerados'})`,
  });
  invalidateUserCache(id);
  notificar('usuario.desbloqueado', dadosConta(row, actor, { bloqueio_manual: eraManual }));
  res.json({ ok: true });
}

/**
 * POST /api/usuarios/:id/bloquear — { motivo, duracao_minutos? } trava o
 * acesso na hora (login e sessões ativas caem em até 30 s). Sem duração, o
 * bloqueio é manual e só sai com "Desbloquear". Exige reautenticação e não
 * vale para si mesmo. Para desligamento definitivo, desative a conta.
 */
export async function bloquearUsuario(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdmin(actor, 'bloqueiam usuários.');
  exigirReautenticacao(req);
  const store = getStore();
  const id = parseIdParam(req);
  const row = await store.findOneWhere(RESOURCES.usuarios, { id });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  if (Number(row.id) === Number(actor.id)) throw new HttpError(400, 'Você não pode bloquear o seu próprio acesso.');
  if (row.ativo === false) throw new HttpError(400, 'Este usuário já está desativado.');
  if (contaBloqueada(row)) throw new HttpError(400, 'Este usuário já está bloqueado.');
  const motivo = String(req.body?.motivo ?? '').trim().slice(0, 300);
  if (!motivo) throw new HttpError(400, 'Informe o motivo do bloqueio.', { motivo: 'Campo obrigatório' });
  const rawDur = req.body?.duracao_minutos;
  const duracao = rawDur === undefined || rawDur === null || rawDur === '' ? null : Number(rawDur);
  if (duracao !== null && (!Number.isInteger(duracao) || duracao < 1 || duracao > 43200)) {
    throw new HttpError(400, 'Duração inválida: informe de 1 minuto a 30 dias, ou vazio para bloqueio sem prazo.', { duracao_minutos: 'Valor inválido' });
  }

  const patch: Record<string, unknown> = { motivo_bloqueio: motivo };
  if (duracao === null) patch.bloqueio_manual = true;
  else patch.bloqueado_ate = new Date(Date.now() + duracao * 60_000).toISOString();
  await store.update(RESOURCES.usuarios, id, patch);
  const prazo = duracao === null ? 'sem prazo (até desbloqueio manual)' : `por ${duracao >= 1440 ? `${Math.round(duracao / 1440)} dia(s)` : duracao >= 60 ? `${Math.round(duracao / 60)} hora(s)` : `${duracao} minuto(s)`}`;
  await store.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'bloqueio',
    recurso: 'usuarios',
    registro_id: id,
    descricao: `${String(row.nome || row.email)} BLOQUEADO por ${actor.name} ${prazo} — motivo: ${motivo}`,
    dados: { motivo, duracao_minutos: duracao, manual: duracao === null },
  });
  invalidateUserCache(id);
  notificar('usuario.bloqueado', dadosConta(row, actor, { motivo, manual: duracao === null, duracao_minutos: duracao }));
  res.json({ ok: true, manual: duracao === null });
}

/**
 * POST /api/usuarios/:id/encerrar-sessoes — derruba TODAS as sessões do
 * usuário e invalida os tokens (efeito imediato, em até 30 s). Exige
 * reautenticação. Para a própria conta, use Configurações → Sessões.
 */
export async function encerrarSessoesUsuario(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdmin(actor, 'encerram sessões de usuários.');
  exigirReautenticacao(req);
  const store = getStore();
  const id = parseIdParam(req);
  const row = await store.findOneWhere(RESOURCES.usuarios, { id });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  if (Number(row.id) === Number(actor.id)) throw new HttpError(400, 'Para a sua própria conta, use Configurações → Sessões e dispositivos.');

  const sessoes = await revogarTodas(id);
  const versao = Number(row.token_versao || 0) + 1;
  await store.update(RESOURCES.usuarios, id, { token_versao: versao });
  await store.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'seguranca',
    recurso: 'usuarios',
    registro_id: id,
    descricao: `Todas as sessões de ${String(row.nome || row.email)} encerradas por ${actor.name} (${sessoes} sessão(ões))`,
    dados: { sessoes_encerradas: sessoes, token_versao: versao },
  });
  invalidateUserCache(id);
  res.json({ ok: true, sessoes_encerradas: sessoes });
}

/**
 * POST /api/usuarios/:id/forcar-troca-senha — marca trocar_senha: no próximo
 * acesso (e imediatamente nas telas) o usuário cai na troca obrigatória.
 */
export async function forcarTrocaSenha(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdmin(actor, 'forçam troca de senha.');
  const store = getStore();
  const id = parseIdParam(req);
  const row = await store.findOneWhere(RESOURCES.usuarios, { id });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  if (row.ativo === false) throw new HttpError(409, 'Usuário desativado: reative-o antes de forçar a troca de senha.');
  if (!row.senha_definida_em) throw new HttpError(409, 'Convite pendente: reenvie o convite em vez de forçar a troca.');
  if (row.trocar_senha === true) throw new HttpError(400, 'A troca de senha já está marcada para este usuário.');

  await store.update(RESOURCES.usuarios, id, { trocar_senha: true });
  await store.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'senha',
    recurso: 'usuarios',
    registro_id: id,
    descricao: `Troca de senha forçada para ${String(row.email)} por ${actor.name} — troca obrigatória no próximo acesso`,
  });
  invalidateUserCache(id);
  res.json({ ok: true });
}

/**
 * POST /api/usuarios/:id/sessoes/:sid/encerrar — revoga UMA sessão específica
 * (ex.: só o celular extraviado). Exige reautenticação. A sessão atual do
 * próprio admin sai por Configurações → Sessões.
 */
export async function revogarSessaoUsuario(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdmin(actor, 'revogam sessões de usuários.');
  exigirReautenticacao(req);
  const store = getStore();
  const id = parseIdParam(req);
  const row = await store.findOneWhere(RESOURCES.usuarios, { id });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  const sid = String(req.params.sid || '');
  const sessao = await store.getSessao(sid);
  if (!sessao || Number(sessao.usuario_id) !== id) throw new HttpError(404, 'Sessão não encontrada.');
  if (sid === sidAtual(req)) throw new HttpError(400, 'Esta é a sua sessão atual — use Sair ou Configurações → Sessões.');
  await revogarUma(sid);
  await store.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'seguranca',
    recurso: 'usuarios',
    registro_id: id,
    descricao: `Sessão de ${String(row.nome || row.email)} revogada por ${actor.name} (${sessao.ip || 'ip desconhecido'})`,
    dados: { sessao: sid.slice(0, 8) },
  });
  invalidateUserCache(id);
  const restantes = (await store.listSessoesAtivas(id)).length;
  res.json({ ok: true, sessoes_restantes: restantes });
}

/** POST /api/usuarios/:id/resetar-mfa — admin limpa o MFA do usuário (reautenticação exigida). */
export async function resetarMfaUsuario(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Apenas administradores resetam o MFA.');
  exigirReautenticacao(req);
  const store = getStore();
  const row = await store.findOneWhere(RESOURCES.usuarios, { id: Number(req.params.id) });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  if (!row.mfa_ativado_em && !row.mfa_secret) throw new HttpError(400, 'Este usuário não possui MFA configurado.');
  await store.update(RESOURCES.usuarios, Number(row.id), { mfa_secret: null, mfa_ativado_em: null, mfa_backup_hashes: null });
  const sessoes = await revogarTodas(Number(row.id));
  await store.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'mfa',
    recurso: 'usuarios',
    registro_id: Number(row.id),
    descricao: `MFA de ${String(row.email)} resetado por ${actor.name} (reautenticado, códigos de recuperação invalidados) — o usuário refaz o cadastro no próximo login`,
    dados: { sessoes_encerradas: sessoes },
  });
  invalidateUserCache(Number(row.id));
  notificar('usuario.mfa_resetado', dadosConta(row, actor, { sessoes_encerradas: sessoes }));
  res.json({ ok: true });
}

// ----------------------------------------------------------------------------
// Onda 4 — Política de senha configurável
// ----------------------------------------------------------------------------
/** GET /api/auth/politica-senha — regras públicas (composição) para o medidor. Sem login. */
export async function politicaSenhaPublica(_req: Request, res: Response) {
  const { regrasPublicas } = await import('./politicaSenha');
  res.json({ politica: regrasPublicas(await obterPolitica()) });
}

/** GET /api/usuarios/politica-senha — política completa (admin). */
export async function obterPoliticaSenha(req: Request, res: Response) {
  exigirAdmin(currentUser(req), 'veem a política de senha.');
  const { LIMITES_POLITICA } = await import('./politicaSenha');
  res.json({ politica: await obterPolitica(), limites: LIMITES_POLITICA });
}

/** PUT /api/usuarios/politica-senha — grava a política (admin + reautenticação). */
export async function salvarPoliticaSenha(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdmin(actor, 'alteram a política de senha.');
  exigirReautenticacao(req);
  const { salvarPolitica, validarPoliticaPatch } = await import('./politicaSenha');
  const v = validarPoliticaPatch(req.body);
  if (!v.ok) throw new HttpError(400, v.erro);
  const antes = await obterPolitica();
  const politica = await salvarPolitica(req.body, actor.name);
  const store = getStore();
  await store
    .audit({
      usuario_id: actor.id,
      usuario: actor.name,
      acao: 'seguranca',
      recurso: 'usuarios',
      registro_id: null,
      descricao: `Política de senha alterada por ${actor.name}: mínimo ${politica.tamanho_minimo}, histórico ${politica.historico_qtd}, expiração ${politica.expiracao_dias ? `${politica.expiracao_dias}d` : 'nunca'}`,
      dados: { antes, depois: politica },
    })
    .catch(() => undefined);
  const { LIMITES_POLITICA } = await import('./politicaSenha');
  res.json({ ok: true, politica, limites: LIMITES_POLITICA });
}

// ----------------------------------------------------------------------------
// Onda 4 — Certificação de acessos (revisão periódica auditada)
// ----------------------------------------------------------------------------
type LinhaCertificacao = {
  id: number;
  nome: string;
  email: string;
  perfil: string;
  ativo: boolean;
  status_conta: string;
  mfa: boolean;
  ultimo_login: string | null;
  certificado_em: string | null;
  certificado_por: string | null;
  certificado_obs: string | null;
  certificado_ha_dias: number | null;
  precisa_recertificar: boolean;
};

async function linhasCertificacao(): Promise<{ linhas: LinhaCertificacao[]; resumo: { total: number; ativos: number; certificados: number; pendentes: number } }> {
  const store = getStore();
  const agora = Date.now();
  const todos = await store.list(RESOURCES.usuarios, { page: 1, pageSize: 5000, sort: 'nome', dir: 'asc' });
  const linhas: LinhaCertificacao[] = (todos.rows || []).map((u: Record<string, any>) => {
    const certMs = u.acesso_certificado_em ? new Date(String(u.acesso_certificado_em)).getTime() : NaN;
    const haDias = Number.isFinite(certMs) ? Math.floor((agora - certMs) / 86400000) : null;
    return {
      id: Number(u.id),
      nome: String(u.nome || ''),
      email: String(u.email || ''),
      perfil: String(u.perfil || ''),
      ativo: u.ativo !== false,
      status_conta: statusConta(u).status_conta,
      mfa: !!u.mfa_ativado_em,
      ultimo_login: u.ultimo_login ? String(u.ultimo_login) : null,
      certificado_em: u.acesso_certificado_em ? String(u.acesso_certificado_em) : null,
      certificado_por: u.acesso_certificado_por ? String(u.acesso_certificado_por) : null,
      certificado_obs: u.acesso_certificado_obs ? String(u.acesso_certificado_obs) : null,
      certificado_ha_dias: haDias,
      precisa_recertificar: u.ativo !== false && !!u.senha_definida_em && precisaCertificar(u, agora),
    };
  });
  const ativos = linhas.filter((l) => l.ativo && l.status_conta !== 'convite_pendente');
  const pendentes = linhas.filter((l) => l.precisa_recertificar).length;
  return { linhas, resumo: { total: linhas.length, ativos: ativos.length, certificados: ativos.length - pendentes, pendentes } };
}

/** GET /api/usuarios/certificacao — matriz quem-tem-o-quê (admin). */
export async function certificacaoUsuarios(req: Request, res: Response) {
  exigirAdmin(currentUser(req), 'veem a certificação de acessos.');
  const { linhas, resumo } = await linhasCertificacao();
  res.json({ ...resumo, validade_dias: CERTIFICACAO_VALIDADE_DIAS, linhas });
}

/** GET /api/usuarios/certificacao/export?format=csv|xlsx — matriz em arquivo (admin). */
export async function exportarCertificacao(req: Request, res: Response) {
  exigirAdmin(currentUser(req), 'exportam a certificação de acessos.');
  const { linhas } = await linhasCertificacao();
  const PERFIL: Record<string, string> = { admin: 'Administrador', gerente: 'Gerente', operador: 'Operador' };
  const STATUS: Record<string, string> = { ativo: 'Ativo', convite_pendente: 'Convite pendente', convite_expirado: 'Convite expirado', provisoria: 'Senha provisória', bloqueado: 'Bloqueado', expirado: 'Acesso expirado', inativo: 'Desativado' };
  const colunas: ColunaExport[] = [
    { key: 'id', label: '#', tipo: 'number' },
    { key: 'nome', label: 'Nome' },
    { key: 'email', label: 'E-mail' },
    { key: 'perfil', label: 'Perfil' },
    { key: 'status', label: 'Status' },
    { key: 'mfa', label: 'MFA' },
    { key: 'ultimo_login', label: 'Último acesso', tipo: 'date' },
    { key: 'certificado_em', label: 'Certificado em', tipo: 'date' },
    { key: 'certificado_por', label: 'Certificado por' },
    { key: 'situacao', label: 'Situação da certificação' },
  ];
  const rows = linhas.map((l) => ({
    ...l,
    perfil: PERFIL[l.perfil] || l.perfil,
    status: STATUS[l.status_conta] || l.status_conta,
    mfa: l.mfa ? 'Sim' : 'Não',
    situacao: !l.ativo ? 'Conta desativada' : l.status_conta === 'convite_pendente' ? 'Aguardando aceite' : l.precisa_recertificar ? (l.certificado_em ? 'Recertificação vencida' : 'Nunca certificado') : 'Certificado',
  }));
  await enviarArquivo(res, 'certificacao-acessos', String(req.query.format || 'csv'), colunas, rows as any, 'Certificação');
}

/**
 * POST /api/usuarios/:id/certificar — { observacao? } carimba a revisão do
 * acesso (admin + reautenticação). Quatro olhos: ninguém certifica o
 * próprio acesso. Só contas ativas.
 */
export async function certificarUsuario(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdmin(actor, 'certificam acessos.');
  exigirReautenticacao(req);
  const store = getStore();
  const id = parseIdParam(req);
  const row = await store.findOneWhere(RESOURCES.usuarios, { id });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  if (Number(row.id) === Number(actor.id)) throw new HttpError(400, 'Você não pode certificar o próprio acesso — peça a outro administrador.');
  if (row.ativo === false) throw new HttpError(409, 'Certifique apenas contas ativas. Reative a conta primeiro.');
  if (!row.senha_definida_em) throw new HttpError(409, 'Conta sem acesso (convite pendente) — não há o que certificar.');
  const observacao = String(req.body?.observacao ?? '').trim().slice(0, 300);
  const agora = new Date().toISOString();
  await store.update(RESOURCES.usuarios, id, {
    acesso_certificado_em: agora,
    acesso_certificado_por: actor.name,
    acesso_certificado_obs: observacao || null,
  });
  await store.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'seguranca',
    recurso: 'usuarios',
    registro_id: id,
    descricao: `Acesso de ${String(row.nome || row.email)} CERTIFICADO por ${actor.name}${observacao ? ` — ${observacao}` : ''}`,
    dados: { observacao: observacao || null },
  });
  invalidateUserCache(id);
  notificar('usuario.acesso_certificado', dadosConta(row, actor, { observacao: observacao || null }));
  res.json({ ok: true, certificado_em: agora, certificado_por: actor.name });
}
