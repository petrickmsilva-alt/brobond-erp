#!/usr/bin/env node
// ============================================================================
// SANEAMENTO PRÉ-GO-LIVE — rotina controlada de limpeza de dados de teste.
//
// Uso:
//   # 1) conferência (NÃO altera nada; transação com ROLLBACK):
//   DATABASE_URL=... node --import tsx scripts/saneamento-go-live.ts --empresas=1
//
//   # 2) execução real (exige backup verificado + confirmação):
//   DATABASE_URL=... node --import tsx scripts/saneamento-go-live.ts \
//       --empresas=1 --executar --confirm=LIMPAR-HOMOLOGACAO \
//       --backup=/caminho/backup-2026-11-10.sql --ator="Diretor"
//
// O que ele NUNCA faz: apagar cadastros, estoque físico, preços, empresas,
// usuários, plano de contas ou estrutura financeira; reenfileirar eventos;
// chamar provedores externos; transmitir documentos fiscais.
//
// O backup NUNCA é gravado no repositório Git (use caminho fora da árvore).
// ============================================================================
import { existsSync, statSync } from 'node:fs';
import { pool } from '../server/src/db';
import {
  CONFIRMACAO_EXECUCAO,
  PLANO,
  TABELAS_PROTEGIDAS,
  compararEstoque,
  executarSaneamento,
  totalFisico,
  type LinhaEstoque,
} from '../server/src/ops/saneamento';

function arg(nome: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return p ? p.slice(nome.length + 3) : undefined;
}
const tem = (nome: string) => process.argv.includes(`--${nome}`);

const empresas = (arg('empresas') ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const modo = tem('executar') ? 'executar' : 'dry-run';
const ator = arg('ator') ?? process.env.USER ?? 'operador';

function imprimirEstoque(titulo: string, foto: LinhaEstoque[]) {
  const porEmpresa = new Map<number | null, number>();
  for (const l of foto) porEmpresa.set(l.empresa_id, (porEmpresa.get(l.empresa_id) ?? 0) + l.quantidade_fisica);
  const reservado = foto.reduce((s, l) => s + l.reservado, 0);
  const valor = foto.reduce((s, l) => s + (l.valor_total ?? 0), 0);
  console.log(`\n── ESTOQUE FÍSICO (${titulo}) ───────────────────────────────`);
  console.log(`  células (SKU×variante×local): ${foto.length}`);
  console.log(`  total de peças físicas:       ${totalFisico(foto)}`);
  console.log(`  reservado (teste):            ${reservado}`);
  console.log(`  valorização (custo×qtd):      ${valor.toFixed(2)}`);
  for (const [emp, qtd] of [...porEmpresa.entries()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))) {
    console.log(`    empresa ${emp ?? '—'}: ${qtd} peça(s)`);
  }
}

async function main() {
  if (!pool) {
    console.error('Saneamento exige DATABASE_URL PostgreSQL.');
    process.exit(2);
  }
  if (!empresas.length) {
    console.error('Informe --empresas=<id[,id]> (o saneamento nunca é global por omissão).');
    process.exit(2);
  }

  console.log(`▶ SANEAMENTO PRÉ-GO-LIVE — modo=${modo} empresas=[${empresas.join(', ')}] ator=${ator}`);
  console.log('  (o estoque físico é a única posição operacional preservada)');

  if (modo === 'executar') {
    if (arg('confirm') !== CONFIRMACAO_EXECUCAO) {
      console.error(`Execução exige --confirm=${CONFIRMACAO_EXECUCAO}.`);
      process.exit(2);
    }
    const backup = arg('backup');
    if (!backup || !existsSync(backup)) {
      console.error('Execução exige --backup=<arquivo> existente e recuperável (Fase Zero). Sem backup, sem exclusão.');
      process.exit(2);
    }
    const st = statSync(backup);
    if (st.size < 1024) {
      console.error(`Backup suspeito (${st.size} bytes). Gere um dump íntegro antes de executar.`);
      process.exit(2);
    }
    console.log(`  backup verificado: ${backup} (${st.size} bytes, ${st.mtime.toISOString()})`);
  }

  const resultado = await executarSaneamento(pool, {
    empresaIds: empresas,
    modo,
    confirmacao: arg('confirm'),
    ator,
  });
  const antes = resultado.estoqueAntes;
  imprimirEstoque('ANTES', antes);

  console.log(`\n── PASSOS EXECUTADOS (${resultado.passos.length}) ─────────────────────────`);
  for (const p of resultado.passos) console.log(`  ${String(p.removidos).padStart(7)}  ${p.tabela.padEnd(30)} ${p.descricao}`);
  console.log(`  TOTAL removido: ${resultado.totalRemovido} linha(s)`);

  imprimirEstoque(modo === 'executar' ? 'DEPOIS' : 'DEPOIS (rollback do dry-run)', resultado.estoqueDepois);

  const divergencias = compararEstoque(antes, resultado.estoqueDepois);
  if (divergencias.length) {
    console.error('\n✖ DIVERGÊNCIA DE ESTOQUE — homologação interrompida:');
    for (const d of divergencias) console.error(`   ${d.sku ?? d.chave}: ${d.antes} → ${d.depois}`);
    process.exit(1);
  }
  console.log(`\n✔ Estoque físico PRESERVADO (${totalFisico(antes)} peças; ${resultado.estoqueAntes.length} células).`);
  console.log(`✔ Tabelas protegidas intactas: ${TABELAS_PROTEGIDAS.join(', ')}`);
  if (modo === 'dry-run') {
    console.log('✔ DRY-RUN concluído — NADA foi alterado (ROLLBACK). Repita com --executar após o backup.');
  } else {
    console.log(`✔ EXECUÇÃO concluída. Auditoria id=${resultado.auditoriaId}.`);
  }
  await pool.end().catch(() => undefined);
}

main().catch(async (e) => {
  console.error('SANEAMENTO FALHOU:', e?.message ?? e);
  await pool?.end().catch(() => undefined);
  process.exit(1);
});
