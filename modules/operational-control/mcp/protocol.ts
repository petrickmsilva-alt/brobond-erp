// ============================================================================
// OPERATIONAL CONTROL › MCP › PROTOCOLO (JSON-RPC 2.0 sobre HTTP)
//
// O Remote MCP Server fala JSON-RPC 2.0 em um único endpoint HTTP (transporte
// "Streamable HTTP" do MCP: POST com a mensagem, resposta JSON). NÃO há
// ferramenta genérica de HTTP, shell, SQL ou filesystem — só as ferramentas
// tipadas declaradas em `tools.ts`.
//
// Estes helpers concentram os códigos de erro do JSON-RPC e a validação da
// mensagem, para que o `server.ts` só orquestre identidade × escopo × política.
// ============================================================================

/** Versão de protocolo MCP anunciada por padrão (o cliente pode pedir outra). */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_SERVER_NAME = 'brobond-operational-control';
export const MCP_SERVER_VERSION = process.env.npm_package_version || '0.6.0';

/** Códigos de erro JSON-RPC 2.0 (+ faixa de servidor). */
export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export type RpcId = string | number | null;

export type RpcRequest = {
  jsonrpc: '2.0';
  id: RpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type RpcError = { code: number; message: string; data?: unknown };

/** Resposta de sucesso. */
export function respostaOk(id: RpcId, result: unknown): { jsonrpc: '2.0'; id: RpcId; result: unknown } {
  return { jsonrpc: '2.0', id, result };
}

export function respostaErro(id: RpcId, erro: RpcError): { jsonrpc: '2.0'; id: RpcId; error: RpcError } {
  return { jsonrpc: '2.0', id, error: erro };
}

/**
 * Valida o envelope JSON-RPC. Devolve o pedido normalizado ou um erro. Uma
 * NOTIFICAÇÃO (sem `id`) é marcada com `notificacao: true` — o transporte
 * responde 202 sem corpo.
 */
export function lerRequisicao(corpo: unknown): { ok: true; req: RpcRequest; notificacao: boolean } | { ok: false; erro: RpcError; id: RpcId } {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) {
    return { ok: false, erro: { code: RPC.invalidRequest, message: 'Mensagem JSON-RPC inválida.' }, id: null };
  }
  const b = corpo as Record<string, unknown>;
  if (b.jsonrpc !== '2.0') {
    return { ok: false, erro: { code: RPC.invalidRequest, message: 'jsonrpc deve ser "2.0".' }, id: (b.id as RpcId) ?? null };
  }
  if (typeof b.method !== 'string' || !b.method) {
    return { ok: false, erro: { code: RPC.invalidRequest, message: 'method é obrigatório.' }, id: (b.id as RpcId) ?? null };
  }
  const temId = b.id !== undefined && b.id !== null;
  const id = temId ? (b.id as RpcId) : null;
  const params = b.params && typeof b.params === 'object' && !Array.isArray(b.params) ? (b.params as Record<string, unknown>) : undefined;
  return { ok: true, req: { jsonrpc: '2.0', id, method: b.method, params }, notificacao: !temId };
}

/** Conteúdo textual de uma resposta de ferramenta MCP. */
export type ResultadoFerramenta = { content: { type: 'text'; text: string }[]; structuredContent?: unknown; isError?: boolean };

export function conteudoTexto(dados: unknown, isError = false): ResultadoFerramenta {
  const texto = typeof dados === 'string' ? dados : JSON.stringify(dados ?? {}, null, 2);
  const base: ResultadoFerramenta = { content: [{ type: 'text', text: texto }] };
  if (!isError && dados && typeof dados === 'object') base.structuredContent = dados;
  if (isError) base.isError = true;
  return base;
}
