// Auditoria de configuração (Fase 4.1). LOCAL: lê apenas o código-fonte e os arquivos
// de documentação. Não lê valores de variáveis de ambiente.
// Garante que TODA variável lida pelo código (e TODA chave do render.yaml) esteja na matriz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
const MATRIZ = readFileSync(join(RAIZ, 'docs/auditoria/matriz-configuracao-producao.md'), 'utf8');

function arquivosTs(dir: string, saida: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    if (nome === 'node_modules' || nome === 'test' || nome.startsWith('.')) continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) arquivosTs(caminho, saida);
    else if (/\.(ts|tsx)$/.test(nome) && !/\.test\.(ts|tsx)$/.test(nome)) saida.push(caminho);
  }
  return saida;
}

// Padrões de leitura de variável no código (ver matriz, §0 e §11). Cobre:
//  - process.env.X e process.env['X'];
//  - helpers com nome literal: requiredEnv('X'), envOr('X'), *Env('X') etc.;
//  - acesso por parâmetro chamado env: env.X e env['X'];
//  - listas literais CONNECTOR_PROVIDER_*_ENV (providers.ts), que nomeiam variáveis sem process.env.
// Não cobre: leitura com nome montado em tempo de execução (ex.: `WHATSAPP_TEMPLATE_${evento}`,
// `SCHEDULE_${tipo}`); esses são verificados pela família documentada no teste abaixo.
const PADROES_LEITURA: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
  /\b[a-zA-Z_]*Env[a-zA-Z_]*\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  /\benv\.([A-Z][A-Z0-9_]*)\b/g,
  /\benv\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
];

function nomesDeListasDeProvedor(texto: string): string[] {
  const nomes: string[] = [];
  const bloco = /CONNECTOR_PROVIDER_(?:REQUIRED|REDIRECT)_ENV[\s\S]*?\n\};/g;
  for (const b of texto.matchAll(bloco)) {
    for (const m of b[0].matchAll(/['"]([A-Z][A-Z0-9_]+)['"]/g)) nomes.push(m[1]);
  }
  return nomes;
}

function variaveisDoCodigo(): Set<string> {
  const nomes = new Set<string>();
  for (const base of ['server/src', 'modules']) {
    for (const arquivo of arquivosTs(join(RAIZ, base))) {
      const texto = readFileSync(arquivo, 'utf8');
      for (const padrao of PADROES_LEITURA) {
        for (const m of texto.matchAll(padrao)) nomes.add(m[1]);
      }
      for (const nome of nomesDeListasDeProvedor(texto)) nomes.add(nome);
    }
  }
  return nomes;
}

test('toda variável de ambiente lida no código está documentada na matriz', () => {
  const ausentes = [...variaveisDoCodigo()].filter((nome) => !MATRIZ.includes(nome)).sort();
  assert.deepEqual(ausentes, [], `Variáveis sem linha na matriz: ${ausentes.join(', ')}`);
});

test('toda chave do render.yaml está documentada na matriz', () => {
  const yaml = readFileSync(join(RAIZ, 'render.yaml'), 'utf8');
  const chaves = [...yaml.matchAll(/^\s*-\s*key:\s*([A-Z][A-Z0-9_]*)/gm)].map((m) => m[1]);
  assert.ok(chaves.length > 20, 'render.yaml deveria ter muitas chaves');
  const ausentes = [...new Set(chaves)].filter((c) => !MATRIZ.includes(c));
  assert.deepEqual(ausentes, []);
});

test('famílias de nomes dinâmicos estão documentadas (não há como listá-las por grep literal)', () => {
  for (const familia of ['WHATSAPP_TEMPLATE_<EVENTO>', 'SCHEDULE_ALERTAS', 'STRIPE_SECRET_KEY', 'PAGBANK_ACCESS_TOKEN', 'PUBLICACAO_CANAIS_LIBERADOS']) {
    assert.ok(MATRIZ.includes(familia), familia);
  }
});

test('o WhatsApp não tem token de verificação GET documentado como existente (sem nome presumido)', () => {
  assert.ok(MATRIZ.includes('não existe no código'), 'a matriz deve declarar a ausência do token GET');
  const codigo = readFileSync(join(RAIZ, 'server/src/commerce/whatsappStatus.ts'), 'utf8');
  assert.match(codigo, /export function segredoVerificacaoWhatsApp\(\): string \| null \{\s*return null;/);
});

test('a matriz não reproduz a senha padrão de desenvolvimento do código', () => {
  // O valor é extraído da fonte em tempo de execução: não é escrito neste arquivo.
  const fonte = readFileSync(join(RAIZ, 'server/src/auth.ts'), 'utf8');
  const m = fonte.match(/ADMIN_PASSWORD\s*\|\|\s*'([^']{4,})'/);
  if (!m) return; // sem padrão literal no código: nada a proteger
  assert.ok(!MATRIZ.includes(m[1]), 'a senha padrão de desenvolvimento não deve constar no documento');
});
