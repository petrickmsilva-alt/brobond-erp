// ============================================================================
// VARIAÇÕES — geração determinística de SKUs filhos.
//
// O que precisa ser verdade:
//   • a mesma entrada produz exatamente os mesmos SKUs (determinismo);
//   • rodar duas vezes não duplica nada (idempotência);
//   • a variação herda a ficha do pai (fiscal, dimensões, preços);
//   • tamanho fora da grade é recusado;
//   • variação de variação não existe (um nível só);
//   • a geração respeita a empresa ativa.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { RESOURCES } = await import('../src/resources');
const { getStore, createRecord } = await import('../src/services');
const { combinar, fatiaSku } = await import('../src/variacoes');
const { gerarVariacoes, listarVariacoes, previaVariacoes } = await import('../src/variacoes');

const ADMIN = { id: 1, name: 'Admin', perfil: 'admin' as const, empresa_id: 1, empresas: [1] };

test('a combinação é pura e determinística', () => {
  const a = combinar({ sku: 'CAM-POLO', nome: 'Camisa Polo' }, [{ id: 1, nome: 'Azul Marinho' }], [
    { id: 10, codigo: 'P' },
    { id: 11, codigo: 'M' },
  ]);
  const b = combinar({ sku: 'CAM-POLO', nome: 'Camisa Polo' }, [{ id: 1, nome: 'azul marinho' }], [
    { id: 10, codigo: 'p' },
    { id: 11, codigo: 'm' },
  ]);

  assert.deepEqual(
    a.map((c) => c.sku),
    ['CAM-POLO-AZUL-MARINHO-P', 'CAM-POLO-AZUL-MARINHO-M']
  );
  assert.deepEqual(a.map((c) => c.sku), b.map((c) => c.sku), 'caixa e acento não mudam o SKU');
  assert.deepEqual(a.map((c) => c.chave), ['COR:AZUL-MARINHO|TAM:P', 'COR:AZUL-MARINHO|TAM:M']);
  assert.equal(a[0].nome, 'Camisa Polo Azul Marinho P');
  assert.equal(fatiaSku('Açaí Especial'), 'ACAI-ESPECIAL');
});

test('só tamanhos, sem cores, também combina', () => {
  const r = combinar({ sku: 'BON', nome: 'Boné' }, [], [{ id: 1, codigo: 'U' }]);
  assert.deepEqual(r.map((c) => c.sku), ['BON-U']);
  assert.equal(r[0].chave, 'TAM:U');
});

// ---------------------------------------------------------------------------
// Fluxo HTTP
// ---------------------------------------------------------------------------

const express = (await import('express')).default;
const request = (await import('supertest')).default;

function app(user: any = ADMIN) {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res: any, next: any) => {
    req.user = user;
    next();
  });
  const wrap = (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req, res)).catch(next);
  a.get('/api/produtos/:id/variacoes', wrap(listarVariacoes));
  a.get('/api/produtos/:id/variacoes/previa', wrap(previaVariacoes));
  a.post('/api/produtos/:id/variacoes', wrap(gerarVariacoes));
  a.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).json({ error: err.message }));
  return a;
}

async function cenario(nome: string) {
  const s = getStore();
  const tamanhos = [];
  for (const [i, codigo] of ['P', 'M', 'G'].entries()) {
    const existente = await s.findOneWhere(RESOURCES.tamanhos, { codigo });
    tamanhos.push(existente ?? (await createRecord(RESOURCES.tamanhos, { codigo, ordem: i + 1 }, ADMIN)));
  }
  // A grade já sabe montar `grade_tamanhos` a partir do multiref — nada de
  // duplicar esse cadastro aqui.
  const grade = await createRecord(
    RESOURCES.grades,
    { nome: `Grade ${nome}`, tamanhos: tamanhos.map((t) => Number(t.id)) },
    ADMIN
  );
  const cor = await createRecord(RESOURCES.cores, { nome: `Azul ${nome}`, hex: '#0033aa' }, ADMIN);
  const pai = await createRecord(
    RESOURCES.produtos,
    {
      sku: `PAI-${nome}`,
      nome: `Camisa ${nome}`,
      grade_id: Number(grade.id),
      ncm: '61091000',
      icms_cst: '00',
      icms_aliquota: 18,
      preco_venda: 120,
      custo: 40,
      peso_liquido_g: 180,
    },
    ADMIN
  );
  return { grade, tamanhos, cor, pai };
}

test('gera as variações, herda a ficha do pai e marca o pai como "variacao"', async () => {
  const { pai, cor, tamanhos } = await cenario('ALFA');

  const previa = await request(app()).get(`/api/produtos/${pai.id}/variacoes/previa`).query({ cor_ids: String(cor.id) });
  assert.equal(previa.status, 200);
  assert.equal(previa.body.total, 3);
  assert.equal(previa.body.novas, 3);
  assert.equal(previa.body.variacoes[0].ja_existe, false);

  const resp = await request(app()).post(`/api/produtos/${pai.id}/variacoes`).send({ cor_ids: [Number(cor.id)] });
  assert.equal(resp.status, 201, JSON.stringify(resp.body));
  assert.equal(resp.body.criadas.length, 3);
  assert.deepEqual(
    resp.body.criadas.map((v: any) => v.sku),
    [`PAI-ALFA-${fatiaSku(cor.nome)}-P`, `PAI-ALFA-${fatiaSku(cor.nome)}-M`, `PAI-ALFA-${fatiaSku(cor.nome)}-G`]
  );

  const s = getStore();
  const paiDepois = await s.get(RESOURCES.produtos, Number(pai.id));
  assert.equal(paiDepois!.formato, 'variacao');

  const filho = await s.get(RESOURCES.produtos, Number(resp.body.criadas[0].id));
  assert.equal(Number(filho!.produto_pai_id), Number(pai.id));
  assert.equal(filho!.ncm, '61091000', 'tributação herdada');
  assert.equal(Number(filho!.icms_aliquota), 18);
  assert.equal(Number(filho!.preco_venda), 120, 'preço herdado');
  assert.equal(Number(filho!.peso_liquido_g), 180, 'dimensões herdadas');
  assert.equal(Number(filho!.variacao_tamanho_id), Number(tamanhos[0].id));
});

test('rodar de novo não duplica: a segunda chamada só mantém', async () => {
  const { pai, cor } = await cenario('BETA');
  const primeira = await request(app()).post(`/api/produtos/${pai.id}/variacoes`).send({ cor_ids: [Number(cor.id)] });
  assert.equal(primeira.body.criadas.length, 3);

  const segunda = await request(app()).post(`/api/produtos/${pai.id}/variacoes`).send({ cor_ids: [Number(cor.id)] });
  assert.equal(segunda.status, 200);
  assert.equal(segunda.body.criadas.length, 0);
  assert.equal(segunda.body.mantidas.length, 3);
  assert.match(segunda.body.mensagem, /já existem/i);

  const lista = await request(app()).get(`/api/produtos/${pai.id}/variacoes`);
  assert.equal(lista.body.total, 3, 'continuam sendo três, não seis');
});

test('ampliar a lista de cores só cria o que falta', async () => {
  const { pai, cor } = await cenario('GAMA');
  await request(app()).post(`/api/produtos/${pai.id}/variacoes`).send({ cor_ids: [Number(cor.id)] });
  const preta = await createRecord(RESOURCES.cores, { nome: 'Preto GAMA', hex: '#000000' }, ADMIN);

  const resp = await request(app())
    .post(`/api/produtos/${pai.id}/variacoes`)
    .send({ cor_ids: [Number(cor.id), Number(preta.id)] });

  assert.equal(resp.body.criadas.length, 3, 'só as três da cor nova');
  assert.equal(resp.body.mantidas.length, 3);
  const lista = await request(app()).get(`/api/produtos/${pai.id}/variacoes`);
  assert.equal(lista.body.total, 6);
});

test('subconjunto de tamanhos é respeitado; tamanho fora da grade é recusado', async () => {
  const { pai, cor, tamanhos } = await cenario('DELTA');

  const resp = await request(app())
    .post(`/api/produtos/${pai.id}/variacoes`)
    .send({ cor_ids: [Number(cor.id)], tamanho_ids: [Number(tamanhos[1].id)] });
  assert.equal(resp.body.criadas.length, 1);
  assert.match(resp.body.criadas[0].sku, /-M$/);

  const forade = await createRecord(RESOURCES.tamanhos, { codigo: 'XGG-DELTA', ordem: 99 }, ADMIN);
  const erro = await request(app())
    .post(`/api/produtos/${pai.id}/variacoes`)
    .send({ cor_ids: [Number(cor.id)], tamanho_ids: [Number(forade.id)] });
  assert.equal(erro.status, 400);
  assert.match(erro.body.error, /não pertence à grade/i);
});

test('variação de variação não existe', async () => {
  const { pai, cor } = await cenario('EPSILON');
  const criadas = await request(app()).post(`/api/produtos/${pai.id}/variacoes`).send({ cor_ids: [Number(cor.id)] });
  const filhoId = criadas.body.criadas[0].id;

  const resp = await request(app()).post(`/api/produtos/${filhoId}/variacoes`).send({ cor_ids: [Number(cor.id)] });
  assert.equal(resp.status, 409);
  assert.match(resp.body.error, /já é uma variação/i);
});

test('produto sem SKU não gera variação', async () => {
  // O cadastro exige SKU, então o caso só aparece em base legada/importada.
  // A guarda existe para esse cenário — aqui ele é reproduzido direto no store.
  const semSku = await createRecord(RESOURCES.produtos, { sku: 'TEMP-SEM-SKU', nome: 'Sem SKU', preco_venda: 10 }, ADMIN);
  await getStore().update(RESOURCES.produtos, Number(semSku.id), { sku: '' });

  const resp = await request(app()).post(`/api/produtos/${semSku.id}/variacoes`).send({ cor_ids: [] });
  assert.equal(resp.status, 409);
  assert.match(resp.body.error, /SKU do produto pai/i);
});

test('sem grade e sem cores não há o que combinar', async () => {
  const solto = await createRecord(RESOURCES.produtos, { sku: 'SOLTO-1', nome: 'Solto', preco_venda: 10 }, ADMIN);
  const resp = await request(app()).post(`/api/produtos/${solto.id}/variacoes`).send({});
  assert.equal(resp.status, 400);
  assert.match(resp.body.error, /ao menos uma grade/i);
});

test('produto de outra empresa responde 404, não 403', async () => {
  const { pai } = await cenario('ZETA');
  const outraEmpresa = { id: 9, name: 'Bruno (B)', perfil: 'gerente' as const, empresa_id: 999, empresas: [999] };
  const resp = await request(app(outraEmpresa)).get(`/api/produtos/${pai.id}/variacoes`);
  assert.equal(resp.status, 404);
});
