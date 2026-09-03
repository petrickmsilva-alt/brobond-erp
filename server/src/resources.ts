// Mapa recurso (rota) -> tabela do banco + dados mock quando não há DB.
// Os nomes de tabela vêm deste mapa controlado por nós (nunca de input do usuário).
export const RESOURCES: Record<
  string,
  { table: string; mock: any[] }
> = {
  produtos: { table: 'produtos', mock: [] },
  insumos: { table: 'insumos', mock: [] },
  fornecedores: { table: 'fornecedores', mock: [] },
  representantes: { table: 'representantes', mock: [] },
  clientes: { table: 'clientes', mock: [] },
  tamanhos: {
    table: 'tamanhos',
    mock: [
      { id: 1, codigo: 'PP' },
      { id: 2, codigo: 'P' },
      { id: 3, codigo: 'M' },
      { id: 4, codigo: 'G' },
      { id: 5, codigo: 'GG' },
    ],
  },
  colecoes: { table: 'colecoes', mock: [] },
  estoques: { table: 'estoques', mock: [] },
  movimentacoes: { table: 'movimentacoes', mock: [] },
  ordens: { table: 'ordens_fabricacao', mock: [] },
  fichas: { table: 'fichas_tecnicas', mock: [] },
  compras: { table: 'compras', mock: [] },
  vendas: { table: 'vendas', mock: [] },
  usuarios: { table: 'usuarios', mock: [] },
};
