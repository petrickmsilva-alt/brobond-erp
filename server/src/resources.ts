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
  | 'uf' // unidade federativa (SP, MG...) — validada contra a lista oficial
  | 'cep' // CEP brasileiro (normalizado para 8 dígitos)
  | 'images' // galeria de fotos do registro (virtual — tabela `arquivos`)
  | 'json'; // coluna JSONB: o valor passa como está (objeto/lista), sem coerção

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
  /**
   * Para `type: 'document'`: restringe o documento aceito. O padrão ('ambos')
   * aceita CPF ou CNPJ. Em qualquer caso o dígito verificador É conferido.
   */
  documento?: 'cpf' | 'cnpj' | 'ambos';
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
  /**
   * MULTIEMPRESA: a tabela tem `empresa_id` e o recurso é isolado por empresa.
   * Toda listagem ganha o filtro da empresa ativa, todo acesso por id é
   * verificado e a empresa é carimbada pelo servidor na criação.
   * Ver server/src/empresa.ts.
   */
  empresa?: boolean;
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

/**
 * Tabelas de trilha (eventos, log, histórico) são APPEND-ONLY: a linha nasce e
 * nunca é editada, então não existe `atualizado_em` no banco. Declarar o campo
 * faria o store tentar selecionar uma coluna que não existe.
 */
const auditAppendOnly: Field[] = [{ name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true, list: false }];

export const PERFIS: FieldOption[] = [
  { value: 'admin', label: 'Administrador', tone: 'amber' },
  { value: 'gerente', label: 'Gerente', tone: 'blue' },
  { value: 'operador', label: 'Operador', tone: 'slate' },
];

/** Indicador da Inscrição Estadual do destinatário (campo indIEDest da NF-e). */
export const INDICADOR_IE: FieldOption[] = [
  { value: '1', label: '1 — Contribuinte de ICMS', tone: 'green' },
  { value: '2', label: '2 — Isento de Inscrição Estadual', tone: 'amber' },
  { value: '9', label: '9 — Não contribuinte', tone: 'slate' },
];

export const PESSOA: FieldOption[] = [
  { value: 'pj', label: 'Pessoa jurídica', tone: 'blue' },
  { value: 'pf', label: 'Pessoa física', tone: 'slate' },
  { value: 'estrangeiro', label: 'Estrangeiro', tone: 'amber' },
];

/** Bloco de endereço reaproveitado por clientes, fornecedores e empresas. */
function camposEndereco(section = 'Endereço'): Field[] {
  return [
    { name: 'cep', label: 'CEP', type: 'cep', maxLength: 9, list: false, section, placeholder: '00000-000', hint: 'Preencha o CEP e use “Buscar CEP” para completar o endereço.' },
    { name: 'logradouro', label: 'Logradouro', type: 'text', maxLength: 160, list: false, wide: true, section },
    { name: 'numero', label: 'Número', type: 'text', maxLength: 20, list: false, section },
    { name: 'complemento', label: 'Complemento', type: 'text', maxLength: 80, list: false, section },
    { name: 'bairro', label: 'Bairro', type: 'text', maxLength: 80, list: false, section },
    { name: 'cidade', label: 'Cidade', type: 'text', maxLength: 80, list: false, search: true, section },
    { name: 'uf', label: 'UF', type: 'uf', maxLength: 2, list: false, section },
    { name: 'codigo_municipio', label: 'Código IBGE do município', type: 'text', maxLength: 7, list: false, section, hint: 'Obrigatório na NF-e. Preenchido pela busca de CEP.' },
  ];
}

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
    // MULTIEMPRESA (Etapa 2.1): o feed filtra pela empresa ativa via
    // aplicarFiltroEmpresa; consolidação segue o privilégio existente.
    empresa: true,
    table: 'auditoria',
    label: 'Auditoria',
    singular: 'Evento',
    labelFields: ['acao', 'recurso'],
    adminOnly: true,
    ops: READ_ONLY,
    notice: 'Registro automático de tudo que é incluído, alterado ou excluído no sistema, e de quem fez.',
    fields: [
      { name: 'data', label: 'Data/hora', type: 'datetime', readonly: true },
      // Somente leitura: carimbada pelo servidor no momento do evento.
      { name: 'empresa_id', label: 'Empresa', type: 'ref', ref: 'empresas', readonly: true },
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
    empresa: true,
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

  // MOTOR ANALÍTICO 1. MEU NEGÓCIOS (migration 0016) — empresas e alíquotas.
  // As vendas multicanal (`sales`) pertencem a uma empresa; os relatórios de
  // BI filtram por empresa_id. A BROBOND é a empresa padrão (id 1), criada
  // pela migration e espelhada no modo demonstração.
  empresas: {
    key: 'empresas',
    table: 'empresas',
    label: 'Empresas',
    singular: 'Empresa',
    labelFields: ['nome'],
    ops: ALL_OPS,
    notice:
      'Empresas do grupo para o motor analítico 1. MEU NEGÓCIOS: cada venda multicanal pertence a uma empresa e os relatórios de BI (margem, curva ABC, dashboard) filtram por ela. A BROBOND (id 1) é a empresa padrão — não a exclua.',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, unique: true, search: true, maxLength: 80, placeholder: 'BROBOND' },
      { name: 'razao_social', label: 'Razão social', type: 'text', maxLength: 140, list: false, wide: true },
      { name: 'nome_fantasia', label: 'Nome fantasia', type: 'text', maxLength: 140, list: false },
      { name: 'cnpj', label: 'CNPJ', type: 'document', documento: 'cnpj', maxLength: 20, list: false, placeholder: '00.000.000/0000-00' },
      { name: 'ie', label: 'Inscrição estadual', type: 'text', maxLength: 30, list: false, section: 'Fiscal' },
      { name: 'im', label: 'Inscrição municipal', type: 'text', maxLength: 30, list: false, section: 'Fiscal' },
      {
        name: 'crt', label: 'Regime tributário (CRT)', type: 'select', list: false, section: 'Fiscal',
        options: [
          { value: '1', label: '1 — Simples Nacional' },
          { value: '2', label: '2 — Simples Nacional, excesso de sublimite' },
          { value: '3', label: '3 — Regime normal' },
        ],
        hint: 'Define se a NF-e sai com CSOSN (Simples) ou CST de ICMS (normal).',
      },
      ...camposEndereco(),
      { name: 'telefone', label: 'Telefone', type: 'phone', maxLength: 20, list: false, section: 'Contato' },
      { name: 'email', label: 'E-mail', type: 'email', maxLength: 160, list: false, section: 'Contato' },
      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
    mock: [{ id: 1, nome: 'BROBOND', razao_social: 'BROBOND CONFECÇÕES LTDA', ativo: true }],
  },

  // Alíquotas de imposto por NCM — alimentam o cálculo de lucro bruto real
  // (imposto = Σ subtotal do item × alíquota do NCM do produto).
  impostos_ncm: {
    key: 'impostos_ncm',
    table: 'impostos_ncm',
    label: 'Alíquotas por NCM',
    singular: 'Alíquota NCM',
    labelFields: ['ncm'],
    ops: ALL_OPS,
    minPerfil: 'gerente',
    notice:
      'Alíquotas usadas pelo motor 1. MEU NEGÓCIOS para calcular os impostos de cada venda: a chave é o NCM do produto (apenas dígitos). Cadastre o NCM completo (8 dígitos, ex.: 61091000), um prefixo (6 ou 4 ou 2 dígitos, ex.: 6109 ou 61) ou DEIXE VAZIO para definir a alíquota padrão dos NCMs não cadastrados. O motor aplica sempre a chave mais longa que casa com o NCM do produto; sem nenhuma, o imposto é 0%.',
    fields: [
      {
        name: 'ncm',
        label: 'NCM (chave)',
        type: 'text',
        maxLength: 8,
        unique: true,
        search: true,
        pattern: '^(|[0-9]{2,8})$',
        patternMessage: 'NCM inválido: use apenas dígitos (2 a 8) ou deixe vazio para a alíquota padrão.',
        placeholder: '61091000, 6109, 61... (vazio = padrão)',
        hint: 'Chave de casamento com o NCM do produto. Vazio = alíquota padrão para NCMs sem cadastro.',
      },
      { name: 'descricao', label: 'Descrição', type: 'text', maxLength: 120, placeholder: 'Camisetas de malha de algodão — carga tributária' },
      { name: 'aliquota_pct', label: 'Alíquota (%)', type: 'percent', required: true, min: 0, max: 100, default: 0, hint: 'Percentual aplicado sobre o subtotal de cada item com este NCM.' },
      ...auditFields,
    ],
    orderBy: { field: 'ncm', dir: 'asc' },
  },

  // MULTIEMPRESA — empresas que cada usuário pode acessar. Interno: a
  // concessão é administrada pelos endpoints /api/empresas/*, não por CRUD
  // genérico (conceder empresa é decisão de segurança, não de cadastro).
  usuario_empresas: {
    key: 'usuario_empresas',
    table: 'usuario_empresas',
    label: 'Acesso a empresas',
    singular: 'Acesso a empresa',
    labelFields: ['id'],
    internal: true,
    ops: ALL_OPS,
    adminOnly: true,
    fields: [
      { name: 'usuario_id', label: 'Usuário', type: 'ref', ref: 'usuarios', required: true },
      { name: 'empresa_id', label: 'Empresa', type: 'ref', ref: 'empresas', required: true },
      ...auditFields,
    ],
    orderBy: { field: 'id', dir: 'asc' },
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
    empresa: true,
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
    empresa: true,
    table: 'fornecedores',
    label: 'Fornecedores',
    singular: 'Fornecedor',
    labelFields: ['nome'],
    ops: ALL_OPS,
    fields: [
      { name: 'nome', label: 'Razão social / Nome', type: 'text', required: true, search: true, maxLength: 160, wide: true },
      { name: 'pessoa', label: 'Tipo de pessoa', type: 'select', required: true, default: 'pj', options: PESSOA },
      { name: 'cnpj', label: 'CNPJ / CPF', type: 'document', search: true, maxLength: 20 },
      { name: 'razao_social', label: 'Razão social', type: 'text', maxLength: 160, list: false, wide: true, search: true },
      { name: 'nome_fantasia', label: 'Nome fantasia', type: 'text', maxLength: 160, list: false, search: true },

      // ---------------- Fiscal (necessário na NF-e de entrada) ----------------
      { name: 'ie', label: 'Inscrição estadual', type: 'text', maxLength: 30, list: false, search: true, section: 'Fiscal' },
      { name: 'indicador_ie', label: 'Indicador de IE', type: 'select', required: true, default: '1', list: false, section: 'Fiscal', options: INDICADOR_IE },
      { name: 'im', label: 'Inscrição municipal', type: 'text', maxLength: 30, list: false, section: 'Fiscal' },

      ...camposEndereco(),

      // ---------------- Contato ----------------
      { name: 'contato', label: 'Pessoa de contato', type: 'text', maxLength: 80, section: 'Contato' },
      { name: 'telefone', label: 'Telefone', type: 'phone', maxLength: 20, section: 'Contato' },
      { name: 'whatsapp', label: 'WhatsApp', type: 'phone', maxLength: 20, list: false, section: 'Contato' },
      { name: 'email', label: 'E-mail', type: 'email', maxLength: 160, section: 'Contato' },

      // ---------------- Comercial ----------------
      { name: 'prazo_entrega_dias', label: 'Prazo de entrega (dias)', type: 'integer', min: 0, list: false, section: 'Comercial' },
      { name: 'condicao_pagamento', label: 'Condição de pagamento', type: 'text', maxLength: 60, list: false, section: 'Comercial', placeholder: '30/60/90 dias' },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true, section: 'Comercial' },

      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
  },

  // Contatos adicionais do fornecedor (compras, financeiro, expedição).
  fornecedor_contatos: {
    key: 'fornecedor_contatos',
    table: 'fornecedor_contatos',
    label: 'Contatos do fornecedor',
    singular: 'Contato do fornecedor',
    labelFields: ['nome'],
    empresa: true,
    ops: ALL_OPS,
    internal: true,
    fields: [
      { name: 'fornecedor_id', label: 'Fornecedor', type: 'ref', ref: 'fornecedores', required: true, search: true },
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, maxLength: 120 },
      { name: 'cargo', label: 'Cargo / Setor', type: 'text', maxLength: 60 },
      { name: 'email', label: 'E-mail', type: 'email', maxLength: 160 },
      { name: 'telefone', label: 'Telefone', type: 'phone', maxLength: 20 },
      { name: 'whatsapp', label: 'WhatsApp', type: 'phone', maxLength: 20 },
      { name: 'principal', label: 'Contato principal', type: 'boolean', default: false },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 1000, list: false, wide: true },
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
  },

  insumos: {
    key: 'insumos',
    empresa: true,
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
    empresa: true,
    table: 'representantes',
    label: 'Representantes',
    singular: 'Representante',
    labelFields: ['nome'],
    ops: ALL_OPS,
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, maxLength: 120, wide: true },
      { name: 'cpf', label: 'CPF', type: 'document', documento: 'cpf', search: true, maxLength: 14 },
      { name: 'cargo', label: 'Cargo', type: 'text', maxLength: 60, search: true, placeholder: 'Vendedor, Representante, Gerente comercial...' },
      { name: 'regiao', label: 'Região', type: 'text', search: true, maxLength: 80 },
      { name: 'comissao_pct', label: 'Comissão padrão (%)', type: 'percent', min: 0, max: 100, default: 0, hint: 'A comissão é paga sobre faturas efetivamente LIQUIDADAS, não sobre a venda criada.' },
      { name: 'usuario_id', label: 'Usuário do sistema', type: 'ref', ref: 'usuarios', list: false, search: true, section: 'Acesso', hint: 'Vincule para que a pessoa veja as próprias vendas e comissões ao entrar no ERP.' },
      { name: 'telefone', label: 'Telefone', type: 'phone', maxLength: 20, section: 'Contato' },
      { name: 'whatsapp', label: 'WhatsApp', type: 'phone', maxLength: 20, list: false, section: 'Contato' },
      { name: 'email', label: 'E-mail', type: 'email', maxLength: 160, section: 'Contato' },
      { name: 'admissao', label: 'Admissão', type: 'date', list: false, section: 'Situação' },
      { name: 'desligamento', label: 'Desligamento', type: 'date', list: false, section: 'Situação', hint: 'Preencher aqui NÃO apaga o histórico de vendas nem as comissões já apuradas.' },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true, section: 'Situação' },
      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
  },

  clientes: {
    key: 'clientes',
    empresa: true,
    table: 'clientes',
    label: 'Clientes',
    singular: 'Cliente',
    labelFields: ['nome'],
    ops: ALL_OPS,
    fields: [
      { name: 'nome', label: 'Nome / Razão social', type: 'text', required: true, search: true, maxLength: 160, wide: true },
      { name: 'pessoa', label: 'Tipo de pessoa', type: 'select', required: true, default: 'pj', options: PESSOA },
      { name: 'cnpj_cpf', label: 'CNPJ / CPF', type: 'document', search: true, maxLength: 20, hint: 'O dígito verificador é conferido no cadastro — documento inválido é recusado pela SEFAZ na hora de faturar.' },
      { name: 'razao_social', label: 'Razão social', type: 'text', maxLength: 160, list: false, wide: true, search: true },
      { name: 'nome_fantasia', label: 'Nome fantasia', type: 'text', maxLength: 160, list: false, search: true },
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

      // ---------------- Fiscal ----------------
      { name: 'rg_ie', label: 'RG / Inscrição estadual', type: 'text', maxLength: 30, list: false, search: true, section: 'Fiscal' },
      { name: 'indicador_ie', label: 'Indicador de IE', type: 'select', required: true, default: '9', list: false, section: 'Fiscal', options: INDICADOR_IE, hint: 'Campo indIEDest da NF-e. Errar aqui é a rejeição mais comum em venda para empresa.' },
      { name: 'im', label: 'Inscrição municipal', type: 'text', maxLength: 30, list: false, section: 'Fiscal' },
      { name: 'suframa', label: 'SUFRAMA', type: 'text', maxLength: 20, list: false, section: 'Fiscal' },

      ...camposEndereco(),

      // ---------------- Contato ----------------
      { name: 'telefone', label: 'Telefone', type: 'phone', maxLength: 20, section: 'Contato' },
      { name: 'whatsapp', label: 'WhatsApp', type: 'phone', maxLength: 20, list: false, section: 'Contato' },
      { name: 'email', label: 'E-mail', type: 'email', maxLength: 160, section: 'Contato' },

      // ---------------- Comercial ----------------
      { name: 'limite_credito', label: 'Limite de crédito', type: 'money', min: 0, default: 0, list: false, section: 'Comercial', hint: 'Zero = sem limite definido.' },
      { name: 'representante_id', label: 'Vendedor padrão', type: 'ref', ref: 'representantes', list: false, search: true, section: 'Comercial' },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true, section: 'Comercial' },

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
    empresa: true,
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
      { name: 'descricao_curta', label: 'Descrição curta', type: 'text', maxLength: 180, list: false, wide: true, section: 'Identificação e catálogo', hint: 'Uma linha — usada em listas, marketplaces e no PDV.' },
      { name: 'marca', label: 'Marca', type: 'text', maxLength: 60, list: false, search: true, section: 'Identificação e catálogo' },
      { name: 'tags', label: 'Tags', type: 'text', maxLength: 240, list: false, wide: true, search: true, section: 'Identificação e catálogo', placeholder: 'verão, básico, promoção', hint: 'Separe por vírgula. Ajuda na busca e nos filtros.' },
      { name: 'observacoes_internas', label: 'Observações internas', type: 'textarea', maxLength: 2000, list: false, wide: true, section: 'Identificação e catálogo', hint: 'Nunca sai em catálogo, proposta ou nota — é só para a equipe.' },

      // ---------------- Classificação ----------------
      {
        name: 'formato', label: 'Formato', type: 'select', default: 'simples', section: 'Classificação',
        hint: 'Com variação, o produto vira um PAI e cada combinação (cor × tamanho) ganha o próprio SKU e o próprio estoque.',
        options: [
          { value: 'simples', label: 'Simples', tone: 'slate' },
          { value: 'variacao', label: 'Com variação / grade', tone: 'blue' },
          { value: 'kit', label: 'Composição / kit', tone: 'amber' },
        ],
      },
      {
        name: 'tipo', label: 'Tipo de produto', type: 'select', default: 'mercadoria', list: false, section: 'Classificação',
        options: [
          { value: 'mercadoria', label: 'Mercadoria para revenda' },
          { value: 'materia_prima', label: 'Matéria-prima' },
          { value: 'produto_acabado', label: 'Produto acabado' },
          { value: 'embalagem', label: 'Embalagem' },
          { value: 'servico', label: 'Serviço' },
          { value: 'outro', label: 'Outro' },
        ],
      },
      {
        name: 'condicao', label: 'Condição', type: 'select', default: 'novo', list: false, section: 'Classificação',
        options: [
          { value: 'novo', label: 'Novo' },
          { value: 'usado', label: 'Usado' },
          { value: 'recondicionado', label: 'Recondicionado' },
        ],
      },
      {
        name: 'producao', label: 'Produção', type: 'select', default: 'propria', list: false, section: 'Classificação',
        options: [
          { value: 'propria', label: 'Própria' },
          { value: 'terceiros', label: 'Terceiros' },
        ],
      },
      { name: 'unidade', label: 'Unidade de medida', type: 'select', default: 'un', list: false, section: 'Classificação', options: UNIDADES },
      { name: 'produto_pai_id', label: 'Produto pai', type: 'ref', ref: 'produtos', list: false, readonly: true, form: false, section: 'Classificação', hint: 'Preenchido automaticamente nas variações geradas a partir do produto pai.' },
      { name: 'variacao_chave', label: 'Variação', type: 'text', maxLength: 120, list: false, readonly: true, form: false, section: 'Classificação' },
      { name: 'variacao_tamanho_id', label: 'Tamanho da variação', type: 'ref', ref: 'tamanhos', list: false, readonly: true, form: false, section: 'Classificação' },

      // ---------------- Fiscal ----------------
      { name: 'ncm', label: 'NCM', type: 'text', maxLength: 10, list: false, placeholder: '6205.20.00', hint: 'Classificação fiscal — obrigatória na NF-e.', section: 'Fiscal' },
      { name: 'cest', label: 'CEST', type: 'text', maxLength: 10, list: false, placeholder: '28.038.00', section: 'Fiscal', hint: 'Obrigatório quando o produto está sujeito a substituição tributária.' },
      {
        name: 'origem', label: 'Origem da mercadoria', type: 'select', default: '0', list: false, section: 'Fiscal',
        options: [
          { value: '0', label: '0 — Nacional' },
          { value: '1', label: '1 — Estrangeira, importação direta' },
          { value: '2', label: '2 — Estrangeira, adquirida no mercado interno' },
          { value: '3', label: '3 — Nacional, conteúdo de importação > 40%' },
          { value: '4', label: '4 — Nacional, processos produtivos básicos' },
          { value: '5', label: '5 — Nacional, conteúdo de importação <= 40%' },
          { value: '6', label: '6 — Estrangeira, importação direta sem similar nacional' },
          { value: '7', label: '7 — Estrangeira, mercado interno sem similar nacional' },
          { value: '8', label: '8 — Nacional, conteúdo de importação > 70%' },
        ],
      },
      { name: 'cfop_saida', label: 'CFOP padrão de saída', type: 'text', maxLength: 4, list: false, section: 'Fiscal', placeholder: '5102', pattern: '^(|[0-9]{4})$', patternMessage: 'CFOP tem 4 dígitos (ex.: 5102)', hint: 'Deixe vazio para usar a regra fiscal da empresa.' },
      { name: 'icms_cst', label: 'CST/CSOSN do ICMS', type: 'text', maxLength: 4, list: false, section: 'Fiscal' },
      { name: 'icms_aliquota', label: 'ICMS (%)', type: 'percent', min: 0, max: 100, list: false, section: 'Fiscal' },
      { name: 'pis_cst', label: 'CST do PIS', type: 'text', maxLength: 3, list: false, section: 'Fiscal' },
      { name: 'pis_aliquota', label: 'PIS (%)', type: 'percent', min: 0, max: 100, list: false, section: 'Fiscal' },
      { name: 'cofins_cst', label: 'CST do COFINS', type: 'text', maxLength: 3, list: false, section: 'Fiscal' },
      { name: 'cofins_aliquota', label: 'COFINS (%)', type: 'percent', min: 0, max: 100, list: false, section: 'Fiscal' },
      { name: 'ipi_cst', label: 'CST do IPI', type: 'text', maxLength: 3, list: false, section: 'Fiscal' },
      { name: 'ipi_aliquota', label: 'IPI (%)', type: 'percent', min: 0, max: 100, list: false, section: 'Fiscal' },
      { name: 'gtin_tributario', label: 'GTIN tributário', type: 'text', maxLength: 14, list: false, section: 'Fiscal', pattern: '^(|\\d{8}|\\d{12,14})$', patternMessage: 'Informe 8, 12, 13 ou 14 dígitos', hint: 'Normalmente igual ao GTIN/EAN; difere em produtos vendidos por fração ou caixa.' },

      // ---------------- Logística ----------------
      { name: 'peso_g', label: 'Peso (g) — legado', type: 'integer', min: 0, list: false, form: false, section: 'Logística' },
      { name: 'peso_liquido_g', label: 'Peso líquido (g)', type: 'integer', min: 0, list: false, section: 'Logística' },
      { name: 'peso_bruto_g', label: 'Peso bruto (g)', type: 'integer', min: 0, list: false, section: 'Logística', hint: 'Com embalagem — é este que a transportadora cobra.' },
      { name: 'largura_mm', label: 'Largura (mm)', type: 'integer', min: 0, list: false, section: 'Logística' },
      { name: 'altura_mm', label: 'Altura (mm)', type: 'integer', min: 0, list: false, section: 'Logística' },
      { name: 'profundidade_mm', label: 'Profundidade (mm)', type: 'integer', min: 0, list: false, section: 'Logística' },
      { name: 'volumes', label: 'Volumes', type: 'integer', min: 1, default: 1, list: false, section: 'Logística' },
      { name: 'itens_por_caixa', label: 'Itens por caixa', type: 'integer', min: 0, list: false, section: 'Logística' },

      // ---------------- Estoque e suprimento ----------------
      { name: 'estoque_min', label: 'Estoque mínimo', type: 'integer', min: 0, default: 0, list: false, section: 'Estoque e suprimento', hint: 'Dispara alerta e alimenta a sugestão de compra.' },
      { name: 'estoque_max', label: 'Estoque máximo', type: 'integer', min: 0, list: false, section: 'Estoque e suprimento', hint: 'Teto de reposição. Precisa ser maior ou igual ao mínimo.' },
      { name: 'localizacao', label: 'Localização física', type: 'text', maxLength: 60, list: false, section: 'Estoque e suprimento', placeholder: 'Corredor B, prateleira 3' },
      { name: 'fornecedor_id', label: 'Fornecedor principal', type: 'ref', ref: 'fornecedores', list: false, search: true, section: 'Estoque e suprimento' },
      { name: 'codigo_fornecedor', label: 'Código no fornecedor', type: 'text', maxLength: 60, list: false, search: true, section: 'Estoque e suprimento', hint: 'Usado no de-para da NF-e de entrada.' },
      { name: 'custo_habitual', label: 'Custo habitual', type: 'money', min: 0, default: 0, list: false, section: 'Estoque e suprimento', hint: 'Referência de compra. O custo que valoriza o estoque continua sendo “Custo unitário”.' },

      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'nome', dir: 'asc' },
  },

  // Componentes de um produto formato='kit'.
  produto_composicao: {
    key: 'produto_composicao',
    table: 'produto_composicao',
    label: 'Composição do produto',
    singular: 'Componente',
    labelFields: ['id'],
    internal: true,
    empresa: true,
    ops: ALL_OPS,
    fields: [
      { name: 'produto_id', label: 'Kit', type: 'ref', ref: 'produtos', required: true },
      { name: 'componente_id', label: 'Componente', type: 'ref', ref: 'produtos', required: true },
      { name: 'quantidade', label: 'Quantidade', type: 'number', required: true, min: 0.001, default: 1 },
      ...auditFields,
    ],
    orderBy: { field: 'id', dir: 'asc' },
  },

  // Regras fiscais — a camada extensível que evita alíquota hardcoded.
  regras_fiscais: {
    key: 'regras_fiscais',
    table: 'regras_fiscais',
    label: 'Regras fiscais',
    singular: 'Regra fiscal',
    labelFields: ['nome'],
    empresa: true,
    ops: ALL_OPS,
    minPerfil: 'gerente',
    notice:
      'Regras resolvem a tributação da NF-e/NFC-e quando o produto não define a sua. Os campos em branco são CURINGA (valem para tudo). O motor aplica a regra MAIS ESPECÍFICA: maior prioridade, depois NCM mais longo, depois UF específica antes de curinga. Nada aqui altera o cálculo de margem do módulo 1. MEU NEGÓCIOS, que continua usando as Alíquotas por NCM.',
    fields: [
      { name: 'nome', label: 'Nome da regra', type: 'text', required: true, search: true, maxLength: 120, wide: true, placeholder: 'Venda interna SP — vestuário' },
      { name: 'ncm', label: 'NCM (prefixo)', type: 'text', maxLength: 8, search: true, section: 'Quando aplicar', pattern: '^(|[0-9]{2,8})$', patternMessage: 'Use de 2 a 8 dígitos, ou deixe vazio', hint: 'Vazio = qualquer NCM.' },
      { name: 'uf_destino', label: 'UF de destino', type: 'uf', section: 'Quando aplicar', hint: 'Vazio = qualquer UF.' },
      { name: 'operacao', label: 'Operação', type: 'select', required: true, default: 'saida', section: 'Quando aplicar', options: [ { value: 'saida', label: 'Saída' }, { value: 'entrada', label: 'Entrada' } ] },
      { name: 'modelo', label: 'Modelo do documento', type: 'select', section: 'Quando aplicar', options: [ { value: '55', label: 'NF-e (55)' }, { value: '65', label: 'NFC-e (65)' } ], hint: 'Vazio = vale para os dois.' },
      { name: 'consumidor_final', label: 'Somente consumidor final', type: 'boolean', list: false, section: 'Quando aplicar' },
      { name: 'regime', label: 'Regime tributário (CRT)', type: 'select', list: false, section: 'Quando aplicar', options: [ { value: '1', label: '1 — Simples Nacional' }, { value: '2', label: '2 — Simples Nacional, excesso de sublimite' }, { value: '3', label: '3 — Regime normal' } ] },
      { name: 'cfop', label: 'CFOP', type: 'text', maxLength: 4, section: 'Resultado', pattern: '^(|[0-9]{4})$', patternMessage: 'CFOP tem 4 dígitos' },
      { name: 'icms_cst', label: 'CST do ICMS', type: 'text', maxLength: 3, list: false, section: 'Resultado' },
      { name: 'csosn', label: 'CSOSN (Simples)', type: 'text', maxLength: 4, list: false, section: 'Resultado' },
      { name: 'icms_aliquota', label: 'ICMS (%)', type: 'percent', min: 0, max: 100, section: 'Resultado' },
      { name: 'icms_reducao_pct', label: 'Redução da base de ICMS (%)', type: 'percent', min: 0, max: 100, list: false, section: 'Resultado' },
      { name: 'icms_mod_bc', label: 'Modalidade da base do ICMS', type: 'text', maxLength: 2, list: false, section: 'Resultado' },
      { name: 'pis_cst', label: 'CST do PIS', type: 'text', maxLength: 3, list: false, section: 'Resultado' },
      { name: 'pis_aliquota', label: 'PIS (%)', type: 'percent', min: 0, max: 100, list: false, section: 'Resultado' },
      { name: 'cofins_cst', label: 'CST do COFINS', type: 'text', maxLength: 3, list: false, section: 'Resultado' },
      { name: 'cofins_aliquota', label: 'COFINS (%)', type: 'percent', min: 0, max: 100, list: false, section: 'Resultado' },
      { name: 'ipi_cst', label: 'CST do IPI', type: 'text', maxLength: 3, list: false, section: 'Resultado' },
      { name: 'ipi_aliquota', label: 'IPI (%)', type: 'percent', min: 0, max: 100, list: false, section: 'Resultado' },
      { name: 'prioridade', label: 'Prioridade', type: 'integer', default: 0, section: 'Governança', hint: 'Maior vence. Use para forçar uma exceção sobre a regra geral.' },
      { name: 'vigencia_inicio', label: 'Vigência — início', type: 'date', list: false, section: 'Governança' },
      { name: 'vigencia_fim', label: 'Vigência — fim', type: 'date', list: false, section: 'Governança' },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true, section: 'Governança' },
      ativo,
      ...auditFields,
    ],
    orderBy: { field: 'prioridade', dir: 'desc' },
  },

  // Configuração de emissão por empresa. Os tokens ficam CIFRADOS e nunca
  // voltam pela API — por isso só a API dedicada (/api/fiscal/config) escreve
  // aqui; o CRUD genérico fica fora de alcance (internal).
  empresa_fiscal_config: {
    key: 'empresa_fiscal_config',
    table: 'empresa_fiscal_config',
    label: 'Configuração fiscal',
    singular: 'Configuração fiscal',
    labelFields: ['provider'],
    ops: { create: false, update: false, delete: false },
    internal: true,
    adminOnly: true,
    fields: [
      { name: 'empresa_id', label: 'Empresa', type: 'ref', ref: 'empresas' },
      { name: 'provider', label: 'Provedor', type: 'text', maxLength: 20 },
      { name: 'ambiente', label: 'Ambiente', type: 'text', maxLength: 20 },
      { name: 'provider_base_url', label: 'URL base', type: 'text', maxLength: 200 },
      // Colunas de segredo: declaradas para que a camada de persistência saiba
      // gravá-las, mas inalcançáveis pela API — o recurso é `internal` e
      // `ops` nega tudo. Só `fiscal.ts` lê, e ele devolve apenas a máscara.
      { name: 'provider_token_cifrado', label: 'Token do provedor (cifrado)', type: 'text', list: false, form: false },
      { name: 'certificado_senha_cifrada', label: 'Senha do certificado (cifrada)', type: 'text', list: false, form: false },
      { name: 'csc_token_cifrado', label: 'CSC (cifrado)', type: 'text', list: false, form: false },
      { name: 'certificado_ref', label: 'Referência do certificado', type: 'text', maxLength: 200 },
      { name: 'certificado_validade', label: 'Validade do certificado', type: 'date' },
      { name: 'csc_id', label: 'ID do CSC', type: 'text', maxLength: 20 },
      { name: 'serie_nfe', label: 'Série NF-e', type: 'integer' },
      { name: 'proximo_numero_nfe', label: 'Próximo número NF-e', type: 'integer' },
      { name: 'serie_nfce', label: 'Série NFC-e', type: 'integer' },
      { name: 'proximo_numero_nfce', label: 'Próximo número NFC-e', type: 'integer' },
      { name: 'natureza_operacao_padrao', label: 'Natureza da operação padrão', type: 'text', maxLength: 120 },
      { name: 'cfop_padrao_dentro_uf', label: 'CFOP dentro do estado', type: 'text', maxLength: 4 },
      { name: 'cfop_padrao_fora_uf', label: 'CFOP fora do estado', type: 'text', maxLength: 4 },
      { name: 'habilitado', label: 'Emissão habilitada', type: 'boolean' },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true },
      { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true },
    ],
    orderBy: { field: 'empresa_id', dir: 'asc' },
  },

  // Documentos fiscais: leitura pela UI, escrita SÓ pela máquina de estados
  // de fiscal.ts. Por isso `ops` nega create/update/delete no CRUD genérico.
  documentos_fiscais: {
    key: 'documentos_fiscais',
    table: 'documentos_fiscais',
    label: 'Documentos fiscais',
    singular: 'Documento fiscal',
    labelFields: ['numero'],
    empresa: true,
    ops: { create: false, update: false, delete: false },
    notice:
      'Somente leitura. O documento é criado e alterado pelo fluxo de emissão (Venda → Emitir NF-e). Status “autorizado” só existe com chave e protocolo devolvidos pela SEFAZ através do provedor.',
    fields: [
      { name: 'venda_id', label: 'Venda', type: 'ref', ref: 'vendas', search: true },
      { name: 'modelo', label: 'Modelo', type: 'select', options: [ { value: '55', label: 'NF-e (55)' }, { value: '65', label: 'NFC-e (65)' } ] },
      { name: 'operacao', label: 'Operação', type: 'select', options: [ { value: 'saida', label: 'Saída' }, { value: 'entrada', label: 'Entrada' } ] },
      { name: 'natureza_operacao', label: 'Natureza da operação', type: 'text', maxLength: 120, list: false },
      {
        name: 'status', label: 'Status', type: 'select',
        options: [
          { value: 'rascunho', label: 'Rascunho', tone: 'slate' },
          { value: 'pendente', label: 'Pendente', tone: 'amber' },
          { value: 'processando', label: 'Processando', tone: 'blue' },
          { value: 'autorizado', label: 'Autorizado', tone: 'green' },
          { value: 'rejeitado', label: 'Rejeitado', tone: 'red' },
          { value: 'cancelado', label: 'Cancelado', tone: 'red' },
          { value: 'inutilizado', label: 'Inutilizado', tone: 'slate' },
          { value: 'erro', label: 'Erro', tone: 'red' },
        ],
      },
      { name: 'motivo', label: 'Motivo', type: 'textarea', list: false, wide: true },
      { name: 'serie', label: 'Série', type: 'integer' },
      { name: 'numero', label: 'Número', type: 'integer', search: true },
      { name: 'chave_acesso', label: 'Chave de acesso', type: 'text', maxLength: 44, search: true, wide: true },
      { name: 'protocolo', label: 'Protocolo', type: 'text', maxLength: 40, list: false },
      { name: 'autorizado_em', label: 'Autorizado em', type: 'datetime' },
      { name: 'cancelado_em', label: 'Cancelado em', type: 'datetime', list: false },
      { name: 'cancelamento_protocolo', label: 'Protocolo do cancelamento', type: 'text', maxLength: 40, list: false },
      { name: 'cancelamento_justificativa', label: 'Justificativa do cancelamento', type: 'textarea', list: false, wide: true },
      { name: 'provider', label: 'Provedor', type: 'text', maxLength: 20 },
      { name: 'provider_ref', label: 'Referência no provedor', type: 'text', maxLength: 120, list: false },
      { name: 'ambiente', label: 'Ambiente', type: 'select', options: [ { value: 'homologacao', label: 'Homologação', tone: 'amber' }, { value: 'producao', label: 'Produção', tone: 'green' } ] },
      { name: 'danfe_url', label: 'DANFE', type: 'text', maxLength: 400, list: false },
      { name: 'valor_produtos', label: 'Produtos', type: 'money', list: false },
      { name: 'valor_frete', label: 'Frete', type: 'money', list: false },
      { name: 'valor_desconto', label: 'Desconto', type: 'money', list: false },
      { name: 'valor_total', label: 'Total', type: 'money' },
      { name: 'valor_icms', label: 'ICMS', type: 'money', list: false },
      { name: 'valor_pis', label: 'PIS', type: 'money', list: false },
      { name: 'valor_cofins', label: 'COFINS', type: 'money', list: false },
      { name: 'valor_ipi', label: 'IPI', type: 'money', list: false },
      { name: 'tentativas', label: 'Tentativas', type: 'integer', list: false },
      { name: 'estoque_baixado_em', label: 'Estoque baixado em', type: 'datetime', list: false },
      { name: 'financeiro_lancado_em', label: 'Financeiro lançado em', type: 'datetime', list: false },
      { name: 'idempotency_key', label: 'Chave de idempotência', type: 'text', maxLength: 120, list: false },
      { name: 'criado_por', label: 'Criado por', type: 'ref', ref: 'usuarios', list: false },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true },
      { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true },
    ],
    orderBy: { field: 'id', dir: 'desc' },
  },

  documentos_fiscais_eventos: {
    key: 'documentos_fiscais_eventos',
    table: 'documentos_fiscais_eventos',
    label: 'Eventos do documento fiscal',
    singular: 'Evento fiscal',
    labelFields: ['evento'],
    empresa: true,
    ops: { create: false, update: false, delete: false },
    internal: true,
    fields: [
      { name: 'documento_id', label: 'Documento', type: 'ref', ref: 'documentos_fiscais', required: true },
      { name: 'de_status', label: 'De', type: 'text', maxLength: 20 },
      { name: 'para_status', label: 'Para', type: 'text', maxLength: 20, required: true },
      { name: 'evento', label: 'Evento', type: 'text', maxLength: 20, required: true },
      { name: 'mensagem', label: 'Mensagem', type: 'textarea', wide: true },
      { name: 'payload', label: 'Resposta do provedor', type: 'textarea', list: false, wide: true },
      { name: 'usuario_id', label: 'Usuário', type: 'ref', ref: 'usuarios' },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true },
    ],
    orderBy: { field: 'id', dir: 'desc' },
  },

  inutilizacoes_fiscais: {
    key: 'inutilizacoes_fiscais',
    table: 'inutilizacoes_fiscais',
    label: 'Inutilizações de numeração',
    singular: 'Inutilização',
    labelFields: ['serie'],
    empresa: true,
    ops: { create: false, update: false, delete: false },
    minPerfil: 'gerente',
    notice:
      'Inutilizar comunica à SEFAZ que uma faixa de numeração não será usada. É uma obrigação acessória — a solicitação é feita em Fiscal → Inutilizar numeração.',
    fields: [
      { name: 'modelo', label: 'Modelo', type: 'select', options: [ { value: '55', label: 'NF-e (55)' }, { value: '65', label: 'NFC-e (65)' } ] },
      { name: 'serie', label: 'Série', type: 'integer', required: true },
      { name: 'numero_inicial', label: 'Número inicial', type: 'integer', required: true },
      { name: 'numero_final', label: 'Número final', type: 'integer', required: true },
      { name: 'justificativa', label: 'Justificativa', type: 'textarea', required: true, maxLength: 255, wide: true, hint: 'Mínimo de 15 caracteres, exigência da SEFAZ.' },
      { name: 'ambiente', label: 'Ambiente', type: 'text', maxLength: 20 },
      { name: 'status', label: 'Status', type: 'select', options: [ { value: 'pendente', label: 'Pendente', tone: 'amber' }, { value: 'homologado', label: 'Homologado', tone: 'green' }, { value: 'rejeitado', label: 'Rejeitado', tone: 'red' }, { value: 'erro', label: 'Erro', tone: 'red' } ] },
      { name: 'protocolo', label: 'Protocolo', type: 'text', maxLength: 40 },
      { name: 'motivo', label: 'Motivo', type: 'textarea', list: false, wide: true },
      { name: 'provider', label: 'Provedor', type: 'text', maxLength: 20 },
      { name: 'criado_por', label: 'Criado por', type: 'ref', ref: 'usuarios', list: false },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true },
      { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true },
    ],
    orderBy: { field: 'id', dir: 'desc' },
  },

  // ----------------------------------------------------------------
  // Estoque
  // ----------------------------------------------------------------
  estoques: {
    key: 'estoques',
    empresa: true,
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
    empresa: true,
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
      { name: 'compra_id', label: 'Compra', type: 'integer', list: false },
      // E2: vínculo FORMAL com a OP. Antes a entrada de produto acabado só era
      // achada pelo texto do motivo ('Produção concluída — OP #N'); o motivo
      // continua sendo escrito para leitura, mas o vínculo agora é a FK.
      { name: 'ordem_id', label: 'Ordem de fabricação', type: 'ref', ref: 'ordens', search: true, hint: 'Preenchido automaticamente quando a movimentação vem de uma OP.' },
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
    empresa: true,
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
          { value: 'liberada', label: 'Liberada', tone: 'amber' },
          { value: 'em_producao', label: 'Em produção', tone: 'blue' },
          { value: 'parcial', label: 'Parcial', tone: 'blue' },
          { value: 'concluida', label: 'Concluída', tone: 'green' },
          { value: 'cancelada', label: 'Cancelada', tone: 'red' },
        ],
        hint: 'Fluxo: planejada → liberada → em produção → parcial → concluída. Use os botões da ficha da OP; trocar o status à mão também é válido, mas a transição é conferida no servidor.',
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
      { name: 'responsavel_id', label: 'Responsável', type: 'ref', ref: 'usuarios', search: true, hint: 'Quem responde pela OP no chão de fábrica.' },
      { name: 'local_producao_id', label: 'Local de produção', type: 'ref', ref: 'locais', hint: 'Onde a peça é produzida. A entrada de produto acabado usa este local; sem ele, usa o Local padrão.' },
      { name: 'inicio', label: 'Início', type: 'date' },
      { name: 'previsao', label: 'Previsão de entrega', type: 'date' },
      // ---- E2: produção, perdas e custo. Tudo readonly — quem escreve é o
      // fluxo (liberar / apontar / concluir), nunca o formulário. Editar à mão
      // descolaria o número do estoque e das movimentações que o sustentam.
      { name: 'quantidade_produzida', label: 'Produzido', type: 'integer', readonly: true, default: 0, hint: 'Peças boas apontadas (soma dos apontamentos).' },
      { name: 'quantidade_perdida', label: 'Perdido', type: 'integer', readonly: true, default: 0, hint: 'Peças refugadas: consumiram insumo e não entraram no estoque.' },
      { name: 'custo_previsto', label: 'Custo previsto', type: 'money', readonly: true, form: false, hint: 'Gravado na liberação: peças planejadas × custo da ficha técnica naquele momento.' },
      { name: 'custo_real', label: 'Custo real', type: 'money', readonly: true, hint: 'Insumos realmente baixados + mão de obra e indiretos reconhecidos.' },
      { name: 'liberada_em', label: 'Liberada em', type: 'datetime', readonly: true, form: false, list: false },
      { name: 'liberada_por', label: 'Liberada por', type: 'ref', ref: 'usuarios', readonly: true, form: false, list: false },
      { name: 'iniciada_em', label: 'Iniciada em', type: 'datetime', readonly: true, form: false, list: false },
      { name: 'concluida_em', label: 'Concluída em', type: 'datetime', readonly: true, form: false },
      { name: 'cancelada_em', label: 'Cancelada em', type: 'datetime', readonly: true, form: false, list: false },
      { name: 'cancelada_por', label: 'Cancelada por', type: 'ref', ref: 'usuarios', readonly: true, form: false, list: false },
      { name: 'motivo_cancelamento', label: 'Motivo do cancelamento', type: 'textarea', maxLength: 500, readonly: true, form: false, wide: true },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true },
      ...auditFields,
    ],
    orderBy: { field: 'id', dir: 'desc' },
  },

  fichas: {
    key: 'fichas',
    empresa: true,
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
    empresa: true,
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
          { value: 'aprovado', label: 'Aprovado', tone: 'blue' },
          { value: 'parcial', label: 'Recebido parcialmente', tone: 'blue' },
          { value: 'recebido', label: 'Recebido', tone: 'green' },
          { value: 'cancelado', label: 'Cancelado', tone: 'red' },
        ],
      },
      { name: 'aprovada_em', label: 'Aprovada em', type: 'datetime', readonly: true, form: false, list: false },
      { name: 'aprovada_por', label: 'Aprovada por', type: 'ref', ref: 'usuarios', readonly: true, form: false, list: false },
      { name: 'total', label: 'Total (R$)', type: 'money', readonly: true, hint: 'Calculado a partir dos itens (e do frete).' },
      { name: 'condicao_pagamento', label: 'Condição de pagamento', type: 'text', maxLength: 60, list: false, placeholder: 'À vista, 30/60 dias...' },
      { name: 'frete', label: 'Frete (R$)', type: 'money', min: 0, default: 0, list: false },
      { name: 'previsao_entrega', label: 'Previsão de entrega', type: 'date', list: false },
      { name: 'nota_fiscal', label: 'Nota fiscal', type: 'text', maxLength: 60, list: false, placeholder: 'Número da NF' },
      { name: 'local_entrada', label: 'Armazém de entrada', type: 'text', maxLength: 60, list: false, hint: 'Local físico onde a mercadoria foi recebida.' },
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
      { name: 'fin_parcelas_detalhes', label: 'Detalhes das parcelas', type: 'text', list: false, form: false },
      { name: 'fin_pago_em', label: 'Pago em', type: 'date', list: false, section: 'Financeiro' },
      { name: 'fin_documento', label: 'Comprovante / doc.', type: 'text', maxLength: 80, list: false, section: 'Financeiro', placeholder: 'Nº comprovante, código Pix...' },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true },
      ...auditFields,
    ],
    orderBy: { field: 'data', dir: 'desc' },
  },

  vendas: {
    key: 'vendas',
    empresa: true,
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
          { value: 'pdv', label: 'PDV', tone: 'green' },
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
      { name: 'nfe_provider', label: 'Provedor da NF-e', type: 'text', maxLength: 20, list: false, form: false, readonly: true },
      // Preenchidos exclusivamente pela máquina de estados de fiscal.ts.
      { name: 'documento_fiscal_id', label: 'Documento fiscal', type: 'ref', ref: 'documentos_fiscais', list: false, form: false, readonly: true },
      { name: 'nfe_chave', label: 'Chave de acesso da NF-e', type: 'text', maxLength: 44, list: false, form: false, readonly: true },
      // ---- P1: amarração com proposta, PDV, expedição e logística ----
      // Preenchidos pelos endpoints próprios; o CRUD genérico não os escreve.
      {
        name: 'expedicao_etapa',
        label: 'Expedição',
        type: 'select',
        default: 'pendente',
        readonly: true,
        options: [
          { value: 'pendente', label: 'Aguardando', tone: 'slate' },
          { value: 'separacao', label: 'Em separação', tone: 'amber' },
          { value: 'conferida', label: 'Conferida', tone: 'blue' },
          { value: 'embalada', label: 'Embalada', tone: 'blue' },
          { value: 'expedida', label: 'Expedida', tone: 'green' },
        ],
      },
      { name: 'proposta_id', label: 'Proposta de origem', type: 'ref', ref: 'propostas', list: false, form: false, readonly: true },
      { name: 'pdv_caixa_id', label: 'Caixa do PDV', type: 'ref', ref: 'pdv_caixas', list: false, form: false, readonly: true },
      { name: 'envio_id', label: 'Envio', type: 'ref', ref: 'envios', list: false, form: false, readonly: true },
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
    empresa: true,
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
      // P1: o preço usado fica CONGELADO — mudar a lista de preço depois não
      // reescreve a venda. É isso que torna a venda auditável no tempo.
      { name: 'lista_preco_id', label: 'Lista de preço', type: 'ref', ref: 'listas_preco', list: false, readonly: true },
      { name: 'preco_tabela', label: 'Preço de tabela', type: 'money', list: false, readonly: true },
    ],
  },

  itens_compra: {
    key: 'itens_compra',
    empresa: true,
    table: 'itens_compra',
    label: 'Itens de compra',
    singular: 'Item de compra',
    labelFields: ['id'],
    internal: true,
    ops: READ_ONLY,
    fields: [
      { name: 'compra_id', label: 'Compra', type: 'integer' },
      { name: 'insumo_id', label: 'Insumo', type: 'ref', ref: 'insumos' },
      { name: 'produto_id', label: 'Produto', type: 'ref', ref: 'produtos' },
      { name: 'tamanho_id', label: 'Tamanho', type: 'ref', ref: 'tamanhos' },
      { name: 'codigo_fornecedor', label: 'Código do fornecedor', type: 'text', list: false },
      { name: 'quantidade', label: 'Quantidade', type: 'number', required: true, min: 0.001 },
      // P1: recebimento parcial. Atualizada por UPDATE condicional no
      // recebimento — nunca por edição direta, para não exceder o pedido.
      { name: 'quantidade_recebida', label: 'Recebida', type: 'number', default: 0, readonly: true, hint: 'Soma dos recebimentos parciais. Nunca excede a quantidade pedida.' },
      { name: 'preco_unitario', label: 'Preço unitário', type: 'money', required: true, min: 0 },
      { name: 'unidade', label: 'Unidade', type: 'text', list: false },
      { name: 'ncm', label: 'NCM', type: 'text', list: false },
      { name: 'cfop', label: 'CFOP', type: 'text', list: false },
      { name: 'dados_fiscais', label: 'Dados fiscais', type: 'text', list: false },
      { name: 'local', label: 'Local de entrada', type: 'text', list: false },
    ],
  },

  produto_fornecedor_skus: {
    key: 'produto_fornecedor_skus',
    empresa: true,
    table: 'produto_fornecedor_skus',
    label: 'De-para de SKUs de fornecedor',
    singular: 'De-para de SKU',
    labelFields: ['codigo_fornecedor'],
    internal: true,
    ops: READ_ONLY,
    fields: [
      { name: 'fornecedor_id', label: 'Fornecedor', type: 'ref', ref: 'fornecedores' },
      { name: 'codigo_fornecedor', label: 'Código do fornecedor', type: 'text' },
      { name: 'produto_id', label: 'Produto', type: 'ref', ref: 'produtos' },
      { name: 'tamanho_id', label: 'Tamanho', type: 'ref', ref: 'tamanhos' },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', list: false },
      { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', list: false },
    ],
  },

  importacoes_nfe: {
    key: 'importacoes_nfe',
    empresa: true,
    table: 'importacoes_nfe',
    label: 'Importações de NF-e',
    singular: 'Importação de NF-e',
    labelFields: ['numero'],
    internal: true,
    ops: READ_ONLY,
    fields: [
      { name: 'chave_acesso', label: 'Chave de acesso', type: 'text', unique: true },
      { name: 'xml_hash', label: 'Hash do XML', type: 'text' },
      { name: 'compra_id', label: 'Compra', type: 'ref', ref: 'compras' },
      { name: 'fornecedor_id', label: 'Fornecedor', type: 'ref', ref: 'fornecedores' },
      { name: 'numero', label: 'Número', type: 'text' },
      { name: 'serie', label: 'Série', type: 'text' },
      { name: 'usuario_id', label: 'Usuário', type: 'ref', ref: 'usuarios' },
      { name: 'dados_fiscais', label: 'Dados fiscais', type: 'text', list: false },
      { name: 'importado_em', label: 'Importado em', type: 'datetime', list: false },
    ],
  },

  // ----------------------------------------------------------------
  // Fase 3 — itens de OP por grade e insumos da ficha técnica
  // (internos; manipulados por sub-recursos em producao.ts)
  // ----------------------------------------------------------------
  itens_ordem: {
    key: 'itens_ordem',
    empresa: true,
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
      { name: 'produzido', label: 'Produzido', type: 'integer', min: 0, default: 0, readonly: true, hint: 'Atualizado pelos apontamentos e ao concluir a OP.' },
      { name: 'perdido', label: 'Perdido', type: 'integer', min: 0, default: 0, readonly: true, list: false, hint: 'Peças refugadas neste tamanho.' },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true, list: false },
    ],
    orderBy: { field: 'tamanho_id', dir: 'asc' },
  },

  // E2 — trilha de transições da OP. Append-only: a linha nasce e nunca é
  // editada, exatamente como expedicao_eventos / proposta_eventos.
  ordens_eventos: {
    key: 'ordens_eventos',
    empresa: true,
    internal: true,
    table: 'ordens_eventos',
    label: 'Eventos da OP',
    singular: 'Evento da OP',
    labelFields: ['id'],
    ops: READ_ONLY,
    fields: [
      { name: 'ordem_id', label: 'OP', type: 'ref', ref: 'ordens' },
      {
        name: 'evento',
        label: 'Evento',
        type: 'select',
        options: [
          { value: 'criada', label: 'Criada', tone: 'slate' },
          { value: 'liberada', label: 'Liberada', tone: 'amber' },
          { value: 'iniciada', label: 'Iniciada', tone: 'blue' },
          { value: 'apontamento', label: 'Apontamento', tone: 'blue' },
          { value: 'perda', label: 'Perda', tone: 'red' },
          { value: 'consumo', label: 'Consumo de insumo', tone: 'amber' },
          { value: 'parcial', label: 'Parcial', tone: 'blue' },
          { value: 'concluida', label: 'Concluída', tone: 'green' },
          { value: 'reaberta', label: 'Reaberta', tone: 'amber' },
          { value: 'cancelada', label: 'Cancelada', tone: 'red' },
          { value: 'atalho', label: 'Atalho de fluxo', tone: 'amber' },
          { value: 'edicao', label: 'Edição', tone: 'slate' },
        ],
      },
      { name: 'de_status', label: 'De', type: 'text', list: false },
      { name: 'para_status', label: 'Para', type: 'text', list: false },
      { name: 'mensagem', label: 'Mensagem', type: 'text' },
      { name: 'dados', label: 'Dados do evento', type: 'json', readonly: true, form: false, list: false },
      { name: 'usuario_id', label: 'Usuário', type: 'ref', ref: 'usuarios' },
      ...auditAppendOnly,
    ],
    // id, não criado_em: eventos do mesmo instante (apontamento + perda) precisam
    // de ordem estável, e o id é monotônico numa trilha append-only.
    orderBy: { field: 'id', dir: 'asc' },
  },

  // E2 — apontamento de produção. Também append-only e criado APENAS pelo
  // endpoint de fluxo (POST /api/ordens/:id/apontamentos): é ele que consome
  // insumo e acumula produzido/perdido, então um INSERT direto descolaria a OP
  // do estoque.
  ordens_apontamentos: {
    key: 'ordens_apontamentos',
    empresa: true,
    internal: true,
    table: 'ordens_apontamentos',
    label: 'Apontamentos de produção',
    singular: 'Apontamento',
    labelFields: ['id'],
    ops: READ_ONLY,
    fields: [
      { name: 'ordem_id', label: 'OP', type: 'ref', ref: 'ordens' },
      { name: 'tamanho_id', label: 'Tamanho', type: 'ref', ref: 'tamanhos' },
      { name: 'quantidade_produzida', label: 'Produzido', type: 'integer', min: 0 },
      { name: 'quantidade_perdida', label: 'Perdido', type: 'integer', min: 0 },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 500 },
      { name: 'idempotency_key', label: 'Chave de idempotência', type: 'text', maxLength: 120, readonly: true, form: false, list: false },
      { name: 'usuario_id', label: 'Apontado por', type: 'ref', ref: 'usuarios' },
      // `apontado_em` (não `criado_em`): é o carimbo que a operação usa.
      { name: 'apontado_em', label: 'Apontado em', type: 'datetime', readonly: true, list: false },
    ],
    orderBy: { field: 'apontado_em', dir: 'asc' },
  },

  itens_ficha_tecnica: {
    key: 'itens_ficha_tecnica',
    empresa: true,
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
    empresa: true,
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
    empresa: true,
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
      // E2: vínculo FORMAL com a OP que consumiu o insumo (antes só o texto do
      // motivo ligava as duas coisas, e o estorno dependia de dar match nele).
      { name: 'ordem_id', label: 'Ordem de fabricação', type: 'ref', ref: 'ordens', search: true, hint: 'Preenchido automaticamente no consumo por OP.' },
      { name: 'data', label: 'Data', type: 'datetime', readonly: true },
    ],
    orderBy: { field: 'data', dir: 'desc' },
  },

  // ----------------------------------------------------------------
  // Fase 4 — Inventário
  // ----------------------------------------------------------------
  inventarios: {
    key: 'inventarios',
    empresa: true,
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
    empresa: true,
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
    empresa: true,
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
    empresa: true,
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
    empresa: true,
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
    empresa: true,
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
    empresa: true,
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
    empresa: true,
    minPerfil: 'gerente',
    table: 'lancamentos_financeiros',
    label: 'Lançamentos Financeiros',
    singular: 'Lançamento financeiro',
    labelFields: ['descricao'],
    ops: ALL_OPS,
    images: { max: 4 },
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
      { name: 'comprovantes', label: 'Comprovantes', type: 'images', virtual: true, form: false, hint: 'Até 4 fotos: comprovante Pix, boleto, recibo...' },
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
    empresa: true,
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
    empresa: true,
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
    empresa: true,
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

  // ----------------------------------------------------------------
  // FASE P1 — listas de preço, propostas, PDV, logística, expedição,
  // devolução e recebimento parcial de compras.
  // ----------------------------------------------------------------

  listas_preco: {
    key: 'listas_preco',
    empresa: true,
    table: 'listas_preco',
    label: 'Listas de Preço',
    singular: 'Lista de preço',
    labelFields: ['nome'],
    ops: ALL_OPS,
    detail: true,
    notice:
      'A lista ATIVA com MAIOR prioridade e dentro da vigência vence; em empate, a mais recente. O preço aplicado é congelado no item da venda — mudar a lista depois não reescreve o que já foi vendido.',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, maxLength: 80, placeholder: 'Atacado SP, Varejo balcão, Black Friday...' },
      { name: 'descricao', label: 'Descrição', type: 'textarea', maxLength: 500, list: false, wide: true },
      { name: 'prioridade', label: 'Prioridade', type: 'integer', default: 0, hint: 'Maior vence. Empate: a lista mais recente.' },
      { name: 'inicio_em', label: 'Válida de', type: 'date' },
      { name: 'fim_em', label: 'Válida até', type: 'date' },
      ativo,
      { name: 'criado_por', label: 'Criado por', type: 'ref', ref: 'usuarios', list: false, form: false, readonly: true },
      ...auditFields,
    ],
    orderBy: { field: 'prioridade', dir: 'desc' },
  },

  lista_preco_itens: {
    key: 'lista_preco_itens',
    empresa: true,
    internal: true,
    table: 'lista_preco_itens',
    label: 'Preços da Lista',
    singular: 'Preço da lista',
    labelFields: ['produto_id'],
    ops: { create: false, update: false, delete: false },
    fields: [
      { name: 'lista_id', label: 'Lista', type: 'ref', ref: 'listas_preco' },
      { name: 'produto_id', label: 'Produto', type: 'ref', ref: 'produtos' },
      { name: 'preco', label: 'Preço (R$)', type: 'money', min: 0 },
      ...auditFields,
    ],
  },

  listas_preco_historico: {
    key: 'listas_preco_historico',
    empresa: true,
    internal: true,
    table: 'listas_preco_historico',
    label: 'Histórico de Preços',
    singular: 'Mudança de preço',
    labelFields: ['id'],
    ops: READ_ONLY,
    fields: [
      { name: 'lista_id', label: 'Lista', type: 'ref', ref: 'listas_preco' },
      { name: 'produto_id', label: 'Produto', type: 'ref', ref: 'produtos' },
      { name: 'preco_anterior', label: 'Preço anterior', type: 'money' },
      { name: 'preco_novo', label: 'Preço novo', type: 'money' },
      { name: 'usuario_id', label: 'Usuário', type: 'ref', ref: 'usuarios' },
      ...auditAppendOnly,
    ],
    orderBy: { field: 'criado_em', dir: 'desc' },
  },

  propostas: {
    key: 'propostas',
    empresa: true,
    table: 'propostas',
    label: 'Propostas Comerciais',
    singular: 'Proposta',
    labelFields: ['id'],
    ops: { create: true, update: false, delete: true },
    detail: true,
    notice:
      'Rascunho → Enviada → Aprovada → Convertida em pedido. O total é calculado pelo servidor e a conversão é idempotente: repetir a conversão devolve o mesmo pedido, nunca um segundo.',
    fields: [
      { name: 'numero', label: 'Número', type: 'text', maxLength: 40, search: true },
      { name: 'cliente_id', label: 'Cliente', type: 'ref', ref: 'clientes', required: true, search: true },
      { name: 'representante_id', label: 'Vendedor', type: 'ref', ref: 'representantes', search: true },
      { name: 'data', label: 'Data', type: 'date', required: true },
      { name: 'valida_ate', label: 'Válida até', type: 'date', hint: 'Obrigatória para enviar. Aprovada e vencida vira "expirada".' },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        default: 'rascunho',
        form: false,
        readonly: true,
        options: [
          { value: 'rascunho', label: 'Rascunho', tone: 'slate' },
          { value: 'enviada', label: 'Enviada', tone: 'blue' },
          { value: 'aprovada', label: 'Aprovada', tone: 'amber' },
          { value: 'convertida', label: 'Convertida', tone: 'green' },
          { value: 'recusada', label: 'Recusada', tone: 'red' },
          { value: 'cancelada', label: 'Cancelada', tone: 'red' },
          { value: 'expirada', label: 'Expirada', tone: 'slate' },
        ],
      },
      { name: 'condicao_pagamento', label: 'Condição de pagamento', type: 'text', maxLength: 60, list: false, placeholder: 'À vista, 30/60 dias...' },
      { name: 'desconto', label: 'Desconto (R$)', type: 'money', min: 0, default: 0, list: false },
      { name: 'frete', label: 'Frete (R$)', type: 'money', min: 0, default: 0, list: false },
      { name: 'total', label: 'Total (R$)', type: 'money', readonly: true, hint: 'Calculado pelo servidor a partir dos itens.' },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true },
      { name: 'venda_id', label: 'Pedido gerado', type: 'ref', ref: 'vendas', readonly: true, form: false, list: false },
      { name: 'convertido_em', label: 'Convertida em', type: 'datetime', readonly: true, form: false, list: false },
      { name: 'convertido_por', label: 'Convertida por', type: 'ref', ref: 'usuarios', readonly: true, form: false, list: false },
      { name: 'recusado_motivo', label: 'Motivo da recusa', type: 'text', readonly: true, form: false, list: false },
      { name: 'recusado_em', label: 'Recusada em', type: 'datetime', readonly: true, form: false, list: false },
      { name: 'cancelado_em', label: 'Cancelada em', type: 'datetime', readonly: true, form: false, list: false },
      { name: 'criado_por', label: 'Criado por', type: 'ref', ref: 'usuarios', readonly: true, form: false, list: false },
      ...auditFields,
    ],
    orderBy: { field: 'data', dir: 'desc' },
  },

  proposta_itens: {
    key: 'proposta_itens',
    empresa: true,
    internal: true,
    table: 'proposta_itens',
    label: 'Itens da Proposta',
    singular: 'Item da proposta',
    labelFields: ['produto_id'],
    ops: { create: false, update: false, delete: false },
    fields: [
      { name: 'proposta_id', label: 'Proposta', type: 'ref', ref: 'propostas' },
      { name: 'produto_id', label: 'Produto', type: 'ref', ref: 'produtos' },
      { name: 'tamanho_id', label: 'Tamanho', type: 'ref', ref: 'tamanhos' },
      { name: 'quantidade', label: 'Quantidade', type: 'number', min: 0 },
      { name: 'preco_unitario', label: 'Preço unitário', type: 'money', min: 0 },
      { name: 'desconto_pct', label: 'Desconto (%)', type: 'percent', min: 0, max: 100 },
      { name: 'subtotal', label: 'Subtotal', type: 'money', readonly: true },
      { name: 'lista_preco_id', label: 'Lista de preço', type: 'ref', ref: 'listas_preco', readonly: true, form: false },
      { name: 'preco_tabela', label: 'Preço de tabela', type: 'money', readonly: true, form: false },
    ],
  },

  proposta_eventos: {
    key: 'proposta_eventos',
    empresa: true,
    internal: true,
    table: 'proposta_eventos',
    label: 'Eventos da Proposta',
    singular: 'Evento da proposta',
    labelFields: ['id'],
    ops: READ_ONLY,
    fields: [
      { name: 'proposta_id', label: 'Proposta', type: 'ref', ref: 'propostas' },
      { name: 'de_status', label: 'De', type: 'text' },
      { name: 'para_status', label: 'Para', type: 'text' },
      { name: 'mensagem', label: 'Mensagem', type: 'text' },
      { name: 'usuario_id', label: 'Usuário', type: 'ref', ref: 'usuarios' },
      ...auditAppendOnly,
    ],
    orderBy: { field: 'criado_em', dir: 'asc' },
  },

  pdv_caixas: {
    key: 'pdv_caixas',
    empresa: true,
    table: 'pdv_caixas',
    label: 'Caixas do PDV',
    singular: 'Caixa do PDV',
    labelFields: ['numero'],
    // Abertura, suprimento, sangria e fechamento mexem em DINHEIRO: são de
    // gerência. O operador vende no caixa aberto; quem responde pela gaveta é
    // gerente ou admin. (O CRUD genérico continua fechado — ver checkFluxo.)
    minPerfil: 'gerente',
    ops: { create: false, update: false, delete: false },
    detail: true,
    notice:
      'Abra o caixa com o troco inicial e feche informando o valor contado. O sistema compara com o esperado (abertura + dinheiro + suprimentos − sangrias) e registra a diferença — fechar não apaga a divergência.',
    fields: [
      { name: 'numero', label: 'Terminal', type: 'text', required: true, search: true, maxLength: 40 },
      { name: 'usuario_id', label: 'Operador', type: 'ref', ref: 'usuarios', search: true },
      { name: 'local', label: 'Local de saída', type: 'text', maxLength: 60, list: false },
      { name: 'abertura_em', label: 'Aberto em', type: 'datetime', readonly: true },
      { name: 'fechamento_em', label: 'Fechado em', type: 'datetime', readonly: true },
      { name: 'valor_abertura', label: 'Troco inicial (R$)', type: 'money', min: 0, readonly: true },
      { name: 'valor_fechamento', label: 'Contado (R$)', type: 'money', readonly: true },
      { name: 'valor_sistema', label: 'Esperado (R$)', type: 'money', readonly: true },
      { name: 'diferenca', label: 'Diferença (R$)', type: 'money', readonly: true },
      // Quem fechou. A coluna existe desde a 0024; sem declará-la o campo era
      // descartado no INSERT/UPDATE (os dois stores montam a lista de colunas a
      // partir daqui) e o fechamento ficava sem autor registrado.
      { name: 'fechado_por', label: 'Fechado por', type: 'ref', ref: 'usuarios', readonly: true, list: false },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        default: 'aberto',
        readonly: true,
        options: [
          { value: 'aberto', label: 'Aberto', tone: 'green' },
          { value: 'fechado', label: 'Fechado', tone: 'slate' },
          { value: 'cancelado', label: 'Cancelado', tone: 'red' },
        ],
      },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 500, list: false, wide: true },
      ...auditFields,
    ],
    orderBy: { field: 'abertura_em', dir: 'desc' },
  },

  pdv_pagamentos: {
    key: 'pdv_pagamentos',
    empresa: true,
    internal: true,
    table: 'pdv_pagamentos',
    label: 'Pagamentos do PDV',
    singular: 'Pagamento',
    labelFields: ['id'],
    ops: READ_ONLY,
    fields: [
      { name: 'venda_id', label: 'Venda', type: 'ref', ref: 'vendas' },
      { name: 'caixa_id', label: 'Caixa', type: 'ref', ref: 'pdv_caixas' },
      { name: 'forma', label: 'Forma', type: 'text' },
      { name: 'valor', label: 'Valor', type: 'money' },
      { name: 'parcelas', label: 'Parcelas', type: 'integer' },
      { name: 'nsu', label: 'NSU / comprovante', type: 'text' },
      { name: 'bandeira', label: 'Bandeira', type: 'text' },
      ...auditAppendOnly,
    ],
    orderBy: { field: 'criado_em', dir: 'desc' },
  },

  pdv_caixa_movimentos: {
    key: 'pdv_caixa_movimentos',
    empresa: true,
    internal: true,
    table: 'pdv_caixa_movimentos',
    label: 'Movimentos do Caixa',
    singular: 'Movimento do caixa',
    labelFields: ['id'],
    ops: READ_ONLY,
    fields: [
      { name: 'caixa_id', label: 'Caixa', type: 'ref', ref: 'pdv_caixas' },
      { name: 'tipo', label: 'Tipo', type: 'select', options: [{ value: 'suprimento', label: 'Suprimento (troco)' }, { value: 'sangria', label: 'Sangria (retirada)' }] },
      { name: 'valor', label: 'Valor', type: 'money' },
      { name: 'motivo', label: 'Motivo', type: 'text' },
      { name: 'usuario_id', label: 'Usuário', type: 'ref', ref: 'usuarios' },
      ...auditAppendOnly,
    ],
    orderBy: { field: 'criado_em', dir: 'desc' },
  },

  envios: {
    key: 'envios',
    empresa: true,
    table: 'envios',
    label: 'Envios',
    singular: 'Envio',
    labelFields: ['id'],
    ops: { create: false, update: true, delete: false },
    detail: true,
    notice:
      'O envio só é marcado como "postado" quando existe código de rastreamento ou referência do provedor. Sem transportadora configurada, ele fica PENDENTE com o motivo — o sistema nunca finge que postou.',
    fields: [
      { name: 'venda_id', label: 'Pedido', type: 'ref', ref: 'vendas', search: true },
      { name: 'provider', label: 'Provedor', type: 'text', maxLength: 20, search: true },
      { name: 'servico', label: 'Serviço', type: 'text', maxLength: 40 },
      { name: 'codigo_rastreamento', label: 'Rastreamento', type: 'text', maxLength: 60, search: true },
      { name: 'provider_ref', label: 'Ref. no provedor', type: 'text', list: false, form: false, readonly: true },
      { name: 'etiqueta_url', label: 'Etiqueta', type: 'text', list: false, form: false },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        default: 'pendente',
        options: [
          { value: 'pendente', label: 'Pendente', tone: 'amber' },
          { value: 'cotado', label: 'Cotado', tone: 'blue' },
          { value: 'gerado', label: 'Gerado', tone: 'blue' },
          { value: 'postado', label: 'Postado', tone: 'green' },
          { value: 'em_transito', label: 'Em trânsito', tone: 'green' },
          { value: 'entregue', label: 'Entregue', tone: 'green' },
          { value: 'devolvido', label: 'Devolvido', tone: 'amber' },
          { value: 'extraviado', label: 'Extraviado', tone: 'red' },
          { value: 'cancelado', label: 'Cancelado', tone: 'red' },
          { value: 'erro', label: 'Erro', tone: 'red' },
        ],
      },
      { name: 'custo', label: 'Custo (R$)', type: 'money', min: 0 },
      { name: 'peso_g', label: 'Peso (g)', type: 'integer', list: false, form: false },
      { name: 'volumes', label: 'Volumes', type: 'integer', list: false, form: false },
      { name: 'cep_destino', label: 'CEP destino', type: 'cep', list: false, form: false },
      { name: 'prazo_dias', label: 'Prazo (dias)', type: 'integer', list: false },
      { name: 'erro', label: 'Erro / motivo', type: 'text', list: false, form: false, readonly: true },
      // A coluna existe desde a 0024 e carrega o índice parcial único
      // (empresa_id, idempotency_key). Sem declará-la aqui, os dois stores
      // montam a lista de colunas a partir deste array e o INSERT a descartava —
      // a busca por chave nunca achava nada e cada chamada criava uma remessa
      // nova, quebrando justamente a idempotência que ela garante.
      { name: 'idempotency_key', label: 'Chave de idempotência', type: 'text', maxLength: 120, list: false, form: false, readonly: true },
      { name: 'criado_por', label: 'Gerado por', type: 'ref', ref: 'usuarios', readonly: true, list: false, form: false },
      ...auditFields,
    ],
    orderBy: { field: 'criado_em', dir: 'desc' },
  },

  envio_eventos: {
    key: 'envio_eventos',
    empresa: true,
    internal: true,
    table: 'envio_eventos',
    label: 'Eventos do Envio',
    singular: 'Evento do envio',
    labelFields: ['id'],
    ops: READ_ONLY,
    fields: [
      { name: 'envio_id', label: 'Envio', type: 'ref', ref: 'envios' },
      { name: 'de_status', label: 'De', type: 'text' },
      { name: 'para_status', label: 'Para', type: 'text' },
      { name: 'codigo', label: 'Código', type: 'text' },
      { name: 'mensagem', label: 'Mensagem', type: 'text' },
      { name: 'local', label: 'Local', type: 'text' },
      // Payload bruto do evento vindo do provedor (JSONB). Sem declará-lo o
      // INSERT descartava a evidência que o provedor devolveu no rastreio.
      { name: 'payload', label: 'Dados do provedor', type: 'json', readonly: true, form: false, list: false },
      { name: 'usuario_id', label: 'Usuário', type: 'ref', ref: 'usuarios' },
      ...auditAppendOnly,
    ],
    orderBy: { field: 'criado_em', dir: 'asc' },
  },

  expedicao_eventos: {
    key: 'expedicao_eventos',
    empresa: true,
    internal: true,
    table: 'expedicao_eventos',
    label: 'Eventos de Expedição',
    singular: 'Evento de expedição',
    labelFields: ['id'],
    ops: READ_ONLY,
    fields: [
      { name: 'venda_id', label: 'Pedido', type: 'ref', ref: 'vendas' },
      { name: 'etapa', label: 'Etapa', type: 'text' },
      { name: 'de_etapa', label: 'De', type: 'text' },
      { name: 'resultado', label: 'Resultado', type: 'select', options: [{ value: 'ok', label: 'OK', tone: 'green' }, { value: 'divergencia', label: 'Divergência', tone: 'red' }, { value: 'erro', label: 'Erro', tone: 'red' }] },
      { name: 'mensagem', label: 'Mensagem', type: 'text' },
      // Detalhe estruturado do evento (JSONB): o que foi lido na conferência,
      // o que divergiu, o motivo da divergência.
      { name: 'dados', label: 'Dados do evento', type: 'json', readonly: true, form: false, list: false },
      { name: 'usuario_id', label: 'Usuário', type: 'ref', ref: 'usuarios' },
      ...auditAppendOnly,
    ],
    orderBy: { field: 'criado_em', dir: 'asc' },
  },

  divergencias_conferencia: {
    key: 'divergencias_conferencia',
    empresa: true,
    table: 'divergencias_conferencia',
    label: 'Divergências de Conferência',
    singular: 'Divergência',
    labelFields: ['id'],
    ops: { create: false, update: true, delete: false },
    notice: 'Registrada automaticamente quando a conferência física não bate com o pedido — inclusive quando a conferência é abortada. É a auditoria da separação.',
    fields: [
      { name: 'venda_id', label: 'Pedido', type: 'ref', ref: 'vendas', search: true },
      { name: 'usuario_id', label: 'Conferido por', type: 'ref', ref: 'usuarios' },
      // O QUE divergiu. `esperado`/`lido` são NOT NULL no banco: sem declará-las
      // aqui o INSERT descartava o conteúdo e a conferência reprovada era
      // gravada sem nenhum rastro do motivo — exatamente o que a auditoria da
      // divergência existe para impedir.
      { name: 'esperado', label: 'Esperado', type: 'json', required: true, form: false, list: false },
      { name: 'lido', label: 'Lido', type: 'json', required: true, form: false, list: false },
      { name: 'faltando', label: 'Faltando', type: 'json', form: false, list: false },
      { name: 'sobrando', label: 'Sobrando', type: 'json', form: false, list: false },
      { name: 'resolvido_em', label: 'Resolvida em', type: 'datetime', readonly: true },
      { name: 'resolvido_por', label: 'Resolvida por', type: 'ref', ref: 'usuarios', readonly: true, form: false },
      { name: 'resolucao', label: 'Resolução', type: 'text', maxLength: 500, list: false, wide: true },
      ...auditAppendOnly,
    ],
    orderBy: { field: 'criado_em', dir: 'desc' },
  },

  devolucoes: {
    key: 'devolucoes',
    empresa: true,
    table: 'devolucoes',
    label: 'Devoluções',
    singular: 'Devolução',
    labelFields: ['id'],
    ops: { create: false, update: false, delete: false },
    detail: true,
    notice:
      'Solicitada → Autorizada → Em trânsito → Recebida. Mercadoria sem código de rastreamento NÃO entra no estoque, e o estoque só sobe uma vez por devolução.',
    fields: [
      { name: 'numero', label: 'Número', type: 'text', maxLength: 40, search: true },
      { name: 'venda_id', label: 'Pedido original', type: 'ref', ref: 'vendas', search: true },
      { name: 'cliente_id', label: 'Cliente', type: 'ref', ref: 'clientes', search: true },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        default: 'solicitada',
        readonly: true,
        options: [
          { value: 'solicitada', label: 'Solicitada', tone: 'blue' },
          { value: 'autorizada', label: 'Autorizada', tone: 'amber' },
          { value: 'em_transito', label: 'Em trânsito', tone: 'amber' },
          { value: 'recebida', label: 'Recebida', tone: 'green' },
          { value: 'recusada', label: 'Recusada', tone: 'red' },
          { value: 'cancelada', label: 'Cancelada', tone: 'red' },
        ],
      },
      {
        name: 'tipo',
        label: 'Tipo',
        type: 'select',
        default: 'devolucao',
        options: [
          { value: 'devolucao', label: 'Devolução' },
          { value: 'troca', label: 'Troca' },
          { value: 'garantia', label: 'Garantia' },
          { value: 'arrependimento', label: 'Arrependimento (CDC 7 dias)' },
        ],
      },
      { name: 'motivo', label: 'Motivo', type: 'text', required: true, maxLength: 500, wide: true },
      { name: 'autorizacao_codigo', label: 'Código de autorização', type: 'text', maxLength: 60, list: false, readonly: true },
      { name: 'codigo_rastreamento', label: 'Rastreamento', type: 'text', maxLength: 60, search: true },
      { name: 'transportadora', label: 'Transportadora', type: 'text', maxLength: 80, list: false },
      { name: 'autorizada_em', label: 'Autorizada em', type: 'datetime', readonly: true, form: false, list: false },
      { name: 'autorizado_por', label: 'Autorizada por', type: 'ref', ref: 'usuarios', readonly: true, form: false, list: false },
      { name: 'recebido_por', label: 'Recebida por', type: 'ref', ref: 'usuarios', readonly: true, form: false, list: false },
      { name: 'criado_por', label: 'Solicitada por', type: 'ref', ref: 'usuarios', readonly: true, form: false, list: false },
      { name: 'documento_fiscal_id', label: 'Documento fiscal', type: 'ref', ref: 'documentos_fiscais', readonly: true, form: false, list: false },
      { name: 'recebida_em', label: 'Recebida em', type: 'datetime', readonly: true, form: false },
      { name: 'local_entrada', label: 'Armazém de entrada', type: 'text', maxLength: 60, list: false, readonly: true },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true },
      ...auditFields,
    ],
    orderBy: { field: 'criado_em', dir: 'desc' },
  },

  devolucao_itens: {
    key: 'devolucao_itens',
    empresa: true,
    internal: true,
    table: 'devolucao_itens',
    label: 'Itens da Devolução',
    singular: 'Item da devolução',
    labelFields: ['produto_id'],
    ops: READ_ONLY,
    fields: [
      { name: 'devolucao_id', label: 'Devolução', type: 'ref', ref: 'devolucoes' },
      { name: 'produto_id', label: 'Produto', type: 'ref', ref: 'produtos' },
      { name: 'tamanho_id', label: 'Tamanho', type: 'ref', ref: 'tamanhos' },
      { name: 'quantidade_solicitada', label: 'Solicitada', type: 'number' },
      { name: 'quantidade_recebida', label: 'Recebida', type: 'number' },
      { name: 'estado', label: 'Estado', type: 'select', options: [{ value: 'bom', label: 'Bom', tone: 'green' }, { value: 'avariado', label: 'Avariado', tone: 'red' }, { value: 'usado', label: 'Usado', tone: 'amber' }, { value: 'faltando_acessorio', label: 'Faltando acessório', tone: 'amber' }] },
      { name: 'devolucao_estoque', label: 'Entrou no estoque', type: 'boolean', readonly: true, form: false },
      // Rastreabilidade: qual item do pedido original está sendo devolvido.
      { name: 'item_venda_id', label: 'Item do pedido', type: 'ref', ref: 'itens_venda', readonly: true, form: false, list: false },
    ],
  },

  compra_recebimentos: {
    key: 'compra_recebimentos',
    empresa: true,
    table: 'compra_recebimentos',
    label: 'Recebimentos de Compra',
    singular: 'Recebimento',
    labelFields: ['id'],
    ops: { create: false, update: false, delete: false },
    notice: 'Cada recebimento parcial é uma linha. O estoque sobe exatamente pela quantidade recebida, nunca pela pedida.',
    fields: [
      { name: 'compra_id', label: 'Pedido de compra', type: 'ref', ref: 'compras', search: true },
      { name: 'data', label: 'Data', type: 'datetime' },
      { name: 'local', label: 'Armazém', type: 'text', maxLength: 60 },
      { name: 'documento', label: 'Chave de idempotência', type: 'text', maxLength: 60, list: false, form: false },
      { name: 'total', label: 'Total (R$)', type: 'money', readonly: true },
      { name: 'usuario_id', label: 'Recebido por', type: 'ref', ref: 'usuarios' },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 500, list: false, wide: true },
      ...auditAppendOnly,
    ],
    orderBy: { field: 'data', dir: 'desc' },
  },

  compra_recebimento_itens: {
    key: 'compra_recebimento_itens',
    empresa: true,
    internal: true,
    table: 'compra_recebimento_itens',
    label: 'Itens do Recebimento',
    singular: 'Item do recebimento',
    labelFields: ['id'],
    ops: READ_ONLY,
    fields: [
      { name: 'recebimento_id', label: 'Recebimento', type: 'ref', ref: 'compra_recebimentos' },
      { name: 'item_compra_id', label: 'Item da compra', type: 'ref', ref: 'itens_compra' },
      { name: 'quantidade', label: 'Quantidade', type: 'number' },
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

/**
 * Coluna de escopo multiempresa. Não é um campo do formulário: o usuário nunca
 * escolhe a empresa de um registro — o servidor carimba (ver empresa.ts). Ela
 * entra apenas como COLUNA, para que o store saiba selecioná-la, filtrá-la e
 * gravá-la.
 */
const EMPRESA_COLUMN: Field = {
  name: 'empresa_id',
  label: 'Empresa',
  type: 'integer',
  readonly: true,
  list: false,
  form: false,
};

/** Colunas reais do banco de um recurso (exclui campos virtuais). */
export function columnsOf(r: Resource): Field[] {
  const cols = r.fields.filter((f) => !f.virtual);
  if (r.empresa && !cols.some((f) => f.name === 'empresa_id')) cols.push(EMPRESA_COLUMN);
  return cols;
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
