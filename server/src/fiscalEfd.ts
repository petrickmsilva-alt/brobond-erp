// ============================================================================
// FASE 9.5 — ENDPOINTS FISCAIS (leiaute vigente + validação estrutural EFD)
//
// O que estes endpoints FAZEM:
//   • mostram o registro VERSIONADO de leiautes (fonte oficial por versão);
//   • resolvem qual leiaute VIGE num período de apuração;
//   • validam ESTRUTURALMENTE um arquivo EFD já montado (gramática, formatos,
//     blocos, filhos obrigatórios, referências, totais).
//
// O que estes endpoints NÃO fazem (limite de homologação — ver docs/fiscal):
//   • não transmitem arquivo à Receita/SEFAZ;
//   • não assinam digitalmente nem emitem documento fiscal real;
//   • não declaram o ERP homologado. A geração do arquivo a partir dos
//     documentos do ERP e a transmissão dependem de contador + ambiente fiscal.
//
// RBAC: leitura por `gerente` (recurso fiscal_layouts); validação exige acesso
// de leitura ao recurso fiscal (mesma regra das obrigações acessórias).
// ============================================================================
import type { Request, Response } from 'express';
import { currentUser } from './auth';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, escopoDe } from './services';
import { validarEfd, resolverLeiauteVigente, listarLayoutsFiscais, type SistemaFiscal } from './fiscalLayouts';

const R_LAYOUT = () => getResource('fiscal_layouts')!;
const R_OBRIGACAO = () => getResource('fiscal_obrigacoes')!;

const SISTEMAS: SistemaFiscal[] = ['EFD_ICMS_IPI', 'EFD_CONTRIBUICOES'];

function sistemaValido(v: unknown): SistemaFiscal {
  const s = String(v ?? '').trim() as SistemaFiscal;
  if (!SISTEMAS.includes(s)) throw new HttpError(400, `Sistema inválido. Use: ${SISTEMAS.join(', ')}.`);
  return s;
}

/** GET /api/fiscal/layouts — registro versionado (referência global). */
export async function listarLayouts(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_LAYOUT(), actor, 'read');
  const sistema = req.query.sistema ? sistemaValido(req.query.sistema) : undefined;
  const layouts = await listarLayoutsFiscais(sistema);
  return res.json({
    layouts,
    nota: 'Referência versionada. A versão vigente de cada período vem das Notas Técnicas/ADEs oficiais (fonte_url). NÃO é geração nem transmissão fiscal.',
  });
}

/** GET /api/fiscal/layouts/vigente?periodo=AAAA-MM&sistema=... */
export async function layoutVigente(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_LAYOUT(), actor, 'read');
  const sistema = sistemaValido(req.query.sistema);
  const periodo = String(req.query.periodo ?? '').trim();
  const layout = await resolverLeiauteVigente(sistema, periodo);
  return res.json({ sistema, periodo, layout });
}

/**
 * POST /api/fiscal/efd/validar
 * body: { sistema, periodo, linhas: string[] }  ou  { sistema, periodo, conteudo: "|0000|..." }
 * Devolve o relatório de erros/avisos. NÃO grava, NÃO transmite.
 */
export async function validarArquivoEfd(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_OBRIGACAO(), actor, 'read');
  // Escopo de empresa aplicado mesmo sendo validação de conteúdo: exige ator
  // com empresa resolvida (multiempresa validado no servidor).
  escopoDe(actor);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sistema = sistemaValido(body.sistema);
  const periodo = String(body.periodo ?? '').trim();
  const layout = await resolverLeiauteVigente(sistema, periodo);
  let linhas: string[];
  if (Array.isArray(body.linhas)) {
    linhas = body.linhas.map((l) => String(l));
  } else if (typeof body.conteudo === 'string') {
    linhas = body.conteudo.split(/\r?\n/).filter((l) => l.trim() !== '');
  } else {
    throw new HttpError(400, 'Envie "linhas" (array) ou "conteudo" (texto do arquivo).');
  }
  const resultado = validarEfd(sistema, layout.codigo_versao, linhas);
  return res.json({
    ...resultado,
    layout: { codigo_versao: layout.codigo_versao, versao_leiaute: layout.versao_leiaute, fonte_url: layout.fonte_url, ato_normativo: layout.ato_normativo },
    nota: 'Validação ESTRUTURAL (gramática/formatos/blocos/totais/referências). Não substitui a validação do PVA oficial nem declara homologação.',
  });
}
