#!/usr/bin/env node
// ============================================================================
// Cliente de execução de UM processo de cron (Ordem Final, 2.1).
//
// Uso (pelo agendador externo):
//   BROBOND_BASE_URL=https://<host-do-erp> CRON_SECRET=<segredo> node scripts/cron-processo.mjs <processo>
//
// Processos: relatorios | pagamentos | publicacoes | pedidos | crm
// (recorrências financeiras NÃO são processo de cron.)
//
// Política (ver docs/operacao/cinco-jobs-cron.md):
//   • Chama POST /api/admin/scheduled/cron/<processo> com Authorization: Bearer <CRON_SECRET>.
//   • Timeout do cliente = timeout do servidor do processo + margem (CRON_CLIENT_TIMEOUT_MS sobrescreve).
//   • Retenta somente falhas transitórias: timeout, erro de rede, 503 com motivo (timeout | erro).
//     Máximo CRON_MAX_TENTATIVAS (padrão 3, entre 1 e 5). Espera: CRON_BACKOFF_MS × 5^(n-1), teto 600 s.
//   • Não retenta 401, 404, 503 sem motivo (ex.: CRON_SECRET ausente no servidor).
//   • 409 (já em execução) não é falha: encerra com 0 e registra "ignorado_concorrente".
//   • Códigos de saída: 0 sucesso ou ignorado; 1 falha; 2 configuração inválida (sem chamada).
//   • Nunca imprime o segredo, cabeçalhos nem o corpo bruto da resposta.
// ============================================================================

import { pathToFileURL } from 'node:url';

const PROCESSOS = ['relatorios', 'pagamentos', 'publicacoes', 'pedidos', 'crm'];
// Espelha TIMEOUT_PADRAO_MS do servidor (server/src/scheduled.ts) com margem de 60 s.
const TIMEOUT_CLIENTE_PADRAO_MS = {
  relatorios: 360_000,
  pagamentos: 300_000,
  publicacoes: 360_000,
  pedidos: 300_000,
  crm: 180_000,
};

function log(evento, dados = {}) {
  // Linha JSON sem segredos: só metadados operacionais.
  process.stdout.write(JSON.stringify({ evento, ...dados, em: new Date().toISOString() }) + '\n');
}

function inteiroEntre(valor, minimo, maximo, padrao) {
  if (valor === undefined || valor === '') return padrao;
  if (!/^\d+$/.test(String(valor).trim())) return null;
  const n = Number(String(valor).trim());
  return n >= minimo && n <= maximo ? n : null;
}

export function configurar(env, argv) {
  const processo = argv[0];
  if (!processo || !PROCESSOS.includes(processo)) {
    return { erro: `processo inválido: use um de ${PROCESSOS.join(', ')}` };
  }
  const segredo = String(env.CRON_SECRET || '').trim();
  if (!segredo) return { erro: 'CRON_SECRET ausente no ambiente do agendador' };
  let base;
  try { base = new URL(String(env.BROBOND_BASE_URL || '')); } catch { return { erro: 'BROBOND_BASE_URL ausente ou inválida' }; }
  const local = base.hostname === '127.0.0.1' || base.hostname === 'localhost';
  if (base.protocol !== 'https:' && !(local && base.protocol === 'http:')) {
    return { erro: 'BROBOND_BASE_URL deve usar https (http só para localhost)' };
  }
  const maxTentativas = inteiroEntre(env.CRON_MAX_TENTATIVAS, 1, 5, 3);
  const backoffMs = inteiroEntre(env.CRON_BACKOFF_MS, 0, 3_600_000, 60_000);
  const timeoutMs = inteiroEntre(env.CRON_CLIENT_TIMEOUT_MS, 5_000, 1_800_000, TIMEOUT_CLIENTE_PADRAO_MS[processo]);
  if (maxTentativas === null || backoffMs === null || timeoutMs === null) {
    return { erro: 'CRON_MAX_TENTATIVAS, CRON_BACKOFF_MS ou CRON_CLIENT_TIMEOUT_MS fora do intervalo permitido' };
  }
  const url = new URL(`/api/admin/scheduled/cron/${processo}`, base);
  return { processo, segredo, url: url.toString(), maxTentativas, backoffMs, timeoutMs };
}

async function tentarUma(cfg) {
  let resp;
  try {
    resp = await fetch(cfg.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.segredo}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    return { transitoria: true, motivo: e?.name === 'TimeoutError' ? 'timeout_cliente' : 'erro_de_rede' };
  }
  let corpo = {};
  try { corpo = await resp.json(); } catch { corpo = {}; }
  const status = resp.status;
  if (status === 200 && corpo.ok === true) return { sucesso: true, status, itens: Number(corpo.itens) || 0 };
  if (status === 409) return { ignorado: true, status };
  if (status === 503 && (corpo.motivo === 'timeout' || corpo.motivo === 'erro')) {
    return { transitoria: true, status, motivo: corpo.motivo };
  }
  return { falha: true, status, motivo: status === 503 ? 'servidor_indisponivel_permanente' : 'recusado' };
}

export async function executarCron(cfg) {
  for (let n = 1; n <= cfg.maxTentativas; n++) {
    const r = await tentarUma(cfg);
    if (r.sucesso) {
      log('cron_cliente_sucesso', { processo: cfg.processo, tentativa: n, status: r.status, itens: r.itens });
      return 0;
    }
    if (r.ignorado) {
      log('cron_cliente_ignorado_concorrente', { processo: cfg.processo, tentativa: n, status: r.status });
      return 0;
    }
    if (r.falha) {
      log('cron_cliente_falha', { processo: cfg.processo, tentativa: n, status: r.status, motivo: r.motivo, retentativa: false });
      return 1;
    }
    const restam = cfg.maxTentativas - n;
    log('cron_cliente_transitoria', { processo: cfg.processo, tentativa: n, status: r.status ?? null, motivo: r.motivo, proxima_em_ms: restam > 0 ? esperaMs(cfg, n) : null });
    if (restam > 0) await new Promise((res) => setTimeout(res, esperaMs(cfg, n)));
  }
  log('cron_cliente_falha', { processo: cfg.processo, tentativas_esgotadas: cfg.maxTentativas, retentativa: false });
  return 1;
}

function esperaMs(cfg, n) {
  return Math.min(cfg.backoffMs * 5 ** (n - 1), 600_000);
}

// Execução direta (não quando importado).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = configurar(process.env, process.argv.slice(2));
  if (cfg.erro) {
    log('cron_cliente_configuracao_invalida', { motivo: cfg.erro });
    process.exitCode = 2;
  } else {
    process.exitCode = await executarCron(cfg);
  }
}
