// ============================================================================
// MULTIEMPRESA (PG) — o painel /api/dashboard lê SOMENTE a empresa ativa.
//
// Executa as 9 consultas reescritas (`empresa_id = $1`) contra Postgres real.
// Usa empresas novas, então os números são exatos mesmo com outros dados no
// banco. Sem DATABASE_URL o arquivo se auto-pula (job testes-postgres do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

test('painel (PG): estoque, produtos e valorização respeitam a empresa ativa', { skip }, async () => {
  const { migrate } = await import('../src/db');
  await migrate();
  const { RESOURCES } = await import('../src/resources');
  const { createRecord, getStore } = await import('../src/services');
  const { escopoDoAtor } = await import('../src/empresa');
  const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };

  const sufixo = `${Date.now() % 1e9}`;
  const a = Number((await createRecord(RESOURCES.empresas, { nome: `PNL-A ${sufixo}`, razao_social: `PNL A ${sufixo} LTDA` }, admin)).id);
  const b = Number((await createRecord(RESOURCES.empresas, { nome: `PNL-B ${sufixo}`, razao_social: `PNL B ${sufixo} LTDA` }, admin)).id);
  const atorA = { id: 1, name: 'Admin', perfil: 'admin' as const, empresa_id: a, empresas: [a] };
  const atorB = { id: 1, name: 'Admin', perfil: 'admin' as const, empresa_id: b, empresas: [b] };
  const s = getStore();
  {
    const pA = await createRecord(RESOURCES.produtos, { sku: `PNLA-${sufixo}`, nome: 'Produto PNL A', custo: 10, preco_venda: 20 }, atorA as any);
    const pB = await createRecord(RESOURCES.produtos, { sku: `PNLB-${sufixo}`, nome: 'Produto PNL B', custo: 10, preco_venda: 20 }, atorB as any);
    await s.insert(RESOURCES.estoques, { produto_id: Number(pA.id), tamanho_id: null, local: 'loja', quantidade: 7, estoque_min: 0, empresa_id: a });
    await s.insert(RESOURCES.estoques, { produto_id: Number(pB.id), tamanho_id: null, local: 'loja', quantidade: 11, estoque_min: 0, empresa_id: b });

    const dA = await s.dashboard(escopoDoAtor({ id: 1, perfil: 'gerente', empresa_id: a, empresas: [a] } as any));
    assert.equal(dA.pecasEstoque, 7, 'empresa A: só as 7 peças dela');
    assert.equal(dA.totais.produtos, 1);
    assert.ok(dA.valorizacao.produtos.every((p) => !p.produto.includes('PNL B')), 'valorização sem produtos da B');

    const dB = await s.dashboard(escopoDoAtor({ id: 1, perfil: 'gerente', empresa_id: a, empresas: [a, b], empresa_sessao: b } as any));
    assert.equal(dB.pecasEstoque, 11, 'empresa B ativa: só as 11 peças dela');
    assert.equal(dB.totais.produtos, 1);

    const consolidado = await s.dashboard(escopoDoAtor({ id: 1, perfil: 'admin', empresa_id: a, empresas: [a, b], consolidar: true, pode_consolidar: true } as any));
    assert.ok(consolidado.pecasEstoque >= 18, 'consolidado autorizado inclui as duas empresas');

    // Sem escopo (sistema): leitura do grupo, como antes.
    const todas = await s.dashboard();
    assert.ok(todas.pecasEstoque >= 18);
  }
});
