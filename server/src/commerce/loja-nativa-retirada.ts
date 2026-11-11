// ============================================================================
// LOJA NATIVA RETIRADA — tratamento das URLs antigas da vitrine própria.
//
// A loja pública nativa (`/loja`) foi DESCONTINUADA (ADR-0007): a única loja
// pública de varejo é a RETAIL WooCommerce (https://brobond.com.br). As rotas
// da SPA e a API `/api/loja/*` não existem mais.
//
// As URLs antigas continuam chegando (links salvos, SEO, histórico). Elas são
// respondidas de forma explícita — nunca com o index do ERP (que daria um 200
// enganoso) nem com um 404 mudo:
//
//   • `STOREFRONT_REDIRECT_URL` definida → 301 permanente para a RETAIL (o
//     Diretor decide o destino de SEO sem alterar DNS por aqui);
//   • sem a variável → 410 Gone (conteúdo removido em definitivo).
//
// Caminhos transacionais (`/loja/carrinho`, `/loja/checkout`, `/loja/pedido/*`)
// não têm equivalente e respondem sempre 410, mesmo com a variável definida —
// redirecionar um carrinho/checkout para outra loja seria mentira.
//
// NENHUM dado é apagado: pedidos, vendas e publicações históricas continuam no
// ERP. Esta camada só governa o HTTP das URLs retiradas.
// ============================================================================
import type { Request, Response } from 'express';

/** Caminhos da SPA nativa que são transacionais e nunca redirecionam. */
const SEM_EQUIVALENTE = [/^\/loja\/carrinho\/?$/, /^\/loja\/checkout\/?$/, /^\/loja\/pedido\//];

/** Caminhos da SPA nativa que podem apontar para a loja de varejo. */
const COM_EQUIVALENTE = [/^\/loja\/?$/, /^\/loja\/produto\//];

function destinoDeRedirect(): string | null {
  const bruto = process.env.STOREFRONT_REDIRECT_URL?.trim();
  if (!bruto) return null;
  // Só aceita URL absoluta http(s) — evita redirecionar para um caminho relativo
  // (loop) ou para um esquema inesperado.
  if (!/^https?:\/\//i.test(bruto)) return null;
  return bruto.replace(/\/+$/, '');
}

/**
 * Responde as URLs antigas da loja nativa. Retorna `true` quando a requisição
 * foi tratada aqui (o chamador deve parar); `false` quando o caminho não é da
 * loja nativa (segue o fluxo normal).
 */
export function lojaNativaRetirada(req: Request, res: Response): boolean {
  const caminho = req.path;
  if (!caminho.startsWith('/loja')) return false;

  const temEquivalente = COM_EQUIVALENTE.some((re) => re.test(caminho));
  const destino = temEquivalente ? destinoDeRedirect() : null;
  if (destino) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.redirect(301, destino);
    return true;
  }

  const definitivo = !SEM_EQUIVALENTE.some((re) => re.test(caminho));
  res.status(410).type('html').send(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8" /><title>Loja descontinuada</title>` +
      `<meta name="robots" content="noindex" /></head><body>` +
      `<h1>Loja própria descontinuada</h1>` +
      `<p>A loja de varejo do Brobond agora é <a href="https://brobond.com.br">brobond.com.br</a>.</p>` +
      `${definitivo ? '' : '<p>Este caminho não tem equivalente na nova loja.</p>'}` +
      `</body></html>`
  );
  return true;
}
