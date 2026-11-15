// ============================================================================
// OAUTH 2.1 › BROWSER AUTHORIZATION BRIDGE (interface HTML + JS estático)
//
// Por que esta ponte existe:
//   O ChatGPT inicia o fluxo OAuth 2.1 abrindo `GET /oauth/authorize?...` por
//   NAVEGAÇÃO de documento no navegador. A sessão do Brobond ERP vive em
//   `localStorage.brobond_token` (enviada como `Authorization: Bearer <token>`
//   nas chamadas de API), que o navegador não anexa automaticamente numa
//   navegação `GET`.
//
// Como funciona sem abrir mão de nenhum controle:
//   1. `GET /oauth/authorize` (sem Bearer) valida os parâmetros públicos da
//      solicitação no servidor e entrega este documento HTML estático na mesma
//      origem do ERP, com cabeçalhos `Cache-Control: no-store`. Nenhum código
//      é emitido e nenhum consentimento é gravado aqui.
//   2. `GET /oauth/authorize/bridge.js` roda sob `script-src 'self'` (sem
//      `eval`, sem script inline, sem alterar a CSP global):
//        • verifica `localStorage.brobond_token`;
//        • sem sessão → exibe orientação clara e link seguro para `/login?next=…`
//          (caminho relativo `/oauth/authorize?…` validado em ambos os lados);
//        • com sessão → consulta `GET /oauth/authorize/session?...` enviando o
//          `Bearer` para obter do SERVIDOR o cliente validado, o usuário
//          autenticado e os escopos efetivamente permitidos;
//        • ao confirmar → envia `POST /oauth/authorize/consent` com `Bearer` +
//          cabeçalho explícito anti-CSRF (`X-Brobond-OAuth-Bridge: 1`) e
//          validação `Origin`/`Sec-Fetch-Site` no servidor;
//        • ao cancelar → envia `POST /oauth/authorize/deny` (sem gravar
//          consentimento nem emitir código) para obter `redirect_uri?error=access_denied`
//          validada pelo servidor, ou retorna ao ERP;
//        • navega o documento (`window.location.replace`) para a URL devolvida
//          pelo backend — sem `fetch()` externo e sem permitir `form-action`
//          fora de `'self'`.
//
// Segurança:
//   • O token do ERP NUNCA entra em URL, query, fragmento, HTML, cookie, log ou
//     mensagem de erro; só sai em `Authorization: Bearer` para a MESMA origem.
//   • O navegador nunca escolhe `redirect_uri` nem amplia escopos: o backend
//     recalcula tudo antes de emitir o código ou o redirecionamento de recusa.
// ============================================================================

export function escaparHtml(valor: unknown): string {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type BridgePageData = {
  ok: boolean;
  applicationName?: string;
  clientId?: string;
  scopes?: Array<{ scope: string; description: string }>;
  errorMessage?: string;
};

/** Renderiza a página HTML da ponte OAuth (zero script inline — compatível com `script-src 'self'`). */
export function renderizarPaginaBridge(dados: BridgePageData): string {
  const titulo = dados.ok ? 'Autorizar conexão OAuth — BROBOND ERP' : 'Solicitação OAuth inválida — BROBOND ERP';
  const appNome = escaparHtml(dados.applicationName ?? '');
  const clientId = escaparHtml(dados.clientId ?? '');
  const erroInicial = dados.ok ? '' : escaparHtml(dados.errorMessage ?? 'Parâmetros de autorização OAuth inválidos.');

  const escoposHtml = (dados.scopes ?? [])
    .map(
      (item) =>
        `<li class="scope-item">` +
        `<span class="scope-check" aria-hidden="true">&#10003;</span>` +
        `<div class="scope-body">` +
        `<div class="scope-desc">${escaparHtml(item.description)}</div>` +
        `<code class="scope-code">${escaparHtml(item.scope)}</code>` +
        `</div>` +
        `</li>`
    )
    .join('');

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${titulo}</title>
  <style>
    :root {
      color-scheme: light;
      --navy-900: #0f172a;
      --navy-800: #1e293b;
      --slate-700: #334155;
      --slate-600: #475569;
      --slate-500: #64748b;
      --slate-200: #e2e8f0;
      --slate-100: #f1f5f9;
      --slate-50: #f8fafc;
      --brand-600: #0284c7;
      --brand-700: #0369a1;
      --green-700: #15803d;
      --green-50: #f0fdf4;
      --green-200: #bbf7d0;
      --red-700: #b91c1c;
      --red-50: #fef2f2;
      --red-200: #fecaca;
      --amber-800: #92400e;
      --amber-50: #fffbeb;
      --amber-200: #fde68a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
      background: var(--slate-100);
      color: var(--navy-900);
    }
    .card {
      width: 100%;
      max-width: 480px;
      background: #ffffff;
      border: 1px solid var(--slate-200);
      border-radius: 16px;
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08);
      padding: 28px;
    }
    .brand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--slate-200);
      margin-bottom: 20px;
    }
    .brand-title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--navy-800);
    }
    .badge {
      font-size: 11px;
      font-weight: 600;
      padding: 4px 8px;
      border-radius: 999px;
      background: var(--slate-100);
      color: var(--slate-700);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 20px;
      line-height: 1.3;
      color: var(--navy-900);
    }
    p {
      margin: 0 0 14px;
      font-size: 14px;
      line-height: 1.55;
      color: var(--slate-600);
    }
    .hidden { display: none !important; }
    .box {
      border: 1px solid var(--slate-200);
      background: var(--slate-50);
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 16px;
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      font-size: 13px;
      padding: 4px 0;
    }
    .meta-label { color: var(--slate-500); }
    .meta-value {
      font-weight: 600;
      color: var(--navy-900);
      text-align: right;
      word-break: break-word;
    }
    .scopes-title {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--slate-500);
      margin: 16px 0 8px;
    }
    .scope-list {
      list-style: none;
      padding: 0;
      margin: 0 0 18px;
      border: 1px solid var(--slate-200);
      border-radius: 12px;
      divide-y: 1px solid var(--slate-200);
      overflow: hidden;
    }
    .scope-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 11px 14px;
      border-bottom: 1px solid var(--slate-200);
      background: #ffffff;
    }
    .scope-item:last-child { border-bottom: none; }
    .scope-check {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 999px;
      background: var(--green-50);
      border: 1px solid var(--green-200);
      color: var(--green-700);
      font-size: 12px;
      font-weight: 700;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .scope-body { min-width: 0; }
    .scope-desc {
      font-size: 13.5px;
      font-weight: 600;
      color: var(--navy-900);
      margin-bottom: 2px;
    }
    .scope-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11.5px;
      color: var(--slate-500);
    }
    .alert {
      border-radius: 10px;
      padding: 12px 14px;
      font-size: 13.5px;
      line-height: 1.5;
      margin-bottom: 16px;
    }
    .alert-error {
      background: var(--red-50);
      border: 1px solid var(--red-200);
      color: var(--red-700);
    }
    .alert-warn {
      background: var(--amber-50);
      border: 1px solid var(--amber-200);
      color: var(--amber-800);
    }
    .actions {
      display: flex;
      gap: 10px;
      margin-top: 18px;
    }
    .btn {
      appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      padding: 11px 16px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background-color 0.15s ease, opacity 0.15s ease;
    }
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .btn-primary {
      background: var(--brand-600);
      color: #ffffff;
    }
    .btn-primary:hover:not(:disabled) { background: var(--brand-700); }
    .btn-secondary {
      background: #ffffff;
      border-color: var(--slate-200);
      color: var(--slate-700);
    }
    .btn-secondary:hover:not(:disabled) { background: var(--slate-50); }
    .reauth-group {
      margin-top: 14px;
      padding: 14px;
      border-radius: 10px;
      border: 1px solid var(--amber-200);
      background: var(--amber-50);
    }
    .reauth-group label {
      display: block;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--amber-800);
      margin-bottom: 6px;
    }
    .reauth-group input {
      width: 100%;
      padding: 9px 11px;
      border: 1px solid var(--slate-200);
      border-radius: 8px;
      font-size: 14px;
    }
    .footnote {
      margin-top: 16px;
      font-size: 12px;
      color: var(--slate-500);
      text-align: center;
    }
  </style>
</head>
<body>
  <main
    class="card"
    id="oauth-bridge-root"
    data-valid="${dados.ok ? '1' : '0'}"
    data-client-id="${clientId}"
    data-app-name="${appNome}"
  >
    <div class="brand">
      <span class="brand-title">BROBOND ERP · Controle Operacional</span>
      <span class="badge">OAuth 2.1 + PKCE</span>
    </div>

    ${
      !dados.ok
        ? `<section id="state-invalid" role="alert">
      <h1>Não foi possível iniciar a autorização</h1>
      <div class="alert alert-error">${erroInicial}</div>
      <p>Nenhum consentimento foi concedido e nenhum código foi emitido. Feche esta janela ou retorne à aplicação de origem.</p>
      <div class="actions">
        <a class="btn btn-secondary" href="/">Ir para o BROBOND ERP</a>
      </div>
    </section>`
        : `<section id="state-loading" aria-live="polite">
      <h1>Verificando sua sessão no ERP…</h1>
      <p>Aguarde um instante enquanto validamos sua autenticação local com segurança.</p>
    </section>

    <section id="state-login-required" class="hidden" aria-live="polite">
      <h1>Sessão do ERP necessária</h1>
      <div id="login-reason" class="alert alert-warn">
        Você precisa entrar no BROBOND ERP neste navegador antes de autorizar a conexão com <strong>${appNome}</strong>.
      </div>
      <p>Após concluir o login (e o segundo fator MFA, se solicitado), você retornará automaticamente para esta tela de consentimento.</p>
      <div class="actions">
        <a id="btn-go-login" class="btn btn-primary" href="/login">Entrar no BROBOND ERP</a>
        <button id="btn-cancel-unauth" type="button" class="btn btn-secondary">Cancelar</button>
      </div>
    </section>

    <section id="state-consent" class="hidden" aria-live="polite">
      <h1>Autorizar acesso à sua conta</h1>
      <p>Revise os dados da aplicação e as permissões solicitadas antes de confirmar.</p>

      <div class="box">
        <div class="meta-row">
          <span class="meta-label">Aplicação cliente</span>
          <span class="meta-value" id="consent-app-name">${appNome}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Client ID</span>
          <span class="meta-value"><code class="scope-code" id="consent-client-id">${clientId}</code></span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Usuário autenticado</span>
          <span class="meta-value" id="consent-user">—</span>
        </div>
      </div>

      <div class="scopes-title">Permissões solicitadas</div>
      <ul class="scope-list" id="consent-scopes">${escoposHtml}</ul>

      <div id="reauth-box" class="reauth-group hidden">
        <label for="reauth-password">Confirme sua senha do ERP para autorizar escopos sensíveis:</label>
        <input id="reauth-password" type="password" autocomplete="current-password" placeholder="Sua senha atual" />
      </div>

      <div id="consent-error" role="alert" class="alert alert-error hidden"></div>

      <div class="actions">
        <button id="btn-deny" type="button" class="btn btn-secondary">Cancelar</button>
        <button id="btn-approve" type="button" class="btn btn-primary">Autorizar acesso</button>
      </div>

      <div class="footnote">
        Código de uso único com PKCE S256 · Sua credencial do ERP não é compartilhada com a aplicação externa.
      </div>
    </section>

    <noscript>
      <div class="alert alert-error">
        O JavaScript precisa estar habilitado para verificar sua sessão no BROBOND ERP e confirmar o consentimento OAuth.
      </div>
    </noscript>`
    }
  </main>
  ${dados.ok ? '<script src="/oauth/authorize/bridge.js" defer></script>' : ''}
</body>
</html>`;
}

/**
 * Script externo estático da ponte (`GET /oauth/authorize/bridge.js`).
 * Servido na mesma origem (`script-src 'self'`), sem `eval` nem dependências externas.
 */
export const SCRIPT_OAUTH_BRIDGE = `(function () {
  'use strict';

  var TOKEN_KEY = 'brobond_token';
  var root = document.getElementById('oauth-bridge-root');
  if (!root || root.getAttribute('data-valid') !== '1') return;

  var secLoading = document.getElementById('state-loading');
  var secLogin = document.getElementById('state-login-required');
  var secConsent = document.getElementById('state-consent');
  var loginReason = document.getElementById('login-reason');
  var btnGoLogin = document.getElementById('btn-go-login');
  var btnCancelUnauth = document.getElementById('btn-cancel-unauth');
  var btnApprove = document.getElementById('btn-approve');
  var btnDeny = document.getElementById('btn-deny');
  var elUser = document.getElementById('consent-user');
  var elAppName = document.getElementById('consent-app-name');
  var elClientId = document.getElementById('consent-client-id');
  var elScopes = document.getElementById('consent-scopes');
  var elError = document.getElementById('consent-error');
  var reauthBox = document.getElementById('reauth-box');
  var reauthInput = document.getElementById('reauth-password');

  function mostrarSecao(alvo) {
    [secLoading, secLogin, secConsent].forEach(function (el) {
      if (!el) return;
      if (el === alvo) el.classList.remove('hidden');
      else el.classList.add('hidden');
    });
  }

  function mostrarErro(msg) {
    if (!elError) return;
    elError.textContent = String(msg || 'Não foi possível concluir a autorização.');
    elError.classList.remove('hidden');
  }

  function limparErro() {
    if (!elError) return;
    elError.textContent = '';
    elError.classList.add('hidden');
  }

  function lerParametrosOAuth() {
    var sp = new URLSearchParams(window.location.search);
    var out = {};
    ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource'].forEach(function (k) {
      var v = sp.get(k);
      if (v !== null) out[k] = v;
    });
    return out;
  }

  function urlLoginComRetorno() {
    var caminhoAtual = '/oauth/authorize' + (window.location.search || '');
    return '/login?next=' + encodeURIComponent(caminhoAtual);
  }

  function exigirLogin(mensagem) {
    if (btnGoLogin) btnGoLogin.setAttribute('href', urlLoginComRetorno());
    if (mensagem && loginReason) {
      loginReason.textContent = mensagem;
    }
    mostrarSecao(secLogin);
  }

  function obterTokenLocal() {
    try {
      return window.localStorage.getItem(TOKEN_KEY) || '';
    } catch (_e) {
      return '';
    }
  }

  function preencherEscopos(lista) {
    if (!elScopes || !Array.isArray(lista)) return;
    elScopes.textContent = '';
    lista.forEach(function (item) {
      var li = document.createElement('li');
      li.className = 'scope-item';

      var check = document.createElement('span');
      check.className = 'scope-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '\\u2713';

      var body = document.createElement('div');
      body.className = 'scope-body';

      var desc = document.createElement('div');
      desc.className = 'scope-desc';
      desc.textContent = String(item.description || item.scope || '');

      var code = document.createElement('code');
      code.className = 'scope-code';
      code.textContent = String(item.scope || '');

      body.appendChild(desc);
      body.appendChild(code);
      li.appendChild(check);
      li.appendChild(body);
      elScopes.appendChild(li);
    });
  }

  function definirOcupado(ocupado) {
    if (btnApprove) btnApprove.disabled = ocupado;
    if (btnDeny) btnDeny.disabled = ocupado;
    if (btnCancelUnauth) btnCancelUnauth.disabled = ocupado;
  }

  function cancelarFluxo() {
    definirOcupado(true);
    limparErro();
    fetch('/oauth/authorize/deny', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Brobond-OAuth-Bridge': '1'
      },
      body: JSON.stringify(lerParametrosOAuth())
    })
      .then(function (r) {
        return r.json().then(function (d) { return { status: r.status, body: d }; });
      })
      .then(function (res) {
        if (res.status === 200 && res.body && typeof res.body.redirect_to === 'string') {
          window.location.replace(res.body.redirect_to);
          return;
        }
        window.location.replace('/');
      })
      .catch(function () {
        window.location.replace('/');
      });
  }

  var precisaReauth = false;

  function carregarSessao() {
    var token = obterTokenLocal();
    if (!token) {
      exigirLogin('');
      return;
    }

    fetch('/oauth/authorize/session' + (window.location.search || ''), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + token,
        'X-Brobond-OAuth-Bridge': '1'
      }
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          return { status: r.status, body: d };
        });
      })
      .then(function (res) {
        if (res.status === 401) {
          try { window.localStorage.removeItem(TOKEN_KEY); } catch (_e) {}
          exigirLogin('Sua sessão no BROBOND ERP expirou ou foi encerrada. Entre novamente para continuar a autorização.');
          return;
        }
        if (res.status !== 200 || !res.body || !res.body.ok) {
          mostrarSecao(secConsent);
          if (btnApprove) btnApprove.disabled = true;
          mostrarErro((res.body && res.body.error) || 'Não foi possível validar os parâmetros de autorização.');
          return;
        }
        var c = res.body.consent || {};
        var u = res.body.user || {};
        if (elAppName && c.application) elAppName.textContent = String(c.application);
        if (elClientId && c.client_id) elClientId.textContent = String(c.client_id);
        if (elUser) {
          var rotulo = u.name ? String(u.name) : 'Usuário autenticado';
          if (u.email) rotulo += ' (' + String(u.email) + ')';
          elUser.textContent = rotulo;
        }
        if (Array.isArray(c.permissions)) {
          preencherEscopos(c.permissions);
        }
        precisaReauth = Boolean(c.requires_reauth);
        if (precisaReauth && reauthBox) {
          reauthBox.classList.remove('hidden');
        }
        mostrarSecao(secConsent);
      })
      .catch(function () {
        mostrarSecao(secConsent);
        mostrarErro('Falha de comunicação com o servidor do ERP. Verifique sua conexão e recarregue a página.');
      });
  }

  function confirmarConsentimento() {
    var token = obterTokenLocal();
    if (!token) {
      exigirLogin('Sua sessão não foi encontrada. Entre novamente para autorizar.');
      return;
    }

    definirOcupado(true);
    limparErro();

    var executarPostConsent = function () {
      return fetch('/oauth/authorize/consent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + token,
          'X-Brobond-OAuth-Bridge': '1'
        },
        body: JSON.stringify(lerParametrosOAuth())
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          return { status: r.status, body: d };
        });
      });
    };

    var fluxo = Promise.resolve();
    if (precisaReauth && reauthInput && reauthInput.value) {
      fluxo = fetch('/api/auth/reautenticar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ senha: reauthInput.value })
      }).then(function (r) {
        if (r.status === 401) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            throw { tipo: 'erro_ui', mensagem: (d && d.error) || 'Senha incorreta na confirmação.' };
          });
        }
        if (!r.ok) {
          throw { tipo: 'erro_ui', mensagem: 'Não foi possível confirmar sua senha.' };
        }
      });
    }

    fluxo
      .then(executarPostConsent)
      .then(function (res) {
        if (res.status === 401) {
          try { window.localStorage.removeItem(TOKEN_KEY); } catch (_e) {}
          definirOcupado(false);
          exigirLogin('Sua sessão expirou antes da confirmação. Entre novamente no ERP para concluir a autorização.');
          return;
        }
        if (res.status === 403 && res.body && res.body.code === 'reauth_necessaria') {
          precisaReauth = true;
          if (reauthBox) reauthBox.classList.remove('hidden');
          definirOcupado(false);
          mostrarErro('Confirme sua senha atual do ERP para autorizar este escopo.');
          return;
        }
        if (res.status !== 200 || !res.body || typeof res.body.redirect_to !== 'string') {
          definirOcupado(false);
          mostrarErro((res.body && res.body.error) || 'Não foi possível conceder a autorização.');
          return;
        }
        window.location.replace(res.body.redirect_to);
      })
      .catch(function (err) {
        definirOcupado(false);
        if (err && err.tipo === 'erro_ui') {
          mostrarErro(err.mensagem);
          return;
        }
        mostrarErro('Falha de conexão ao confirmar a autorização. Tente novamente.');
      });
  }

  if (btnGoLogin) btnGoLogin.setAttribute('href', urlLoginComRetorno());
  if (btnApprove) btnApprove.addEventListener('click', confirmarConsentimento);
  if (btnDeny) btnDeny.addEventListener('click', cancelarFluxo);
  if (btnCancelUnauth) btnCancelUnauth.addEventListener('click', cancelarFluxo);

  carregarSessao();
})();
`;
