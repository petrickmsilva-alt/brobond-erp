import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api';
import { rotuloDeTela } from './perf';

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const resposta = (body: object, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe('PERF-08 — coalescing de leituras idênticas', () => {
  it('duas leituras iguais SIMULTÂNEAS fazem UMA chamada de rede', async () => {
    const fetch = vi.fn().mockResolvedValue(resposta({ itens: [1, 2, 3] }));
    vi.stubGlobal('fetch', fetch);

    const [a, b] = await Promise.all([apiFetch('/produtos'), apiFetch('/produtos')]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ itens: [1, 2, 3] });
    expect(b).toEqual({ itens: [1, 2, 3] });
  });

  it('cada chamador recebe uma CÓPIA — mutar uma não afeta a outra', async () => {
    const fetch = vi.fn().mockResolvedValue(resposta({ itens: [{ id: 1 }] }));
    vi.stubGlobal('fetch', fetch);

    const [a, b] = await Promise.all([apiFetch<any>('/produtos'), apiFetch<any>('/produtos')]);
    a.itens[0].id = 999;
    expect(b.itens[0].id).toBe(1);
  });

  it('leituras SEQUENCIAIS continuam indo à rede (sem cache velho)', async () => {
    const fetch = vi.fn().mockResolvedValue(resposta({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    await apiFetch('/produtos');
    await apiFetch('/produtos');

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('caminhos diferentes não são coalescidos', async () => {
    const fetch = vi.fn().mockResolvedValue(resposta({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    await Promise.all([apiFetch('/produtos'), apiFetch('/clientes')]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('escrita NUNCA é coalescida, mesmo idêntica e simultânea', async () => {
    const fetch = vi.fn().mockResolvedValue(resposta({ ok: true }, 201));
    vi.stubGlobal('fetch', fetch);

    await Promise.all([
      apiFetch('/pedidos', { method: 'POST', body: '{}' }),
      apiFetch('/pedidos', { method: 'POST', body: '{}' }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('chamador com AbortSignal controla o próprio ciclo (não compartilha)', async () => {
    const fetch = vi.fn().mockResolvedValue(resposta({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const c = new AbortController();

    await Promise.all([apiFetch('/produtos'), apiFetch('/produtos', { signal: c.signal })]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('erro não fica em cache: a chamada seguinte vai à rede', async () => {
    // 404 não é repetido pelo retry (só 5xx é), então isola o comportamento
    // do coalescing: a promessa que falhou sai do mapa.
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(resposta({ error: 'não encontrado' }, 404))
      .mockResolvedValue(resposta({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    await expect(apiFetch('/produtos')).rejects.toMatchObject({ status: 404 });
    await expect(apiFetch('/produtos')).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('falha compartilhada rejeita para TODOS os chamadores simultâneos', async () => {
    const fetch = vi.fn().mockResolvedValue(resposta({ error: 'não encontrado' }, 404));
    vi.stubGlobal('fetch', fetch);

    const resultados = await Promise.allSettled([apiFetch('/produtos'), apiFetch('/produtos')]);
    expect(resultados.every((r) => r.status === 'rejected')).toBe(true);
    // Uma única ida à rede para as duas chamadas.
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('PERF-09 — rótulo de tela normalizado', () => {
  it('substitui IDs numéricos e UUIDs para a série temporal não explodir', () => {
    expect(rotuloDeTela('/produtos/123')).toBe('/produtos/:id');
    expect(rotuloDeTela('/vendas/9/itens/42')).toBe('/vendas/:id/itens/:id');
    expect(rotuloDeTela('/produtos?q=segredo&f.preco=99')).toBe('/produtos');
    expect(rotuloDeTela('/portal/8f14e45f-ceea-467f-a0d1-1a2b3c4d5e6f')).toBe('/portal/:uuid');
  });
});
