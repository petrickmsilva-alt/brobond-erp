// Reexporta só o que os adaptadores/hub precisam do núcleo do ERP. Existe para
// que o módulo `commerce/` não espalhe imports por meia dúzia de arquivos.
export { getStore, storeDoAtor, escopoDe } from '../services';
export { recalcularTotal } from '../itens';
export { RESOURCES } from '../resources';
export { HttpError } from '../errors';
export { escopoDoAtor } from '../empresa';
export type { EscopoEmpresa } from '../empresa';
