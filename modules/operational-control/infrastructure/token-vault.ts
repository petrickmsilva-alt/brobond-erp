// ============================================================================
// CONTROL PLANE › INFRA › COFRE DE SEGREDOS DA GITHUB APP
//
// CREDENCIAL NUNCA NO CÓDIGO. A chave privada da GitHub App e o webhook secret
// vivem no AMBIENTE do servidor (render.yaml, sync:false) ou, alternativamente,
// na tabela `configuracoes` CIFRADOS (AES-256-GCM, `segredos.ts`) — o mesmo
// mecanismo já usado por transportadoras e gateways.
//
// Nomes de configuração (referências, NUNCA valores enviados pelo chat):
//   GITHUB_APP_ID
//   GITHUB_APP_INSTALLATION_ID
//   GITHUB_APP_PRIVATE_KEY      (PEM; `\n` escapado no ambiente é aceito)
//   GITHUB_WEBHOOK_SECRET       (somente se webhooks forem habilitados)
//
// Nenhum token é registrado em log; a chave privada nunca é serializada.
// ============================================================================
import { lerConfig, gravarConfig } from '../../../server/src/configuracoes';
import { cifrarSegredo, decifrarSegredo, pareceCifrado } from '../../../server/src/segredos';

export type GithubAppConfig = {
  appId: string;
  installationId: string;
  privateKey: string;
  webhookSecret: string | null;
};

const CHAVE_CONFIG = 'operational_github_app';

/** A chave privada PEM precisa ter cabeçalho e rodapé; `\n` escapado é aceito. */
function normalizarPem(bruto: string): string {
  const s = String(bruto ?? '').replace(/\\n/g, '\n').trim();
  if (!s.includes('BEGIN') || !s.includes('PRIVATE KEY')) return '';
  return s;
}

/** Config da GitHub App a partir do AMBIENTE (precedência) — `null` se incompleta. */
function doAmbiente(): GithubAppConfig | null {
  const appId = String(process.env.GITHUB_APP_ID ?? '').trim();
  const installationId = String(process.env.GITHUB_APP_INSTALLATION_ID ?? '').trim();
  const privateKey = normalizarPem(process.env.GITHUB_APP_PRIVATE_KEY ?? '');
  if (!appId || !installationId || !privateKey) return null;
  return { appId, installationId, privateKey, webhookSecret: String(process.env.GITHUB_WEBHOOK_SECRET ?? '').trim() || null };
}

/** Config da GitHub App a partir da tabela `configuracoes` (cifrada). */
async function doBanco(): Promise<GithubAppConfig | null> {
  const bruto = await lerConfig(CHAVE_CONFIG);
  if (!bruto) return null;
  try {
    const parsed = JSON.parse(bruto) as Record<string, string | null>;
    const privateKey = normalizarPem(decifrarSegredo(parsed.private_key) ?? '');
    const appId = String(parsed.app_id ?? '').trim();
    const installationId = String(parsed.installation_id ?? '').trim();
    if (!appId || !installationId || !privateKey) return null;
    return {
      appId,
      installationId,
      privateKey,
      webhookSecret: decifrarSegredo(parsed.webhook_secret) ?? null,
    };
  } catch {
    return null;
  }
}

/** Config resolvida (ambiente primeiro, banco depois). `null` = não configurada. */
export async function obterConfigGithubApp(): Promise<GithubAppConfig | null> {
  return doAmbiente() ?? (await doBanco());
}

/** A GitHub App está configurada? (sem revelar nenhum valor) */
export async function githubAppConfigurada(): Promise<boolean> {
  return (await obterConfigGithubApp()) !== null;
}

/**
 * Grava a config cifrada na tabela `configuracoes` (uso administrativo). O
 * segredo entra em claro e sai CIFRADO; a resposta nunca devolve o valor.
 */
export async function salvarConfigGithubApp(cfg: GithubAppConfig, atualizadoPor: string): Promise<void> {
  const payload = {
    app_id: cfg.appId,
    installation_id: cfg.installationId,
    private_key: pareceCifrado(cfg.privateKey) ? cfg.privateKey : cifrarSegredo(cfg.privateKey),
    webhook_secret: cfg.webhookSecret ? (pareceCifrado(cfg.webhookSecret) ? cfg.webhookSecret : cifrarSegredo(cfg.webhookSecret)) : null,
  };
  await gravarConfig(CHAVE_CONFIG, JSON.stringify(payload), atualizadoPor);
}
