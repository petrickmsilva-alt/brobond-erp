// ============================================================================
// MOTOR DE FRETE › APLICAÇÃO › CONTEXTO DA VENDA
//
// Monta o `ContextoCotacao` a partir de uma VENDA já lida e autorizada. Tudo
// vem do servidor: origem (empresa/config), destino (cliente), volumes (ficha
// dos produtos), valores (itens) e a loja de origem (vínculo do pedido externo).
//
// O cliente NUNCA informa CEP de origem, peso, volumes ou valor — o backend os
// deriva do banco. Isso é o que impede uma cotação "montada" pelo navegador.
// ============================================================================
import { getStore } from '../../../server/src/services';
import { getResource } from '../../../server/src/resources';
import { HttpError } from '../../../server/src/errors';
import { round2 } from '../../../server/src/utils';
import { cepNormalizado, cepValido, type ContextoCotacao, type Modalidade, type VolumeFrete } from '../domain/contract';
import { obterConfigLogistica } from '../../../server/src/logistica';
import { provedorPadrao } from './quotes';
import { lojaDaVenda } from '../integration/woocommerce';
import type { Row } from '../../../server/src/store';

function num(v: unknown, padrao = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
}

export type ContextoVenda = ContextoCotacao & { providerSlug: string };

async function enderecoDe(row: Row | null): Promise<{ cep: string; cidade: string | null; uf: string | null }> {
  return { cep: cepNormalizado(row?.cep), cidade: row?.cidade ? String(row.cidade) : null, uf: row?.uf ? String(row.uf) : null };
}

/** Origem: endereço da empresa ou o CEP padrão da configuração de logística. */
async function origemPadrao(empresaId: number): Promise<{ cep: string; cidade: string | null; uf: string | null }> {
  const empresa = await getStore().get(getResource('empresas')!, empresaId);
  const cfg = await obterConfigLogistica(empresaId);
  const end = await enderecoDe(empresa);
  return { cep: cepNormalizado(cfg.cep_origem) || end.cep, cidade: end.cidade, uf: end.uf };
}

/** Destino: endereço do cliente da venda. */
async function destinoDaVenda(venda: Row, empresaId: number): Promise<{ cep: string; cidade: string | null; uf: string | null }> {
  if (!venda.cliente_id) throw new HttpError(400, 'A venda não tem cliente — não há endereço de entrega para cotar o frete.');
  const cliente = await getStore().get(getResource('clientes')!, Number(venda.cliente_id));
  if (!cliente || Number(cliente.empresa_id) !== empresaId) throw new HttpError(404, 'Cliente da venda não encontrado nesta empresa.');
  const end = await enderecoDe(cliente);
  if (!cepValido(end.cep)) throw new HttpError(400, 'O cliente não tem CEP cadastrado (ou está incompleto). Complete o endereço antes de cotar o frete.');
  return end;
}

/** Volumes e valores somados dos itens da venda. */
async function volumesDaVenda(vendaId: number, empresaId: number): Promise<{ volumes: VolumeFrete[]; valor: number; pesoTotal: number }> {
  const s = getStore();
  const itens = await s.list(getResource('itens_venda')!, { page: 1, pageSize: 1000, filter: { venda_id: vendaId, empresa_id: empresaId } });
  const produtos = await s.list(getResource('produtos')!, { page: 1, pageSize: 20000, filter: { empresa_id: empresaId } });
  const porId = new Map(produtos.rows.map((p) => [Number(p.id), p]));
  let pesoTotal = 0;
  let valor = 0;
  const volumes: VolumeFrete[] = [];
  for (const item of itens.rows) {
    const p = porId.get(Number(item.produto_id));
    const qtd = Math.max(1, Math.trunc(num(item.quantidade)));
    const pesoUnit = num(p?.peso_bruto_g ?? p?.peso_g ?? 300);
    pesoTotal += pesoUnit * qtd;
    valor = round2(valor + num(item.subtotal));
    volumes.push({
      peso_g: pesoUnit,
      // A ficha guarda em MILÍMETROS; os provedores pedem centímetros.
      altura_cm: p && num(p.altura_mm) ? round2(num(p.altura_mm) / 10) : undefined,
      largura_cm: p && num(p.largura_mm) ? round2(num(p.largura_mm) / 10) : undefined,
      comprimento_cm: p && num(p.profundidade_mm) ? round2(num(p.profundidade_mm) / 10) : undefined,
      quantidade: qtd,
    });
  }
  if (!volumes.length) volumes.push({ peso_g: 300, quantidade: 1 });
  return { volumes, valor, pesoTotal };
}

/** Modalidade padrão da empresa (CIF). Pode ser sobreposta pela requisição. */
function modalidadePadrao(): Modalidade {
  const bruto = String(process.env.LOGISTICS_DEFAULT_MODALIDADE ?? 'CIF').toUpperCase();
  return (['CIF', 'FOB', 'RETIRADA', 'SUBSIDIADO'].includes(bruto) ? bruto : 'CIF') as Modalidade;
}

export async function montarContextoVenda(
  empresaId: number,
  venda: Row,
  opcoes: { provider?: string | null; modalidade?: Modalidade } = {}
): Promise<ContextoVenda> {
  const vendaId = Number(venda.id);
  const [origem, destino, vol] = await Promise.all([origemPadrao(empresaId), destinoDaVenda(venda, empresaId), volumesDaVenda(vendaId, empresaId)]);
  if (!cepValido(origem.cep)) throw new HttpError(409, 'A empresa não tem CEP de origem. Complete o cadastro da empresa ou defina o CEP na configuração de logística.');
  const storeKey = await lojaDaVenda(empresaId, vendaId);
  const providerSlug = String(opcoes.provider || provedorPadrao()).toLowerCase();
  return {
    empresaId,
    storeKey,
    vendaId,
    origem,
    destino,
    volumes: vol.volumes,
    pesoTotalG: vol.pesoTotal,
    valorDeclarado: vol.valor,
    valorPedido: round2(num(venda.total) || vol.valor),
    modalidade: opcoes.modalidade ?? modalidadePadrao(),
    providerSlug,
  };
}
