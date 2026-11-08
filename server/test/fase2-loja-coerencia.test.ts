// ============================================================================
// FASE 2 — COERÊNCIA DOCUMENTAL DA `/loja` (estado atual × arquitetura-alvo).
//
// A decisão do Diretor (ADR-0007) é RETIRAR a loja pública nativa `/loja` e
// deixar a RETAIL WooCommerce como única loja pública de varejo. A retirada,
// porém, NÃO foi executada (bloqueada por ambiente/decisão — ver
// NATIVE-STORE-DECOMMISSION-REPORT.md). Enquanto não executada, a
// documentação precisa descrever a superfície como ATIVA, não como removida.
//
// Este teste trava as duas metades da coerência:
//   1. a superfície nativa continua REGISTRADA (nada foi removido por engano);
//   2. os documentos de arquitetura NÃO afirmam a retirada como concluída.
//
// Não valida DNS, SEO nem o fluxo RETAIL (fora do escopo desta missão).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const raiz = new URL('../../', import.meta.url);
const ler = (relativo: string) => readFileSync(new URL(relativo, raiz), 'utf8');

test('a superfície pública nativa continua registrada (nada removido nesta missão)', () => {
  const index = ler('server/src/index.ts');
  for (const rota of [
    "'/api/loja/config'",
    "'/api/loja/produtos'",
    "'/api/loja/produtos/:slug'",
    "'/api/loja/preview'",
    "'/api/loja/carrinho/quantidade'",
    "'/api/loja/payment-methods'",
    "'/api/loja/checkout'",
    "'/api/loja/checkout/:chave'",
    "'/api/loja/pedidos/:token'",
    "'/api/commerce/checkout/payment-intent'",
    "'/api/commerce/loja/estado'",
  ]) {
    assert.ok(index.includes(rota), `rota ${rota} deveria continuar registrada (retirada não executada)`);
  }

  const app = ler('client/src/App.tsx');
  for (const rota of ['/loja', '/loja/produto/:slug', '/loja/carrinho', '/loja/checkout', '/loja/pedido/:token']) {
    assert.ok(app.includes(`path="${rota}"`), `rota SPA ${rota} deveria continuar registrada`);
  }
});

test('os serviços compartilhados da vitrine continuam presentes (não removidos)', () => {
  // Só os módulos que a retirada preservaria; se algum sumir, é sinal de remoção
  // fora do escopo (a missão proíbe descontinuar a /loja).
  for (const arquivo of [
    'server/src/commerce/vitrine.ts',
    'server/src/commerce/pedidos.ts',
    'server/src/commerce/estado-loja.ts',
    'server/src/commerce/loja-base.ts',
  ]) {
    assert.doesNotThrow(() => ler(arquivo), `${arquivo} deveria existir`);
  }
});

test('o relatório registra a retirada como NÃO executada (coerência com o estado real)', () => {
  const relatorio = ler('docs/architecture/NATIVE-STORE-DECOMMISSION-REPORT.md');
  assert.match(relatorio, /NÃO EXECUTADA/i, 'o relatório deve declarar a retirada como não executada');
  assert.match(relatorio, /bloquead/i, 'o relatório deve registrar o bloqueio');
});

test('ADR-0007 registra a decisão como Aceita (a arquitetura-alvo é descontinuar)', () => {
  const adr = ler('docs/architecture/ADR/ADR-0007-descontinuacao-loja-nativa.md');
  assert.match(adr, /Status:\*\*\s*\*\*Aceita/i, 'ADR-0007 deve estar Aceita');
});

test('nenhum documento de arquitetura afirma a retirada da /loja como concluída', () => {
  // O risco corrigido nesta missão: docs diziam "descontinuada" (concluída)
  // quando a superfície segue ativa. "Descontinuar/descontinuada" só é aceitável
  // como decisão/plano, nunca como estado realizado.
  const arquivos = [
    'docs/architecture/SECURITY-ARCHITECTURE.md',
    'docs/architecture/TARGET-ARCHITECTURE.md',
    'docs/architecture/README.md',
    'docs/architecture/NATIVE-STORE-DECOMMISSION.md',
    'docs/architecture/NATIVE-STORE-DECOMMISSION-REPORT.md',
  ];
  for (const arquivo of arquivos) {
    const texto = ler(arquivo);
    assert.doesNotMatch(
      texto,
      /loja nativa[^\n]*\*\*descontinuada\*\*/i,
      `${arquivo}: a loja nativa não pode ser descrita como "descontinuada" (ainda está ativa)`
    );
    assert.doesNotMatch(
      texto,
      /retirada[^\n]*\*\*(concluída|executada)\*\*/i,
      `${arquivo}: a retirada não pode ser descrita como concluída/executada`
    );
    // Afirmação em prosa (sem negrito) do tipo "A retirada é executada na
    // Fase 2" também é incoerente com o estado real (retirada não executada).
    assert.doesNotMatch(
      texto,
      /retirada (?:é|e|foi) executada/i,
      `${arquivo}: a retirada não pode ser afirmada como executada (ainda pendente — BL-015)`
    );
  }
});

test('o plano de retirada (NATIVE-STORE-DECOMMISSION.md) declara a execução bloqueada', () => {
  const plano = ler('docs/architecture/NATIVE-STORE-DECOMMISSION.md');
  assert.match(plano, /execução está\s+bloqueada\*\*/i, 'o plano deve declarar a execução bloqueada');
  assert.match(plano, /ainda está ativa/i, 'o plano deve declarar a superfície ainda ativa');
});
