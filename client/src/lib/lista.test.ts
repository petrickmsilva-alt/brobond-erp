// ============================================================================
// Configuração da listagem — colunas, densidade e chips de filtros ativos.
// ============================================================================
import { beforeEach, describe, expect, it } from 'vitest';
import type { Field } from './meta';
import {
  CAMPO_ESTOQUE,
  camposDoCard,
  camposOrdenados,
  chipsDeFiltros,
  DENSIDADE_INFO,
  densidadeLegada,
  larguraDaColuna,
  rotuloDaColuna,
  saldoDaLinha,
  usaColunaEstoque,
} from './lista';

const campo = (name: string, extra: Partial<Field> = {}): Field => ({ name, label: name, type: 'text', ...extra });

describe('ordem e rótulos das colunas de produtos', () => {
  const campos = [
    campo('ativo', { label: 'Ativo', type: 'boolean' }),
    campo('custo', { label: 'Custo unitário', type: 'money' }),
    campo('sku', { label: 'SKU / Referência' }),
    campo('formato', { label: 'Formato', type: 'select' }),
    campo('nome', { label: 'Nome' }),
    campo('preco_venda', { label: 'Preço de venda (varejo)', type: 'money' }),
    campo('categoria_id', { label: 'Categoria', type: 'ref' }),
    campo('colecao_id', { label: 'Coleção', type: 'ref' }),
    campo('cor_id', { label: 'Cor (cadastro)', type: 'ref' }),
    campo('grade_id', { label: 'Grade de tamanhos', type: 'ref' }),
    CAMPO_ESTOQUE,
  ];

  it('coloca as colunas prioritárias primeiro, na ordem do domínio', () => {
    const ordem = camposOrdenados(campos, 'produtos').map((f) => f.name);
    expect(ordem.slice(0, 9)).toEqual([
      'nome',
      'sku',
      'categoria_id',
      'colecao_id',
      'cor_id',
      'grade_id',
      'preco_venda',
      'estoque',
      'formato',
    ]);
    // O que não é prioritário continua depois, na ordem original.
    expect(ordem.slice(9)).toEqual(['custo', 'ativo']);
  });

  it('não muta a lista recebida', () => {
    const antes = campos.map((f) => f.name);
    camposOrdenados(campos, 'produtos');
    expect(campos.map((f) => f.name)).toEqual(antes);
  });

  it('usa o rótulo de apresentação sem trocar o nome do campo (sort/API intactos)', () => {
    const nome = campos.find((f) => f.name === 'nome')!;
    const ativo = campos.find((f) => f.name === 'ativo')!;
    expect(rotuloDaColuna(nome, 'produtos')).toBe('Produto');
    expect(rotuloDaColuna(ativo, 'produtos')).toBe('Status');
    expect(nome.name).toBe('nome');
    expect(ativo.name).toBe('ativo');
  });

  it('recursos sem configuração mantêm o rótulo e a largura padrão', () => {
    expect(rotuloDaColuna(campo('nome', { label: 'Nome' }), 'clientes')).toBe('Nome');
    expect(larguraDaColuna(campo('nome'), 'clientes').min).toBe('min-w-[120px]');
    expect(larguraDaColuna(campo('nome'), 'produtos').min).toBe('min-w-[240px]');
  });

  it('modo visual mostra os campos do cartão na ordem configurada', () => {
    const card = camposDoCard(campos, 'produtos').map((f) => f.name);
    expect(card).toEqual(['sku', 'categoria_id', 'cor_id', 'colecao_id', 'grade_id', 'preco_venda', 'estoque', 'ativo']);
  });

  it('a coluna de estoque é exclusiva de produtos', () => {
    expect(usaColunaEstoque('produtos')).toBe(true);
    expect(usaColunaEstoque('clientes')).toBe(false);
  });
});

describe('densidade', () => {
  it('as três densidades têm miniaturas de 48/56/64 px', () => {
    expect(DENSIDADE_INFO.compacta.thumb).toBe(48);
    expect(DENSIDADE_INFO.normal.thumb).toBe(56);
    expect(DENSIDADE_INFO.confortavel.thumb).toBe(64);
  });

  beforeEach(() => localStorage.clear());

  it('migra a preferência antiga "tabela compacta"', () => {
    localStorage.setItem('brobond_tabela_compacta', '1');
    expect(densidadeLegada()).toBe('compacta');
    localStorage.setItem('brobond_tabela_compacta', '0');
    expect(densidadeLegada()).toBe('normal');
  });

  it('sem preferência antiga não força densidade', () => {
    expect(densidadeLegada()).toBeNull();
  });
});

describe('estoque lido do payload', () => {
  it('não inventa saldo quando a listagem não traz estoque', () => {
    expect(saldoDaLinha({ id: 1, sku: 'CAM-001' })).toBeNull();
    expect(saldoDaLinha({ id: 1, estoque: '' })).toBeNull();
  });

  it('usa o saldo quando o payload já o traz', () => {
    expect(saldoDaLinha({ estoque: 12 })).toBe(12);
    expect(saldoDaLinha({ estoque_total: '7' })).toBe(7);
  });
});

describe('chips de filtros ativos', () => {
  const campos: Field[] = [
    campo('categoria_id', { label: 'Categoria', type: 'ref', ref: 'categorias' }),
    campo('formato', { label: 'Formato', type: 'select', options: [{ value: 'simples', label: 'Simples' }, { value: 'variacao', label: 'Com variação' }] }),
    campo('ativo', { label: 'Ativo', type: 'boolean' }),
    campo('preco_venda', { label: 'Preço de venda (varejo)', type: 'money' }),
    campo('data', { label: 'Data', type: 'date' }),
  ];
  const opcoes = { categorias: [{ value: 1, label: 'Camisetas' }] };

  it('não gera chip quando nada está preenchido', () => {
    expect(chipsDeFiltros(campos, {})).toEqual([]);
    expect(chipsDeFiltros(campos, { categoria_id: '', formato: '' })).toEqual([]);
  });

  it('faixa de preço vira UM chip (mínimo e máximo juntos)', () => {
    const chips = chipsDeFiltros(campos, { preco_venda_min: '200', preco_venda_max: '600' });
    expect(chips).toHaveLength(1);
    expect(chips[0].chaves).toEqual(['preco_venda_min', 'preco_venda_max']);
    expect(chips[0].rotulo).toBe('Preço de venda (varejo)');
    expect(chips[0].valor).toContain('200');
    expect(chips[0].valor).toContain('600');
  });

  it('faixa de datas vira um chip e pode ser parcial', () => {
    const chips = chipsDeFiltros(campos, { data_de: '2026-01-05' });
    expect(chips).toHaveLength(1);
    expect(chips[0].chaves).toEqual(['data_de']);
    expect(chips[0].valor).toBe('de 05/01/2026 sem fim');
  });

  it('traduz referência, lista e booleano para o rótulo que o usuário vê', () => {
    const chips = chipsDeFiltros(campos, { categoria_id: '1', formato: 'variacao', ativo: 'false' }, opcoes);
    expect(chips.map((c) => `${c.rotulo}: ${c.valor}`)).toEqual([
      'Categoria: Camisetas',
      'Formato: Com variação',
      'Ativo: Não',
    ]);
    expect(chips.map((c) => c.chaves)).toEqual([['categoria_id'], ['formato'], ['ativo']]);
  });

  it('referência desconhecida não vira texto vazio', () => {
    const chips = chipsDeFiltros(campos, { categoria_id: '9' }, {});
    expect(chips[0].valor).toBe('#9');
  });
});
