// ============================================================================
// Máscaras e normalização brasileiras — contrato do cadastro de clientes.
//
// Cada campo tem 3 camadas: máscara (maskX), validação (xValido/erroX) e
// normalização de envio (normalizeX). Estes testes travam o formato exato
// pedido no spec: CPF 000.000.000-00, CNPJ 00.000.000/0000-00, celular
// +55 (62) 99999-9999, fixo +55 (62) 3333-4444, CEP 00000-000, moeda R$ 1.500,00.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  cpfValido,
  cnpjValido,
  erroTelefone,
  formatDocumento,
  formatPhone,
  maskCep,
  maskCnpj,
  maskCpf,
  maskDocumentoTipo,
  maskMoneyInput,
  maskPhone,
  normalizePhone,
  parseMoneyInput,
  soDigitos,
  UFS_BRASIL,
} from './format';

describe('CPF', () => {
  it('mascara 000.000.000-00 enquanto digita', () => {
    expect(maskCpf('52998224725')).toBe('529.982.247-25');
    expect(maskCpf('52998')).toBe('529.98');
    // remascara o que já veio com pontuação
    expect(maskCpf('529.982.247-25')).toBe('529.982.247-25');
    // trunca em 11 dígitos
    expect(maskCpf('529982247259999')).toBe('529.982.247-25');
    expect(maskCpf('')).toBe('');
  });

  it('valida dígito verificador e rejeita sequências', () => {
    expect(cpfValido('52998224725')).toBe(true);
    // com máscara conta igual
    expect(cpfValido('529.982.247-25')).toBe(true);
    // dígito verificador errado
    expect(cpfValido('52998224726')).toBe(false);
    expect(cpfValido('00000000000')).toBe(false);
    expect(cpfValido('11111111111')).toBe(false);
    // 10 dígitos
    expect(cpfValido('1234567890')).toBe(false);
    expect(cpfValido('')).toBe(false);
  });

  it('formata para exibição a partir dos dígitos', () => {
    expect(formatDocumento('52998224725')).toBe('529.982.247-25');
  });
});

describe('CNPJ', () => {
  it('mascara 00.000.000/0000-00 enquanto digita', () => {
    expect(maskCnpj('11222333000181')).toBe('11.222.333/0001-81');
    expect(maskCnpj('11222')).toBe('11.222');
    expect(maskCnpj('11.222.333/0001-81')).toBe('11.222.333/0001-81');
    // trunca em 14 dígitos
    expect(maskCnpj('11222333000181999')).toBe('11.222.333/0001-81');
  });

  it('valida dígito verificador e rejeita sequências', () => {
    expect(cnpjValido('11222333000181')).toBe(true);
    expect(cnpjValido('11.222.333/0001-81')).toBe(true);
    // dígito verificador errado
    expect(cnpjValido('11222333000182')).toBe(false);
    expect(cnpjValido('00000000000000')).toBe(false);
    // 13 dígitos
    expect(cnpjValido('1122233300018')).toBe(false);
  });

  it('formata para exibição a partir dos dígitos', () => {
    expect(formatDocumento('11222333000181')).toBe('11.222.333/0001-81');
  });
});

describe('máscara por tipo de pessoa (nunca CPF e CNPJ juntos)', () => {
  it('PF só aceita 11 dígitos, PJ só 14', () => {
    expect(maskDocumentoTipo('52998224725', 'pf')).toBe('529.982.247-25');
    // trunca no CPF
    expect(maskDocumentoTipo('52998224725999', 'pf')).toBe('529.982.247-25');
    expect(maskDocumentoTipo('11222333000181', 'pj')).toBe('11.222.333/0001-81');
    // trunca no CNPJ
    expect(maskDocumentoTipo('112223330001819999', 'pj')).toBe('11.222.333/0001-81');
    expect(maskDocumentoTipo('123', 'estrangeiro')).toBe('123');
  });
});

describe('telefone', () => {
  it('mascara celular +55 (62) 99999-9999', () => {
    expect(maskPhone('62999999999')).toBe('+55 (62) 99999-9999');
    expect(maskPhone('629999')).toBe('+55 (62) 9999');
    expect(maskPhone('6299999')).toBe('+55 (62) 99999');
    expect(maskPhone('+55 (62) 99999-9999')).toBe('+55 (62) 99999-9999');
    // com DDI 55 cai no formato local
    expect(maskPhone('5562999999999')).toBe('+55 (62) 99999-9999');
  });

  it('mascara fixo +55 (62) 3333-4444 (adaptativo pelo primeiro dígito)', () => {
    expect(maskPhone('6233334444')).toBe('+55 (62) 3333-4444');
    expect(maskPhone('62 3333-4444')).toBe('+55 (62) 3333-4444');
    expect(maskPhone('623333')).toBe('+55 (62) 3333');
  });

  it('deixa telefone internacional com +DDI relativamente livre', () => {
    expect(maskPhone('+351912345678')).toBe('+351912345678');
  });

  it('normaliza para DDD+número (sem máscara) antes de enviar', () => {
    expect(normalizePhone('+55 (62) 99999-9999')).toBe('62999999999');
    expect(normalizePhone('(62) 99999-9999')).toBe('62999999999');
    expect(normalizePhone('62999999999')).toBe('62999999999');
    expect(normalizePhone('55 62 99999 9999')).toBe('62999999999');
    expect(normalizePhone('+55 (62) 3333-4444')).toBe('6233334444');
    // internacional guarda dígitos com DDI
    expect(normalizePhone('+351 912 345 678')).toBe('351912345678');
    expect(normalizePhone('')).toBe(null);
  });

  it('valida DDD, tamanho e início do número', () => {
    // fixo válido
    expect(erroTelefone('62 3333-4444')).toBe(null);
    // celular válido
    expect(erroTelefone('62 99999-9999')).toBe(null);
    expect(erroTelefone('abc')).not.toBe(null);
    // DDD 00 não existe
    expect(erroTelefone('(00) 99999-9999')).not.toBe(null);
    // celular começa com 9
    expect(erroTelefone('62 89999-9999')).not.toBe(null);
    // fixo não começa com 9
    expect(erroTelefone('62 9333-4444')).not.toBe(null);
    // 9 dígitos não vale
    expect(erroTelefone('62 999-999')).not.toBe(null);
    // vazio é tratado pela obrigatoriedade
    expect(erroTelefone('')).toBe(null);
  });

  it('exibe no formato brasileiro a partir de qualquer armazenamento legado', () => {
    expect(formatPhone('62999999999')).toBe('+55 (62) 99999-9999');
    expect(formatPhone('6233334444')).toBe('+55 (62) 3333-4444');
    expect(formatPhone('(62) 99999-9999')).toBe('+55 (62) 99999-9999');
    expect(formatPhone('')).toBe('');
  });
});

describe('CEP', () => {
  it('mascara 00000-000 e normaliza para 8 dígitos', () => {
    expect(maskCep('74000000')).toBe('74000-000');
    expect(maskCep('74000')).toBe('74000');
    expect(maskCep('74000-000')).toBe('74000-000');
    // trunca em 8 dígitos
    expect(maskCep('74000000999')).toBe('74000-000');
    expect(soDigitos(maskCep('74000-000'))).toHaveLength(8);
  });
});

describe('moeda', () => {
  it('mascara 1.500,50 enquanto digita', () => {
    expect(maskMoneyInput('1500,5')).toBe('1.500,5');
    expect(maskMoneyInput('1500,50')).toBe('1.500,50');
    // sem vírgula, só agrupa milhar
    expect(maskMoneyInput('2599990')).toBe('2.599.990');
    expect(maskMoneyInput('25999,90')).toBe('25.999,90');
    expect(maskMoneyInput('0,00')).toBe('0,00');
    expect(maskMoneyInput('')).toBe('');
    // aceita colar com R$
    expect(maskMoneyInput('R$ 1.500,00')).toBe('1.500,00');
  });

  it('converte "1.500,50" → 1500.50 e "25.999,90" → 25999.9', () => {
    expect(parseMoneyInput('1.500,50')).toBe(1500.5);
    expect(parseMoneyInput('25.999,90')).toBe(25999.9);
    expect(parseMoneyInput('0,00')).toBe(0);
    expect(parseMoneyInput('R$ 1.500,00')).toBe(1500);
    expect(parseMoneyInput('1500.50')).toBe(1500.5);
    expect(parseMoneyInput('')).toBe(null);
    expect(parseMoneyInput('abc')).toBe(null);
    expect(parseMoneyInput(-5)).toBe(-5);
  });
});

describe('UF', () => {
  it('lista somente as 27 UFs oficiais', () => {
    expect(UFS_BRASIL).toHaveLength(27);
    for (const uf of ['AC', 'GO', 'SP', 'MG', 'RS', 'TO', 'DF']) {
      expect(UFS_BRASIL).toContain(uf);
    }
    expect(UFS_BRASIL).not.toContain('BR' as never);
  });
});
