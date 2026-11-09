// ============================================================================
// BROBOND ERP 3.0 — EXECUTOR DE TESTES OBRIGATÓRIOS DO GATE (módulo compartilhado)
// ----------------------------------------------------------------------------
// Motivação (achado TEST-01): o gate `go-live:audit` verificava a ESTRUTURA
// (arquivo de teste existe? módulo canônico existe?) mas NUNCA executava os
// testes de AUTORIZAÇÃO HTTP. Um P1 real — `checkAccess(alert_events,'update')`
// contra `ops.update=false` (HTTP 405 para todo ator) — passava com P0/P1/P2=0,
// porque "existe arquivo de teste" era tratado como evidência suficiente.
//
// Este módulo EXECUTA os testes obrigatórios pelo runner REAL e classifica o
// resultado em: aprovado, falho, ignorado e NÃO EXECUTADO. Regra dura:
//
//   • `fail > 0`          → reprovado (bloqueia o gate);
//   • nenhum teste rodou   → NÃO EXECUTADO → reprovado (falta de evidência NÃO
//                            é aprovação — exatamente o defeito que o gate tinha);
//   • `skipped` é contado à parte e NUNCA somado aos aprovados;
//   • erro de spawn/timeout → reprovado.
// ============================================================================
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Nomes das suítes que o gate exige como evidência de autorização/tenant. */
export const TESTES_OBRIGATORIOS_AUTORIZACAO = [
  'server/test/aud-01-alertas-transicoes-http.test.ts',
  'server/test/sec-01-carteira-customer-platform-http.test.ts',
];

/** Resumo de uma execução do runner. */
function parseTap(saida) {
  const num = (re) => {
    const m = saida.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    tests: num(/^# tests (\d+)/m) ?? num(/^# pass (\d+)/m),
    pass: num(/^# pass (\d+)/m),
    fail: num(/^# fail (\d+)/m),
    skipped: num(/^# skipped (\d+)/m) ?? num(/^# todo (\d+)/m),
  };
}

/**
 * Executa um conjunto de arquivos de teste pelo runner do Node e devolve o
 * resultado classificado. Nunca lança: falha de spawn vira `ok:false`.
 */
export function executarTestes(raiz, arquivos, { timeoutMs = 120_000 } = {}) {
  const ausentes = arquivos.filter((f) => !existsSync(path.join(raiz, f)));
  const presentes = arquivos.filter((f) => existsSync(path.join(raiz, f)));
  const base = { pass: 0, fail: 0, skipped: 0, tests: 0, naoExecutados: ausentes, arquivosComFalha: [], saida: '' };
  if (!presentes.length) {
    return { ok: false, ...base, motivo: 'nenhum arquivo de teste obrigatório existe' };
  }
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-reporter=tap', ...presentes],
    { cwd: raiz, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, DATABASE_URL: '' } }
  );
  const saida = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const resumo = parseTap(saida);
  const arquivosComFalha = [...saida.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());

  // "não executado": o runner não emitiu resumo algum (crash/timeout) ou zero
  // testes rodaram. Isso NÃO pode virar aprovação.
  const rodouAlgo = resumo.tests !== null && resumo.tests > 0;
  const naoExecutados = [...ausentes];
  if (!rodouAlgo) naoExecutados.push(...presentes);

  const resultado = {
    ...base,
    pass: resumo.pass ?? 0,
    fail: resumo.fail ?? 0,
    skipped: resumo.skipped ?? 0,
    tests: resumo.tests ?? 0,
    naoExecutados,
    arquivosComFalha,
    saida,
  };

  if (!rodouAlgo) {
    return { ok: false, ...resultado, motivo: `nenhum teste foi executado (status do runner: ${r.status})` };
  }
  if (resultado.fail > 0) {
    return { ok: false, ...resultado, motivo: `${resultado.fail} teste(s) obrigatório(s) falharam` };
  }
  if (r.status !== 0) {
    return { ok: false, ...resultado, motivo: `runner encerrou com status ${r.status}` };
  }
  return { ok: true, ...resultado, motivo: 'todos os testes obrigatórios passaram' };
}

/** Conveniência: roda a suíte de autorização obrigatória do gate. */
export function executarTestesObrigatorios(raiz, opts = {}) {
  return executarTestes(raiz, TESTES_OBRIGATORIOS_AUTORIZACAO, opts);
}
