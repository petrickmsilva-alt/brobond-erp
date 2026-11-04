// R-12 (Ordem integral) — canal CORPORATIVO GLOBAL, separado do operacional.
//
// Fluxo B: comunicações institucionais do próprio ERP (ex.: aviso de manutenção). NUNCA contém dados
// operacionais, financeiros ou de clientes de uma empresa. Fluxo A (operacional, em notifications.ts e
// scheduled.ts) é sempre segregado por empresa e NÃO passa por aqui.
//
// Regras obrigatórias:
//  - finalidade explícita, de uma lista fechada (FINALIDADES_CORPORATIVAS);
//  - `dadosOperacionais` deve ser `false` (qualquer outro valor é recusado);
//  - destinatários = candidatos de NOTIFICAR_EMAILS ∩ usuários ativos com perfil `admin`.
//    A variável só FILTRA; nunca adiciona destinatário que não seja administrador vigente;
//  - sem destinatário identificado, nada é enviado.
//
// Não há chamador no fluxo atual: o canal existe para uso futuro, com finalidade e autorização próprias.
import { enviarEmail } from './mail';
import { getStore } from './services';
import { acessoVigente, normalizarEmail } from './destinatariosEmpresa';

/** Finalidades autorizadas para comunicado corporativo. Ampliar exige decisão do Diretor. */
export const FINALIDADES_CORPORATIVAS = ['comunicado_institucional'] as const;
export type FinalidadeCorporativa = (typeof FINALIDADES_CORPORATIVAS)[number];

export interface ComunicadoCorporativo {
  finalidade: string;
  assunto: string;
  html: string;
  /** Deve ser `false`. Comunicado com dados operacionais é recusado. */
  dadosOperacionais: boolean;
}

export type EnviadorCorporativo = (opts: { to: string; assunto: string; html: string }) => Promise<unknown>;

export interface ResultadoCorporativo {
  enviados: number;
  ignorados: number;
}

function validar(c: ComunicadoCorporativo): void {
  if (!(FINALIDADES_CORPORATIVAS as readonly string[]).includes(c.finalidade)) {
    throw new Error('Finalidade sem autorização própria para comunicado corporativo.');
  }
  if (c.dadosOperacionais !== false) {
    throw new Error('Comunicado corporativo não pode conter dados operacionais.');
  }
  if (!String(c.assunto ?? '').trim() || !String(c.html ?? '').trim()) {
    throw new Error('Comunicado corporativo sem assunto ou conteúdo.');
  }
}

/** Candidatos vindos da configuração (apenas filtro). */
function candidatos(): string[] {
  return (process.env.NOTIFICAR_EMAILS || '')
    .split(',')
    .map(normalizarEmail)
    .filter(Boolean);
}

export async function enviarComunicadoCorporativo(
  comunicado: ComunicadoCorporativo,
  enviador: EnviadorCorporativo = enviarEmail,
): Promise<ResultadoCorporativo> {
  validar(comunicado);
  const s = getStore();
  const emails = [...new Set(candidatos())];
  let enviados = 0;
  let ignorados = 0;
  for (const email of emails) {
    const usuario = await s.findUserByEmail(email);
    // Autorização própria: administrador vigente. Qualquer outro perfil é ignorado.
    if (!usuario || !acessoVigente(usuario) || String(usuario.perfil) !== 'admin') {
      ignorados++;
      continue;
    }
    await enviador({ to: email, assunto: comunicado.assunto, html: comunicado.html }).then(
      () => { enviados++; },
      () => { ignorados++; },
    );
  }
  return { enviados, ignorados };
}
