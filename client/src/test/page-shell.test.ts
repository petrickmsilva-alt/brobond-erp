// ============================================================================
// GATE DE CI — PAGE SHELL (Fase 9.3, UX operacional)
// ----------------------------------------------------------------------------
// Toda página operacional do ERP usa a MESMA moldura de página (`PageShell`):
// respiro canônico (p-4 sm:p-6), empilhamento (space-y-4) e o mesmo ponto de
// entrada de estados (PageLoading/PageError). Sem a moldura, cada tela inventa
// o próprio padding e a navegação fica irregular; sem o estado canônico, cada
// tela inventa o próprio carregamento e a mesma página muda de moldura conforme
// o estado.
//
// Provas (todas estruturais — leem os FONTES, pegam a regressão mesmo em página
// sem teste de componente):
//   A. um arquivo que renderiza `<PageHeader>` precisa renderizar `<PageShell>`;
//   B. nenhuma página reimplementa a moldura à mão: um `return` cujo elemento
//      raiz é `<div className="… p-4 … sm:p-6 …">` (a moldura manual que a fase
//      eliminou). O regex aceita qualquer ordem/classe extra, mas exige que o
//      `p-4`/`sm:p-6` esteja na MESMA string de `className` — cartões internos
//      (`card p-4 sm:p-6`) não são o elemento raiz de um `return` e não entram;
//   C. nenhuma página devolve um `<Spinner>` cru como ESTADO DE PÁGINA inteira:
//      o estado canônico é `PageLoading` (com a moldura). `Spinner` continua
//      válido para carregamento de SEÇÃO (dentro de um bloco, não como `return`
//      de página);
//   D. o kit exporta as primitivas de moldura e estado de página.
//
// Escopo: `client/src/pages/*.tsx` (nível de módulo), como o gate original. As
// páginas de `commerce/` e `creators/` são filhas de um módulo do menu cujo
// wrapper de nível superior já usa a moldura — a cobrança recursiva fica fora
// deste gate para não reformar o ERP inteiro por estética (Fase 9.3 §7.7).
// ============================================================================
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirPaginas = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../pages');

const arquivos = readdirSync(dirPaginas).filter(
  (f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'),
);

const ler = (arquivo: string) => readFileSync(path.join(dirPaginas, arquivo), 'utf8');

// Moldura manual: o elemento raiz de um `return` é um `<div>` cujo `className`
// traz `p-4` E `sm:p-6` na mesma string (com ou sem classes extras, em qualquer
// ordem). Cartões internos não são o raiz de um `return`, então não casam.
const MOLDURA_MANUAL = /return\s*\(\s*<div\s+className=["'`][^"'`]*\bp-4\b[^"'`]*\bsm:p-6\b[^"'`]*["'`]/;
// Estado de página inteira entregue como `Spinner` cru (early return).
const SPINNER_DE_PAGINA = /return\s*\(?\s*<Spinner\b/;

describe('PageShell — moldura canônica das páginas operacionais', () => {
  it('A. toda página com <PageHeader> usa <PageShell>', () => {
    const semMoldura: string[] = [];
    for (const arquivo of arquivos) {
      const fonte = ler(arquivo);
      if (!/<PageHeader\b/.test(fonte)) continue;
      if (/<PageShell\b/.test(fonte)) continue;
      semMoldura.push(arquivo);
    }
    expect(semMoldura).toEqual([]);
  });

  it('B. nenhuma página reimplementa a moldura à mão (p-4 sm:p-6 no raiz de um return)', () => {
    const molduraManual: string[] = [];
    for (const arquivo of arquivos) {
      if (MOLDURA_MANUAL.test(ler(arquivo))) molduraManual.push(arquivo);
    }
    expect(molduraManual).toEqual([]);
  });

  it('C. nenhuma página entrega <Spinner> cru como estado de página inteira (use <PageLoading>)', () => {
    const spinnerCru: string[] = [];
    for (const arquivo of arquivos) {
      if (SPINNER_DE_PAGINA.test(ler(arquivo))) spinnerCru.push(arquivo);
    }
    expect(spinnerCru).toEqual([]);
  });

  it('D. o kit de negócios exporta as primitivas de moldura e estado de página', async () => {
    const kit = await import('../components/ui-kit-negocios');
    for (const nome of ['PageShell', 'PageLoading', 'PageError']) {
      expect(typeof (kit as Record<string, unknown>)[nome]).toBe('function');
    }
  });
});
