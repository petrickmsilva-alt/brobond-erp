#!/usr/bin/env node
// ============================================================================
// BENCHMARK REPRODUZÍVEL — RENDER × HOSTGATOR VPS
//
// Executa o MESMO protocolo nos dois alvos e produz uma comparação única:
//   • latência fria (cold start) e P50/P95/P99 por rota;
//   • throughput (RPS) e erros em estágios crescentes de concorrência;
//   • evidência do lado do servidor (CPU, memória, pool, lag do event loop);
//   • custo mensal total informado e custo normalizado por 1 milhão de req.
//
// REGRAS PARA A COMPARAÇÃO VALER
//   1. Mesma versão da aplicação nos dois alvos (mesmo commit).
//   2. MESMO banco Neon — de preferência um BRANCH do Neon para o teste, para
//      não gerar carga no banco de produção. A latência API↔banco deve ser a
//      mesma nos dois lados, senão mede-se geografia, não hospedagem.
//   3. Mesmo PG_POOL_MAX e BOOT_HOLD_MS.
//   4. Rodar os dois na mesma janela de horário e rede de teste.
//   5. Aquecer antes de medir (o script já faz).
//
// Uso:
//   PERF_EMAIL=... PERF_SENHA=... node scripts/perf/benchmark-render-vs-vps.mjs \
//     --render https://brobond-erp.onrender.com \
//     --vps http://IP_DA_VPS:8080 \
//     --estagios 1,5,10,25 --duracao 30 \
//     --custo-render 0 --custo-vps 149 \
//     --markdown docs/PERFORMANCE/benchmark.md
//
// Nenhuma migração de produção é feita por este script: ele só mede.
// ============================================================================
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (nome, padrao) => {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : padrao;
};

const RENDER = arg('render', process.env.PERF_RENDER || '');
const VPS = arg('vps', process.env.PERF_VPS || '');
const ESTAGIOS = arg('estagios', '1,5,10,25');
const DURACAO = arg('duracao', '30');
const CUSTO_RENDER = Number(arg('custo-render', 0));
const CUSTO_VPS = Number(arg('custo-vps', 0));
const MARKDOWN = arg('markdown', '');

if (!RENDER || !VPS) {
  console.error('Informe --render e --vps (URLs base). Abortando.');
  process.exit(2);
}

const pasta = mkdtempSync(path.join(tmpdir(), 'brobond-bench-'));

function rodar(script, alvo, saida) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [
        path.join('scripts', 'perf', script),
        '--base',
        alvo,
        '--saida',
        saida,
        ...(script === 'carga.mjs' ? ['--estagios', ESTAGIOS, '--duracao', DURACAO] : ['--iteracoes', '20']),
      ],
      { stdio: 'inherit', env: process.env }
    );
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} saiu com código ${code}`))));
  });
}

const ler = (arquivo) => JSON.parse(readFileSync(arquivo, 'utf8'));

function tabelaComparativa(nome, render, vps) {
  const linhas = [
    `### ${nome}`,
    '',
    '| Métrica | Render | VPS | Vencedor |',
    '|---|---|---|---|',
  ];
  const vence = (a, b, menorMelhor = true) => {
    if (a === null || a === undefined) return 'VPS';
    if (b === null || b === undefined) return 'Render';
    if (a === b) return 'empate';
    return (menorMelhor ? a < b : a > b) ? 'Render' : 'VPS';
  };
  for (const chave of Object.keys(render)) {
    if (typeof render[chave] === 'object') continue;
    linhas.push(`| ${chave} | ${render[chave]} | ${vps[chave] ?? '—'} | ${vence(render[chave], vps[chave])} |`);
  }
  return linhas.join('\n');
}

async function main() {
  console.log(`\n═══ BENCHMARK: Render × VPS ═══\nRender: ${RENDER}\nVPS:    ${VPS}\n`);

  const alvos = [
    ['render', RENDER],
    ['vps', VPS],
  ];
  const dados = {};
  for (const [nome, url] of alvos) {
    console.log(`\n──────── ${nome.toUpperCase()} (${url}) ────────`);
    const diagnostico = path.join(pasta, `${nome}-diag.json`);
    const carga = path.join(pasta, `${nome}-carga.json`);
    await rodar('diagnostico.mjs', url, diagnostico);
    await rodar('carga.mjs', url, carga);
    dados[nome] = { diagnostico: ler(diagnostico), carga: ler(carga) };
  }

  // ---- Consolidação por rota -------------------------------------------
  const rotasRender = new Map(dados.render.diagnostico.rotas.map((r) => [r.rota, r]));
  const secoes = [];
  secoes.push('# Benchmark Render × HostGator VPS', '');
  secoes.push(`Gerado em ${new Date().toISOString()}`, '');
  secoes.push('Protocolo idêntico nos dois alvos: mesma versão da aplicação, mesmo banco Neon,');
  secoes.push(`mesmo PG_POOL_MAX, estágios ${ESTAGIOS} usuários simultâneos por ${DURACAO}s.`, '');

  secoes.push('## Latência por rota (após aquecimento)', '');
  secoes.push('| Rota | Render P50 | Render P95 | VPS P50 | VPS P95 | Ganho P95 |');
  secoes.push('|---|---|---|---|---|---|');
  for (const r of dados.render.diagnostico.rotas) {
    const v = dados.vps.diagnostico.rotas.find((x) => x.rota === r.rota) ?? {};
    const ganho =
      r.p95_ms && v.p95_ms ? `${Math.round((1 - Number(v.p95_ms) / Number(r.p95_ms)) * 100)}%` : '—';
    secoes.push(`| ${r.rota} | ${r.p50_ms} | ${r.p95_ms} | ${v.p50_ms ?? '—'} | ${v.p95_ms ?? '—'} | ${ganho} |`);
  }
  secoes.push('');

  secoes.push('## Cold start (primeira requisição após inatividade)', '');
  secoes.push('| Rota | Render 1ª req. | VPS 1ª req. |');
  secoes.push('|---|---|---|');
  for (const r of dados.render.diagnostico.rotas) {
    const v = dados.vps.diagnostico.rotas.find((x) => x.rota === r.rota) ?? {};
    secoes.push(`| ${r.rota} | ${r.primeira_ms ?? '—'} ms | ${v.primeira_ms ?? '—'} ms |`);
  }
  secoes.push('');

  secoes.push('## Throughput e estabilidade', '');
  secoes.push('| Concorrência | Render RPS | VPS RPS | Render P95 | VPS P95 | Render erros | VPS erros |');
  secoes.push('|---|---|---|---|---|---|---|');
  for (const e of dados.render.carga.estagios) {
    const v = dados.vps.carga.estagios.find((x) => x.concorrencia === e.concorrencia) ?? {};
    secoes.push(
      `| ${e.concorrencia} | ${e.rps} | ${v.rps ?? '—'} | ${e.p95_ms} | ${v.p95_ms ?? '—'} | ${e.erros_total} | ${v.erros_total ?? '—'} |`
    );
  }
  secoes.push('');

  const ultimoRender = dados.render.carga.estagios.at(-1)?.servidor_depois ?? {};
  const ultimoVps = dados.vps.carga.estagios.at(-1)?.servidor_depois ?? {};
  secoes.push('## Evidência do servidor no pico', '');
  secoes.push(tabelaComparativa('Recursos no último estágio', {
    'CPU %': ultimoRender.cpu_pct ?? null,
    'RSS MB': ultimoRender.rss_mb ?? null,
    'Event loop lag P99 ms': ultimoRender.lag_p99_ms ?? null,
    'Pool aguardando': ultimoRender.pool?.aguardando ?? null,
    'Espera de pool P95 ms': ultimoRender.espera_pool_p95_ms ?? null,
    'DB P95 ms': ultimoRender.db_p95_ms ?? null,
  }, {
    'CPU %': ultimoVps.cpu_pct ?? null,
    'RSS MB': ultimoVps.rss_mb ?? null,
    'Event loop lag P99 ms': ultimoVps.lag_p99_ms ?? null,
    'Pool aguardando': ultimoVps.pool?.aguardando ?? null,
    'Espera de pool P95 ms': ultimoVps.espera_pool_p95_ms ?? null,
    'DB P95 ms': ultimoVps.db_p95_ms ?? null,
  }));
  secoes.push('');

  // ---- Custo -----------------------------------------------------------
  if (CUSTO_RENDER || CUSTO_VPS) {
    const reqRender = dados.render.carga.estagios.reduce((a, e) => a + e.requisicoes, 0);
    const reqVps = dados.vps.carga.estagios.reduce((a, e) => a + e.requisicoes, 0);
    secoes.push('## Custo', '');
    secoes.push('| Item | Render | VPS |');
    secoes.push('|---|---|---|');
    secoes.push(`| Mensalidade informada (R$) | ${CUSTO_RENDER} | ${CUSTO_VPS} |`);
    secoes.push(`| Requisições no teste | ${reqRender} | ${reqVps} |`);
    secoes.push('');
    secoes.push(
      '> Custo por requisição só tem sentido com o MESMO volume; use os números de RPS para'
    );
    secoes.push(
      '> estimar a mensalidade real (`RPS × 2.592.000 s/mês × preço por 1M req`). Custos de'
    );
    secoes.push(
      '> backup, monitoramento, TLS, atualização de sistema e tempo de operação devem ser'
    );
    secoes.push('> somados ao lado da VPS — estão na seção "Recomendação" do relatório principal.');
    secoes.push('');
  }

  secoes.push('## Arquivos brutos', '');
  secoes.push(`Diagnósticos e cargas completos em \`${pasta}\`.`);

  const texto = secoes.join('\n');
  console.log(`\n${texto}`);
  if (MARKDOWN) {
    writeFileSync(MARKDOWN, texto);
    console.log(`\n💾 Markdown salvo em ${MARKDOWN}`);
  }
}

main().catch((e) => {
  console.error('❌ Benchmark falhou:', e?.message || e);
  process.exit(1);
});
