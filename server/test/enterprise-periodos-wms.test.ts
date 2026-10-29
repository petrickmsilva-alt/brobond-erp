import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
const { RESOURCES } = await import('../src/resources');
const { createRecord, updateRecord, deleteRecord, getStore } = await import('../src/services');
const { alterarPeriodo, obterPeriodo } = await import('../src/financeiroPeriodos');
const { confirmarImportacaoContabil, normalizarImportacao } = await import('../src/financeiroImportacao');
const admin = { id: 1, name: 'Admin', perfil: 'admin' as const, empresa_id: 1, empresas: [1] };
const gerente = { ...admin, perfil: 'gerente' as const };
const escopo = { kind: 'empresa', empresaId: 1 } as const;
function req(user: object, params: object = {}, body: object = {}) { return { user, params, body, query: {} } as any; }
function res() { let body: any; let status = 200; const out: any = { json: (v: any) => { body = v; return out; }, status: (v: number) => { status = v; return out; } }; return { out, get: () => ({ body, status }) }; }
const action = async (user: object, competencia: string, acao: string) => { const r = res(); await alterarPeriodo(req(user, { competencia, acao }, { motivo: 'Decisão da contabilidade' }), r.out); return r.get().body; };

test('ERP contábil: fechamento bloqueia nova escrituração, permite replay e reabertura só por admin', async () => {
  for (const [codigo, natureza] of [['9101', 'ativo'], ['9102', 'receita']]) {
    await createRecord(RESOURCES.plano_contas, { codigo, nome: `Conta ${codigo}`, natureza, tipo: 'analitica', ativo: true }, admin, { escopo });
  }
  const lote = (valor: number) => ({ competencia: '2028-05', entradas: [{ data: '2028-05-15', historico: 'Ajuste contábil', partidas: [
    { conta: '9101', natureza: 'debito', valor }, { conta: '9102', natureza: 'credito', valor },
  ] }] });
  const r = res();
  await confirmarImportacaoContabil(req(gerente, {}, lote(10)), r.out);
  assert.equal(r.get().status, 201);
  const importId = r.get().body.importacao_id;
  const lines = await getStore().list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 100, filter: { empresa_id: 1, documento_origem_id: importId } });
  assert.equal(lines.rows.length, 2);
  await assert.rejects(() => updateRecord(RESOURCES.lancamentos_financeiros, Number(lines.rows[0].id), { valor: 90 }, admin, { escopo }), (e: any) => e.status === 409);
  await assert.rejects(() => deleteRecord(RESOURCES.lancamentos_financeiros, Number(lines.rows[0].id), admin, escopo), (e: any) => e.status === 409);
  await action(gerente, '2028-05', 'fechar');
  const replay = res();
  await confirmarImportacaoContabil(req(gerente, {}, lote(10)), replay.out);
  assert.equal(replay.get().body.idempotente, true);
  await assert.rejects(() => confirmarImportacaoContabil(req(gerente, {}, lote(20)), res().out), (e: any) => e.status === 409);
  await assert.rejects(() => action(gerente, '2028-05', 'reabrir'), (e: any) => e.status === 403);
  await action(admin, '2028-05', 'reabrir');
  const again = res();
  await confirmarImportacaoContabil(req(gerente, {}, lote(20)), again.out);
  assert.equal(again.get().status, 201);
  const other = res();
  await obterPeriodo(req({ ...admin, empresa_id: 2, empresas: [2] }, { competencia: '2028-05' }), other.out);
  assert.equal(other.get().body.estado, 'aberto');
  assert.equal(other.get().body.registrado, false);
});

test('ERP contábil: rejeita dias inexistentes, competência inválida e frações de centavo', () => {
  const lote = (data: string, valor: number, competencia = '2028-02') => ({ competencia, entradas: [{ data, historico: 'teste', partidas: [
    { conta: 'a', natureza: 'debito', valor }, { conta: 'b', natureza: 'credito', valor },
  ] }] });
  for (const item of [lote('2028-02-30', 10), lote('2028-02-01', 10, '2028-13'), lote('2028-02-01', 1.001)])
    assert.throws(() => normalizarImportacao(item));
});

test('WMS: armazém → zona → endereço usa locais existentes e impede vínculos inválidos', async () => {
  const criar = (nome: string, nivel_wms: string, local_pai_id?: number) => createRecord(RESOURCES.locais,
    { nome, tipo: 'loja', ativo: true, nivel_wms, ...(local_pai_id ? { local_pai_id } : {}) }, admin, { escopo });
  const armazem = await criar('WMS armazém de teste', 'armazem');
  const zona = await criar('WMS zona de teste', 'zona', Number(armazem.id));
  const bin = await criar('WMS endereço de teste', 'endereco', Number(zona.id));
  assert.equal(Number(bin.local_pai_id), Number(zona.id));
  await assert.rejects(() => criar('WMS pai inválido', 'endereco', Number(armazem.id)), (e: any) => e.status === 409);
  await assert.rejects(() => updateRecord(RESOURCES.locais, Number(armazem.id), { nivel_wms: 'local' }, admin, { escopo }), (e: any) => e.status === 409);
  await assert.rejects(() => deleteRecord(RESOURCES.locais, Number(zona.id), admin, escopo), (e: any) => e.status === 409);
  const foreign = await createRecord(RESOURCES.locais, { nome: 'WMS outra empresa', tipo: 'loja', nivel_wms: 'armazem' }, admin, { escopo: { kind: 'empresa', empresaId: 2 } as any });
  await assert.rejects(() => criar('WMS cruzado', 'zona', Number(foreign.id)), (e: any) => e.status === 404);
});
