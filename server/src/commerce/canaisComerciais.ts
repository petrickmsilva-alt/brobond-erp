// ============================================================================
// FASE 9.4 — IDENTIDADE COMERCIAL CANÔNICA E APRESENTAÇÃO DOS CANAIS.
//
// Consolida a apresentação dos TRÊS canais oficiais (ADR-0005 / ADR-0008) numa
// visão única, sem criar um segundo cadastro de canais:
//
//   RETAIL         → WooCommerce  (https://brobond.com.br)
//   WHOLESALE      → WooCommerce  (https://atacado.brobond.com.br)
//   REPRESENTATIVES→ Portal de representantes (https://catalogo.brobond.com.br)
//
// REGRA DE HONESTIDADE (a razão deste módulo existir):
//   • um canal NUNCA aparece como "conectado" sem evidência REAL de conexão;
//   • RETAIL/WHOLESALE reusam o registry multi-loja (`store_key`); o estado é
//     "configurado" quando há URL+credencial, e "conectado" SOMENTE quando o
//     teste autenticado (`?testar=1`) responde OK;
//   • REPRESENTATIVES não tem conector no repositório — aparece como
//     `nao_homologado`, jamais como conectado;
//   • nenhuma credencial (CK/CS/token) é devolvida.
//
// Este módulo é LEITURA. Não publica, não sincroniza, não ativa conector e não
// altera a loja nativa `/loja` (a retirada dela segue BLOQUEADA — ADR-0007).
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from '../errors';
import { currentUser } from '../auth';
import { checkAccess } from '../services';
import { getResource } from '../resources';
import { escopoDoAtor } from '../empresa';
import { STORE_KEYS, STORE_LABEL, FONTE_PRECO, CANAL_PEDIDO, statusStoresDaEmpresa, configStore, type StoreKey } from './woocommerce/registry';
import { testarConexao } from './woocommerce/cliente';
import { estadoDaStore } from './woocommerce/estado';

export type CanalId = 'RETAIL' | 'WHOLESALE' | 'REPRESENTATIVES';

/**
 * Estado do canal. Deliberadamente conservador: `conectado` exige teste real;
 * ausência de conector no repositório vira `nao_homologado`.
 */
export type EstadoCanal = 'nao_configurado' | 'configurado' | 'conectado' | 'erro' | 'nao_homologado';

export type CanalComercial = {
  canal: CanalId;
  rotulo: string;
  plataforma: string;
  endereco: string;
  loja: StoreKey | null;
  preco_fonte: string | null;
  canal_venda: string | null;
  estado: EstadoCanal;
  conexao: { ok: boolean; erro?: string } | null;
  ultima_sincronizacao: string | null;
  ultimo_erro: string | null;
  pendencia: string | null;
  evidencia: string;
};

const ENDERECOS: Record<CanalId, string> = {
  RETAIL: 'https://brobond.com.br',
  WHOLESALE: 'https://atacado.brobond.com.br',
  REPRESENTATIVES: 'https://catalogo.brobond.com.br',
};

/**
 * Estado derivado de um canal WooCommerce. NUNCA promove a "conectado" sem o
 * resultado do teste autenticado — sem teste, o teto é "configurado".
 */
async function canalWoo(empresaId: number, store: StoreKey, testar: boolean): Promise<CanalComercial> {
  const status = statusStoresDaEmpresa(empresaId).find((s) => s.store_key === store);
  const cfg = configStore(store);
  const estado = await estadoDaStore(empresaId, store);
  let conexao: CanalComercial['conexao'] = null;
  let estadoCanal: EstadoCanal = 'nao_configurado';
  let pendencia: string | null = null;

  if (!status || !status.habilitada) {
    estadoCanal = 'nao_configurado';
    pendencia = status?.motivo ?? 'Loja não habilitada para esta empresa.';
  } else if (!cfg) {
    estadoCanal = 'nao_configurado';
    pendencia = status.motivo ?? 'Configuração incompleta.';
  } else {
    estadoCanal = 'configurado';
    if (testar) {
      conexao = await testarConexao(cfg);
      estadoCanal = conexao.ok ? 'conectado' : 'erro';
      if (!conexao.ok) pendencia = conexao.erro ?? 'Falha no teste de conexão.';
    } else {
      pendencia = 'Conexão não testada nesta consulta (use ?testar=1).';
    }
  }

  return {
    canal: store,
    rotulo: STORE_LABEL[store],
    plataforma: 'WooCommerce',
    endereco: ENDERECOS[store],
    loja: store,
    preco_fonte: FONTE_PRECO[store],
    canal_venda: CANAL_PEDIDO[store],
    estado: estadoCanal,
    conexao,
    ultima_sincronizacao: estado.ultima_sincronizacao_estoque_em,
    ultimo_erro: estado.ultimo_erro,
    pendencia,
    evidencia: cfg
      ? `Loja ${store} habilitada com URL e credencial configuradas.`
      : `Loja ${store} sem configuração completa (URL/CK/CS).`,
  };
}

/** Canal REPRESENTATIVES — sem conector no repositório: nunca "conectado". */
function canalRepresentantes(): CanalComercial {
  return {
    canal: 'REPRESENTATIVES',
    rotulo: 'Representantes (catálogo)',
    plataforma: 'Portal de representantes',
    endereco: ENDERECOS.REPRESENTATIVES,
    loja: null,
    preco_fonte: null,
    canal_venda: 'representante',
    estado: 'nao_homologado',
    conexao: null,
    ultima_sincronizacao: null,
    ultimo_erro: null,
    pendencia: 'Portal de representantes sem conector no repositório — homologação externa pendente.',
    evidencia: 'Nenhum conector de sincronização implementado para este canal; nada é presumido.',
  };
}

/**
 * Visão unificada dos canais da empresa. `testar` só afeta RETAIL/WHOLESALE e
 * faz o teste AUTENTICADO (leitura) da conexão — sem escrever nada na loja.
 */
export async function canaisComerciais(empresaId: number, opcoes: { testar?: boolean } = {}): Promise<CanalComercial[]> {
  const testar = opcoes.testar === true;
  const canais: CanalComercial[] = [];
  for (const store of STORE_KEYS) canais.push(await canalWoo(empresaId, store, testar));
  canais.push(canalRepresentantes());
  return canais;
}

/** GET /api/commerce/canais — visão unificada dos canais comerciais (?testar=1). */
export async function listarCanaisComerciais(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') {
    throw new HttpError(403, 'Apenas gerentes e administradores consultam os canais comerciais.');
  }
  const { empresaId } = escopoDoAtor(actor);
  res.setHeader('Cache-Control', 'private, no-store');
  const canais = await canaisComerciais(empresaId, { testar: req.query.testar === '1' });
  res.json({
    empresa_id: empresaId,
    testado: req.query.testar === '1',
    canais,
    nota:
      'RETAIL e WHOLESALE são WooCommerce (store_key imutável); REPRESENTATIVES é canal próprio. "conectado" só aparece após teste real de conexão. A loja nativa /loja segue ativa e não é um canal público oficial (retirada bloqueada — ADR-0007).',
  });
}
