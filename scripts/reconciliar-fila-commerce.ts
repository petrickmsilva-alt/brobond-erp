#!/usr/bin/env node
// ============================================================================
// RECONCILIAÇÃO DA FILA DO COMMERCE — operação controlada (PR #129).
//
// Reclassifica a fila de NOTIFICAÇÃO do commerce contra a verdade canônica
// (pedido/pagamento), sem apagar histórico e sem tocar em dinheiro/estoque:
//
//   • aviso BLOQUEADO cujo pedido já foi CANCELADO/EXPIRADO/ESTORNADO
//     (ou cuja cobrança já foi resolvida) → OBSOLETO (motivo/data/responsável);
//   • aviso ERRO causado SÓ por falta de configuração (SMTP/WhatsApp ausente)
//     → BLOQUEADO (pendência de configuração, não falha técnica);
//   • aviso BLOQUEADO com o provedor JÁ configurado → PENDENTE (envio liberado).
//
// NÃO encerra evento de conversão/publicação/estoque: só eventos de notificação
// (`payload.acao='notificacao'`). NÃO apaga linha. Idempotente.
//
// Uso (Render Shell, dentro do repo):
//   # 1) conferência (NÃO altera nada; transação com ROLLBACK):
//   DATABASE_URL=... node --import tsx scripts/reconciliar-fila-commerce.ts --empresas=1
//
//   # 2) execução real (exige confirmação explícita):
//   DATABASE_URL=... node --import tsx scripts/reconciliar-fila-commerce.ts \
//       --empresas=1 --executar --confirm=RECONCILIAR-FILA --ator="Diretor"
//
// Sem `--empresas`, varre TODAS as empresas ativas (o relatório mostra o recorte
// por empresa). A escrita é auditada (tabela de auditoria) em cada alteração.
// ============================================================================
import { pool, migrate } from '../server/src/db';
import { getStore } from '../server/src/services';
import { getResource } from '../server/src/resources';
import { reconciliarFilaCommerce, type ResultadoReconciliacaoFila } from '../server/src/commerce/outbox';

function arg(nome: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return p ? p.slice(nome.length + 3) : undefined;
}
const tem = (nome: string) => process.argv.includes(`--${nome}`);

const CONFIRMACAO = 'RECONCILIAR-FILA';
const ator = arg('ator') ?? process.env.USER ?? 'operador';
const modo = tem('executar') ? 'executar' : 'dry-run';
const empresasArg = (arg('empresas') ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);

/** Marcador interno para abortar a transação do dry-run (rollback garantido). */
class RollbackDryRun extends Error {
  constructor(readonly resultado: ResultadoReconciliacaoFila) {
    super('dry-run');
  }
}

async function empresasAlvo(): Promise<number[]> {
  if (empresasArg.length) return empresasArg;
  const s = getStore();
  const lista = await s.list(getResource('empresas')!, { page: 1, pageSize: 10_000 });
  return lista.rows.filter((e) => e.ativo !== false).map((e) => Number(e.id));
}

async function main() {
  if (!pool) {
    console.error('Reconciliação exige DATABASE_URL PostgreSQL.');
    process.exit(2);
  }
  if (modo === 'executar' && arg('confirm') !== CONFIRMACAO) {
    console.error(`Execução exige --confirm=${CONFIRMACAO}.`);
    process.exit(2);
  }

  await migrate(); // conecta e garante a cadeia aplicada antes de qualquer leitura/escrita
  const s = getStore();
  const empresas = await empresasAlvo();
  if (!empresas.length) {
    console.error('Nenhuma empresa alvo (use --empresas=<id[,id]>).');
    process.exit(2);
  }

  console.log(`▶ RECONCILIAÇÃO DA FILA DO COMMERCE — modo=${modo} ator=${ator}`);
  console.log(`  empresas: [${empresas.join(', ')}]`);
  console.log('  (não apaga histórico; não toca em pedido, venda, pagamento ou estoque)');

  let totalObsoletos = 0;
  let totalReclassificados = 0;
  let totalReenfileirados = 0;
  let totalMantidos = 0;

  for (const empresa of empresas) {
    let resultado: ResultadoReconciliacaoFila;
    try {
      resultado = await s.transaction(async (tx) => {
        const r = await reconciliarFilaCommerce(empresa, { id: null, name: ator }, tx);
        // Dry-run: desfaz tudo (o rollback acontece no throw da transação).
        if (modo === 'dry-run') throw new RollbackDryRun(r);
        return r;
      });
    } catch (e) {
      if (e instanceof RollbackDryRun) resultado = e.resultado;
      else throw e;
    }

    totalObsoletos += resultado.obsoletos;
    totalReclassificados += resultado.reclassificados;
    totalReenfileirados += resultado.reenfileirados;
    totalMantidos += resultado.mantidos;

    console.log(`\n── EMPRESA ${empresa} ─────────────────────────────────────────`);
    console.log(`  examinados: ${resultado.examinados} | obsoletos: ${resultado.obsoletos} | reclassificados: ${resultado.reclassificados} | reenfileirados: ${resultado.reenfileirados} | mantidos: ${resultado.mantidos}`);
    for (const d of resultado.detalhes) {
      console.log(`   #${d.id} ${d.de} → ${d.para}  ${d.chave}`);
      console.log(`        ${d.motivo}`);
    }
  }

  console.log(`\n── TOTAL ────────────────────────────────────────────────────`);
  console.log(`  obsoletos: ${totalObsoletos} | reclassificados: ${totalReclassificados} | reenfileirados: ${totalReenfileirados} | mantidos: ${totalMantidos}`);
  if (modo === 'dry-run') {
    console.log('✔ DRY-RUN concluído — NADA foi alterado (ROLLBACK). Revise a lista acima e repita com --executar --confirm=' + CONFIRMACAO + '.');
  } else {
    console.log('✔ EXECUÇÃO concluída. Cada alteração foi registrada na auditoria.');
  }
  await pool.end().catch(() => undefined);
}

main().catch(async (e) => {
  console.error('RECONCILIAÇÃO FALHOU:', e?.message ?? e);
  await pool?.end().catch(() => undefined);
  process.exit(1);
});
