// ============================================================================
// ATALHOS DE IMPORTAÇÃO — todos apontam para a ÚNICA interface do motor
// universal. O destino é apenas contexto pré-selecionado; não existe motor,
// rota ou tela de importação por módulo.
// ============================================================================
export type TipoImport = 'produtos' | 'clientes' | 'fornecedores' | 'insumos' | 'estoque' | 'politica_comercial';

export const IMPORT_TIPOS: { tipo: TipoImport; label: string; recurso: string; singular: string }[] = [
  { tipo: 'produtos', label: 'Produtos', recurso: 'produtos', singular: 'produto' },
  { tipo: 'clientes', label: 'Clientes', recurso: 'clientes', singular: 'cliente' },
  { tipo: 'fornecedores', label: 'Fornecedores', recurso: 'fornecedores', singular: 'fornecedor' },
  { tipo: 'insumos', label: 'Insumos', recurso: 'insumos', singular: 'insumo' },
  { tipo: 'estoque', label: 'Saldos iniciais de estoque', recurso: 'estoques', singular: 'saldo de estoque' },
  { tipo: 'politica_comercial', label: 'Política comercial', recurso: 'politica_comercial', singular: 'política comercial' },
];

/** Rota canônica de importação de um recurso (null quando o recurso não importa). */
export function rotaImportacaoDoRecurso(recurso: string): string | null {
  const cfg = IMPORT_TIPOS.find((t) => t.recurso === recurso);
  return cfg ? `/importacao-universal?destino=${cfg.tipo}` : null;
}
