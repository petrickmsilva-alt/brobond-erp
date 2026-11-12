#!/usr/bin/env node
// ============================================================================
// DIAGNÓSTICO DE CONEXÃO AO POSTGRESQL PUBLICADO — executor SOMENTE LEITURA.
//
// Uso:
//   DATABASE_URL=... node --import tsx scripts/diagnostico-conexao-producao.ts \
//     [--projeto=ep-...|projeto-id] [--branch=production] [--branch-id=br-...] \
//     [--marcador=empresas]
//
// Confirma de qual banco a credencial fala ANTES de qualquer ato operacional:
//   • imprime current_database(), current_user, current_schema(), version(),
//     now() e o estado do SSL;
//   • lê as GUCs do Neon (neon.project_id / neon.branch_id / neon.branch_name /
//     neon.endpoint_id / neon.timeline_id) para confirmar o destino;
//   • confirma a tabela-marcador do ERP e o histórico de migrações.
//
// NÃO executa DELETE/TRUNCATE/DROP/UPDATE/INSERT, migração, saneamento, carga
// cadastral, alteração de estoque, publicação ou sincronização externa. A
// sessão roda em transação `READ ONLY` (ver server/src/ops/diagnostico-conexao.ts).
//
// NUNCA imprime a DATABASE_URL, usuário, senha, tokens nem variáveis de
// ambiente: a origem é mostrada apenas como host:porta/banco.
//
// Se o destino NÃO for confirmado como a branch esperada do projeto no Neon, o
// script interrompe com código de saída ≠ 0 (fail-closed).
// ============================================================================
import { Pool } from 'pg';
import {
  avaliarDestino,
  coletarIdentidade,
  MARCADOR_PADRAO,
  SUFIXO_HOST_NEON,
  type IdentidadeConexao,
} from '../server/src/ops/diagnostico-conexao';

function arg(nome: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${nome}=`));
  const v = p ? p.slice(nome.length + 3).trim() : '';
  return v || undefined;
}

function imprimir(id: IdentidadeConexao) {
  console.log('▶ DIAGNÓSTICO DE CONEXÃO — somente leitura (nenhuma escrita)');
  console.log(`  origem (host:porta/banco): ${id.origem}`);
  console.log('');
  console.log('── IDENTIFICAÇÃO (somente leitura) ─────────────────────────────');
  console.log(`  current_database(): ${id.banco}`);
  console.log(`  current_user:       ${id.usuario}`);
  console.log(`  current_schema():   ${id.schema}`);
  console.log(`  version():          ${id.versao}`);
  console.log(`  now():              ${id.agora}`);
  console.log(`  SSL (pg_stat_ssl):  ${id.ssl === null ? 'não informado' : id.ssl ? 'cifrada' : 'SEM CIFRA'}`);
  console.log('');
  console.log('── DESTINO NEON ────────────────────────────────────────────────');
  console.log(`  neon.project_id:    ${id.neon.projetoId ?? '— (ausente)'}`);
  console.log(`  neon.branch_id:     ${id.neon.branchId ?? '— (ausente)'}`);
  console.log(`  neon.branch_name:   ${id.neon.branchNome ?? '— (ausente)'}`);
  console.log(`  neon.endpoint_id:   ${id.neon.endpointId ?? '— (ausente)'}`);
  console.log(`  neon.timeline_id:   ${id.neon.timelineId ?? '— (ausente)'}`);
  console.log('');
  console.log('── IMPRESSÃO DIGITAL DO SCHEMA ─────────────────────────────────');
  console.log(`  schema_migrations:  ${id.migracoesPresentes ? 'presente' : 'AUSENTE'}`);
  console.log(`  tabela-marcador:    ${id.marcadorPresente ? 'presente' : 'AUSENTE'}`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !/^postgres(?:ql)?:\/\//i.test(url)) {
    console.error('Diagnóstico exige DATABASE_URL PostgreSQL (o valor NÃO é impresso).');
    process.exit(2);
  }

  const esperado = {
    projetoId: arg('projeto') ?? null,
    branchNome: arg('branch') ?? 'production',
    branchId: arg('branch-id') ?? null,
    marcador: arg('marcador') ?? MARCADOR_PADRAO,
    hostSufixo: arg('host-sufixo') ?? SUFIXO_HOST_NEON,
  };

  // Fail-closed: sem o id do projeto esperado não há como confirmar que o alvo é
  // a branch certa do BROBOND-ERP — e confirmar é o objetivo do diagnóstico.
  if (!esperado.projetoId) {
    console.error('Informe --projeto=<id do projeto Neon> — sem ele o destino NÃO é confirmável.');
    process.exit(2);
  }

  const pool = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 15_000,
    // O Neon exige conexão cifrada. `PGSSL=false` só é usado no teste local.
    ssl: process.env.PGSSL === 'false' ? undefined : { rejectUnauthorized: false },
  });

  try {
    const id = await coletarIdentidade(pool, { url, marcador: esperado.marcador ?? MARCADOR_PADRAO });
    imprimir(id);

    const resultado = avaliarDestino(id, esperado);
    console.log('');
    console.log('── CONFIRMAÇÃO DO DESTINO ──────────────────────────────────────');
    for (const v of resultado.verificacoes) console.log(`  ${v.ok ? '✔' : '✖'} ${v.nome}: ${v.detalhe}`);
    console.log(`  esperado: projeto=${esperado.projetoId ?? '(não informado)'} branch=${esperado.branchNome} host≈*${esperado.hostSufixo}`);

    if (!resultado.ok) {
      console.error('\n✖ DESTINO NÃO CONFIRMADO — interrompendo. Nenhuma operação foi executada.');
      process.exitCode = 1;
      return;
    }
    console.log('\n✔ Destino CONFIRMADO como a branch esperada do projeto Neon. Nenhuma escrita foi executada.');
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error('DIAGNÓSTICO FALHOU:', e?.message ?? e);
  process.exit(1);
});
