import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiError } from './api';

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const response = (status: number, body: object = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

describe('apiFetch — segurança de retry e cancelamento', () => {
  it('não repete POST após erro 500', async () => {
    const fetch = vi.fn().mockResolvedValue(response(500, { error: 'falha' })); vi.stubGlobal('fetch', fetch);
    await expect(apiFetch('/pedido', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 500 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('repete GET com backoff e retorna a resposta', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(503)).mockResolvedValueOnce(response(200, { ok: true })); vi.stubGlobal('fetch', fetch);
    const result = apiFetch('/produto'); await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toEqual({ ok: true }); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('honra AbortSignal do chamador também durante o backoff', async () => {
    const fetch = vi.fn().mockResolvedValue(response(503)); vi.stubGlobal('fetch', fetch);
    const controller = new AbortController(); const result = apiFetch('/produto', { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); controller.abort(); await rejected;
    await vi.advanceTimersByTimeAsync(5000); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('mantém timeout ativo em toda a operação', async () => {
    vi.stubGlobal('fetch', vi.fn((_path: string, opts: RequestInit) => new Promise((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const result = apiFetch('/produto'); const rejected = expect(result).rejects.toBeInstanceOf(ApiError);
    await vi.advanceTimersByTimeAsync(30_000); await rejected;
  });
});

describe('api.upload — multipart sem Content-Type manual', () => {
  it('não força application/json quando o corpo é FormData (o browser põe o boundary)', async () => {
    const fetch = vi.fn().mockResolvedValue(response(200, { ok: true })); vi.stubGlobal('fetch', fetch);
    const fd = new FormData(); fd.append('file', new Blob(['<xml/>']), 'nota.xml'); fd.append('aplicar', 'false');
    const { api } = await import('./api');
    await expect(api.upload('/suprimentos/compras/importar-xml', fd)).resolves.toEqual({ ok: true });
    const [, opts] = fetch.mock.calls[0];
    const headers = opts.headers as Headers;
    expect(headers.has('Content-Type')).toBe(false);
    expect(headers.get('Authorization')).toBeNull(); // sem token no localStorage
    expect(opts.body).toBe(fd);
  });
});
