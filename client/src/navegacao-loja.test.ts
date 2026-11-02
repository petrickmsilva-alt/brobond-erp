// ============================================================================
// NAVEGAÇÃO COMMERCE → EXPERIÊNCIA — regressão de "Abrir Loja".
//
// Regra de produto:
//   Commerce → Experiência → Loja própria → /commerce/loja (admin/config)
//   Commerce → Experiência → Abrir Loja   → /loja          (pública, oficial)
//
// "Abrir Loja" é um item de navegação NORMAL da fonte única (modules.ts), não
// um módulo administrativo novo: não cria página, não cria rota paralela, não
// abre modal/iframe/overlay. A rota /loja continua sendo a ÚNICA vitrine.
// ============================================================================
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODULES, buildNavigationTree, moduleOfPath, usaCrudGenerico, visibleModules } from './modules';

// Vitest roda com cwd = client/ (tanto via `npm --workspace client test` quanto
// via `npx vitest` de dentro de client/). O fallback cobre execução na raiz.
function fonte(relativo: string): string {
  const candidatos = [path.resolve(process.cwd(), relativo), path.resolve(process.cwd(), 'client', relativo)];
  const achado = candidatos.find((p) => existsSync(p));
  if (!achado) throw new Error(`arquivo não encontrado: ${relativo}`);
  return readFileSync(achado, 'utf8');
}

const app = fonte('src/App.tsx');

describe('Commerce → Experiência → Loja própria / Abrir Loja', () => {
  it('Loja própria continua em /commerce/loja e Abrir Loja aponta DIRETAMENTE para /loja', () => {
    const loja = MODULES.find((m) => m.id === 'commerce-loja');
    const abrir = MODULES.find((m) => m.id === 'commerce-abrir-loja');
    expect(loja?.path).toBe('/commerce/loja');
    expect(abrir?.label).toBe('Abrir Loja');
    expect(abrir?.path).toBe('/loja');
    expect(abrir?.area).toBe('Commerce');
    expect(abrir?.group).toBe('Experiência');
    expect(abrir?.subgroup).toBe(loja?.subgroup);
    expect(abrir?.icon).toBeDefined();
    // Abaixo de "Loja própria", na mesma ordem da árvore.
    expect(MODULES.indexOf(abrir!)).toBe(MODULES.indexOf(loja!) + 1);
    // dono da rota (breadcrumb / título / Command Palette)
    expect(moduleOfPath('/commerce/loja')?.id).toBe('commerce-loja');
    expect(moduleOfPath('/loja')?.id).toBe('commerce-abrir-loja');
  });

  it('a árvore de navegação renderiza os dois itens em Experiência → Vitrine, nessa ordem', () => {
    const tree = buildNavigationTree(MODULES);
    const comercio = tree.flatMap((s) => s.areas).find((a) => a.area === 'Commerce');
    const experiencia = comercio?.groups.find((g) => g.group === 'Experiência');
    const vitrine = experiencia?.subgroups.find((s) => s.subgroup === 'Vitrine');
    expect(vitrine?.modules.map((m) => [m.label, m.path])).toEqual([
      ['Loja própria', '/commerce/loja'],
      ['Abrir Loja', '/loja'],
    ]);
    // Acessível em todos os perfis: é um atalho para a experiência PÚBLICA.
    for (const perfil of ['admin', 'gerente', 'operador']) {
      expect(visibleModules({ perfil }).some((m) => m.id === 'commerce-abrir-loja')).toBe(true);
    }
  });

  it('não cria rota paralela: /loja continua sendo a rota pública oficial e única', () => {
    expect(MODULES.filter((m) => m.path === '/loja')).toHaveLength(1);
    expect(MODULES.find((m) => m.id === 'commerce-abrir-loja')?.rotaPublica).toBe(true);
    expect(usaCrudGenerico(MODULES.find((m) => m.id === 'commerce-abrir-loja')!)).toBe(false);
    expect(app).toContain('path="/loja" element={<LojaInicioPage />}');
    // O loop gerador de rotas administrativas ignora itens de rota pública.
    expect(app).toContain('!m.rotaPublica');
    for (const proibida of ['/commerce/loja-publica', '/commerce/storefront', '/commerce/vitrine-publica', '/commerce/abrir-loja']) {
      expect(MODULES.some((m) => m.path === proibida)).toBe(false);
      expect(app).not.toContain(`path="${proibida}"`);
    }
  });

  it('navegação direta: sem modal, dialog, drawer, sheet, overlay ou iframe', () => {
    const novos = fonte('src/modules.ts');
    expect(novos).not.toMatch(/target=["']_blank["']/);
    expect(app).not.toMatch(/<iframe\b/i);
    expect(novos).not.toMatch(/<(Modal|Dialog|Drawer|Sheet|Overlay)\b/);
  });
});
