// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › ESTOQUE (ERP → loja).
//
// O ERP é a FONTE CANÔNICA do estoque: a loja nunca vira autoridade. O saldo
// enviado é o DISPONÍVEL VENDÁVEL do motor canônico
// (`disponibilidadesPorTamanho`: físico − reservas − empenhado − bloqueado),
// não o físico bruto.
//
// Cada loja recebe a SUA sincronização, e cada uma falha por conta própria:
// uma indisponibilidade da RETAIL não bloqueia a WHOLESALE (a varredura
// itera as lojas e acumula desfechos). O envio usa os IDs EXTERNOS do VÍNCULO
// daquela loja — nunca um ID descoberto por SKU em outra loja, o que causaria
// atualização cruzada.
//
// Nenhuma operação destrutiva: só `stock_quantity` + `manage_stock`.
// ============================================================================
import { HttpError } from '../../errors';
import { getStore } from '../../services';
import type { Row, Tx } from '../../store';
import { getResource } from '../../resources';
import { disponivelDoProdutoVendavel } from '../catalogo';
import { escopoDeSistema } from '../../empresa';
import type { ConfigStore, StoreKey } from './registry';
import { dryRun } from './registry';
import { wooStoreFetch, ehDryRun } from './cliente';
import { listarVinculos } from './vinculos';
import { registrarSincronizacao } from './estado';

const R_PRODUTOS = () => getResource('produtos')!;

export type ResultadoEstoqueLoja = {
  store_key: StoreKey;
  ok: boolean;
  atualizados: number;
  sem_vinculo: number;
  dry_run: boolean;
  erro?: string;
};

type ItemEstoque = { id: string; stock_quantity: number; manage_stock: true };

/** Fila de atualizações de um produto (simples ou pai de variações). */
type FilaProduto = { externalProductId: string; produto: ItemEstoque | null; variacoes: ItemEstoque[] };

/**
 * Calcula o disponível vendável por produto do ERP, uma vez por operação.
 * Variações (filhos) também entram: cada uma resolve o saldo do PAI + tamanho
 * pelo vínculo canônico (A06-04).
 */
async function disponiveis(empresaId: number, produtos: Row[], tx?: Tx): Promise<Map<number, number>> {
  const mapa = new Map<number, number>();
  const escopo = escopoDeSistema(empresaId);
  for (const p of produtos) {
    mapa.set(Number(p.id), await disponivelDoProdutoVendavel(escopo, p, tx));
  }
  return mapa;
}

/**
 * Sincroniza o estoque de UMA loja.
 *
 * Lê os vínculos da loja (produtos e variações), recalcula o disponível no ERP
 * e envia em lote. Produto sem vínculo é contado em `sem_vinculo` — nunca é
 * inventado nem casado por SKU em outra loja.
 */
export async function sincronizarEstoqueDaLoja(
  cfg: ConfigStore,
  empresaId: number,
  opcoes: { limite?: number } = {}
): Promise<ResultadoEstoqueLoja> {
  const s = getStore();
  const vinculos = await listarVinculos(empresaId, cfg.store_key, { pageSize: opcoes.limite ?? 20000 });
  if (!vinculos.length) {
    await registrarSincronizacao(empresaId, cfg.store_key, { ultima_sincronizacao_estoque_em: new Date().toISOString(), erro: null });
    return { store_key: cfg.store_key, ok: true, atualizados: 0, sem_vinculo: 0, dry_run: false };
  }

  // Modo de homologação: NADA é escrito na loja. O cliente devolve a resposta
  // sintética do dry-run (não a confirmação da loja), então conferir o lote aqui
  // recusaria uma sincronização que, por definição, não tocou a rede. A fila é
  // montada abaixo mesmo assim para reportar quantos itens SERIAM enviados.
  const modoHomologacao = dryRun();

  const idsProdutos = [...new Set(vinculos.map((v) => Number(v.produto_id)))];
  const produtos = new Map<number, Row>();
  for (const id of idsProdutos) {
    const p = await s.findOneWhere(R_PRODUTOS(), { id, empresa_id: empresaId });
    if (p) produtos.set(id, p);
  }
  const saldo = await disponiveis(empresaId, [...produtos.values()]);

  // Agrupa por produto externo: produto-pai recebe as variações; produto
  // simples/variação avulsa recebe o próprio saldo.
  const fila = new Map<string, FilaProduto>();
  let semVinculo = 0;
  for (const v of vinculos) {
    const produtoId = Number(v.produto_id);
    const produto = produtos.get(produtoId);
    if (!produto) {
      semVinculo += 1;
      continue;
    }
    const externalProductId = String(v.external_product_id);
    const quantidade = Math.max(0, Math.trunc(saldo.get(produtoId) ?? 0));
    const item = fila.get(externalProductId) ?? { externalProductId, produto: null, variacoes: [] };
    if (v.external_variation_id != null && String(v.external_variation_id) !== '') {
      item.variacoes.push({ id: String(v.external_variation_id), stock_quantity: quantidade, manage_stock: true });
    } else {
      item.produto = { id: externalProductId, stock_quantity: quantidade, manage_stock: true };
    }
    fila.set(externalProductId, item);
  }

  let atualizados = 0;
  let dryRunResposta = modoHomologacao;
  const simples: ItemEstoque[] = [];
  for (const item of fila.values()) {
    if (item.variacoes.length) {
      // A API de lote do WooCommerce aceita no máximo 100 itens por chamada.
      for (let i = 0; i < item.variacoes.length; i += 100) {
        const lote = item.variacoes.slice(i, i + 100);
        const resposta = await wooStoreFetch<{ update?: unknown[] }>(cfg, `/products/${item.externalProductId}/variations/batch`, {
          method: 'POST',
          body: { update: lote },
        });
        dryRunResposta = dryRunResposta || ehDryRun(resposta);
        // Dry-run: a resposta é sintética, não há confirmação real a conferir.
        if (!dryRunResposta) conferirLote(resposta, lote);
        atualizados += lote.length;
      }
    } else if (item.produto) {
      simples.push(item.produto);
    }
  }
  for (let i = 0; i < simples.length; i += 100) {
    const lote = simples.slice(i, i + 100);
    const resposta = await wooStoreFetch<{ update?: unknown[] }>(cfg, '/products/batch', { method: 'POST', body: { update: lote } });
    dryRunResposta = dryRunResposta || ehDryRun(resposta);
    if (!dryRunResposta) conferirLote(resposta, lote);
    atualizados += lote.length;
  }

  // Homologação: a água-marca NÃO avança (nada foi sincronizado de verdade) —
  // só o erro anterior é limpo. O painel não pode dizer "sincronizado agora".
  await registrarSincronizacao(
    empresaId,
    cfg.store_key,
    modoHomologacao ? { erro: null } : { ultima_sincronizacao_estoque_em: new Date().toISOString(), erro: null }
  );
  await s
    .audit({
      usuario_id: null,
      usuario: 'WooCommerce multi-store',
      acao: 'editar',
      recurso: 'woocommerce_sync_state',
      registro_id: null,
      descricao: `Estoque sincronizado na loja ${cfg.store_key} (${cfg.url}): ${atualizados} item(ns), ${semVinculo} sem vínculo`,
      dados: { store_key: cfg.store_key, atualizados, sem_vinculo: semVinculo, dry_run: dryRunResposta },
      empresa_id: empresaId,
    })
    .catch(() => undefined);

  return { store_key: cfg.store_key, ok: true, atualizados, sem_vinculo: semVinculo, dry_run: dryRunResposta };
}

/**
 * Sincroniza todas as lojas habilitadas. Cada loja devolve o próprio desfecho;
 * o erro de uma é registrado no estado DAQUELA loja, sem tocar a outra.
 */
export async function sincronizarEstoqueTodasLojas(
  lojas: { cfg: ConfigStore; empresaId: number }[]
): Promise<ResultadoEstoqueLoja[]> {
  const resultados: ResultadoEstoqueLoja[] = [];
  for (const { cfg, empresaId } of lojas) {
    try {
      resultados.push(await sincronizarEstoqueDaLoja(cfg, empresaId));
    } catch (e) {
      const mensagem = e instanceof HttpError ? e.message : 'Falha ao sincronizar estoque com a loja.';
      await registrarSincronizacao(empresaId, cfg.store_key, { erro: mensagem }).catch(() => undefined);
      resultados.push({ store_key: cfg.store_key, ok: false, atualizados: 0, sem_vinculo: 0, dry_run: false, erro: mensagem });
    }
  }
  return resultados;
}

/** O lote só é sucesso se a loja confirmou TODOS os itens enviados. */
function conferirLote(resposta: { update?: unknown[] } | null, esperado: ItemEstoque[]): void {
  const update = resposta?.update;
  if (!Array.isArray(update) || update.length !== esperado.length) {
    throw new HttpError(502, 'A loja não confirmou todas as atualizações de estoque do lote.');
  }
  const ids = new Set(update.map((u) => String((u as { id?: unknown })?.id ?? '')));
  const falhou = update.some((u) => Boolean((u as { error?: unknown })?.error));
  if (falhou || ids.size !== esperado.length) {
    throw new HttpError(502, 'A loja não confirmou todas as atualizações de estoque do lote.');
  }
}
