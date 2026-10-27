// ============================================================================
// CADASTROS › REPRESENTANTES — PostgreSQL REAL.
//
// Prova o que só o banco pode provar para o cadastro no padrão LISTA → PÁGINA:
//   • CPF ÚNICO POR EMPRESA (índice parcial `uq_representantes_cpf_empresa` da
//     migration 0021): duplicado na mesma empresa devolve 409
//     `representante_duplicado` com erro no campo `cpf`; em outra empresa é
//     permitido; sem CPF, quantos quiser (o índice é parcial);
//   • USUÁRIO ÚNICO POR EMPRESA (`uq_representantes_usuario_empresa`): o mesmo
//     usuário do ERP não representa dois vendedores na MESMA empresa; em outra
//     empresa é permitido — 409 `representante_usuario_duplicado` com erro no
//     campo `usuario_id`;
//   • normalização: documento entra com máscara e é gravado só com dígitos;
//   • listagem paginada com busca (ILIKE — nome, CPF por dígitos, cargo,
//     região, telefone/e-mail) e filtros reais (`ativo`, `usuario_id`) na
//     MESMA query;
//   • "Utilização" = contagem real (SQL) de pedidos de venda
//     (`vendas.representante_id`), recortada pela empresa ativa;
//   • MULTIEMPRESA: cadastro, utilização e opções não vazam entre empresas;
//   • a FK `vendas.representante_id` continua NO ACTION: DELETE direto na store
//     recebe 23503 e, pela camada de serviço, 409 `dependencias_vinculadas`
//     com o diagnóstico do catálogo (nada de CASCADE, nada de DELETE forçado);
//   • desativar/desligar preserva o registro e as vendas (histórico intacto).
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';
process.env.NODE_ENV = 'test';

const sufixo = Date.now().toString(36).toUpperCase();

// CPF VÁLIDO (dígito verificador conferido — o mesmo do smoke E2E).
const CPF_VALIDO = '52998224725';

test('representantes em PostgreSQL real: CPF/usuário únicos por empresa, busca/filtros, utilização, FK e diagnóstico', { skip }, async () => {
  const { query, migrate } = await import('../../src/db');
  await migrate();

  const { RESOURCES } = await import('../../src/resources');
  const { createRecord, deleteRecord, getRecord, getStore, listRecords, updateRecord } = await import('../../src/services');

  const admin: { id: number; name: string; perfil: 'admin' } = { id: 1, name: 'Admin PG Representantes', perfil: 'admin' };

  // Duas empresas: cadastro, utilização e unicidade são SEMPRE por empresa.
  const empA = await createRecord(RESOURCES.empresas, { nome: `REPR A ${sufixo}` }, admin);
  const empB = await createRecord(RESOURCES.empresas, { nome: `REPR B ${sufixo}` }, admin);
  const A = Number(empA.id);
  const B = Number(empB.id);
  const atorA = { id: 0, name: 'Gerente A', perfil: 'gerente' as const, empresa_id: A, empresas: [A] };
  const atorB = { id: 0, name: 'Gerente B', perfil: 'gerente' as const, empresa_id: B, empresas: [B] };

  // Usuários REAIS do ERP: `representantes.usuario_id` é FK para `usuarios`, e
  // o índice de unicidade compara (empresa_id, usuario_id).
  const store = getStore();
  const usuario1 = await store.insert(RESOURCES.usuarios, {
    nome: `Usuário Repr 1 ${sufixo}`,
    email: `repr1-${sufixo.toLowerCase()}@brobond.test`,
    perfil: 'operador',
    ativo: true,
  });
  const usuario2 = await store.insert(RESOURCES.usuarios, {
    nome: `Usuário Repr 2 ${sufixo}`,
    email: `repr2-${sufixo.toLowerCase()}@brobond.test`,
    perfil: 'operador',
    ativo: true,
  });
  const usuario1Id = Number(usuario1.id);
  const usuario2Id = Number(usuario2.id);

  // ---- A) Criação: CPF com máscara é gravado só com dígitos -----------------
  const representante = await createRecord(
    RESOURCES.representantes,
    {
      nome: `Ana PG ${sufixo}`,
      cpf: '529.982.247-25',
      cargo: 'Vendedora',
      regiao: 'Centro-Oeste',
      telefone: '+55 (62) 3333-4444',
      email: `ana-${sufixo.toLowerCase()}@brobond.com.br`,
      usuario_id: usuario1Id,
      comissao_pct: 3.5,
      ativo: true,
    },
    atorA
  );
  const representanteId = Number(representante.id);
  const gravado = await query<{ cpf: string; telefone: string; empresa_id: number }>(
    'SELECT cpf, telefone, empresa_id FROM representantes WHERE id = $1',
    [representanteId]
  );
  assert.equal(gravado.rows[0].cpf, CPF_VALIDO, 'CPF normalizado para dígitos no banco');
  assert.equal(gravado.rows[0].telefone, '6233334444', 'telefone canônico sem máscara');
  assert.equal(gravado.rows[0].empresa_id, A, 'o registro é da empresa ativa do ator');

  // ---- B) CPF único POR EMPRESA (índice parcial da migration 0021) ---------
  let erroCpf: any = null;
  try {
    await createRecord(RESOURCES.representantes, { nome: `CPF duplicado ${sufixo}`, cpf: '529.982.247-25' }, atorA);
  } catch (e: any) {
    erroCpf = e;
  }
  assert.ok(erroCpf, 'CPF duplicado na mesma empresa é recusado');
  assert.equal(erroCpf.status, 409);
  assert.equal(erroCpf.code, 'representante_duplicado');
  assert.match(String(erroCpf.message), /Já existe um representante cadastrado com este CPF nesta empresa/);
  assert.equal(erroCpf.fields?.cpf, 'Já cadastrado', 'o erro aponta o campo cpf do formulário');

  // Em OUTRA empresa o mesmo CPF é permitido (multiempresa preservada).
  const mesmoCpfEmB = await createRecord(
    RESOURCES.representantes,
    { nome: `Ana PG B ${sufixo}`, cpf: CPF_VALIDO, usuario_id: usuario1Id },
    atorB
  );
  assert.ok(Number(mesmoCpfEmB.id) > 0, 'o CPF é único POR EMPRESA, não global');

  // Sem CPF, quantos quiser: o índice único é PARCIAL (cpf não vazio).
  const semCpf1 = await createRecord(RESOURCES.representantes, { nome: `Sem CPF 1 ${sufixo}` }, atorA);
  const semCpf2 = await createRecord(RESOURCES.representantes, { nome: `Sem CPF 2 ${sufixo}` }, atorA);
  assert.ok(Number(semCpf1.id) !== Number(semCpf2.id));

  // ---- C) USUÁRIO do sistema único POR EMPRESA ------------------------------
  let erroUsuario: any = null;
  try {
    await createRecord(RESOURCES.representantes, { nome: `Usuário duplicado ${sufixo}`, usuario_id: usuario1Id }, atorA);
  } catch (e: any) {
    erroUsuario = e;
  }
  assert.ok(erroUsuario, 'o mesmo usuário não representa dois vendedores na MESMA empresa');
  assert.equal(erroUsuario.status, 409);
  assert.equal(erroUsuario.code, 'representante_usuario_duplicado');
  assert.match(String(erroUsuario.message), /já está vinculado a outro representante nesta empresa/);
  assert.equal(erroUsuario.fields?.usuario_id, 'Já vinculado', 'o erro aponta o campo usuario_id');

  // O mesmo usuário em OUTRA empresa é permitido (o índice inclui empresa_id).
  const outroUsuarioEmA = await createRecord(
    RESOURCES.representantes,
    { nome: `Outro usuário ${sufixo}`, usuario_id: usuario2Id },
    atorA
  );
  assert.ok(Number(outroUsuarioEmA.id) > 0);

  // ---- D) Listagem: busca + filtros reais na MESMA query -------------------
  const porNome = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 50, q: `ana pg ${sufixo}` }, atorA);
  const linhaA = porNome.rows.find((r) => Number(r.id) === representanteId);
  assert.ok(linhaA, 'busca por nome (ILIKE, sem ligar para caixa/acento) encontra o representante');
  assert.equal(linhaA!.cargo, 'Vendedora');
  assert.equal(linhaA!.regiao, 'Centro-Oeste');

  const porCpf = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 50, q: CPF_VALIDO }, atorA);
  assert.ok(porCpf.rows.some((r) => Number(r.id) === representanteId), 'busca por dígitos do CPF encontra');

  const porCpfMascarado = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 50, q: '529.982.247-25' }, atorA);
  assert.ok(porCpfMascarado.rows.some((r) => Number(r.id) === representanteId), 'busca pelo CPF COM máscara encontra');

  const porTelefone = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 50, q: '6233334444' }, atorA);
  assert.ok(porTelefone.rows.some((r) => Number(r.id) === representanteId), 'busca por telefone encontra');

  const porEmail = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 50, q: `ana-${sufixo.toLowerCase()}@brobond.com.br` }, atorA);
  assert.ok(porEmail.rows.some((r) => Number(r.id) === representanteId), 'busca por e-mail encontra');

  const porStatus = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 100, filter: { ativo: 'true' } }, atorA);
  assert.ok(porStatus.rows.some((r) => Number(r.id) === representanteId), 'filtro de status recorta no servidor');

  const porUsuario = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 100, filter: { usuario_id: usuario1Id } }, atorA);
  assert.ok(porUsuario.rows.some((r) => Number(r.id) === representanteId), 'filtro de usuário vinculado recorta no servidor');
  const outroUsuario = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 100, filter: { usuario_id: usuario2Id } }, atorA);
  assert.ok(!outroUsuario.rows.some((r) => Number(r.id) === representanteId), 'o filtro não mistura usuários');

  // ---- E) MULTIEMPRESA: a empresa B não enxerga o representante da A -------
  const listaB = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 50, q: `ana pg ${sufixo}` }, atorB);
  assert.ok(!listaB.rows.some((r) => Number(r.id) === representanteId), 'a empresa B não enxerga o representante da A');
  assert.ok(listaB.rows.some((r) => Number(r.id) === Number(mesmoCpfEmB.id)), 'a B enxerga O SEU representante');

  // ---- F) Utilização: contagem real de vendas, por empresa -----------------
  const cliente = await createRecord(RESOURCES.clientes, { nome: `Cliente Repr ${sufixo}`, pessoa: 'pj' }, atorA);
  const clienteB = await createRecord(RESOURCES.clientes, { nome: `Cliente Repr B ${sufixo}`, pessoa: 'pj' }, atorB);
  await createRecord(RESOURCES.vendas, { cliente_id: Number(cliente.id), representante_id: representanteId, data: '2026-10-01' }, atorA);
  await createRecord(RESOURCES.vendas, { cliente_id: Number(cliente.id), representante_id: representanteId, data: '2026-10-02' }, atorA);
  await createRecord(
    RESOURCES.vendas,
    { cliente_id: Number(clienteB.id), representante_id: Number(mesmoCpfEmB.id), data: '2026-10-01' },
    atorB
  );

  const comUso = (await listRecords(RESOURCES.representantes, { page: 1, pageSize: 50, q: `ana pg ${sufixo}` }, atorA)).rows.find(
    (r) => Number(r.id) === representanteId
  );
  assert.equal(comUso!.uso_vinculado, 2, 'duas vendas reais na empresa A');
  assert.equal(comUso!.uso_vinculado_label, '2 vendas');

  const usoB = (await listRecords(RESOURCES.representantes, { page: 1, pageSize: 50, q: `ana pg b ${sufixo}` }, atorB)).rows.find(
    (r) => Number(r.id) === Number(mesmoCpfEmB.id)
  );
  assert.equal(usoB!.uso_vinculado, 1, 'a utilização da B conta só as vendas da B');

  // ---- G) FK é a proteção final: DELETE direto na store dá 23503 -----------
  await assert.rejects(
    () => getStore().remove(RESOURCES.representantes, representanteId),
    (e: any) => e?.code === '23503',
    'a FK vendas.representante_id impede o DELETE (NO ACTION)'
  );
  assert.equal((await query('SELECT id FROM representantes WHERE id = $1', [representanteId])).rowCount, 1, 'nada foi apagado');

  // ---- H) Pela camada de serviço: 409 + diagnóstico do catálogo ------------
  let erro: any = null;
  try {
    await deleteRecord(RESOURCES.representantes, representanteId, atorA);
  } catch (e: any) {
    erro = e;
  }
  assert.ok(erro, 'a exclusão de representante com vendas é recusada');
  assert.equal(erro.status, 409);
  assert.equal(erro.code, 'dependencias_vinculadas');
  const diag = erro.details?.dependencias;
  assert.equal(diag.origem, 'postgresql', 'relações lidas do catálogo do PostgreSQL');
  assert.equal(diag.bloqueado, true);
  assert.ok(diag.modulosBloqueantes.includes('Vendas'), 'o diagnóstico aponta o módulo Vendas');
  const vinculo = diag.vinculos.find((v: any) => v.tabela === 'vendas');
  assert.ok(vinculo, 'o vínculo de vendas aparece no diagnóstico');
  assert.equal(vinculo.quantidade, 2);
  assert.equal(vinculo.acao, 'NO_ACTION', 'a FK real é NO ACTION — nenhum CASCADE foi criado');
  assert.equal((await getRecord(RESOURCES.representantes, representanteId, atorA)).nome, `Ana PG ${sufixo}`);

  // ---- I) Representante sem vínculo segue o fluxo normal --------------------
  const orfao = await createRecord(RESOURCES.representantes, { nome: `Órfão ${sufixo}` }, atorA);
  await deleteRecord(RESOURCES.representantes, Number(orfao.id), atorA);
  const restou = await query('SELECT id FROM representantes WHERE id = $1', [Number(orfao.id)]);
  assert.equal(restou.rowCount, 0);

  // ---- J) Desativar/desligar preserva registro e vendas --------------------
  const desativado = await updateRecord(RESOURCES.representantes, representanteId, { ativo: false }, atorA);
  assert.equal(desativado.ativo, false);
  const desligado = await updateRecord(RESOURCES.representantes, representanteId, { desligamento: '2026-01-31' }, atorA);
  assert.equal(String(desligado.desligamento).slice(0, 10), '2026-01-31');
  assert.equal((await query('SELECT id FROM representantes WHERE id = $1', [representanteId])).rowCount, 1, 'o registro continua');
  const vendas = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM vendas WHERE representante_id = $1', [representanteId]);
  assert.equal(Number(vendas.rows[0].n), 2, 'as vendas do representante desligado continuam intactas');

  // Limpeza: os usuários de teste não ficam pendurados no banco.
  await query('DELETE FROM usuarios WHERE id = ANY($1::int[])', [[usuario1Id, usuario2Id]]).catch(() => undefined);
});
