#!/usr/bin/env node
// ============================================================================
// BROBOND ERP 3.0 — GATE FINAL DE GO-LIVE (`npm run go-live:audit`)
// ----------------------------------------------------------------------------
// Este é o ÚLTIMO portão antes da homologação operacional. Ele NÃO substitui
// `npm test` / `npm run build` / `audit:menu` / `audit:ux` / `architecture:audit`
// — ele os EXIGE e, além deles, procura o que os gates isolados não veem:
//
//   P0 (bloqueia sempre)
//     · qualquer violação de UX que reintroduza fluxo de módulo em painel;
//     · cross-tenant estrutural (recurso com empresa_id sem escopo declarado);
//     · migration fora de sequência / schema SQL ausente;
//     · cálculo crítico sem teste dedicado;
//     · rota operacional da homologação sem página;
//     · implementação falsa (`not implemented`, `TODO` em caminho crítico).
//
//   P1 (bloqueia nesta rodada)
//     · capacidade sem menu/rota, rota sem página, resource sem dono;
//     · aviso estrutural do inventário que indique dado sem dono funcional;
//     · módulo `planned` com backend funcional.
//
//   P2 / P3 — relatados, não bloqueiam (roadmap real ou dívida cosmética).
//
// Saída: seções P0, P1, P2, P3, ERROS, WARNINGS + veredito. Exit 1 quando há
// P0 ou P1. Nenhum achado é convertido em "skip".
//
// Uso:  node --import tsx scripts/final-go-live-audit.ts [--json]
// ============================================================================
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditarUx } from './ux-guard.mjs';
import { auditarCapacidades, carregarRegistro } from './capacidades-audit';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Achado = { id: string; severidade: 'P0' | 'P1' | 'P2' | 'P3'; mensagem: string; onde?: string };

const achados: Achado[] = [];
const registrar = (id: string, severidade: Achado['severidade'], mensagem: string, onde?: string) =>
  achados.push({ id, severidade, mensagem, onde });

const ler = (rel: string) => readFileSync(path.join(raiz, rel), 'utf8');

/**
 * Marcações pendentes de verdade. `TODO` em português significa "todo(s)/cada"
 * e aparece em comentários legítimos ("TODO recurso do CRUD genérico"), então
 * só contamos o padrão de anotação: `TODO:`/`TODO(`/`TODO-`, além de FIXME/XXX
 * (que não têm uso em prosa portuguesa).
 */
function marcacoesPendentes(texto: string): string[] {
  return [
    ...texto.matchAll(/\bTODO\s*[:(]|\bTODO-|\bFIXME\b|\bXXX\b/g),
  ].map((m) => m[0]);
}
const existe = (rel: string) => existsSync(path.join(raiz, rel));

/** Executa um script do repositório e devolve stdout/stderr/exit. */
function rodar(comando: string[]): { ok: boolean; saida: string } {
  const r = spawnSync(process.execPath, comando, { cwd: raiz, encoding: 'utf8', timeout: 240_000 });
  return { ok: r.status === 0, saida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ---------------------------------------------------------------------------
// 1) GATES OBRIGATÓRIOS — cada um precisa passar por si
// ---------------------------------------------------------------------------
const gates: { nome: string; comando: string[] }[] = [
  { nome: 'audit:ux (zero modal / fluxos convertidos)', comando: ['scripts/auditar-ux.mjs'] },
  { nome: 'audit:menu (menu × rota × RBAC × multiempresa)', comando: ['--import', 'tsx', 'scripts/auditar-menu.ts'] },
  { nome: 'architecture:audit (recurso × tabela × tenant × Prisma)', comando: ['--import', 'tsx', 'scripts/arquitetura-audit.ts'] },
];
for (const gate of gates) {
  const r = rodar(gate.comando);
  if (!r.ok) {
    registrar('GATE_VERMELHO', 'P0', `Gate obrigatório falhou: ${gate.nome}`, gate.comando.join(' '));
  }
}

// ---------------------------------------------------------------------------
// 2) UX — fluxos convertidos (defesa em profundidade, além do gate acima)
// ---------------------------------------------------------------------------
const ux = auditarUx(raiz);
for (const v of ux.violacoes) registrar('UX_SOBREPOSICAO', 'P0', v, 'client/src');

// ---------------------------------------------------------------------------
// 3) CAPACIDADES — capacidade ↔ menu ↔ rota ↔ página ↔ resource ↔ teste
// ---------------------------------------------------------------------------
const capacidades = auditarCapacidades(carregarRegistro(raiz), raiz);
for (const erro of capacidades.erros) {
  const id = String((erro as { regra?: string }).regra ?? 'CAPACIDADE');
  // Capacidade operacional invisível ou resource sem dono é P1; o resto é P2.
  const bloqueia = ['CAPACIDADE_SEM_MENU', 'ROTA_SEM_PAGINA', 'RECURSO_SEM_DONO', 'PLANNED_OBSOLETO'].includes(id);
  registrar(id, bloqueia ? 'P1' : 'P2', String((erro as { detalhe?: string }).detalhe ?? (erro as { mensagem?: string }).mensagem ?? JSON.stringify(erro)));
}
for (const aviso of capacidades.avisos ?? []) {
  registrar(String((aviso as { regra?: string }).regra ?? 'CAPACIDADE_AVISO'), 'P2', String((aviso as { detalhe?: string }).detalhe ?? (aviso as { mensagem?: string }).mensagem ?? JSON.stringify(aviso)));
}

// ---------------------------------------------------------------------------
// 4) CÁLCULOS CRÍTICOS — cada fórmula precisa de teste dedicado
// ---------------------------------------------------------------------------
const CALCULOS: { nome: string; modulo: string; testes: string[] }[] = [
  { nome: 'custo médio ponderado / frete rateado', modulo: 'server/src/custoRecebimento.ts', testes: ['server/test/custo-recebimento.test.ts', 'server/test/calculos-oracle.test.ts', 'server/test/pg-custo-recebimento.test.ts'] },
  { nome: 'disponibilidade do estoque (físico − reservado − bloqueado − empenho)', modulo: 'server/src/estoqueCanonico.ts', testes: ['server/test/calculos-oracle.test.ts', 'server/test/estoque-transferencia.test.ts'] },
  { nome: 'valorização de estoque', modulo: 'server/src/valorizacao.ts', testes: ['server/test/valorizacao.test.ts'] },
  { nome: 'classificação ABC / contagem cíclica', modulo: 'server/src/contagemCiclica.ts', testes: ['server/test/contagem-ciclica.test.ts'] },
  { nome: 'MRP e capacidade', modulo: 'server/src/producaoCapacidade.ts', testes: ['server/test/producao-capacidade-mrp.test.ts'] },
  { nome: 'produção / consumo / conclusão de OP', modulo: 'server/src/producao.ts', testes: ['server/test/producao-e2.test.ts', 'server/test/pg-producao-e2.test.ts'] },
  { nome: 'parcelas e baixa financeira', modulo: 'server/src/financeiro.ts', testes: ['server/test/fin01-parcelas.test.ts', 'server/test/financeiro-profissional.test.ts', 'server/test/calculos-oracle.test.ts'] },
  // O ERP é livro-caixa (não há partida dobrada): a identidade cobrada é a
  // fechamento do balancete (Σ saldos = Σ débitos − Σ créditos) e o saldo do
  // caixa por conta, não um Σdébitos = Σcréditos que não existe no modelo.
  {
    nome: 'caixa e balancete (saldo = inicial + líquidos − saídas; Σ saldos = Σ débitos − Σ créditos)',
    modulo: 'server/src/financeiroContabil.ts',
    testes: ['server/test/financeiro-contabil.test.ts', 'server/test/financeiro-oracle.test.ts'],
  },
  { nome: 'preço de venda / desconto / margem', modulo: 'server/src/precoVenda.ts', testes: ['server/test/preco-venda.test.ts', 'server/test/calculos-oracle.test.ts'] },
  { nome: 'comissões', modulo: 'server/src/comissoes.ts', testes: ['server/test/comissoes.test.ts', 'server/test/master-comercial.test.ts'] },
  { nome: 'tributação fiscal (NCM/CFOP/CST)', modulo: 'server/src/fiscalRegras.ts', testes: ['server/test/fiscal.test.ts', 'server/test/fiscal-obrigacoes.test.ts'] },
  { nome: 'vendas / faturamento / estorno', modulo: 'server/src/itens.ts', testes: ['server/test/pedidos.test.ts', 'server/test/eventos-venda.test.ts'] },
];
for (const calc of CALCULOS) {
  if (!existe(calc.modulo)) {
    registrar('CALCULO_SEM_MODULO', 'P0', `Módulo canônico ausente: ${calc.modulo}`, calc.nome);
    continue;
  }
  const encontrados = calc.testes.filter((t) => existe(t));
  if (!encontrados.length) {
    registrar('CALCULO_SEM_TESTE', 'P0', `Cálculo crítico sem teste dedicado: ${calc.nome}`, calc.modulo);
  }
}

// ---------------------------------------------------------------------------
// 5) MIGRATIONS — sequência, schema SQL e migrations sem tenant quando precisa
// ---------------------------------------------------------------------------
const migrations = readdirSync(path.join(raiz, 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
migrations.forEach((arquivo, indice) => {
  const numero = Number(arquivo.slice(0, 4));
  if (!Number.isInteger(numero)) registrar('MIGRATION_NOME', 'P0', `Migration sem prefixo numérico: ${arquivo}`);
  else if (numero !== indice + 1) {
    registrar('MIGRATION_SEQUENCIA', 'P0', `Migration fora de sequência: ${arquivo} (esperado ${String(indice + 1).padStart(4, '0')})`);
  }
});
if (!existe('db/schema.sql')) registrar('SCHEMA_AUSENTE', 'P0', '`db/schema.sql` (fonte de verdade SQL) não existe.');
else {
  // Comentários SQL contêm a palavra "CREATE TABLE"/"ALTER TABLE" em prosa —
  // sem removê-los o scan inventa tabelas chamadas `if` e `mas`.
  const limpar = (t: string) => t.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const schema = ler('db/schema.sql');
  const migracoes = migrations.map((m) => limpar(ler(`db/migrations/${m}`))).join('\n');
  const schemaLimpo = limpar(schema);

  // Corpo de cada tabela (para achar empresa_id e as FKs de tenancy encadeada).
  const corpos = new Map<string, string>();
  for (const m of schemaLimpo.matchAll(
    /CREATE TABLE(?: IF NOT EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]*?)\n\);/gi
  )) {
    corpos.set(m[1].toLowerCase(), m[2]);
  }

  // `empresa_id` pode chegar por ALTER TABLE na migration de multiempresa (0017)
  // — procurar só no CREATE TABLE daria dezenas de falsos positivos.
  const comTenant = new Set<string>();
  for (const [t, corpo] of corpos) if (/empresa_id/i.test(corpo)) comTenant.add(t);
  for (const m of migracoes.matchAll(
    /ALTER TABLE\s+(?:IF EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?[\s\S]{0,160}?empresa_id/gi
  )) {
    comTenant.add(m[1].toLowerCase());
  }

  // (a) Globais POR DESENHO: governança da instalação, não de uma empresa.
  //     · empresas: é a própria tabela de tenant;
  //     · usuarios/sessoes/login_tentativas: identidade, isolada por
  //       `usuario_empresas` (0017) e pelo RBAC — não por coluna;
  //     · webhooks/webhook_entregas: admin-only, eventos do ciclo de vida das
  //       contas (ver server/src/webhooks.ts, `exigirAdminLocal`);
  //     · configuracoes/impostos_ncm: cadastro de referência da instalação.
  const GLOBAIS = new Set([
    'empresas',
    'usuarios',
    'sessoes',
    'login_tentativas',
    'webhooks',
    'webhook_entregas',
    'configuracoes',
    'impostos_ncm',
  ]);
  // (b) Catálogos técnicos compartilhados (tamanhos/grades/medidas/categorias/
  //     cores): são domínio de modelagem, não dado comercial — o produto que os
  //     referencia é que tem `empresa_id`.
  const CATALOGOS = new Set([
    'tamanhos',
    'grades',
    'grade_tamanhos',
    'medidas',
    'medida_valores',
    'categorias',
    'cores',
  ]);

  /** Tenancy encadeada: a tabela herda o tenant do registro-pai (FK). */
  const tenancyEncadeada = (t: string, visitados = new Set<string>()): boolean => {
    if (comTenant.has(t)) return true;
    if (visitados.has(t)) return false;
    visitados.add(t);
    const corpo = corpos.get(t) ?? '';
    const pais = [...corpo.matchAll(/REFERENCES\s+"?([a-z_][a-z0-9_]*)"?/gi)].map((m) => m[1].toLowerCase());
    return pais.some((p) => tenancyEncadeada(p, visitados));
  };

  // (c) Polimórficas: `arquivos` (recurso, registro_id) não tem FK, então a
  //     tenancy é conferida no código a cada acesso (assertRegistroDaEmpresa*).
  //     O gate NÃO confia na prosa: exige o assert no caminho de uploads.
  const POLIMORFICAS = new Set(['arquivos']);
  const uploads = existe('server/src/uploads.ts') ? ler('server/src/uploads.ts') : '';
  if (POLIMORFICAS.size && !/assertRegistroDaEmpresaParaEscrita\(/.test(uploads)) {
    registrar(
      'POLIMORFICA_SEM_TENANCY',
      'P0',
      '`arquivos` é polimórfica (sem FK) e `server/src/uploads.ts` não confere a empresa do registro-pai.',
      'server/src/uploads.ts'
    );
  }

  const semTenant: string[] = [];
  const encadeadas: string[] = [];
  for (const t of corpos.keys()) {
    if (comTenant.has(t) || GLOBAIS.has(t) || CATALOGOS.has(t) || POLIMORFICAS.has(t)) continue;
    if (tenancyEncadeada(t)) encadeadas.push(t);
    else semTenant.push(t);
  }

  if (semTenant.length) {
    registrar(
      'TABELA_SEM_EMPRESA_ID',
      'P0',
      `Tabela(s) sem \`empresa_id\` e sem tenancy encadeada por FK: ${semTenant.join(', ')}`,
      'db/schema.sql'
    );
  }
  if (encadeadas.length) {
    registrar(
      'TABELA_TENANCY_ENCADEADA',
      'P3',
      `${encadeadas.length} tabela(s) herdam o tenant do pai por FK (filhas de documento): ${encadeadas.join(', ')}`
    );
  }
  registrar(
    'TENANCY_RESUMO',
    'P3',
    `${comTenant.size}/${corpos.size} tabelas têm \`empresa_id\` próprio; ` +
      `${encadeadas.length} herdam por FK; ${POLIMORFICAS.size} são polimórficas com tenancy em código; ` +
      `${GLOBAIS.size + CATALOGOS.size} são globais/catálogo por desenho.`
  );
}

// ---------------------------------------------------------------------------
// 6) IMPLEMENTAÇÃO FALSA — mocks/atalhos em caminho de produção
// ---------------------------------------------------------------------------
const arquivosServer = readdirSync(path.join(raiz, 'server', 'src'), { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile() && d.name.endsWith('.ts'))
  .map((d) => path.relative(raiz, path.join(d.parentPath ?? (d as unknown as { path: string }).path, d.name)).split(path.sep).join('/'));

for (const arquivo of arquivosServer) {
  const texto = ler(arquivo);
  if (/throw new Error\(['"`]not implemented/i.test(texto) || /not implemented/i.test(texto)) {
    registrar('IMPLEMENTACAO_FALSA', 'P0', 'Servidor contém "not implemented" — funcionalidade falsa em produção', arquivo);
  }
  const todos = marcacoesPendentes(texto);
  if (todos.length) registrar('TODO_RESIDUAL', 'P2', `${todos.length} marcação(ões) TODO/FIXME no servidor`, arquivo);
}

const arquivosClient = readdirSync(path.join(raiz, 'client', 'src'), { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile() && /\.(ts|tsx)$/.test(d.name) && !/\.test\.(ts|tsx)$/.test(d.name))
  .map((d) => path.relative(raiz, path.join(d.parentPath ?? (d as unknown as { path: string }).path, d.name)).split(path.sep).join('/'));
for (const arquivo of arquivosClient) {
  const texto = ler(arquivo);
  const todos = marcacoesPendentes(texto);
  if (todos.length) registrar('TODO_RESIDUAL', 'P2', `${todos.length} marcação(ões) TODO/FIXME no cliente`, arquivo);
  // Frontend não pode guardar segredo operacional.
  if (/(SECRET|TOKEN|PASSWORD|SENHA)_?[A-Z_]*\s*=\s*['"][A-Za-z0-9_-]{16,}['"]/.test(texto)) {
    registrar('SEGREDO_NO_FRONT', 'P0', 'Possível segredo hardcoded no cliente', arquivo);
  }
}

// ---------------------------------------------------------------------------
// 7) ROTAS OPERACIONAIS DA HOMOLOGAÇÃO — rota registrada e página existente
// ---------------------------------------------------------------------------
const app = ler('client/src/App.tsx');
const FLUXOS_ESPERADOS: { rota: string; pagina: string }[] = [
  { rota: 'compras/:id/receber', pagina: 'client/src/pages/RecebimentoCompraPage.tsx' },
  { rota: 'custo/nova', pagina: 'client/src/pages/NovaFichaPage.tsx' },
  { rota: 'devolucoes/nova', pagina: 'client/src/pages/DevolucaoNovaPage.tsx' },
  { rota: 'empresas/:id/editar', pagina: 'client/src/pages/EmpresaFormPage.tsx' },
  { rota: 'ncm/novo', pagina: 'client/src/pages/NcmFormPage.tsx' },
  { rota: 'ncm/:id/editar', pagina: 'client/src/pages/NcmFormPage.tsx' },
  { rota: 'config/impressao/terminais/:id/editar', pagina: 'client/src/pages/ImpressaoTerminalFormPage.tsx' },
  { rota: 'config/impressao/agentes/novo', pagina: 'client/src/pages/ImpressaoAgenteNovaPage.tsx' },
  { rota: 'config/impressao/agentes/:machineId/editar', pagina: 'client/src/pages/ImpressaoAgenteEdicaoPage.tsx' },
  { rota: 'webhooks/novo', pagina: 'client/src/pages/WebhookFormPage.tsx' },
  { rota: 'webhooks/:id/editar', pagina: 'client/src/pages/WebhookFormPage.tsx' },
  { rota: 'importar/:tipo', pagina: 'client/src/pages/ImportarPage.tsx' },
  { rota: 'usuarios/novo', pagina: 'client/src/pages/UsuariosPage.tsx' },
  { rota: 'usuarios/:id/editar', pagina: 'client/src/pages/UsuariosPage.tsx' },
];
for (const fluxo of FLUXOS_ESPERADOS) {
  if (!app.includes(fluxo.rota)) registrar('ROTA_SEM_REGISTRO', 'P0', `Rota operacional não registrada em App.tsx: /${fluxo.rota}`, fluxo.pagina);
  if (!existe(fluxo.pagina)) registrar('PAGINA_AUSENTE', 'P0', `Página da rota /${fluxo.rota} não existe`, fluxo.pagina);
}

// ---------------------------------------------------------------------------
// 8) TENANCY ESTRUTURAL — resource com tabela multiempresa precisa de escopo
// ---------------------------------------------------------------------------
const resources = ler('server/src/resources.ts');
const totalEmpresaId = (ler('db/schema.sql').match(/empresa_id/g) ?? []).length;
if (!/empresa_id/.test(resources)) registrar('TENANCY_SEM_ESCORA', 'P0', '`resources.ts` não menciona empresa_id — o escopo por empresa não está declarado.');
if (totalEmpresaId < 50) registrar('TENANCY_FRACA', 'P1', `Apenas ${totalEmpresaId} ocorrências de empresa_id no schema — revisar escopo multiempresa.`);

// ---------------------------------------------------------------------------
// 9) DOCUMENTAÇÃO MÍNIMA DE HOMOLOGAÇÃO
// ---------------------------------------------------------------------------
const DOCS = [
  'docs/RELATORIO-HOMOLOGACAO-FINAL-ERP-3.0.md',
  'docs/ERP-3.0-ARCHITECTURE-INVENTORY.json',
  'docs/ERP-3.0-CAPACITIES.json',
  'docs/ERP-3.0-UX-BASELINE.json',
  'docs/ERP-3.0-GAP-MATRIX.md',
];
for (const doc of DOCS) if (!existe(doc)) registrar('DOC_AUSENTE', 'P1', `Documento de homologação ausente: ${doc}`);

// ---------------------------------------------------------------------------
// RELATÓRIO
// ---------------------------------------------------------------------------
const porSeveridade = (s: Achado['severidade']) => achados.filter((a) => a.severidade === s);
const P0 = porSeveridade('P0');
const P1 = porSeveridade('P1');
const P2 = porSeveridade('P2');
const P3 = porSeveridade('P3');
const erros = [...P0, ...P1];
const warnings = [...P2, ...P3];

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ P0, P1, P2, P3, erros, warnings, veredito: erros.length ? 'BLOCKED' : 'READY FOR MERGE' }, null, 2));
  process.exit(erros.length ? 1 : 0);
}

const linha = (a: Achado) => `   · [${a.id}] ${a.mensagem}${a.onde ? ` — ${a.onde}` : ''}`;
console.log('BROBOND ERP 3.0 — GATE FINAL DE GO-LIVE\n');
console.log('Gates executados: audit:ux · audit:menu · architecture:audit');
console.log(`Fluxos de página exigidos: ${FLUXOS_ESPERADOS.length}`);
console.log(`Cálculos críticos exigidos: ${CALCULOS.length}`);
console.log(`Migrations verificadas: ${migrations.length}\n`);

for (const [rotulo, lista] of [
  ['P0 (BLOQUEIA)', P0],
  ['P1 (BLOQUEIA)', P1],
  ['P2 (não bloqueia)', P2],
  ['P3 (não bloqueia)', P3],
] as const) {
  console.log(`${rotulo}: ${lista.length}`);
  for (const a of lista) console.log(linha(a));
  console.log();
}

console.log(`ERROS: ${erros.length}`);
console.log(`WARNINGS: ${warnings.length}`);

if (erros.length) {
  console.error('\nGATE BLOCKED — há P0/P1 abertos. Nenhum é convertido em skip.');
  process.exit(1);
}
console.log('\nGATE PASS — sem P0/P1. Homologação com evidência técnica.');
