import '@testing-library/jest-dom/vitest';

// jsdom não implementa `scrollIntoView` (não há layout/scroll real). Componentes do
// shell usam em efeito (ex.: CommandPalette mantém o item ativo visível), então o
// ambiente de teste recebe um no-op — em navegador o método existe e rola de verdade.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function scrollIntoView() {};
