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
// `<dialog>`, `showModal()`, `role="dialog"`, `aria-modal`, backdrop
// `fixed inset-0`) reintroduz o padrão que foi removido — inclusive quando é
// "só uma confirmaçãozinha".
//
// COMO O GATE FUNCIONA (v2 — baseline objetivo em JSON)
//   1. Lê `docs/ERP-3.0-UX-BASELINE.json` — a ÚNICA fonte de exceções.
//   2. Valida o próprio baseline: categoria permitida, motivo com conteúdo,
//      contagens coerentes, arquivo existente e nenhuma exceção para
//      cadastro/edição/exclusão/detalhe/seleção/formulário/workflow.
//   3. Varre `client/src/**` procurando as assinaturas de sobreposição.
//   4. Falha (exit 1) se BASELINE + QUALQUER OCORRÊNCIA NOVA:
//        • assinatura em arquivo que não está no baseline;
//        • contagem por arquivo acima da declarada;
//        • total por assinatura acima do declarado;
//        • export de primitiva proibida no design system;
//        • módulo com CRUD genérico sem rota de cadastro/edição.
//
// O QUE **NÃO** É VIOLÂNCIA
//   · Texto, comentário ou documentação que MENCIONA modal/dialog (o gate
//     remove comentários antes de procurar; string em prosa também não é
//     assinatura de componente).
//   · Exceções declaradas no baseline (navegação global, menu mobile,
//     infraestrutura, portal público, catálogo público).
//   · NUNCA: cadastro, edição, confirmação de exclusão, detalhe, seleção,
//     formulário ou etapa de workflow. Essas categorias não existem no
//     baseline e o gate recusa qualquer tentativa de criá-las.
// ============================================================================
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Caminho do baseline, relativo à raiz do repositório. */
export const CAMINHO_BASELINE = 'docs/ERP-3.0-UX-BASELINE.json';

/**
 * Categorias de exceção que o baseline pode declarar. Qualquer outra é
 * recusada — inclusive (e principalmente) "fluxo de módulo".
 */
export const CATEGORIAS_PERMITIDAS = [
  'navegacao_global',
  'menu_mobile',
  'infraestrutura',
  'portal_publico',
  'catalogo_publico',
];

/**
 * Assinaturas que denunciam sobreposição de interface.
 * `implementacao` = o que de fato caracteriza o padrão (o gate procura isso).
 */
export const ASSINATURAS = [
  { id: 'role-dialog', regex: /role=["']dialog["']/g, descricao: 'role="dialog"' },
  { id: 'role-alertdialog', regex: /role=["']alertdialog["']/g, descricao: 'role="alertdialog"' },
  { id: 'aria-modal', regex: /aria-modal=["']true["']/g, descricao: 'aria-modal="true"' },
  {
    id: 'overlay-fixo',
    regex: /(?:className|class)\s*=\s*["'`][^"'`]*\bfixed\b[^"'`]*\binset-0\b/g,
    descricao: 'backdrop/overlay fixed inset-0',
  },
  {
    id: 'overlay-fixo-inverso',
    regex: /(?:className|class)\s*=\s*["'`][^"'`]*\binset-0\b[^"'`]*\bfixed\b/g,
    descricao: 'backdrop/overlay inset-0 + fixed (ordem invertida)',
  },
  {
    // `inset-x-0` + `inset-y-0` juntos = tela inteira (mesmo efeito de
    // `inset-0`). Um `fixed inset-x-0 bottom-0` é barra fixa, não overlay —
    // por isso a assinatura exige os DOIS eixos, para não punir barra de ação.
    id: 'overlay-eixos',
    regex: /(?:className|class)\s*=\s*["'`][^"'`]*\binset-x-0\b[^"'`]*\binset-y-0\b[^"'`]*/g,
    descricao: 'backdrop/overlay com inset-x-0 + inset-y-0 (tela inteira)',
  },
  { id: 'elemento-dialog', regex: /<dialog[\s>]/g, descricao: 'elemento nativo <dialog>' },
  { id: 'show-modal', regex: /\.showModal\s*\(/g, descricao: 'HTMLDialogElement.showModal()' },
  {
    id: 'componente-modal',
    regex: /<(?:Modal|Dialog|Drawer|Sheet|AlertDialog|ModalRoot|DialogRoot|DialogContent|ModalContent|DrawerContent|SheetContent)\b/g,
    descricao: 'componente de sobreposição (Modal/Dialog/Drawer/Sheet)',
  },
  { id: 'portal', regex: /\bcreatePortal\s*\(/g, descricao: 'createPortal (renderiza fora da árvore da página)' },
  { id: 'browser-dialog-api', regex: /\bwindow\.(?:confirm|prompt|alert)\s*\(/g, descricao: 'window.confirm/prompt/alert (fluxo operacional bloqueante)' },
];

/** Componentes proibidos no design system (o ERP não exporta sobreposição nenhuma). */
const EXPORTS_PROIBIDOS = [
  /\bexport\s+(?:default\s+)?(?:function|const|class)\s+Modal\b/,
  /\bexport\s+(?:default\s+)?(?:function|const|class)\s+Dialog\b/,
  /\bexport\s+(?:default\s+)?(?:function|const|class)\s+Drawer\b/,
  /\bexport\s+(?:default\s+)?(?:function|const|class)\s+Sheet\b/,
  /\bexport\s+(?:default\s+)?(?:function|const|class)\s+AlertDialog\b/,
  /\bexport\s+(?:default\s+)?(?:function|const|class)\s+ConfirmDialog\b/,
  /\bexport\s+(?:default\s+)?(?:function|const|class)\s+ConfirmModal\b/,
  /\bexport\s+(?:default\s+)?(?:function|const|class)\s+Dialog(?:Root|Content|Title|Overlay)\b/,
  /\bexport\s+(?:default\s+)?(?:function|const|class)\s+Modal(?:Root|Content|Overlay)\b/,
  /\bexport\s+(?:default\s+)?(?:function|const|class)\s+Sheet(?:Root|Content)\b/,
  /\bexport\s+(?:default\s+)?(?:function|const|class)\s+(?:Overlay|Backdrop)\b/,
];

/** Arquivos do design system que não podem exportar primitiva de sobreposição. */
const ARQUIVOS_DESIGN_SYSTEM = [
  'client/src/components/ui.tsx',
  'client/src/components/ui-kit.tsx',
  'client/src/components/ui-kit-negocios.tsx',
];

/**
 * Caminhos que NUNCA podem receber exceção: são exatamente os fluxos de
 * módulo que a regra ZERO MODAL protege. Se um dia alguém tentar declarar
 * exceção para um deles, o gate acusa o baseline — não o código.
 */
const CAMINHOS_PROIBIDOS_EM_EXCECAO = [
  /(?:^|\/)RegistroPage\.tsx$/,
  /(?:^|\/)RecordForm\.tsx$/,
  /Form(?:ulario)?(?:Page)?\.tsx$/i,
  /(?:Novo|Edicao|Editar|Cadastro|Detalhe|Exclusao|Confirmacao|Selecao)(?:Page)?\.tsx$/i,
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

/** Carrega e valida o baseline. Erros aqui são violações (o baseline é código). */
export function carregarBaseline(raiz) {
  const abs = path.join(raiz, CAMINHO_BASELINE);
  const violacoes = [];
  if (!existsSync(abs)) {
    return {
      baseline: { versao: 0, excecoes: [], totais: {} },
      violacoes: [`${CAMINHO_BASELINE}: baseline ausente — sem ele o gate não tem o que comparar`],
    };
  }
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    return {
      baseline: { versao: 0, excecoes: [], totais: {} },
      violacoes: [`${CAMINHO_BASELINE}: JSON inválido — ${(e && e.message) || e}`],
    };
  }

  const excecoes = Array.isArray(baseline.exceptions) ? baseline.exceptions : Array.isArray(baseline.excecoes) ? baseline.excecoes : [];
  const ids = new Set(ASSINATURAS.map((a) => a.id));
  const vistos = new Set();

  if (Number(baseline.version ?? baseline.versao) >= 3) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(baseline.date ?? ''))) violacoes.push(`${CAMINHO_BASELINE}: date ausente ou inválida (AAAA-MM-DD)`);
    if (!Array.isArray(baseline.rules) || baseline.rules.length < 1 || baseline.rules.some((r) => typeof r !== 'string' || !r.trim())) violacoes.push(`${CAMINHO_BASELINE}: rules deve conter regras executáveis documentadas`);
    if (!baseline.allowed_patterns || typeof baseline.allowed_patterns !== 'object') violacoes.push(`${CAMINHO_BASELINE}: allowed_patterns ausente`);
    if (JSON.stringify(baseline.allowed_patterns?.exception_categories ?? []) !== JSON.stringify(CATEGORIAS_PERMITIDAS)) violacoes.push(`${CAMINHO_BASELINE}: exception_categories deve corresponder à lista fechada suportada pelo gate`);
    if (!Array.isArray(baseline.forbidden_patterns) || baseline.forbidden_patterns.length < 1) violacoes.push(`${CAMINHO_BASELINE}: forbidden_patterns ausente`);
    if (!Array.isArray(baseline.exceptions)) violacoes.push(`${CAMINHO_BASELINE}: exceptions deve ser a lista única e explícita de exceções`);
    const resourceRoutes = baseline.allowed_patterns?.resource_routes;
    for (const key of ['list', 'create', 'detail', 'edit']) {
      if (typeof resourceRoutes?.[key] !== 'string' || !resourceRoutes[key].startsWith('/')) violacoes.push(`${CAMINHO_BASELINE}: padrão de rota '${key}' ausente/inválido`);
    }
    const declarados = new Set((baseline.forbidden_patterns ?? []).map((p) => String(p).toLowerCase()));
    for (const proibido of ['modal', 'dialog', 'drawer', 'sheet', 'overlay', 'createportal(', 'window.confirm(', 'window.prompt(', 'window.alert(']) {
      if (![...declarados].some((p) => p.includes(proibido))) violacoes.push(`${CAMINHO_BASELINE}: forbidden_patterns não declara '${proibido}'`);
    }
  }

  for (const [i, e] of excecoes.entries()) {
    const rotulo = `${CAMINHO_BASELINE}: exceção #${i + 1} (${e?.arquivo ?? 'sem arquivo'})`;
    if (!e || typeof e !== 'object') {
      violacoes.push(`${rotulo}: entrada inválida`);
      continue;
    }
    if (!e.arquivo) violacoes.push(`${rotulo}: falta \`arquivo\``);
    if (typeof e.arquivo === 'string' && /[*?]/.test(e.arquivo)) violacoes.push(`${rotulo}: wildcard não é permitido em exceções`);
    if (vistos.has(e.arquivo)) violacoes.push(`${rotulo}: arquivo duplicado no baseline`);
    vistos.add(e.arquivo);
    if (e.arquivo && !existsSync(path.join(raiz, e.arquivo))) {
      violacoes.push(`${rotulo}: arquivo declarado não existe — remova a exceção morta`);
    }
    if (!CATEGORIAS_PERMITIDAS.includes(e.categoria)) {
      violacoes.push(
        `${rotulo}: categoria "${e.categoria ?? '(ausente)'}" não é permitida. ` +
          `Aceitas: ${CATEGORIAS_PERMITIDAS.join(', ')}. Fluxo de módulo (cadastro, edição, exclusão, detalhe, seleção, formulário, workflow) NÃO tem categoria.`
      );
    }
    const motivo = typeof e.motivo === 'string' ? e.motivo.trim() : '';
    if (motivo.length < 40) {
      violacoes.push(`${rotulo}: \`motivo\` precisa justificar a exceção (mínimo 40 caracteres)`);
    }
    if (e.arquivo && CAMINHOS_PROIBIDOS_EM_EXCECAO.some((re) => re.test(e.arquivo))) {
      violacoes.push(`${rotulo}: este caminho é fluxo de módulo (formulário/cadastro/detalhe) e NUNCA pode ser exceção`);
    }
    const padroes = e.padroes && typeof e.padroes === 'object' ? e.padroes : {};
    for (const [id, qtd] of Object.entries(padroes)) {
      if (!ids.has(id)) {
        violacoes.push(`${rotulo}: assinatura desconhecida "${id}" (o gate não a mede)`);
      }
      if (typeof qtd !== 'number' || !Number.isInteger(qtd) || qtd < 0) {
        violacoes.push(`${rotulo}: contagem inválida para "${id}" (${JSON.stringify(qtd)})`);
      }
    }
  }

  const totais = baseline.totais && typeof baseline.totais === 'object' ? baseline.totais : {};
  for (const [id, qtd] of Object.entries(totais)) {
    if (!ids.has(id)) violacoes.push(`${CAMINHO_BASELINE}: total declarado para assinatura desconhecida "${id}"`);
    if (typeof qtd !== 'number' || !Number.isInteger(qtd) || qtd < 0) {
      violacoes.push(`${CAMINHO_BASELINE}: total inválido para "${id}"`);
    }
  }

  return { baseline, violacoes };
}

/**
 * Executa o gate.
 * @returns {{ ok: boolean, violacoes: string[], resumo: Array<{arquivo:string,padrao:string,qtd:number}>, excecoes: any[], totais: Record<string,number>, avisos: string[] }}
 */
export function auditarUx(raiz) {
  const dir = path.join(raiz, 'client', 'src');
  const arquivos = walk(dir).filter((f) => /\.(tsx?|jsx?)$/.test(f) && !/\.test\.(tsx?|jsx?)$/.test(f));

  const { baseline, violacoes: violacoesBaseline } = carregarBaseline(raiz);
  const violacoes = [...violacoesBaseline];
  const avisos = [];
  const excecoes = Array.isArray(baseline.exceptions) ? baseline.exceptions : Array.isArray(baseline.excecoes) ? baseline.excecoes : [];
  const excecoesPorArquivo = new Map(excecoes.map((e) => [e.arquivo, e]));
  const resumo = [];
  const totais = Object.fromEntries(ASSINATURAS.map((a) => [a.id, 0]));

  for (const abs of arquivos) {
    const rel = path.relative(raiz, abs).split(path.sep).join('/');
    const texto = semComentarios(readFileSync(abs, 'utf8'));
    const excecao = excecoesPorArquivo.get(rel);
    for (const assinatura of ASSINATURAS) {
      const qtd = contar(texto, assinatura.regex);
      if (!qtd) continue;
      totais[assinatura.id] += qtd;
      resumo.push({ arquivo: rel, padrao: assinatura.descricao, id: assinatura.id, qtd });
      const permitido = excecao?.padroes?.[assinatura.id] ?? 0;
      if (qtd > permitido) {
        violacoes.push(
          `${rel}: ${qtd}× ${assinatura.descricao} (baseline permite: ${permitido})` +
            (excecao
              ? ` — a exceção existe, mas a contagem CRESCEU (categoria: ${excecao.categoria})`
              : ` — arquivo fora do baseline (${CAMINHO_BASELINE})`)
        );
      }
    }
  }

  // Total por assinatura: baseline + ocorrência nova = falha, mesmo que por
  // arquivo cada um esteja dentro do permitido (ex.: nova ocorrência num
  // arquivo já listado com folga).
  for (const assinatura of ASSINATURAS) {
    const declarado = baseline.totais?.[assinatura.id];
    const medido = totais[assinatura.id];
    if (typeof declarado !== 'number') continue;
    if (medido > declarado) {
      violacoes.push(
        `${assinatura.descricao}: ${medido}× no repositório, baseline declara ${declarado}× — ocorrência nova não justificada`
      );
    } else if (medido < declarado) {
      avisos.push(
        `${assinatura.descricao}: ${medido}× medido, baseline declara ${declarado}× — atualize \`totais\` no baseline (sobra tolerada, falta não)`
      );
    }
  }

  // O design system não pode voltar a exportar primitivas de sobreposição.
  for (const rel of ARQUIVOS_DESIGN_SYSTEM) {
    const abs = path.join(raiz, rel);
    if (!existsSync(abs)) continue;
    const texto = semComentarios(readFileSync(abs, 'utf8'));
    for (const re of EXPORTS_PROIBIDOS) {
      if (re.test(texto)) violacoes.push(`${rel}: exporta uma primitiva proibida (${re.source}) — use ConfirmacaoInline/PainelInline`);
    }
  }

  // Toda página/rota de módulo com CRUD genérico precisa existir como PÁGINA.
  const app = readFileSync(path.join(raiz, 'client', 'src', 'App.tsx'), 'utf8');
  if (Number(baseline.version ?? baseline.versao) >= 3) {
    if (!app.includes('`${base}/novo`')) violacoes.push('client/src/App.tsx: rota /recurso/novo não está ligada ao CRUD genérico');
    if (!app.includes('`${base}/:id/editar`')) violacoes.push('client/src/App.tsx: rota /recurso/:id/editar não está ligada ao CRUD genérico');
    const detail = baseline.allowed_patterns?.resource_routes?.detail;
    if (detail !== '/recurso/:id') violacoes.push(`${CAMINHO_BASELINE}: rota de detalhe deve ser /recurso/:id`);
  }
  if (!app.includes('usaCrudGenerico')) {
    violacoes.push('client/src/App.tsx: rotas genéricas de cadastro/edição ausentes (usaCrudGenerico) — o CRUD voltaria para a modal');
  }
  const registro = readFileSync(path.join(raiz, 'client', 'src', 'pages', 'RegistroPage.tsx'), 'utf8');
  if (!registro.includes('RecordForm')) {
    violacoes.push('client/src/pages/RegistroPage.tsx: a página de cadastro precisa reutilizar o mesmo RecordForm (sem formulário duplicado)');
  }

  return { ok: violacoes.length === 0, violacoes, resumo, excecoes, totais, avisos };
}

/** Compatibilidade: lista de exceções do baseline (usada pelo relatório). */
export const EXCECOES = (() => {
  try {
    const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    return JSON.parse(readFileSync(path.join(raiz, CAMINHO_BASELINE), 'utf8')).exceptions ?? [];
  } catch {
    return [];
  }
})();
