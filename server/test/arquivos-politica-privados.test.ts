// ============================================================================
// POLÍTICA DE ARQUIVOS — privados x públicos (Fase 4.3, item 12)
//
// Store em memória, sem rede: chama o handler real `serveFile` com requisição e
// resposta simuladas. Cobre acesso autorizado, negado, expirado, prazo acima do
// permitido, troca de arquivo (isolamento), miniatura x original e recurso público.
// ============================================================================
import { test, describe } from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-arquivos-politica';

const { getStore } = await import('../src/services');
const { getResource } = await import('../src/resources');
const { serveFile, toPublicFile } = await import('../src/uploads');
const {
  assinarArquivo, caminhoArquivoPrivado, verificarArquivoPrivado, arquivoEhPublico,
  TTL_URL_PRIVADA_SEGUNDOS,
} = await import('../src/arquivosPolitica');

const s = getStore();
const BYTES_PRIVADOS = Buffer.from('comprovante-financeiro-privado');
const BYTES_PUBLICOS = Buffer.from('foto-produto-publica');

type Resposta = { status: number; headers: Record<string, string>; body: Buffer | string | null; redirect: string | null };

/** Simula req/res do Express para o handler real serveFile. */
async function chamar(caminho: string, query: Record<string, string> = {}): Promise<Resposta> {
  const semQuery = caminho.split('?')[0];
  const m = /^\/api\/files\/(\d+)\/([^./?]+)\.[a-z0-9]+$/i.exec(semQuery);
  assert.ok(m, `caminho inválido no teste: ${caminho}`);
  const req = { params: { id: m[1], token: `${m[2]}.png` }, query } as unknown as import('express').Request;
  const out: Resposta = { status: 200, headers: {}, body: null, redirect: null };
  const res = {
    setHeader(k: string, v: unknown) { out.headers[k.toLowerCase()] = String(v); },
    status(c: number) { out.status = c; return this; },
    end(b?: Buffer | string) { out.body = b ?? null; return this; },
    redirect(c: number, url: string) { out.status = c; out.redirect = url; return this; },
  } as unknown as import('express').Response;
  await serveFile(req, res);
  return out;
}

async function criarArquivo(recurso: string, registro: number, dados: Buffer, extra: Record<string, unknown> = {}) {
  // Token real: hexadecimal aleatório (como em produção, gerado com randomBytes).
  const token = randomBytes(16).toString('hex');
  const row = await s.insert(getResource('arquivos')!, {
    recurso, registro_id: registro, nome: 'arq.png', mime: 'image/png', tamanho_bytes: dados.length,
    url: null, thumb_url: null, externo_id: null, dados, thumb: null, token,
    principal: false, ordem: 0, ativo: true, empresa_id: 1, ...extra,
  } as never);
  return { id: Number(row.id), token, dados };
}

describe('Arquivos privados (comprovantes) exigem URL assinada e temporária', () => {
  test('acesso autorizado: URL assinada devolve o conteúdo com cache privado (no-store)', async () => {
    const a = await criarArquivo('lancamentos_financeiros', 10, BYTES_PRIVADOS);
    const url = caminhoArquivoPrivado(a.id, a.token, 'png', 'imagem');
    const r = await chamar(url, Object.fromEntries(new URL(`http://x${url}`).searchParams));
    assert.equal(r.status, 200);
    assert.equal(r.body?.toString(), BYTES_PRIVADOS.toString());
    assert.equal(r.headers['cache-control'], 'private, no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });

  test('acesso negado: sem assinatura → 404 uniforme, sem conteúdo e sem cache público', async () => {
    const a = await criarArquivo('lancamentos_financeiros', 11, BYTES_PRIVADOS);
    const r = await chamar(`/api/files/${a.id}/${a.token}.png`);
    assert.equal(r.status, 404);
    assert.equal(r.body, null);
    assert.ok(!String(r.headers['cache-control'] || '').includes('public'));
  });

  test('assinatura adulterada → 404', async () => {
    const a = await criarArquivo('lancamentos_financeiros', 12, BYTES_PRIVADOS);
    const url = caminhoArquivoPrivado(a.id, a.token, 'png', 'imagem');
    const trocada = url.replace(/sig=([a-f0-9])/, (_m, c) => `sig=${c === 'a' ? 'b' : 'a'}`);
    const r = await chamar(trocada, Object.fromEntries(new URL(`http://x${trocada}`).searchParams));
    assert.equal(r.status, 404);
  });

  test('URL expirada → 404', async () => {
    const a = await criarArquivo('lancamentos_financeiros', 13, BYTES_PRIVADOS);
    const antigo = Math.floor(Date.now() / 1000) - 3600; // gerada há 1 h: já expirou
    const url = caminhoArquivoPrivado(a.id, a.token, 'png', 'imagem', antigo);
    const r = await chamar(url, Object.fromEntries(new URL(`http://x${url}`).searchParams));
    assert.equal(r.status, 404);
  });

  test('prazo acima do TTL permitido é recusado mesmo com assinatura correta', async () => {
    const a = await criarArquivo('lancamentos_financeiros', 14, BYTES_PRIVADOS);
    const exp = Math.floor(Date.now() / 1000) + TTL_URL_PRIVADA_SEGUNDOS * 4;
    const sig = assinarArquivo(a.id, a.token, 'imagem', exp);
    assert.equal(verificarArquivoPrivado(a.id, a.token, 'imagem', String(exp), sig), false);
    const r = await chamar(`/api/files/${a.id}/${a.token}.png?exp=${exp}&sig=${sig}`, { exp: String(exp), sig });
    assert.equal(r.status, 404);
  });

  test('isolamento: assinatura de um arquivo não serve para outro (troca de id ou token)', async () => {
    const a = await criarArquivo('lancamentos_financeiros', 15, BYTES_PRIVADOS);
    const b = await criarArquivo('lancamentos_financeiros', 16, Buffer.from('outro-comprovante'));
    const url = caminhoArquivoPrivado(a.id, a.token, 'png', 'imagem');
    const params = Object.fromEntries(new URL(`http://x${url}`).searchParams);
    const trocaId = await chamar(`/api/files/${b.id}/${b.token}.png`, params);
    assert.equal(trocaId.status, 404, 'id trocado não pode reaproveitar a assinatura');
    const trocaToken = await chamar(`/api/files/${a.id}/${b.token}.png`, params);
    assert.equal(trocaToken.status, 404, 'token trocado não pode reaproveitar a assinatura');
  });

  test('miniatura assinada não serve o original (a variante é coberta pela assinatura)', async () => {
    const a = await criarArquivo('lancamentos_financeiros', 17, BYTES_PRIVADOS);
    const thumbUrl = caminhoArquivoPrivado(a.id, a.token, 'png', 'miniatura');
    const params = Object.fromEntries(new URL(`http://x${thumbUrl}`).searchParams);
    const semThumb = { exp: params.exp, sig: params.sig };
    const r = await chamar(`/api/files/${a.id}/${a.token}.png`, semThumb);
    assert.equal(r.status, 404);
  });

  test('segundo recurso desconhecido é PRIVADO (fail-closed)', async () => {
    const a = await criarArquivo('recurso_inexistente', 18, BYTES_PRIVADOS);
    assert.equal(arquivoEhPublico('recurso_inexistente'), false);
    const r = await chamar(`/api/files/${a.id}/${a.token}.png`);
    assert.equal(r.status, 404);
  });

  test('toPublicFile de arquivo privado NÃO expõe a URL externa armazenada', async () => {
    const a = await criarArquivo('lancamentos_financeiros', 19, Buffer.alloc(0), {
      dados: null, url: 'https://cdn.exemplo.invalid/comprovante-secreto.png',
    });
    const row = await s.fileById(a.id);
    const pub = toPublicFile(row as never);
    assert.ok(pub.url.startsWith(`/api/files/${a.id}/`), `url deve ser local assinada: ${pub.url}`);
    assert.ok(!pub.url.includes('cdn.exemplo.invalid'));
    assert.match(pub.url, /exp=\d+&sig=[a-f0-9]{64}/);
  });
});

describe('Arquivos públicos (catálogo) mantêm o comportamento legítimo', () => {
  test('produtos: acesso sem assinatura com cache público de longa duração', async () => {
    const a = await criarArquivo('produtos', 20, BYTES_PUBLICOS);
    const r = await chamar(`/api/files/${a.id}/${a.token}.png`);
    assert.equal(r.status, 200);
    assert.equal(r.body?.toString(), BYTES_PUBLICOS.toString());
    assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
  });

  test('produtos: a URL pública continua sem assinatura (não quebra vitrine)', async () => {
    const a = await criarArquivo('produtos', 21, BYTES_PUBLICOS);
    const pub = toPublicFile((await s.fileById(a.id)) as never);
    assert.equal(pub.url, `/api/files/${a.id}/${a.token}.png`);
  });

  test('token inválido continua 404 em ambos os tipos', async () => {
    const a = await criarArquivo('produtos', 22, BYTES_PUBLICOS);
    const r = await chamar(`/api/files/${a.id}/${'0'.repeat(32)}.png`);
    assert.equal(r.status, 404);
  });
});

describe('Verificação criptográfica da assinatura', () => {
  test('entradas malformadas são recusadas sem lançar exceção', () => {
    const agora = Math.floor(Date.now() / 1000);
    const sig = 'a'.repeat(64);
    assert.equal(verificarArquivoPrivado(1, 'tok', 'imagem', undefined, sig, agora), false);
    assert.equal(verificarArquivoPrivado(1, 'tok', 'imagem', '1.5', sig, agora), false);
    assert.equal(verificarArquivoPrivado(1, 'tok', 'imagem', 'abc', sig, agora), false);
    assert.equal(verificarArquivoPrivado(1, 'tok', 'imagem', String(agora + 60), 'curta', agora), false);
    assert.equal(verificarArquivoPrivado(1, 'tok', 'imagem', String(agora + 60), ['x'], agora), false);
  });

  test('assinatura válida é aceita dentro do prazo e recusada após a expiração (relógio injetado)', () => {
    const agora = 1_800_000_000;
    const url = caminhoArquivoPrivado(7, 'tokenabc', 'png', 'imagem', agora);
    const params = new URL(`http://x${url}`).searchParams;
    assert.equal(verificarArquivoPrivado(7, 'tokenabc', 'imagem', params.get('exp'), params.get('sig'), agora + 1), true);
    assert.equal(verificarArquivoPrivado(7, 'tokenabc', 'imagem', params.get('exp'), params.get('sig'), agora + TTL_URL_PRIVADA_SEGUNDOS + 1), false);
  });
});
