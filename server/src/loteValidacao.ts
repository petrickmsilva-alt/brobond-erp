// Validação do cadastro de LOTES (migration 0106). Um lote pertence a um
// produto OU a um insumo — nunca aos dois, nunca a nenhum. Lote em uso pelas
// movimentações não pode ser excluído (o histórico aponta para ele): a
// exclusão é recusada aqui com mensagem clara; a FK é a proteção final.
import { HttpError } from './errors';
import { getResource } from './resources';
import type { Payload, Row, Store, Tx } from './store';

export async function validarLote(s: Store, empresaId: number, data: Payload, anterior: Row | null, tx: Tx) {
  const produto = data.produto_id !== undefined ? data.produto_id : anterior?.produto_id;
  const insumo = data.insumo_id !== undefined ? data.insumo_id : anterior?.insumo_id;
  const temProduto = produto !== null && produto !== undefined && produto !== '';
  const temInsumo = insumo !== null && insumo !== undefined && insumo !== '';
  if (temProduto && temInsumo)
    throw new HttpError(400, 'O lote é de um produto OU de um insumo — não informe os dois.', { insumo_id: 'Remova um dos vínculos' });
  if (!temProduto && !temInsumo) throw new HttpError(400, 'Informe o produto ou o insumo do lote.', { produto_id: 'Campo obrigatório' });
  const fab = data.fabricacao ?? anterior?.fabricacao;
  const val = data.validade ?? anterior?.validade;
  if (fab && val && new Date(String(val)) < new Date(String(fab))) {
    throw new HttpError(400, 'A validade não pode ser anterior à fabricação.', { validade: 'Anterior à fabricação' });
  }
}
