// fichaPrint (P0 §8): o documento impresso não pode conter handler inline
// (a CSP `script-src 'self'` o bloquearia); o disparo vem da janela pai,
// como em LabelSheet/MedidasPage.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { imprimirFicha } from './fichaPrint';

const dados = {
  usuario: { nome: 'Maria Teste', email: 'maria@exemplo.com', perfil: 'operador', status_conta: 'ativo', criado_em: '2026-01-01T10:00:00Z', tentativas_falhas: 0 },
  criador: null,
  sessoes: [],
  historico: [],
  acessos: [],
  estatisticas: { logins_30d: 1, eventos_30d: 2, tentativas_falhas: 0, sessoes_ativas: 0 },
};

describe('imprimirFicha', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('gera o HTML sem onload/script inline e imprime pela janela pai', () => {
    vi.useFakeTimers();
    let html = '';
    const printSpy = vi.fn();
    const fakeWin = {
      document: {
        write: (s: string) => { html += s; },
        close: vi.fn(),
      },
      focus: vi.fn(),
      print: printSpy,
    };
    vi.spyOn(window, 'open').mockReturnValue(fakeWin as unknown as Window);

    expect(imprimirFicha(dados as never, 'Admin')).toBe(true);
    expect(html).not.toContain('onload=');
    expect(html).not.toContain('<script');
    expect(html).toContain('Maria Teste');

    expect(printSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('devolve false quando o popup é bloqueado', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(imprimirFicha(dados as never, 'Admin')).toBe(false);
  });
});
