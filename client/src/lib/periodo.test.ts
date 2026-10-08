import { describe, expect, it } from 'vitest';
import { diasEntre, janelaDoPeriodo, variacaoPct } from './periodo';

// Hoje = 8 de outubro de 2026 (data de referência do projeto), horário local.
const HOJE = new Date(2026, 9, 8, 15, 30);

describe('janelaDoPeriodo', () => {
  it('últimos 7 dias inclui hoje e volta 6 dias', () => {
    expect(janelaDoPeriodo('7d', HOJE)).toEqual({ de: '2026-10-02', ate: '2026-10-08', prevDe: '2026-09-25', prevAte: '2026-10-01', dias: 7 });
  });

  it('mês atual começa no dia 1 e compara com o mesmo número de dias anteriores', () => {
    const j = janelaDoPeriodo('mes', HOJE)!;
    expect(j.de).toBe('2026-10-01');
    expect(j.dias).toBe(8);
    expect(j.prevAte).toBe('2026-09-30');
    expect(diasEntre(j.prevDe, j.prevAte)).toBe(j.dias);
  });

  it('janela anterior nunca se sobrepõe à atual', () => {
    for (const p of ['7d', '30d', 'mes', '90d'] as const) {
      const j = janelaDoPeriodo(p, HOJE)!;
      expect(j.prevAte < j.de).toBe(true);
    }
  });

  it('personalizado exige De ≤ Até', () => {
    expect(janelaDoPeriodo('personalizado', HOJE, { de: '2026-10-05', ate: '2026-10-01' })).toBeNull();
    expect(janelaDoPeriodo('personalizado', HOJE, { de: '', ate: '2026-10-01' })).toBeNull();
    expect(janelaDoPeriodo('personalizado', HOJE, { de: '2026-10-01', ate: '2026-10-03' })?.dias).toBe(3);
  });

  it('cruza virada de ano sem erro', () => {
    const j = janelaDoPeriodo('30d', new Date(2026, 0, 10))!;
    expect(j.de).toBe('2025-12-12');
    expect(j.prevAte).toBe('2025-12-11');
  });
});

describe('variacaoPct', () => {
  it('calcula variação percentual', () => {
    expect(variacaoPct(120, 100)).toBeCloseTo(20);
    expect(variacaoPct(80, 100)).toBeCloseTo(-20);
  });

  it('sem base de comparação devolve null (não inventa percentual)', () => {
    expect(variacaoPct(50, 0)).toBeNull();
  });
});
