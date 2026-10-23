// ============================================================================
// Configuração local do agente.
//
// Arquivos (em `dir`, padrão: pasta de dados do usuário — ver defaultDir):
//   • agent-config.json  — configuração não secreta (URL do ERP, machine id,
//     terminal, polling, impressora padrão);
//   • machine-token      — SÓ o token de máquina, arquivo separado com
//     permissão restrita (0600 onde o FS suporta). Nunca é logado.
//
// Variáveis de ambiente sobrescrevem o arquivo (útil para testes/serviço):
//   BROBOND_ERP_URL, BROBOND_PRINT_TOKEN, BROBOND_PRINT_MACHINE_ID,
//   BROBOND_PRINT_TERMINAL, BROBOND_PRINT_DIR, BROBOND_PRINT_DRY_RUN,
//   BROBOND_PRINT_POLL_MS, BROBOND_PRINT_PORT, BROBOND_PRINT_PRINTER,
//   BROBOND_ERP_ORIGIN (origem do ERP aceita pela API local).
//
// Hardening futuro (documentado, fora da P1): no Windows, migrar o token
// para DPAPI/Credential Manager. Hoje a mitigação é: arquivo restrito ao
// usuário + token REVOGÁVEL e rotacionável no ERP + hash-only no servidor.
// ============================================================================
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AgentConfig = {
  dir: string;
  erpUrl: string;
  erpOrigin: string | null;
  machineId: string | null;
  terminal: string | null;
  nome: string | null;
  pollMs: number;
  heartbeatMs: number;
  localPort: number;
  dryRun: boolean;
  printerDefault: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
};

export function defaultDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BROBOND_PRINT_DIR) return env.BROBOND_PRINT_DIR;
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || homedir(), 'BroBond', 'PrintAgent');
  return join(homedir(), '.brobond', 'print-agent');
}

const CONFIG_FILE = 'agent-config.json';
const TOKEN_FILE = 'machine-token';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const dir = defaultDir(env);
  let file: Record<string, unknown> = {};
  const cfgPath = join(dir, CONFIG_FILE);
  if (existsSync(cfgPath)) {
    try { file = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { file = {}; }
  }
  const erpUrl = (env.BROBOND_ERP_URL || String(file.erpUrl || 'http://localhost:3001')).replace(/\/+$/, '');
  let erpOrigin: string | null = env.BROBOND_ERP_ORIGIN || (file.erpOrigin as string) || null;
  if (!erpOrigin) {
    try { erpOrigin = new URL(erpUrl).origin; } catch { erpOrigin = null; }
  }
  return {
    dir,
    erpUrl,
    erpOrigin,
    machineId: env.BROBOND_PRINT_MACHINE_ID || (file.machineId as string) || null,
    terminal: env.BROBOND_PRINT_TERMINAL || (file.terminal as string) || null,
    nome: (file.nome as string) || null,
    pollMs: Number(env.BROBOND_PRINT_POLL_MS || file.pollMs || 3000),
    heartbeatMs: Number(file.heartbeatMs || 30_000),
    localPort: Number(env.BROBOND_PRINT_PORT || file.localPort || 17831),
    // Dry-run é o PADRÃO até os renderers físicos (P2/P4): o job é
    // "impresso" em arquivo no outbox, nunca numa impressora real por engano.
    dryRun: env.BROBOND_PRINT_DRY_RUN ? env.BROBOND_PRINT_DRY_RUN !== '0' : file.dryRun !== false,
    printerDefault: env.BROBOND_PRINT_PRINTER || (file.printerDefault as string) || null,
    logLevel: (env.BROBOND_PRINT_LOG as AgentConfig['logLevel']) || (file.logLevel as AgentConfig['logLevel']) || 'info',
  };
}

export function saveConfig(cfg: AgentConfig): void {
  mkdirSync(cfg.dir, { recursive: true });
  const { dir: _dir, ...rest } = cfg;
  writeFileSync(join(cfg.dir, CONFIG_FILE), JSON.stringify(rest, null, 2), 'utf8');
}

export function loadToken(cfg: AgentConfig, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.BROBOND_PRINT_TOKEN) return env.BROBOND_PRINT_TOKEN;
  const p = join(cfg.dir, TOKEN_FILE);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8').trim() || null;
}

export function saveToken(cfg: AgentConfig, token: string): void {
  mkdirSync(cfg.dir, { recursive: true });
  // mode 0600: só o dono lê (POSIX). No Windows, a pasta em %LOCALAPPDATA%
  // já nasce restrita ao usuário; DPAPI é o hardening planejado.
  writeFileSync(join(cfg.dir, TOKEN_FILE), token, { encoding: 'utf8', mode: 0o600 });
}
