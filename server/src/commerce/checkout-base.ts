// ============================================================================
// BASE DO CHECKOUT INTERNO — configuração, frete e responsável.
//
// A loja pública nativa `/loja` foi RETIRADA (ADR-0007). O motor de checkout,
// porém, é um serviço COMPARTILHADO do ERP (ADR-0007, "Consequências": os
// serviços internos — `checkoutMethods`, motor de pedidos — permanecem). Ele é
// servido por rotas AUTENTICADAS (`/api/commerce/checkout/*`), nunca por uma
// superfície pública anônima.
//
// Por isso o tenant NÃO é mais resolvido por env/unicidade da vitrine: ele vem
// do ATOR autenticado (`contextoCheckout`). Não existe mais um caminho sem
// sessão — a loja pública de varejo é a RETAIL WooCommerce (brobond.com.br).
// ============================================================================
import type { Request } from 'express';
import { currentUser } from '../auth';
import { escopoDoAtor } from '../empresa';
import { HttpError } from '../errors';
import { getStore } from '../services';
import { getResource } from '../resources';
import type { Row, Tx } from '../store';
import type { ConfigFrete } from './frete';

const R_CONFIG = () => getResource('commerce_configuracoes')!;
const R_USUARIOS = () => getResource('usuarios')!;
const R_USUARIO_EMPRESAS = () => getResource('usuario_empresas')!;

/** Configuração de checkout da empresa (linha única) ou null. */
export async function configDaLoja(empresaId: number, tx?: Tx): Promise<Row | null> {
  const s = getStore();
  return s.findOneWhere(R_CONFIG(), { empresa_id: empresaId }, tx);
}

/**
 * Tenant + configuração do checkout a partir da SESSÃO. A empresa nunca vem do
 * corpo nem de variável de ambiente: é o escopo do ator autenticado.
 */
export async function contextoCheckout(req: Request): Promise<{ empresaId: number; config: Row | null }> {
  const actor = currentUser(req);
  if (!actor) throw new HttpError(401, 'Autenticação necessária.');
  const { empresaId } = escopoDoAtor(actor);
  const config = await configDaLoja(empresaId);
  return { empresaId, config };
}

/**
 * Usuário dono das linhas `sales` do checkout (`sales.usuario_id NOT NULL`):
 *   1. `checkout_usuario_id` explícito da configuração (ativo);
 *   2. admin ativo cujo `usuarios.empresa_id` é a própria empresa;
 *   3. admin ativo com concessão em `usuario_empresas`;
 *   4. falha fechada com instrução — nunca escolhe usuário de outro tenant.
 */
export async function responsavelCheckout(empresaId: number, config: Row | null): Promise<number> {
  const s = getStore();
  if (config?.checkout_usuario_id) {
    const dono = await s.get(R_USUARIOS(), Number(config.checkout_usuario_id));
    const concessao = dono && (await s.findOneWhere(R_USUARIO_EMPRESAS(), { usuario_id: Number(dono.id), empresa_id: empresaId }));
    if (dono && dono.ativo !== false && (Number(dono.empresa_id) === empresaId || concessao)) return Number(dono.id);
    throw new HttpError(
      409,
      'O responsável pelo checkout configurado está inativo ou não tem acesso à empresa. Ajuste a configuração antes de vender.'
    );
  }
  const admins = await s.list(R_USUARIOS(), { page: 1, pageSize: 500, sort: 'id', dir: 'asc', filter: { perfil: 'admin', ativo: true } });
  const daEmpresa = admins.rows.find((u) => Number(u.empresa_id ?? 0) === empresaId);
  if (daEmpresa) return Number(daEmpresa.id);
  const concessoes = await s.list(R_USUARIO_EMPRESAS(), { page: 1, pageSize: 500, sort: 'id', dir: 'asc', filter: { empresa_id: empresaId } });
  const concedidos = new Set(concessoes.rows.map((c) => Number(c.usuario_id)));
  const adminConcedido = admins.rows.find((u) => concedidos.has(Number(u.id)));
  if (adminConcedido) return Number(adminConcedido.id);
  throw new HttpError(
    409,
    'O checkout não tem um usuário responsável. Cadastre um administrador para a empresa ou defina o responsável na configuração.'
  );
}

/** Configuração de frete tipada para o FreightProvider. */
export function freteDaConfig(config: Row | null): ConfigFrete {
  return {
    frete_provedor: String(config?.frete_provedor || 'nenhum'),
    frete_valor: config?.frete_valor ?? 0,
    frete_gratis_acima: config?.frete_gratis_acima ?? null,
    frete_prazo_dias: config?.frete_prazo_dias ?? null,
  };
}

// ----------------------------------------------------------------------------
// CARRINHO — VALIDAÇÃO ESTRITA DA ALTERAÇÃO DE QUANTIDADE (server-side).
//
// Módulo PURO (sem banco, sem Request/Response) para teste isolado. Regra:
//   - `quantidade` só é aceita como NUMBER inteiro, finito, 1..99;
//   - strings (mesmo "2"), null, boolean, objeto, array, 0, negativos, decimais,
//     NaN e ±Infinity são REJEITADOS (nunca coerced);
//   - só produto_id / tamanho_id / quantidade / cupom são lidos. Campos
//     monetários/de tenant enviados pelo cliente são IGNORADOS.

/** Limite operacional do carrinho (mesmo teto do preview e do checkout). */
export const QUANTIDADE_MAXIMA_CARRINHO = 99;

/** Devolve a quantidade válida ou `null` — NUNCA converte tipo. */
export function quantidadeValida(valor: unknown): number | null {
  if (typeof valor !== 'number') return null;
  if (!Number.isFinite(valor) || !Number.isInteger(valor)) return null;
  if (valor < 1 || valor > QUANTIDADE_MAXIMA_CARRINHO) return null;
  return valor;
}

export type LinhaQuantidade = {
  produto_id: number;
  tamanho_id: number | null;
  quantidade: number;
};

export type CorpoQuantidade = {
  alvo: LinhaQuantidade;
  itens: LinhaQuantidade[];
  cupom: string;
};

function erro(mensagem: string): never {
  throw new HttpError(400, mensagem, { itens: 'Quantidade inválida' });
}

function objeto(valor: unknown): valor is Record<string, unknown> {
  return !!valor && typeof valor === 'object' && !Array.isArray(valor);
}

function idProduto(valor: unknown): number {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor <= 0) erro('Item do carrinho sem produto.');
  return valor;
}

function idTamanho(valor: unknown): number | null {
  if (valor == null || valor === '') return null;
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor <= 0) erro('Tamanho inválido no carrinho.');
  return valor;
}

function linha(bruto: unknown): LinhaQuantidade {
  if (!objeto(bruto)) erro('Item do carrinho inválido.');
  const quantidade = quantidadeValida(bruto.quantidade);
  if (quantidade === null) erro('Quantidade inválida (1 a 99) no carrinho.');
  return {
    produto_id: idProduto(bruto.produto_id),
    tamanho_id: idTamanho(bruto.tamanho_id),
    quantidade,
  };
}

export function chaveLinha(linhaAlvo: Pick<LinhaQuantidade, 'produto_id' | 'tamanho_id'>): string {
  return `${linhaAlvo.produto_id}:${linhaAlvo.tamanho_id ?? ''}`;
}

/**
 * Valida o corpo de POST /api/commerce/checkout/carrinho/quantidade e devolve SOMENTE os
 * campos que o servidor aceita. Qualquer campo monetário/de tenant é descartado
 * aqui (não existe caminho para ele chegar ao cálculo).
 */
export function validarCorpoQuantidade(bruto: unknown): CorpoQuantidade {
  if (!objeto(bruto)) erro('Corpo da requisição inválido.');
  const alvo = linha(bruto.alvo);
  if (!Array.isArray(bruto.itens) || bruto.itens.length === 0 || bruto.itens.length > 30) erro('O carrinho está vazio ou excede 30 linhas.');
  const itens = bruto.itens.map(linha);
  const chaves = new Set<string>();
  for (const item of itens) {
    const chave = chaveLinha(item);
    if (chaves.has(chave)) erro('Item duplicado no carrinho. Atualize a quantidade na mesma linha.');
    chaves.add(chave);
  }
  const alvoNoCarrinho = itens.find((i) => chaveLinha(i) === chaveLinha(alvo));
  if (!alvoNoCarrinho || alvoNoCarrinho.quantidade !== alvo.quantidade) {
    erro('A quantidade solicitada não corresponde ao carrinho enviado.');
  }
  const cupom = typeof bruto.cupom === 'string' ? bruto.cupom.slice(0, 40) : '';
  return { alvo, itens, cupom };
}

