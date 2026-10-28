#!/usr/bin/env node
// ============================================================================
// `npm run audit:ux` — GATE DE ARQUITETURA DE UX DO BROBOND ERP 3.0
// ----------------------------------------------------------------------------
// Regra de produto: ZERO MODAL. O ERP padroniza
//
//     LISTA → DETALHE → NOVO (/recurso/novo) → EDIÇÃO (/recurso/:id/editar)
//
// O baseline objetivo (exceções justificadas) vive em
// `docs/ERP-3.0-UX-BASELINE.json`. Este gate FALHA (exit 1) quando aparece
// QUALQUER ocorrência nova acima do baseline — inclusive dentro de um arquivo
// que já tem exceção. Rode em CI junto de `architecture:audit` e `audit:menu`.
//
// Uso:
//   node scripts/auditar-ux.mjs           # relatório + gate
//   node scripts/auditar-ux.mjs --json    # saída legível por máquina
// ============================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditarUx, CAMINHO_BASELINE } from './ux-guard.mjs';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { ok, violacoes, resumo, excecoes, totais, avisos } = auditarUx(raiz);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok, violacoes, resumo, excecoes, totais, avisos }, null, 2));
  process.exit(ok ? 0 : 1);
}

console.log('BROBOND ERP 3.0 — AUDITORIA DE UX (ZERO MODAL)\n');
console.log(`Baseline: ${CAMINHO_BASELINE}`);
console.log(`Assinaturas de sobreposição encontradas: ${resumo.length}`);
if (resumo.length) {
  for (const r of resumo) console.log(`  · ${r.arquivo} — ${r.qtd}× ${r.padrao}`);
}
console.log(`\nTotais medidos por assinatura: ${Object.entries(totais).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
console.log(`\nExceções declaradas no baseline (não são fluxo de módulo): ${excecoes.length}`);
for (const e of excecoes) console.log(`  · [${e.categoria}] ${e.arquivo} — ${e.motivo}`);

if (avisos.length) {
  console.log('\nAvisos (não bloqueiam):');
  for (const a of avisos) console.log(`  ! ${a}`);
}

if (!ok) {
  console.error(`\nFALHOU: ${violacoes.length} violação(ões) da regra ZERO MODAL:`);
  for (const v of violacoes) console.error(`  ✗ ${v}`);
  console.error('\nCorrija usando PÁGINA (pages/RegistroPage.tsx), ConfirmacaoInline ou PainelInline.');
  console.error(`Exceção legítima? Edite ${CAMINHO_BASELINE} de propósito, com categoria e motivo.`);
  process.exit(1);
}

console.log('\nOK — nenhuma sobreposição nova em fluxo de módulo. LISTA → PÁGINA garantido.');
