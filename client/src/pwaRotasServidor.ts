// ============================================================================
// PWA › CAMINHOS QUE PERTENCEM AO SERVIDOR (e não ao SPA)
//
// O Service Worker gerado pelo vite-plugin-pwa responde TODA navegação
// (`request.mode === 'navigate'`) com o `index.html` do precache — é o que faz
// o ERP abrir offline. A consequência é que, num navegador onde o ERP já foi
// aberto, qualquer endereço digitado na barra é entregue pelo Service Worker
// SEM chegar ao Express: o React Router não reconhece o caminho e cai no
// dashboard (ou no login).
//
// Os caminhos abaixo são atendidos pelo Express na RAIZ (fora do `/api`) e
// devolvem JSON ou redirecionamento do protocolo — nunca a casca do SPA. Eles
// entram na `navigateFallbackDenylist` do Workbox para que a navegação siga
// para a rede:
//
//   /api/…            API do ERP
//   /.well-known/…    descoberta OAuth 2.1 (RFC 8414 / RFC 9728) e JWKS
//   /oauth/…          Authorization Server (authorize, token, register, revoke)
//   /mcp              Remote MCP Server (Resource Server)
//
// O Workbox confere cada expressão contra `pathname + search`.
//
// Arquivo SEM dependências de propósito: é lido pelo `vite.config.ts` (build),
// pelo teste do cliente e pelo teste de contrato do servidor
// (`server/test/oauth-well-known-http.test.ts`), que recusa uma rota nova na
// raiz do OAuth/MCP que não esteja coberta aqui.
// ============================================================================
export const ROTAS_DO_SERVIDOR: RegExp[] = [
  /^\/api\//,
  /^\/\.well-known\//,
  /^\/oauth\//,
  /^\/mcp(?:\/|\?|$)/,
];

/** `true` quando a navegação deve ir para a rede (Express), não para o SPA. */
export function ehRotaDoServidor(caminhoComQuery: string): boolean {
  return ROTAS_DO_SERVIDOR.some((re) => re.test(caminhoComQuery));
}
