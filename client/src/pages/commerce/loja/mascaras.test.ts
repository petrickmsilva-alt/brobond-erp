import { describe, expect, it } from 'vitest';
import { cpfValido, mascararCEP, mascararCPF, mascararTelefoneBR, normalizarEmail, normalizarNome, normalizarUF, soDigitos, telefoneBRCompleto } from './mascaras';

describe('Máscaras do checkout (apresentação; backend persiste dígitos)', () => {
  it('WhatsApp/telefone: (62) 99999-9999, aceita colar com +55', () => {
    expect(mascararTelefoneBR('62999990000')).toBe('(62) 99999-0000');
    expect(mascararTelefoneBR('6233334444')).toBe('(62) 3333-4444');
    expect(mascararTelefoneBR('+55 (62) 99999-0000')).toBe('(62) 99999-0000');
    expect(mascararTelefoneBR('6')).toBe('(6');
    expect(mascararTelefoneBR('629')).toBe('(62) 9');
    expect(soDigitos('(62) 99999-0000')).toBe('62999990000');
    expect(telefoneBRCompleto('(62) 99999-0000')).toBe(true);
    expect(telefoneBRCompleto('(62) 9999')).toBe(false);
  });

  it('CPF: máscara, 11 dígitos e dígitos verificadores', () => {
    expect(mascararCPF('52998224725')).toBe('529.982.247-25');
    expect(mascararCPF('5299')).toBe('529.9');
    expect(cpfValido('529.982.247-25')).toBe(true);
    expect(cpfValido('12345678909')).toBe(true);
    expect(cpfValido('529.982.247-26')).toBe(false);
    expect(cpfValido('111.111.111-11')).toBe(false);
    expect(cpfValido('5299822472')).toBe(false);
  });

  it('CEP 74000-000 exibido, 8 dígitos persistidos; UF maiúscula', () => {
    expect(mascararCEP('74000000')).toBe('74000-000');
    expect(mascararCEP('74000-0001')).toBe('74000-000');
    expect(soDigitos(mascararCEP('74000-000'))).toBe('74000000');
    expect(normalizarUF('go')).toBe('GO');
    expect(normalizarUF('g1o2x')).toBe('GO');
  });

  it('nome sem espaços extras; e-mail minúsculo e sem espaços', () => {
    expect(normalizarNome('  Maria   da  Silva ')).toBe('Maria da Silva');
    expect(normalizarEmail('  Maria@Example.COM ')).toBe('maria@example.com');
  });
});
