import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { enviarEmail } from '../src/mail';

const keys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const;
async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>) {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key];
  }
  try { return await fn(); } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
}
async function captureLogs<T>(fn: () => Promise<T>) {
  const previous = { log: console.log, warn: console.warn, error: console.error };
  const logs: string[] = [];
  const capture = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.log = capture; console.warn = capture; console.error = capture;
  try { return { value: await fn(), output: logs.join('\n') }; }
  finally { console.log = previous.log; console.warn = previous.warn; console.error = previous.error; }
}
const message = { to: 'private-person@example.test', assunto: 'assunto-privado', html: '<a href="/redefinir/secret-token-123">secret-body-456</a>' };
function assertNoSecrets(output: string) {
  for (const sensitive of ['private-person@example.test', 'assunto-privado', 'secret-token-123', 'secret-body-456', 'smtp-password-secret']) assert.ok(!output.includes(sensitive), `log vazou ${sensitive}`);
}

test('sem SMTP: fallback não registra destinatário, corpo, URL de reset ou token', async () => {
  await withEnv({}, async () => {
    const { value, output } = await captureLogs(() => enviarEmail(message));
    assert.equal(value, 'nao_enviado'); assertNoSecrets(output);
    assert.match(output, /não enviada/i);
  });
});

test('falha do SMTP: erro remoto e credenciais não são registrados', async () => {
  const mailer = createRequire(import.meta.url)('nodemailer'); const original = mailer.createTransport;
  mailer.createTransport = () => ({ sendMail: async () => { throw new Error('smtp-password-secret private-person@example.test secret-token-123'); } });
  try {
    await withEnv({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'private-person@example.test', SMTP_PASS: 'smtp-password-secret' }, async () => {
      const { value, output } = await captureLogs(() => enviarEmail(message));
      assert.equal(value, 'nao_enviado'); assertNoSecrets(output); assert.match(output, /Falha no transporte SMTP/);
    });
  } finally { mailer.createTransport = original; }
});

test('SMTP real local: mensagem é entregue pelo nodemailer sem depender de credenciais externas', async () => {
  let data = ''; let recipient = '';
  const server = createServer((socket) => {
    let buffer = ''; let inData = false;
    socket.setTimeout(5000, () => socket.destroy());
    socket.write('220 localhost ESMTP test\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n'); if (end < 0) return;
          data = buffer.slice(0, end); buffer = buffer.slice(end + 5); inData = false; socket.write('250 Message accepted\r\n'); continue;
        }
        const end = buffer.indexOf('\r\n'); if (end < 0) return;
        const command = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (/^(EHLO|HELO)/i.test(command)) socket.write('250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 HELP\r\n');
        else if (/^AUTH PLAIN/i.test(command)) socket.write('235 Authentication successful\r\n');
        else if (/^MAIL FROM:/i.test(command)) socket.write('250 Sender OK\r\n');
        else if (/^RCPT TO:/i.test(command)) { recipient = command; socket.write('250 Recipient OK\r\n'); }
        else if (/^DATA$/i.test(command)) { inData = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (/^QUIT$/i.test(command)) socket.end('221 Bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    await withEnv({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(address.port), SMTP_USER: 'fixture', SMTP_PASS: 'fixture' }, async () => {
      const result = await enviarEmail({ to: 'recipient@example.test', assunto: 'Teste', html: '<p>Mensagem segura</p>' });
      assert.equal(result, 'enviado');
    });
    assert.match(recipient, /recipient@example\.test/); assert.match(data, /Mensagem segura/);
  } finally { server.close(); await once(server, 'close'); }
});
