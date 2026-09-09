// ============================================================
// E-mail transacional do ERP: convite de acesso, "esqueci minha senha"
// e avisos periódicos.
//
// Regra de ouro: todo link enviado precisa ser ABSOLUTO (com protocolo e
// domínio). Um link relativo ("/convite/abc") não tem para onde ir fora do
// site — o Gmail/Outlook responde "URL inválida". Os links saem montados por
// server/src/urlPublica.ts, e enviarEmail() avisa no log se algum href relativo
// aparecer aqui dentro.
//
// SMTP opcional (nodemailer — dependência instalada em server/package.json):
//   SMTP_HOST=smtp.gmail.com  SMTP_PORT=587  SMTP_USER=jjustino.sousa@gmail.com
//   SMTP_PASS=<senha de app>  SMTP_FROM=JJustino <jjustino.sousa@gmail.com>
// Sem SMTP configurado, o link é logado no console (dev/preview) e a tela de
// Configurações avisa. Nenhuma exceção quebra o fluxo do "esqueci minha senha".
// ============================================================
import { createRequire } from 'node:module';
import { hostInterno } from './urlPublica';

const require = createRequire(import.meta.url);

export function smtpConfigurado(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_PORT);
}

type EmailMsg = { to: string; assunto: string; html: string };

/** Escapa texto vindo do banco antes de montá-lo no HTML do e-mail. */
export function escaparHtml(valor: unknown): string {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Bloco de link para os e-mails do sistema. Sempre imprime a URL também em
 * texto (copiável): se o botão falhar — cliente de e-mail que bloqueia
 * links, pré-visualização que reescreve o href, corretor ortográfico que
 * começa o endereço — quem recebe ainda consegue colar o endereço no navegador.
 */
export function blocoLinkEmail(url: string, rotulo: string): string {
  const segura = escaparHtml(url);
  return [
    `<p style="margin:24px 0 8px;">`,
    `<a href="${segura}" style="display:inline-block;background:#0f2c52;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">${escaparHtml(rotulo)}</a>`,
    `</p>`,
    `<p style="margin:0 0 20px;font-size:13px;color:#64748b;">Se o botão não abrir, copie e cole este endereço no navegador:<br/><span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:#0f2c52;">${segura}</span></p>`,
  ].join('');
}

/** Casca padrão (texto discreto, sem CSS externo) para os avisos transacionais. */
export function corpoEmail(paragrafos: string[]): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.6;font-size:15px;">${paragrafos.join('')}</div>`;
}

/**
 * Links que não abrem na mão de quem recebe o e-mail:
 *   • relativos ("/convite/abc") — o cliente de e-mail não tem de onde partir;
 *   • apontando para endereço interno (localhost, IP privado, nome sem
 *     domínio) — abrem na máquina de quem lê, não no servidor.
 * Usado só para avisar: o e-mail sai mesmo assim, mas o log diz o endereço
 * exato que foi parar na caixa de entrada (é o que o suporte precisa).
 */
export function linksQueNaoAbrem(html: string): string[] {
  const achados = new Set<string>();
  for (const m of String(html || '').matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    const url = m[1]!.trim();
    if (/^(mailto:|tel:|#|data:)/i.test(url)) continue;
    if (!/^https?:\/\//i.test(url)) {
      achados.add(url); // relativo
      continue;
    }
    try {
      if (hostInterno(new URL(url).hostname)) achados.add(url); // absoluto, mas interno
    } catch {
      achados.add(url);
    }
  }
  return [...achados];
}

/** Envia e-mail via SMTP. Sem SMTP, registra a mensagem no console. */
export async function enviarEmail(msg: EmailMsg): Promise<'enviado' | 'console'> {
  const cfg = smtpConfigurado();
  const quebrados = linksQueNaoAbrem(msg.html);
  if (quebrados.length) {
    console.warn(
      `⚠️  [mail] Link que não abre para quem recebe (${quebrados.join(', ')}) — ` +
        'defina APP_URL com o endereço público do ERP (ex.: https://erp.brobond.com.br). ' +
        'Sem isso o destinatário vê "URL inválida" ao clicar.'
    );
  }
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
