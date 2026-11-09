// ============================================================================
// GATE DE CI — PAGE SHELL (Fase 9.3, UX operacional)
// ----------------------------------------------------------------------------
// Toda página operacional do ERP usa a MESMA moldura de página (`PageShell`):
// respiro canônico (p-4 sm:p-6), empilhamento (space-y-4) e o mesmo ponto de
// entrada de estados (PageLoading/PageError). Sem a moldura, cada tela inventa
// o próprio padding e a navegação fica irregular.
//
// A regra objetiva: um arquivo de página que renderiza `<PageHeader>` precisa
// renderizar `<PageShell>`. A moldura já absorve os casos de layout próprio
// (rodapé fixo, coluna centrada) via `className`, então não há mais exceção:
// qualquer tela nova que invente a própria moldura falha aqui.
//
// É um teste de ESTRUTURA (lê os fontes), não de renderização: pega a regressão
// mesmo em páginas sem teste de componente.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirPaginas = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../pages');

const arquivos = readdirSync(dirPaginas).filter(
  (f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'),
);

describe('PageShell — moldura canônica das páginas operacionais', () => {
  it('toda página com <PageHeader> usa <PageShell>', () => {
    const semMoldura: string[] = [];
    for (const arquivo of arquivos) {
      const fonte = readFileSync(path.join(dirPaginas, arquivo), 'utf8');
      if (!/<PageHeader\b/.test(fonte)) continue;
      if (/<PageShell\b/.test(fonte)) continue;
      semMoldura.push(arquivo);
    }
    expect(semMoldura).toEqual([]);
  });

  it('nenhuma página reimplementa a moldura à mão (p-4 sm:p-6)', () => {
    // A moldura canônica é o `PageShell`. Um `<div className="p-4 sm:p-6">`
    // solto numa página é a regressão que a Fase 9.3 eliminou: a tela volta a
    // inventar o próprio respiro e divergir da navegação.
    const molduraManual: string[] = [];
    for (const arquivo of arquivos) {
      const fonte = readFileSync(path.join(dirPaginas, arquivo), 'utf8');
      if (/className="p-4 sm:p-6"/.test(fonte)) molduraManual.push(arquivo);
    }
    expect(molduraManual).toEqual([]);
  });

  it('o kit de negócios exporta as primitivas de moldura e estado de página', async () => {
    const kit = await import('../components/ui-kit-negocios');
    for (const nome of ['PageShell', 'PageLoading', 'PageError']) {
      expect(typeof (kit as Record<string, unknown>)[nome]).toBe('function');
    }
  });
});
