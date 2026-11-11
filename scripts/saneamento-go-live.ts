#!/usr/bin/env node
// ============================================================================
// SANEAMENTO PRÉ-GO-LIVE — rotina controlada de limpeza de dados de teste.
//
// Uso:
//   # 1) conferência (NÃO altera nada; transação com ROLLBACK):
//   DATABASE_URL=... node --import tsx scripts/saneamento-go-live.ts --empresas=1
//
//   # 2) execução real (exige backup VERIFICADO + confirmação):
//   DATABASE_URL=... node --import tsx scripts/saneamento-go-live.ts \
//       --empresas=1 --executar --confirm=LIMPAR-HOMOLOGACAO \
//       --backup=/caminho/backup.dump --manifesto=/caminho/backup.json \
//       --ator="Diretor"
//
// O backup é provado RECUPERÁVEL: o manifesto traz o sha256 e a contagem por
// tabela, o arquivo é restaurado num banco DESCARTÁVEL e as contagens são
// comparadas. Tamanho do arquivo NÃO é prova.
//
// O que ele NUNCA faz: apagar cadastros, estoque físico, preços, empresas,
// usuários, plano de contas ou estrutura financeira; reenfileirar eventos;
// chamar provedores externos; transmitir documentos fiscais.
//
// O backup NUNCA é gravado no repositório Git (use caminho fora da árvore).
// ============================================================================
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pool } from '../server/src/db';
import {
  CONFIRMACAO_EXECUCAO,
  PLANO,
  TABELAS_PROTEGIDAS,
  executarSaneamento,
  relatorioPorSku,
  totalFisico,
  type LinhaEstoque,
  type RelatorioSku,
} from '../server/src/ops/saneamento';
import {
  gerarDump,
  identificacaoOrigem,
  inventarioDe,
  verificarComRestauracao,
  type ManifestoBackup,
} from '../server/src/ops/backup-verificacao';

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

function imprimirRelatorioSku(linhas: RelatorioSku[]) {
  console.log(`\n── RELATÓRIO POR SKU (${linhas.length} SKU(s), posição física final) ─────────`);
  console.log('  ' + 'SKU'.padEnd(26) + 'células'.padStart(8) + 'peças'.padStart(10) + 'custo'.padStart(10) + 'valor'.padStart(12));
  for (const l of linhas) {
    console.log(
      `  ${(l.sku ?? '—').padEnd(26)}${String(l.celulas).padStart(8)}${String(l.quantidadeFisica).padStart(10)}` +
        `${String(l.custoUnitario ?? '—').padStart(10)}${(l.valorTotal ?? 0).toFixed(2).padStart(12)}`
    );
  }
}

/**
 * Verifica o backup de forma efetiva: gera (se preciso), valida integridade e
 * RESTAURA num banco descartável comparando a contagem por tabela.
 */
async function verificarBackup(url: string): Promise<ManifestoBackup> {
  const arquivo = arg('backup');
  const manifestoPath = arg('manifesto');
  if (!arquivo) throw new Error('--backup=<arquivo> é obrigatório no modo executar.');
  if (!existsSync(arquivo)) throw new Error(`arquivo de backup inexistente: ${arquivo}`);

  let manifesto: ManifestoBackup;
  if (manifestoPath && existsSync(manifestoPath)) {
    manifesto = JSON.parse(readFileSync(manifestoPath, 'utf8')) as ManifestoBackup;
    console.log(`  manifesto lido: ${manifestoPath} (sha256 ${manifesto.sha256.slice(0, 12)}…)`);
  } else {
    console.log('  sem manifesto: gerando dump íntegro com pg_dump e inventário da origem…');
    const inv = await inventarioDe(pool!);
    const { bytes, sha256 } = gerarDump(url, arquivo);
    manifesto = {
      origem: identificacaoOrigem(url),
      geradoEm: new Date().toISOString(),
      ferramenta: 'pg_dump -Fc',
      arquivo,
      bytes,
      sha256,
      tabelas: inv,
    };
    const saida = manifestoPath ?? `${arquivo}.manifesto.json`;
    writeFileSync(saida, JSON.stringify(manifesto, null, 2));
    console.log(`  manifesto gravado: ${saida}`);
  }

  console.log('  validando integridade (sha256 + catálogo) e restaurando em banco descartável…');
  const v = await verificarComRestauracao({ arquivo, manifesto, baseUrl: url });
  if (!v.ok) {
    throw new Error(
      `BACKUP NÃO RECUPERÁVEL (${v.problemas.join('; ')}` +
        `${v.divergencias.length ? ` | ${v.divergencias.length} tabela(s) divergentes: ${v.divergencias.slice(0, 5).map((d) => `${d.tabela} ${d.esperado}≠${d.restaurado}`).join(', ')}` : ''}). Sem backup comprovado, sem exclusão.`
    );
  }
  console.log(`  ✔ backup RECUPERÁVEL: ${v.tabelasConferidas} tabela(s) restaurada(s) com contagem idêntica (banco ${v.bancoDescartavel} descartado).`);
  return manifesto;
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
  const url = process.env.DATABASE_URL!;

  console.log(`▶ SANEAMENTO PRÉ-GO-LIVE — modo=${modo} empresas=[${empresas.join(', ')}] ator=${ator}`);
  console.log(`  banco: ${identificacaoOrigem(url)}`);
  console.log('  (o estoque físico é a única posição operacional preservada)');

  if (modo === 'executar') {
    if (arg('confirm') !== CONFIRMACAO_EXECUCAO) {
      console.error(`Execução exige --confirm=${CONFIRMACAO_EXECUCAO}.`);
      process.exit(2);
    }
    await verificarBackup(url);
  }

  const resultado = await executarSaneamento(pool, {
    empresaIds: empresas,
    modo,
    confirmacao: arg('confirm'),
    ator,
  });
  const antes = resultado.estoqueAntes;
  imprimirEstoque('ANTES', antes);

  console.log(`\n── COBERTURA DE FK ──────────────────────────────────────────`);
  console.log(`  FKs no grafo: ${resultado.cobertura.totalFks} | tabelas-alvo: ${resultado.cobertura.alvos} | bloqueios: ${resultado.cobertura.bloqueios}`);
  console.log(`  plano: ${PLANO.length} passo(s) de exclusão`);

  console.log(`\n── RELATÓRIO POR TABELA (${resultado.relatorio.length}) ─────────────────────`);
  for (const p of resultado.relatorio) console.log(`  ${String(p.removidos).padStart(7)}  ${p.tabela.padEnd(30)} ${p.descricao}`);
  console.log(`  TOTAL removido: ${resultado.totalRemovido} linha(s)`);

  imprimirEstoque(modo === 'executar' ? 'DEPOIS' : 'DEPOIS (rollback do dry-run)', resultado.estoqueDepois);
  imprimirRelatorioSku(relatorioPorSku(resultado.estoqueDepois));

  if (resultado.divergencias.length) {
    console.error('\n✖ DIVERGÊNCIA DE ESTOQUE — homologação interrompida:');
    for (const d of resultado.divergencias) console.error(`   ${d}`);
    process.exit(1);
  }
  console.log(`\n✔ Estoque físico PRESERVADO (${totalFisico(antes)} peças; ${resultado.estoqueAntes.length} células; custo e valorização idênticos).`);
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
