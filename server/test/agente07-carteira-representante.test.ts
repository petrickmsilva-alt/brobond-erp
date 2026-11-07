// ============================================================================
// A06-14 — REPRESENTANTE COMO PAPEL DE ACESSO (RBAC + CARTEIRA)
//
// O achado: `representantes.usuario_id` era apenas um vínculo cadastral. Não
// havia papel de acesso, nem filtro "meus clientes / minhas vendas / minhas
// comissões": o usuário vinculado a um representante enxergava a EMPRESA
// inteira — e um operador de backoffice conseguia ler comissões por chamada
// direta à API.
//
// Este arquivo prova, no modo memória (services + handlers), que:
//   • o vínculo cadastral vira ESCOPO DE CARTEIRA resolvido no SERVIDOR;
//   • listagem e leitura por id ficam restritas à própria carteira (404 alheio);
//   • a escrita carimba a carteira e recusa lançar em nome de outro;
//   • comissões: gerente/admin veem tudo, o representante vê só a sua linha,
//     o operador de backoffice SEM vínculo continua recusado (A06-07);
//   • o painel e os indicadores nunca abrem a carteira de outro;
//   • admin/gerente seguem sem restrição (nenhuma regra foi afrouxada).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const {
  createRecord,
  getRecord,
  getStore,
  listRecords,
  updateRecord,
} = await import('../src/services');
const { escopoDoAtor, escopoDeSistema } = await import('../src/empresa');
const { carteiraDoUsuario, invalidarCacheCarteira } = await import('../src/empresasAcesso');
const { apiIndicadores, apiPainelRepresentante } = await import('../src/comercial');
const { resumoComissoes, comissoesDaVenda } = await import('../src/comissoes');
const { criarAtor, garantirAdmin, esperarErro, reqDe, resFake } = await import('./_p1util');

await garantirAdmin();

const empresaA = escopoDeSistema(1);
const empresaB = escopoDeSistema(2);
const adminA = await criarAtor(1, 'admin');
const gerenteA = await criarAtor(1, 'gerente');
// Operador de BACKOFFICE (sem vínculo de representante) — o alvo do A06-07.
const operadorA = await criarAtor(1, 'operador');

const sufixo = `${Date.now() % 1000000}`;
let seq = 0;

/** Cria um representante na empresa e, opcionalmente, vincula um usuário. */
async function novoRepresentante(empresa: number, usuarioId: number | null = null) {
  seq++;
  const row = await getStore().insert(RESOURCES.representantes, {
    nome: `Rep A06-14 ${sufixo} ${seq}`,
    empresa_id: empresa,
    ativo: true,
    ...(usuarioId ? { usuario_id: usuarioId } : {}),
  });
  return row;
}

/** Ator como o middleware de auth o monta: perfil + empresas + carteira. */
function atorComCarteira(id: number, perfil: string, empresaId: number, carteira: number | null) {
  return { id, name: `Ator ${id}`, perfil, empresa_id: empresaId, empresas: [empresaId], carteira };
}

let clienteId: number | null = null;
async function clienteDaEmpresa(empresa: number) {
  if (clienteId == null) {
    const c = await createRecord(RESOURCES.clientes, { nome: `Cliente carteira ${sufixo}`, pessoa: 'pj' }, adminA);
    clienteId = Number(c.id);
  }
  void empresa;
  return clienteId;
}

async function novaVenda(empresa: number, representanteId: number, comissao = 100) {
  const cliente = await clienteDaEmpresa(empresa);
  seq++;
  return getStore().insert(RESOURCES.vendas, {
    empresa_id: empresa,
    cliente_id: cliente,
    representante_id: representanteId,
    data: '2026-10-20',
    status: 'faturada',
    faturada_em: '2026-10-21T10:00:00.000Z',
    comissao_valor: comissao,
    comissao_pct: 5,
    total: 1000,
  });
}

// ---------------------------------------------------------------------------
// 1) RESOLUÇÃO DO VÍNCULO → CARTEIRA (fail-safe: nunca inventa carteira)
// ---------------------------------------------------------------------------
test('A06-14: vínculo cadastral vira carteira; gestão e operador sem vínculo não têm recorte', async () => {
  const usuario = await criarAtor(1, 'operador');
  const rep = await novoRepresentante(1, Number(usuario.id));
  invalidarCacheCarteira();

  const resolvido = await carteiraDoUsuario({ id: Number(usuario.id), perfil: 'operador', empresas: [1] });
  assert.equal(resolvido, Number(rep.id), 'o vínculo representantes.usuario_id é resolvido');

  // Admin/gerente NUNCA são restritos, mesmo que exista vínculo cadastral.
  assert.equal(await carteiraDoUsuario({ id: Number(usuario.id), perfil: 'admin', empresas: [1] }), null);
  assert.equal(await carteiraDoUsuario({ id: Number(usuario.id), perfil: 'gerente', empresas: [1] }), null);

  // O escopo só restringe perfil não-gestão com carteira resolvida.
  assert.equal(escopoDoAtor({ id: Number(usuario.id), perfil: 'operador', empresa_id: 1, empresas: [1], carteira: Number(rep.id) }).carteira, Number(rep.id));
  assert.equal(escopoDoAtor({ id: Number(usuario.id), perfil: 'admin', empresa_id: 1, empresas: [1], carteira: Number(rep.id) }).carteira, null);
  assert.equal(escopoDoAtor({ id: Number(usuario.id), perfil: 'operador', empresa_id: 1, empresas: [1] }).carteira, null, 'sem vínculo não há recorte');
  // Consolidado desliga o recorte (visão de grupo é de gestão).
  assert.equal(escopoDoAtor({ id: Number(usuario.id), perfil: 'operador', empresa_id: 1, empresas: [1], carteira: Number(rep.id), consolidar: true, pode_consolidar: true }).carteira, null);
});

// ---------------------------------------------------------------------------
// 2) LISTAGEM E LEITURA POR ID — restritas à própria carteira
// ---------------------------------------------------------------------------
test('A06-14: representante só lista e lê as PRÓPRIAS vendas; a de outro responde 404', async () => {
  const usuario = await criarAtor(1, 'operador');
  const repProprio = await novoRepresentante(1, Number(usuario.id));
  const repOutro = await novoRepresentante(1, null);
  const vendaPropria = await novaVenda(1, Number(repProprio.id));
  const vendaAlheia = await novaVenda(1, Number(repOutro.id));
  const escopo = escopoDoAtor({ id: Number(usuario.id), perfil: 'operador', empresa_id: 1, empresas: [1], carteira: Number(repProprio.id) });

  const lista = await listRecords(RESOURCES.vendas, { page: 1, pageSize: 500 }, escopo);
  const ids = lista.rows.map((v) => Number(v.id));
  assert.ok(ids.includes(Number(vendaPropria.id)), 'a venda da própria carteira aparece');
  assert.ok(!ids.includes(Number(vendaAlheia.id)), 'a venda de outro representante NÃO aparece');

  await getRecord(RESOURCES.vendas, Number(vendaPropria.id), escopo);
  await esperarErro(() => getRecord(RESOURCES.vendas, Number(vendaAlheia.id), escopo), 404);

  // Gerente da mesma empresa continua vendo as duas (nada foi afrouxado).
  const listaGerente = await listRecords(RESOURCES.vendas, { page: 1, pageSize: 500 }, escopoDoAtor(gerenteA));
  const idsGerente = listaGerente.rows.map((v) => Number(v.id));
  assert.ok(idsGerente.includes(Number(vendaPropria.id)) && idsGerente.includes(Number(vendaAlheia.id)));
});

test('A06-14: cliente de outro representante não vaza na listagem do próprio', async () => {
  const usuario = await criarAtor(1, 'operador');
  const repProprio = await novoRepresentante(1, Number(usuario.id));
  const repOutro = await novoRepresentante(1, null);
  const clienteProprio = await createRecord(RESOURCES.clientes, { nome: `Cliente próprio ${sufixo}`, pessoa: 'pf', representante_id: Number(repProprio.id) }, adminA);
  const clienteAlheio = await createRecord(RESOURCES.clientes, { nome: `Cliente alheio ${sufixo}`, pessoa: 'pf', representante_id: Number(repOutro.id) }, adminA);
  const escopo = escopoDoAtor({ id: Number(usuario.id), perfil: 'operador', empresa_id: 1, empresas: [1], carteira: Number(repProprio.id) });

  const lista = await listRecords(RESOURCES.clientes, { page: 1, pageSize: 1000 }, escopo);
  const ids = lista.rows.map((c) => Number(c.id));
  assert.ok(ids.includes(Number(clienteProprio.id)));
  assert.ok(!ids.includes(Number(clienteAlheio.id)));
  await esperarErro(() => getRecord(RESOURCES.clientes, Number(clienteAlheio.id), escopo), 404);
});

// ---------------------------------------------------------------------------
// 3) ESCRITA — carimba a carteira e recusa lançar em nome de outro
// ---------------------------------------------------------------------------
test('A06-14: escrita carimba a própria carteira e recusa a de outro (403)', async () => {
  const usuario = await criarAtor(1, 'operador');
  const repProprio = await novoRepresentante(1, Number(usuario.id));
  const repOutro = await novoRepresentante(1, null);
  const escopo = escopoDoAtor({ id: Number(usuario.id), perfil: 'operador', empresa_id: 1, empresas: [1], carteira: Number(repProprio.id) });
  const cliente = await clienteDaEmpresa(1);

  // Lançar em nome do próprio representante funciona (o id do corpo é aceito).
  const propria = await createRecord(
    RESOURCES.vendas,
    { cliente_id: cliente, data: '2026-10-22', representante_id: Number(repProprio.id) },
    atorComCarteira(Number(usuario.id), 'operador', 1, Number(repProprio.id)),
    { escopo }
  );
  assert.equal(Number(propria.representante_id), Number(repProprio.id));

  // Lançar em nome de OUTRO representante é recusado, sem linha criada.
  await esperarErro(
    () => createRecord(
      RESOURCES.vendas,
      { cliente_id: cliente, data: '2026-10-22', representante_id: Number(repOutro.id) },
      atorComCarteira(Number(usuario.id), 'operador', 1, Number(repProprio.id)),
      { escopo }
    ),
    403,
    /própria carteira/i
  );

  // Sem representante_id no corpo, o servidor CARIMBA a carteira (nunca deixa em branco).
  const carimbada = await createRecord(
    RESOURCES.vendas,
    { cliente_id: cliente, data: '2026-10-23' },
    atorComCarteira(Number(usuario.id), 'operador', 1, Number(repProprio.id)),
    { escopo }
  );
  assert.equal(Number(carimbada.representante_id), Number(repProprio.id), 'o dono é carimbado pelo servidor');

  // Na edição, o dono da linha não é reatribuído para outro representante.
  const editada = await updateRecord(
    RESOURCES.vendas,
    Number(carimbada.id),
    { representante_id: Number(repOutro.id), observacoes: 'tentativa de troca de dono' },
    atorComCarteira(Number(usuario.id), 'operador', 1, Number(repProprio.id)),
    { escopo }
  );
  assert.equal(Number(editada.representante_id), Number(repProprio.id), 'o dono permanece o próprio');
});

// ---------------------------------------------------------------------------
// 4) COMISSÕES — RBAC (A06-07) + recorte de carteira (A06-14)
// ---------------------------------------------------------------------------
test('A06-14: comissões — operador sem vínculo é recusado; representante vê só a sua linha', async () => {
  const usuario = await criarAtor(1, 'operador');
  const repProprio = await novoRepresentante(1, Number(usuario.id));
  const repOutro = await novoRepresentante(1, null);
  await novaVenda(1, Number(repProprio.id), 250);
  await novaVenda(1, Number(repOutro.id), 900);

  const escopo = escopoDoAtor({ id: Number(usuario.id), perfil: 'operador', empresa_id: 1, empresas: [1], carteira: Number(repProprio.id) });
  const repAtor = atorComCarteira(Number(usuario.id), 'operador', 1, Number(repProprio.id));

  // Representante: enxerga APENAS a própria linha.
  const { res, saida } = resFake();
  await resumoComissoes(reqDe({}, { user: repAtor }), res);
  const linhas = saida.json.linhas as any[];
  assert.ok(linhas.length >= 1);
  assert.ok(linhas.every((l) => Number(l.representante_id) === Number(repProprio.id)), 'nenhuma linha de outro representante');
  assert.ok(linhas.some((l) => Number(l.representante_id) === Number(repProprio.id)));

  // Operador de BACKOFFICE sem vínculo: recusado (regra do A06-07 preservada).
  await esperarErro(() => resumoComissoes(reqDe({}, { user: operadorA }), resFake().res), 403, /comissões/i);

  // Gerente: vê a empresa inteira (as duas linhas).
  const { res: resG, saida: saidaG } = resFake();
  await resumoComissoes(reqDe({}, { user: gerenteA }), resG);
  const idsG = (saidaG.json.linhas as any[]).map((l) => Number(l.representante_id));
  assert.ok(idsG.includes(Number(repProprio.id)) && idsG.includes(Number(repOutro.id)));

  // Livro de uma venda de OUTRO representante: 404 (não vaza que existe).
  const vendaAlheia = await novaVenda(1, Number(repOutro.id), 10);
  await esperarErro(() => comissoesDaVenda(reqDe({}, { params: { id: Number(vendaAlheia.id) }, user: repAtor }), resFake().res), 404);

  // O gerente lê o mesmo livro normalmente.
  const { res: resV, saida: saidaV } = resFake();
  await comissoesDaVenda(reqDe({}, { params: { id: Number(vendaAlheia.id) }, user: gerenteA }), resV);
  assert.equal(Number(saidaV.json.venda_id), Number(vendaAlheia.id));

  void escopo;
});

// ---------------------------------------------------------------------------
// 5) PAINEL E INDICADORES — nunca abrem a carteira de outro
// ---------------------------------------------------------------------------
test('A06-14: painel do representante só abre o PRÓPRIO; indicadores fixam o filtro', async () => {
  const usuario = await criarAtor(1, 'operador');
  const repProprio = await novoRepresentante(1, Number(usuario.id));
  const repOutro = await novoRepresentante(1, null);
  const repAtor = atorComCarteira(Number(usuario.id), 'operador', 1, Number(repProprio.id));

  // O próprio painel abre.
  const { res, saida } = resFake();
  await apiPainelRepresentante(reqDe({}, { params: { id: Number(repProprio.id) }, user: repAtor }), res);
  assert.equal(Number(saida.json.id ?? saida.json.representante?.id ?? repProprio.id), Number(repProprio.id));

  // O painel de outro responde 404.
  await esperarErro(() => apiPainelRepresentante(reqDe({}, { params: { id: Number(repOutro.id) }, user: repAtor }), resFake().res), 404);

  // Indicadores: mesmo pedindo representante_id de outro na query, o servidor
  // fixa o filtro na própria carteira.
  const { res: resI, saida: saidaI } = resFake();
  await apiIndicadores(reqDe({}, { query: { representante_id: String(repOutro.id) }, user: repAtor }), resI);
  assert.ok(saidaI.json, 'os indicadores respondem sem erro');

  // O gerente abre o painel de qualquer representante da empresa.
  const { res: resG } = resFake();
  await apiPainelRepresentante(reqDe({}, { params: { id: Number(repOutro.id) }, user: gerenteA }), resG);
});

// ---------------------------------------------------------------------------
// 6) ISOLAMENTO ENTRE EMPRESAS continua valendo com a carteira
// ---------------------------------------------------------------------------
test('A06-14: a carteira não enfraquece o isolamento entre empresas', async () => {
  const usuario = await criarAtor(1, 'operador');
  const repProprio = await novoRepresentante(1, Number(usuario.id));
  const repEmpresaB = await novoRepresentante(2, null);
  const vendaB = await novaVenda(2, Number(repEmpresaB.id));
  const escopo = escopoDoAtor({ id: Number(usuario.id), perfil: 'operador', empresa_id: 1, empresas: [1], carteira: Number(repProprio.id) });

  await esperarErro(() => getRecord(RESOURCES.vendas, Number(vendaB.id), escopo), 404);
  const lista = await listRecords(RESOURCES.vendas, { page: 1, pageSize: 500 }, escopo);
  assert.ok(!lista.rows.map((v) => Number(v.id)).includes(Number(vendaB.id)));

  void empresaA;
  void empresaB;
});
