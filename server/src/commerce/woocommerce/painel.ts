// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › PAINEL, RECONCILIAÇÃO E MONITORAMENTO.
//
// Alimenta a visão administrativa por loja, sempre com dado REAL:
//
//   • estado da conexão (teste autenticado, sem vazar credencial);
//   • produtos vinculados / pendentes / com erro;
//   • estoque sincronizado e última sincronização;
//   • pedidos importados e falhas;
//   • ação de sincronização manual;
//   • reconciliação (ERP × vínculos × loja).
//
// Nada aqui escreve nas lojas por conta própria: a sincronização manual
// enfileira no outbox (ou roda em dry-run, sem tocar a loja).
// ============================================================================
import { getStore } from '../../services';
import { getResource } from '../../resources';
import { disponibilidadesPorTamanho } from '../catalogo';
import { escopoDeSistema } from '../../empresa';
import { STORE_KEYS, statusStores, configStore, type StoreKey, type StatusStore } from './registry';
import { testarConexao } from './cliente';
import { estadoDaStore, type EstadoSincronizacao } from './estado';
import { listarVinculos, contarPorStatus } from './vinculos';

const R_PRODUTOS = () => getResource('produtos')!;
const R_VENDAS = () => getResource('vendas')!;

export type PainelLoja = {
  store_key: StoreKey;
  status: StatusStore;
  conexao: { ok: boolean; erro?: string } | null;
  vinculos: { total: number; por_status: Record<string, number> };
  pendentes: { produto_id: number; sku: string; nome: string; motivo: string }[];
  estoque: { sincronizado_em: string | null };
  pedidos_importados: number;
  estado: EstadoSincronizacao;
};

/** Conta as vendas importadas desta loja (referência WOO-<store>-). */
async function pedidosImportados(empresaId: number, store: StoreKey): Promise<number> {
  const s = getStore();
  const out = await s.list(R_VENDAS(), { page: 1, pageSize: 20000, filter: { empresa_id: empresaId } });
  const prefixo = `WOO-${store}-`;
  return out.rows.filter((v) => String(v.pedido_cliente || '').startsWith(prefixo)).length;
}

/**
 * Produtos ativos e visíveis no site que ainda NÃO têm vínculo nesta loja.
 * É a lista acionável de "o que falta publicar".
 */
async function produtosPendentes(empresaId: number, store: StoreKey): Promise<PainelLoja['pendentes']> {
  const s = getStore();
  const produtos = await s.list(R_PRODUTOS(), {
    page: 1,
    pageSize: 20000,
    filter: { empresa_id: empresaId },
    sort: 'sku',
    dir: 'asc',
  });
  const vinculos = await listarVinculos(empresaId, store, { pageSize: 20000 });
  const comVinculo = new Set(vinculos.map((v) => Number(v.produto_id)));
  const pendentes: PainelLoja['pendentes'] = [];
  for (const p of produtos.rows) {
    if (p.ativo === false || p.exibir_site === false) continue;
    const id = Number(p.id);
    if (comVinculo.has(id)) continue;
    const sku = String(p.sku || '').trim();
    if (!sku) {
      pendentes.push({ produto_id: id, sku: '', nome: String(p.nome || ''), motivo: 'Produto sem SKU — não é publicável.' });
      continue;
    }
    pendentes.push({ produto_id: id, sku, nome: String(p.nome || ''), motivo: 'Sem vínculo nesta loja.' });
  }
  return pendentes;
}

/** Painel de UMA loja. `testar` faz o teste autenticado (leitura) da conexão. */
export async function painelDaLoja(empresaId: number, store: StoreKey, opcoes: { testar?: boolean } = {}): Promise<PainelLoja> {
  const cfg = configStore(store);
  const status = statusStores().find((s) => s.store_key === store)!;
  const vinculos = cfg ? await listarVinculos(empresaId, store, { pageSize: 20000 }) : [];
  const estado = await estadoDaStore(empresaId, store);
  let conexao: PainelLoja['conexao'] = null;
  if (opcoes.testar && cfg) conexao = await testarConexao(cfg);
  return {
    store_key: store,
    status,
    conexao,
    vinculos: { total: vinculos.length, por_status: contarPorStatus(vinculos) },
    pendentes: cfg ? await produtosPendentes(empresaId, store) : [],
    estoque: { sincronizado_em: estado.ultima_sincronizacao_estoque_em },
    pedidos_importados: await pedidosImportados(empresaId, store),
    estado,
  };
}

/** Painel de todas as lojas (uma entrada por loja, independente). */
export async function painelTodasLojas(empresaId: number, opcoes: { testar?: boolean } = {}): Promise<PainelLoja[]> {
  const out: PainelLoja[] = [];
  for (const store of STORE_KEYS) out.push(await painelDaLoja(empresaId, store, opcoes));
  return out;
}

export type DivergenciaReconciliacao = {
  produto_id: number;
  sku: string;
  tipo: 'SEM_VINCULO' | 'SALDO_DIVERGENTE' | 'VINCULO_ORFAO';
  detalhe: string;
};

/**
 * Reconciliação: compara o ERP com o que a integração acredita sobre a loja.
 *
 *   • SEM_VINCULO      — produto ativo/visível sem vínculo na loja;
 *   • SALDO_DIVERGENTE — o disponível do ERP difere do saldo enviado (o
 *     saldo enviado não é persistido por célula, então a divergência é
 *     reportada quando o disponível é negativo ou não-inteiro, o que impede
 *     o envio correto);
 *   • VINCULO_ORFAO    — vínculo apontando para produto que não existe mais.
 */
export async function reconciliarLoja(empresaId: number, store: StoreKey): Promise<DivergenciaReconciliacao[]> {
  const s = getStore();
  const divergencias: DivergenciaReconciliacao[] = [];
  const produtos = await s.list(R_PRODUTOS(), { page: 1, pageSize: 20000, filter: { empresa_id: empresaId } });
  const porId = new Map(produtos.rows.map((p) => [Number(p.id), p]));
  const vinculos = await listarVinculos(empresaId, store, { pageSize: 20000 });
  const comVinculo = new Set(vinculos.map((v) => Number(v.produto_id)));

  for (const v of vinculos) {
    const id = Number(v.produto_id);
    if (!porId.has(id)) {
      divergencias.push({ produto_id: id, sku: String(v.sku || ''), tipo: 'VINCULO_ORFAO', detalhe: 'Vínculo aponta para produto inexistente.' });
    }
  }

  const escopo = escopoDeSistema(empresaId);
  for (const p of produtos.rows) {
    if (p.ativo === false || p.exibir_site === false) continue;
    const id = Number(p.id);
    const sku = String(p.sku || '').trim();
    if (!comVinculo.has(id)) {
      divergencias.push({ produto_id: id, sku, tipo: 'SEM_VINCULO', detalhe: 'Produto visível no site sem vínculo nesta loja.' });
      continue;
    }
    const linhas = await disponibilidadesPorTamanho(escopo, id);
    const invalido = linhas.find((l) => !Number.isFinite(Number(l.disponivel)) || Number(l.disponivel) < 0);
    if (invalido) {
      divergencias.push({
        produto_id: id,
        sku,
        tipo: 'SALDO_DIVERGENTE',
        detalhe: `Disponível inválido (${invalido.disponivel}) no tamanho ${invalido.codigo ?? 'único'}.`,
      });
    }
  }
  return divergencias;
}


