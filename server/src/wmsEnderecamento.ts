// Metadados de endereço nos locais CANÔNICOS do estoque. Movimentações,
// reservas e saldos continuam nos recursos existentes do ERP.
import { HttpError } from './errors';
import { getResource } from './resources';
import type { Payload, Row, Store, Tx } from './store';

export async function validarEnderecoWms(s: Store, empresaId: number, data: Payload, anterior: Row | null, tx: Tx) {
  const nivel = String(data.nivel_wms ?? anterior?.nivel_wms ?? 'local');
  const pai = data.local_pai_id !== undefined ? data.local_pai_id : anterior?.local_pai_id;
  const paiId = pai === null || pai === undefined || pai === '' ? null : Number(pai);
  if (!['local', 'armazem', 'zona', 'endereco'].includes(nivel)) throw new HttpError(400, 'Nível de endereço inválido.');
  if (['local', 'armazem'].includes(nivel) && paiId !== null) throw new HttpError(400, 'Local independente e armazém não têm local pai.');
  if (['zona', 'endereco'].includes(nivel) && (!Number.isInteger(paiId) || !paiId || paiId <= 0)) throw new HttpError(400, 'Informe o local pai para a zona ou endereço.');
  if (paiId !== null) {
    if (anterior && Number(anterior.id) === paiId) throw new HttpError(400, 'Um local não pode ser pai de si mesmo.');
    const localPai = await s.findOneWhere(getResource('locais')!, { id: paiId, empresa_id: empresaId }, tx);
    if (!localPai) throw new HttpError(404, 'Local pai não encontrado.');
    const esperado = nivel === 'zona' ? 'armazem' : 'zona';
    if (localPai.ativo === false || String(localPai.nivel_wms ?? 'local') !== esperado)
      throw new HttpError(409, `O local pai deve ser um(a) ${esperado} ativo(a) da mesma empresa.`);
  }
  if (anterior && (nivel !== String(anterior.nivel_wms ?? 'local') || data.ativo === false)) {
    const filhos = await s.countWhere(getResource('locais')!, { empresa_id: empresaId, local_pai_id: Number(anterior.id) }, tx);
    if (filhos) throw new HttpError(409, 'Local com endereços dependentes não pode ser desativado ou ter seu nível alterado.');
  }
}
