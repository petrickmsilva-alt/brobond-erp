// ============================================================================
// FINANCEIRO 3.0 — IMPORTAÇÃO CONTÁBIL (migration 0059)
//
// CONTEXTO ARQUITETURAL (o que esta rota NÃO pode ser)
// ----------------------------------------------------
// O ERP tem UM livro: `lancamentos_financeiros`, classificado por
// `conta_contabil_id` + `natureza_lancamento` (0056) e lido pelo balancete.
// Importar a contabilidade do contador NÃO pode virar um segundo ledger — então
// cada partida é gravada como uma linha DESSE livro, carimbada com a origem
// (`documento_origem_recurso = 'fin_importacoes_contabeis'`). O cabeçalho do
// lote (`fin_importacoes_contabeis`) existe só para idempotência e conferência.
//
// FLUXO (2 PASSOS, NADA É GRAVADO NO PREVIEW)
// -------------------------------------------
//   1) POST /api/financeiro/importacao-contabil/preview
//        valida TUDO e devolve o que seria gravado. Não escreve nada.
//   2) POST /api/financeiro/importacao-contabil
//        repete a validação DENTRO de uma transação e grava. Qualquer erro
//        desfaz o lote inteiro (rollback), nunca fica "meio importado".
//
// GARANTIAS
// ---------
//   • BALANÇO POR LANÇAMENTO: Σ débitos = Σ créditos em CADA entrada (não só no
//     total do arquivo). Um lote que fecha no total mas tem entrada torta é
//     recusado — é o erro que passa despercebido e estraga o balancete.
//   • EMPRESA: conta citada tem de existir no plano de contas DA EMPRESA e ser
//     analítica (lançar em conta sintética é erro de escrituração).
//   • IDEMPOTÊNCIA: o hash do conteúdo normalizado é único por empresa. Repetir
//     a importação devolve o MESMO lote (`idempotente: true`) e não duplica
//     partida. A corrida é resolvida por unique key no banco, não por SELECT.
//   • AUDITORIA: uma entrada por lote (quem, quando, arquivo, totais, contas).
//   • SEM INVENÇÃO: nada de alíquota, histórico automático ou conta "padrão".
//     Cada partida traz conta, natureza e valor; o resto é recusado com 400.
// ============================================================================
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, escopoDe, getStore, toHttpError } from './services';
import { currentUser } from './auth';
import { round2 } from './utils';
import type { Row, Tx } from './store';
import { assertPeriodosAbertos, comTravaContabil, competenciaValida } from './financeiroPeriodos';

const R_LANCAMENTO = () => getResource('lancamentos_financeiros')!;
const R_PLANO = () => getResource('plano_contas')!;
const R_IMPORTACAO = () => getResource('fin_importacoes_contabeis')!;

/** Marcador de proveniência — é o que o fluxo de caixa usa para excluir. */
export const ORIGEM_IMPORTACAO_CONTABIL = 'fin_importacoes_contabeis';

/** Natureza contábil da partida. */
export type NaturezaPartida = 'debito' | 'credito';

export type PartidaEntrada = {
  conta: string;
  natureza: NaturezaPartida;
  valor: number;
};

export type EntradaContabil = {
  /** Número da entrada no arquivo (1..N). Serve para a mensagem de erro. */
  numero: number;
  data: string;
  historico: string;
  documento?: string | null;
  partidas: PartidaEntrada[];
};

export type PlanoDaEmpresa = Map<string, Row>;

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

function texto(valor: unknown, campo: string, max: number): string {
  const t = valor === null || valor === undefined ? '' : String(valor).replace(/\s+/g, ' ').trim();
  if (!t) throw new HttpError(400, `A entrada contábil precisa de "${campo}".`, { [campo]: 'Obrigatório' });
  if (t.length > max) throw new HttpError(400, `O campo "${campo}" excede ${max} caracteres.`, { [campo]: `Máximo ${max}` });
  return t;
}

/**
 * Normaliza e valida o corpo da importação SEM tocar no banco.
 *
 * O formato aceito é uma lista de entradas:
 *
 *   { competencia?: 'AAAA-MM', arquivo?: 'razao.csv', entradas: [
 *       { data: 'AAAA-MM-DD', historico: '...', documento?: '...',
 *         partidas: [ { conta: '1.1.1', natureza: 'debito', valor: 100 },
 *                     { conta: '3.1.1', natureza: 'credito', valor: 100 } ] } ] }
 *
 * `partidas` também aceita `debitos`/`creditos` como listas separadas — o
 * layout mais comum nos arquivos de contador.
 */
export function normalizarImportacao(body: unknown): { arquivo: string | null; competencia: string | null; entradas: EntradaContabil[] } {
  const dados = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const bruto = Array.isArray(dados.entradas) ? dados.entradas : null;
  if (!bruto || bruto.length === 0) {
    throw new HttpError(400, 'Informe `entradas`: a lista de lançamentos contábeis a importar.', { entradas: 'Obrigatório' });
  }
  if (bruto.length > 5000) {
    throw new HttpError(400, 'Um lote de importação aceita no máximo 5000 lançamentos. Divida o arquivo.', { entradas: 'Máximo 5000' });
  }

  const competencia = dados.competencia === undefined || dados.competencia === null || dados.competencia === ''
    ? null
    : String(dados.competencia);
  if (competencia !== null) competenciaValida(competencia);
  const arquivo = dados.arquivo === undefined || dados.arquivo === null ? null : String(dados.arquivo).slice(0, 240);

  const entradas: EntradaContabil[] = bruto.map((item, indice) => {
    const e = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const numero = indice + 1;
    const data = String(e.data ?? '').trim();
    if (!DATA_ISO.test(data) || Number.isNaN(Date.parse(`${data}T00:00:00Z`)) || new Date(`${data}T00:00:00Z`).toISOString().slice(0, 10) !== data) {
      throw new HttpError(400, `Entrada ${numero}: \`data\` deve estar no formato AAAA-MM-DD.`, { entradas: `Entrada ${numero}: data inválida` });
    }
    const historico = texto(e.historico, 'historico', 300);

    const partidasBrutas: PartidaEntrada[] = [];
    const push = (conta: unknown, natureza: NaturezaPartida, valor: unknown) => {
      const valorNum = Number(String(valor ?? '').replace(',', '.'));
      if (!Number.isFinite(valorNum) || valorNum < 0.01 || valorNum > 9999999999.99 || Math.abs(valorNum * 100 - Math.round(valorNum * 100)) > 1e-7) {
        throw new HttpError(400, `Entrada ${numero}: valor da partida precisa ser maior que zero.`, {
          entradas: `Entrada ${numero}: valor inválido`,
        });
      }
      const codigo = String(conta ?? '').trim();
      if (!codigo) {
        throw new HttpError(400, `Entrada ${numero}: partida sem conta contábil.`, { entradas: `Entrada ${numero}: conta obrigatória` });
      }
      partidasBrutas.push({ conta: codigo, natureza, valor: round2(valorNum) });
    };

    if (Array.isArray(e.partidas)) {
      e.partidas.forEach((p: unknown, i: number) => {
        const parte = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
        const natureza = String(parte.natureza ?? '').toLowerCase();
        if (natureza !== 'debito' && natureza !== 'credito') {
          throw new HttpError(400, `Entrada ${numero}, partida ${i + 1}: \`natureza\` deve ser debito ou credito.`, {
            entradas: `Entrada ${numero}: natureza inválida`,
          });
        }
        push(parte.conta, natureza, parte.valor);
      });
    } else {
      if (!Array.isArray(e.debitos) || !Array.isArray(e.creditos)) {
        throw new HttpError(400, `Entrada ${numero}: informe \`partidas\` ou \`debitos\`+\`creditos\`.`, {
          entradas: `Entrada ${numero}: partidas ausentes`,
        });
      }
      (e.debitos as unknown[]).forEach((p: unknown) => {
        const parte = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
        push(parte.conta, 'debito', parte.valor);
      });
      (e.creditos as unknown[]).forEach((p: unknown) => {
        const parte = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
        push(parte.conta, 'credito', parte.valor);
      });
    }

    if (partidasBrutas.length < 2) {
      throw new HttpError(400, `Entrada ${numero}: partida dobrada exige ao menos duas partidas (uma a débito e uma a crédito).`, {
        entradas: `Entrada ${numero}: partidas insuficientes`,
      });
    }
    const debitos = round2(partidasBrutas.filter((p) => p.natureza === 'debito').reduce((a, p) => a + p.valor, 0));
    const creditos = round2(partidasBrutas.filter((p) => p.natureza === 'credito').reduce((a, p) => a + p.valor, 0));
    if (debitos !== creditos) {
      throw new HttpError(
        400,
        `Entrada ${numero} não fecha: débitos ${debitos.toFixed(2)} ≠ créditos ${creditos.toFixed(2)} (diferença ${round2(debitos - creditos).toFixed(2)}).`,
        { entradas: `Entrada ${numero}: desbalanceada` }
      );
    }
    if (debitos <= 0) {
      throw new HttpError(400, `Entrada ${numero}: valor total precisa ser maior que zero.`, { entradas: `Entrada ${numero}: valor zero` });
    }

    return {
      numero,
      data,
      historico,
      documento: e.documento === undefined || e.documento === null ? null : String(e.documento).slice(0, 80),
      partidas: partidasBrutas,
    };
  });

  return { arquivo, competencia, entradas };
}

/** Plano de contas da empresa, indexado por código (só contas ANALÍTICAS). */
export async function planoDaEmpresa(empresaId: number, tx?: Tx): Promise<PlanoDaEmpresa> {
  const s = getStore();
  const { rows } = await s.list(R_PLANO(), { page: 1, pageSize: 5000, filter: { empresa_id: empresaId } }, tx);
  const mapa: PlanoDaEmpresa = new Map();
  for (const conta of rows) mapa.set(String(conta.codigo), conta);
  return mapa;
}

/**
 * Valida as contas contra o plano da empresa.
 *
 * Conta inexistente ou SINTÉTICA é 422 (não é erro de digitação de campo: é
 * erro de escrituração, e a resposta diz qual conta e por quê).
 */
export function validarContas(entradas: EntradaContabil[], plano: PlanoDaEmpresa): void {
  const problemas: { entrada: number; conta: string; motivo: string }[] = [];
  for (const entrada of entradas) {
    for (const partida of entrada.partidas) {
      const conta = plano.get(partida.conta);
      if (!conta) {
        problemas.push({ entrada: entrada.numero, conta: partida.conta, motivo: 'Conta não existe no plano de contas desta empresa' });
        continue;
      }
      if (String(conta.tipo) !== 'analitica') {
        problemas.push({ entrada: entrada.numero, conta: partida.conta, motivo: 'Conta sintética não recebe lançamento' });
      }
      if (conta.ativo === false) {
        problemas.push({ entrada: entrada.numero, conta: partida.conta, motivo: 'Conta inativa' });
      }
    }
  }
  if (problemas.length) {
    throw new HttpError(422, 'Há partidas com conta contábil inválida para esta empresa.', { partidas: problemas });
  }
}

/** Hash determinístico do conteúdo — a chave de idempotência do lote. */
export function hashDaImportacao(entradas: EntradaContabil[], competencia: string | null): string {
  const normalizado = JSON.stringify({
    competencia,
    entradas: entradas.map((e) => ({
      data: e.data,
      historico: e.historico,
      documento: e.documento ?? null,
      partidas: e.partidas.map((p) => `${p.conta}:${p.natureza}:${p.valor.toFixed(2)}`),
    })),
  });
  return createHash('sha256').update(normalizado).digest('hex');
}

/** Totais do lote (sempre iguais por construção — a validação por entrada garante). */
export function totaisDaImportacao(entradas: EntradaContabil[]) {
  let debitos = 0;
  let creditos = 0;
  let partidas = 0;
  for (const e of entradas) {
    for (const p of e.partidas) {
      partidas += 1;
      if (p.natureza === 'debito') debitos += p.valor;
      else creditos += p.valor;
    }
  }
  return { entradas: entradas.length, partidas, total_debitos: round2(debitos), total_creditos: round2(creditos) };
}

/**
 * Tipo do lançamento no livro-caixa.
 *
 * `lancamentos_financeiros.tipo` é a classificação de FLUXO (receita/despesa/
 * investimento/estorno), não a natureza contábil — que vem em
 * `natureza_lancamento`. A importação deriva o tipo da natureza da CONTA, e
 * registra isso na resposta. Como o resumo financeiro exclui as linhas de
 * importação contábil, esse rótulo não afeta DRE/fluxo de caixa.
 */
export function tipoDoLancamento(conta: Row): string {
  const natureza = String(conta.natureza ?? '').toLowerCase();
  if (natureza === 'receita') return 'receita';
  if (natureza === 'despesa' || natureza === 'custo') return 'despesa';
  return 'investimento';
}

function montarPreview(entradas: EntradaContabil[], plano: PlanoDaEmpresa) {
  return entradas.map((e) => ({
    numero: e.numero,
    data: e.data,
    historico: e.historico,
    documento: e.documento ?? null,
    debitos: round2(e.partidas.filter((p) => p.natureza === 'debito').reduce((a, p) => a + p.valor, 0)),
    creditos: round2(e.partidas.filter((p) => p.natureza === 'credito').reduce((a, p) => a + p.valor, 0)),
    partidas: e.partidas.map((p) => {
      const conta = plano.get(p.conta);
      return {
        conta: p.conta,
        conta_nome: String(conta?.nome ?? ''),
        conta_natureza: String(conta?.natureza ?? ''),
        natureza: p.natureza,
        valor: p.valor,
        tipo_lancamento: conta ? tipoDoLancamento(conta) : null,
      };
    }),
  }));
}

/** POST /api/financeiro/importacao-contabil/preview — valida e NÃO grava. */
export async function previewImportacaoContabil(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_LANCAMENTO(), actor, 'create');
  const escopo = escopoDe(actor);
  try {
    const { arquivo, competencia, entradas } = normalizarImportacao(req.body);
    const plano = await planoDaEmpresa(escopo.empresaId);
    validarContas(entradas, plano);
    await assertPeriodosAbertos(escopo.empresaId, entradas.map((e) => competencia ?? e.data.slice(0, 7)));
    const totais = totaisDaImportacao(entradas);
    const hash = hashDaImportacao(entradas, competencia);
    const jaImportado = await getStore().findOneWhere(R_IMPORTACAO(), { empresa_id: escopo.empresaId, hash });

    return res.json({
      ok: true,
      preview: true,
      gravado: false,
      hash,
      arquivo,
      competencia,
      totais,
      balanceado: totais.total_debitos === totais.total_creditos,
      ja_importado: jaImportado ? { id: Number(jaImportado.id), criado_em: jaImportado.criado_em } : null,
      entradas: montarPreview(entradas, plano),
      regra:
        'O preview não grava nada. A confirmação repete a validação dentro da transação, grava as partidas no MESMO livro (lancamentos_financeiros) e recusa lote repetido pelo hash.',
    });
  } catch (e) {
    throw toHttpError(e, R_LANCAMENTO());
  }
}

/** POST /api/financeiro/importacao-contabil — grava o lote (transacional). */
export async function confirmarImportacaoContabil(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_LANCAMENTO(), actor, 'create');
  const escopo = escopoDe(actor);
  const s = getStore();
  try {
    const { arquivo, competencia, entradas } = normalizarImportacao(req.body);
    const hash = hashDaImportacao(entradas, competencia);

    const resultado = await comTravaContabil(escopo.empresaId, async (tx) => {
      // IDEMPOTÊNCIA (camada 1): lote já aplicado com este conteúdo.
      const existente = await s.findOneWhere(R_IMPORTACAO(), { empresa_id: escopo.empresaId, hash }, tx);
      if (existente) {
        return { importacao: existente, idempotente: true, gravadas: 0 };
      }

      // Validação de contas DENTRO da transação: o plano pode ter mudado entre
      // o preview e a confirmação.
      await assertPeriodosAbertos(escopo.empresaId, entradas.map((e) => competencia ?? e.data.slice(0, 7)), tx);
      const plano = await planoDaEmpresa(escopo.empresaId, tx);
      validarContas(entradas, plano);
      const totais = totaisDaImportacao(entradas);
      if (totais.total_debitos !== totais.total_creditos) {
        throw new HttpError(400, 'O lote não fecha: Σ débitos ≠ Σ créditos.', { totais });
      }

      // A trava por empresa serializa confirmação, fechamento e reabertura;
      // o índice único continua sendo a barreira de defesa no banco.
      const cabecalho = await s.insert(R_IMPORTACAO(), {
        empresa_id: escopo.empresaId, hash, arquivo,
        competencia: competencia ? `${competencia}-01` : null,
        entradas: totais.entradas, partidas: totais.partidas,
        total_debitos: totais.total_debitos, total_creditos: totais.total_creditos,
        status: 'aplicada', criado_por: actor.id || null,
      }, tx);

      const importacaoId = Number(cabecalho.id);
      let gravadas = 0;
      for (const entrada of entradas) {
        for (const partida of entrada.partidas) {
          const conta = plano.get(partida.conta)!;
          await s.insert(
            R_LANCAMENTO(),
            {
              empresa_id: escopo.empresaId,
              data: entrada.data,
              tipo: tipoDoLancamento(conta),
              descricao: entrada.historico,
              valor: partida.valor,
              status: 'confirmado',
              conta_contabil_id: Number(conta.id),
              natureza_lancamento: partida.natureza,
              documento_origem_recurso: ORIGEM_IMPORTACAO_CONTABIL,
              documento_origem_id: importacaoId,
              partida_id: entrada.numero,
              competencia: competencia ? `${competencia}-01` : entrada.data,
              observacoes: entrada.documento ? `Documento ${entrada.documento}` : null,
            },
            tx
          );
          gravadas += 1;
        }
      }

      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'criar',
          recurso: 'lancamentos_financeiros',
          registro_id: importacaoId,
          descricao: `Importação contábil #${importacaoId}: ${totais.entradas} lançamento(s), ${gravadas} partida(s), R$ ${totais.total_debitos.toFixed(2)}`,
          dados: { importacao_id: importacaoId, hash, arquivo, competencia, ...totais },
          empresa_id: escopo.empresaId,
        },
        tx
      );

      return { importacao: cabecalho, idempotente: false, gravadas };
    });

    return res.status(resultado.idempotente ? 200 : 201).json({
      ok: true,
      preview: false,
      idempotente: resultado.idempotente,
      importacao_id: Number(resultado.importacao.id),
      totais: {
        entradas: Number(resultado.importacao.entradas ?? 0),
        partidas: Number(resultado.importacao.partidas ?? 0),
        total_debitos: Number(resultado.importacao.total_debitos ?? 0),
        total_creditos: Number(resultado.importacao.total_creditos ?? 0),
      },
      partidas_gravadas: resultado.gravadas,
      mensagem: resultado.idempotente
        ? 'Este lote já havia sido importado; nenhum lançamento foi duplicado.'
        : 'Lote contábil importado no livro único (lancamentos_financeiros).',
    });
  } catch (e) {
    throw toHttpError(e, R_LANCAMENTO());
  }
}

// ============================================================================
// IMPORTAÇÃO DO PLANO DE CONTAS (P2-13)
//
// POR QUE PRECISA EXISTIR
// -----------------------
// A importação de PARTIDAS (acima) só funciona se as contas já existirem. O
// contador entrega o plano e o razão juntos; exigir que o plano seja digitado
// conta por conta antes é o motivo pelo qual essa importação não era usada.
//
// REGRAS (todas verificáveis, nenhuma inventada)
// ----------------------------------------------
//   • o arquivo traz `codigo`, `nome`, `natureza` e `tipo` (analitica/sintetica);
//     `pai_codigo` é opcional — sem ele, a hierarquia é deduzida do CÓDIGO
//     (prefixo seguido de ponto), e a resposta diz que foi deduzida;
//   • o pai PRECISA existir (no arquivo ou no plano atual) e ser SINTÉTICA:
//     lançar em conta que tem filhas é erro de escrituração, e ter filha em
//     conta analítica é erro de estrutura;
//   • duplicidade de código DENTRO do arquivo é erro (não "o último vence");
//   • `criar_apenas` (padrão) NUNCA altera conta existente;
//     `atualizar` altera nome/natureza/tipo e é o único modo que mexe em dado
//     existente — e o preview mostra exatamente o que mudaria;
//   • nada é apagado: conta que sai do arquivo continua no plano.
//
// A escrita é transacional e idempotente por (empresa_id, codigo).
// ============================================================================
export type ContaImportada = {
  codigo: string;
  nome: string;
  natureza: string;
  tipo: 'analitica' | 'sintetica';
  pai_codigo: string | null;
  pai_deduzido: boolean;
  descricao: string | null;
};

const NATUREZAS = ['ativo', 'passivo', 'patrimonio_liquido', 'receita', 'despesa', 'custo'];
const CODIGO_CONTABIL = /^\d+(\.\d+)*$/;

/** Pai deduzido do próprio código: `1.1.2` → procura `1.1`, depois `1`. */
function paiPorPrefixo(codigo: string): string | null {
  const partes = codigo.split('.');
  for (let n = partes.length - 1; n >= 1; n--) {
    const candidato = partes.slice(0, n).join('.');
    if (CODIGO_CONTABIL.test(candidato)) return candidato;
  }
  return null;
}

/** Normaliza e valida o arquivo do plano SEM tocar no banco. */
export function normalizarPlanoDeContas(body: unknown): ContaImportada[] {
  const dados = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const bruto = Array.isArray(dados.contas) ? dados.contas : null;
  if (!bruto || bruto.length === 0) {
    throw new HttpError(400, 'Informe `contas`: a lista de contas contábeis a importar.', { contas: 'Obrigatório' });
  }
  if (bruto.length > 5000) {
    throw new HttpError(400, 'Um lote de plano de contas aceita no máximo 5000 contas. Divida o arquivo.', { contas: 'Máximo 5000' });
  }

  const vistos = new Map<string, number>();
  return bruto.map((item, indice) => {
    const c = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const linha = indice + 1;
    const codigo = String(c.codigo ?? '').trim();
    if (!CODIGO_CONTABIL.test(codigo)) {
      throw new HttpError(400, `Conta ${linha}: o código "${codigo}" não é uma estrutura de dígitos separados por ponto (ex.: 1.1.01).`, {
        contas: `Linha ${linha}: código inválido`,
      });
    }
    if (vistos.has(codigo)) {
      throw new HttpError(400, `Conta ${linha}: o código "${codigo}" aparece também na linha ${vistos.get(codigo)}. Corrija o arquivo — a última linha NÃO sobrescreve a primeira.`, {
        contas: `Linha ${linha}: código duplicado`,
      });
    }
    vistos.set(codigo, linha);

    const nome = String(c.nome ?? '').replace(/\s+/g, ' ').trim();
    if (!nome) throw new HttpError(400, `Conta ${linha} (${codigo}): informe o nome.`, { contas: `Linha ${linha}: nome obrigatório` });

    const natureza = String(c.natureza ?? '').trim().toLowerCase();
    if (!NATUREZAS.includes(natureza)) {
      throw new HttpError(400, `Conta ${linha} (${codigo}): natureza "${natureza}" inválida. Use uma de: ${NATUREZAS.join(', ')}.`, {
        contas: `Linha ${linha}: natureza inválida`,
      });
    }

    const tipoBruto = String(c.tipo ?? '').trim().toLowerCase();
    const tipo = tipoBruto === 'sintetica' || tipoBruto === 'sintética' ? 'sintetica' : tipoBruto === 'analitica' || tipoBruto === 'analítica' ? 'analitica' : null;
    if (!tipo) {
      throw new HttpError(400, `Conta ${linha} (${codigo}): tipo deve ser "analitica" ou "sintetica".`, { contas: `Linha ${linha}: tipo inválido` });
    }

    const paiInformado = c.pai_codigo === undefined || c.pai_codigo === null || c.pai_codigo === '' ? null : String(c.pai_codigo).trim();
    if (paiInformado && !CODIGO_CONTABIL.test(paiInformado)) {
      throw new HttpError(400, `Conta ${linha} (${codigo}): \`pai_codigo\` "${paiInformado}" não é um código válido.`, { contas: `Linha ${linha}: pai inválido` });
    }
    if (paiInformado && paiInformado === codigo) {
      throw new HttpError(400, `Conta ${linha} (${codigo}): a conta não pode ser pai de si mesma.`, { contas: `Linha ${linha}: autorreferência` });
    }

    return {
      codigo,
      nome: nome.slice(0, 120),
      natureza,
      tipo,
      pai_codigo: paiInformado ?? paiPorPrefixo(codigo),
      pai_deduzido: !paiInformado,
      descricao: c.descricao === undefined || c.descricao === null ? null : String(c.descricao).slice(0, 500),
    };
  });
}

type PlanoAtual = Map<string, Row>;

async function planoAtualDaEmpresa(empresaId: number): Promise<PlanoAtual> {
  const { rows } = await getStore().list(R_PLANO(), { page: 1, pageSize: 5000, filter: { empresa_id: empresaId } });
  return new Map(rows.map((c) => [String(c.codigo), c]));
}

/**
 * Valida estrutura contra o plano atual + o próprio arquivo.
 * Devolve o plano de ação (criar / atualizar / ignorar) sem gravar nada.
 */
function planejarImportacao(contas: ContaImportada[], atual: PlanoAtual, modo: 'criar_apenas' | 'atualizar') {
  const noArquivo = new Map(contas.map((c) => [c.codigo, c]));
  const problemas: { codigo: string; motivo: string }[] = [];
  const criar: ContaImportada[] = [];
  const atualizar: { conta: ContaImportada; mudancas: string[] }[] = [];
  const ignorar: { codigo: string; motivo: string }[] = [];

  // 1) pai: existe (arquivo ou plano) e é SINTÉTICA.
  for (const conta of contas) {
    if (!conta.pai_codigo) continue;
    const paiNoArquivo = noArquivo.get(conta.pai_codigo);
    const paiNoBanco = atual.get(conta.pai_codigo);
    if (!paiNoArquivo && !paiNoBanco) {
      problemas.push({ codigo: conta.codigo, motivo: `o pai "${conta.pai_codigo}" não existe nem no arquivo nem no plano atual` });
      continue;
    }
    const tipoPai = paiNoArquivo ? paiNoArquivo.tipo : String(paiNoBanco!.tipo);
    if (tipoPai !== 'sintetica') {
      problemas.push({ codigo: conta.codigo, motivo: `o pai "${conta.pai_codigo}" é analítica — conta com filhas precisa ser sintética` });
    }
  }

  // 2) conta que é PAI no arquivo não pode ser analítica.
  const paisUsados = new Set(contas.map((c) => c.pai_codigo).filter((x): x is string => !!x));
  for (const conta of contas) {
    if (paisUsados.has(conta.codigo) && conta.tipo !== 'sintetica') {
      problemas.push({ codigo: conta.codigo, motivo: 'a conta é pai de outra no arquivo, então precisa ser sintética' });
    }
  }

  // 3) comparação com o que já existe.
  for (const conta of contas) {
    const existente = atual.get(conta.codigo);
    if (!existente) {
      criar.push(conta);
      continue;
    }
    const mudancas: string[] = [];
    if (String(existente.nome) !== conta.nome) mudancas.push('nome');
    if (String(existente.natureza) !== conta.natureza) mudancas.push('natureza');
    if (String(existente.tipo) !== conta.tipo) mudancas.push('tipo');
    if (modo === 'atualizar' && mudancas.length) atualizar.push({ conta, mudancas });
    else if (mudancas.length) ignorar.push({ codigo: conta.codigo, motivo: `já existe e difere em ${mudancas.join(', ')} (modo criar_apenas)` });
    else ignorar.push({ codigo: conta.codigo, motivo: 'já existe idêntica' });
  }

  return { criar, atualizar, ignorar, problemas };
}

function modoDoBody(body: unknown): 'criar_apenas' | 'atualizar' {
  const m = String((body as any)?.modo ?? 'criar_apenas').toLowerCase();
  if (m !== 'criar_apenas' && m !== 'atualizar') {
    throw new HttpError(400, 'O modo aceita apenas "criar_apenas" (padrão) ou "atualizar".', { modo: 'criar_apenas | atualizar' });
  }
  return m;
}

/** POST /api/financeiro/plano-contas/importar/preview — valida e NÃO grava. */
export async function previewImportacaoPlano(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_PLANO(), actor, 'create');
  const escopo = escopoDe(actor);
  try {
    const modo = modoDoBody(req.body);
    const contas = normalizarPlanoDeContas(req.body);
    const atual = await planoAtualDaEmpresa(escopo.empresaId);
    const plano = planejarImportacao(contas, atual, modo);
    return res.json({
      ok: true,
      preview: true,
      gravado: false,
      modo,
      resumo: {
        no_arquivo: contas.length,
        criar: plano.criar.length,
        atualizar: plano.atualizar.length,
        ignorar: plano.ignorar.length,
        problemas: plano.problemas.length,
        plano_atual: atual.size,
      },
      criar: plano.criar.map((c) => ({ codigo: c.codigo, nome: c.nome, tipo: c.tipo, natureza: c.natureza, pai_codigo: c.pai_codigo, pai_deduzido: c.pai_deduzido })),
      atualizar: plano.atualizar,
      ignorar: plano.ignorar,
      problemas: plano.problemas,
      regra:
        'O preview não grava nada. Conta que já existe não é alterada no modo padrão; `atualizar` mexe só no que a lista mostra. Nada é apagado.',
    });
  } catch (e) {
    throw toHttpError(e, R_PLANO());
  }
}

/** POST /api/financeiro/plano-contas/importar — aplica o plano em transação. */
export async function confirmarImportacaoPlano(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_PLANO(), actor, 'create');
  const escopo = escopoDe(actor);
  const s = getStore();
  try {
    const modo = modoDoBody(req.body);
    const contas = normalizarPlanoDeContas(req.body);

    const resultado = await s.transaction(async (tx) => {
      const atual = await planoAtualDaEmpresa(escopo.empresaId);
      const plano = planejarImportacao(contas, atual, modo);
      // Estrutura inválida NÃO grava nada: importar plano torto é pior que não
      // importar, porque o balancete passa a somar conta errada.
      if (plano.problemas.length) {
        throw new HttpError(422, 'O plano de contas tem problemas de estrutura; nada foi gravado.', { contas: plano.problemas });
      }

      const idPorCodigo = new Map<string, number>([...atual].map(([codigo, row]) => [codigo, Number(row.id)]));
      let criadas = 0;
      let atualizadas = 0;

      // Sintéticas antes das analíticas: o pai precisa existir para o `pai_id`.
      const ordenadas = [...plano.criar].sort((a, b) => a.codigo.split('.').length - b.codigo.split('.').length || a.codigo.localeCompare(b.codigo));
      for (const conta of ordenadas) {
        const paiId = conta.pai_codigo ? (idPorCodigo.get(conta.pai_codigo) ?? null) : null;
        const inserida = await s.insert(
          R_PLANO(),
          {
            empresa_id: escopo.empresaId,
            codigo: conta.codigo,
            nome: conta.nome,
            natureza: conta.natureza,
            tipo: conta.tipo,
            pai_id: paiId,
            descricao: conta.descricao,
            ativo: true,
          },
          tx
        );
        idPorCodigo.set(conta.codigo, Number(inserida.id));
        criadas += 1;
      }

      for (const { conta } of plano.atualizar) {
        const existente = atual.get(conta.codigo)!;
        const paiId = conta.pai_codigo ? (idPorCodigo.get(conta.pai_codigo) ?? null) : null;
        await s.update(
          R_PLANO(),
          Number(existente.id),
          { nome: conta.nome, natureza: conta.natureza, tipo: conta.tipo, pai_id: paiId, descricao: conta.descricao ?? existente.descricao ?? null },
          tx
        );
        atualizadas += 1;
      }

      if (criadas || atualizadas) {
        await s.audit(
          {
            usuario_id: actor.id || null,
            usuario: actor.name,
            acao: 'criar',
            recurso: 'plano_contas',
            registro_id: null,
            descricao: `Importação de plano de contas (${modo}): ${criadas} criada(s), ${atualizadas} atualizada(s)`,
            dados: { modo, criadas, atualizadas, ignoradas: plano.ignorar.length, total_no_arquivo: contas.length },
            empresa_id: escopo.empresaId,
          },
          tx
        );
      }

      return { criadas, atualizadas, ignoradas: plano.ignorar.length };
    });

    return res.status(resultado.criadas || resultado.atualizadas ? 201 : 200).json({
      ok: true,
      preview: false,
      modo,
      ...resultado,
      mensagem:
        resultado.criadas || resultado.atualizadas
          ? 'Plano de contas aplicado. Nada foi apagado.'
          : 'Nada a fazer: o plano já estava igual ao arquivo.',
    });
  } catch (e) {
    throw toHttpError(e, R_PLANO());
  }
}
