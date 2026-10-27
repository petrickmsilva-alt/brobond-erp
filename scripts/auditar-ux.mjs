#!/usr/bin/env node
// ============================================================================
// `npm run audit:ux` — GATE DE ARQUITETURA DE UX DO BROBOND ERP 3.0
// ----------------------------------------------------------------------------
// Regra de produto: ZERO MODAL. O ERP padroniza
//
//     LISTA → DETALHE → NOVO (/recurso/novo) → EDIÇÃO (/recurso/:id/editar)
//
// Este gate FALHA (exit 1) quando alguém reintroduz modal/dialog/drawer/sheet
// ou qualquer overlay fixo em fluxo de módulo. Rode em CI junto de
// `architecture:audit` e `audit:menu`.
//
// Uso:
//   node scripts/auditar-ux.mjs           # relatório + gate
//   node scripts/auditar-ux.mjs --json    # saída legível por máquina
// ============================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditarUx, EXCECOES } from './ux-guard.mjs';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { ok, violacoes, resumo } = auditarUx(raiz);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok, violacoes, resumo, excecoes: EXCECOES }, null, 2));
  process.exit(ok ? 0 : 1);
}

console.log('BROBOND ERP 3.0 — AUDITORIA DE UX (ZERO MODAL)\n');
console.log(`Assinaturas de sobreposição encontradas: ${resumo.length}`);
if (resumo.length) {
  for (const r of resumo) console.log(`  · ${r.arquivo} — ${r.qtd}× ${r.padrao}`);
}
console.log(`\nExceções declaradas (não são fluxo de módulo): ${EXCECOES.length}`);
for (const e of EXCECOES) console.log(`  · ${e.arquivo} — ${e.motivo}`);

if (!ok) {
  console.error(`\nFALHOU: ${violacoes.length} violação(ões) da regra ZERO MODAL:`);
  for (const v of violacoes) console.error(`  ✗ ${v}`);
  console.error('\nCorrija usando PÁGINA (pages/RegistroPage.tsx), ConfirmacaoInline ou PainelInline.');
  process.exit(1);
}

console.log('\nOK — nenhum modal/drawer/sheet em fluxo de módulo. LISTA → PÁGINA garantido.');
