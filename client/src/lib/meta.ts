// Tipos dos metadados enviados por GET /api/meta (espelham server/src/resources.ts)
import { createContext, useContext } from 'react';

export type FieldType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'phone'
  | 'document'
  | 'integer'
  | 'number'
  | 'money'
  | 'percent'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'select'
  | 'ref'
  | 'multiref'
  | 'password'
  | 'color'
  | 'uf'
  | 'cep'
  | 'images';

export type Tone = 'green' | 'red' | 'amber' | 'blue' | 'slate';
export type FieldOption = { value: string; label: string; tone?: Tone };

export type Field = {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  requiredOnCreate?: boolean;
  unique?: boolean;
  options?: FieldOption[];
  ref?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  default?: unknown;
  list?: boolean;
  form?: boolean;
  readonly?: boolean;
  search?: boolean;
  virtual?: boolean;
  hint?: string;
  placeholder?: string;
  wide?: boolean;
  section?: string;
  pattern?: string;
  patternMessage?: string;
  documento?: 'cpf' | 'cnpj' | 'ambos';
};

export type PublicFile = {
  id: number;
  nome: string | null;
  mime: string | null;
  tamanho_bytes: number | null;
  url: string;
  thumb_url: string;
  principal: boolean;
  ordem: number;
  criado_em: string;
};

export type ResourceOps = { create: boolean; update: boolean; delete: boolean };

export type ResourceMeta = {
  key: string;
  label: string;
  singular: string;
  labelFields: string[];
  fields: Field[];
  orderBy?: { field: string; dir: 'asc' | 'desc' };
  ops: ResourceOps;
  adminOnly?: boolean;
  /**
   * RBAC de ESCRITA (espelha `Resource.minPerfilEscrita` do servidor): perfil
   * mínimo para incluir/alterar/excluir, mantendo a leitura aberta. Usado pelo
   * catálogo COMPARTILHADO (categorias, cores, grades, tamanhos) — SEC-04.
   */
  minPerfilEscrita?: 'gerente' | 'admin';
  notice?: string;
  images?: { max: number };
  detail?: boolean;
  /** Recorte da busca textual da listagem (espelha o servidor). */
  searchFields?: (string | { ref: string; field?: string })[];
  /** Filtros declarados da listagem, na ordem de exibição. */
  filterFields?: string[];
  /**
   * Superfície do formulário: `drawer` = cadastro simples em painel lateral
   * (a lista continua visível); `modal` (padrão) = modal central histórico.
   * Espelha `Resource.editor` do servidor.
   */
  editor?: 'modal' | 'drawer';
  /** Contagem real de uso do cadastro (coluna "Utilização"). */
  uso?: { recurso: string; campo: string; singular: string; plural: string };
  /** Filtros rápidos (um clique) da listagem. */
  quickFilters?: { field: string; label: string; options: { value: string; label: string }[] }[];
};

export type Meta = {
  resources: Record<string, ResourceMeta>;
  mode: 'postgres' | 'memory';
  uploads?: 'db' | 'cloudinary';
  /** true quando UPLOAD_PROVIDER=cloudinary mas a CLOUDINARY_URL é inválida */
  uploadsConfigError?: boolean;
  version?: string;
  /** SMTP configurado? (esqueci minha senha) */
  smtp?: { configurado: boolean };
  /**
   * Origem usada para montar os links que saem por e-mail (convite de acesso,
   * redefinição de senha). `configurada=false` significa que a base vem do
   * cabeçalho da requisição — funciona, mas quebra se o ERP mudar de endereço.
   * `publica=false` (ou `appUrlIgnorada=true`) é o caso que chega ao
   * destinatório como "URL inválida": a origem aponta para um endereço interno
   * (localhost/IP privado) e por isso é descartada.
   *
   * `fonte` diz de onde saiu a base: 'env' (APP_URL), 'banco' (endereço salvo
   * pelo admin em Configurações › Sistema), 'requisicao' (endereço da sessão)
   * ou 'dev'. `sugerida` é o endereço detectado nesta sessão — só sugestão, o
   * servidor nunca o grava sozinho (Host é controlado por quem requisita).
   */
  emailLinks?: {
    configurada: boolean;
    base: string;
    publica: boolean;
    appUrlIgnorada: boolean;
    fonte?: 'env' | 'banco' | 'requisicao' | 'dev' | '';
    doBanco?: string;
    doAmbiente?: string;
    sugerida?: string;
    permitirInterna?: boolean;
    aviso?: string;
  };
  /** Informações do fluxo de autenticação (hash, MFA, reautenticação) */
  auth?: { hash: string; mfa_admin_obrigatorio: boolean; reauth_ttl_segundos: number };
  /** Local padrão (origem das movimentações) — o front o usa para pré-selecionar os formulários. */
  defaultLocal?: { id: number | null; nome: string } | null;
};

export const MetaContext = createContext<Meta | null>(null);

export function useMeta(): Meta {
  const m = useContext(MetaContext);
  if (!m) throw new Error('useMeta deve ser usado dentro de MetaProvider');
  return m;
}

export type ListResult<T = Record<string, any>> = {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type Option = { value: number; label: string };
