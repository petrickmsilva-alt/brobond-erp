// Ordem Final 2.7 — arquivos privados: a URL assinada só é emitida para registros acessíveis ao
// ator na sua empresa. Outra empresa recebe 404 (sem revelar existência) e nenhuma URL.
// LOCAL: store em memória; handlers reais (listFiles, serveFile); nenhuma rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-arquivos-segregacao';

const { getStore } = await import('../src/services');
const { getResource } = await import('../src/resources');
const { listFiles } = await import('../src/uploads');
const s: any = getStore();

const resposta = () => {
  const r: any = { status: 200, body: undefined, headers: {} };
  r.status = (c: number) => { r.statusCode = c; r.code = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.setHeader = (k: string, v: unknown) => { r.headers[k.toLowerCase()] = String(v); };
  return r;
};

async function preparar() {
  const lanc = await s.insert(getResource('lancamentos_financeiros')!, {
    empresa_id: 1, descricao: 'Lançamento de segregação', tipo: 'receita', valor: 10, data: '2026-11-01', status: 'aberto',
  } as never);
  const token = randomBytes(16).toString('hex');
  await s.insert(getResource('arquivos')!, {
    recurso: 'lancamentos_financeiros', registro_id: Number(lanc.id), nome: 'comp.png', mime: 'image/png',
    tamanho_bytes: 4, url: null, thumb_url: null, externo_id: null, dados: Buffer.from('png!'), thumb: null, token,
    principal: true, ordem: 0, ativo: true, empresa_id: 1,
  } as never);
  return Number(lanc.id);
}

const ator = (empresa: number) => ({ id: 77 + empresa, name: `op-${empresa}`, perfil: 'admin', empresa_id: empresa, email: `op${empresa}@x.test` });

test('mesma empresa: lista o comprovante com URL assinada (privada, com exp e sig)', async () => {
  const id = await preparar();
  const res = resposta();
  await listFiles({ params: { resource: 'lancamentos_financeiros', id: String(id) }, user: ator(1), query: {}, headers: {} } as any, res);
  assert.equal(res.statusCode ?? 200, 200);
  assert.ok(Array.isArray(res.body) && res.body.length === 1);
  const url = String(res.body[0].url || res.body[0].thumb_url || '');
  assert.match(url, /\?exp=\d+&sig=[a-f0-9]{64}/, 'URL privada assinada');
});

test('outra empresa: 404 uniforme e nenhuma URL do comprovante', async () => {
  const id = await preparar();
  const res = resposta();
  let erro: any = null;
  try {
    await listFiles({ params: { resource: 'lancamentos_financeiros', id: String(id) }, user: ator(2), query: {}, headers: {} } as any, res);
  } catch (e: any) { erro = e; }
  const status = erro?.status ?? res.statusCode ?? 200;
  assert.equal(status, 404, `esperado 404; obtido ${status}`);
  assert.ok(!JSON.stringify(res.body ?? null).includes('/api/files/'), 'nenhuma URL de arquivo para outra empresa');
});
