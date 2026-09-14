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
  | 'multiref' // lista de chaves estrangeiras (muitos-para-muitos; ex.: tamanhos de uma grade)
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
  /** perfil mínimo para acessar (admin > gerente > operador). Ex.: gerentePlus */
  minPerfil?: 'gerente' | 'admin';
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
  portal_acessos: {
    key: 'portal_acessos', table: 'portal_acessos', label: 'Acessos do portal', singular: 'Acesso', labelFields: ['id'], internal: true, ops: READ_ONLY,
    fields: [
      { name: 'cliente_id', label: 'Cliente', type: 'ref', ref: 'clientes' }, { name: 'token_hash', label: 'Token', type: 'text', unique: true },
      { name: 'expira_em', label: 'Expira em', type: 'datetime' }, { name: 'revogado_em', label: 'Revogado em', type: 'datetime' },
      { name: 'ultimo_acesso_em', label: 'Último acesso', type: 'datetime' }, { name: 'acessos', label: 'Acessos', type: 'integer' },
      { name: 'criado_em', label: 'Criado em', type: 'datetime' },
    ],
  },
  cotacao_decisoes: {
    key: 'cotacao_decisoes', table: 'cotacao_decisoes', label: 'Decisões de cotação', singular: 'Decisão', labelFields: ['id'], internal: true, ops: READ_ONLY,
    fields: [
      { name: 'venda_id', label: 'Venda', type: 'ref', ref: 'vendas' }, { name: 'cliente_id', label: 'Cliente', type: 'ref', ref: 'clientes' },
      { name: 'decisao', label: 'Decisão', type: 'text' }, { name: 'responsavel', label: 'Responsável', type: 'text' },
      { name: 'mensagem', label: 'Mensagem', type: 'text' }, { name: 'proposta_hash', label: 'Hash', type: 'text' },
      { name: 'ip', label: 'IP', type: 'text' }, { name: 'user_agent', label: 'Navegador', type: 'text' }, { name: 'criado_em', label: 'Criado em', type: 'datetime' },
    ],
  },
  catalogo_compartilhamentos: {
    key: 'catalogo_compartilhamentos', table: 'catalogo_compartilhamentos', label: 'Compartilhamentos de catálogo', singular: 'Compartilhamento',
    labelFields: ['id'], internal: true, ops: READ_ONLY,
    fields: [
      { name: 'catalogo_id', label: 'Catálogo', type: 'ref', ref: 'catalogos' },
      { name: 'cliente_id', label: 'Cliente', type: 'ref', ref: 'clientes' },
      { name: 'usuario_id', label: 'Vendedor', type: 'ref', ref: 'usuarios' },
      { name: 'token_hash', label: 'Token', type: 'text', unique: true },
      { name: 'canal', label: 'Canal', type: 'text' },
      { name: 'expira_em', label: 'Expira em', type: 'datetime' },
      { name: 'revogado_em', label: 'Revogado em', type: 'datetime' },
      { name: 'primeiro_acesso_em', label: 'Primeiro acesso', type: 'datetime' },
      { name: 'ultimo_acesso_em', label: 'Último acesso', type: 'datetime' },
      { name: 'acessos', label: 'Acessos', type: 'integer' },
      { name: 'criado_em', label: 'Criado em', type: 'datetime' },
    ],
  },
  catalogo_eventos: {
    key: 'catalogo_eventos', table: 'catalogo_eventos', label: 'Eventos de catálogo', singular: 'Evento',
    labelFields: ['id'], internal: true, ops: READ_ONLY,
    fields: [
      { name: 'compartilhamento_id', label: 'Compartilhamento', type: 'ref', ref: 'catalogo_compartilhamentos' },
      { name: 'catalogo_id', label: 'Catálogo', type: 'ref', ref: 'catalogos' },
      { name: 'produto_id', label: 'Produto', type: 'ref', ref: 'produtos' },
      { name: 'pedido_id', label: 'Pedido', type: 'ref', ref: 'vendas' },
      { name: 'valor', label: 'Valor', type: 'money' },
      { name: 'tipo', label: 'Tipo', type: 'text' },
      { name: 'dados', label: 'Dados', type: 'text' },
      { name: 'criado_em', label: 'Criado em', type: 'datetime' },
    ],
  },
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
      'Senhas protegidas por hash Argon2id (irreversível) — nunca exibidas nem recuperáveis. Novos usuários recebem um CONVITE por e-mail para definir a própria senha; o administrador pode gerar uma senha temporária de exibição única. Desative em vez de excluir: a exclusão definitiva só é permitida para contas que nunca foram usadas.',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, maxLength: 120 },
      { name: 'email', label: 'E-mail', type: 'email', required: true, unique: true, search: true, maxLength: 160, hint: 'Usado para o login e para o convite de acesso.' },
      { name: 'perfil', label: 'Perfil', type: 'select', required: true, options: PERFIS, default: 'operador', hint: 'Administrador: tudo (com MFA obrigatório). Gerente: tudo, exceto usuários. Operador: não exclui registros.' },
      { name: 'cargo', label: 'Cargo / função', type: 'text', search: true, maxLength: 80, section: 'Dados profissionais', placeholder: 'Ex.: Vendedora, Estoquista, Costureira...', hint: 'Função da pessoa na empresa (aparece na ficha do usuário).' },
      { name: 'departamento', label: 'Departamento', type: 'text', search: true, maxLength: 60, section: 'Dados profissionais', placeholder: 'Ex.: Vendas, Estoque, Produção, Financeiro...' },
      { name: 'telefone', label: 'Telefone / WhatsApp', type: 'phone', maxLength: 20, section: 'Dados profissionais', list: false },
      { name: 'observacoes', label: 'Observações internas', type: 'textarea', maxLength: 1000, list: false, wide: true, section: 'Dados profissionais', hint: 'Visível apenas para administradores. Ex.: turno, loja, responsável pela contratação.' },
      { name: 'acesso_expira_em', label: 'Acesso expira em', type: 'datetime', list: false, section: 'Ciclo de vida', hint: 'Opcional: para acessos temporários (ex.: freelancer, safra). Vazio = sem expiração. Expirado bloqueia o login.' },
      { name: 'perm_catalogos', label: 'Gerenciar catálogos', type: 'select', default: 'herdar', section: 'Permissões comerciais', options: [{ value: 'herdar', label: 'Herdar do perfil' }, { value: 'permitir', label: 'Permitir' }, { value: 'negar', label: 'Negar' }] },
      { name: 'perm_compartilhar', label: 'Compartilhar catálogos', type: 'select', default: 'herdar', section: 'Permissões comerciais', options: [{ value: 'herdar', label: 'Herdar do perfil' }, { value: 'permitir', label: 'Permitir' }, { value: 'negar', label: 'Negar' }] },
      { name: 'perm_metricas', label: 'Ver métricas comerciais', type: 'select', default: 'herdar', section: 'Permissões comerciais', options: [{ value: 'herdar', label: 'Herdar do perfil' }, { value: 'permitir', label: 'Permitir' }, { value: 'negar', label: 'Negar' }] },
      { name: 'perm_politicas', label: 'Gerenciar políticas', type: 'select', default: 'herdar', section: 'Permissões comerciais', options: [{ value: 'herdar', label: 'Herdar do perfil' }, { value: 'permitir', label: 'Permitir' }, { value: 'negar', label: 'Negar' }] },
      { name: 'perm_aprovar', label: 'Aprovar exceções', type: 'select', default: 'herdar', section: 'Permissões comerciais', options: [{ value: 'herdar', label: 'Herdar do perfil' }, { value: 'permitir', label: 'Permitir' }, { value: 'negar', label: 'Negar' }] },
      { name: 'desconto_max_pct', label: 'Desconto máximo (%)', type: 'percent', min: 0, max: 100, section: 'Alçadas comerciais', hint: 'Vazio usa o padrão do perfil.' },
      { name: 'venda_sem_aprovacao_ate', label: 'Venda sem aprovação até', type: 'money', min: 0, section: 'Alçadas comerciais', hint: 'Acima deste valor exige aprovação.' },
      { ...ativo, hint: 'Usuários inativos não conseguem entrar. Ao desativar, informe o motivo e as sessões ativas são encerradas na hora.' },
      {
        name: 'status_conta',
        label: 'Status',
        type: 'select',
        virtual: true,
        list: true,
        form: false,
        options: [
          { value: 'ativo', label: 'Ativo', tone: 'green' },
          { value: 'convite_pendente', label: 'Convite pendente', tone: 'blue' },
          { value: 'convite_expirado', label: 'Convite expirado', tone: 'amber' },
          { value: 'provisoria', label: 'Senha provisória', tone: 'amber' },
          { value: 'bloqueado', label: 'Bloqueado', tone: 'red' },
          { value: 'expirado', label: 'Acesso expirado', tone: 'red' },
          { value: 'inativo', label: 'Desativado', tone: 'slate' },
        ],
        hint: 'Situação consolidada da conta (calculada pelo servidor).',
      },
      {
        name: 'senha_status',
        label: 'Acesso',
        type: 'select',
        virtual: true,
        list: true,
        form: false,
        options: [
          { value: 'propria', label: 'Definida pelo usuário', tone: 'green' },
          { value: 'provisoria', label: 'Provisória — troca pendente', tone: 'amber' },
          { value: 'convite_pendente', label: 'Convite pendente', tone: 'blue' },
        ],
        hint: 'A senha real nunca é exibida: é gravada em hash Argon2id (irreversível), igual ao login.',
      },
      { name: 'convite_expira_em', label: 'Convite expira em', type: 'datetime', readonly: true, form: false, list: false },
      { name: 'trocar_senha', label: 'Trocar senha no próximo acesso', type: 'boolean', default: false, list: false, hint: 'Ao marcar, o usuário é obrigado a definir uma senha nova no primeiro acesso.' },
      { name: 'mfa_ativado_em', label: 'MFA ativado em', type: 'datetime', readonly: true, form: false, list: false, hint: 'Autenticação em dois fatores (TOTP) — obrigatória para administradores.' },
      { name: 'senha_definida_em', label: 'Senha definida em', type: 'datetime', readonly: true, form: false, list: false },
      { name: 'ultimo_login', label: 'Último acesso', type: 'datetime', readonly: true, form: false },
      { name: 'ultimo_ip', label: 'Último IP', type: 'text', readonly: true, form: false, list: false },
      { name: 'tentativas_falhas', label: 'Tentativas falhas', type: 'integer', readonly: true, form: false, list: false, hint: 'Falhas de senha consecutivas (zera a cada login com sucesso).' },
      { name: 'ultimo_falha_em', label: 'Última falha em', type: 'datetime', readonly: true, form: false, list: false },
      { name: 'bloqueado_ate', label: 'Bloqueado até', type: 'datetime', readonly: true, form: false, list: false, hint: 'Bloqueio temporário por excesso de tentativas. Use "Desbloquear" na ficha do usuário.' },
      { name: 'motivo_bloqueio', label: 'Motivo do bloqueio', type: 'text', readonly: true, form: false, list: false },
      { name: 'bloqueio_manual', label: 'Bloqueio manual', type: 'boolean', readonly: true, form: false, list: false, hint: 'Bloqueio aplicado pelo administrador (sem prazo). Use "Desbloquear" na ficha do usuário.' },
      { name: 'criado_por', label: 'Criado por (id)', type: 'integer', readonly: true, form: false, list: false },
      { name: 'desativado_por', label: 'Desativado por', type: 'text', readonly: true, form: false, list: false },
      { name: 'desativado_em', label: 'Desativado em', type: 'datetime', readonly: true, form: false, list: false },
      { name: 'desativado_motivo', label: 'Motivo da desativação', type: 'text', readonly: true, form: false, list: false },
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
      { name: 'usuario_id', label: 'ID do usuário', type: 'integer', readonly: true, list: false, form: false },
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
          { value: 'login_falha', label: 'Login (falha)', tone: 'red' },
          { value: 'senha', label: 'Troca de senha', tone: 'amber' },
          { value: 'mfa', label: 'MFA (2FA)', tone: 'blue' },
          { value: 'seguranca', label: 'Segurança', tone: 'red' },
          { value: 'bloqueio', label: 'Bloqueio de acesso', tone: 'red' },
          { value: 'convite', label: 'Convite de acesso', tone: 'green' },
          { value: 'importar', label: 'Importação', tone: 'blue' },
          { value: 'ajuste', label: 'Ajuste de estoque', tone: 'amber' },
          { value: 'estornar', label: 'Estorno', tone: 'amber' },
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
  locais: {
    key: 'locais',
    table: 'locais',
    label: 'Locais de estoque',
    singular: 'Local',
    labelFields: ['nome'],
    ops: ALL_OPS,
    notice: 'Locais onde o estoque fica guardado (loja, expedição, facção). Marque um deles como Local padrão — ele vira a origem padrão das movimentações (entrada/saída/transferência) e do Estoque Físico. Gestão livre: o administrador pode incluir, alterar e excluir um local mesmo que ele já esteja em uso — ao renomear, o novo nome é propagado para saldos, movimentações e inventários; ao excluir, o histórico permanece com o nome do local.',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, unique: true, search: true, maxLength: 60, placeholder: 'loja, expedição, facção...', hint: 'Pode ser alterado mesmo com o local em uso (decisão do administrador): o novo nome é aplicado em saldos, movimentações e inventários.' },
      {
        name: 'tipo',
        label: 'Tipo',
        type: 'select',
        required: true,
        default: 'loja',
        options: [
          { value: 'loja', label: 'Loja', tone: 'green' },
          { value: 'expedicao', label: 'Expedição', tone: 'amber' },
          { value: 'faccao', label: 'Facção', tone: 'slate' },
        ],
      },
      {
        name: 'padrao',
        label: 'Local padrão',
        type: 'boolean',
        default: false,
        hint: 'Marque para usar este local como origem padrão das movimentações. Somente um local pode ser o padrão (ao marcar um novo, o anterior é desmarcado automaticamente).',
      },
      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
    mock: [
      { id: 1, nome: 'loja', tipo: 'loja', ativo: true, padrao: true },
      { id: 2, nome: 'expedicao', tipo: 'expedicao', ativo: true, padrao: false },
      { id: 3, nome: 'faccao', tipo: 'faccao', ativo: true, padrao: false },
    ],
  },

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
      { id: 6, codigo: '36', descricao: 'Calça/Bermuda', ordem: 10 },
      { id: 7, codigo: '38', descricao: 'Calça/Bermuda', ordem: 11 },
      { id: 8, codigo: '40', descricao: 'Calça/Bermuda', ordem: 12 },
      { id: 9, codigo: '42', descricao: 'Calça/Bermuda', ordem: 13 },
      { id: 10, codigo: '44', descricao: 'Calça/Bermuda', ordem: 14 },
      { id: 11, codigo: '46', descricao: 'Calça/Bermuda', ordem: 15 },
      { id: 12, codigo: '48', descricao: 'Calça/Bermuda', ordem: 16 },
      { id: 13, codigo: 'Único', descricao: 'Tamanho único', ordem: 20 },
    ],
  },

  grades: {
    key: 'grades',
    table: 'grades',
    label: 'Grades',
    singular: 'Grade',
    labelFields: ['nome'],
    ops: ALL_OPS,
    notice:
      'Uma grade é um conjunto nomeado de tamanhos na ordem correta (ex.: Camiseta PP–GG, Calça 36–48, Calçado 34–44). Vincule a grade à categoria (padrão) ou diretamente ao produto para que o estoque mostre apenas os tamanhos daquele tipo de peça.',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, unique: true, search: true, maxLength: 60, placeholder: 'Camiseta PP-GG, Calça 36-48...' },
      { name: 'tamanhos', label: 'Tamanhos', type: 'multiref', ref: 'tamanhos', virtual: true, required: true, list: true, wide: true, hint: 'Marque os tamanhos desta grade, na ordem em que devem aparecer. Reordene marcando na sequência desejada.' },
      { name: 'descricao', label: 'Descrição', type: 'text', search: true, maxLength: 160 },
      {
        name: 'instrucoes_medidas',
        label: 'Instruções de medição (para o cliente)',
        type: 'textarea',
        list: false,
        wide: true,
        maxLength: 600,
        placeholder: 'Ex.: Meça a peça sobre uma superfície plana, sem esticar. Tolerância de ±1 cm.',
        hint: 'Aparece abaixo da tabela de medidas no catálogo público, no detalhe do produto e na impressão. Explique como a peça foi medida e a tolerância.',
      },
      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
    mock: [
      { id: 1, nome: 'Camiseta PP-GG', descricao: 'Malha e camisaria básica', ativo: true },
      { id: 2, nome: 'Calça 36-48', descricao: 'Jeans e sarja', ativo: true },
      { id: 3, nome: 'Bermuda 36-46', descricao: 'Bermudas e shorts', ativo: true },
    ],
  },

  // Interno — itens de uma grade (tamanhos vinculados, com ordem).
  grade_tamanhos: {
    key: 'grade_tamanhos',
    table: 'grade_tamanhos',
    label: 'Itens de grade',
    singular: 'Item de grade',
    labelFields: ['id'],
    internal: true,
    ops: READ_ONLY,
    fields: [
      { name: 'grade_id', label: 'Grade', type: 'integer' },
      { name: 'tamanho_id', label: 'Tamanho', type: 'ref', ref: 'tamanhos', required: true },
      { name: 'ordem', label: 'Ordem', type: 'integer', min: 0, default: 0 },
    ],
    orderBy: { field: 'ordem', dir: 'asc' },
    mock: [
      { id: 1, grade_id: 1, tamanho_id: 1, ordem: 1 },
      { id: 2, grade_id: 1, tamanho_id: 2, ordem: 2 },
      { id: 3, grade_id: 1, tamanho_id: 3, ordem: 3 },
      { id: 4, grade_id: 1, tamanho_id: 4, ordem: 4 },
      { id: 5, grade_id: 1, tamanho_id: 5, ordem: 5 },
      { id: 6, grade_id: 2, tamanho_id: 6, ordem: 1 },
      { id: 7, grade_id: 2, tamanho_id: 7, ordem: 2 },
      { id: 8, grade_id: 2, tamanho_id: 8, ordem: 3 },
      { id: 9, grade_id: 2, tamanho_id: 9, ordem: 4 },
      { id: 10, grade_id: 2, tamanho_id: 10, ordem: 5 },
      { id: 11, grade_id: 2, tamanho_id: 11, ordem: 6 },
      { id: 12, grade_id: 2, tamanho_id: 12, ordem: 7 },
      { id: 13, grade_id: 3, tamanho_id: 6, ordem: 1 },
      { id: 14, grade_id: 3, tamanho_id: 7, ordem: 2 },
      { id: 15, grade_id: 3, tamanho_id: 8, ordem: 3 },
      { id: 16, grade_id: 3, tamanho_id: 9, ordem: 4 },
      { id: 17, grade_id: 3, tamanho_id: 10, ordem: 5 },
      { id: 18, grade_id: 3, tamanho_id: 11, ordem: 6 },
    ],
  },

  // Interno — tabela de medidas: colunas (medidas) e valores por tamanho.
  medidas: {
    key: 'medidas',
    table: 'medidas',
    label: 'Medidas da grade',
    singular: 'Medida',
    labelFields: ['nome'],
    internal: true,
    ops: READ_ONLY,
    fields: [
      { name: 'grade_id', label: 'Grade', type: 'integer' },
      { name: 'nome', label: 'Nome', type: 'text', required: true, maxLength: 60, placeholder: 'Largura (A), Comprimento (B), Manga (C)...' },
      { name: 'unidade', label: 'Unidade', type: 'select', options: [{ value: 'cm', label: 'cm' }, { value: 'mm', label: 'mm' }, { value: 'pol', label: 'pol' }], default: 'cm' },
      { name: 'ordem', label: 'Ordem', type: 'integer', min: 0, default: 0 },
      ...auditFields,
    ],
    orderBy: { field: 'ordem', dir: 'asc' },
  },

  medida_valores: {
    key: 'medida_valores',
    table: 'medida_valores',
    label: 'Valores de medida',
    singular: 'Valor de medida',
    labelFields: ['id'],
    internal: true,
    ops: READ_ONLY,
    fields: [
      { name: 'medida_id', label: 'Medida', type: 'integer' },
      { name: 'tamanho_id', label: 'Tamanho', type: 'ref', ref: 'tamanhos', required: true },
      { name: 'valor', label: 'Valor', type: 'number' },
      { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true, list: false },
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
      { name: 'grade_id', label: 'Grade padrão', type: 'ref', ref: 'grades', search: true, hint: 'Grade de tamanhos usada por padrão nos produtos desta categoria (o produto pode sobrescrever).' },
      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
    mock: [
      { id: 1, nome: 'Camisa', descricao: 'Camisas sociais e casuais', ativo: true, grade_id: 1 },
      { id: 2, nome: 'Camiseta', descricao: 'Malha, gola careca e polo', ativo: true, grade_id: 1 },
      { id: 3, nome: 'Calça', descricao: 'Jeans, sarja e alfaiataria', ativo: true, grade_id: 2 },
      { id: 4, nome: 'Bermuda', descricao: '', ativo: true, grade_id: 3 },
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
      { name: 'grade_id', label: 'Grade de tamanhos', type: 'ref', ref: 'grades', search: true, hint: 'Define os tamanhos deste produto no estoque. Se vazio, herda a grade padrão da categoria.' },
      { name: 'colecao_id', label: 'Coleção', type: 'ref', ref: 'colecoes', search: true },
      { name: 'cor_id', label: 'Cor (cadastro)', type: 'ref', ref: 'cores', search: true, hint: 'Cor padronizada, com amostra colorida.' },
      { name: 'cor', label: 'Cor (texto livre)', type: 'text', search: true, maxLength: 40, list: false, hint: 'Use quando a cor ainda não estiver no cadastro (ex.: estampa).' },
      { name: 'custo', label: 'Custo unitário', type: 'money', min: 0, default: 0, hint: 'Base para o valor do estoque no Dashboard.' },
      { name: 'preco_venda', label: 'Preço de venda (varejo)', type: 'money', min: 0, default: 0, section: 'Varejo e atacado' },
      { name: 'preco_atacado', label: 'Preço de venda atacado', type: 'money', min: 0, default: 0, list: false, section: 'Varejo e atacado', hint: 'Usado em catálogos/links de atacado e no pedido pelo site.' },
      { name: 'atacado_min_qtd', label: 'Qtd. mínima atacado', type: 'integer', min: 0, default: 0, list: false, section: 'Varejo e atacado', hint: 'Quantidade mínima para aplicar o preço de atacado.' },
      { name: 'exibir_site', label: 'Exibir no catálogo/site', type: 'boolean', default: false, list: false, section: 'Varejo e atacado', hint: 'Produto disponível para catálogos públicos e pedidos pelo site.' },
      { name: 'destaque', label: 'Destaque no catálogo', type: 'boolean', default: false, list: false, section: 'Varejo e atacado' },
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
      { name: 'local', label: 'Local', type: 'text', search: true, maxLength: 60, placeholder: 'loja, expedição, facção...', list: false, hint: 'Preenchido automaticamente pelo seletor de local. Deixe em branco para usar o Local padrão.' },
      { name: 'local_id', label: 'Local', type: 'ref', ref: 'locais', search: true, hint: 'Use o cadastro de Locais em vez de digitar texto livre.' },
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
      'Toda movimentação atualiza o saldo do Estoque Físico e é imutável. "Transferência" move peças entre locais em um único lançamento. Para corrigir, faça o lançamento inverso.',
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
          { value: 'transferencia', label: 'Transferência', tone: 'blue' },
          { value: 'ajuste', label: 'Ajuste', tone: 'amber' },
        ],
      },
      { name: 'produto_id', label: 'Produto', type: 'ref', ref: 'produtos', required: true, search: true },
      { name: 'tamanho_id', label: 'Tamanho', type: 'ref', ref: 'tamanhos', required: true },
      { name: 'local', label: 'Local de origem', type: 'text', maxLength: 60, list: false, hint: 'Preenchido automaticamente pelo seletor de local. Deixe em branco para usar o Local padrão.' },
      { name: 'local_id', label: 'Local de origem', type: 'ref', ref: 'locais', search: true, hint: 'Use o cadastro de Locais em vez de digitar texto livre.' },
      { name: 'local_destino', label: 'Local de destino', type: 'text', maxLength: 60, list: false, hint: 'Obrigatório em transferências.' },
      { name: 'local_destino_id', label: 'Local de destino', type: 'ref', ref: 'locais', hint: 'Obrigatório em transferências.' },
      { name: 'quantidade', label: 'Quantidade', type: 'integer', required: true, hint: 'Entrada: positivo (aumenta). Saída/transferência: positivo (diminui). Ajuste: positivo para acrescentar, negativo para reduzir.' },
      { name: 'motivo', label: 'Motivo', type: 'text', search: true, maxLength: 200, wide: true },
      { name: 'estornado', label: 'Estornado', type: 'boolean', default: false, list: false },
      { name: 'estornado_em', label: 'Estornado em', type: 'datetime', list: false },
      { name: 'estornado_por', label: 'Estornado por', type: 'text', list: false },
      { name: 'movimentacao_estorno_id', label: 'Movimentação de estorno', type: 'ref', ref: 'movimentacoes', list: false },
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
    detail: true,
    notice:
      'OP "por tamanho": uma OP para um único tamanho. OP "por grade": quantidades de PP a GG na mesma OP. Ao concluir, as peças entram no Estoque Físico (no Local padrão) e o consumo de insumos da ficha técnica é baixado.',
    fields: [
      { name: 'produto_id', label: 'Produto', type: 'ref', ref: 'produtos', required: true, search: true },
      {
        name: 'tipo',
        label: 'Tipo de OP',
        type: 'select',
        required: true,
        default: 'tamanho',
        options: [
          { value: 'tamanho', label: 'Por tamanho' },
          { value: 'grade', label: 'Por grade (PP–GG)' },
        ],
      },
      { name: 'tamanho_id', label: 'Tamanho', type: 'ref', ref: 'tamanhos', search: true, hint: 'Obrigatório em OP "por tamanho".' },
      { name: 'quantidade', label: 'Quantidade', type: 'integer', min: 1, hint: 'Obrigatório em OP "por tamanho".' },
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
      {
        name: 'etapa',
        label: 'Etapa',
        type: 'select',
        options: [
          { value: 'corte', label: 'Corte', tone: 'slate' },
          { value: 'costura', label: 'Costura', tone: 'blue' },
          { value: 'acabamento', label: 'Acabamento', tone: 'amber' },
          { value: 'revisao', label: 'Revisão', tone: 'green' },
        ],
      },
      { name: 'faccao', label: 'Facção', type: 'text', maxLength: 80, search: true, placeholder: 'Facção responsável (opcional)' },
      { name: 'inicio', label: 'Início', type: 'date' },
      { name: 'previsao', label: 'Previsão de entrega', type: 'date' },
      { name: 'concluida_em', label: 'Concluída em', type: 'datetime', readonly: true, form: false },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true },
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
    detail: true,
    notice:
      'Uma ficha por produto. A lista de insumos por peça (com perda) é mantida na página da ficha. O custo calculado e o preço sugerido são recalculados automaticamente e podem ser aplicados ao produto.',
    fields: [
      { name: 'produto_id', label: 'Produto', type: 'ref', ref: 'produtos', required: true, unique: true, search: true, hint: 'Uma ficha técnica por produto.' },
      { name: 'mao_obra', label: 'Mão de obra (R$)', type: 'money', min: 0, default: 0 },
      { name: 'custos_indiretos', label: 'Custos indiretos (R$)', type: 'money', min: 0, default: 0 },
      { name: 'margem_pct', label: 'Margem (%)', type: 'percent', min: 0, max: 1000, default: 0, hint: 'Usada no preço sugerido: custo × (1 + margem/100).' },
      { name: 'custo_calculado', label: 'Custo calculado (R$)', type: 'money', readonly: true, hint: 'Σ insumos (com perda × custo médio) + mão de obra + indiretos.' },
      { name: 'preco_sugerido', label: 'Preço sugerido (R$)', type: 'money', readonly: true },
      { name: 'calculado_em', label: 'Calculado em', type: 'datetime', readonly: true, form: false },
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
      {
        name: 'fin_conta_id',
        label: 'Conta financeira (pagamento)',
        type: 'ref',
        ref: 'contas_financeiras',
        search: true,
        list: false,
        section: 'Financeiro',
      },
      {
        name: 'fin_status',
        label: 'Situação financeira',
        type: 'select',
        default: 'a_pagar',
        list: false,
        section: 'Financeiro',
        options: [
          { value: 'a_pagar', label: 'A pagar', tone: 'amber' },
          { value: 'pago', label: 'Pago', tone: 'green' },
          { value: 'cancelado', label: 'Cancelado', tone: 'red' },
        ],
      },
      {
        name: 'fin_forma_pagamento',
        label: 'Forma de pagamento',
        type: 'select',
        list: false,
        section: 'Financeiro',
        options: [
          { value: 'pix', label: 'Pix' },
          { value: 'boleto', label: 'Boleto' },
          { value: 'dinheiro', label: 'Dinheiro' },
          { value: 'transferencia', label: 'Transferência' },
          { value: 'outros', label: 'Outros' },
        ],
      },
      { name: 'fin_vencimento', label: 'Vencimento / previsão', type: 'date', list: false, section: 'Financeiro' },
      { name: 'fin_parcelas', label: 'Parcelas', type: 'integer', min: 1, default: 1, list: false, section: 'Financeiro' },
      { name: 'fin_pago_em', label: 'Pago em', type: 'date', list: false, section: 'Financeiro' },
      { name: 'fin_documento', label: 'Comprovante / doc.', type: 'text', maxLength: 80, list: false, section: 'Financeiro', placeholder: 'Nº comprovante, código Pix...' },
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
      'Ao "Faturar", as peças saem do estoque (local de saída, com fallback para o Local padrão) e a comissão do representante é congelada. Cancelar um pedido faturado/entregue estorna a saída.',
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
          { value: 'cotacao', label: 'Cotação / Pedido do site', tone: 'blue' },
          { value: 'aberta', label: 'Aberta', tone: 'amber' },
          { value: 'faturada', label: 'Faturada', tone: 'green' },
          { value: 'entregue', label: 'Entregue', tone: 'blue' },
          { value: 'cancelada', label: 'Cancelada', tone: 'red' },
        ],
      },
      {
        name: 'canal_venda',
        label: 'Canal de venda',
        type: 'select',
        default: 'balcao',
        search: true,
        options: [
          { value: 'balcao', label: 'Balcão / Loja', tone: 'slate' },
          { value: 'representante', label: 'Representante', tone: 'blue' },
          { value: 'whatsapp', label: 'WhatsApp / Indicação', tone: 'green' },
          { value: 'site_varejo', label: 'Site — Varejo', tone: 'amber' },
          { value: 'site_atacado', label: 'Site — Atacado', tone: 'red' },
          { value: 'marketplace', label: 'Marketplace', tone: 'red' },
          { value: 'outro', label: 'Outro', tone: 'slate' },
        ],
      },
      {
        name: 'fin_conta_id',
        label: 'Conta financeira (recebimento)',
        type: 'ref',
        ref: 'contas_financeiras',
        search: true,
        list: false,
        section: 'Financeiro',
      },
      {
        name: 'fin_status',
        label: 'Situação financeira',
        type: 'select',
        default: 'a_receber',
        list: false,
        section: 'Financeiro',
        options: [
          { value: 'a_receber', label: 'A receber', tone: 'amber' },
          { value: 'recebido', label: 'Recebido', tone: 'green' },
          { value: 'cancelado', label: 'Cancelado', tone: 'red' },
        ],
      },
      {
        name: 'fin_forma_pagamento',
        label: 'Forma de pagamento',
        type: 'select',
        list: false,
        section: 'Financeiro',
        options: [
          { value: 'pix', label: 'Pix' },
          { value: 'cartao_credito', label: 'Cartão de crédito' },
          { value: 'cartao_debito', label: 'Cartão de débito' },
          { value: 'boleto', label: 'Boleto' },
          { value: 'dinheiro', label: 'Dinheiro' },
          { value: 'transferencia', label: 'Transferência' },
          { value: 'outros', label: 'Outros' },
        ],
      },
      { name: 'fin_vencimento', label: 'Vencimento / previsão', type: 'date', list: false, section: 'Financeiro' },
      { name: 'fin_parcelas', label: 'Parcelas', type: 'integer', min: 1, default: 1, list: false, section: 'Financeiro' },
      { name: 'fin_recebido_em', label: 'Recebido em', type: 'date', list: false, section: 'Financeiro' },
      { name: 'fin_documento', label: 'Comprovante / doc.', type: 'text', maxLength: 80, list: false, section: 'Financeiro', placeholder: 'Nº comprovante, código Pix...' },
      { name: 'total', label: 'Total (R$)', type: 'money', readonly: true, hint: 'Calculado a partir dos itens, desconto e frete — nunca é editável.' },
      { name: 'condicao_pagamento', label: 'Condição de pagamento', type: 'text', maxLength: 60, list: false, placeholder: 'À vista, 30/60 dias...' },
      { name: 'desconto', label: 'Desconto (R$)', type: 'money', min: 0, default: 0, list: false },
      { name: 'frete', label: 'Frete (R$)', type: 'money', min: 0, default: 0, list: false },
      { name: 'previsao_entrega', label: 'Previsão de entrega', type: 'date', list: false },
      { name: 'pedido_cliente', label: 'Pedido do cliente', type: 'text', maxLength: 60, list: false, placeholder: 'Número do pedido no cliente' },
      { name: 'local_saida', label: 'Local de saída', type: 'text', maxLength: 60, list: false, hint: 'Local de onde as peças saem no faturamento. Começa no Local padrão, mas você pode escolher outro. Se não houver saldo, tenta o Local padrão.' },
      { name: 'comissao_pct', label: 'Comissão (%)', type: 'percent', readonly: true, form: false },
      { name: 'comissao_valor', label: 'Comissão (R$)', type: 'money', readonly: true, form: false },
      { name: 'faturada_em', label: 'Faturada em', type: 'datetime', readonly: true, form: false },
      // Estado fiscal: persistido apenas pelos endpoints de NF-e (o CRUD descarta
      // estes campos), então a UI nunca mostra "emitida" para o que é simulação.
      {
        name: 'nfe_status',
        label: 'NF-e',
        type: 'select',
        default: 'nao_emitida',
        list: true,
        form: false,
        readonly: true,
        options: [
          { value: 'nao_emitida', label: 'NF-e não emitida', tone: 'slate' },
          { value: 'simulada', label: 'NF-e simulada', tone: 'amber' },
          { value: 'emitida', label: 'NF-e emitida', tone: 'green' },
          { value: 'cancelada', label: 'NF-e cancelada', tone: 'red' },
        ],
      },
      { name: 'nfe_numero', label: 'Número da NF-e', type: 'text', list: false, form: false, readonly: true },
      { name: 'nfe_emitida_em', label: 'NF-e emitida em', type: 'datetime', list: false, form: false, readonly: true },
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

  // ----------------------------------------------------------------
  // Fase 3 — itens de OP por grade e insumos da ficha técnica
  // (internos; manipulados por sub-recursos em producao.ts)
  // ----------------------------------------------------------------
  itens_ordem: {
    key: 'itens_ordem',
    table: 'itens_ordem',
    label: 'Itens da OP (grade)',
    singular: 'Item da OP',
    labelFields: ['id'],
    internal: true,
    ops: READ_ONLY,
    fields: [
      { name: 'ordem_id', label: 'OP', type: 'integer' },
      { name: 'tamanho_id', label: 'Tamanho', type: 'ref', ref: 'tamanhos', required: true },
      { name: 'quantidade', label: 'Quantidade', type: 'integer', required: true, min: 0 },
      { name: 'produzido', label: 'Produzido', type: 'integer', min: 0, default: 0, readonly: true, hint: 'Atualizado ao concluir a OP.' },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true, list: false },
    ],
    orderBy: { field: 'tamanho_id', dir: 'asc' },
  },

  itens_ficha_tecnica: {
    key: 'itens_ficha_tecnica',
    table: 'itens_ficha_tecnica',
    label: 'Insumos da ficha técnica',
    singular: 'Insumo da ficha',
    labelFields: ['id'],
    internal: true,
    ops: READ_ONLY,
    fields: [
      { name: 'ficha_id', label: 'Ficha', type: 'integer' },
      { name: 'insumo_id', label: 'Insumo', type: 'ref', ref: 'insumos', required: true },
      { name: 'consumo', label: 'Consumo por peça', type: 'number', required: true, min: 0.001, hint: 'Ex.: 1.5 m de tecido por peça.' },
      { name: 'perda_pct', label: 'Perda (%)', type: 'percent', min: 0, max: 100, default: 0, hint: 'Acrescenta perda no custo: consumo × (1 + perda/100).' },
    ],
    orderBy: { field: 'id', dir: 'asc' },
  },

  // ----------------------------------------------------------------
  // Fase 3 — Estoque de insumos (módulo público)
  // ----------------------------------------------------------------
  estoque_insumos: {
    key: 'estoque_insumos',
    table: 'estoque_insumos',
    label: 'Estoque de Insumos',
    singular: 'Saldo de insumo',
    labelFields: ['insumo_id'],
    ops: { create: false, update: true, delete: false },
    notice: 'Saldo de matéria-prima. Entradas automáticas: compras recebidas e OPs concluídas consomem. Use "Movimentações de insumos" para lançamentos manuais e edite aqui apenas o estoque mínimo.',
    fields: [
      { name: 'insumo_id', label: 'Insumo', type: 'ref', ref: 'insumos', required: true, search: true, readonly: true },
      { name: 'quantidade', label: 'Saldo', type: 'number', readonly: true, hint: 'Alterado apenas por movimentações (compra, ajuste, consumo de OP).' },
      { name: 'estoque_min', label: 'Estoque mínimo', type: 'number', min: 0, default: 0, hint: 'Abaixo disso o insumo entra em alerta no Dashboard.' },
      { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true, list: false },
    ],
    orderBy: { field: 'insumo_id', dir: 'asc' },
  },

  movimentacoes_insumos: {
    key: 'movimentacoes_insumos',
    table: 'movimentacoes_insumos',
    label: 'Movimentações de Insumos',
    singular: 'Movimentação de insumo',
    labelFields: ['id'],
    ops: { create: true, update: false, delete: false },
    notice: 'Lançamentos manuais de insumos (entrada por compra é automática). Toda movimentação atualiza o saldo e é imutável.',
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
      { name: 'quantidade', label: 'Quantidade', type: 'number', required: true, hint: 'Entrada/saída: positivo. Ajuste: negativo para reduzir o saldo.' },
      { name: 'custo_unitario', label: 'Custo unitário', type: 'money', min: 0, default: 0, hint: 'Usado apenas como histórico.' },
      { name: 'motivo', label: 'Motivo', type: 'text', search: true, maxLength: 200, wide: true },
      { name: 'data', label: 'Data', type: 'datetime', readonly: true },
    ],
    orderBy: { field: 'data', dir: 'desc' },
  },

  // ----------------------------------------------------------------
  // Fase 4 — Inventário
  // ----------------------------------------------------------------
  inventarios: {
    key: 'inventarios',
    table: 'inventarios',
    label: 'Inventários',
    singular: 'Inventário',
    labelFields: ['id'],
    ops: { create: true, update: true, delete: false },
    notice: 'Abrir um inventário congela o saldo do local. A contagem é lançada item a item e o fechamento gera os ajustes automaticamente (somente gerente/admin).',
    fields: [
      { name: 'local', label: 'Local', type: 'text', list: false, maxLength: 60, hint: 'Preenchido automaticamente pelo seletor de local.' },
      { name: 'local_id', label: 'Local', type: 'ref', ref: 'locais', required: true, search: true },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        readonly: true,
        options: [
          { value: 'aberto', label: 'Aberto', tone: 'amber' },
          { value: 'fechado', label: 'Fechado', tone: 'green' },
        ],
      },
      { name: 'aberto_por', label: 'Aberto por', type: 'text', readonly: true },
      { name: 'aberto_em', label: 'Aberto em', type: 'datetime', readonly: true },
      { name: 'fechado_por', label: 'Fechado por', type: 'text', readonly: true, list: false },
      { name: 'fechado_em', label: 'Fechado em', type: 'datetime', readonly: true, list: false },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true },
      ...auditFields,
    ],
    orderBy: { field: 'id', dir: 'desc' },
  },

  itens_inventario: {
    key: 'itens_inventario',
    table: 'itens_inventario',
    label: 'Itens do inventário',
    singular: 'Item do inventário',
    labelFields: ['id'],
    internal: true,
    ops: READ_ONLY,
    fields: [
      { name: 'inventario_id', label: 'Inventário', type: 'integer' },
      { name: 'produto_id', label: 'Produto', type: 'ref', ref: 'produtos', required: true },
      { name: 'tamanho_id', label: 'Tamanho', type: 'ref', ref: 'tamanhos', required: true },
      { name: 'saldo_sistema', label: 'Saldo no sistema', type: 'integer', readonly: true },
      { name: 'contado', label: 'Contado', type: 'integer', min: 0 },
      { name: 'diferenca', label: 'Diferença', type: 'integer', readonly: true },
    ],
    orderBy: { field: 'id', dir: 'asc' },
  },

  // ----------------------------------------------------------------
  // Fase 3A — Políticas comerciais configuráveis por vigência e contexto
  // ----------------------------------------------------------------
  politicas_comerciais: {
    key: 'politicas_comerciais', table: 'politicas_comerciais', label: 'Políticas comerciais', singular: 'Política comercial',
    labelFields: ['nome'], ops: ALL_OPS, minPerfil: 'gerente',
    notice: 'Regras sazonais de preço e pedido. A regra mais específica prevalece: cliente → catálogo → coleção → canal → geral.',
    fields: [
      { name: 'nome', label: 'Nome da política', type: 'text', required: true, search: true, maxLength: 120, wide: true, placeholder: 'Pré-venda Inverno 2027' },
      { name: 'escopo', label: 'Aplicar por', type: 'select', required: true, default: 'geral', options: [
        { value: 'geral', label: 'Regra geral' }, { value: 'canal', label: 'Canal' }, { value: 'colecao', label: 'Coleção' }, { value: 'catalogo', label: 'Catálogo' }, { value: 'cliente', label: 'Cliente específico' }
      ] },
      { name: 'canal', label: 'Canal', type: 'select', options: [{ value: 'todos', label: 'Todos' }, { value: 'varejo', label: 'Varejo' }, { value: 'atacado', label: 'Atacado' }] },
      { name: 'colecao_id', label: 'Coleção', type: 'ref', ref: 'colecoes' },
      { name: 'catalogo_id', label: 'Catálogo', type: 'ref', ref: 'catalogos' },
      { name: 'cliente_id', label: 'Cliente', type: 'ref', ref: 'clientes' },
      { name: 'inicio_em', label: 'Início da vigência', type: 'date' },
      { name: 'fim_em', label: 'Fim da vigência', type: 'date' },
      { name: 'prioridade', label: 'Prioridade', type: 'integer', default: 0, hint: 'Desempata regras do mesmo escopo. Maior número vence.' },
      { name: 'desconto_pct', label: 'Desconto (%)', type: 'percent', default: 0, min: 0, max: 100 },
      { name: 'pedido_min_valor', label: 'Pedido mínimo (R$)', type: 'money', default: 0, min: 0 },
      { name: 'pedido_min_pecas', label: 'Pedido mínimo (peças)', type: 'integer', default: 0, min: 0 },
      { name: 'produto_min_qtd', label: 'Mínimo por produto', type: 'integer', default: 0, min: 0 },
      { name: 'multiplo_qtd', label: 'Múltiplo por item', type: 'integer', default: 1, min: 1 },
      { name: 'reserva_horas', label: 'Reserva após aprovação (horas)', type: 'integer', default: 0, min: 0 },
      ativo, ...auditFields,
    ], orderBy: { field: 'prioridade', dir: 'desc' },
  },

  // ----------------------------------------------------------------
  // Fase 7 — Catálogos públicos
  // ----------------------------------------------------------------
  catalogos: {
    key: 'catalogos',
    table: 'catalogos',
    label: 'Catálogos públicos',
    singular: 'Catálogo',
    labelFields: ['nome'],
    ops: ALL_OPS,
    minPerfil: 'gerente',
    notice: 'Um link público (somente leitura) com os produtos, fotos e preços — para enviar a clientes e representantes pelo WhatsApp.',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, maxLength: 80, placeholder: 'Catálogo Verão 2026 — Representantes' },
      { name: 'token', label: 'Token do link', type: 'text', readonly: true, hint: 'Gerado automaticamente. O link público é /catalogo/<token>.' },
      { name: 'senha', label: 'Senha de acesso (opcional)', type: 'password', virtual: true, list: false, min: 8, hint: 'Se preenchida, quem abrir o link precisará digitar esta senha.' },
      { name: 'colecao_id', label: 'Coleção (filtro)', type: 'ref', ref: 'colecoes', search: true, hint: 'Deixe vazio para todas as coleções.' },
      { name: 'categoria_id', label: 'Categoria (filtro)', type: 'ref', ref: 'categorias', search: true, hint: 'Deixe vazio para todas as categorias.' },
      {
        name: 'canal',
        label: 'Canal do catálogo',
        type: 'select',
        default: 'todos',
        options: [
          { value: 'todos', label: 'Todos (varejo + atacado)', tone: 'blue' },
          { value: 'varejo', label: 'Somente varejo', tone: 'green' },
          { value: 'atacado', label: 'Somente atacado', tone: 'red' },
        ],
      },
      {
        name: 'tabela_preco',
        label: 'Preços exibidos',
        type: 'select',
        default: 'automatico',
        options: [
          { value: 'automatico', label: 'Automático (segue o canal)' },
          { value: 'varejo', label: 'Somente preço de varejo' },
          { value: 'atacado', label: 'Somente preço de atacado' },
          { value: 'ambos', label: 'Varejo e atacado' },
        ],
      },
      { name: 'aceita_pedido_site', label: 'Aceitar pedidos pelo catálogo', type: 'boolean', default: true, hint: 'Permite que o cliente monte o pedido no link público e envie como cotação.' },
      { name: 'como_comprar', label: 'Como comprar / instruções', type: 'textarea', maxLength: 2000, list: false, wide: true, placeholder: 'Ex.: fale com seu representante pelo WhatsApp (11) ... — pedido mínimo 12 peças.' },
      { name: 'mostrar_preco', label: 'Mostrar preço', type: 'boolean', default: true, hint: 'Exibe o preço de venda no catálogo.' },
      { name: 'mostrar_saldo', label: 'Mostrar saldo por tamanho', type: 'boolean', default: false, hint: 'Exibe quantas peças há de cada tamanho (estoque físico).' },
      { name: 'mostrar_medidas', label: 'Mostrar tabela de medidas', type: 'boolean', default: true, hint: 'Exibe, em cada produto, a tabela de medidas da grade (largura, comprimento, manga...) com unidade, instruções de medição e data de atualização. Catálogos novos nascem com esse item ligado.' },
      { name: 'expira_em', label: 'Expira em', type: 'date', hint: 'Opcional: o link deixa de funcionar após esta data.' },
      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
  },

  // ----------------------------------------------------------------
  // FINANÇAS — módulo financeiro ligado a vendas, compras, custos e aportes
  // ----------------------------------------------------------------
  categorias_financeiras: {
    key: 'categorias_financeiras',
    minPerfil: 'gerente',
    table: 'categorias_financeiras',
    label: 'Categorias Financeiras',
    singular: 'Categoria financeira',
    labelFields: ['nome'],
    ops: ALL_OPS,
    notice: 'Classificação dos lançamentos: vendas, compras, folha, aluguel, energia, marketing, aporte de investidor etc.',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, unique: true, search: true, maxLength: 80 },
      {
        name: 'tipo',
        label: 'Tipo',
        type: 'select',
        required: true,
        default: 'despesa',
        options: [
          { value: 'receita', label: 'Receita', tone: 'green' },
          { value: 'despesa', label: 'Despesa', tone: 'red' },
          { value: 'investimento', label: 'Investimento / aporte', tone: 'amber' },
        ],
      },
      {
        name: 'classificacao_dre',
        label: 'Classe na DRE',
        type: 'select',
        default: 'despesas_operacionais',
        section: 'Financeiro',
        options: [
          { value: 'receita', label: 'Receita', tone: 'green' },
          { value: 'cmv', label: 'Custo de mercadoria / insumos', tone: 'amber' },
          { value: 'mao_obra', label: 'Mão de obra / produção', tone: 'amber' },
          { value: 'despesas_operacionais', label: 'Despesas operacionais', tone: 'red' },
          { value: 'despesas_financeiras', label: 'Despesas financeiras / juros', tone: 'red' },
          { value: 'receitas_financeiras', label: 'Receitas financeiras / juros e multa', tone: 'green' },
          { value: 'impostos', label: 'Impostos e taxas', tone: 'red' },
          { value: 'investimento', label: 'Investimento / aporte', tone: 'blue' },
        ],
      },
      { name: 'pai_id', label: 'Categoria-pai', type: 'ref', ref: 'categorias_financeiras', search: true, list: false, hint: 'Plano de contas em dois níveis: ex. "Marketing" (pai) → "Tráfego pago" (filha). Deixe vazio para categoria principal.' },
      { name: 'cor', label: 'Cor', type: 'color', maxLength: 7, list: false },
      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
    mock: [
      { id: 1, nome: 'Vendas pelo site', tipo: 'receita', classificacao_dre: 'receita', ativo: true },
      { id: 2, nome: 'Vendas em balcão', tipo: 'receita', classificacao_dre: 'receita', ativo: true },
      { id: 3, nome: 'Compras de insumos', tipo: 'despesa', classificacao_dre: 'cmv', ativo: true },
      { id: 4, nome: 'Mão de obra / produção', tipo: 'despesa', classificacao_dre: 'mao_obra', ativo: true },
      { id: 5, nome: 'Logística e frete', tipo: 'despesa', classificacao_dre: 'despesas_operacionais', ativo: true },
      { id: 6, nome: 'Marketing e vendas', tipo: 'despesa', classificacao_dre: 'despesas_operacionais', ativo: true },
      { id: 7, nome: 'Aporte de investidor', tipo: 'investimento', classificacao_dre: 'investimento', ativo: true },
      { id: 8, nome: 'Administrativo', tipo: 'despesa', classificacao_dre: 'despesas_operacionais', ativo: true },
    ],
  },

  contas_financeiras: {
    key: 'contas_financeiras',
    minPerfil: 'gerente',
    table: 'contas_financeiras',
    label: 'Contas Financeiras',
    singular: 'Conta financeira',
    labelFields: ['nome'],
    ops: ALL_OPS,
    notice: 'Onde o dinheiro entra e sai: caixa, conta bancária, Pix, cartão. O saldo é calculado com saldo inicial + lançamentos confirmados.',
    fields: [
      { name: 'nome', label: 'Nome da conta', type: 'text', required: true, unique: true, search: true, maxLength: 80, placeholder: 'Caixa, Banco Inter, Pix...' },
      {
        name: 'tipo',
        label: 'Tipo',
        type: 'select',
        required: true,
        default: 'caixa',
        options: [
          { value: 'caixa', label: 'Caixa' },
          { value: 'banco', label: 'Banco' },
          { value: 'pix', label: 'Pix' },
          { value: 'cartao', label: 'Cartão' },
          { value: 'boleto', label: 'Boleto' },
          { value: 'outro', label: 'Outro' },
        ],
      },
      { name: 'saldo_inicial', label: 'Saldo inicial', type: 'money', min: 0, default: 0, hint: 'Saldo na data em que a conta começou a ser usada no sistema.' },
      ativo,
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 500, list: false, wide: true },
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
    mock: [
      { id: 1, nome: 'Caixa', tipo: 'caixa', saldo_inicial: 0, ativo: true },
      { id: 2, nome: 'Pix BROBOND', tipo: 'pix', saldo_inicial: 0, ativo: true },
    ],
  },

  investidores: {
    key: 'investidores',
    table: 'investidores',
    label: 'Investidores / Sócios',
    singular: 'Investidor ou sócio',
    labelFields: ['nome'],
    ops: ALL_OPS,
    minPerfil: 'gerente',
    notice: 'Cadastro dos investidores e sócios para registrar aportes, participação e distribuição de resultados.',
    fields: [
      { name: 'nome', label: 'Nome / Razão social', type: 'text', required: true, search: true, maxLength: 160, wide: true },
      { name: 'cnpj_cpf', label: 'CNPJ / CPF', type: 'document', search: true, maxLength: 20 },
      {
        name: 'tipo',
        label: 'Tipo',
        type: 'select',
        default: 'investidor',
        options: [
          { value: 'investidor', label: 'Investidor', tone: 'blue' },
          { value: 'socio', label: 'Sócio', tone: 'amber' },
          { value: 'emprestador', label: 'Emprestador', tone: 'red' },
        ],
      },
      { name: 'participacao_pct', label: 'Participação (%)', type: 'percent', min: 0, max: 100, default: 0, hint: 'Usada para distribuição de lucros.' },
      { name: 'email', label: 'E-mail', type: 'email', maxLength: 160 },
      { name: 'telefone', label: 'Telefone', type: 'phone', maxLength: 20 },
      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
  },

  aportes: {
    key: 'aportes',
    table: 'aportes',
    label: 'Aportes de Investidores',
    singular: 'Aporte',
    labelFields: ['id'],
    ops: ALL_OPS,
    minPerfil: 'gerente',
    notice: 'Capital inicial, aportes/rodadas, reinvestimento, empréstimo de sócio ou distribuição de lucro. O lançamento financeiro é gerado ao confirmar.',
    fields: [
      { name: 'investidor_id', label: 'Investidor / Sócio', type: 'ref', ref: 'investidores', required: true, search: true },
      { name: 'data', label: 'Data', type: 'date', required: true },
      {
        name: 'tipo',
        label: 'Tipo',
        type: 'select',
        required: true,
        default: 'aporte',
        options: [
          { value: 'capital_inicial', label: 'Capital inicial', tone: 'blue' },
          { value: 'aporte', label: 'Aporte / rodada', tone: 'green' },
          { value: 'reinvestimento', label: 'Reinvestimento', tone: 'amber' },
          { value: 'emprestimo_socio', label: 'Empréstimo de sócio', tone: 'red' },
          { value: 'distribuicao_lucro', label: 'Distribuição de lucro', tone: 'slate' },
        ],
      },
      { name: 'valor', label: 'Valor (R$)', type: 'money', required: true, min: 0 },
      {
        name: 'forma_pagamento',
        label: 'Forma de pagamento',
        type: 'select',
        default: 'pix',
        options: [
          { value: 'pix', label: 'Pix' },
          { value: 'transferencia', label: 'Transferência' },
          { value: 'boleto', label: 'Boleto' },
          { value: 'dinheiro', label: 'Dinheiro' },
          { value: 'outros', label: 'Outros' },
        ],
      },
      { name: 'conta_id', label: 'Conta de destino', type: 'ref', ref: 'contas_financeiras', search: true, section: 'Financeiro' },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        default: 'previsto',
        options: [
          { value: 'previsto', label: 'Previsto', tone: 'amber' },
          { value: 'confirmado', label: 'Confirmado', tone: 'green' },
          { value: 'estornado', label: 'Estornado', tone: 'red' },
        ],
      },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true },
      { name: 'fin_lancamento_id', label: 'Lançamento financeiro', type: 'integer', readonly: true, list: false, form: false },
      ...auditFields,
    ],
    orderBy: { field: 'data', dir: 'desc' },
  },

  lancamentos_financeiros: {
    key: 'lancamentos_financeiros',
    minPerfil: 'gerente',
    table: 'lancamentos_financeiros',
    label: 'Lançamentos Financeiros',
    singular: 'Lançamento financeiro',
    labelFields: ['descricao'],
    ops: ALL_OPS,
    notice: 'Livro-caixa: receitas, despesas, investimentos e estornos. Lançamentos automáticos de vendas, compras e aportes podem ser editados aqui.',
    fields: [
      { name: 'data', label: 'Data', type: 'date', required: true, search: true },
      {
        name: 'tipo',
        label: 'Tipo',
        type: 'select',
        required: true,
        default: 'despesa',
        options: [
          { value: 'receita', label: 'Receita (entrada)', tone: 'green' },
          { value: 'despesa', label: 'Despesa (saída)', tone: 'red' },
          { value: 'investimento', label: 'Investimento / aporte (entrada)', tone: 'amber' },
          { value: 'estorno', label: 'Estorno / cancelamento', tone: 'slate' },
          { value: 'transferencia', label: 'Transferência entre contas (neutra no DRE)', tone: 'blue' },
        ],
      },
      { name: 'categoria_id', label: 'Categoria', type: 'ref', ref: 'categorias_financeiras', search: true },
      { name: 'conta_id', label: 'Conta', type: 'ref', ref: 'contas_financeiras', search: true },
      { name: 'centro_custo_id', label: 'Centro de custo', type: 'ref', ref: 'centros_custo', search: true, list: false, section: 'Gerencial', hint: 'Rateio gerencial: Loja, Produção, Administrativo...' },
      { name: 'descricao', label: 'Descrição', type: 'text', required: true, search: true, maxLength: 200, wide: true },
      { name: 'valor', label: 'Valor bruto (R$)', type: 'money', required: true, min: 0 },
      { name: 'taxa_pct', label: 'Taxa da operadora (%)', type: 'percent', min: 0, max: 99.99, default: 0, list: false, section: 'Gerencial', hint: 'Mercado Pago, cartão etc. O líquido (bruto − taxa) é o que entra na conta.' },
      { name: 'valor_liquido', label: 'Valor líquido (R$)', type: 'money', min: 0, section: 'Gerencial', hint: 'Calculado: valor − taxa. Editável para ajustar centavos.' },
      { name: 'vencimento', label: 'Vencimento', type: 'date', list: false, section: 'Financeiro' },
      { name: 'parcela', label: 'Parcela', type: 'integer', min: 0, default: 1, list: false, section: 'Financeiro' },
      { name: 'total_parcelas', label: 'Total de parcelas', type: 'integer', min: 0, default: 1, list: false, section: 'Financeiro' },
      { name: 'referencia_recorrencia_id', label: 'Recorrência de origem', type: 'integer', list: false, form: false },
      {
        name: 'forma_pagamento',
        label: 'Forma de pagamento',
        type: 'select',
        list: false,
        options: [
          { value: 'pix', label: 'Pix' },
          { value: 'boleto', label: 'Boleto' },
          { value: 'cartao_credito', label: 'Cartão de crédito' },
          { value: 'cartao_debito', label: 'Cartão de débito' },
          { value: 'dinheiro', label: 'Dinheiro' },
          { value: 'transferencia', label: 'Transferência' },
          { value: 'outros', label: 'Outros' },
        ],
      },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        default: 'confirmado',
        options: [
          { value: 'confirmado', label: 'Confirmado', tone: 'green' },
          { value: 'pendente', label: 'Pendente', tone: 'amber' },
          { value: 'cancelado', label: 'Cancelado', tone: 'red' },
        ],
      },
      {
        name: 'referencia_tipo',
        label: 'Referência',
        type: 'select',
        list: false,
        options: [
          { value: 'venda', label: 'Venda' },
          { value: 'compra', label: 'Compra' },
          { value: 'aporte', label: 'Aporte' },
          { value: 'outro', label: 'Outro' },
        ],
      },
      { name: 'referencia_id', label: 'Registro de origem', type: 'integer', list: false },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true },
      ...auditFields,
    ],
    orderBy: { field: 'data', dir: 'desc' },
  },

  // ----------------------------------------------------------------
  // FINANÇAS — Recorrência (aluguel, energia, folha, facção, assinaturas)
  // ----------------------------------------------------------------
  recorrencias_financeiras: {
    key: 'recorrencias_financeiras',
    minPerfil: 'gerente',
    table: 'recorrencias_financeiras',
    label: 'Recorrências Financeiras',
    singular: 'Recorrência financeira',
    labelFields: ['descricao'],
    ops: ALL_OPS,
    notice: 'Despesas ou receitas que se repetem: aluguel, energia, folha, facção, assinaturas. A geração é feita pelo agendador (cron) ou pelo botão "Gerar recorrencias" no Financeiro.',
    fields: [
      { name: 'descricao', label: 'Descrição', type: 'text', required: true, search: true, maxLength: 200, wide: true, placeholder: 'Aluguel da loja, Energia, Folha de costura...' },
      {
        name: 'tipo',
        label: 'Tipo',
        type: 'select',
        required: true,
        default: 'despesa',
        options: [
          { value: 'receita', label: 'Receita', tone: 'green' },
          { value: 'despesa', label: 'Despesa', tone: 'red' },
          { value: 'investimento', label: 'Investimento', tone: 'amber' },
        ],
      },
      { name: 'categoria_id', label: 'Categoria', type: 'ref', ref: 'categorias_financeiras', search: true },
      { name: 'conta_id', label: 'Conta', type: 'ref', ref: 'contas_financeiras', search: true },
      { name: 'centro_custo_id', label: 'Centro de custo', type: 'ref', ref: 'centros_custo', search: true, list: false },
      { name: 'valor', label: 'Valor (R$)', type: 'money', required: true, min: 0 },
      {
        name: 'forma_pagamento',
        label: 'Forma de pagamento',
        type: 'select',
        options: [
          { value: 'pix', label: 'Pix' },
          { value: 'boleto', label: 'Boleto' },
          { value: 'dinheiro', label: 'Dinheiro' },
          { value: 'transferencia', label: 'Transferência' },
          { value: 'outros', label: 'Outros' },
        ],
      },
      {
        name: 'frequencia',
        label: 'Frequência',
        type: 'select',
        required: true,
        default: 'mensal',
        options: [
          { value: 'semanal', label: 'Semanal' },
          { value: 'mensal', label: 'Mensal' },
          { value: 'anual', label: 'Anual' },
        ],
      },
      { name: 'dia', label: 'Dia de geração', type: 'integer', min: 1, max: 31, default: 1, hint: 'Ex.: 1 = todo dia 1, 10 = dia 10 (mensal).' },
      { name: 'proxima_geracao', label: 'Próxima geração', type: 'date', hint: 'Deixe vazio para calcular automaticamente.' },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        default: 'ativo',
        options: [
          { value: 'ativo', label: 'Ativo', tone: 'green' },
          { value: 'inativo', label: 'Inativo', tone: 'amber' },
        ],
      },
      { name: 'ultimo_gerado_em', label: 'Última geração', type: 'datetime', readonly: true, form: false },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true },
      ...auditFields,
    ],
    orderBy: { field: 'descricao', dir: 'asc' },
    mock: [
      { id: 1, descricao: 'Aluguel da loja', tipo: 'despesa', categoria_id: 8, conta_id: 1, valor: 1800, forma_pagamento: 'boleto', frequencia: 'mensal', dia: 5, status: 'ativo' },
      { id: 2, descricao: 'Energia', tipo: 'despesa', categoria_id: 8, conta_id: 1, valor: 320, forma_pagamento: 'boleto', frequencia: 'mensal', dia: 10, status: 'ativo' },
      { id: 3, descricao: 'Facção de costura', tipo: 'despesa', categoria_id: 4, conta_id: 1, valor: 1500, forma_pagamento: 'pix', frequencia: 'mensal', dia: 1, status: 'ativo' },
    ],
  },

  // ----------------------------------------------------------------
  // FINANÇAS — Centros de custo (rateio gerencial) e transferências
  // ----------------------------------------------------------------
  centros_custo: {
    key: 'centros_custo',
    minPerfil: 'gerente',
    table: 'centros_custo',
    label: 'Centros de Custo',
    singular: 'Centro de custo',
    labelFields: ['nome'],
    ops: ALL_OPS,
    notice: 'Rateio gerencial: separa o resultado por área (Loja, Produção/Facção, Administrativo, Marketing...). Vincule nos lançamentos e recorrências.',
    fields: [
      { name: 'codigo', label: 'Código', type: 'text', required: true, unique: true, search: true, maxLength: 20, placeholder: 'LOJA, PROD, ADM...' },
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, maxLength: 80, placeholder: 'Loja, Produção, Administrativo...' },
      { name: 'descricao', label: 'Descrição', type: 'textarea', maxLength: 500, list: false, wide: true },
      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'codigo', dir: 'asc' },
    mock: [
      { id: 1, codigo: 'LOJA', nome: 'Loja / Comercial', ativo: true },
      { id: 2, codigo: 'PROD', nome: 'Produção / Facção', ativo: true },
      { id: 3, codigo: 'ADM', nome: 'Administrativo', ativo: true },
    ],
  },

  transferencias_financeiras: {
    key: 'transferencias_financeiras',
    minPerfil: 'gerente',
    table: 'transferencias_financeiras',
    label: 'Transferências entre Contas',
    singular: 'Transferência',
    labelFields: ['id'],
    ops: ALL_OPS,
    notice:
      'Tira dinheiro de uma conta e coloca em outra (Caixa → Banco Inter, Mercado Pago → Banco Inter...). Gera um par de lançamentos do tipo "transferencia", que não polui receitas nem despesas do DRE. Cancelar uma transferência cancela o par sem apagar o histórico.',
    fields: [
      { name: 'data', label: 'Data', type: 'date', required: true, search: true },
      { name: 'conta_origem_id', label: 'Conta de origem', type: 'ref', ref: 'contas_financeiras', required: true, search: true },
      { name: 'conta_destino_id', label: 'Conta de destino', type: 'ref', ref: 'contas_financeiras', required: true, search: true },
      { name: 'valor', label: 'Valor (R$)', type: 'money', required: true, min: 0 },
      { name: 'descricao', label: 'Descrição', type: 'text', search: true, maxLength: 200, wide: true, placeholder: 'Ex.: depósito do caixa, repasse do Mercado Pago...' },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        default: 'confirmado',
        options: [
          { value: 'confirmado', label: 'Confirmada', tone: 'green' },
          { value: 'cancelado', label: 'Cancelada', tone: 'red' },
        ],
      },
      { name: 'lancamento_saida_id', label: 'Lançamento de saída', type: 'integer', readonly: true, list: false, form: false },
      { name: 'lancamento_entrada_id', label: 'Lançamento de entrada', type: 'integer', readonly: true, list: false, form: false },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true },
      ...auditFields,
    ],
    orderBy: { field: 'data', dir: 'desc' },
    mock: [
      { id: 1, data: '2026-09-01', conta_origem_id: 1, conta_destino_id: 2, valor: 500, descricao: 'Depósito do caixa no banco', status: 'confirmado' },
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

/**
 * Colunas de autenticação que existem no banco mas NÃO aparecem como campos do
 * recurso (segredos/tokens): o store aceita gravá-las via API interna, porém
 * elas jamais voltam em consultas (ver COLUNAS_SECRETAS no pgstore/memdb).
 */
export const COLUNAS_AUTENTICACAO = ['senha_hash', 'senha_historico', 'mfa_secret', 'mfa_backup_hashes', 'convite_token_hash', 'reset_token_hash', 'reset_expira_em', 'token_versao', 'senha_provisoria', 'acesso_certificado_em', 'acesso_certificado_por', 'acesso_certificado_obs'];

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
