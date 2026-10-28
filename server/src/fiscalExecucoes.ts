import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { currentUser } from './auth';
import { assertRegistroDaEmpresa } from './empresa';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, escopoDe, getStore } from './services';
import type { Row, Tx } from './store';
import { parseId } from './validate';

const R_OBRIGACAO = () => getResource('fiscal_obrigacoes')!;
const R_EXECUCAO = () => getResource('fiscal_execucoes')!;
const R_EVIDENCIA = () => getResource('fiscal_execucao_evidencias')!;
const VERSAO_SEM_MANIFESTO = 'manifesto-oficial-nao-configurado';

export function chaveExecucaoFiscal(empresaId: number, obrigacaoId: number, periodo: string, versao: string): string {
  return createHash('sha256').update(`${empresaId}|${obrigacaoId}|${periodo}|${versao}`).digest('hex');
}

function validarPeriodo(v: unknown): string {
  const periodo = String(v ?? '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) throw new HttpError(400, 'Período inválido. Use AAAA-MM.');
  return periodo;
}

async function obterExecucaoEscopada(id: number, empresaId: number, tx?: Tx): Promise<Row> {
  const store = getStore();
  const row = await store.findOneWhere(R_EXECUCAO(), { id, empresa_id: empresaId }, tx);
  if (!row) throw new HttpError(404, 'Execução fiscal não encontrada.');
  return row;
}

/** GET /api/fiscal/obrigacoes/:id/execucoes — histórico completo, sem apagar tentativas. */
export async function listarExecucoesFiscais(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_OBRIGACAO(), actor, 'read');
  const escopo = escopoDe(actor);
  const empresaId = escopo.empresaId;
  const obrigacaoId = parseId(req.params.id);
  const store = getStore();
  const obrigacao = await store.findOneWhere(R_OBRIGACAO(), { id: obrigacaoId, empresa_id: empresaId });
  if (!obrigacao) throw new HttpError(404, 'Obrigação fiscal não encontrada.');
  const execucoes = await store.list(R_EXECUCAO(), {
    page: 1, pageSize: 1000, sort: 'criado_em', dir: 'desc', filter: { empresa_id: empresaId, obrigacao_id: obrigacaoId },
  });
  if (execucoes.total > execucoes.rows.length) throw new HttpError(409, 'Histórico excede o limite seguro; nenhuma lista parcial foi retornada.');
  return res.json({ obrigacao_id: obrigacaoId, execucoes: execucoes.rows });
}

/**
 * POST /api/fiscal/obrigacoes/:id/execucoes.
 * O executor oficial não está configurado neste baseline. Em vez de gerar um
 * arquivo fiscal inventado, grava uma tentativa idempotente em NAO_SUPORTADO, com hash,
 * período, versão/identificador e causa explícita para auditoria.
 */
export async function executarObrigacaoFiscal(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_OBRIGACAO(), actor, 'update');
  const escopo = escopoDe(actor);
  const empresaId = escopo.empresaId;
  const obrigacaoId = parseId(req.params.id);
  const periodo = validarPeriodo(req.body?.periodo);
  const versao = VERSAO_SEM_MANIFESTO;
  const executionHash = chaveExecucaoFiscal(empresaId, obrigacaoId, periodo, versao);
  const store = getStore();
  const agora = new Date().toISOString();

  const existente = await store.findOneWhere(R_EXECUCAO(), { empresa_id: empresaId, obrigacao_id: obrigacaoId, periodo, versao });
  if (existente) return res.status(200).json({ ...existente, idempotente: true, layout_suportado: false });

  let criada: Row | null = null;
  try {
    criada = await store.transaction(async (tx) => {
      const obrigacao = assertRegistroDaEmpresa(
        R_OBRIGACAO(),
        await store.findOneWhere(R_OBRIGACAO(), { id: obrigacaoId, empresa_id: empresaId }, tx),
        escopo
      );
      const repetida = await store.findOneWhere(R_EXECUCAO(), { empresa_id: empresaId, obrigacao_id: obrigacaoId, periodo, versao }, tx);
      if (repetida) return repetida;
      const row = await store.insert(R_EXECUCAO(), {
        empresa_id: empresaId,
        obrigacao_id: Number(obrigacao.id),
        periodo,
        status: 'NAO_SUPORTADO',
        started_at: agora,
        finished_at: agora,
        executed_by: actor.id ?? null,
        versao,
        execution_hash: executionHash,
        resultado: 'NAO_SUPORTADO: nenhum manifesto/leiaute oficial está configurado para geração ou validação nesta instalação.',
      }, tx);
      await store.audit({
        usuario_id: actor.id ?? null, usuario: actor.name, acao: 'criar', recurso: 'fiscal_execucoes',
        registro_id: Number(row?.id), descricao: `Execução fiscal não suportada para obrigação #${obrigacaoId}, período ${periodo}; nenhuma escrituração foi gerada.`,
        dados: { empresa_id: empresaId, obrigacao_id: obrigacaoId, periodo, versao, execution_hash: executionHash, status: 'NAO_SUPORTADO' },
        empresa_id: empresaId,
      }, tx);
      return row;
    });
  } catch (e) {
    // Concorrência: o índice único decide o vencedor; retry encontra a mesma
    // execução em vez de criar uma duplicata silenciosa.
    const retry = await store.findOneWhere(R_EXECUCAO(), { empresa_id: empresaId, obrigacao_id: obrigacaoId, periodo, versao });
    if (retry) return res.status(200).json({ ...retry, idempotente: true, layout_suportado: false });
    throw e;
  }
  return res.status(201).json({ ...criada, idempotente: false, layout_suportado: false });
}

/** POST /api/fiscal/execucoes/:id/evidencias — metadados hashados, anexados e não sobrescritos. */
export async function registrarEvidenciaFiscal(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_OBRIGACAO(), actor, 'update');
  const empresaId = escopoDe(actor).empresaId;
  const execucaoId = parseId(req.params.id);
  const arquivoRef = String(req.body?.arquivo_ref ?? '').trim();
  const hash = String(req.body?.hash_sha256 ?? '').trim().toLowerCase();
  const tamanho = Number(req.body?.tamanho_bytes);
  if (!arquivoRef || arquivoRef.length > 1000) throw new HttpError(400, 'Informe uma referência de arquivo válida.');
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new HttpError(400, 'hash_sha256 deve ser SHA-256 hexadecimal (64 caracteres).');
  if (!Number.isSafeInteger(tamanho) || tamanho <= 0) throw new HttpError(400, 'tamanho_bytes deve ser um inteiro positivo.');
  const store = getStore();
  const evidencia = await store.transaction(async (tx) => {
    const execucao = await obterExecucaoEscopada(execucaoId, empresaId, tx);
    const row = await store.insert(R_EVIDENCIA(), {
      empresa_id: empresaId,
      execucao_id: Number(execucao.id),
      arquivo_ref: arquivoRef,
      hash_sha256: hash,
      tamanho_bytes: tamanho,
      timestamp: new Date().toISOString(),
      usuario_id: actor.id ?? null,
      resultado: 'REGISTRADA_SEM_VALIDACAO_DE_LAYOUT_OFICIAL',
    }, tx);
    await store.audit({
      usuario_id: actor.id ?? null, usuario: actor.name, acao: 'criar', recurso: 'fiscal_execucao_evidencias',
      registro_id: Number(row?.id), descricao: `Evidência registrada para execução fiscal #${execucaoId}.`,
      dados: { empresa_id: empresaId, execucao_id: execucaoId, hash_sha256: hash, tamanho_bytes: tamanho, resultado: 'REGISTRADA_SEM_VALIDACAO_DE_LAYOUT_OFICIAL' },
      empresa_id: empresaId,
    }, tx);
    return row;
  });
  return res.status(201).json(evidencia);
}

/** GET /api/fiscal/execucoes/:id/evidencias — somente leitura e tenant-scoped. */
export async function listarEvidenciasFiscais(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_OBRIGACAO(), actor, 'read');
  const empresaId = escopoDe(actor).empresaId;
  const execucaoId = parseId(req.params.id);
  const store = getStore();
  await obterExecucaoEscopada(execucaoId, empresaId);
  const result = await store.list(R_EVIDENCIA(), { page: 1, pageSize: 1000, sort: 'timestamp', dir: 'asc', filter: { empresa_id: empresaId, execucao_id: execucaoId } });
  if (result.total > result.rows.length) throw new HttpError(409, 'Evidências excedem o limite seguro; nenhuma lista parcial foi retornada.');
  return res.json(result.rows);
}
