// ============================================================
// Regressão: validação de convite (e link de redefinição) no Postgres.
//
// O PgStore.findOneWhere/countWhere filtravam as chaves do `where` apenas pelas
// colunas "reais" do recurso (columnsOf), que NÃO incluem as colunas internas de
// autenticação (convite_token_hash, reset_token_hash, ...). Resultado: o filtro
// ficava vazio e o método retornava null — TODO convite e TODO link de
// redefinição de senha eram recusados em produção ("Não conseguimos validar este
// link"), embora o modo demonstração (memdb, que não filtra) funcionasse.
//
// Só roda contra Postgres real; sem DATABASE_URL o arquivo se auto-pula.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

function mockReq(body: any = {}, params: any = {}, ip = '203.0.113.42'): any {
  return { body, params, headers: {}, socket: { remoteAddress: ip } };
}
function mockRes() {
  let payload: any;
  let status = 0;
  const res: any = {
    json: (d: any) => {
      payload = d;
      if (!status) status = 200;
      return res;
    },
    status: (s: number) => {
      status = s;
      return res;
    },
    setHeader: () => res,
  };
  return { res, payload: () => payload, code: () => status };
}

test('PgStore consulta usuário pelas colunas de autenticação (convite/redefinição)', { skip }, async () => {
  const { migrate, pool } = await import('../src/db');
  await migrate();
  const { RESOURCES } = await import('../src/resources');
  const { getStore } = await import('../src/services');
  const { hashResetToken, gerarResetToken } = await import('../src/auth');
  const s = getStore();

  const email = `convite.pg.${Date.now()}-${process.pid}@teste.com.br`;
  const criado = await s.insert(RESOURCES.usuarios, { nome: 'Sócio PG', email, perfil: 'gerente', ativo: true });
  const token = gerarResetToken();
  const hash = hashResetToken(token);
  await s.update(RESOURCES.usuarios, Number(criado.id), {
    convite_token_hash: hash,
    convite_expira_em: new Date(Date.now() + 3600_000).toISOString(),
    trocar_senha: true,
  });

  try {
    // O ponto que falhava: chave fora de columnsOf() era descartada → null.
    const achado = await s.findOneWhere(RESOURCES.usuarios, { convite_token_hash: hash });
    assert.ok(achado, 'findOneWhere deve localizar pelo convite_token_hash');
    assert.equal(Number(achado.id), Number(criado.id));

    const conta = await s.countWhere(RESOURCES.usuarios, { convite_token_hash: hash });
    assert.equal(conta, 1, 'countWhere deve contar pelo convite_token_hash');
  } finally {
    await pool!.query('DELETE FROM usuarios WHERE id = $1', [Number(criado.id)]);
  }
});

test('fluxo do convite funciona de ponta a ponta no Postgres (validar + aceitar)', { skip }, async () => {
  const { migrate, pool } = await import('../src/db');
  await migrate();
  const { RESOURCES } = await import('../src/resources');
  const { getStore } = await import('../src/services');
  const { hashResetToken, gerarResetToken } = await import('../src/auth');
  const { infoConvite, aceitarConvite } = await import('../src/usuariosAdmin');
  const s = getStore();

  const email = `convite.fluxo.${Date.now()}-${process.pid}@teste.com.br`;
  const criado = await s.insert(RESOURCES.usuarios, { nome: 'Sócio Fluxo', email, perfil: 'gerente', ativo: true });
  const token = gerarResetToken();
  await s.update(RESOURCES.usuarios, Number(criado.id), {
    convite_token_hash: hashResetToken(token),
    convite_expira_em: new Date(Date.now() + 3600_000).toISOString(),
    trocar_senha: true,
  });

  try {
    // GET /api/convites/:token — antes voltava 404 e a tela mostrava "inválido".
    const r1 = mockRes();
    await infoConvite(mockReq({}, { token }), r1.res);
    assert.equal(r1.code(), 200, 'infoConvite deve validar o link');
    assert.equal(r1.payload().email, email, 'resposta traz o e-mail do convidado');
    assert.equal(r1.payload().expirado, false, 'convite dentro do prazo não está expirado');

    // POST /api/convites/aceitar — antes sempre recusava com "inválido ou já utilizado".
    const r2 = mockRes();
    await aceitarConvite(mockReq({ token, senha: 'DefinindoPropria1' }), r2.res);
    assert.equal(r2.code(), 200, 'aceitarConvite deve concluir');
    assert.equal(r2.payload().ok, true);

    const bruto = await s.findOneWhere(RESOURCES.usuarios, { id: Number(criado.id) });
    assert.equal(bruto?.convite_token_hash, null, 'token de convite é de uso único');
    assert.ok(bruto?.senha_hash, 'senha definida pelo convidado foi gravada (hash)');
  } finally {
    await pool!.query('DELETE FROM usuarios WHERE id = $1', [Number(criado.id)]);
    await pool!.query("DELETE FROM login_tentativas WHERE chave LIKE 'convite:%'").catch(() => undefined);
  }
});
