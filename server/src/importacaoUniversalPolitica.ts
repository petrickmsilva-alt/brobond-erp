// ============================================================================
// ADAPTADOR DE DESTINO — POLÍTICA COMERCIAL
// ----------------------------------------------------------------------------
// Este arquivo NÃO é um motor de importação. Ele converte o plano calculado
// pela regra de negócio da política comercial em (a) prévia/reconciliação do
// motor universal e (b) uma operação durável executada pelo mesmo pipeline.
// ============================================================================
import type { Tx } from './store';
import {
  construirPreviaPlano,
  enfileirarCargaPoliticaComercial,
  lerPlanoDosBytes,
} from './cargaPoliticaComercial';

export type ResultadoReconciliacaoPolitica = {
  resultado: Record<string, unknown>;
  previaAdapter: Record<string, unknown>;
};

function divergenciasDoPlano(previa: ReturnType<typeof construirPreviaPlano>) {
  const divergencias: Record<string, unknown>[] = [];
  const validacoes = previa.validacoes as any;
  for (const status of validacoes?.status_invalidos ?? []) {
    divergencias.push({ tipo: 'politica_status_invalido', descricao: `Status inválido na origem: ${String(status)}`, chave: String(status) });
  }
  for (const conflito of validacoes?.precos_conflitantes_arquivo ?? []) {
    divergencias.push({ tipo: 'politica_preco_conflitante', descricao: 'Preço conflitante na planilha para o mesmo SKU/faixa.', chave: String(typeof conflito === 'object' ? JSON.stringify(conflito) : conflito).slice(0, 200) });
  }
  if (previa.truncado) divergencias.push({ tipo: 'limite_carga_excedido', descricao: `A planilha excede o limite de ${previa.limite} itens.` });
  return divergencias;
}

/** Reconciliação somente leitura: não grava nenhuma entidade do ERP. */
export async function reconciliarPoliticaComercial(
  bytes: Buffer,
  nomeArquivo: string,
  sha256: string,
): Promise<ResultadoReconciliacaoPolitica> {
  const carregado = await lerPlanoDosBytes(bytes, nomeArquivo);
  const previa = construirPreviaPlano(carregado);
  const divergencias = divergenciasDoPlano(previa);
  const registros = carregado.plano.itens.map((item) => ({
    aba: item.fonte,
    linha: item.linha,
    entidade: item.pai_sku ? 'variacao' : 'produto',
    sku: item.codigo_industria,
    nome: item.descricao || item.nome_pai,
    cor: item.cor,
    tamanho: item.tamanho,
    status: item.acao ?? 'analisado',
    divergencias: item.erros ?? [],
    mapeado: { precos: item.precos, custo: item.custo_base, atributos_adicionais: item.atributos_adicionais },
  }));
  return {
    resultado: {
      adaptador: 'politica_comercial',
      sha256,
      divergencias,
      totais: {
        itens: carregado.plano.itens.length,
        familias: carregado.plano.familias.length,
        celulas_estoque: previa.inventario.total_celulas,
        unidades_estoque: previa.inventario.total_unidades,
      },
      previaConsolidada: { registros, quantidade: registros.length },
      resumoDimensional: {
        relacionamentosAnalisados: carregado.reconciliacao.abas.length,
        correspondencias: carregado.barcodes.validos,
        conflitosDimensionais: divergencias.length,
      },
      validacoes: previa.validacoes,
      reconciliacaoAbas: previa.reconciliacao,
      inventario: previa.inventario,
      dependencias: [],
      importacaoLiberada: false,
    },
    previaAdapter: {
      adaptador: 'politica_comercial',
      previa,
      regraAplicada: 'recalculada_no_servidor',
      gravacao: 'somente_apos_aprovacao_e_execucao_explicita',
    },
  };
}

/** Enfileira a execução do adaptador dentro da transação da sessão aprovada. */
export async function enfileirarExecucaoPoliticaComercial(
  actor: any,
  sessaoId: string,
  nomeArquivo: string,
  arquivoBase64: string,
  tx: Tx,
) {
  return enfileirarCargaPoliticaComercial(actor, {
    conteudo: arquivoBase64,
    nome: nomeArquivo,
    sessao_id: sessaoId,
    origem: 'importacao_universal',
  }, tx);
}
