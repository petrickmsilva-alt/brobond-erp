// ============================================================
// Definição dos recursos (módulos com cadastro) do BROBOND ERP.
//
// Este arquivo é a FONTE ÚNICA DE VERDADE para:
//   • validação dos dados recebidos pela API (validate.ts)
//   • montagem das consultas SQL (store.ts) — nomes de tabela/coluna
//     vêm SEMPRE daqui, nunca do input do usuário
//   • formulários e tabelas do front (via GET /api/meta)
//
// Para adicionar um campo em um módulo basta declará-lo aqui e criar a
// coluna no banco (db/schema.sql + migrate.ts).
// ============================================================

export type FieldType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'phone'
  | 'document' // CPF/CNPJ
  | 'integer'
  | 'number'
  | 'money'
  | 'percent'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'select'
  | 'ref' // chave estrangeira para outro recurso
  | 'password'
  | 'color' // cor em hexadecimal (#RRGGBB) — exibe uma "bolinha" colorida
  | 'images'; // galeria de fotos do registro (virtual — tabela `arquivos`)

export type Tone = 'green' | 'red' | 'amber' | 'blue' | 'slate';

export type FieldOption = { value: string; label: string; tone?: Tone };

export type Field = {
  name: string;
  label: string;
  type: FieldType;
  /** obrigatório em criação e edição */
  required?: boolean;
  /** obrigatório apenas na criação (ex.: senha) */
  requiredOnCreate?: boolean;
  /** valor único (usado para mensagens de erro amigáveis) */
  unique?: boolean;
  options?: FieldOption[];
  /** chave do recurso referenciado (type = 'ref') */
  ref?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  default?: unknown;
  /** aparece na tabela (padrão: true) */
  list?: boolean;
  /** aparece no formulário (padrão: true) */
  form?: boolean;
  /** exibido, mas não editável (ex.: criado_em) */
  readonly?: boolean;
  /** participa da busca textual */
  search?: boolean;
  /** não é coluna do banco (ex.: senha → senha_hash) */
  virtual?: boolean;
  hint?: string;
  placeholder?: string;
  /** ocupa a linha inteira no formulário */
  wide?: boolean;
  /** agrupa campos em uma seção do formulário (ex.: 'Fiscal') */
  section?: string;
  /** expressão regular (string) que o valor deve satisfazer */
  pattern?: string;
  /** mensagem quando `pattern` não é satisfeito */
  patternMessage?: string;
};

export type ResourceOps = { create: boolean; update: boolean; delete: boolean };

export type Resource = {
  key: string;
  table: string;
  label: string;
  singular: string;
  /** campos que identificam o registro (usado em selects e mensagens) */
  labelFields: string[];
  fields: Field[];
  orderBy?: { field: string; dir: 'asc' | 'desc' };
  ops: ResourceOps;
  adminOnly?: boolean;
  /** aviso exibido no topo do módulo */
  notice?: string;
  /** dados iniciais do modo demonstração (sem banco) */
  mock?: Record<string, unknown>[];
  /** recurso aceita fotos (galeria via tabela `arquivos`) */
  images?: { max: number };
  /** possui página de detalhe (/recurso/:id) */
  detail?: boolean;
  /** recurso interno: não aparece no menu nem na API genérica */
  internal?: boolean;
};

const ALL_OPS: ResourceOps = { create: true, update: true, delete: true };
const READ_ONLY: ResourceOps = { create: false, update: false, delete: false };

const ativo: Field = {
  name: 'ativo',
  label: 'Ativo',
  type: 'boolean',
  default: true,
};

const auditFields: Field[] = [
  { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true, list: false },
  { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true, list: false },
];

export const PERFIS: FieldOption[] = [
  { value: 'admin', label: 'Administrador', tone: 'amber' },
  { value: 'gerente', label: 'Gerente', tone: 'blue' },
  { value: 'operador', label: 'Operador', tone: 'slate' },
];

export const UNIDADES: FieldOption[] = [
  { value: 'un', label: 'Unidade (un)' },
  { value: 'pc', label: 'Peça (pç)' },
  { value: 'm', label: 'Metro (m)' },
  { value: 'cm', label: 'Centímetro (cm)' },
  { value: 'kg', label: 'Quilo (kg)' },
  { value: 'g', label: 'Grama (g)' },
  { value: 'l', label: 'Litro (l)' },
  { value: 'rl', label: 'Rolo (rl)' },
  { value: 'cx', label: 'Caixa (cx)' },
  { value: 'pct', label: 'Pacote (pct)' },
];

export const RESOURCES: Record<string, Resource> = {
  // ----------------------------------------------------------------
  // Interno — anexos (fotos). Manipulado por uploads.ts, não pela API genérica.
  // ----------------------------------------------------------------
  arquivos: {
    key: 'arquivos',
    table: 'arquivos',
    label: 'Arquivos',
    singular: 'Arquivo',
    labelFields: ['nome'],
    internal: true,
    ops: READ_ONLY,
    fields: [
      { name: 'recurso', label: 'Recurso', type: 'text' },
      { name: 'registro_id', label: 'Registro', type: 'integer' },
      { name: 'nome', label: 'Nome', type: 'text' },
      { name: 'mime', label: 'Tipo', type: 'text' },
      { name: 'tamanho_bytes', label: 'Tamanho', type: 'integer' },
      { name: 'url', label: 'URL', type: 'text' },
      { name: 'thumb_url', label: 'Miniatura', type: 'text' },
      { name: 'externo_id', label: 'ID externo', type: 'text' },
      { name: 'dados', label: 'Dados', type: 'text' },
      { name: 'thumb', label: 'Thumb', type: 'text' },
      { name: 'token', label: 'Token', type: 'text' },
      { name: 'principal', label: 'Principal', type: 'boolean', default: false },
      { name: 'ordem', label: 'Ordem', type: 'integer', default: 0 },
      { name: 'criado_por', label: 'Criado por', type: 'integer' },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true },
    ],
    orderBy: { field: 'ordem', dir: 'asc' },
  },

  // ----------------------------------------------------------------
  // Configurações
  // ----------------------------------------------------------------
  usuarios: {
    key: 'usuarios',
    table: 'usuarios',
    label: 'Usuários',
    singular: 'Usuário',
    labelFields: ['nome'],
    adminOnly: true,
    ops: ALL_OPS,
    notice:
      'Prefira desativar um usuário a excluí-lo: o histórico de auditoria permanece vinculado ao nome.',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, maxLength: 120 },
      { name: 'email', label: 'E-mail', type: 'email', required: true, unique: true, search: true, maxLength: 160, hint: 'Usado para entrar no sistema.' },
      { name: 'perfil', label: 'Perfil', type: 'select', required: true, options: PERFIS, default: 'operador', hint: 'Administrador: tudo. Gerente: tudo, exceto usuários. Operador: não exclui registros.' },
      { ...ativo, hint: 'Usuários inativos não conseguem entrar.' },
      { name: 'senha', label: 'Senha', type: 'password', virtual: true, requiredOnCreate: true, list: false, min: 6, hint: 'Mínimo de 6 caracteres. Ao editar, deixe em branco para manter a senha atual.' },
      { name: 'ultimo_login', label: 'Último acesso', type: 'datetime', readonly: true, form: false },
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
  },

  auditoria: {
    key: 'auditoria',
    table: 'auditoria',
    label: 'Auditoria',
    singular: 'Evento',
    labelFields: ['acao', 'recurso'],
    adminOnly: true,
    ops: READ_ONLY,
    notice: 'Registro automático de tudo que é incluído, alterado ou excluído no sistema, e de quem fez.',
    fields: [
      { name: 'data', label: 'Data/hora', type: 'datetime', readonly: true },
      { name: 'usuario', label: 'Usuário', type: 'text', readonly: true, search: true },
      {
        name: 'acao',
        label: 'Ação',
        type: 'select',
        readonly: true,
        options: [
          { value: 'criar', label: 'Inclusão', tone: 'green' },
          { value: 'editar', label: 'Alteração', tone: 'blue' },
          { value: 'excluir', label: 'Exclusão', tone: 'red' },
          { value: 'login', label: 'Login', tone: 'slate' },
          { value: 'senha', label: 'Troca de senha', tone: 'amber' },
        ],
      },
      { name: 'recurso', label: 'Módulo', type: 'text', readonly: true, search: true },
      { name: 'registro_id', label: 'Registro', type: 'integer', readonly: true },
      { name: 'descricao', label: 'Descrição', type: 'text', readonly: true, search: true, wide: true },
    ],
    orderBy: { field: 'data', dir: 'desc' },
  },

  // ----------------------------------------------------------------
  // Cadastros
  // ----------------------------------------------------------------
  tamanhos: {
    key: 'tamanhos',
    table: 'tamanhos',
    label: 'Tamanhos / Grade',
    singular: 'Tamanho',
    labelFields: ['codigo'],
    ops: ALL_OPS,
    fields: [
      { name: 'codigo', label: 'Código', type: 'text', required: true, unique: true, search: true, maxLength: 10, placeholder: 'PP, P, M, G, GG...' },
      { name: 'descricao', label: 'Descrição', type: 'text', search: true, maxLength: 60 },
      { name: 'ordem', label: 'Ordem na grade', type: 'integer', min: 0, default: 0, hint: 'Define a sequência (PP=1, P=2, M=3...).' },
      ...auditFields,
    ],
    orderBy: { field: 'ordem', dir: 'asc' },
    mock: [
      { id: 1, codigo: 'PP', descricao: 'Extra pequeno', ordem: 1 },
      { id: 2, codigo: 'P', descricao: 'Pequeno', ordem: 2 },
      { id: 3, codigo: 'M', descricao: 'Médio', ordem: 3 },
      { id: 4, codigo: 'G', descricao: 'Grande', ordem: 4 },
      { id: 5, codigo: 'GG', descricao: 'Extra grande', ordem: 5 },
    ],
  },

  colecoes: {
    key: 'colecoes',
    table: 'colecoes',
    label: 'Coleções',
    singular: 'Coleção',
    labelFields: ['nome'],
    ops: ALL_OPS,
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, maxLength: 80 },
      {
        name: 'temporada',
        label: 'Temporada',
        type: 'select',
        options: [
          { value: 'Verão', label: 'Verão' },
          { value: 'Outono', label: 'Outono' },
          { value: 'Inverno', label: 'Inverno' },
          { value: 'Primavera', label: 'Primavera' },
          { value: 'Atemporal', label: 'Atemporal' },
        ],
      },
      { name: 'ano', label: 'Ano', type: 'integer', min: 2000, max: 2100 },
      ...auditFields,
    ],
    orderBy: { field: 'ano', dir: 'desc' },
    mock: [{ id: 1, nome: 'Verão 2026', temporada: 'Verão', ano: 2026 }],
  },

  fornecedores: {
    key: 'fornecedores',
    table: 'fornecedores',
    label: 'Fornecedores',
    singular: 'Fornecedor',
    labelFields: ['nome'],
    ops: ALL_OPS,
    fields: [
      { name: 'nome', label: 'Razão social / Nome', type: 'text', required: true, search: true, maxLength: 160, wide: true },
      { name: 'cnpj', label: 'CNPJ', type: 'document', search: true, maxLength: 20 },
      { name: 'contato', label: 'Pessoa de contato', type: 'text', maxLength: 80 },
      { name: 'telefone', label: 'Telefone', type: 'phone', maxLength: 20 },
      { name: 'email', label: 'E-mail', type: 'email', maxLength: 160 },
      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
  },

  insumos: {
    key: 'insumos',
    table: 'insumos',
    label: 'Insumos',
    singular: 'Insumo',
    labelFields: ['nome'],
    ops: ALL_OPS,
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, maxLength: 120, wide: true },
      { name: 'unidade', label: 'Unidade', type: 'select', required: true, options: UNIDADES, default: 'un' },
      { name: 'custo_medio', label: 'Custo médio', type: 'money', min: 0, default: 0 },
      { name: 'fornecedor_id', label: 'Fornecedor', type: 'ref', ref: 'fornecedores', search: true },
      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
  },

  representantes: {
    key: 'representantes',
    table: 'representantes',
    label: 'Representantes',
    singular: 'Representante',
    labelFields: ['nome'],
    ops: ALL_OPS,
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, maxLength: 120, wide: true },
      { name: 'regiao', label: 'Região', type: 'text', search: true, maxLength: 80 },
      { name: 'comissao_pct', label: 'Comissão (%)', type: 'percent', min: 0, max: 100, default: 0 },
      { name: 'telefone', label: 'Telefone', type: 'phone', maxLength: 20 },
      { name: 'email', label: 'E-mail', type: 'email', maxLength: 160 },
      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
  },

  clientes: {
    key: 'clientes',
    table: 'clientes',
    label: 'Clientes',
    singular: 'Cliente',
    labelFields: ['nome'],
    ops: ALL_OPS,
    fields: [
      { name: 'nome', label: 'Nome / Razão social', type: 'text', required: true, search: true, maxLength: 160, wide: true },
      { name: 'cnpj_cpf', label: 'CNPJ / CPF', type: 'document', search: true, maxLength: 20 },
      {
        name: 'tipo',
        label: 'Tipo',
        type: 'select',
        default: 'loja',
        options: [
          { value: 'loja', label: 'Loja' },
          { value: 'atacadista', label: 'Atacadista' },
          { value: 'varejo', label: 'Varejo' },
        ],
      },
      { name: 'telefone', label: 'Telefone', type: 'phone', maxLength: 20 },
      { name: 'email', label: 'E-mail', type: 'email', maxLength: 160 },
      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
  },

  categorias: {
    key: 'categorias',
    table: 'categorias',
    label: 'Categorias',
    singular: 'Categoria',
    labelFields: ['nome'],
    ops: ALL_OPS,
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, unique: true, search: true, maxLength: 60, placeholder: 'Camisa, Camiseta, Calça, Bermuda...' },
      { name: 'descricao', label: 'Descrição', type: 'text', search: true, maxLength: 160 },
      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
    mock: [
      { id: 1, nome: 'Camisa', descricao: 'Camisas sociais e casuais', ativo: true },
      { id: 2, nome: 'Camiseta', descricao: 'Malha, gola careca e polo', ativo: true },
      { id: 3, nome: 'Calça', descricao: 'Jeans, sarja e alfaiataria', ativo: true },
      { id: 4, nome: 'Bermuda', descricao: '', ativo: true },
      { id: 5, nome: 'Jaqueta', descricao: '', ativo: true },
    ],
  },

  cores: {
    key: 'cores',
    table: 'cores',
    label: 'Cores',
    singular: 'Cor',
    labelFields: ['nome'],
    ops: ALL_OPS,
    notice: 'Cores padronizadas evitam duplicidade ("Azul", "azul", "AZUL"). O código hexadecimal mostra a amostra da cor nas listas.',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, unique: true, search: true, maxLength: 40, placeholder: 'Azul marinho, Preto, Off-white...' },
      { name: 'hex', label: 'Amostra (hex)', type: 'color', maxLength: 7, hint: 'Ex.: #1F3A5F. Opcional.' },
      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
    mock: [
      { id: 1, nome: 'Preto', hex: '#111111', ativo: true },
      { id: 2, nome: 'Branco', hex: '#FFFFFF', ativo: true },
      { id: 3, nome: 'Azul marinho', hex: '#1F3A5F', ativo: true },
      { id: 4, nome: 'Cinza mescla', hex: '#9CA3AF', ativo: true },
      { id: 5, nome: 'Verde militar', hex: '#4B5320', ativo: true },
    ],
  },

  produtos: {
    key: 'produtos',
    table: 'produtos',
    label: 'Produtos',
    singular: 'Produto',
    labelFields: ['sku', 'nome'],
    ops: ALL_OPS,
    images: { max: 5 },
    detail: true,
    fields: [
      { name: 'fotos', label: 'Fotos', type: 'images', virtual: true, form: false, hint: 'Até 5 fotos por produto. A primeira é a principal.' },
      { name: 'sku', label: 'SKU / Referência', type: 'text', required: true, unique: true, search: true, maxLength: 40, placeholder: 'Ex.: CAM-001' },
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, maxLength: 120 },
      { name: 'categoria_id', label: 'Categoria', type: 'ref', ref: 'categorias', search: true },
      { name: 'colecao_id', label: 'Coleção', type: 'ref', ref: 'colecoes', search: true },
      { name: 'cor_id', label: 'Cor (cadastro)', type: 'ref', ref: 'cores', search: true, hint: 'Cor padronizada, com amostra colorida.' },
      { name: 'cor', label: 'Cor (texto livre)', type: 'text', search: true, maxLength: 40, list: false, hint: 'Use quando a cor ainda não estiver no cadastro (ex.: estampa).' },
      { name: 'custo', label: 'Custo unitário', type: 'money', min: 0, default: 0, hint: 'Base para o valor do estoque no Dashboard.' },
      { name: 'preco_venda', label: 'Preço de venda', type: 'money', min: 0, default: 0 },
      { name: 'codigo_barras', label: 'Código de barras (EAN)', type: 'text', unique: true, search: true, maxLength: 14, list: false, placeholder: '7891234567890', pattern: '^(\\d{8}|\\d{12,14})$', patternMessage: 'Informe 8, 12, 13 ou 14 dígitos', hint: '8, 12, 13 ou 14 dígitos. Usado nas etiquetas.', section: 'Identificação e catálogo' },
      { name: 'composicao', label: 'Composição', type: 'text', maxLength: 120, list: false, placeholder: '100% algodão', section: 'Identificação e catálogo' },
      { name: 'descricao', label: 'Descrição comercial', type: 'textarea', maxLength: 2000, list: false, wide: true, hint: 'Texto usado no catálogo e nas propostas.', section: 'Identificação e catálogo' },
      { name: 'ncm', label: 'NCM', type: 'text', maxLength: 10, list: false, placeholder: '6205.20.00', hint: 'Classificação fiscal (preparação para NF-e).', section: 'Fiscal e logística' },
      { name: 'peso_g', label: 'Peso (g)', type: 'integer', min: 0, list: false, section: 'Fiscal e logística' },
      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
  },

  // ----------------------------------------------------------------
  // Estoque
  // ----------------------------------------------------------------
  estoques: {
    key: 'estoques',
    table: 'estoques',
    label: 'Estoque Físico',
    singular: 'Saldo de estoque',
    labelFields: ['local'],
    ops: ALL_OPS,
    notice:
      'Alterar a quantidade aqui gera automaticamente uma movimentação do tipo "ajuste". Para entradas e saídas do dia a dia use o módulo Movimentações.',
    fields: [
      { name: 'produto_id', label: 'Produto', type: 'ref', ref: 'produtos', required: true, search: true },
      { name: 'tamanho_id', label: 'Tamanho', type: 'ref', ref: 'tamanhos', required: true },
      { name: 'local', label: 'Local', type: 'text', required: true, default: 'almoxarifado', search: true, maxLength: 60, placeholder: 'almoxarifado, loja, expedição...' },
      { name: 'quantidade', label: 'Quantidade', type: 'integer', required: true, default: 0 },
      { name: 'estoque_min', label: 'Estoque mínimo', type: 'integer', min: 0, default: 0, hint: 'Abaixo disso o item entra em alerta no Dashboard.' },
      ...auditFields,
    ],
    orderBy: { field: 'produto_id', dir: 'asc' },
  },

  movimentacoes: {
    key: 'movimentacoes',
    table: 'movimentacoes',
    label: 'Movimentações',
    singular: 'Movimentação',
    labelFields: ['tipo'],
    ops: { create: true, update: false, delete: false },
    notice:
      'Toda movimentação atualiza o saldo do Estoque Físico e é imutável. Para corrigir um lançamento, faça um lançamento inverso.',
    fields: [
      {
        name: 'tipo',
        label: 'Tipo',
        type: 'select',
        required: true,
        default: 'entrada',
        options: [
          { value: 'entrada', label: 'Entrada', tone: 'green' },
          { value: 'saida', label: 'Saída', tone: 'red' },
          { value: 'ajuste', label: 'Ajuste', tone: 'amber' },
        ],
      },
      { name: 'produto_id', label: 'Produto', type: 'ref', ref: 'produtos', required: true, search: true },
      { name: 'tamanho_id', label: 'Tamanho', type: 'ref', ref: 'tamanhos', required: true },
      { name: 'local', label: 'Local', type: 'text', required: true, default: 'almoxarifado', maxLength: 60 },
      { name: 'quantidade', label: 'Quantidade', type: 'integer', required: true, hint: 'Entrada/saída: informe um valor positivo. Ajuste: use negativo para reduzir o saldo.' },
      { name: 'motivo', label: 'Motivo', type: 'text', search: true, maxLength: 200, wide: true },
      { name: 'data', label: 'Data', type: 'datetime', readonly: true },
    ],
    orderBy: { field: 'data', dir: 'desc' },
  },

  // ----------------------------------------------------------------
  // Produção
  // ----------------------------------------------------------------
  ordens: {
    key: 'ordens',
    table: 'ordens_fabricacao',
    label: 'Ordens de Fabricação',
    singular: 'Ordem de fabricação',
    labelFields: ['id'],
    ops: ALL_OPS,
    notice:
      'Ao mudar o status para "Concluída", as peças entram automaticamente no Estoque Físico (local almoxarifado).',
    fields: [
      { name: 'produto_id', label: 'Produto', type: 'ref', ref: 'produtos', required: true, search: true },
      { name: 'tamanho_id', label: 'Tamanho', type: 'ref', ref: 'tamanhos', required: true },
      { name: 'quantidade', label: 'Quantidade', type: 'integer', required: true, min: 1 },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        default: 'planejada',
        options: [
          { value: 'planejada', label: 'Planejada', tone: 'slate' },
          { value: 'em_producao', label: 'Em produção', tone: 'blue' },
          { value: 'concluida', label: 'Concluída', tone: 'green' },
          { value: 'cancelada', label: 'Cancelada', tone: 'red' },
        ],
      },
      { name: 'inicio', label: 'Início', type: 'date' },
      { name: 'previsao', label: 'Previsão de entrega', type: 'date' },
      ...auditFields,
    ],
    orderBy: { field: 'id', dir: 'desc' },
  },

  fichas: {
    key: 'fichas',
    table: 'fichas_tecnicas',
    label: 'Ficha Técnica / BOM',
    singular: 'Ficha técnica',
    labelFields: ['id'],
    ops: ALL_OPS,
    notice: 'Cadastre aqui os custos de mão de obra, indiretos e a margem por produto. A lista de insumos por peça será o próximo passo.',
    fields: [
      { name: 'produto_id', label: 'Produto', type: 'ref', ref: 'produtos', required: true, search: true },
      { name: 'mao_obra', label: 'Mão de obra (R$)', type: 'money', min: 0, default: 0 },
      { name: 'custos_indiretos', label: 'Custos indiretos (R$)', type: 'money', min: 0, default: 0 },
      { name: 'margem_pct', label: 'Margem (%)', type: 'percent', min: 0, max: 1000, default: 0 },
      ...auditFields,
    ],
    orderBy: { field: 'id', dir: 'desc' },
  },

  // ----------------------------------------------------------------
  // Compras / Vendas
  // ----------------------------------------------------------------
  compras: {
    key: 'compras',
    table: 'compras',
    label: 'Compras',
    singular: 'Pedido de compra',
    labelFields: ['id'],
    ops: ALL_OPS,
    detail: true,
    notice:
      'Ao marcar o pedido como "Recebido", os insumos entram no estoque e o custo médio de cada insumo é atualizado automaticamente. Cancelar um pedido recebido estorna a entrada.',
    fields: [
      { name: 'fornecedor_id', label: 'Fornecedor', type: 'ref', ref: 'fornecedores', required: true, search: true },
      { name: 'data', label: 'Data', type: 'date', required: true },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        default: 'pendente',
        options: [
          { value: 'pendente', label: 'Pendente', tone: 'amber' },
          { value: 'recebido', label: 'Recebido', tone: 'green' },
          { value: 'cancelado', label: 'Cancelado', tone: 'red' },
        ],
      },
      { name: 'total', label: 'Total (R$)', type: 'money', readonly: true, hint: 'Calculado a partir dos itens (e do frete).' },
      { name: 'condicao_pagamento', label: 'Condição de pagamento', type: 'text', maxLength: 60, list: false, placeholder: 'À vista, 30/60 dias...' },
      { name: 'frete', label: 'Frete (R$)', type: 'money', min: 0, default: 0, list: false },
      { name: 'previsao_entrega', label: 'Previsão de entrega', type: 'date', list: false },
      { name: 'nota_fiscal', label: 'Nota fiscal', type: 'text', maxLength: 60, list: false, placeholder: 'Número da NF' },
      { name: 'recebida_em', label: 'Recebida em', type: 'datetime', readonly: true, form: false },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true },
      ...auditFields,
    ],
    orderBy: { field: 'data', dir: 'desc' },
  },

  vendas: {
    key: 'vendas',
    table: 'vendas',
    label: 'Vendas',
    singular: 'Pedido de venda',
    labelFields: ['id'],
    ops: ALL_OPS,
    detail: true,
    notice:
      'Ao "Faturar", as peças saem do estoque (local de saída, com fallback para o almoxarifado) e a comissão do representante é congelada. Cancelar um pedido faturado/entregue estorna a saída.',
    fields: [
      { name: 'cliente_id', label: 'Cliente', type: 'ref', ref: 'clientes', required: true, search: true },
      { name: 'representante_id', label: 'Representante', type: 'ref', ref: 'representantes', search: true },
      { name: 'data', label: 'Data', type: 'date', required: true },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        default: 'aberta',
        options: [
          { value: 'aberta', label: 'Aberta', tone: 'amber' },
          { value: 'faturada', label: 'Faturada', tone: 'green' },
          { value: 'entregue', label: 'Entregue', tone: 'blue' },
          { value: 'cancelada', label: 'Cancelada', tone: 'red' },
        ],
      },
      { name: 'total', label: 'Total (R$)', type: 'money', readonly: true, hint: 'Calculado a partir dos itens, desconto e frete — nunca é editável.' },
      { name: 'condicao_pagamento', label: 'Condição de pagamento', type: 'text', maxLength: 60, list: false, placeholder: 'À vista, 30/60 dias...' },
      { name: 'desconto', label: 'Desconto (R$)', type: 'money', min: 0, default: 0, list: false },
      { name: 'frete', label: 'Frete (R$)', type: 'money', min: 0, default: 0, list: false },
      { name: 'previsao_entrega', label: 'Previsão de entrega', type: 'date', list: false },
      { name: 'pedido_cliente', label: 'Pedido do cliente', type: 'text', maxLength: 60, list: false, placeholder: 'Número do pedido no cliente' },
      { name: 'local_saida', label: 'Local de saída', type: 'text', maxLength: 60, default: 'almoxarifado', list: false, hint: 'Local de onde as peças saem no faturamento. Se não houver saldo, tenta o almoxarifado.' },
      { name: 'comissao_pct', label: 'Comissão (%)', type: 'percent', readonly: true, form: false },
      { name: 'comissao_valor', label: 'Comissão (R$)', type: 'money', readonly: true, form: false },
      { name: 'faturada_em', label: 'Faturada em', type: 'datetime', readonly: true, form: false },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true },
      ...auditFields,
    ],
    orderBy: { field: 'data', dir: 'desc' },
  },

  // ----------------------------------------------------------------
  // Interno — itens de pedidos e estoque de insumos.
  // Manipulados por pedidos.ts (sub-recursos), não pela API genérica.
  // ----------------------------------------------------------------
  itens_venda: {
    key: 'itens_venda',
    table: 'itens_venda',
    label: 'Itens de venda',
    singular: 'Item de venda',
    labelFields: ['id'],
    internal: true,
    ops: READ_ONLY,
    fields: [
      { name: 'venda_id', label: 'Venda', type: 'integer' },
      { name: 'produto_id', label: 'Produto', type: 'ref', ref: 'produtos', required: true },
      { name: 'tamanho_id', label: 'Tamanho', type: 'ref', ref: 'tamanhos', required: true },
      { name: 'quantidade', label: 'Quantidade', type: 'integer', required: true, min: 1 },
      { name: 'preco_unitario', label: 'Preço unitário', type: 'money', required: true, min: 0 },
      { name: 'desconto_pct', label: 'Desconto (%)', type: 'percent', min: 0, max: 100, default: 0 },
      { name: 'subtotal', label: 'Subtotal', type: 'money', readonly: true },
    ],
  },

  itens_compra: {
    key: 'itens_compra',
    table: 'itens_compra',
    label: 'Itens de compra',
    singular: 'Item de compra',
    labelFields: ['id'],
    internal: true,
    ops: READ_ONLY,
    fields: [
      { name: 'compra_id', label: 'Compra', type: 'integer' },
      { name: 'insumo_id', label: 'Insumo', type: 'ref', ref: 'insumos', required: true },
      { name: 'quantidade', label: 'Quantidade', type: 'number', required: true, min: 0.001 },
      { name: 'preco_unitario', label: 'Preço unitário', type: 'money', required: true, min: 0 },
    ],
  },

  estoque_insumos: {
    key: 'estoque_insumos',
    table: 'estoque_insumos',
    label: 'Estoque de insumos',
    singular: 'Saldo de insumo',
    labelFields: ['insumo_id'],
    internal: true,
    ops: READ_ONLY,
    fields: [
      { name: 'insumo_id', label: 'Insumo', type: 'ref', ref: 'insumos' },
      { name: 'quantidade', label: 'Quantidade', type: 'number', default: 0 },
      { name: 'estoque_min', label: 'Estoque mínimo', type: 'number', min: 0, default: 0 },
      { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true },
    ],
  },

  movimentacoes_insumos: {
    key: 'movimentacoes_insumos',
    table: 'movimentacoes_insumos',
    label: 'Movimentações de insumos',
    singular: 'Movimentação de insumo',
    labelFields: ['id'],
    internal: true,
    ops: READ_ONLY,
    fields: [
      {
        name: 'tipo',
        label: 'Tipo',
        type: 'select',
        required: true,
        options: [
          { value: 'entrada', label: 'Entrada', tone: 'green' },
          { value: 'saida', label: 'Saída', tone: 'red' },
          { value: 'ajuste', label: 'Ajuste', tone: 'amber' },
        ],
      },
      { name: 'insumo_id', label: 'Insumo', type: 'ref', ref: 'insumos', required: true },
      { name: 'quantidade', label: 'Quantidade', type: 'number', required: true },
      { name: 'custo_unitario', label: 'Custo unitário', type: 'money', min: 0, default: 0 },
      { name: 'motivo', label: 'Motivo', type: 'text' },
      { name: 'usuario_id', label: 'Usuário', type: 'integer' },
      { name: 'data', label: 'Data', type: 'datetime', readonly: true },
    ],
  },
};

export function getResource(key: string): Resource | undefined {
  return Object.prototype.hasOwnProperty.call(RESOURCES, key) ? RESOURCES[key] : undefined;
}

/** Recurso exposto na API genérica (exclui os internos). */
export function getPublicResource(key: string): Resource | undefined {
  const r = getResource(key);
  return r && !r.internal ? r : undefined;
}

/** Colunas reais do banco de um recurso (exclui campos virtuais). */
export function columnsOf(r: Resource): Field[] {
  return r.fields.filter((f) => !f.virtual);
}

/** Campos que o usuário pode gravar (não virtuais, não somente leitura). */
export function writableFields(r: Resource): Field[] {
  return r.fields.filter((f) => !f.readonly && f.form !== false);
}

/** Versão pública (para o front) — sem dados de mock. */
export function publicMeta() {
  const out: Record<string, Omit<Resource, 'mock' | 'table'>> = {};
  for (const r of Object.values(RESOURCES)) {
    if (r.internal) continue;
    const { mock: _m, table: _t, ...rest } = r;
    out[r.key] = rest;
  }
  return out;
}
