// GitHub App: ambiente tem precedência; registro legado cifrado continua legível.
// Nunca registrar valores, exceções de criptografia ou conteúdo do banco.
import { createPrivateKey } from 'node:crypto';
import { lerConfigEstrita, gravarConfig } from '../../../server/src/configuracoes';
import { cifrarSegredo, decifrarSegredo, pareceCifrado } from '../../../server/src/segredos';

export type GithubAppConfig = { appId: string; installationId: string; privateKey: string; webhookSecret: string | null };
export type DiagnosticoGithubApp = {
  fonte: 'ambiente' | 'banco' | 'nenhuma';
  ambiente: 'valido' | 'ausente' | 'vazio' | 'incompleto' | 'id_invalido' | 'pem_invalido';
  banco: 'nao_consultado' | 'valido' | 'registro_inexistente' | 'leitura_falhou' | 'json_invalido' | 'incompleto' | 'id_invalido' | 'descriptografia_falhou' | 'pem_invalido';
};
const CHAVE_CONFIG = 'operational_github_app';

/** Aceita PEM em múltiplas linhas ou com quebras escapadas, mas valida RSA de verdade. */
function normalizarPem(bruto: string): string | null {
  const s = String(bruto ?? '').replace(/\\n/g, '\n').trim();
  try {
    const chave = createPrivateKey(s);
    return chave.asymmetricKeyType === 'rsa' && (chave.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048 ? s : null;
  } catch { return null; }
}
const idValido = (s: string) => /^[1-9]\d*$/.test(s);

type Resultado = { config: GithubAppConfig | null; diagnostico: DiagnosticoGithubApp };
/** Diagnóstico de códigos fixos: nunca contém valores de configuração nem exceções. */
export async function resolverConfigGithubApp(): Promise<Resultado> {
  const nomes = ['GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY'] as const;
  const valores = nomes.map((n) => process.env[n]);
  let ambiente: DiagnosticoGithubApp['ambiente'];
  if (valores.every((v) => v === undefined)) ambiente = 'ausente';
  else if (valores.some((v) => v !== undefined && !v.trim())) ambiente = 'vazio';
  else if (valores.some((v) => v === undefined)) ambiente = 'incompleto';
  else if (!idValido(valores[0]!.trim()) || !idValido(valores[1]!.trim())) ambiente = 'id_invalido';
  else if (!normalizarPem(valores[2]!)) ambiente = 'pem_invalido';
  else {
    const config = { appId: valores[0]!.trim(), installationId: valores[1]!.trim(), privateKey: normalizarPem(valores[2]!)!, webhookSecret: String(process.env.GITHUB_WEBHOOK_SECRET ?? '').trim() || null };
    return { config, diagnostico: { fonte: 'ambiente', ambiente: 'valido', banco: 'nao_consultado' } };
  }
  const falha = (banco: DiagnosticoGithubApp['banco']): Resultado => ({ config: null, diagnostico: { fonte: 'nenhuma', ambiente, banco } });
  let bruto: string | null;
  try { bruto = await lerConfigEstrita(CHAVE_CONFIG); } catch { return falha('leitura_falhou'); }
  if (bruto === null) return falha('registro_inexistente');
  let parsed: Record<string, unknown>;
  try {
    const valor: unknown = JSON.parse(bruto);
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return falha('json_invalido');
    parsed = valor as Record<string, unknown>;
  } catch { return falha('json_invalido'); }
  const textoId = (valor: unknown) => typeof valor === 'string' || typeof valor === 'number' ? String(valor).trim() : '';
  const appId = textoId(parsed.app_id);
  const installationId = textoId(parsed.installation_id);
  if (!appId || !installationId || typeof parsed.private_key !== 'string' || !parsed.private_key) return falha('incompleto');
  if (!idValido(appId) || !idValido(installationId)) return falha('id_invalido');
  const privada = decifrarSegredo(parsed.private_key);
  if (!privada) return falha('descriptografia_falhou');
  const privateKey = normalizarPem(privada);
  if (!privateKey) return falha('pem_invalido');
  // Webhook é opcional: não descartar uma App válida por falha secundária.
  const webhookSecret = typeof parsed.webhook_secret === 'string' ? decifrarSegredo(parsed.webhook_secret) : null;
  return { config: { appId, installationId, privateKey, webhookSecret }, diagnostico: { fonte: 'banco', ambiente, banco: 'valido' } };
}
export async function obterConfigGithubApp(): Promise<GithubAppConfig | null> { return (await resolverConfigGithubApp()).config; }
export async function githubAppConfigurada(): Promise<boolean> { return (await obterConfigGithubApp()) !== null; }

/** Compatibilidade com o formato legado. Sem rota de escrita: ambiente é o meio operacional.
 * Não chamar em produção sem procedimento autorizado de preservação dos dados. */
export async function salvarConfigGithubApp(cfg: GithubAppConfig, atualizadoPor: string): Promise<void> {
  const payload = { app_id: cfg.appId, installation_id: cfg.installationId,
    private_key: pareceCifrado(cfg.privateKey) ? cfg.privateKey : cifrarSegredo(cfg.privateKey),
    webhook_secret: cfg.webhookSecret ? (pareceCifrado(cfg.webhookSecret) ? cfg.webhookSecret : cifrarSegredo(cfg.webhookSecret)) : null };
  await gravarConfig(CHAVE_CONFIG, JSON.stringify(payload), atualizadoPor);
}
