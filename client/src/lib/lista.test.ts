// ============================================================================
// Configuração da listagem — colunas, densidade e chips de filtros ativos.
// ============================================================================
import { beforeEach, describe, expect, it } from 'vitest';
import type { Field } from './meta';
import {
  CAMPO_ESTOQUE,
  CAMPO_ID,
  CAMPO_MEDIDAS,
  CAMPO_USO,
  camposDoCard,
  camposOrdenados,
  chipsDeFiltros,
  DENSIDADE_INFO,
  densidadeLegada,
  descricaoDoCadastro,
  larguraDaColuna,
  permiteAlternarAtivo,
  placeholderBusca,
  rotuloDaColuna,
  rotuloEditar,
  rotuloNovo,
  rotuloSalvar,
  ROTULO_STATUS_MEDIDAS,
  saldoDaLinha,
  statusMedidasDaLinha,
  temUtilizacao,
  textoContagem,
  textoVazio,
  usaColunaEstoque,
  usaColunaMedidas,
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

describe('apresentação da listagem de categorias', () => {
  const campos: Field[] = [
    campo('ativo', { label: 'Ativo', type: 'boolean' }),
    campo('nome', { label: 'Nome' }),
    campo('descricao', { label: 'Descrição' }),
    campo('grade_id', { label: 'Grade padrão', type: 'ref', ref: 'grades' }),
  ];

  it('ordena as colunas como Categoria, Descrição, Grade padrão e Status', () => {
    expect(camposOrdenados(campos, 'categorias').map((f) => f.name)).toEqual([
      'nome',
      'descricao',
      'grade_id',
      'ativo',
    ]);
  });

  it('usa os rótulos de apresentação sem trocar o nome do campo (sort/API intactos)', () => {
    const nome = campos.find((f) => f.name === 'nome')!;
    const ativo = campos.find((f) => f.name === 'ativo')!;
    const grade = campos.find((f) => f.name === 'grade_id')!;
    expect(rotuloDaColuna(nome, 'categorias')).toBe('Categoria');
    expect(rotuloDaColuna(ativo, 'categorias')).toBe('Status');
    expect(rotuloDaColuna(grade, 'categorias')).toBe('Grade padrão');
    expect(nome.name).toBe('nome');
  });

  it('busca, botão de inclusão e estado vazio seguem a linguagem do cadastro', () => {
    expect(placeholderBusca('categorias', 'Categorias')).toBe('Buscar categoria...');
    expect(rotuloNovo('categorias', 'Categoria')).toBe('Nova categoria');
    expect(textoVazio('categorias', 'Categoria')).toEqual({
      titulo: 'Nenhuma categoria cadastrada',
      descricao: 'Cadastre sua primeira categoria para organizar seus produtos.',
    });
  });

  it('recursos sem configuração mantêm o texto genérico', () => {
    expect(placeholderBusca('clientes', 'Clientes')).toBe('Buscar em Clientes...');
    expect(rotuloNovo('clientes', 'Cliente')).toBe('Novo cliente');
    expect(textoVazio('clientes', 'Cliente').titulo).toBe('Nenhum(a) cliente cadastrado(a)');
  });

  it('só categorias declaram a ação Ativar/Desativar na linha', () => {
    expect(permiteAlternarAtivo('categorias')).toBe(true);
    expect(permiteAlternarAtivo('produtos')).toBe(false);
    expect(permiteAlternarAtivo('clientes')).toBe(false);
  });

  it('o contador usa o substantivo do cadastro (e o genérico nos demais)', () => {
    expect(textoContagem('categorias', 1, 3, 3)).toBe('1–3 de 3 categorias');
    expect(textoContagem('categorias', 1, 1, 1)).toBe('1–1 de 1 categoria');
    expect(textoContagem('categorias', 0, 0, 0)).toBe('Nenhum registro');
    expect(textoContagem('produtos', 1, 25, 1248)).toBe('1–25 de 1248 registros');
  });

  it('o modo visual da categoria traz descrição, grade e status', () => {
    expect(camposDoCard(campos, 'categorias').map((f) => f.name)).toEqual(['descricao', 'grade_id', 'ativo']);
  });
});

describe('apresentação da listagem de grades', () => {
  const campos = [
    campo('ativo', { label: 'Ativo', type: 'boolean' }),
    campo('descricao', { label: 'Descrição' }),
    campo('instrucoes_medidas', { label: 'Instruções de medição', type: 'textarea', list: false }),
    campo('nome', { label: 'Nome' }),
    campo('tamanhos', { label: 'Tamanhos', type: 'multiref', ref: 'tamanhos', virtual: true, list: true }),
    CAMPO_USO,
    CAMPO_MEDIDAS,
    CAMPO_ID,
  ];

  // A ModulePage já descarta o que não é de lista (`instrucoes_medidas` vive na
  // página da grade, não na tabela) — aqui entra o mesmo recorte.
  const visiveis = campos.filter((f) => f.list !== false);

  it('ordena as colunas como # · Grade · Tamanhos · Medidas · Status · Utilização · Descrição', () => {
    expect(visiveis.map((f) => f.name)).not.toContain('instrucoes_medidas');
    expect(camposOrdenados(visiveis, 'grades').map((f) => f.name)).toEqual([
      'id',
      'nome',
      'tamanhos',
      'medidas_status',
      'ativo',
      'uso_vinculado',
      'descricao',
    ]);
  });

  it('usa os rótulos de apresentação sem trocar o nome do campo (sort/API intactos)', () => {
    expect(camposOrdenados(visiveis, 'grades').map((f) => rotuloDaColuna(f, 'grades'))).toEqual([
      '#',
      'Grade',
      'Tamanhos',
      'Medidas',
      'Status',
      'Utilização',
      'Descrição',
    ]);
    // O campo continua se chamando como no servidor: a coluna sintética de
    // medidas é `medidas_status`, nunca um campo novo em `grades`.
    expect(rotuloDaColuna(CAMPO_MEDIDAS, 'grades')).toBe('Medidas');
    expect(CAMPO_MEDIDAS.name).toBe('medidas_status');
    expect(CAMPO_MEDIDAS.form).toBe(false);
  });

  it('busca, títulos das páginas e estado vazio seguem a linguagem do cadastro', () => {
    expect(placeholderBusca('grades', 'Grades')).toBe('Buscar grade...');
    expect(rotuloNovo('grades', 'Grade')).toBe('Nova grade');
    expect(rotuloEditar('grades', 'Grade')).toBe('Editar grade');
    expect(rotuloSalvar('grades')).toBe('Salvar grade');
    expect(descricaoDoCadastro('grades')).toBe(
      'Configure uma grade de tamanhos para utilização no catálogo de produtos.'
    );
    expect(textoVazio('grades', 'Grade')).toEqual({
      titulo: 'Nenhuma grade cadastrada',
      descricao: 'Cadastre a primeira grade de tamanhos para organizar o estoque dos produtos.',
    });
    expect(textoContagem('grades', 1, 4, 4)).toBe('1–4 de 4 grades');
    expect(textoContagem('grades', 1, 1, 1)).toBe('1–1 de 1 grade');
  });

  it('a grade pode ser desativada na linha (nunca excluída à força)', () => {
    expect(permiteAlternarAtivo('grades')).toBe(true);
  });

  it('o modo visual da grade traz tamanhos, medidas, status e utilização', () => {
    expect(camposDoCard(campos, 'grades').map((f) => f.name)).toEqual([
      'tamanhos',
      'medidas_status',
      'ativo',
      'uso_vinculado',
    ]);
  });

  it('a coluna de MEDIDAS é exclusiva das grades', () => {
    expect(usaColunaMedidas('grades')).toBe(true);
    for (const recurso of ['produtos', 'categorias', 'cores', 'clientes']) {
      expect(usaColunaMedidas(recurso)).toBe(false);
    }
  });

  it('lê o estado da tabela de medidas do payload — e não inventa quando ele não vem', () => {
    expect(statusMedidasDaLinha({ medidas_status: 'sem_tabela' })).toBe('sem_tabela');
    expect(statusMedidasDaLinha({ medidas_status: 'parcial' })).toBe('parcial');
    expect(statusMedidasDaLinha({ medidas_status: 'completa' })).toBe('completa');
    expect(statusMedidasDaLinha({})).toBeNull();
    expect(statusMedidasDaLinha({ medidas_status: 'outra_coisa' })).toBeNull();
    expect(ROTULO_STATUS_MEDIDAS.parcial).toBe('Parcial');
  });

  it('utilização só existe quando há produtos OU categorias vinculadas', () => {
    expect(temUtilizacao({ uso_vinculado: 18, uso_categorias: 2 })).toBe(true);
    expect(temUtilizacao({ uso_vinculado: 0, uso_categorias: 1 })).toBe(true);
    expect(temUtilizacao({ uso_vinculado: 7, uso_categorias: 0 })).toBe(true);
    expect(temUtilizacao({ uso_vinculado: 0, uso_categorias: 0 })).toBe(false);
    expect(temUtilizacao({})).toBe(false);
  });
});

// ============================================================================
// REPRESENTANTES — configuração da listagem (padrão LISTA → PÁGINA).
//
// O cadastro é o MESMO usado nas vendas, propostas e comissões: a config só
// apresenta o que existe de verdade (nome, cpf, cargo, regiao, comissao_pct,
// usuario_id, contato, ativo e a utilização agregada pelo servidor).
// ============================================================================
describe('representantes — configuração da listagem', () => {
  // Campos do CADASTRO MESTRE 2.0 (schema.sql + migration 0048). `documento`,
  // `equipe_label` e `contato` são colunas de APRESENTAÇÃO (virtual) montadas
  // com o que a API já devolveu na linha; `uso_vinculado` é anotado no
  // servidor em lote. Nenhum campo inventado.
  const campos: Field[] = [
    campo('codigo', { label: 'Código' }),
    campo('nome', { label: 'Nome', section: 'Identificação' }),
    campo('documento', { label: 'CPF/CNPJ', type: 'document', virtual: true }),
    campo('tipo_representante', { label: 'Tipo', type: 'select' }),
    campo('cargo', { label: 'Cargo' }),
    campo('territorio_id', { label: 'Território', type: 'ref', ref: 'territorios' }),
    campo('equipe_label', { label: 'Equipe', virtual: true }),
    campo('comissao_pct', { label: 'Comissão padrão (%)', type: 'percent', section: 'Comercial' }),
    campo('usuario_id', { label: 'Usuário do sistema', type: 'ref', ref: 'usuarios' }),
    campo('contato', { label: 'Contato', virtual: true }),
    campo('carteira_vinculos', { label: 'Carteira', type: 'integer', virtual: true }),
    campo('ativo', { label: 'Ativo', type: 'boolean' }),
    campo('uso_vinculado', { label: 'Utilização', type: 'integer', virtual: true }),
  ];

  it('ordena as colunas do domínio e usa os rótulos de apresentação', () => {
    const ordem = camposOrdenados(campos, 'representantes').map((f) => f.name);
    expect(ordem).toEqual([
      'codigo',
      'nome',
      'documento',
      'tipo_representante',
      'cargo',
      'territorio_id',
      'equipe_label',
      'comissao_pct',
      'usuario_id',
      'contato',
      'carteira_vinculos',
      'ativo',
      'uso_vinculado',
    ]);
    expect(rotuloDaColuna(campos[1], 'representantes')).toBe('Representante');
    expect(rotuloDaColuna(campos[2], 'representantes')).toBe('CPF/CNPJ');
    expect(rotuloDaColuna(campos[11], 'representantes')).toBe('Status');
    expect(larguraDaColuna(campos[1], 'representantes').min).toBe('min-w-[190px]');
  });

  it('o cartão mostra o essencial do representante, sem campo inventado', () => {
    expect(camposDoCard(campos, 'representantes').map((f) => f.name)).toEqual([
      'codigo',
      'documento',
      'tipo_representante',
      'cargo',
      'territorio_id',
      'equipe_label',
      'comissao_pct',
      'contato',
      'carteira_vinculos',
      'ativo',
    ]);
  });

  it('textos do cadastro são os do domínio (novo/editar/salvar/vazio/contagem)', () => {
    expect(rotuloNovo('representantes', 'Representante')).toBe('Novo representante');
    expect(rotuloEditar('representantes', 'Representante')).toBe('Editar representante');
    expect(rotuloSalvar('representantes')).toBe('Salvar representante');
    // A descrição fala do que o CADASTRO guarda e devolve EQUIPE, CARTEIRA,
    // METAS e COMISSÃO aos domínios próprios (sem segunda estrutura).
    expect(descricaoDoCadastro('representantes')).toMatch(/código, PF\/PJ, CPF\/CNPJ/);
    expect(descricaoDoCadastro('representantes')).toMatch(/Equipe, carteira, metas e comissão vivem nos próprios domínios/);
    expect(placeholderBusca('representantes', 'Representantes')).toMatch(/CPF\/CNPJ/);
    expect(textoVazio('representantes', 'Representante')).toEqual({
      titulo: 'Nenhum representante cadastrado',
      descricao: 'Cadastre o primeiro representante para vincular vendas, clientes, metas e comissões.',
    });
    expect(textoContagem('representantes', 1, 3, 3)).toBe('1–3 de 3 representantes');
    expect(textoContagem('representantes', 0, 0, 0)).toBe('Nenhum registro');
  });

  it('a linha oferece Ativar/Desativar e a utilização vem do servidor', () => {
    expect(permiteAlternarAtivo('representantes')).toBe(true);
    expect(permiteAlternarAtivo('clientes')).toBe(false);
    expect(temUtilizacao({ uso_vinculado: 12, uso_vinculado_label: '12 vendas' })).toBe(true);
    expect(temUtilizacao({ uso_vinculado: 0 })).toBe(false);
    expect(CAMPO_USO.label).toBe('Utilização');
  });
});
