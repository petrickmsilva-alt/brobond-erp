// ============================================================================
// CNAB (P2 §12) — camada de PARSER/ADAPTADOR para arquivos de retorno.
//
// Nenhum banco é assumido: cada layout se registra como um `CnabParser`
// (detecta + parseRetorno). Hoje existe o parser do padrão FEBRABAN CNAB 240
// (segmentos T/U — arquivo de retorno de cobrança), válido como base para a
// maioria dos bancos; layout proprietário entra registrando outro parser.
//
// Regras duras:
//   • um título NUNCA é considerado pago por posição presumida no arquivo —
//     a identificação vem do NOSSO NÚMERO/DOCUMENTO da linha e do código de
//     movimento (liquidação); sem identificação confiável a linha vira
//     divergência para conferência manual;
//   • idempotência: a mesma linha (nosso nº + movimento + data + valor) não
//     importa duas vezes na mesma conta (hash único em fin_extrato_transacoes);
//   • liquidação confirmada baixa o título pelo MESMO núcleo idempotente
//     (efetuarBaixa) — reprocessar o arquivo não gera segunda baixa.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore } from './services';
import { currentUser, type AuthUser } from './auth';
import { aplicarFiltroEmpresa, assertRegistroDaEmpresa, escopoDoAtor, empresaDoAtorAudit } from './empresa';
import { round2 } from './utils';
import { efetuarBaixa } from './financeiro';
import { hashLinhaExtrato, R_EXTRATO } from './extrato';
import { R_GATEWAY_COBRANCAS } from './gateway';
import type { Row } from './store';

// ----------------------------------------------------------------------------
// Contrato do parser
// ----------------------------------------------------------------------------

export type TipoMovimentoCnab = 'liquidacao' | 'entrada_confirmada' | 'rejeicao' | 'baixa' | 'divergente' | 'desconhecido';

export type CnabRetornoLinha = {
  banco: string | null;
  nosso_numero: string;
  documento: string;
  codigo_movimento: string;
  data_ocorrencia: string | null;
  data_credito: string | null;
  valor_titulo: number;
  valor_pago: number;
  tipo: TipoMovimentoCnab;
  descricao?: string;
};

export interface CnabParser {
  readonly id: string;
  readonly nome: string;
  /** Verifica se o conteúdo pertence a este layout. */
  detecta(conteudo: string): boolean;
  /** Converte o arquivo de RETORNO em linhas normalizadas. */
  parseRetorno(conteudo: string): CnabRetornoLinha[];
}

const parsers: CnabParser[] = [];

export function registrarCnabParser(p: CnabParser): void {
  if (!parsers.some((x) => x.id === p.id)) parsers.push(p);
}

export function listarCnabParsers(): { id: string; nome: string }[] {
  return parsers.map((p) => ({ id: p.id, nome: p.nome }));
}

export function detectarParser(conteudo: string): CnabParser | null {
  return parsers.find((p) => p.detecta(conteudo)) || null;
}

// ----------------------------------------------------------------------------
// FEBRABAN CNAB 240 — retorno de cobrança (segmentos T e U), genérico.
// Posições (1-based) conforme o layout padrão FEBRABAN; bancos com
// particularidades devem registrar o próprio parser.
// ----------------------------------------------------------------------------

/** Converte campo numérico com 2 decimais implícitos ("0000000012345" → 123.45). */
function num2(campo: string): number {
  const limpo = campo.replace(/\D/g, '');
  if (!limpo) return 0;
  const n = Number(limpo) / 100;
  return Number.isFinite(n) ? round2(n) : 0;
}

function dataBr(campo: string): string | null {
  const d = campo.replace(/\D/g, '');
  if (d.length !== 8 || d === '00000000') return null;
  return `${d.slice(4, 8)}-${d.slice(2, 4)}-${d.slice(0, 2)}`;
}

/** Classificação CONSERVADORA do código de movimento (FEBRABAN C004). */
export function classificarMovimentoCnab240(codigo: string): TipoMovimentoCnab {
  switch (codigo) {
    case '02':
      return 'entrada_confirmada';
    case '03':
      return 'rejeicao';
    case '06':
      // Único código tratado como LIQUIDAÇÃO sem ressalvas. Os demais
      // códigos de liquidação variam por banco e viram divergência.
      return 'liquidacao';
    case '09':
    case '10':
      return 'baixa';
    default:
      return 'desconhecido';
  }
}

export const cnab240Parser: CnabParser = {
  id: 'cnab240',
  nome: 'CNAB 240 (FEBRABAN — retorno de cobrança)',
  detecta(conteudo: string): boolean {
    const linhas = conteudo.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (!linhas.length) return false;
    // Arquivo CNAB 240: linhas de ~240 posições; header de arquivo tem tipo
    // de registro "0" na posição 8.
    const primeira = linhas[0];
    return primeira.length >= 200 && primeira.charAt(7) === '0';
  },
  parseRetorno(conteudo: string): CnabRetornoLinha[] {
    const linhas = conteudo.split(/\r?\n/);
    const banco = (linhas[0] || '').slice(0, 3).replace(/\D/g, '') || null;
    const saida: CnabRetornoLinha[] = [];
    let corrente: CnabRetornoLinha | null = null;

    for (const bruta of linhas) {
      if (bruta.length < 100) continue;
      const tipoRegistro = bruta.charAt(7);
      if (tipoRegistro !== '3') continue; // só detalhes interessam
      const segmento = bruta.charAt(13);

      if (segmento === 'T') {
        // Segmento T: identificação do título.
        const codigoMovimento = bruta.slice(15, 17);
        const nossoNumero = bruta.slice(37, 57).trim();
        const documento = bruta.slice(58, 73).trim();
        const valorTitulo = num2(bruta.slice(81, 96));
        const tipo = classificarMovimentoCnab240(codigoMovimento);
        corrente = {
          banco,
          nosso_numero: nossoNumero,
          documento,
          codigo_movimento: codigoMovimento,
          data_ocorrencia: null,
          data_credito: null,
          valor_titulo: valorTitulo,
          valor_pago: 0,
          tipo,
        };
        saida.push(corrente);
      } else if (segmento === 'U' && corrente) {
        // Segmento U: valores pagos/datas — completa o T imediatamente anterior.
        corrente.valor_pago = num2(bruta.slice(77, 92));
        corrente.data_ocorrencia = dataBr(bruta.slice(137, 145));
        corrente.data_credito = dataBr(bruta.slice(145, 153));
        corrente = null;
      }
    }
    return saida;
  },
};

registrarCnabParser(cnab240Parser);

// ----------------------------------------------------------------------------
// Importação do arquivo de retorno
// ----------------------------------------------------------------------------

/**
 * POST /api/financeiro/cnab/importar
 * { conta_id, conteudo }
 *
 * Para cada linha de LIQUIDAÇÃO: identifica o título pelo nosso número
 * (cobrança emitida via gateway) ou por matching confiável — nunca pela
 * posição no arquivo — e baixa pelo núcleo idempotente. Rejeições e linhas
 * não identificadas viram divergência para conferência.
 */
export async function importarCnab(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const body = (req.body || {}) as Record<string, unknown>;
  const contaId = Number(body.conta_id || 0);
  if (!(contaId > 0)) throw new HttpError(400, 'Informe a conta bancária da importação (conta_id).', { conta_id: 'Obrigatório' });
  const conteudo = String(body.conteudo || body.arquivo || '');
  if (!conteudo.trim()) throw new HttpError(400, 'Envie o conteúdo do arquivo de retorno em `conteudo`.');

  const parser = detectarParser(conteudo);
  if (!parser) {
    throw new HttpError(400, `Layout de CNAB não reconhecido. Parsers disponíveis: ${listarCnabParsers().map((p) => p.id).join(', ')}.`);
  }

  const s = getStore();
  const conta = assertRegistroDaEmpresa(getResource('contas_financeiras')!, await s.get(getResource('contas_financeiras')!, contaId), escopo);
  const linhas = parser.parseRetorno(conteudo);
  if (!linhas.length) throw new HttpError(400, 'O arquivo não contém linhas de detalhe (segmentos T/U).');

  const detalhes: { nosso_numero: string; movimento: string; tipo: string; valor: number; resultado: string; lancamento_id: number | null }[] = [];
  let novas = 0;
  let duplicadas = 0;
  let liquidadas = 0;
  let divergentes = 0;

  // Títulos pendentes do escopo (para o matching por valor+data).
  const lancR = await s.list(getResource('lancamentos_financeiros')!, { page: 1, pageSize: 100000, filter: aplicarFiltroEmpresa(getResource('lancamentos_financeiros')!, undefined, escopo) });
  const pendentes = lancR.rows.filter((l) => String(l.status) === 'pendente' && ['receita', 'despesa'].includes(String(l.tipo)));

  for (const linha of linhas) {
    const hash = hashLinhaExtrato({ data: linha.data_ocorrencia || '', valor: linha.valor_pago || linha.valor_titulo, direcao: 'entrada', descricao: linha.documento, documento: linha.nosso_numero, codigo_movimento: linha.codigo_movimento });
    const existente = await s.findOneWhere(R_EXTRATO, { conta_id: contaId, linha_hash: hash });
    if (existente) {
      duplicadas++;
      continue;
    }
    novas++;

    // Identificação do título: NUNCA por posição presumida.
    let lancAlvo: Row | null = null;
    let viaIdentificacao = '';
    if (linha.nosso_numero) {
      const cobrancas = await s.list(R_GATEWAY_COBRANCAS, { page: 1, pageSize: 5, filter: { empresa_id: escopo.empresaId, nosso_numero: linha.nosso_numero } });
      const cobranca = cobrancas.rows[0];
      if (cobranca?.lancamento_id) {
        lancAlvo = await s.get(getResource('lancamentos_financeiros')!, Number(cobranca.lancamento_id));
        viaIdentificacao = `nosso número ${linha.nosso_numero} (cobrança #${cobranca.id})`;
      }
    }
    if (!lancAlvo && linha.documento && /^\d+$/.test(linha.documento)) {
      // documento numérico pode ser o id da venda/compra de origem do título
      for (const ref of ['venda', 'compra']) {
        const origem = await s.findOneWhere(getResource(ref === 'venda' ? 'vendas' : 'compras')!, { id: Number(linha.documento), empresa_id: escopo.empresaId });
        if (origem) {
          const parcelas = pendentes.filter((l) => String(l.referencia_tipo) === ref && Number(l.referencia_id) === Number(linha.documento));
          const porValor = parcelas.filter((l) => Math.abs(Number(l.valor || 0) - (linha.valor_pago || linha.valor_titulo)) < 0.01);
          if (porValor.length === 1) {
            lancAlvo = porValor[0];
            viaIdentificacao = `documento ${linha.documento} (${ref} #${linha.documento})`;
          }
          break;
        }
      }
    }

    const statusBase = linha.tipo === 'liquidacao' ? 'importada' : linha.tipo === 'rejeicao' ? 'divergente' : 'importada';
    const row = await s.insert(R_EXTRATO, {
      empresa_id: escopo.empresaId,
      conta_id: contaId,
      origem: 'cnab',
      linha_hash: hash,
      data: linha.data_ocorrencia || null,
      valor: round2(linha.valor_pago || linha.valor_titulo),
      direcao: 'entrada',
      descricao: `CNAB ${parser.id} · mov ${linha.codigo_movimento}${linha.nosso_numero ? ` · NN ${linha.nosso_numero}` : ''}`,
      documento: linha.nosso_numero || linha.documento || null,
      codigo_movimento: linha.codigo_movimento,
      status: statusBase,
      motivo: linha.tipo === 'rejeicao' ? `Movimento ${linha.codigo_movimento}: entrada rejeitada pelo banco.` : null,
    });

    // Só LIQUIDAÇÃO baixa título — e só com título identificado.
    if (linha.tipo !== 'liquidacao') {
      if (linha.tipo === 'rejeicao') divergentes++;
      if (linha.tipo === 'baixa' || linha.tipo === 'desconhecido') {
        // Movimento ambíguo: divergência para decisão humana (nunca baixa automática).
        await s.update(R_EXTRATO, Number(row.id), { status: 'divergente', motivo: `Movimento ${linha.codigo_movimento} não é liquidação inequívoca — exige conferência manual.` });
        divergentes++;
      }
      detalhes.push({ nosso_numero: linha.nosso_numero, movimento: linha.codigo_movimento, tipo: linha.tipo, valor: round2(linha.valor_pago || linha.valor_titulo), resultado: 'registrada sem baixa', lancamento_id: null });
      continue;
    }

    if (!lancAlvo) {
      await s.update(R_EXTRATO, Number(row.id), { status: 'divergente', motivo: 'Liquidação sem título identificado (nosso número/documento não casou) — conferir manualmente.' });
      divergentes++;
      detalhes.push({ nosso_numero: linha.nosso_numero, movimento: linha.codigo_movimento, tipo: linha.tipo, valor: round2(linha.valor_pago || linha.valor_titulo), resultado: 'divergente: título não identificado', lancamento_id: null });
      continue;
    }

    if (String(lancAlvo.status) !== 'pendente') {
      // Já baixado (arquivo repetido ou baixa manual): idempotência.
      await s.update(R_EXTRATO, Number(row.id), { status: 'conciliada', lancamento_id: Number(lancAlvo.id), conciliado_em: new Date().toISOString(), motivo: 'Título já estava baixado.' });
      liquidadas++;
      detalhes.push({ nosso_numero: linha.nosso_numero, movimento: linha.codigo_movimento, tipo: linha.tipo, valor: round2(linha.valor_pago || linha.valor_titulo), resultado: 'título já baixado', lancamento_id: Number(lancAlvo.id) });
      continue;
    }

    const valorPago = linha.valor_pago > 0 ? linha.valor_pago : linha.valor_titulo;
    const valorTitulo = Number(lancAlvo.valor || 0);
    try {
      await efetuarBaixa(
        { id: actor.id || null, name: actor.name },
        Number(lancAlvo.id),
        {
          valor: valorPago > 0 && valorPago < valorTitulo - 0.009 ? valorPago : null,
          data: linha.data_ocorrencia || undefined,
          conta_id: contaId,
          origem: 'cnab',
          nota: `CNAB ${parser.id} — movimento ${linha.codigo_movimento} · ${viaIdentificacao || 'matching por valor/documento'}`,
        }
      );
    } catch (e: any) {
      await s.update(R_EXTRATO, Number(row.id), { status: 'divergente', motivo: `Falha na baixa: ${String(e?.message || e).slice(0, 160)}` });
      divergentes++;
      detalhes.push({ nosso_numero: linha.nosso_numero, movimento: linha.codigo_movimento, tipo: linha.tipo, valor: round2(valorPago), resultado: `erro: ${String(e?.message || e).slice(0, 100)}`, lancamento_id: Number(lancAlvo.id) });
      continue;
    }
    await s.update(R_EXTRATO, Number(row.id), { status: 'conciliada', lancamento_id: Number(lancAlvo.id), conciliado_em: new Date().toISOString() });
    pendentes.splice(pendentes.indexOf(lancAlvo), 1);
    liquidadas++;
    detalhes.push({ nosso_numero: linha.nosso_numero, movimento: linha.codigo_movimento, tipo: linha.tipo, valor: round2(valorPago), resultado: `liquidado via ${viaIdentificacao || 'matching'}`, lancamento_id: Number(lancAlvo.id) });
  }

  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'criar',
    recurso: 'fin_extrato_transacoes',
    registro_id: contaId,
    descricao: `CNAB (${parser.id}) importado na conta "${conta.nome}": ${novas} linha(s), ${liquidadas} liquidação(ões), ${divergentes} divergência(s), ${duplicadas} duplicada(s)`,
    dados: { conta_id: contaId, parser: parser.id, novas, liquidadas, divergentes, duplicadas },
    empresa_id: empresaDoAtorAudit(actor),
  });

  res.json({ ok: true, parser: parser.id, conta_id: contaId, total_linhas: linhas.length, novas, duplicadas, liquidadas, divergentes, detalhes });
}

/** GET /api/financeiro/cnab/parsers — layouts registrados. */
export async function listarParsersHandler(_req: Request, res: Response) {
  res.json({ parsers: listarCnabParsers() });
}
