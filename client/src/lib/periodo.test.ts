import { describe, expect, it } from 'vitest';
import { dataISO, diasEntre, janelaDoPeriodo, variacaoPct } from './periodo';

// Hoje = 8 de outubro de 2026, às 15:30 em America/Sao_Paulo.
const HOJE = new Date('2026-10-08T15:30:00-03:00');

describe('dataISO — dia civil America/Sao_Paulo', () => {
  it('mantém o dia civil antes da meia-noite de Brasília mesmo após a virada UTC', () => {
    expect(dataISO(new Date('2026-10-08T02:59:59.999Z'))).toBe('2026-10-07');
  });

  it('vira o dia exatamente à meia-noite de Brasília (03:00 UTC)', () => {
    expect(dataISO(new Date('2026-10-08T03:00:00.000Z'))).toBe('2026-10-08');
  });

  it('mantém domingo até 23:59:59.999 antes da abertura da semana civil', () => {
    expect(dataISO(new Date('2026-10-05T02:59:59.999Z'))).toBe('2026-10-04');
  });

  it('muda para segunda-feira à meia-noite de Brasília', () => {
    expect(dataISO(new Date('2026-10-05T03:00:00.000Z'))).toBe('2026-10-05');
  });

  it('mantém 31 de janeiro no mês civil correto durante a virada UTC', () => {
    expect(dataISO(new Date('2026-02-01T02:59:59.999Z'))).toBe('2026-01-31');
  });

  it('abre fevereiro somente à meia-noite de Brasília', () => {
    expect(dataISO(new Date('2026-02-01T03:00:00.000Z'))).toBe('2026-02-01');
  });

  it('mantém 31 de dezembro no ano civil anterior durante a virada UTC', () => {
    expect(dataISO(new Date('2026-01-01T02:59:59.999Z'))).toBe('2025-12-31');
  });

  it('abre o ano novo somente à meia-noite de Brasília', () => {
    expect(dataISO(new Date('2026-01-01T03:00:00.000Z'))).toBe('2026-01-01');
  });
});

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
    const j = janelaDoPeriodo('30d', new Date('2026-01-10T15:00:00-03:00'))!;
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
