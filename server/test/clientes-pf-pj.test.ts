// ============================================================================
// CLIENTES PF/PJ — suíte do cadastro profissional.
//
// Cobre máscara/normalização/validação de CPF, CNPJ, telefone, CEP, e-mail e
// moeda; a coerência pessoa × documento; duplicidade de documento POR EMPRESA
// (multi-tenant); e os fluxos de criar/editar. Modo memória — não precisa de
// banco. Rodar: npm test (pasta server) ou npm test na raiz.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, updateRecord, getRecord, listRecords, clientePorDocumento, getStore } = await import('../src/services');
const { HttpError } = await import('../src/errors');
const {
  cpfValido,
  cnpjValido,
  telefoneNormalizado,
  formatarTelefone,
  erroTelefone,
  formatarDocumento,
} = await import('../src/documentos');

const adminA = { id: 1, name: 'Admin A', perfil: 'admin' as const, empresa_id: 1, empresas: [1] };
const adminB = { id: 2, name: 'Admin B', perfil: 'admin' as const, empresa_id: 2, empresas: [2] };

// ----------------------------------------------------------------------------
// Geradores de documento VÁLIDO e único por teste — a regra de duplicidade por
// empresa exige documentos distintos entre cadastros independentes.
// ----------------------------------------------------------------------------
function digitoMod11(digitos: number[], pesos: number[]): number {
  const resto = digitos.reduce((acc, d, i) => acc + d * pesos[i], 0) % 11;
  return resto < 2 ? 0 : 11 - resto;
}

let seqDoc = 0;
function cpfUnico(): string {
  seqDoc += 1;
  const base = String(100000000 + seqDoc * 7).slice(0, 9).split('').map(Number);
  const d1 = digitoMod11(base, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = digitoMod11([...base, d1], [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base.join('')}${d1}${d2}`;
}

function cnpjUnico(): string {
  seqDoc += 1;
  const base = `19${String(100000 + seqDoc).padStart(6, '0')}0001`.split('').map(Number);
  const d1 = digitoMod11(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = digitoMod11([...base, d1], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base.join('')}${d1}${d2}`;
}

// Valores fixos conhecidos — usados só nos testes PUROS de validação.
const CPF_VALIDO = '52998224725';
const CPF_MASCARADO = '529.982.247-25';
const CPF_DV_ERRADO = '52998224726';
const CNPJ_VALIDO = '11222333000181';
const CNPJ_MASCARADO = '11.222.333/0001-81';
const CNPJ_DV_ERRADO = '11222333000182';

async function esperarHttp(fn: () => Promise<unknown>, status: number, re?: RegExp): Promise<any> {
  try {
    await fn();
  } catch (e: any) {
    assert.ok(e instanceof HttpError, `esperava HttpError, veio ${e?.constructor?.name}: ${e?.message}`);
    assert.equal(e.status, status, `status ${e.status} ≠ ${status}: ${e.message}`);
    if (re) assert.match(String(e.message), re);
    return e;
  }
  assert.fail(`esperava erro HTTP ${status}`);
}

before(() => {
  getStore();
});

// ----------------------------------------------------------------------------
// Documentos — validação matemática (contratada pela suíte)
// ----------------------------------------------------------------------------
test('CPF: dígito verificador e sequências inválidas são recusados', () => {
  assert.equal(cpfValido(CPF_VALIDO), true);
  assert.equal(cpfValido(CPF_MASCARADO), true, 'com máscara precisa validar igual');
  assert.equal(cpfValido(CPF_DV_ERRADO), false, 'dígito verificador errado');
  assert.equal(cpfValido('00000000000'), false, 'sequência 000.000.000-00');
  assert.equal(cpfValido('11111111111'), false);
  assert.equal(cpfValido('12345678901'), false);
});

test('CNPJ: dígito verificador e sequências inválidas são recusados', () => {
  assert.equal(cnpjValido(CNPJ_VALIDO), true);
  assert.equal(cnpjValido(CNPJ_MASCARADO), true);
  assert.equal(cnpjValido(CNPJ_DV_ERRADO), false);
  assert.equal(cnpjValido('00000000000000'), false, 'sequência zerada');
  assert.equal(cnpjValido('1122233300018'), false, '13 dígitos não é CNPJ');
});

test('formatarDocumento: exibe 000.000.000-00 e 00.000.000/0000-00', () => {
  assert.equal(formatarDocumento(CPF_VALIDO), '529.982.247-25');
  assert.equal(formatarDocumento(CNPJ_VALIDO), '11.222.333/0001-81');
});

// ----------------------------------------------------------------------------
// Criação PF
// ----------------------------------------------------------------------------
test('PF: cria com CPF válido (com máscara) e grava SÓ os dígitos', async () => {
  const c = await createRecord(
    RESOURCES.clientes,
    { nome: 'Maria  da   Silva', pessoa: 'pf', cnpj_cpf: cpfUnico().replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4'), email: '  Maria@Exemplo.com.br  ' },
    adminA
  );
  assert.match(String(c.cnpj_cpf), /^\d{11}$/, 'normalizado para somente dígitos');
  assert.equal(c.nome, 'Maria da Silva', 'espaços duplicados colapsados');
  assert.equal(String(c.email), 'maria@exemplo.com.br', 'e-mail trim + minúsculas (contrato atual)');
});

test('PF: CPF sem máscara também grava normalizado', async () => {
  const cpf = cpfUnico();
  const c = await createRecord(RESOURCES.clientes, { nome: 'João Sem Máscara', pessoa: 'pf', cnpj_cpf: cpf }, adminA);
  assert.equal(c.cnpj_cpf, cpf);
});

test('PF: CPF com dígito verificador errado é recusado com "CPF inválido."', async () => {
  const e = await esperarHttp(
    () => createRecord(RESOURCES.clientes, { nome: 'CPF Errado', pessoa: 'pf', cnpj_cpf: CPF_DV_ERRADO }, adminA),
    400,
    /CPF inválido/
  );
  assert.match(String(e.fields?.cnpj_cpf), /CPF inválido/);
});

test('PF: CPF de sequência repetida é recusado', async () => {
  await esperarHttp(
    () => createRecord(RESOURCES.clientes, { nome: 'Zerinho', pessoa: 'pf', cnpj_cpf: '000.000.000-00' }, adminA),
    400,
    /CPF inválido/
  );
});

test('PF: não aceita CNPJ no lugar do CPF', async () => {
  await esperarHttp(
    () => createRecord(RESOURCES.clientes, { nome: 'Confuso', pessoa: 'pf', cnpj_cpf: cnpjUnico() }, adminA),
    400,
    /Pessoa física deve usar CPF/
  );
});

// ----------------------------------------------------------------------------
// Criação PJ
// ----------------------------------------------------------------------------
test('PJ: cria com CNPJ válido (com máscara) e grava SÓ os dígitos', async () => {
  const c = await createRecord(
    RESOURCES.clientes,
    {
      nome: 'Loja   Centro',
      pessoa: 'pj',
      cnpj_cpf: formatarDocumento(cnpjUnico()),
      razao_social: 'Loja  Centro Comércio de Roupas LTDA',
      nome_fantasia: 'Loja Centro',
    },
    adminA
  );
  assert.match(String(c.cnpj_cpf), /^\d{14}$/);
  assert.equal(c.nome, 'Loja Centro');
  assert.equal(c.razao_social, 'Loja Centro Comércio de Roupas LTDA');
});

test('PJ: CNPJ com dígito verificador errado é recusado com "CNPJ inválido."', async () => {
  await esperarHttp(
    () => createRecord(RESOURCES.clientes, { nome: 'CNPJ Errado', pessoa: 'pj', cnpj_cpf: CNPJ_DV_ERRADO }, adminA),
    400,
    /CNPJ inválido/
  );
});

test('PJ: não aceita CPF no lugar do CNPJ', async () => {
  await esperarHttp(
    () => createRecord(RESOURCES.clientes, { nome: 'Confuso 2', pessoa: 'pj', cnpj_cpf: cpfUnico() }, adminA),
    400,
    /Pessoa jurídica deve usar CNPJ/
  );
});

test('integração legada: sem informar `pessoa`, um CPF nasce como PF (critério do backfill)', async () => {
  const cpf = cpfUnico();
  const c = await createRecord(RESOURCES.clientes, { nome: 'Legado Sem Pessoa', cnpj_cpf: cpf }, adminA);
  assert.equal(c.pessoa, 'pf');
  assert.equal(c.cnpj_cpf, cpf);
});

// ----------------------------------------------------------------------------
// Troca de pessoa (edição)
// ----------------------------------------------------------------------------
test('trocar PF→PJ mantendo CPF é recusado; trocar junto com o documento funciona', async () => {
  const c = await createRecord(RESOURCES.clientes, { nome: 'Troca Tipo', pessoa: 'pf', cnpj_cpf: cpfUnico() }, adminA);
  // Só a pessoa: o CPF antigo passa a ser inconsistente.
  await esperarHttp(() => updateRecord(RESOURCES.clientes, Number(c.id), { pessoa: 'pj' }, adminA), 400, /CNPJ|Pessoa jurídica/);
  // Pessoa + documento novos juntos: tudo coerente.
  const novoCnpj = cnpjUnico();
  const ok = await updateRecord(RESOURCES.clientes, Number(c.id), { pessoa: 'pj', cnpj_cpf: novoCnpj, nome: 'Troca Tipo PJ' }, adminA);
  assert.equal(ok.pessoa, 'pj');
  assert.equal(ok.cnpj_cpf, novoCnpj);
});

test('trocar PJ→PF com CPF novo funciona', async () => {
  const c = await createRecord(RESOURCES.clientes, { nome: 'Volta PF', pessoa: 'pj' }, adminA);
  const cpf = cpfUnico();
  const ok = await updateRecord(RESOURCES.clientes, Number(c.id), { pessoa: 'pf', cnpj_cpf: cpf }, adminA);
  assert.equal(ok.pessoa, 'pf');
  assert.equal(ok.cnpj_cpf, cpf);
});

// ----------------------------------------------------------------------------
// Duplicidade de documento (por empresa — multi-tenant)
// ----------------------------------------------------------------------------
test('CPF duplicado na MESMA empresa é recusado com "Já existe um cliente cadastrado com este CPF."', async () => {
  const cpf = cpfUnico();
  await createRecord(RESOURCES.clientes, { nome: 'Primeiro Dono', pessoa: 'pf', cnpj_cpf: cpf }, adminA);
  const e = await esperarHttp(
    () => createRecord(RESOURCES.clientes, { nome: 'Segundo Dono', pessoa: 'pf', cnpj_cpf: formatarDocumento(cpf) }, adminA),
    409,
    /Já existe um cliente cadastrado com este CPF/
  );
  assert.equal(e.code, 'cliente_duplicado');
  assert.match(String(e.fields?.cnpj_cpf), /Já existe/);
});

test('CNPJ duplicado na MESMA empresa é recusado com "Já existe um cliente cadastrado com este CNPJ."', async () => {
  const cnpj = cnpjUnico();
  await createRecord(RESOURCES.clientes, { nome: 'Primeira Loja', pessoa: 'pj', cnpj_cpf: cnpj }, adminA);
  await esperarHttp(
    () => createRecord(RESOURCES.clientes, { nome: 'Segunda Loja', pessoa: 'pj', cnpj_cpf: formatarDocumento(cnpj) }, adminA),
    409,
    /Já existe um cliente cadastrado com este CNPJ/
  );
});

test('o MESMO documento em EMPRESAS diferentes não se bloqueia (multi-tenant)', async () => {
  const cnpj = cnpjUnico();
  await createRecord(RESOURCES.clientes, { nome: 'Dono Original', pessoa: 'pj', cnpj_cpf: cnpj }, adminA);
  const b = await createRecord(RESOURCES.clientes, { nome: 'Cliente da Empresa B', pessoa: 'pj', cnpj_cpf: cnpj }, adminB);
  assert.equal(Number(b.empresa_id), 2);
  assert.equal(b.cnpj_cpf, cnpj);
});

test('a duplicidade compara por DÍGITOS: valor legado com máscara também bloqueia', async () => {
  const cpf = cpfUnico();
  // Legado gravado com máscara direto no store (como linhas antigas do banco).
  await getStore().insert(RESOURCES.clientes, { empresa_id: 1, nome: 'Legado Máscara', pessoa: 'pf', cnpj_cpf: formatarDocumento(cpf) });
  await esperarHttp(
    () => createRecord(RESOURCES.clientes, { nome: 'Novo Mesmo CPF', pessoa: 'pf', cnpj_cpf: cpf }, adminA),
    409,
    /Já existe um cliente cadastrado com este CPF/
  );
});

test('editar o PRÓPRIO cliente sem trocar o documento não conflita com ele mesmo', async () => {
  const cpf = cpfUnico();
  const c = await createRecord(RESOURCES.clientes, { nome: 'Edição Segura', pessoa: 'pf', cnpj_cpf: cpf }, adminA);
  const ok = await updateRecord(RESOURCES.clientes, Number(c.id), { nome: 'Edição Segura (ok)', cnpj_cpf: cpf }, adminA);
  assert.equal(ok.nome, 'Edição Segura (ok)');
});

test('editar trocando para o documento de OUTRO cliente é recusado', async () => {
  const cnpj = cnpjUnico();
  await createRecord(RESOURCES.clientes, { nome: 'Alvo Duplicado', pessoa: 'pj', cnpj_cpf: cnpj }, adminA);
  const outro = await createRecord(RESOURCES.clientes, { nome: 'Outro Cliente', pessoa: 'pj' }, adminA);
  await esperarHttp(
    () => updateRecord(RESOURCES.clientes, Number(outro.id), { cnpj_cpf: cnpj }, adminA),
    409,
    /Já existe um cliente cadastrado com este CNPJ/
  );
});

test('clientePorDocumento localiza por dígitos (inclusive valor legado com máscara) e respeita a empresa', async () => {
  const cpf = cpfUnico();
  await getStore().insert(RESOURCES.clientes, { empresa_id: 1, nome: 'Achado Máscara', pessoa: 'pf', cnpj_cpf: formatarDocumento(cpf) });
  const achado = await clientePorDocumento(cpf, 1);
  assert.ok(achado, 'legado com máscara precisa ser encontrado pela consulta normalizada');
  assert.equal(String(achado!.cnpj_cpf).replace(/\D/g, ''), cpf);
  // Outra empresa: não aparece (e não bloqueia).
  assert.equal(await clientePorDocumento(cpf, 2), null);
});

// ----------------------------------------------------------------------------
// Telefone — celular, fixo, DDD, +55, máscara, normalização
// ----------------------------------------------------------------------------
test('telefone: celular com máscara e +55 normaliza para DDD+número', () => {
  assert.equal(telefoneNormalizado('+55 (62) 99999-9999'), '62999999999');
  assert.equal(telefoneNormalizado('(62) 99999-9999'), '62999999999');
  assert.equal(telefoneNormalizado('62 99999-9999'), '62999999999');
  assert.equal(telefoneNormalizado('62999999999'), '62999999999');
  assert.equal(telefoneNormalizado('55 62 99999 9999'), '62999999999');
});

test('telefone: fixo de 8 dígitos valida e normaliza', () => {
  assert.equal(telefoneNormalizado('+55 (62) 3333-4444'), '6233334444');
  assert.equal(telefoneNormalizado('62 3333-4444'), '6233334444');
});

test('telefone: exibição brasileira com +55', () => {
  assert.equal(formatarTelefone('62999999999'), '+55 (62) 99999-9999');
  assert.equal(formatarTelefone('6233334444'), '+55 (62) 3333-4444');
  assert.equal(formatarTelefone('+55 (62) 99999-9999'), '+55 (62) 99999-9999');
});

test('telefone: recusa letras, DDD inexistente e tamanhos errados', () => {
  assert.ok(erroTelefone('abc'), 'letras');
  assert.ok(erroTelefone('(00) 99999-9999'), 'DDD 00 não existe');
  assert.ok(erroTelefone('62 9999-999'), '9 dígitos não é nem fixo nem celular');
  assert.ok(erroTelefone('62 89999-9999'), 'celular de 9 dígitos precisa começar com 9');
  assert.ok(erroTelefone('62 9333-4444'), 'fixo de 8 dígitos não começa com 9');
  assert.equal(erroTelefone('62 3333-4444'), null, 'fixo com DDD 62 é válido');
  assert.equal(erroTelefone(''), null, 'vazio não é erro aqui (obrigatoriedade é do campo)');
});

test('telefone: cadastro grava normalizado (sem máscara)', async () => {
  const c = await createRecord(
    RESOURCES.clientes,
    {
      nome: 'Cliente Telefone',
      pessoa: 'pf',
      telefone: '+55 (62) 3333-4444',
      whatsapp: '(62) 99999-9999',
    },
    adminA
  );
  assert.equal(c.telefone, '6233334444');
  assert.equal(c.whatsapp, '62999999999');
});

test('telefone: número inválido é recusado com mensagem clara', async () => {
  await esperarHttp(
    () => createRecord(RESOURCES.clientes, { nome: 'Telefone Ruim', pessoa: 'pf', telefone: '62 abc' }, adminA),
    400,
    /Telefone inválido/
  );
});

test('telefone: internacional com + e DDI passa como dígitos com DDI', () => {
  assert.equal(telefoneNormalizado('+351 912 345 678'), '351912345678');
});

// ----------------------------------------------------------------------------
// CEP, UF, e-mail, moeda
// ----------------------------------------------------------------------------
test('CEP: 8 dígitos, com ou sem máscara; fora disso é recusado', async () => {
  const c = await createRecord(RESOURCES.clientes, { nome: 'Cliente CEP', pessoa: 'pf', cep: '74000-000', uf: 'go' }, adminA);
  assert.equal(c.cep, '74000000', 'CEP normalizado para 8 dígitos');
  assert.equal(c.uf, 'GO', 'UF sempre maiúscula');
  await esperarHttp(
    () => createRecord(RESOURCES.clientes, { nome: 'CEP Curto', pessoa: 'pf', cep: '7400-000' }, adminA),
    400,
    /CEP inválido/
  );
  await esperarHttp(
    () => createRecord(RESOURCES.clientes, { nome: 'UF Livre', pessoa: 'pf', uf: 'Goiás' }, adminA),
    400,
    /UF inválida/
  );
});

test('e-mail: sintaxe validada, bordas trimadas; inválido recusado', async () => {
  const ok = await createRecord(RESOURCES.clientes, { nome: 'Cliente E-mail', pessoa: 'pf', email: ' cliente@empresa.com.br ' }, adminA);
  assert.equal(String(ok.email), 'cliente@empresa.com.br');
  await esperarHttp(
    () => createRecord(RESOURCES.clientes, { nome: 'E-mail Ruim', pessoa: 'pf', email: 'fulano@sem-dominio' }, adminA),
    400,
    /E-mail inválido/
  );
});

test('valores monetários: "1.500,50" vira 1500.50; "25.999,90" vira 25999.9', async () => {
  const a = await createRecord(RESOURCES.clientes, { nome: 'Limite A', pessoa: 'pf', limite_credito: '1.500,50' }, adminA);
  assert.equal(Number(a.limite_credito), 1500.5);
  const b = await createRecord(RESOURCES.clientes, { nome: 'Limite B', pessoa: 'pf', limite_credito: '25.999,90' }, adminA);
  assert.equal(Number(b.limite_credito), 25999.9);
  const zero = await createRecord(RESOURCES.clientes, { nome: 'Limite Zero', pessoa: 'pf', limite_credito: '0,00' }, adminA);
  assert.equal(Number(zero.limite_credito), 0);
});

// ----------------------------------------------------------------------------
// Fluxo completo: criar → editar → visualizar (o "cancelar" é de UI)
// ----------------------------------------------------------------------------
test('fluxo: criar → editar → ler de volta preserva a normalização', async () => {
  const cnpj = cnpjUnico();
  const criado = await createRecord(
    RESOURCES.clientes,
    {
      nome: 'Fluxo Completo',
      pessoa: 'pj',
      cnpj_cpf: formatarDocumento(cnpj),
      razao_social: 'Fluxo Completo Distribuidora LTDA',
      nome_fantasia: 'Fluxo',
      telefone: '(62) 3333-4444',
      email: 'fluxo@exemplo.com.br',
      limite_credito: '1.500,00',
    },
    adminA
  );
  const id = Number(criado.id);
  const editado = await updateRecord(RESOURCES.clientes, id, { nome: 'Fluxo Editado', telefone: '62 99999-9999' }, adminA);
  assert.equal(editado.nome, 'Fluxo Editado');
  assert.equal(editado.telefone, '62999999999');
  const lido = await getRecord(RESOURCES.clientes, id, adminA);
  assert.equal(lido.cnpj_cpf, cnpj);
  assert.equal(Number(lido.limite_credito), 1500);
  const lista = await listRecords(RESOURCES.clientes, { page: 1, pageSize: 500, q: 'Fluxo Editado' }, adminA);
  assert.ok(lista.rows.some((r: any) => Number(r.id) === id));
});

test('sem documento o cadastro continua liberado (consumidor final)', async () => {
  const c = await createRecord(RESOURCES.clientes, { nome: 'Consumidor Final', pessoa: 'pf' }, adminA);
  assert.equal(c.cnpj_cpf ?? null, null);
});
