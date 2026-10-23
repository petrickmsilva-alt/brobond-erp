// ============================================================================
// CLIENTES — endpoints específicos do cadastro profissional PF/PJ.
//
// O CRUD genérico (/api/clientes) continua sendo o caminho de gravação; este
// módulo só expõe a consulta de DUPLICIDADE que o formulário usa para avisar
// "já existe um cliente com este CPF/CNPJ" ANTES de salvar — e oferecer o link
// "Abrir cliente". A decisão final de unicidade continua no servidor (regra em
// services.validarRegrasCliente + índice parcial uq_clientes_documento_empresa).
//
// MULTIEMPRESA: a busca é SEMPRE recortada pela empresa ativa do ator. O mesmo
// documento em outra empresa do grupo não aparece (e não bloqueia).
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { apenasDigitos, formatarDocumento, tipoDocumento } from './documentos';
import { clientePorDocumento, escopoDe } from './services';
import { currentUser } from './auth';
import { parseId } from './validate';

/**
 * GET /api/clientes/por-documento?doc=...&ignorar_id=...
 *
 * Responde `{ cliente: { id, nome, pessoa, cnpj_cpf, ativo } | null }` —
 * `null` significa que o documento está livre nesta empresa. A consulta aceita
 * documento com ou sem máscara; a comparação é por dígitos.
 */
export async function clientePorDocumentoHandler(req: Request, res: Response) {
  const doc = String(req.query.doc ?? '').trim();
  const digitos = apenasDigitos(doc);
  if (!digitos || (digitos.length !== 11 && digitos.length !== 14)) {
    throw new HttpError(400, 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).', { doc: 'Documento inválido' });
  }
  const ignorarRaw = req.query.ignorar_id;
  const ignorarId = ignorarRaw === undefined || ignorarRaw === '' ? null : parseId(ignorarRaw);
  const actor = currentUser(req);
  const escopo = escopoDe(actor);

  const existente = await clientePorDocumento(digitos, escopo.empresaId, ignorarId);
  if (!existente) {
    res.json({ cliente: null, disponivel: true });
    return;
  }
  // `ignorar_id` exclui o próprio registro em edição — o form consulta a
  // duplicidade mesmo quando o documento não mudou.
  res.json({
    cliente: {
      id: Number(existente.id),
      nome: String(existente.nome ?? ''),
      pessoa: String(existente.pessoa ?? ''),
      cnpj_cpf: formatarDocumento(existente.cnpj_cpf),
      documento_tipo: tipoDocumento(existente.cnpj_cpf),
      ativo: existente.ativo !== false,
    },
    disponivel: false,
  });
}
