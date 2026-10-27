// ============================================================================
// GATE DE CI — ZERO MODAL (npm --workspace client run test)
// ----------------------------------------------------------------------------
// Executa a MESMA auditoria de `npm run audit:ux` dentro da suíte do cliente,
// para que qualquer modal/drawer/sheet reintroduzido quebre o build de testes
// mesmo que alguém esqueça de rodar o gate manualmente.
//
// A auditoria é um script Node (`scripts/ux-guard.mjs`) chamado via CLI —
// é a fonte única da regra, sem duplicar regex entre script e teste.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('ZERO MODAL — gate de arquitetura de UX', () => {
  it('nenhum modal/dialog/drawer/sheet em fluxo de módulo (audit:ux)', () => {
    let saida = '';
    try {
      saida = execFileSync(process.execPath, [path.join(raiz, 'scripts/auditar-ux.mjs'), '--json'], {
        cwd: raiz,
        encoding: 'utf8',
      });
    } catch (e: any) {
      // exit 1 = gate reprovado; o JSON vai em stdout
      saida = String(e.stdout || '');
      const relatorio = saida ? JSON.parse(saida) : { violacoes: ['gate não executou'] };
      throw new Error(`Regra ZERO MODAL violada:\n${(relatorio.violacoes || []).join('\n')}`);
    }
    const relatorio = JSON.parse(saida);
    expect(relatorio.ok).toBe(true);
    expect(relatorio.violacoes).toEqual([]);
  }, 60_000);

  it('o design system não exporta primitiva de modal', async () => {
    const ui = await import('../components/ui');
    for (const proibido of ['Modal', 'Dialog', 'ConfirmDialog', 'Drawer', 'Sheet']) {
      expect(Object.keys(ui)).not.toContain(proibido);
    }
    // Os substitutos corretos existem e são a única superfície permitida.
    expect(Object.keys(ui)).toContain('PainelInline');
    expect(Object.keys(ui)).toContain('ConfirmacaoInline');
  });
});
