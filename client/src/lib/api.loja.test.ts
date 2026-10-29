import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch, ApiError, getToken, setToken } from './api';

beforeEach(() => { localStorage.clear(); setToken('sessao-erp-preservada'); });
afterEach(() => vi.unstubAllGlobals());

it('erro 401 da API pública da vitrine não apaga a identidade ERP do operador', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401, ok: false, json: async () => ({ error: 'Pagamento indisponível.' }) }));
  await expect(apiFetch('/loja/checkout', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(ApiError);
  expect(getToken()).toBe('sessao-erp-preservada');
});
