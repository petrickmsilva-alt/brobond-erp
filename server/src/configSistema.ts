// ============================================================
// Endereço público do ERP — configuração self-service (admin).
//
// Resolve na própria tela o defeito que antes exigia redeploy: "convite por
// e-mail abre como URL inválida". O administrador salva o endereço público em
// Configurações › Sistema; ele é gravado na tabela `configuracoes` (chave
// `app_url`) e passa a ser a base dos links de convite, redefinição de senha,
// portal do cliente, catálogo e QR code — ver urlPublica.ts para a precedência
// (APP_URL do ambiente continua valendo e tem prioridade).
//
// Regras de segurança desta rota:
//   • só administrador (403 para os demais perfis);
//   • exige reautenticação recente (5 min) para gravar/apagar;
//   • o valor é validado: http(s), sem credenciais e, em produção, precisa ser
//     um endereço público (localhost/IP privado são recusados);
//   • tudo vai para a auditoria, com antes/depois.
//
// O endereço detectado na sessão (`sugerida`) é só sugestão exibida na tela:
// nunca é gravado automaticamente. O cabeçalho Host é controlado por quem faz
// a requisição — gravá-lo às cegas permitiria a um atacante apontar os links
// de convite/reset (que carregam o token) para o domínio dele.
// ============================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { empresaDoAtorAudit } from './empresa';
import { currentUser, exigirReautenticacao } from './auth';
import { getStore } from './services';
import { RESOURCES } from './resources';
import { CHAVE_APP_URL, gravarConfig, removerConfig } from './configuracoes';
import { carregarOrigemDoBanco, registrarOrigemDoBanco, statusOrigemAsync, validarOrigemPublica } from './urlPublica';

/** Convites ainda não aceitos (usuário sem senha definida) — avisa que precisa reenviar. */
async function contarConvitesPendentes(): Promise<number> {
  try {
    const { rows } = await getStore().list(RESOURCES.usuarios, { page: 1, pageSize: 500, sort: 'nome', dir: 'asc' });
    return rows.filter((r) => !r.senha_hash && r.ativo !== false).length;
  } catch {
    return 0;
  }
}

function exigirAdmin(actor: { perfil?: string }, verbo: string): void {
  if (actor.perfil !== 'admin') throw new HttpError(403, `Apenas administradores ${verbo}.`);
}

/** GET /api/admin/config/endereco-publico — diagnóstico do endereço dos links. */
export async function obterEnderecoPublico(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdmin(actor, 'configuram o endereço público do ERP');
  const status = await statusOrigemAsync(req);
  res.json({
    status,
    convitesPendentes: await contarConvitesPendentes(),
    /** true quando o valor do ambiente está OK e o do banco é redundante. */
    ambienteValido: Boolean(status.doAmbiente) && !status.appUrlIgnorada,
  });
}

/** PUT /api/admin/config/endereco-publico — { valor } salva o endereço público. */
export async function salvarEnderecoPublico(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdmin(actor, 'configuram o endereço público do ERP');
  exigirReautenticacao(req);
  const v = validarOrigemPublica(req.body?.valor);
  if (!v.ok) throw new HttpError(400, v.erro);

  const antes = (await carregarOrigemDoBanco()) || '(não configurado)';
  await gravarConfig(CHAVE_APP_URL, v.origem, actor.name);
  registrarOrigemDoBanco(v.origem); // já vale para esta requisição, sem esperar o cache

  await getStore()
    .audit({
      usuario_id: actor.id,
      usuario: actor.name,
      acao: 'seguranca',
      recurso: 'configuracoes',
      registro_id: null,
      descricao: `Endereço público do ERP alterado para ${v.origem} (base dos links de e-mail, portal e QR)`,
      dados: { chave: CHAVE_APP_URL, antes, depois: v.origem },
      empresa_id: empresaDoAtorAudit(actor),
    })
    .catch(() => undefined);

  res.json({
    ok: true,
    status: await statusOrigemAsync(req),
    convitesPendentes: await contarConvitesPendentes(),
  });
}

/** DELETE /api/admin/config/endereco-publico — apaga o valor salvo (volta ao APP_URL/requisição). */
export async function removerEnderecoPublico(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdmin(actor, 'configuram o endereço público do ERP');
  exigirReautenticacao(req);
  const antes = await carregarOrigemDoBanco();
  await removerConfig(CHAVE_APP_URL);
  registrarOrigemDoBanco('');
  await getStore()
    .audit({
      usuario_id: actor.id,
      usuario: actor.name,
      acao: 'seguranca',
      recurso: 'configuracoes',
      registro_id: null,
      descricao: 'Endereço público salvo removido — os links voltam a usar APP_URL e, na falta dela, a origem da requisição',
      dados: { chave: CHAVE_APP_URL, antes: antes || '(não configurado)' },
      empresa_id: empresaDoAtorAudit(actor),
    })
    .catch(() => undefined);
  res.json({ ok: true, status: await statusOrigemAsync(req) });
}
