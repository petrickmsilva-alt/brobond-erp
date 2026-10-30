// ============================================================================
// EXTRATO BANCÁRIO PERSISTENTE (P2 §13/§14) — OFX/CSV → conta → transações
// → matching → conciliação.
//
//   • cada linha importada fica gravada em `fin_extrato_transacoes`;
//   • a importação é IDEMPOTENTE por (conta, hash da linha): o FITID do OFX
//     (ou um hash do conteúdo) impede que a mesma transação entre duas vezes;
//   • valor e data não identificam um pagamento: OFX/CSV aguardam revisão;
//   • confirmação e baixa compartilham transação e trava com repasses;
//   • confirmação manual e divergência são endpoints próprios, auditados.
// ============================================================================
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import type { Resource } from './resources';
import { getResource } from './resources';
import { checkAccess, getStore, toHttpError } from './services';
import { currentUser, type AuthUser } from './auth';
import { aplicarFiltroEmpresa, assertRegistroDaEmpresa, escopoDoAtor, empresaDoRegistroAudit } from './empresa';
import { round2, diaISO } from './utils';
import { efetuarBaixa, pareceOFX, parseLinhasExtrato } from './financeiro';
import type { Row, Tx } from './store';

export const R_EXTRATO: Resource = {
  key: 'fin_extrato_transacoes',
  table: 'fin_extrato_transacoes',
  label: 'Transações de extrato',
  singular: 'Transação de extrato',
  labelFields: ['descricao'],
  internal: true,
  empresa: true,
  ops: { create: false, update: false, delete: false },
  orderBy: { field: 'id', dir: 'desc' },
  fields: [
    { name: 'empresa_id', label: 'Empresa', type: 'integer', readonly: true },
    { name: 'conta_id', label: 'Conta', type: 'integer' },
    { name: 'origem', label: 'Origem', type: 'text' },
    { name: 'linha_hash', label: 'Identificador', type: 'text', readonly: true },
    { name: 'fitid', label: 'FITID', type: 'text' },
    { name: 'data', label: 'Data', type: 'date' },
    { name: 'valor', label: 'Valor', type: 'money' },
    { name: 'direcao', label: 'Direção', type: 'text' },
    { name: 'descricao', label: 'Descrição', type: 'text' },
    { name: 'documento', label: 'Documento', type: 'text' },
    { name: 'codigo_movimento', label: 'Cód. movimento', type: 'text' },
    { name: 'lancamento_id', label: 'Lançamento', type: 'integer' },
    { name: 'baixa_lancamento_id', label: 'Efeito da baixa', type: 'integer', readonly: true },
    { name: 'status', label: 'Status', type: 'text' },
    { name: 'motivo', label: 'Motivo', type: 'text' },
    { name: 'conciliado_em', label: 'Conciliado em', type: 'datetime', readonly: true },
    { name: 'importado_em', label: 'Importado em', type: 'datetime', readonly: true },
  ],
};

/**
 * Identificador estável da linha: FITID quando o banco fornece (OFX), senão
 * um hash do conteúdo. É a chave da idempotência de importação.
 */
export function hashLinhaExtrato(linha: { fitid?: string | null; data?: string; valor?: number; direcao?: string; descricao?: string; documento?: string; codigo_movimento?: string }): string {
  const fitid = String(linha.fitid || '').trim();
  if (fitid) return `fitid:${fitid.toLowerCase()}`;
  const base = [String(linha.data || ''), round2(Number(linha.valor || 0)).toFixed(2), String(linha.direcao || ''), String(linha.descricao || '').toLowerCase().trim(), String(linha.documento || ''), String(linha.codigo_movimento || '')].join('|');
  return `h:${createHash('sha1').update(base).digest('hex')}`;
}

/**
 * OFX/CSV é evidência bancária, não prova da identidade de um título.
 * Importa idempotentemente e deixa TODAS as linhas para revisão; o fato de
 * existir um único valor/data compatível não autoriza movimentar caixa.
 */
export async function importarExtrato(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const body = (req.body || {}) as Record<string, unknown>;
  const contaId = Number(body.conta_id || 0);
  if (!Number.isSafeInteger(contaId) || contaId <= 0) throw new HttpError(400, 'Informe a conta bancária da importação (conta_id).', { conta_id: 'Obrigatório' });
  const s = getStore();
  const conta = assertRegistroDaEmpresa(getResource('contas_financeiras')!, await s.get(getResource('contas_financeiras')!, contaId), escopo);
  const conteudo = String(body.conteudo || body.texto || body.csv || body.extrato || body.ofx || '');
  const fonte = pareceOFX(conteudo) ? 'ofx' : 'csv';
  const linhas = conteudo ? parseLinhasExtrato({ [fonte === 'ofx' ? 'ofx' : 'texto']: conteudo }) : parseLinhasExtrato(body);
  if (!linhas.length) throw new HttpError(400, 'Nenhuma linha válida no extrato. Cole o conteúdo OFX ou linhas data;valor;descrição.');
  const { locked } = await import('../../modules/payments/infrastructure/locking');

  // Uma transação por arquivo: erro em qualquer linha não deixa importação
  // parcial; a mesma trava protege também os vínculos com repasses.
  let resultado: { importadas: Row[]; duplicadas: number };
  try {
    resultado = await locked(escopo.empresaId, 'payout-bank-match', async (tx) => {
      const importadas: Row[] = [];
      let duplicadas = 0;
      const identidadesNoArquivo = new Set<string>();
      for (const linha of linhas) {
        const direcao = linha.direcao ?? 'entrada';
        const hash = hashLinhaExtrato({ ...linha, direcao });
        if (identidadesNoArquivo.has(hash)) throw new HttpError(409, 'O arquivo contém linhas indistinguíveis ou identificador repetido; revise antes de importar.', undefined, 'EXTRATO_ARQUIVO_AMBIGUO');
        identidadesNoArquivo.add(hash);
        let existente = await s.findOneWhere(R_EXTRATO, { empresa_id: escopo.empresaId, conta_id: contaId, linha_hash: hash }, tx);
        // O parser CSV antigo descartava a direção ANTES de calcular o hash.
        // Reconheça esse identificador histórico; nunca duplique uma linha ao
        // atualizar o sistema. Saída antiga registrada como entrada diverge.
        if (!existente && fonte === 'csv') {
          const hashLegado = hashLinhaExtrato({ ...linha, direcao: undefined });
          if (hashLegado !== hash) existente = await s.findOneWhere(R_EXTRATO, { empresa_id: escopo.empresaId, conta_id: contaId, linha_hash: hashLegado }, tx);
        }
        if (existente) {
          // FITID igual e conteúdo financeiro diferente NÃO é replay válido.
          if (diaISO(existente.data) !== diaISO(linha.data) || Math.round(Number(existente.valor) * 100) !== Math.round(linha.valor * 100) || String(existente.direcao) !== direcao) {
            throw new HttpError(409, 'Identificador bancário repetido com data, valor ou direção divergente; revise o extrato.', undefined, 'EXTRATO_IDENTIFICADOR_DIVERGENTE');
          }
          if (!linha.fitid) throw new HttpError(409, 'Uma linha sem identificador já possui o mesmo conteúdo; não é possível distinguir replay de outra transação. Revise o extrato.', undefined, 'EXTRATO_SEM_IDENTIFICADOR_AMBIGUO');
          if (String(existente.fitid || '') !== String(linha.fitid)) throw new HttpError(409, 'Identificadores bancários diferem apenas em maiúsculas/minúsculas; revise antes de importar.', undefined, 'EXTRATO_IDENTIFICADOR_DIVERGENTE');
          duplicadas++;
          continue;
        }
        importadas.push(await s.insert(R_EXTRATO, {
          empresa_id: escopo.empresaId, conta_id: contaId, origem: fonte,
          linha_hash: hash, fitid: linha.fitid ?? null, data: linha.data || null,
          valor: round2(linha.valor), direcao, descricao: linha.descricao || null, status: 'importada',
        }, tx));
      }
      await s.audit({ usuario_id: actor.id || null, usuario: actor.name, acao: 'criar', recurso: 'fin_extrato_transacoes', registro_id: contaId,
        descricao: `Extrato ${fonte.toUpperCase()} importado na conta "${conta.nome}": ${importadas.length} linha(s) nova(s), ${duplicadas} duplicada(s); revisão pendente`,
        dados: { conta_id: contaId, fonte, importadas: importadas.length, duplicadas, conciliadas: 0 },
        empresa_id: empresaDoRegistroAudit(getResource('contas_financeiras')!, conta, actor) }, tx);
      return { importadas, duplicadas };
    }, 'read committed');
  } catch (error) { throw toHttpError(error, R_EXTRATO); }

  const pendentes = resultado.importadas.map((linha) => ({ extrato_id: Number(linha.id), data: (linha.data as string | null) ?? null,
    valor: Number(linha.valor), direcao: String(linha.direcao), descricao: (linha.descricao as string | null) ?? null }));
  res.json({ ok: true, fonte, conta_id: contaId, totalLinhas: linhas.length, importadas: resultado.importadas.length, duplicadas: resultado.duplicadas,
    conciliadas: 0, conciliadas_detalhe: [], pendentes });
}

/** GET /api/financeiro/extrato — linhas importadas (filtro conta/status). */
export async function listarExtrato(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const s = getStore();
  const filtro: Record<string, unknown> = {};
  const page = req.query.page === undefined ? 1 : Number(req.query.page);
  const pageSize = req.query.pageSize === undefined ? 100 : Number(req.query.pageSize);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500)
    throw new HttpError(400, 'Paginação inválida.');
  if (req.query.conta_id !== undefined) {
    const conta = Number(req.query.conta_id);
    if (!Number.isSafeInteger(conta) || conta <= 0) throw new HttpError(400, 'Conta inválida.');
    filtro.conta_id = conta;
  }
  if (req.query.status !== undefined) {
    const status = String(req.query.status);
    if (!['importada', 'conciliada', 'divergente', 'ignorada'].includes(status)) throw new HttpError(400, 'Situação inválida.');
    filtro.status = status;
  }
  const out = await s.list(R_EXTRATO, { page, pageSize, filter: aplicarFiltroEmpresa(R_EXTRATO, filtro, escopo) });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ total: out.total, page, pageSize, linhas: out.rows });
}

/** Baixa e vínculo são um único commit, compartilhando a trava de repasse.
 * O título pode ter várias parciais; cada extrato aponta ao filho específico.
 * Não executa chamadas externas e é seguro reexecutar o MESMO vínculo. */
export async function conciliarExtratoComLancamento(
  empresaId: number, linhaId: number, lancId: number, actor: { id: number | null; name: string },
  origem: 'extrato' | 'cnab', nota: string, transacaoBloqueada?: Tx
) {
  const s = getStore();
  const { locked } = await import('../../modules/payments/infrastructure/locking');
  const { R_PAYOUTS } = await import('../../modules/payments/infrastructure/resources');
  try {
    const conciliar = async (tx: Tx) => {
      const linha = await s.findOneWhere(R_EXTRATO, { empresa_id: empresaId, id: linhaId }, tx);
      if (!linha) throw new HttpError(404, 'Linha de extrato não encontrada.');
      const lanc = await s.findOneWhere(getResource('lancamentos_financeiros')!, { empresa_id: empresaId, id: lancId }, tx);
      if (!lanc) throw new HttpError(404, 'Lançamento não encontrado.');
      if (await s.findOneWhere(R_PAYOUTS, { empresa_id: empresaId, bank_transaction_id: linhaId }, tx))
        throw new HttpError(409, 'Esta linha está vinculada a um repasse; desvincule-o antes de baixar outro título.');
      const dataExtrato = diaISO(linha.data);
      const dataComprovada = /^\d{4}-\d{2}-\d{2}$/.test(dataExtrato) && Number.isFinite(Date.parse(`${dataExtrato}T12:00:00Z`)) && new Date(`${dataExtrato}T12:00:00Z`).toISOString().slice(0, 10) === dataExtrato;
      if (!dataComprovada) throw new HttpError(409, 'Linha de extrato sem data válida exige revisão antes da baixa.');
      if (linha.status === 'conciliada') {
        const efeitoId = Number(linha.baixa_lancamento_id);
        const efeito = efeitoId > 0 ? await s.findOneWhere(getResource('lancamentos_financeiros')!, { empresa_id: empresaId, id: efeitoId }, tx) : null;
        const pertence = efeito && (efeitoId === lancId || (efeito.referencia_tipo === 'baixa' && Number(efeito.referencia_id) === lancId));
        if (Number(linha.lancamento_id) === lancId && pertence && efeito.status === 'confirmado' &&
            efeito.tipo === (linha.direcao === 'entrada' ? 'receita' : 'despesa') && Number(efeito.conta_id) === Number(linha.conta_id) &&
            Math.round(Number(efeito.valor) * 100) === Math.round(Number(linha.valor) * 100) && diaISO(efeito.data_baixa) === dataExtrato)
          return { resultado: null, linha, idempotente: true };
        throw new HttpError(409, 'Esta linha já está conciliada ou precisa de revisão da evidência histórica.');
      }
      if (linha.status !== 'importada' || linha.lancamento_id || linha.baixa_lancamento_id)
        throw new HttpError(409, 'A linha não está disponível para conciliação.');
      if (String(lanc.status) !== 'pendente') throw new HttpError(409, 'O título não está pendente; revise a evidência antes de conciliá-lo.');
      if ((linha.direcao === 'entrada' && lanc.tipo !== 'receita') || (linha.direcao === 'saida' && lanc.tipo !== 'despesa') || !['entrada', 'saida'].includes(String(linha.direcao)))
        throw new HttpError(409, 'A direção da linha bancária não corresponde ao tipo do título.');
      if (!Number(linha.conta_id) || (lanc.conta_id && Number(lanc.conta_id) !== Number(linha.conta_id)))
        throw new HttpError(409, 'A conta do extrato não corresponde à conta do título.');
      const valor = Number(linha.valor); const titulo = Number(lanc.valor);
      if (!Number.isFinite(valor) || valor <= 0 || !Number.isFinite(titulo) || Math.round(valor * 100) > Math.round(titulo * 100))
        throw new HttpError(409, 'O valor do extrato excede o saldo do título ou é inválido; revise a divergência.');
      const parcial = Math.round(valor * 100) < Math.round(titulo * 100);
      const liquido = Number(lanc.valor_liquido || titulo);
      if (Number(lanc.taxa_pct || 0) !== 0 || Math.round(liquido * 100) !== Math.round(titulo * 100))
        throw new HttpError(409, 'Título com taxa ou líquido diferente do bruto exige revisão; não é possível presumir baixa.');
      const resultado = await efetuarBaixa(actor, lancId, { valor: parcial ? valor : undefined,
        data: dataExtrato, conta_id: linha.conta_id, origem, nota }, tx);
      const efeitoId = resultado.parcial ? resultado.filhos[0] : lancId;
      if (!efeitoId) throw new HttpError(409, 'Não foi possível identificar o efeito financeiro da baixa.');
      const atualizada = await s.tryUpdateIf(R_EXTRATO, linhaId, { empresa_id: empresaId, status: 'importada', lancamento_id: null, baixa_lancamento_id: null },
        { status: 'conciliada', lancamento_id: lancId, baixa_lancamento_id: efeitoId, conciliado_em: new Date().toISOString() }, tx);
      if (!atualizada) throw new HttpError(409, 'A linha foi alterada durante a conciliação.');
      await s.audit({ usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: R_EXTRATO.key, registro_id: linhaId,
        descricao: `Conciliação bancária da linha #${linhaId} com título #${lancId}`,
        empresa_id: empresaId, dados: { lancamento_id: lancId, baixa_lancamento_id: efeitoId, parcial: resultado.parcial, origem } }, tx);
      return { resultado, linha: atualizada, idempotente: false };
    };
    // Um chamador que fornece transação já deve possuir a MESMA trava. `null`
    // representa a transação do Store de memória e não abre uma transação nova.
    return transacaoBloqueada !== undefined ? await conciliar(transacaoBloqueada) :
      await locked(empresaId, 'payout-bank-match', conciliar, 'read committed');
  } catch (error) { throw toHttpError(error, R_EXTRATO); }
}

/** POST /api/financeiro/extrato/:id/conciliar — confirmação explícita. */
export async function conciliarLinhaManual(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const linhaId = Number(req.params.id); const lancId = Number((req.body || {}).lancamento_id || 0);
  if (!Number.isSafeInteger(linhaId) || linhaId <= 0 || !Number.isSafeInteger(lancId) || lancId <= 0)
    throw new HttpError(400, 'Informe identificadores válidos da linha e do lançamento.');
  const out = await conciliarExtratoComLancamento(escopo.empresaId, linhaId, lancId,
    { id: actor.id || null, name: actor.name }, 'extrato', `Confirmação manual da linha de extrato #${linhaId}`);
  res.json({ ok: true, extrato_id: linhaId, lancamento_id: lancId, baixa_lancamento_id: out.linha.baixa_lancamento_id,
    idempotente: out.idempotente, parcial: out.resultado?.parcial ?? null, restante: out.resultado?.restante ?? null });
}

/** GET /api/financeiro/extrato/:id — sem dados de outras empresas. */
export async function detalheExtrato(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const linhaId = Number(req.params.id);
  if (!Number.isSafeInteger(linhaId) || linhaId <= 0) throw new HttpError(400, 'Identificador inválido.');
  const linha = await getStore().findOneWhere(R_EXTRATO, { empresa_id: escopo.empresaId, id: linhaId });
  if (!linha) throw new HttpError(404, 'Linha de extrato não encontrada.');
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ linha });
}

/** POST /api/financeiro/extrato/:id/divergir — marca divergência (auditoria). */
export async function marcarDivergencia(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const s = getStore();
  const motivo = String((req.body || {}).motivo || '').trim();
  if (motivo.length < 5 || motivo.length > 500) throw new HttpError(400, 'Descreva a divergência (mínimo 5 e máximo 500 caracteres).', { motivo: 'Entre 5 e 500 caracteres' });
  const linhaId = Number(req.params.id);
  if (!Number.isSafeInteger(linhaId) || linhaId <= 0) throw new HttpError(400, 'Identificador inválido.');
  // Mesmo lock da conciliação Payment: o extrato não pode se tornar
  // divergente entre a validação e o vínculo. Não altera nenhum lançamento.
  const { locked } = await import('../../modules/payments/infrastructure/locking');
  const { R_PAYOUTS } = await import('../../modules/payments/infrastructure/resources');
  const idempotente = await locked(escopo.empresaId, 'payout-bank-match', async (tx) => {
    const linha = await s.findOneWhere(R_EXTRATO, { empresa_id: escopo.empresaId, id: linhaId }, tx);
    if (!linha) throw new HttpError(404, 'Linha de extrato não encontrada.');
    if (String(linha.status) === 'conciliada') throw new HttpError(409, 'Linha já conciliada — o caminho é o estorno, não divergência.');
    if (linha.status === 'divergente') {
      if (linha.motivo === motivo) return true;
      throw new HttpError(409, 'Linha já divergente com outro motivo; revise o histórico.');
    }
    if (linha.status !== 'importada') throw new HttpError(409, 'Linha não está disponível para registrar divergência.');
    await s.update(R_EXTRATO, linhaId, { status: 'divergente', motivo }, tx);
    const payout = await s.findOneWhere(R_PAYOUTS, { empresa_id: escopo.empresaId, bank_transaction_id: linhaId }, tx);
    if (payout && payout.status !== 'DIVERGENT') {
      await s.update(R_PAYOUTS, Number(payout.id), { status: 'DIVERGENT', updated_at: new Date().toISOString() }, tx);
      await s.audit({ usuario_id: actor.id || null, usuario: actor.name, acao: 'ajuste', recurso: 'payment_payouts',
        registro_id: Number(payout.id), descricao: 'Repasse divergente após divergência no extrato',
        empresa_id: escopo.empresaId, dados: { bank_transaction_id: linhaId, antes: payout.status, depois: 'DIVERGENT' } }, tx);
    }
    await s.audit({ usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'fin_extrato_transacoes',
      registro_id: linhaId, descricao: `Divergência registrada na linha de extrato #${linhaId}`,
      empresa_id: escopo.empresaId, dados: { motivo_registrado: true } }, tx);
    return false;
  }, 'read committed');
  res.json({ ok: true, extrato_id: linhaId, status: 'divergente', idempotente });
}
