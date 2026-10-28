// ============================================================================
// IMPORTAÇÃO DE PLANILHAS — configuração canônica dos tipos aceitos
// ----------------------------------------------------------------------------
// Usada pela página `/importar/:tipo` e pelos botões "Importar" das listagens.
// O limite de linhas por arquivo é o MESMO do servidor (`server/src/importacao.ts`):
// acima dele a pré-visualização marca `truncado` e a importação é BLOQUEADA em
// vez de gravar um prefixo silencioso do arquivo.
// ============================================================================
export type TipoImport = 'produtos' | 'clientes' | 'fornecedores' | 'insumos' | 'estoque';

export const IMPORT_TIPOS: { tipo: TipoImport; label: string; recurso: string; singular: string }[] = [
  { tipo: 'produtos', label: 'Produtos', recurso: 'produtos', singular: 'produto' },
  { tipo: 'clientes', label: 'Clientes', recurso: 'clientes', singular: 'cliente' },
  { tipo: 'fornecedores', label: 'Fornecedores', recurso: 'fornecedores', singular: 'fornecedor' },
  { tipo: 'insumos', label: 'Insumos', recurso: 'insumos', singular: 'insumo' },
  { tipo: 'estoque', label: 'Saldos iniciais de estoque', recurso: 'estoques', singular: 'saldo de estoque' },
];

/** Rota canônica de importação de um recurso (null quando o recurso não importa). */
export function rotaImportacaoDoRecurso(recurso: string): string | null {
  const cfg = IMPORT_TIPOS.find((t) => t.recurso === recurso);
  return cfg ? `/importar/${cfg.tipo}` : null;
}
