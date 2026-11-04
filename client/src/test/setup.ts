import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// Rotas são carregadas com `lazy()` (App.tsx → ModulePage e páginas dedicadas). Na primeira
// renderização de cada arquivo, o módulo é transformado sob demanda; em runner de 2 vCPU com
// outros arquivos em paralelo isso passa de 1 s (timeout padrão de `findBy*`) e o teste falha
// sem que a rota esteja errada (CI: RepresentantesRoute.test.tsx e ComercialRoutes.test.tsx,
// reproduzido com cache frio + carga). Ampliamos apenas a espera assíncrona; asserções inalteradas.
configure({ asyncUtilTimeout: 5000 });

// jsdom não implementa `scrollIntoView` (não há layout/scroll real). Componentes do
// shell usam em efeito (ex.: CommandPalette mantém o item ativo visível), então o
// ambiente de teste recebe um no-op — em navegador o método existe e rola de verdade.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function scrollIntoView() {};
