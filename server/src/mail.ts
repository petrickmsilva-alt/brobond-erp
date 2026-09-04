// ============================================================
// Fase 6 — E-mail (esqueci minha senha).
//
// SMTP opcional (nodemailer — dependência instalada em server/package.json):
//   SMTP_HOST=smtp.gmail.com  SMTP_PORT=587  SMTP_USER=jjustino.sousa@gmail.com
//   SMTP_PASS=<senha de app>  SMTP_FROM=JJustino <jjustino.sousa@gmail.com>
// Sem SMTP configurado, o link é logado no console (dev/preview) e a tela de
// Configurações avisa. Nenhuma exceção quebra o fluxo do "esqueci minha senha".
// ============================================================
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function smtpConfigurado(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_PORT);
}

type EmailMsg = { to: string; assunto: string; html: string };

/** Envia e-mail via SMTP. Sem SMTP, registra a mensagem no console. */
export async function enviarEmail(msg: EmailMsg): Promise<'enviado' | 'console'> {
  const cfg = smtpConfigurado();
  const texto = msg.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cfg) {
    console.log(`[mail:sem-smtp] Para: ${msg.to} — ${msg.assunto}`);
    console.log(texto);
    return 'console';
  }
  try {
    let nodemailer: any = null;
    try {
      nodemailer = require('nodemailer');
    } catch {
      nodemailer = null;
    }
    if (!nodemailer) {
      console.warn('⚠️  SMTP configurado, mas o pacote nodemailer não está instalado. Rode: npm --prefix server install nodemailer');
      console.log(`[mail] Para: ${msg.to} — ${msg.assunto}\n${texto}`);
      return 'console';
    }
    const port = Number(process.env.SMTP_PORT) || 587;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: msg.to,
      subject: msg.assunto,
      html: msg.html,
      text: texto,
    });
    return 'enviado';
  } catch (e: any) {
    console.warn('⚠️  Falha ao enviar e-mail (SMTP):', e?.message || e);
    console.log(`[mail] Para: ${msg.to} — ${msg.assunto}\n${texto}`);
    return 'console';
  }
}
