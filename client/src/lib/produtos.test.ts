// ============================================================================
// PRODUTOS — máscara, normalização e validação dos campos do cadastro.
//
// Trava o contrato campo a campo: o que é formato conhecido tem formato
// conhecido, e o que é texto livre continua texto livre. As regras espelham o
// servidor (resources.produtos + validate.ts).
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  erroCest,
  erroCfop,
  erroCodigoBarras,
  erroEstoqueMax,
  erroGtinTributario,
  erroNcm,
  erroNome,
  erroSku,
  normalizarCest,
  normalizarCodigoBarras,
  normalizarNcm,
  normalizarPayloadProduto,
  normalizarSku,
  normalizarTags,
} from './produtos';

describe('SKU — chave do domínio', () => {
  it('preserva a caixa e os separadores, removendo só espaço acidental', () => {
    expect(normalizarSku('  cam-001  ')).toBe('cam-001');
    expect(normalizarSku('CAM   001')).toBe('CAM 001');
    expect(normalizarSku('REF/2026-X')).toBe('REF/2026-X');
  });

  it('exige valor e respeita o limite de 40 caracteres', () => {
    expect(erroSku('')).toMatch(/Informe o SKU/);
    expect(erroSku('   ')).toMatch(/Informe o SKU/);
    expect(erroSku('CAM-001')).toBeNull();
    expect(erroSku('X'.repeat(41))).toMatch(/Máximo de 40/);
  });
});

describe('nome — texto livre com limite', () => {
  it('exige valor e respeita 120 caracteres', () => {
    expect(erroNome('')).toMatch(/Informe o nome/);
    expect(erroNome('Camiseta Polo')).toBeNull();
    expect(erroNome('X'.repeat(121))).toMatch(/Máximo de 120/);
  });
});

describe('código de barras (EAN/GTIN)', () => {
  it('aceita 8, 12, 13 e 14 dígitos e ignora separadores digitados', () => {
    expect(normalizarCodigoBarras('789-1234')).toBe('7891234');
    expect(erroCodigoBarras('78912345')).toBeNull();
    expect(erroCodigoBarras('789123456789')).toBeNull();
    expect(erroCodigoBarras('7891234567890')).toBeNull();
    expect(erroCodigoBarras('78912345678901')).toBeNull();
  });

  it('recusa quantidade de dígitos que o domínio não suporta', () => {
    expect(erroCodigoBarras('1234567')).toMatch(/8, 12, 13 ou 14/);
    expect(erroCodigoBarras('123456789')).toMatch(/8, 12, 13 ou 14/);
  });

  it('vazio é permitido — o EAN é opcional', () => {
    expect(erroCodigoBarras('')).toBeNull();
  });
});

describe('NCM — 8 dígitos, exibido pontuado', () => {
  it('formata 62052000 como 6205.20.00 (formato do domínio)', () => {
    expect(normalizarNcm('62052000')).toBe('6205.20.00');
    expect(normalizarNcm('6205.20.00')).toBe('6205.20.00');
    expect(erroNcm('6205.20.00')).toBeNull();
  });

  it('recusa NCM incompleto', () => {
    expect(erroNcm('620520')).toMatch(/8 dígitos/);
  });

  it('vazio é permitido', () => {
    expect(erroNcm('')).toBeNull();
  });
});

describe('CEST — 7 dígitos, exibido pontuado', () => {
  it('formata 2803800 como 28.038.00', () => {
    expect(normalizarCest('2803800')).toBe('28.038.00');
    expect(erroCest('28.038.00')).toBeNull();
  });

  it('recusa CEST incompleto', () => {
    expect(erroCest('280380')).toMatch(/7 dígitos/);
  });
});

describe('CFOP e GTIN tributário', () => {
  it('CFOP tem exatamente 4 dígitos (ou vazio)', () => {
    expect(erroCfop('5102')).toBeNull();
    expect(erroCfop('')).toBeNull();
    expect(erroCfop('510')).toMatch(/4 dígitos/);
  });

  it('GTIN tributário segue a família do código de barras', () => {
    expect(erroGtinTributario('7891234567890')).toBeNull();
    expect(erroGtinTributario('')).toBeNull();
    expect(erroGtinTributario('123')).toMatch(/8, 12, 13 ou 14/);
  });
});

describe('estoque máximo x mínimo', () => {
  it('não pode ficar abaixo do mínimo (mesma CHECK do banco)', () => {
    expect(erroEstoqueMax('10', '5')).toMatch(/maior ou igual/);
    expect(erroEstoqueMax('10', '10')).toBeNull();
    expect(erroEstoqueMax('10', '20')).toBeNull();
    expect(erroEstoqueMax('10', '')).toBeNull();
  });
});

describe('tags — lista normalizada', () => {
  it('remove espaços nas pontas e vazios, mantendo a ordem', () => {
    expect(normalizarTags(' verão , básico ,, promoção ')).toBe('verão, básico, promoção');
    expect(normalizarTags('')).toBe('');
  });
});

describe('payload — formatos canônicos antes de enviar', () => {
  it('normaliza os campos de formato conhecido e zera vazios', () => {
    const out = normalizarPayloadProduto({
      sku: ' cam-001 ',
      codigo_barras: '789-1234-567890',
      ncm: '62052000',
      cest: '2803800',
      cfop_saida: '5102',
      gtin_tributario: '',
      tags: 'verão,básico',
      nome: 'Camiseta Polo',
    });
    expect(out.sku).toBe('cam-001');
    expect(out.codigo_barras).toBe('7891234567890');
    expect(out.ncm).toBe('6205.20.00');
    expect(out.cest).toBe('28.038.00');
    expect(out.cfop_saida).toBe('5102');
    expect(out.gtin_tributario).toBeNull();
    expect(out.tags).toBe('verão, básico');
    // Texto livre não é mexido.
    expect(out.nome).toBe('Camiseta Polo');
  });

  it('vazio em campo formatado vira null, não string vazia', () => {
    const out = normalizarPayloadProduto({ codigo_barras: '', ncm: '', cest: '', cfop_saida: '', tags: '' });
    expect(out.codigo_barras).toBeNull();
    expect(out.ncm).toBeNull();
    expect(out.cest).toBeNull();
    expect(out.cfop_saida).toBeNull();
    expect(out.tags).toBeNull();
  });
});
