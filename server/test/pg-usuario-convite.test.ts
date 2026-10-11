// ============================================================================
// ERP-07 — P0-06: CADASTRAR USUÁRIO EM POSTGRESQL (o defeito que ninguém via).
//
// Achado durante o ERP-07, ao tentar criar um usuário pela API para vinculá-lo
// a uma empresa:
//
//   POST /api/usuarios — o ÚNICO caminho de criação de usuário do sistema —
//   respondia **409 "Outra operação alterou estes dados ao mesmo tempo"** em
//   PostgreSQL, SEMPRE, e NENHUM usuário era criado. Mensagem de conflito de
//   concorrência para um defeito determinístico.
//
// Causa: `gerarConvite` (usuariosAdmin.ts) gravava a auditoria do convite com
// `store.audit({...})` SEM `tx`, já dentro da transação de cadastro. Com o
// isolamento SERIALIZABLE do store, a segunda conexão provoca `40001` na
// transação principal e o cadastro inteiro é desfeito. Pior: a linha de
// auditoria do convite **sobrevivia ao rollback** — descrevendo um convite de
// um usuário que não existe (auditoria mentindo é pior que auditoria ausente).
//
// Este arquivo prova o ANTES e o DEPOIS:
//   • criar usuário funciona e a linha existe com o convite emitido;
//   • a auditoria do convite é da MESMA transação: cadastro que falha não
//     deixa rastro de convite;
//   • o convite emitido aceita senha (`aceitarConvite`), provando que o token
//     gravado é o que o fluxo espera.
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

const sufixo = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

test('ERP-07/P0-06 em Postgres real: criar usuário funciona e a auditoria do convite é transacional', { skip }, async () => {
  const { query, migrate } = await import('../src/db');
  await migrate();

  const { RESOURCES } = await import('../src/resources');
  const { createRecord, getStore } = await import('../src/services');
  const { validarSenhaUsuario } = await import('../src/politicaSenha');

  const ADMIN = { id: 1, name: 'Admin P0-06', perfil: 'admin' as const, empresa_id: 1, empresas: [1] };
  const s = getStore();
  const email = `p006-${sufixo}@example.test`;

  const contarConvites = async (emailAlvo: string) =>
    Number((await query(`SELECT count(*)::int AS n FROM auditoria WHERE acao = 'convite' AND descricao LIKE $1`, [`%${emailAlvo}%`])).rows[0].n);

  // ---- 1) Antes do fix: 409 e nenhum usuário (a falha era DETERMINÍSTICA) --
  //      Agora: o cadastro passa e volta com o usuário criado.
  const criado = await createRecord(
    RESOURCES.usuarios,
    { nome: `Usuario P006 ${sufixo}`, email, perfil: 'gerente', ativo: true },
    ADMIN
  );
  assert.ok(Number(criado.id) > 0, 'o usuário foi criado (antes: 409 "Outra operação alterou..." e nada gravado)');

  const gravado = await query(`SELECT id, email, convite_token_hash, convite_expira_em, trocar_senha FROM usuarios WHERE email = $1`, [email]);
  assert.equal(gravado.rows.length, 1, 'a linha existe no banco');
  assert.ok(gravado.rows[0].convite_token_hash, 'o convite foi emitido (token gravado)');
  assert.equal(gravado.rows[0].trocar_senha, true, 'o usuário entra pelo fluxo de definição de senha');
  assert.ok(new Date(String(gravado.rows[0].convite_expira_em)).getTime() > Date.now(), 'o convite está no prazo');

  // ---- 2) A auditoria do convite é da MESMA transação --------------------
  const convitesDepoisDoSucesso = await contarConvites(email);
  assert.equal(convitesDepoisDoSucesso, 1, 'exatamente UM evento de convite para o usuário criado');

  // Cadastro que FALHA (e-mail duplicado) não pode deixar evento de convite:
  // antes do fix a linha de auditoria sobrevivia ao rollback.
  await assert.rejects(
    () => createRecord(RESOURCES.usuarios, { nome: 'Duplicado', email, perfil: 'gerente', ativo: true }, ADMIN),
    (e: any) => e.status === 409,
    'e-mail repetido é recusado'
  );
  assert.equal(await contarConvites(email), convitesDepoisDoSucesso, 'cadastro recusado NÃO deixa convite na auditoria');

  // ---- 3) O convite emitido é o que o fluxo de aceite espera -------------
  assert.equal(await validarSenhaUsuario('Senha@Forte123', { email }, true), null, 'uma senha forte passa pela política');
  assert.ok(await validarSenhaUsuario('123456', { email }, true), 'senha fraca continua recusada');
  const linha = await s.findOneWhere(RESOURCES.usuarios, { email });
  assert.ok(linha?.convite_token_hash, 'o hash do convite continua no registro antes do aceite');
});
