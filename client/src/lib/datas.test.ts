import { describe, expect, it } from 'vitest';
import { diaDaSemana, diasNoMes, formatarDiaBR, lerDia, somarDias, somarMeses, validarIntervalo } from './datas';

describe('datas (dia civil, sem fuso)', () => {
  it('rejeita datas inexistentes e formatos inválidos', () => {
    expect(lerDia('2026-02-30')).toBeNull();
    expect(lerDia('2026-13-01')).toBeNull();
    expect(lerDia('08/10/2026')).toBeNull();
    expect(lerDia('')).toBeNull();
  });

  it('formata para pt-BR dd/mm/aaaa', () => {
    expect(formatarDiaBR('2026-10-08')).toBe('08/10/2026');
    expect(formatarDiaBR(null)).toBe('');
  });

  it('virada de mês e de ano ao somar dias', () => {
    expect(somarDias('2026-01-31', 1)).toBe('2026-02-01');
    expect(somarDias('2026-12-31', 1)).toBe('2027-01-01');
    expect(somarDias('2027-01-01', -1)).toBe('2026-12-31');
    expect(somarDias('2026-03-01', -1)).toBe('2026-02-28'); // 2026 não é bissexto
    expect(somarDias('2028-03-01', -1)).toBe('2028-02-29'); // 2028 é bissexto
  });

  it('soma meses limitando ao último dia do mês de destino', () => {
    expect(somarMeses('2026-01-31', 1)).toBe('2026-02-28');
    expect(somarMeses('2026-10-08', -1)).toBe('2026-09-08');
    expect(somarMeses('2026-12-15', 1)).toBe('2027-01-15');
    expect(somarMeses('2026-01-15', -1)).toBe('2025-12-15');
  });

  it('dias do mês e dia da semana', () => {
    expect(diasNoMes(2026, 2)).toBe(28);
    expect(diasNoMes(2028, 2)).toBe(29);
    expect(diasNoMes(2026, 12)).toBe(31);
    expect(diaDaSemana('2026-10-08')).toBe(4); // quinta-feira
  });

  it('valida intervalo: datas invertidas, inválidas e ausentes', () => {
    expect(validarIntervalo('2026-10-01', '2026-10-31')).toBeNull();
    expect(validarIntervalo('2026-10-01', '2026-10-01')).toBeNull();
    expect(validarIntervalo('2026-10-31', '2026-10-01')).toMatch(/posterior/);
    expect(validarIntervalo('2026-02-30', '2026-03-01')).toMatch(/inicial inválida/);
    expect(validarIntervalo('', '2026-03-01')).toBeNull();
  });
});
