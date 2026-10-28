// ============================================================================
// GATE DE CI — ZERO MODAL: O BASELINE É OBJETIVO E MORDE
// ----------------------------------------------------------------------------
// O gate antigo tinha as exceções escritas à mão dentro do script e só olhava
// uma lista fixa de assinaturas. Estes testes provam o endurecimento:
//
//   · ocorrência NOVA (arquivo novo) → falha;
//   · ocorrência NOVA dentro de arquivo que já tem exceção → falha;
//   · `<dialog>`, `showModal()`, `aria-modal`, `createPortal` → falha;
//   · comentário/prosa que MENCIONA modal → NÃO falha;
//   · exceção sem categoria, com categoria de "fluxo de módulo", com motivo
//     curto ou apontando para página de cadastro → falha (no baseline).
//
// Cada caso monta uma raiz temporária mínima, para não depender do código real.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const raizRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const guardUrl = pathToFileURL(path.join(raizRepo, 'scripts', 'ux-guard.mjs')).href;

type Fixture = {
  arquivos?: Record<string, string>;
  baseline?: any;
};

function criarRaiz({ arquivos = {}, baseline }: Fixture) {
  const raiz = mkdtempSync(path.join(tmpdir(), 'ux-guard-'));
  const escrever = (rel: string, conteudo: string) => {
    const abs = path.join(raiz, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, conteudo);
  };
  // Estrutura mínima que o gate sempre confere.
  escrever('client/src/App.tsx', 'export const rotas = usaCrudGenerico; const novo = `${base}/novo`; const editar = `${base}/:id/editar`;');
  escrever('client/src/pages/RegistroPage.tsx', 'export const P = <RecordForm />;');
  escrever(
    'docs/ERP-3.0-UX-BASELINE.json',
    JSON.stringify(
      baseline ?? {
        versao: 2,
        regra: 'ZERO MODAL',
        categorias_permitidas: ['navegacao_global', 'menu_mobile', 'infraestrutura', 'portal_publico', 'catalogo_publico'],
        excecoes: [],
        totais: {},
      }
    )
  );
  for (const [rel, conteudo] of Object.entries(arquivos)) escrever(rel, conteudo);
  return raiz;
}

/**
 * Executa o guard em processo Node separado: `scripts/` fica FORA do root do
 * Vite (client), então importar o .mjs direto do teste não resolve. Rodar pelo
 * CLI é também o que o CI faz — o teste exercita o caminho real.
 */
async function auditar(raiz: string) {
  const script = `import { auditarUx } from ${JSON.stringify(guardUrl)}; console.log(JSON.stringify(auditarUx(process.argv[1])));`;
  const saida = execFileSync(process.execPath, ['--input-type=module', '-e', script, raiz], {
    cwd: raizRepo,
    encoding: 'utf8',
  });
  return JSON.parse(saida) as {
    ok: boolean;
    violacoes: string[];
    avisos: string[];
    resumo: Array<{ arquivo: string; id: string; qtd: number }>;
    totais: Record<string, number>;
  };
}

async function comFixture(fixture: Fixture, fn: (r: Awaited<ReturnType<typeof auditar>>) => void) {
  const raiz = criarRaiz(fixture);
  try {
    fn(await auditar(raiz));
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
}

describe('ZERO MODAL — baseline objetivo', () => {
  it('bloqueia APIs de confirmação do navegador como fluxo operacional', async () => {
    await comFixture({ arquivos: { 'client/src/pages/Operacao.tsx': 'window.confirm("Excluir?"); window.prompt("Motivo?"); window.alert("OK");' } }, (r) => {
      expect(r.ok).toBe(false);
      expect(r.violacoes.join(' ')).toContain('window.confirm/prompt/alert');
    });
  });

  it('exige baseline v3 executável e rejeita exceção wildcard', async () => {
    const baseline = {
      version: 3, date: '2026-10-28', rules: ['ZERO MODAL'],
      allowed_patterns: { resource_routes: { list: '/recurso', create: '/recurso/novo', detail: '/recurso/:id', edit: '/recurso/:id/editar' }, exception_categories: ['navegacao_global', 'menu_mobile', 'infraestrutura', 'portal_publico', 'catalogo_publico'] },
      forbidden_patterns: ['Modal', 'Dialog', 'Drawer', 'Sheet', 'Overlay', 'createPortal(', 'window.confirm(', 'window.prompt(', 'window.alert('],
      exceptions: [{ arquivo: 'client/src/pages/*.tsx', categoria: 'infraestrutura', motivo: 'Exceção ampla que não identifica arquivo ou ocorrência concreta e auditável.', padroes: {} }],
      totais: {}
    };
    await comFixture({ baseline }, (r) => {
      expect(r.ok).toBe(false);
      expect(r.violacoes.join(' ')).toContain('wildcard não é permitido');
    });
  });

  it('reconhece as rotas /novo e /:id/editar como fluxo válido quando ligadas ao CRUD', async () => {
    const baseline = {
      version: 3, date: '2026-10-28', rules: ['ZERO MODAL'],
      allowed_patterns: { resource_routes: { list: '/recurso', create: '/recurso/novo', detail: '/recurso/:id', edit: '/recurso/:id/editar' }, exception_categories: ['navegacao_global', 'menu_mobile', 'infraestrutura', 'portal_publico', 'catalogo_publico'] },
      forbidden_patterns: ['Modal', 'Dialog', 'Drawer', 'Sheet', 'Overlay', 'createPortal(', 'window.confirm(', 'window.prompt(', 'window.alert('],
      exceptions: [], totais: {}
    };
    await comFixture({ baseline }, (r) => {
      expect(r.violacoes).toEqual([]);
      expect(r.ok).toBe(true);
    });
  });

  it('reprova arquivo NOVO com componente de sobreposição', async () => {
    await comFixture(
      { arquivos: { 'client/src/pages/ClientesPage.tsx': 'export const X = () => <Modal>oi</Modal>;' } },
      (r) => {
        expect(r.ok).toBe(false);
        expect(r.violacoes.join('\n')).toContain('componente de sobreposição');
        expect(r.violacoes.join('\n')).toContain('fora do baseline');
      }
    );
  });

  it('reprova `role="dialog"`, `aria-modal`, `<dialog>`, `showModal()` e `createPortal`', async () => {
    await comFixture(
      {
        arquivos: {
          'client/src/pages/A.tsx': 'export const A = () => <div role="dialog" />;',
          'client/src/pages/B.tsx': 'export const B = () => <div aria-modal="true" />;',
          'client/src/pages/C.tsx': 'export const C = () => <dialog open />;',
          'client/src/pages/D.tsx': 'export const D = () => ref.current.showModal();',
          'client/src/pages/E.tsx': 'export const E = () => createPortal(<div />, document.body);',
        },
      },
      (r) => {
        expect(r.ok).toBe(false);
        const txt = r.violacoes.join('\n');
        for (const arquivo of ['A.tsx', 'B.tsx', 'C.tsx', 'D.tsx', 'E.tsx']) expect(txt).toContain(arquivo);
      }
    );
  });

  it('reprova `fixed inset-0` novo e a variante com ordem invertida', async () => {
    await comFixture(
      {
        arquivos: {
          'client/src/pages/F.tsx': 'export const F = () => <div className="fixed inset-0 z-50" />;',
          'client/src/pages/G.tsx': 'export const G = () => <div className="inset-0 fixed z-50" />;',
          'client/src/pages/H.tsx': 'export const H = () => <div className="fixed inset-x-0 inset-y-0" />;',
        },
      },
      (r) => {
        expect(r.ok).toBe(false);
        const txt = r.violacoes.join('\n');
        expect(txt).toContain('F.tsx');
        expect(txt).toContain('G.tsx');
        expect(txt).toContain('H.tsx');
      }
    );
  });

  it('NÃO reprova barra fixa (fixed inset-x-0 bottom-0) nem texto que menciona modal', async () => {
    await comFixture(
      {
        arquivos: {
          'client/src/pages/Barra.tsx': 'export const B = () => <div className="fixed inset-x-0 bottom-0 z-30" />;',
          'client/src/pages/Doc.tsx': [
            '// Este módulo não usa Modal nem Dialog (ZERO MODAL).',
            '/* Antes existia um <Dialog> aqui; hoje é página. */',
            'export const D = () => <p>Sem modal: LISTA → DETALHE → EDIÇÃO.</p>;',
          ].join('\n'),
        },
      },
      (r) => {
        expect(r.violacoes).toEqual([]);
        expect(r.ok).toBe(true);
      }
    );
  });

  it('reprova quando a contagem CRESCE num arquivo que já tem exceção', async () => {
    const baseline = {
      versao: 2,
      regra: 'ZERO MODAL',
      categorias_permitidas: ['navegacao_global'],
      excecoes: [
        {
          arquivo: 'client/src/components/CommandPalette.tsx',
          categoria: 'navegacao_global',
          motivo: 'Navegação global de módulos e ações, sem cadastro, edição ou detalhe de registro.',
          padroes: { 'role-dialog': 1 },
        },
      ],
      totais: { 'role-dialog': 1 },
    };
    await comFixture(
      {
        baseline,
        arquivos: {
          'client/src/components/CommandPalette.tsx': 'export const C = () => <div role="dialog" role="dialog" />;',
        },
      },
      (r) => {
        expect(r.ok).toBe(false);
        expect(r.violacoes.join('\n')).toContain('CRESCEU');
      }
    );
  });

  it('reprova total acima do declarado mesmo com cada arquivo dentro do permitido', async () => {
    const baseline = {
      versao: 2,
      regra: 'ZERO MODAL',
      categorias_permitidas: ['infraestrutura', 'navegacao_global'],
      excecoes: [
        {
          arquivo: 'client/src/components/A.tsx',
          categoria: 'infraestrutura',
          motivo: 'Captura invisível de clique fora do menu de ações da linha, sem conteúdo visual.',
          padroes: { 'overlay-fixo': 5 },
        },
        {
          arquivo: 'client/src/components/B.tsx',
          categoria: 'navegacao_global',
          motivo: 'Navegação global de módulos e ações, sem cadastro, edição ou detalhe de registro.',
          padroes: { 'overlay-fixo': 5 },
        },
      ],
      // Cada arquivo está dentro do permitido (5), mas o TOTAL do repo passou
      // de 1: é exatamente o caso "baseline + ocorrência nova".
      totais: { 'overlay-fixo': 1 },
    };
    await comFixture(
      {
        baseline,
        arquivos: {
          'client/src/components/A.tsx': 'export const A = () => <div className="fixed inset-0" />;',
          'client/src/components/B.tsx': 'export const B = () => <div className="fixed inset-0" />;',
        },
      },
      (r) => {
        expect(r.ok).toBe(false);
        expect(r.violacoes.join('\n')).toContain('ocorrência nova não justificada');
      }
    );
  });

  it('reprova exceção sem categoria, com categoria inventada, motivo curto ou em página de cadastro', async () => {
    const casos: Array<{ nome: string; excecao: any; esperado: string }> = [
      {
        nome: 'sem categoria',
        excecao: { arquivo: 'client/src/components/X.tsx', motivo: 'Justificativa suficientemente longa para passar do mínimo exigido.', padroes: {} },
        esperado: 'não é permitida',
      },
      {
        nome: 'categoria de fluxo de módulo',
        excecao: {
          arquivo: 'client/src/components/X.tsx',
          categoria: 'fluxo_modulo',
          motivo: 'Justificativa suficientemente longa para passar do mínimo exigido aqui.',
          padroes: {},
        },
        esperado: 'não é permitida',
      },
      {
        nome: 'motivo curto',
        excecao: { arquivo: 'client/src/components/X.tsx', categoria: 'infraestrutura', motivo: 'porque sim', padroes: {} },
        esperado: 'mínimo 40 caracteres',
      },
      {
        nome: 'página de cadastro',
        excecao: {
          arquivo: 'client/src/pages/RegistroPage.tsx',
          categoria: 'infraestrutura',
          motivo: 'Justificativa suficientemente longa para passar do mínimo exigido aqui.',
          padroes: {},
        },
        esperado: 'NUNCA pode ser exceção',
      },
    ];
    for (const caso of casos) {
      const raiz = criarRaiz({
        baseline: {
          versao: 2,
          regra: 'ZERO MODAL',
          categorias_permitidas: ['infraestrutura'],
          excecoes: [caso.excecao],
          totais: {},
        },
        arquivos: { 'client/src/components/X.tsx': 'export const X = 1;' },
      });
      try {
        const r = await auditar(raiz);
        expect(r.ok, `${caso.nome}: deveria reprovar`).toBe(false);
        expect(r.violacoes.join('\n'), caso.nome).toContain(caso.esperado);
      } finally {
        rmSync(raiz, { recursive: true, force: true });
      }
    }
  });

  it('reprova exceção apontando para arquivo inexistente e assinatura desconhecida', async () => {
    await comFixture(
      {
        baseline: {
          versao: 2,
          regra: 'ZERO MODAL',
          categorias_permitidas: ['infraestrutura'],
          excecoes: [
            {
              arquivo: 'client/src/components/Fantasma.tsx',
              categoria: 'infraestrutura',
              motivo: 'Justificativa suficientemente longa para passar do mínimo exigido aqui.',
              padroes: { 'assinatura-inventada': 1 },
            },
          ],
          totais: {},
        },
      },
      (r) => {
        expect(r.ok).toBe(false);
        const txt = r.violacoes.join('\n');
        expect(txt).toContain('não existe');
        expect(txt).toContain('assinatura desconhecida');
      }
    );
  });

  it('falha se o baseline desaparecer (gate sem fonte de verdade não passa)', async () => {
    const raiz = criarRaiz({});
    rmSync(path.join(raiz, 'docs', 'ERP-3.0-UX-BASELINE.json'));
    try {
      const r = await auditar(raiz);
      expect(r.ok).toBe(false);
      expect(r.violacoes.join('\n')).toContain('baseline ausente');
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });
});
