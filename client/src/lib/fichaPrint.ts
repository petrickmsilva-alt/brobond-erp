// Dossiê impresso da ficha do usuário (RH/arquivo): gera um HTML
// autocontido em nova janela e dispara a impressão. Devolve false quando
// o navegador bloqueia o popup (o chamador avisa o usuário).
import { formatDateTime } from './format';

const PERFIL: Record<string, string> = { admin: 'Administrador', gerente: 'Gerente', operador: 'Operador' };
const STATUS: Record<string, string> = {
  ativo: 'Ativo',
  convite_pendente: 'Convite pendente',
  convite_expirado: 'Convite expirado',
  provisoria: 'Senha provisória',
  bloqueado: 'Bloqueado',
  expirado: 'Acesso expirado',
  inativo: 'Desativado',
};
const SENHA: Record<string, string> = { propria: 'Definida pelo usuário', provisoria: 'Provisória — troca pendente', convite_pendente: 'Aguardando convite' };
const ACAO: Record<string, string> = {
  criar: 'inclusão', editar: 'alteração', excluir: 'exclusão', login: 'login', login_falha: 'login (falha)',
  senha: 'senha', mfa: 'MFA', seguranca: 'segurança', bloqueio: 'bloqueio', convite: 'convite',
  importar: 'importação', ajuste: 'ajuste', estornar: 'estorno',
};

function esc(v: unknown): string {
  return String(v ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function linha(k: string, v: string): string {
  return `<tr><th>${k}</th><td>${v}</td></tr>`;
}

type DadosFicha = {
  usuario: Record<string, any>;
  criador: { nome: string; email: string } | null;
  sessoes: { sid: string; criada_em: string; expira_em: string; ip: string | null; user_agent: string | null }[];
  historico: Record<string, any>[];
  acessos: Record<string, any>[];
  estatisticas: { logins_30d: number; eventos_30d: number; tentativas_falhas: number; sessoes_ativas: number };
};

export function imprimirFicha(dados: DadosFicha, geradoPor: string): boolean {
  const u = dados.usuario;
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) return false;
  const agora = new Date().toLocaleString('pt-BR');
  const sessoes = (dados.sessoes || [])
    .map(
      (s) =>
        `<tr><td class="mono">${esc(String(s.sid).slice(0, 8))}</td><td>${esc(s.ip || '—')}</td><td>${esc(formatDateTime(s.criada_em))}</td><td>${esc(formatDateTime(s.expira_em))}</td><td>${esc((s.user_agent || '—').slice(0, 60))}</td></tr>`
    )
    .join('');
  const acessos = (dados.acessos || [])
    .slice(0, 10)
    .map((a) => `<tr><td>${esc(formatDateTime(a.data))}</td><td>${esc(a.descricao)}</td></tr>`)
    .join('');
  const trilha = (dados.historico || [])
    .slice(0, 25)
    .map((h) => `<tr><td>${esc(formatDateTime(h.data))}</td><td>${esc(h.usuario || 'sistema')}</td><td>${esc(ACAO[String(h.acao)] || String(h.acao))}</td><td>${esc(h.descricao)}</td></tr>`)
    .join('');

  win.document.write(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Ficha do usuário — ${esc(u.nome)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #1e293b; margin: 32px; font-size: 12px; }
  h1 { font-size: 20px; margin: 0; } h2 { font-size: 14px; margin: 22px 0 8px; border-bottom: 2px solid #1e3a5f; padding-bottom: 4px; }
  .topo { display: flex; justify-content: space-between; align-items: flex-start; }
  .meta { text-align: right; color: #64748b; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th, td { border: 1px solid #cbd5e1; padding: 5px 8px; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; width: 220px; }
  table.lista th { width: auto; }
  .mono { font-family: monospace; font-size: 11px; }
  .badge { display: inline-block; border: 1px solid #94a3b8; border-radius: 4px; padding: 1px 8px; font-size: 11px; margin-right: 6px; }
  .assinaturas { display: flex; gap: 48px; margin-top: 56px; }
  .assinaturas div { flex: 1; border-top: 1px solid #475569; padding-top: 6px; text-align: center; color: #475569; }
  .rodape { margin-top: 24px; color: #64748b; font-size: 10px; border-top: 1px solid #e2e8f0; padding-top: 8px; }
  @media print { body { margin: 0; } .noprint { display: none; } }
</style></head><body onload="window.print()">
<div class="topo"><div><h1>BROBOND ERP — Ficha do usuário</h1><p><span class="badge">${esc(PERFIL[String(u.perfil)] || u.perfil)}</span><span class="badge">${esc(STATUS[String(u.status_conta)] || '—')}</span></p></div><div class="meta">Gerado em ${esc(agora)}<br>por ${esc(geradoPor)}</div></div>
<h2>Identificação</h2>
<table>
${linha('Nome', esc(u.nome))}${linha('E-mail', esc(u.email))}${linha('Cargo', esc(u.cargo))}${linha('Departamento', esc(u.departamento))}${linha('Telefone', esc(u.telefone))}
${linha('Criado em', esc(formatDateTime(u.criado_em)))}${linha('Criado por', dados.criador ? esc(`${dados.criador.nome} (${dados.criador.email})`) : '—')}
${u.observacoes ? linha('Observações internas', esc(u.observacoes)) : ''}
</table>
<h2>Acesso e segurança</h2>
<table>
${linha('Senha', esc(SENHA[String(u.senha_status)] || '—') + (u.trocar_senha ? ' — troca obrigatória' : ''))}
${linha('MFA', u.mfa_ativado_em ? `Ativado em ${esc(formatDateTime(u.mfa_ativado_em))} (${Number(u.mfa_backup_restantes ?? 0)} código(s) de recuperação restantes)` : 'Não ativado')}
${linha('Último acesso', u.ultimo_login ? esc(`${formatDateTime(u.ultimo_login)} (IP ${u.ultimo_ip || '—'})`) : 'Nunca acessou')}
${linha('Logins / eventos (30 dias)', `${Number(dados.estatisticas?.logins_30d || 0)} / ${Number(dados.estatisticas?.eventos_30d || 0)}`)}
${linha('Tentativas falhas', String(Number(u.tentativas_falhas || 0)))}
${u.acesso_expira_em ? linha('Acesso expira em', esc(formatDateTime(u.acesso_expira_em))) : ''}
${u.desativado_em ? linha('Desativação', esc(`${formatDateTime(u.desativado_em)} por ${u.desativado_por || '—'} — ${u.desativado_motivo || '—'}`)) : ''}
</table>
<h2>Sessões ativas (${(dados.sessoes || []).length})</h2>
${(dados.sessoes || []).length ? `<table class="lista"><tr><th>Sessão</th><th>IP</th><th>Criada em</th><th>Expira em</th><th>Dispositivo</th></tr>${sessoes}</table>` : '<p>Nenhuma sessão ativa.</p>'}
<h2>Últimos acessos</h2>
${(dados.acessos || []).length ? `<table class="lista"><tr><th>Data/hora</th><th>Evento</th></tr>${acessos}</table>` : '<p>Nenhum acesso registrado.</p>'}
<h2>Trilha da conta (25 recentes)</h2>
${(dados.historico || []).length ? `<table class="lista"><tr><th>Data/hora</th><th>Por</th><th>Ação</th><th>Detalhe</th></tr>${trilha}</table>` : '<p>Nenhum evento sobre esta conta.</p>'}
<div class="assinaturas"><div>Responsável (RH/Administração)</div><div>Colaborador (ciência)</div></div>
<div class="rodape">Documento gerado pelo BROBOND ERP a partir da trilha de auditoria do sistema. Verifique a integridade em Administração → Auditoria.</div>
</body></html>`);
  win.document.close();
  win.focus();
  return true;
}
