import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
if (!process.env.DATABASE_URL) throw new Error('Closure procurement exige PostgreSQL real');
process.env.NODE_ENV = 'test';
const { migrate, pool } = await import('../../src/db'); await migrate(); const q = pool!;
const cc = await import('../../src/cotacoesCompra'); const compras = await import('../../src/compras'); const financeiro = await import('../../src/financeiro');
const { reqDe, resFake } = await import('../_p1util');
async function fixture() {
  const ref = `closure-quote-${randomUUID().slice(0, 12)}`;
  const company = Number((await q.query('INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id', [ref])).rows[0].id);
  const user = Number((await q.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES($1,$2,'admin',true,$3) RETURNING id", [ref, `${ref}@example.invalid`, company])).rows[0].id);
  const account = Number((await q.query("INSERT INTO contas_financeiras(empresa_id,nome,tipo) VALUES($1,$2,'banco') RETURNING id", [company, ref])).rows[0].id);
  await q.query("INSERT INTO locais(empresa_id,nome,tipo,padrao,ativo) VALUES($1,'loja','loja',true,true)", [company]);
  const supplier = Number((await q.query("INSERT INTO fornecedores(empresa_id,nome,ativo) VALUES($1,'Fornecedor',true) RETURNING id", [company])).rows[0].id);
  const supply = Number((await q.query("INSERT INTO insumos(empresa_id,nome,unidade,custo_medio,ativo) VALUES($1,'Insumo','un',0,true) RETURNING id", [company])).rows[0].id);
  const quote = Number((await q.query("INSERT INTO cotacoes_compra(empresa_id,titulo,status,criterio) VALUES($1,$2,'rascunho','menor_preco_total') RETURNING id", [company, ref])).rows[0].id);
  return { company, account, supplier, supply, quote, actor: { id: user, name: ref, perfil: 'admin' as const, empresa_id: company, empresas: [company] } };
}
async function call(fn: (req: any, res: any) => Promise<any>, f: Awaited<ReturnType<typeof fixture>>, body: object, id: number = f.quote, actor = f.actor) {
  const { res, saida } = resFake(); await fn(reqDe(body, { params: { id }, user: actor }), res); return { status: saida.status, body: saida.json as any };
}

test('PG compras: cotação → pedido → aprovação → estoque/custo → AP → baixa, com frete e replay', async () => {
  const f = await fixture();
  const item = await call(cc.criarItemCotacao, f, { insumo_id: f.supply, quantidade: 2 });
  assert.equal(item.status, 201);
  await call(cc.convidarFornecedores, f, { fornecedor_ids: [f.supplier] });
  const invite = (await q.query('SELECT id FROM cotacao_compra_fornecedores WHERE empresa_id=$1 AND cotacao_id=$2', [f.company, f.quote])).rows[0];
  await call(cc.cotarFornecedor, f, { convite_id: invite.id, frete: 7, precos: [{ item_id: item.body.id, preco_unitario: 4 }] });
  const decision = await call(cc.decidirCotacaoCompra, f, { criterio: 'menor_preco_total' });
  assert.equal(decision.status, 201); assert.equal(decision.body.total, 15);
  const replay = await call(cc.decidirCotacaoCompra, f, { criterio: 'menor_preco_total' });
  assert.equal(replay.status, 200); assert.equal(replay.body.compra_id, decision.body.compra_id);
  const purchase = Number(decision.body.compra_id);
  const dbPurchase = (await q.query('SELECT fornecedor_id,total,frete,status FROM compras WHERE id=$1', [purchase])).rows[0];
  assert.equal(Number(dbPurchase.total), 15); assert.equal(Number(dbPurchase.frete), 7); assert.equal(Number(dbPurchase.fornecedor_id), f.supplier);
  await call(compras.aprovarCompra, f, {}, purchase);
  const purchaseItem = (await q.query('SELECT id FROM itens_compra WHERE empresa_id=$1 AND compra_id=$2', [f.company, purchase])).rows[0];
  const receive = await call(compras.receberParcial, f, { itens: [{ item_compra_id: purchaseItem.id, quantidade: 2 }], idempotency_key: 'closure-quotation-receipt' }, purchase);
  assert.equal(receive.status, 201); assert.equal(receive.body.status, 'recebido');
  const receivedAgain = await call(compras.receberParcial, f, { itens: [{ item_compra_id: purchaseItem.id, quantidade: 2 }], idempotency_key: 'closure-quotation-receipt' }, purchase);
  assert.equal(receivedAgain.body.idempotente, true);
  const stock = (await q.query('SELECT COALESCE(SUM(quantidade),0) AS n FROM estoque_insumos WHERE empresa_id=$1 AND insumo_id=$2', [f.company, f.supply])).rows[0];
  assert.equal(Number(stock.n), 2);
  const supply = (await q.query('SELECT custo_medio FROM insumos WHERE id=$1', [f.supply])).rows[0]; assert.equal(Number(supply.custo_medio), 7.5);
  const payables = await q.query("SELECT id,valor,status FROM lancamentos_financeiros WHERE empresa_id=$1 AND referencia_tipo='compra' AND referencia_id=$2", [f.company, purchase]);
  assert.equal(payables.rows.length, 1); assert.equal(Number(payables.rows[0].valor), 15); assert.equal(payables.rows[0].status, 'pendente');
  await call(financeiro.baixarLancamento, f, { conta_id: f.account }, Number(payables.rows[0].id));
  assert.equal((await q.query('SELECT status FROM lancamentos_financeiros WHERE id=$1', [payables.rows[0].id])).rows[0].status, 'confirmado');
  assert.equal((await q.query('SELECT fin_status FROM compras WHERE id=$1', [purchase])).rows[0].fin_status, 'pago');
  const outsider = await fixture();
  await assert.rejects(() => call(cc.comparativoCotacao, f, {}, f.quote, outsider.actor), (e: any) => e.status === 404);
});

test('PG cotação: item da página posterior sem preço bloqueia decisão e pedido parcial', async () => {
  const f = await fixture();
  await q.query("UPDATE cotacoes_compra SET status='cotando' WHERE id=$1", [f.quote]);
  await q.query("INSERT INTO cotacao_compra_itens(empresa_id,cotacao_id,insumo_id,quantidade,unidade) SELECT $1,$2,$3,1,'un' FROM generate_series(1,501)", [f.company, f.quote, f.supply]);
  const invite = (await q.query("INSERT INTO cotacao_compra_fornecedores(empresa_id,cotacao_id,fornecedor_id,status,frete) VALUES($1,$2,$3,'cotado',0) RETURNING id", [f.company, f.quote, f.supplier])).rows[0];
  await q.query('INSERT INTO cotacao_compra_precos(empresa_id,convite_id,item_id,preco_unitario) SELECT $1,$2,id,5 FROM cotacao_compra_itens WHERE empresa_id=$1 AND cotacao_id=$3 ORDER BY id LIMIT 500', [f.company, invite.id, f.quote]);
  const comp = await call(cc.comparativoCotacao, f, {}); assert.equal(comp.body.resumo.itens, 501); assert.equal(comp.body.resumo.itens_sem_cotacao, 1);
  await assert.rejects(() => call(cc.decidirCotacaoCompra, f, { criterio: 'menor_preco_total' }), (e: any) => e.status === 409);
  const row = (await q.query('SELECT status,compra_id FROM cotacoes_compra WHERE id=$1', [f.quote])).rows[0];
  assert.equal(row.status, 'cotando'); assert.equal(row.compra_id, null);
  assert.equal(Number((await q.query('SELECT count(*) FROM compras WHERE empresa_id=$1', [f.company])).rows[0].count), 0);
});

test('PG cotação: decisões simultâneas geram uma compra; replay alterado e legado sem assinatura são recusados', async () => {
  const f = await fixture(); const item = await call(cc.criarItemCotacao, f, { insumo_id: f.supply, quantidade: 1 });
  await call(cc.convidarFornecedores, f, { fornecedor_ids: [f.supplier] });
  const invite = (await q.query('SELECT id FROM cotacao_compra_fornecedores WHERE empresa_id=$1 AND cotacao_id=$2', [f.company, f.quote])).rows[0];
  await call(cc.cotarFornecedor, f, { convite_id: invite.id, frete: 1, precos: [{ item_id: item.body.id, preco_unitario: 9 }] });
  const body = { criterio: 'menor_preco_total', observacoes: 'Decisão conferida' };
  const results = await Promise.allSettled([call(cc.decidirCotacaoCompra, f, body), call(cc.decidirCotacaoCompra, f, body)]);
  const successes = results.filter((r) => r.status === 'fulfilled'); assert.ok(successes.length >= 1);
  for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.status, 409);
  const decisions = await q.query('SELECT compra_id,decisao_hash FROM cotacoes_compra WHERE id=$1', [f.quote]);
  const pid = Number(decisions.rows[0].compra_id); assert.match(decisions.rows[0].decisao_hash, /^[a-f0-9]{64}$/);
  assert.equal(Number((await q.query('SELECT count(*) FROM compras WHERE empresa_id=$1', [f.company])).rows[0].count), 1);
  const replay = await call(cc.decidirCotacaoCompra, f, body); assert.equal(replay.body.idempotente, true); assert.equal(replay.body.compra_id, pid);
  await assert.rejects(() => call(cc.decidirCotacaoCompra, f, { ...body, observacoes: 'Outro conteúdo' }), (e: any) => e.status === 409);
  await q.query('UPDATE cotacoes_compra SET decisao_hash=NULL WHERE id=$1', [f.quote]);
  await assert.rejects(() => call(cc.decidirCotacaoCompra, f, body), (e: any) => e.status === 409 && /histórica/.test(e.message));
  await assert.rejects(() => q.query("UPDATE cotacoes_compra SET decisao_hash='errado' WHERE id=$1", [f.quote]), (e: any) => e.code === '23514');
});

test('PG compras: alçada por vínculo, bloqueio de bypass e recebimento aprovado', async () => {
  const f = await fixture(); const other = await fixture(); const { configurarAlcadaCompra } = await import('../../src/empresasApi');
  const { createRecord, updateRecord } = await import('../../src/services'); const { RESOURCES } = await import('../../src/resources');
  const { createItem } = await import('../../src/itens');
  const managerId = Number((await q.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES('Gerente PG',$1,'gerente',true,$2) RETURNING id", [`manager-${randomUUID()}@example.invalid`, f.company])).rows[0].id);
  await q.query('INSERT INTO usuario_empresas(usuario_id,empresa_id,limite_aprovacao_compra) VALUES($1,$2,10),($1,$3,1000)', [managerId, f.company, other.company]);
  const manager = { id: managerId, name: 'Gerente PG', perfil: 'gerente' as const, empresa_id: f.company, empresas: [f.company, other.company] };
  const purchase = Number((await q.query("INSERT INTO compras(empresa_id,fornecedor_id,data,status,total) VALUES($1,$2,'2030-01-01','pendente',1) RETURNING id", [f.company, f.supplier])).rows[0].id);
  const item = Number((await q.query('INSERT INTO itens_compra(empresa_id,compra_id,insumo_id,quantidade,preco_unitario) VALUES($1,$2,$3,2,15) RETURNING id', [f.company, purchase, f.supply])).rows[0].id);
  const receiveBody = { itens: [{ item_compra_id: item, quantidade: 1 }], idempotency_key: 'approval-guard-pg' };
  await assert.rejects(() => call(compras.receberParcial, f, receiveBody, purchase), (e: any) => e.status === 409);
  await assert.rejects(() => call(compras.aprovarCompra, f, { limite_alcada: 999999 }, purchase, manager), (e: any) => e.status === 400);
  await assert.rejects(() => call(compras.aprovarCompra, f, {}, purchase, manager), (e: any) => e.status === 403 && /alçada/.test(e.message));
  await assert.rejects(() => createRecord(RESOURCES.compras, { fornecedor_id: f.supplier, data: '2030-01-01', status: 'aprovado' }, f.actor), (e: any) => e.status === 409);
  await assert.rejects(() => updateRecord(RESOURCES.compras, purchase, { status: 'recebido' }, f.actor), (e: any) => e.status === 409);
  await assert.rejects(() => call(compras.aprovarCompra, f, {}, purchase, other.actor), (e: any) => e.status === 404);
  const params = { id: managerId, empresaId: f.company };
  await assert.rejects(() => configurarAlcadaCompra(reqDe({ limite_aprovacao_compra: 100 }, { params, user: manager }), resFake().res), (e: any) => e.status === 403);
  await assert.rejects(() => configurarAlcadaCompra(reqDe({ limite_aprovacao_compra: 100 }, { params, user: other.actor }), resFake().res), (e: any) => e.status === 403);
  await configurarAlcadaCompra(reqDe({ limite_aprovacao_compra: 30 }, { params, user: f.actor }), resFake().res);
  const approved = await call(compras.aprovarCompra, f, {}, purchase, manager); assert.equal(approved.body.status, 'aprovado');
  assert.equal(Number(approved.body.total), 30, 'total foi recalculado a partir de todas as linhas');
  await assert.rejects(() => updateRecord(RESOURCES.compras, purchase, { frete: 999 }, f.actor), (e: any) => e.status === 409);
  await assert.rejects(() => call(createItem, f, { insumo_id: f.supply, quantidade: 1, preco_unitario: 1 }, purchase), (e: any) => e.status === 409);
  const first = await call(compras.receberParcial, f, receiveBody, purchase); assert.equal(first.body.status, 'parcial');
  const second = await call(compras.receberParcial, f, { ...receiveBody, idempotency_key: 'approval-guard-pg-2' }, purchase); assert.equal(second.body.status, 'recebido');
  const audit = await q.query("SELECT dados FROM auditoria WHERE empresa_id=$1 AND recurso='compras' AND registro_id=$2 AND descricao LIKE '%aprovado%'", [f.company, purchase]);
  assert.equal(audit.rows.length, 1); assert.equal(Number(audit.rows[0].dados.total), 30); assert.equal(Number(audit.rows[0].dados.limite_aprovacao), 30);
});

test('PG compras: corrida entre inclusão de item e aprovação preserva o valor aprovado', { timeout: 60000 }, async () => {
  const { createItem } = await import('../../src/itens');
  for (let attempt = 0; attempt < 5; attempt++) {
    const f = await fixture();
    const purchase = Number((await q.query("INSERT INTO compras(empresa_id,fornecedor_id,data,status,total) VALUES($1,$2,'2030-01-01','pendente',10) RETURNING id", [f.company, f.supplier])).rows[0].id);
    await q.query('INSERT INTO itens_compra(empresa_id,compra_id,insumo_id,quantidade,preco_unitario) VALUES($1,$2,$3,1,10)', [f.company, purchase, f.supply]);
    const outcomes = await Promise.allSettled([
      call(compras.aprovarCompra, f, {}, purchase),
      call(createItem, f, { insumo_id: f.supply, quantidade: 1, preco_unitario: 7 }, purchase),
    ]);
    for (const result of outcomes) if (result.status === 'rejected') assert.ok(result.reason?.status === 409 || result.reason?.code === '40001', `Falha inesperada: ${result.reason}`);
    let p = (await q.query('SELECT status,total FROM compras WHERE id=$1', [purchase])).rows[0];
    if (p.status === 'pendente') { await call(compras.aprovarCompra, f, {}, purchase); p = (await q.query('SELECT status,total FROM compras WHERE id=$1', [purchase])).rows[0]; }
    const sum = (await q.query('SELECT sum(quantidade*preco_unitario) AS total FROM itens_compra WHERE empresa_id=$1 AND compra_id=$2', [f.company, purchase])).rows[0];
    assert.equal(p.status, 'aprovado'); assert.equal(Number(p.total), Number(sum.total));
    const audit = await q.query("SELECT dados FROM auditoria WHERE empresa_id=$1 AND recurso='compras' AND registro_id=$2 AND descricao LIKE '%aprovado%'", [f.company, purchase]);
    assert.equal(audit.rows.length, 1); assert.equal(Number(audit.rows[0].dados.total), Number(sum.total));
  }
});

test('PG XML: prévia sem escrita e importação exige alçada sobre valor bruto mais frete', async () => {
  const f = await fixture(); const { importarXmlCompra } = await import('../../src/suprimentos');
  const { configurarAlcadaCompra } = await import('../../src/empresasApi');
  const suffix = randomUUID().slice(0, 8);
  await q.query("UPDATE fornecedores SET cnpj='11222333000181' WHERE id=$1", [f.supplier]);
  const product = Number((await q.query("INSERT INTO produtos(empresa_id,sku,nome,ativo) VALUES($1,$2,'Produto XML alçada',true) RETURNING id", [f.company, `XML-${suffix}`])).rows[0].id);
  const size = Number((await q.query("INSERT INTO tamanhos(codigo,descricao) VALUES($1,'XML alçada') RETURNING id", [`T${suffix}`])).rows[0].id);
  const managerId = Number((await q.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES('Gerente XML',$1,'gerente',true,$2) RETURNING id", [`xml-${suffix}@example.invalid`, f.company])).rows[0].id);
  await q.query('INSERT INTO usuario_empresas(usuario_id,empresa_id,limite_aprovacao_compra) VALUES($1,$2,129)', [managerId, f.company]);
  const manager = { id: managerId, name: 'Gerente XML', perfil: 'gerente' as const, empresa_id: f.company, empresas: [f.company] };
  // Total declarado menor que as linhas não pode reduzir a alçada exigida.
  const key = `5226101122233300018155001${String(f.company).padStart(19, '0')}`.slice(0, 44);
  const xml = `<nfeProc><NFe><infNFe Id="NFe${key}"><ide><nNF>1</nNF><serie>1</serie><dhEmi>2030-01-01T10:00:00-03:00</dhEmi></ide><emit><CNPJ>11222333000181</CNPJ><xNome>Fornecedor XML</xNome></emit><det nItem="1"><prod><cProd>XML-${suffix}</cProd><xProd>Produto XML</xProd><uCom>UN</uCom><qCom>2</qCom><vUnCom>50</vUnCom><vProd>100</vProd></prod></det><total><ICMSTot><vNF>1</vNF><vProd>100</vProd><vFrete>30</vFrete></ICMSTot></total></infNFe></NFe></nfeProc>`;
  const request = (aplicar: boolean, user = manager) => reqDe({ xml, aplicar, tamanho_id: size, limite_alcada: 999999 }, { user });
  const preview = resFake(); await importarXmlCompra(request(false), preview.res); assert.equal(preview.saida.json.aplicado, false);
  assert.equal(Number((await q.query('SELECT count(*) FROM compras WHERE empresa_id=$1', [f.company])).rows[0].count), 0);
  assert.equal(preview.saida.json.pode_importar, false);
  await assert.rejects(() => importarXmlCompra(request(true), resFake().res), (e: any) => e.status === 422 && /Total do documento/.test(e.message));
  const xmlValido = xml.replace('<vNF>1</vNF>', '<vNF>130</vNF>');
  const requestValido = () => reqDe({ xml: xmlValido, aplicar: true, tamanho_id: size, limite_alcada: 999999 }, { user: manager });
  await assert.rejects(() => importarXmlCompra(requestValido(), resFake().res), (e: any) => e.status === 403 && /alçada/.test(e.message));
  assert.equal(Number((await q.query('SELECT count(*) FROM compras WHERE empresa_id=$1', [f.company])).rows[0].count), 0);
  await configurarAlcadaCompra(reqDe({ limite_aprovacao_compra: 130 }, { params: { id: managerId, empresaId: f.company }, user: f.actor }), resFake().res);
  const applied = resFake(); await importarXmlCompra(requestValido(), applied.res);
  const purchase = (await q.query('SELECT status,aprovada_por,aprovada_em FROM compras WHERE empresa_id=$1 AND id=$2', [f.company, applied.saida.json.compra_id])).rows[0];
  assert.equal(purchase.status, 'recebido'); assert.equal(Number(purchase.aprovada_por), managerId); assert.ok(purchase.aprovada_em);
  const audit = (await q.query("SELECT dados FROM auditoria WHERE empresa_id=$1 AND recurso='compras' AND registro_id=$2 AND dados ? 'aprovacao'", [f.company, applied.saida.json.compra_id])).rows[0];
  assert.ok(audit); assert.equal(Number(audit.dados.aprovacao.valor_considerado), 130);
  const payable = (await q.query("SELECT valor FROM lancamentos_financeiros WHERE empresa_id=$1 AND referencia_tipo='compra' AND referencia_id=$2", [f.company, applied.saida.json.compra_id])).rows[0];
  assert.equal(Number(payable.valor), 130);
  assert.equal(Number((await q.query('SELECT sum(quantidade) AS n FROM estoques WHERE empresa_id=$1 AND produto_id=$2', [f.company, product])).rows[0].n), 2);
});

test('PG alçada: 1001 linhas são contadas antes da aprovação', async () => {
  const f = await fixture(); const { configurarAlcadaCompra } = await import('../../src/empresasApi');
  const managerId = Number((await q.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES('Gerente limite',$1,'gerente',true,$2) RETURNING id", [`limit-${randomUUID()}@example.invalid`, f.company])).rows[0].id);
  await q.query('INSERT INTO usuario_empresas(usuario_id,empresa_id,limite_aprovacao_compra) VALUES($1,$2,1000)', [managerId, f.company]);
  const manager = { id: managerId, name: 'Gerente limite', perfil: 'gerente' as const, empresa_id: f.company, empresas: [f.company] };
  const purchase = Number((await q.query("INSERT INTO compras(empresa_id,fornecedor_id,data,status,total) VALUES($1,$2,'2030-01-01','pendente',0) RETURNING id", [f.company, f.supplier])).rows[0].id);
  await q.query('INSERT INTO itens_compra(empresa_id,compra_id,insumo_id,quantidade,preco_unitario) SELECT $1,$2,$3,1,1 FROM generate_series(1,1001)', [f.company, purchase, f.supply]);
  await assert.rejects(() => call(compras.aprovarCompra, f, {}, purchase, manager), (e: any) => e.status === 403 && /alçada/.test(e.message));
  await configurarAlcadaCompra(reqDe({ limite_aprovacao_compra: 1001 }, { params: { id: managerId, empresaId: f.company }, user: f.actor }), resFake().res);
  const approved = await call(compras.aprovarCompra, f, {}, purchase, manager);
  assert.equal(approved.body.status, 'aprovado'); assert.equal(Number(approved.body.total), 1001);
});

test('PG alçada: revogação concorrente espera a decisão e vale para a próxima compra', { timeout: 30000 }, async () => {
  const f = await fixture(); const { configurarAlcadaCompra } = await import('../../src/empresasApi'); const { getStore } = await import('../../src/services');
  const s = getStore(); const managerId = Number((await q.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES('Gerente revogação',$1,'gerente',true,$2) RETURNING id", [`revoke-${randomUUID()}@example.invalid`, f.company])).rows[0].id);
  await q.query('INSERT INTO usuario_empresas(usuario_id,empresa_id,limite_aprovacao_compra) VALUES($1,$2,100)', [managerId, f.company]);
  const manager = { id: managerId, name: 'Gerente revogação', perfil: 'gerente' as const, empresa_id: f.company, empresas: [f.company] };
  const makePurchase = async () => {
    const id = Number((await q.query("INSERT INTO compras(empresa_id,fornecedor_id,data,status,total) VALUES($1,$2,'2030-01-01','pendente',50) RETURNING id", [f.company, f.supplier])).rows[0].id);
    await q.query('INSERT INTO itens_compra(empresa_id,compra_id,insumo_id,quantidade,preco_unitario) VALUES($1,$2,$3,1,50)', [f.company, id, f.supply]); return id;
  };
  const purchase = await makePurchase(); const original = s.findOneWhere.bind(s); let trapped = false;
  let entered!: () => void, release!: () => void; const ready = new Promise<void>((r) => { entered = r; }); const gate = new Promise<void>((r) => { release = r; });
  s.findOneWhere = async (resource, filter, tx) => {
    if (!trapped && tx && resource.key === 'usuario_empresas' && Number(filter.usuario_id) === managerId) { trapped = true; entered(); await gate; }
    return original(resource, filter, tx);
  };
  try {
    const approving = call(compras.aprovarCompra, f, {}, purchase, manager); await ready;
    const request = () => configurarAlcadaCompra(reqDe({ limite_aprovacao_compra: 0 }, { params: { id: managerId, empresaId: f.company }, user: f.actor }), resFake().res);
    const revoking = request();
    const observation = await Promise.race([revoking.then(() => 'finished', () => 'finished'), new Promise((r) => setTimeout(() => r('waiting'), 100))]);
    assert.equal(observation, 'waiting', 'a alteração aguarda a trava de leitura da aprovação');
    release(); const approved = await approving; assert.equal(approved.body.status, 'aprovado');
    try { await revoking; } catch (e: any) { assert.ok(e.code === '40001' || e.status === 409); await request(); }
    const next = await makePurchase(); await assert.rejects(() => call(compras.aprovarCompra, f, {}, next, manager), (e: any) => e.status === 403);
  } finally { release(); s.findOneWhere = original; }
});
