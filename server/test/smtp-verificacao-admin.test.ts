// P1-06 — verificação SMTP explícita e teste de envio pelo administrador.
// LOCAL: nenhuma conexão externa. "Servidor inacessível" usa porta 1 de loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { verificarConexaoSmtp } = await import('../src/mail');
const { verificarSmtpHandler, enviarTesteSmtpHandler } = await import('../src/notifications');

const VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'SMTP_FROM'] as const;
function ambiente(valores: Partial<Record<(typeof VARS)[number], string>>, t: { after: (f: () => void) => void }) {
  const anterior: Record<string, string | undefined> = {};
  for (const v of VARS) anterior[v] = process.env[v];
  for (const v of VARS) delete process.env[v];
  Object.assign(process.env, valores);
  t.after(() => { for (const v of VARS) { if (anterior[v] === undefined) delete process.env[v]; else process.env[v] = anterior[v]; } });
}
function resposta() {
  return { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
}

test('sem SMTP configurado: verificação responde nao_configurado sem tentar conexão', async (t) => {
  ambiente({}, t);
  assert.deepEqual(await verificarConexaoSmtp(), { ok: false, motivo: 'nao_configurado' });
});

test('servidor inacessível: falha_conexao e a resposta não expõe host, usuário nem senha', async (t) => {
  ambiente({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_USER: 'usuario-teste', SMTP_PASS: 'senha-teste-123' }, t);
  const r = await verificarConexaoSmtp();
  assert.equal(r.ok, false);
  assert.equal((r as { motivo: string }).motivo, 'falha_conexao');
  const texto = JSON.stringify(r);
  for (const sensivel of ['127.0.0.1', 'usuario-teste', 'senha-teste-123']) assert.ok(!texto.includes(sensivel), sensivel);
});

test('handler de verificação devolve o resultado como JSON', async (t) => {
  ambiente({}, t);
  const res = resposta();
  await verificarSmtpHandler({} as any, res as any);
  assert.deepEqual(res.body, { ok: false, motivo: 'nao_configurado' });
});

test('teste de envio: sem e-mail cadastrado no usuário, recusa com 400', async () => {
  const res = resposta();
  await enviarTesteSmtpHandler({ user: { id: 1, name: 'Sem e-mail' } } as any, res as any);
  assert.equal(res.statusCode, 400);
});

test('teste de envio: vai só ao próprio administrador e devolve destino mascarado', async (t) => {
  ambiente({}, t); // sem SMTP: a mensagem não sai, mas o destino é resolvido e mascarado
  const res = resposta();
  await enviarTesteSmtpHandler({ user: { id: 1, name: 'Admin', email: 'admin.geral@exemplo.com.br' } } as any, res as any);
  assert.deepEqual(res.body, { resultado: 'nao_enviado', destino: 'ad***@exemplo.com.br' });
  assert.ok(!JSON.stringify(res.body).includes('admin.geral'));
});
