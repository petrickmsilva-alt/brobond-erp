// ============================================================================
// MIGRATIONS — IDENTIDADE E SEQUÊNCIA (fonte única de critério)
// ----------------------------------------------------------------------------
// ETAPA 01 / MIGRATION FORENSICS (2026-11-14). Este módulo existe porque o gate
// final usava um critério DIFERENTE do runner real:
//
//   • RUNNER (server/src/db.ts, aplicarMigrationsVersionadas):
//       identidade = NOME COMPLETO do arquivo (PRIMARY KEY em schema_migrations);
//       ordem      = lexical (.sort() sobre o nome inteiro);
//       registro   = INSERT transacional do nome completo.
//   • GATE antigo (final-go-live-audit.ts):
//       exigia prefixo == posição + 1 — um modelo de "número único por arquivo"
//       que o runner NÃO usa e que o histórico real já violou (0121 duplicado).
//
// Evidência forense (PostgreSQL 16.14 real, bancos descartáveis — ver
// docs/auditoria/etapa-01-migration-forensics.md e
// server/test/pg/prod-db-04-identidade-migrations.test.ts):
//   C1 banco novo: os DOIS arquivos 0121 aplicam, em ordem lexical estável;
//   C2 reboot: nada reaplica (identidade = nome completo);
//   C3 banco legado pré-perf: recebe SOMENTE o 0121_perf faltante;
//   C4 renomear 0121_perf → 0122 SEM reconciliar schema_migrations REAPLICA a
//      migration (o nome novo não está registrado). Renomear sem evidência do
//      histórico de produção é, portanto, PROIBIDO.
//
// Critério coerente resultante (este módulo):
//   1. identidade continua sendo o nome completo — prefixo é ORDENAÇÃO, não chave;
//   2. prefixos distintos formam sequência contígua a partir de 0001 (sem buraco);
//   3. prefixo duplicado só é aceito se estiver na colisões-históricas abaixo
//      (registradas com evidência). Qualquer NOVA duplicidade é P0;
//   4. colisão histórica conhecida é reportada (P2) com o plano de reconciliação
//      — nunca silenciada.
//
// A correção NÃO renomeia nenhum arquivo: o histórico de produção não está
// acessível neste ambiente (BLOQUEADO — EVIDÊNCIA DE PRODUÇÃO INDISPONÍVEL) e a
// regra da missão proíbe renomear sem comprovar o estado de aplicação.
// ============================================================================

/**
 * Colisões de prefixo JÁ PRESENTES no histórico enviado ao repositório.
 * Cada entrada exige: arquivos exatos, motivo e plano de reconciliação.
 *
 * 0121: `0121_operational_control_plane.sql` (PR do Control Plane) e
 * `0121_perf_busca_trigram_e_listagens.sql` (PR #136, performance) foram
 * mesclados em paralelo a partir da mesma base. O runner identifica pelo nome
 * completo e aplica ambos em ordem lexical determinística
 * ('operational' < 'perf'), sem conflito de execução. A duplicidade viola a
 * convenção de numeração, não a integridade da cadeia.
 *
 * Reconciliação futura (exige evidência de produção + autorização do Diretor):
 *   a. consulta READ-ONLY em produção: SELECT id FROM schema_migrations WHERE id LIKE '0121%';
 *   b. se '0121_perf_busca_trigram_e_listagens.sql' estiver registrada:
 *      migration aditiva que faz INSERT ... SELECT do id novo ('0122_...')
 *      quando o id antigo existir (ON CONFLICT DO NOTHING), e SÓ ENTÃO o
 *      rename do arquivo na mesma release;
 *   c. se NÃO estiver registrada: rename simples é seguro (nunca aplicou);
 *   d. remover a entrada desta lista junto com o rename.
 * Enquanto (a) não for possível, a colisão permanece registrada aqui.
 */
export const COLISOES_HISTORICAS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '0121': Object.freeze([
    '0121_operational_control_plane.sql',
    '0121_perf_busca_trigram_e_listagens.sql',
  ]),
});

export type AchadoSequencia = {
  id: 'MIGRATION_NOME' | 'MIGRATION_SEQUENCIA' | 'MIGRATION_PREFIXO_DUPLICADO' | 'MIGRATION_COLISAO_HISTORICA';
  severidade: 'P0' | 'P2';
  mensagem: string;
};

/**
 * Audita a cadeia de migrations pelo MESMO modelo de identidade do runner.
 * `nomes` deve ser a lista de arquivos .sql do diretório (a função ordena
 * lexicalmente, como o runner). Função PURA — testável sem banco.
 */
export function auditarSequenciaMigrations(nomes: readonly string[]): AchadoSequencia[] {
  const achados: AchadoSequencia[] = [];
  const ordenados = [...nomes].sort();

  // 1) Todo arquivo precisa de prefixo numérico de 4 dígitos + separador.
  const comPrefixo: Array<{ arquivo: string; prefixo: string }> = [];
  for (const arquivo of ordenados) {
    const m = /^(\d{4})_/.exec(arquivo);
    if (!m) {
      achados.push({ id: 'MIGRATION_NOME', severidade: 'P0', mensagem: `Migration sem prefixo numérico de 4 dígitos: ${arquivo}` });
      continue;
    }
    comPrefixo.push({ arquivo, prefixo: m[1] });
  }

  // 2) Agrupa por prefixo (a ordem lexical dos nomes já é a ordem do runner).
  const porPrefixo = new Map<string, string[]>();
  for (const { arquivo, prefixo } of comPrefixo) {
    const lista = porPrefixo.get(prefixo) ?? [];
    lista.push(arquivo);
    porPrefixo.set(prefixo, lista);
  }

  // 3) Prefixos DISTINTOS precisam ser contíguos a partir de 0001. Buraco ou
  //    início errado indica cadeia incompleta (P0) — independente de duplicidade.
  const prefixos = [...porPrefixo.keys()].sort();
  prefixos.forEach((prefixo, indice) => {
    const esperado = String(indice + 1).padStart(4, '0');
    if (prefixo !== esperado) {
      achados.push({
        id: 'MIGRATION_SEQUENCIA',
        severidade: 'P0',
        mensagem: `Sequência de prefixos quebrada: ${prefixo} (esperado ${esperado}); arquivos: ${porPrefixo.get(prefixo)!.join(', ')}`,
      });
    }
  });

  // 4) Duplicidade de prefixo: histórica registrada (P2, com plano) ou nova (P0).
  for (const [prefixo, arquivos] of porPrefixo) {
    if (arquivos.length < 2) continue;
    const registrada = COLISOES_HISTORICAS[prefixo];
    const exatamenteHistorica =
      registrada !== undefined &&
      registrada.length === arquivos.length &&
      [...registrada].sort().every((a, i) => a === arquivos[i]);
    if (exatamenteHistorica) {
      achados.push({
        id: 'MIGRATION_COLISAO_HISTORICA',
        severidade: 'P2',
        mensagem:
          `Prefixo ${prefixo} duplicado no histórico enviado (${arquivos.join(', ')}). ` +
          'Identidade do runner = nome completo: ambos aplicam uma única vez, em ordem lexical. ' +
          'Rename BLOQUEADO até consulta read-only do schema_migrations de produção ' +
          '(plano em scripts/migrations-identidade.ts e docs/auditoria/etapa-01-migration-forensics.md).',
      });
    } else {
      achados.push({
        id: 'MIGRATION_PREFIXO_DUPLICADO',
        severidade: 'P0',
        mensagem:
          `Prefixo ${prefixo} duplicado por arquivos NÃO registrados como colisão histórica: ${arquivos.join(', ')}. ` +
          'Escolha o próximo prefixo livre; nunca renomeie migration já enviada sem reconciliar schema_migrations.',
      });
    }
  }

  return achados;
}
