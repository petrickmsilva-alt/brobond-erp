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

/**
 * O contrato de DATE é o DIA CIVIL "YYYY-MM-DD" — o pool da aplicação
 * (server/src/db.ts) sobrepõe o parser da OID 1082 justamente para isso. Esta
 * normalização defensiva mantém a asserção legível caso o valor chegue como
 * `Date` por qualquer caminho: o que se compara é o DIA, não a representação.
 */
function dia(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  return String(valor).slice(0, 10);
}

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
  assert.equal(dia(desligado.desligamento), '2026-01-31');
  assert.equal((await query('SELECT id FROM representantes WHERE id = $1', [representanteId])).rowCount, 1, 'o registro continua');
  const vendas = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM vendas WHERE representante_id = $1', [representanteId]);
  assert.equal(Number(vendas.rows[0].n), 2, 'as vendas do representante desligado continuam intactas');

  // Limpeza: os usuários de teste não ficam pendurados no banco.
  await query('DELETE FROM usuarios WHERE id = ANY($1::int[])', [[usuario1Id, usuario2Id]]).catch(() => undefined);
});

// ============================================================================
// REPRESENTANTE 2.0 (migration 0048) — PostgreSQL REAL.
//
// Prova o que só o banco pode provar:
//   • a migration ADITIVA criou as colunas (identidade PF/PJ, contato,
//     endereço estruturado, tipo de representante, território) sem remover
//     nada do cadastro anterior (incluindo `regiao` legado);
//   • os índices UNIQUE PARCIAIS por empresa (código e CNPJ por dígitos) e os
//     CHECKs de coerência existem e são aplicados pelo PostgreSQL;
//   • o TRIGGER normaliza código/documentos/CEP/UF/país e recusa território de
//     OUTRA empresa (tenant-safe mesmo por psql/carga administrativa);
//   • a trilha de auditoria guarda o ANTES → DEPOIS da alteração cadastral;
//   • a listagem anota equipe e carteira em LOTE e filtra por equipe
//     (virtual) sem N+1;
//   • o painel do representante deriva carteira/metas/indicadores das fontes
//     oficiais, recortado por empresa.
// ============================================================================
test('representante 2.0 em PostgreSQL real: colunas, índices, trigger de tenant, auditoria, projeções e painel', { skip }, async () => {
  const { query, migrate } = await import('../../src/db');
  await migrate();

  const { RESOURCES } = await import('../../src/resources');
  const { createRecord, getRecord, getStore, listRecords, updateRecord } = await import('../../src/services');
  const { painelDoRepresentante } = await import('../../src/comercial');

  const admin: { id: number; name: string; perfil: 'admin' } = { id: 1, name: 'Admin PG Repr 2.0', perfil: 'admin' };
  const empA = await createRecord(RESOURCES.empresas, { nome: `REPR20 A ${sufixo}` }, admin);
  const empB = await createRecord(RESOURCES.empresas, { nome: `REPR20 B ${sufixo}` }, admin);
  const A = Number(empA.id);
  const B = Number(empB.id);
  const atorA = { id: 0, name: 'Gerente 2.0 A', perfil: 'gerente' as const, empresa_id: A, empresas: [A] };
  const atorB = { id: 0, name: 'Gerente 2.0 B', perfil: 'gerente' as const, empresa_id: B, empresas: [B] };

  // ---- A) A migration 0048 é ADITIVA: as colunas existem ------------------
  const colunas = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'representantes'`
  );
  const nomes = new Set(colunas.rows.map((r) => r.column_name));
  for (const campo of [
    'codigo',
    'tipo_pessoa',
    'cnpj',
    'razao_social',
    'nome_fantasia',
    'registro_profissional',
    'orgao_registro',
    'tipo_representante',
    'data_nascimento',
    'celular',
    'cep',
    'logradouro',
    'numero',
    'complemento',
    'bairro',
    'cidade',
    'uf',
    'pais',
    'territorio_id',
    // o cadastro anterior CONTINUA existindo (nada foi removido)
    'nome',
    'cpf',
    'cargo',
    'regiao',
    'comissao_pct',
    'telefone',
    'whatsapp',
    'email',
    'admissao',
    'desligamento',
    'observacoes',
    'usuario_id',
  ]) {
    assert.ok(nomes.has(campo), `${campo} existe em representantes`);
  }

  // Índices UNIQUE PARCIAIS por empresa + índices de recorte.
  const indices = await query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename = 'representantes'`);
  const nomesIdx = new Set(indices.rows.map((r) => r.indexname));
  for (const idx of [
    'uq_representantes_empresa_codigo',
    'uq_representantes_cnpj_empresa',
    'representantes_empresa_tipo_idx',
    'representantes_empresa_pessoa_idx',
    'representantes_empresa_territorio_idx',
    'representantes_empresa_codigo_idx',
  ]) {
    assert.ok(nomesIdx.has(idx), `índice ${idx} criado pela 0048`);
  }

  // CHECKs + trigger de coerência/tenant.
  const constraints = await query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'representantes'::regclass`
  );
  const nomesCons = new Set(constraints.rows.map((r) => r.conname));
  for (const cons of [
    'representantes_tipo_pessoa_valido',
    'representantes_tipo_valido',
    'representantes_uf_valida',
    'representantes_cep_valido',
    'representantes_nascimento_plausivel',
  ]) {
    assert.ok(nomesCons.has(cons), `constraint ${cons} criada pela 0048`);
  }
  const triggers = await query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = 'representantes'::regclass AND NOT tgisinternal`
  );
  assert.ok(triggers.rows.some((t) => t.tgname === 'trg_representante_valida'), 'trigger de normalização/tenant existe');

  // ---- B) Código comercial gerado pelo servidor, único por empresa --------
  const r1 = await createRecord(RESOURCES.representantes, { nome: `Código gerado ${sufixo}` }, atorA);
  assert.match(String(r1.codigo), /^REP\d{5}$/, 'código REP00001 gerado no serviço');
  const r2 = await createRecord(RESOURCES.representantes, { nome: `Código explícito ${sufixo}`, codigo: ` rep-${sufixo.toLowerCase()} ` }, atorA);
  assert.equal(r2.codigo, `REP-${sufixo}`, 'código normalizado em maiúsculas');

  let dupCodigo: any = null;
  try {
    await createRecord(RESOURCES.representantes, { nome: `Duplicado ${sufixo}`, codigo: `REP-${sufixo}` }, atorA);
  } catch (e: any) {
    dupCodigo = e;
  }
  assert.equal(dupCodigo?.code, 'representante_codigo_duplicado');
  assert.equal(dupCodigo?.status, 409);

  // O índice do banco é a garantia final: INSERT direto duplicado dá 23505.
  await assert.rejects(
    () =>
      query('INSERT INTO representantes (empresa_id, nome, codigo, tipo_pessoa, tipo_representante) VALUES ($1, $2, $3, $4, $5)', [
        A,
        `Direto ${sufixo}`,
        `REP-${sufixo}`,
        'PF',
        'INTERNO',
      ]),
    (e: any) => e?.code === '23505',
    'uq_representantes_empresa_codigo impede duplicidade'
  );

  // Em OUTRA empresa o mesmo código é permitido (unicidade POR empresa).
  const emB = await createRecord(RESOURCES.representantes, { nome: `Código em B ${sufixo}`, codigo: `REP-${sufixo}` }, atorB);
  assert.ok(Number(emB.id) > 0);

  // ---- C) PF × PJ: CNPJ único por empresa (índice parcial por dígitos) ----
  const CNPJ = '11222333000181';
  const pj = await createRecord(
    RESOURCES.representantes,
    {
      nome: `PJ ${sufixo}`,
      tipo_pessoa: 'PJ',
      cnpj: '11.222.333/0001-81',
      razao_social: '  Distribuidora   Exemplo  Ltda ',
      tipo_representante: 'PARCEIRO',
    },
    atorA
  );
  const pjGravado = await query<{ cnpj: string; razao_social: string; tipo_pessoa: string }>(
    'SELECT cnpj, razao_social, tipo_pessoa FROM representantes WHERE id = $1',
    [Number(pj.id)]
  );
  assert.equal(pjGravado.rows[0].cnpj, CNPJ, 'CNPJ gravado só com dígitos');
  assert.equal(pjGravado.rows[0].razao_social, 'Distribuidora Exemplo Ltda', 'espaços normalizados');
  assert.equal(pjGravado.rows[0].tipo_pessoa, 'PJ');

  await assert.rejects(
    () =>
      query('INSERT INTO representantes (empresa_id, nome, cnpj, tipo_pessoa, tipo_representante) VALUES ($1, $2, $3, $4, $5)', [
        A,
        `CNPJ direto ${sufixo}`,
        '11222333000181',
        'PJ',
        'INTERNO',
      ]),
    (e: any) => e?.code === '23505',
    'uq_representantes_cnpj_empresa compara por dígitos'
  );
  const pjEmB = await createRecord(RESOURCES.representantes, { nome: `PJ em B ${sufixo}`, tipo_pessoa: 'PJ', cnpj: CNPJ }, atorB);
  assert.ok(Number(pjEmB.id) > 0, 'o mesmo CNPJ é permitido em outra empresa');

  // CHECK do tipo de pessoa/tipo de representante.
  await assert.rejects(
    () =>
      query('INSERT INTO representantes (empresa_id, nome, tipo_pessoa, tipo_representante) VALUES ($1, $2, $3, $4)', [
        A,
        `Tipo inválido ${sufixo}`,
        'XX',
        'INTERNO',
      ]),
    (e: any) => e?.code === '23514',
    'CHECK representantes_tipo_pessoa_valido'
  );

  // ---- D) TRIGGER: normaliza o que entra cru e recusa território alheio ---
  const territorioA = await createRecord(RESOURCES.territorios, { nome: `Território 2.0 A ${sufixo}`, codigo: `T2A${sufixo}` }, atorA);
  const territorioB = await createRecord(RESOURCES.territorios, { nome: `Território 2.0 B ${sufixo}`, codigo: `T2B${sufixo}` }, atorB);

  const cru = await query<{ cpf: string; cep: string; uf: string; pais: string; codigo: string }>(
    `INSERT INTO representantes (empresa_id, nome, codigo, cpf, cep, uf, tipo_pessoa, tipo_representante, territorio_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'pf', 'interno', $7)
     RETURNING cpf, cep, uf, pais, codigo`,
    [A, `Cru ${sufixo}`, ` cru-${sufixo} `, '390.533.447-05', '74.000-000', 'go', Number(territorioA.id)]
  );
  assert.equal(cru.rows[0].cpf, '39053344705', 'trigger normaliza CPF');
  assert.equal(cru.rows[0].cep, '74000000', 'trigger normaliza CEP');
  assert.equal(cru.rows[0].uf, 'GO', 'trigger normaliza UF');
  assert.equal(cru.rows[0].pais, 'Brasil', 'país padrão aplicado pelo banco');
  assert.equal(cru.rows[0].codigo, `CRU-${sufixo}`, 'trigger normaliza o código');
  const idCru = Number((await query<{ id: number }>('SELECT id FROM representantes WHERE codigo = $1', [`CRU-${sufixo}`])).rows[0].id);

  await assert.rejects(
    () =>
      query('UPDATE representantes SET territorio_id = $1 WHERE id = $2', [Number(territorioB.id), idCru]),
    (e: any) => e?.code === '23514' && /outra empresa/.test(String(e?.message)),
    'trigger recusa território de OUTRA empresa (tenant-safe)'
  );
  await assert.rejects(
    () => query('UPDATE representantes SET territorio_id = 999999999 WHERE id = $1', [idCru]),
    (e: any) => e?.code === '23503',
    'trigger recusa território inexistente'
  );

  // O serviço responde 404 (não revela a existência fora do tenant).
  let errado: any = null;
  try {
    await createRecord(RESOURCES.representantes, { nome: `Território cruzado ${sufixo}`, territorio_id: Number(territorioB.id) }, atorA);
  } catch (e: any) {
    errado = e;
  }
  assert.equal(errado?.status, 404);
  assert.match(String(errado?.message), /Território não encontrado/);

  // ---- E) Auditoria: ANTES → DEPOIS da alteração cadastral ----------------
  let evento: any = null;
  await updateRecord(RESOURCES.representantes, Number(r2.id), { cargo: 'Gerente regional', tipo_representante: 'GERENTE' }, atorA);
  const trilha = await query<{ dados: any; descricao: string; acao: string }>(
    `SELECT dados, descricao, acao FROM auditoria
      WHERE recurso = 'representantes' AND registro_id = $1 AND acao = 'editar'
      ORDER BY id DESC LIMIT 1`,
    [Number(r2.id)]
  );
  evento = trilha.rows[0];
  assert.ok(evento, 'existe evento de edição na trilha');
  assert.equal(evento.dados.cargo.para, 'Gerente regional', 'o valor NOVO é registrado');
  assert.equal(evento.dados.tipo_representante.de, 'REPRESENTANTE_COMERCIAL', 'o valor ANTERIOR (default do cadastro) é preservado');
  assert.equal(evento.dados.tipo_representante.para, 'GERENTE');
  assert.match(String(evento.descricao), /cargo/);

  // ---- F) Listagem: anotações em LOTE + filtros (inclusive equipe virtual) -
  const equipe = await createRecord(RESOURCES.equipes_comerciais, { nome: `Equipe 2.0 ${sufixo}`, codigo: `E2${sufixo}` }, atorA);
  await createRecord(
    RESOURCES.equipe_membros,
    { equipe_id: Number(equipe.id), representante_id: Number(r2.id), papel: 'lider', entrada: '2026-01-01' },
    atorA
  );
  const cliente = await createRecord(RESOURCES.clientes, { nome: `Cliente 2.0 ${sufixo}`, pessoa: 'pj' }, atorA);
  await createRecord(
    RESOURCES.representante_cliente,
    { representante_id: Number(r2.id), cliente_id: Number(cliente.id), inicio: '2026-01-01' },
    atorA
  );

  const linha = (await listRecords(RESOURCES.representantes, { page: 1, pageSize: 50, q: `REP-${sufixo}` }, atorA)).rows.find(
    (r) => Number(r.id) === Number(r2.id)
  );
  assert.ok(linha, 'a busca pelo CÓDIGO encontra o representante');
  assert.equal(linha!.equipe_label, `Equipe 2.0 ${sufixo}`, 'equipe vigente projetada');
  assert.equal(Number(linha!.carteira_vinculos), 1, 'carteira vigente projetada');
  assert.equal(Number(linha!.territorio_id ?? 0), 0);

  const porEquipe = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 50, filter: { equipe_id: Number(equipe.id) } }, atorA);
  assert.deepEqual(porEquipe.rows.map((r) => Number(r.id)), [Number(r2.id)], 'filtro VIRTUAL por equipe');
  assert.equal(porEquipe.total, 1);

  const porTipo = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 100, filter: { tipo_representante: 'GERENTE' } }, atorA);
  assert.ok(porTipo.rows.some((r) => Number(r.id) === Number(r2.id)), 'filtro por tipo de representante');

  const porPessoa = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 100, filter: { tipo_pessoa: 'PJ' } }, atorA);
  assert.ok(porPessoa.rows.some((r) => Number(r.id) === Number(pj.id)), 'filtro por tipo de pessoa');

  const porTerritorio = await listRecords(
    RESOURCES.representantes,
    { page: 1, pageSize: 100, filter: { territorio_id: Number(territorioA.id) } },
    atorA
  );
  assert.ok(porTerritorio.rows.some((r) => Number(r.id) === idCru), 'filtro por território');

  const porCnpj = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 50, q: CNPJ }, atorA);
  assert.ok(porCnpj.rows.some((r) => Number(r.id) === Number(pj.id)), 'busca por CNPJ (dígitos)');
  const porRazao = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 50, q: 'Distribuidora Exemplo' }, atorA);
  assert.ok(porRazao.rows.some((r) => Number(r.id) === Number(pj.id)), 'busca por razão social');

  // A empresa B não enxerga NADA da A.
  const listaB = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 100, q: `REP-${sufixo}` }, atorB);
  assert.ok(!listaB.rows.some((r) => Number(r.id) === Number(r2.id)));
  assert.ok(listaB.rows.some((r) => Number(r.id) === Number(emB.id)));

  // ---- G) Painel: tudo derivado das fontes oficiais, recortado por empresa -
  await createRecord(
    RESOURCES.metas,
    {
      nome: `Meta 2.0 ${sufixo}`,
      alvo_tipo: 'representante',
      representante_id: Number(r2.id),
      metrica: 'faturamento',
      periodo_inicio: '2026-01-01',
      periodo_fim: '2026-12-31',
      valor_meta: 10000,
      quantidade_meta: 0,
      status: 'ativa',
    },
    atorA
  );
  // Fixture de LEITURA: venda já faturada direto na store (o fluxo com itens é
  // coberto por itens.test.ts) — o painel só lê.
  await getStore().insert(RESOURCES.vendas, {
    empresa_id: A,
    cliente_id: Number(cliente.id),
    representante_id: Number(r2.id),
    data: '2026-03-10',
    status: 'faturada',
    total: 2500,
  });

  const painel: any = await painelDoRepresentante(getStore(), { empresaId: A, consolidado: false } as any, Number(r2.id));
  assert.equal(painel.representante.id, Number(r2.id));
  assert.equal(painel.representante.tipo_representante, 'GERENTE');
  assert.equal(painel.estrutura.territorio, null);
  assert.deepEqual(painel.estrutura.equipes.map((e: any) => e.equipe_id), [Number(equipe.id)]);
  assert.equal(painel.carteira.vigentes, 1);
  assert.equal(painel.carteira.clientes_ativos, 1);
  assert.equal(painel.metas.linhas[0].meta, 10000);
  assert.equal(painel.metas.linhas[0].realizado, 2500, 'realizado derivado da venda faturada');
  assert.equal(painel.indicadores.faturamento, 2500);
  assert.ok(painel.ranking.total >= 1);

  // Cross-company: 404 no painel.
  let cross: any = null;
  try {
    await painelDoRepresentante(getStore(), { empresaId: B, consolidado: false } as any, Number(r2.id));
  } catch (e: any) {
    cross = e;
  }
  assert.equal(cross?.status, 404);

  // ---- H) Desligar preserva histórico e desativa para novas atribuições ---
  const desligado = await updateRecord(RESOURCES.representantes, Number(r2.id), { desligamento: '2026-06-30' }, atorA);
  assert.equal(desligado.ativo, false);
  assert.equal((await getRecord(RESOURCES.representantes, Number(r2.id), atorA)).nome, `Código explícito ${sufixo}`);
  const vinculo = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM representante_cliente WHERE representante_id = $1', [
    Number(r2.id),
  ]);
  assert.ok(Number(vinculo.rows[0].n) >= 1, 'a carteira do desligado permanece (histórico)');
});
