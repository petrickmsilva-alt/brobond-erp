// ============================================================================
// BROBOND ERP 3.0 — GATE DE UX "ZERO MODAL" (módulo compartilhado)
// ----------------------------------------------------------------------------
// Este arquivo é a REGRA OBJETIVA de arquitetura de UX do ERP:
//
//     É PROIBIDO usar caixa modal para qualquer módulo do BROBOND ERP.
//
// Não se trata de estilo: a proibição é estrutural. O produto padroniza
//
//     LISTA  →  DETALHE  →  NOVO (/recurso/novo)  →  EDIÇÃO (/recurso/:id/editar)
//
// e qualquer superfície sobreposta (`Modal`, `Dialog`, `Drawer`, `Sheet`,
// `role="dialog"`, `aria-modal`, backdrop `fixed inset-0`) reintroduz o padrão
// que foi removido — inclusive quando é "só uma confirmaçãozinha".
//
// COMO O GATE FUNCIONA
//   1. Varre `client/src/**` procurando as assinaturas de sobreposição.
//   2. Compara o resultado com a lista de exceções declaradas abaixo.
//   3. Falha (exit 1) se:
//        • aparecer assinatura em arquivo que não está na lista;
//        • a contagem de um arquivo AUMENTAR em relação ao baseline;
//        • existir export `Modal`/`Dialog`/`Drawer`/`Sheet` no design system;
//        • um módulo com CRUD genérico não tiver as rotas de cadastro/edição.
//
// DIFERENÇA ENTRE "SOBREPOSIÇÃO DE FLUXO" E "INFRAESTRUTURA NÃO-VISUAL"
//   O gate não é cego: ele reconhece explicitamente as exceções que NÃO são
//   fluxo de módulo (navegação, captura de clique invisível, páginas públicas).
//   Cada exceção tem motivo escrito e contagem máxima — crescer exige mudar
//   este arquivo de propósito, com revisão.
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** Assinaturas que denunciam sobreposição de interface. */
export const ASSINATURAS = [
  { id: 'role-dialog', regex: /role=["']dialog["']/g, descricao: 'role="dialog"' },
  { id: 'aria-modal', regex: /aria-modal=["']true["']/g, descricao: 'aria-modal="true"' },
  { id: 'overlay-fixo', regex: /fixed\s+inset-0/g, descricao: 'backdrop/overlay fixed inset-0' },
  { id: 'componente-modal', regex: /<Modal\b|<Dialog\b|<Drawer\b|<Sheet\b/g, descricao: 'componente Modal/Dialog/Drawer/Sheet' },
];

/**
 * Exceções declaradas. `padroes` é a contagem MÁXIMA tolerada por assinatura —
 * o gate falha se crescer. Toda exceção precisa de motivo de negócio/técnico.
 */
export const EXCECOES = [
  {
    arquivo: 'client/src/components/CommandPalette.tsx',
    motivo:
      'Navegação global (Ctrl+K): busca de módulos e ações, sem cadastro, edição ou detalhe de registro. Não é fluxo de módulo — é atalho de navegação, como o menu lateral.',
    padroes: { 'role-dialog': 1, 'aria-modal': 1, 'overlay-fixo': 1 },
  },
  {
    arquivo: 'client/src/components/Sidebar.tsx',
    motivo:
      'Backdrop do menu de navegação no celular. É navegação (a mesma árvore de módulos do desktop), não formulário: nenhum CRUD vive ali.',
    padroes: { 'overlay-fixo': 1 },
  },
  {
    arquivo: 'client/src/components/Layout.tsx',
    motivo:
      'Comentário/estrutura do drawer de navegação mobile (reenvia ao Sidebar). Nenhum conteúdo de negócio é renderizado aqui.',
    padroes: {},
  },
  {
    arquivo: 'client/src/pages/UsuariosPage.tsx',
    motivo:
      'Captura invisível de clique fora do menu de ações da linha (elemento sem conteúdo visual, `cursor-default`). Não é overlay de conteúdo.',
    padroes: { 'overlay-fixo': 1 },
  },
  {
    arquivo: 'client/src/pages/PortalCliente.tsx',
    motivo:
      'Portal PÚBLICO do cliente (fora do ERP, rota /portal/:token): página do cliente final, que lê o pedido e responde a proposta. Não é módulo do ERP nem cadastro interno.',
    padroes: { 'overlay-fixo': 1 },
  },
  {
    arquivo: 'client/src/pages/CatalogoPublico.tsx',
    motivo:
      'Catálogo PÚBLICO compartilhável (rota /catalogo/:token): visualização de produtos e carrinho do cliente final — fora do ERP e sem cadastro interno. A ampliação da foto do produto e o carrinho continuam sobrepostos de propósito: é a experiência de compra do cliente, não um fluxo de módulo.',
    padroes: { 'overlay-fixo': 3, 'role-dialog': 1, 'aria-modal': 1 },
  },
];

/** Componentes proibidos no design system (o ERP não exporta modal nenhum). */
const EXPORTS_PROIBIDOS = [
  /\bexport\s+function\s+Modal\b/,
  /\bexport\s+function\s+Dialog\b/,
  /\bexport\s+function\s+Drawer\b/,
  /\bexport\s+function\s+Sheet\b/,
  /\bexport\s+function\s+ConfirmDialog\b/,
];

function walk(dir, out = []) {
  for (const entrada of readdirSync(dir)) {
    if (['node_modules', 'dist', 'coverage', '.git', '.vite'].includes(entrada)) continue;
    const p = path.join(dir, entrada);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const contar = (texto, regex) => (texto.match(regex) ?? []).length;

/**
 * Remove comentários antes de procurar assinaturas: comentário que CITA o
 * padrão proibido (para explicar por que ele não existe mais) não é
 * implementação do padrão. Sem isso o gate puniria a própria documentação.
 */
function semComentarios(texto) {
  return texto.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * Executa o gate.
 * @returns {{ ok: boolean, violacoes: string[], resumo: Array<{arquivo:string,padrao:string,qtd:number}> }}
 */
export function auditarUx(raiz) {
  const dir = path.join(raiz, 'client', 'src');
  const arquivos = walk(dir).filter((f) => /\.(tsx?|jsx?)$/.test(f) && !/\.test\.(tsx?|jsx?)$/.test(f));
  const excecoes = new Map(EXCECOES.map((e) => [e.arquivo, e]));
  const violacoes = [];
  const resumo = [];

  for (const abs of arquivos) {
    const rel = path.relative(raiz, abs).split(path.sep).join('/');
    const texto = semComentarios(readFileSync(abs, 'utf8'));
    const excecao = excecoes.get(rel);
    for (const assinatura of ASSINATURAS) {
      const qtd = contar(texto, assinatura.regex);
      if (!qtd) continue;
      resumo.push({ arquivo: rel, padrao: assinatura.descricao, qtd });
      const permitido = excecao?.padroes?.[assinatura.id] ?? 0;
      if (qtd > permitido) {
        violacoes.push(
          `${rel}: ${qtd}× ${assinatura.descricao} (permitido: ${permitido})` +
            (excecao ? ` — exceção declarada: ${excecao.motivo}` : ' — arquivo sem exceção declarada em scripts/ux-guard.mjs')
        );
      }
    }
  }

  // O design system não pode voltar a exportar primitivas de sobreposição.
  for (const rel of ['client/src/components/ui.tsx', 'client/src/components/ui-kit.tsx', 'client/src/components/ui-kit-negocios.tsx']) {
    const texto = readFileSync(path.join(raiz, rel), 'utf8');
    for (const re of EXPORTS_PROIBIDOS) {
      if (re.test(texto)) violacoes.push(`${rel}: exporta uma primitiva proibida (${re.source}) — use ConfirmacaoInline/PainelInline`);
    }
  }

  // Toda página/rota de módulo com CRUD genérico precisa existir como PÁGINA.
  const app = readFileSync(path.join(raiz, 'client', 'src', 'App.tsx'), 'utf8');
  if (!app.includes('usaCrudGenerico')) {
    violacoes.push('client/src/App.tsx: rotas genéricas de cadastro/edição ausentes (usaCrudGenerico) — o CRUD voltaria para a modal');
  }
  const registro = readFileSync(path.join(raiz, 'client', 'src', 'pages', 'RegistroPage.tsx'), 'utf8');
  if (!registro.includes('RecordForm')) {
    violacoes.push('client/src/pages/RegistroPage.tsx: a página de cadastro precisa reutilizar o mesmo RecordForm (sem formulário duplicado)');
  }

  return { ok: violacoes.length === 0, violacoes, resumo };
}
