// ============================================================================
// BUSCA TEXTUAL DAS LISTAGENS — contrato único entre o adaptador PostgreSQL e
// o adaptador em memória.
//
// Um recurso declara `searchFields` quando a busca tem um recorte de domínio
// próprio (ex.: Produtos: SKU, nome, código de barras, referência do
// fornecedor, categoria, coleção, cor, grade, marca). Sem a declaração, vale o
// comportamento histórico: todo campo com `search: true`.
//
// O que este módulo garante, nos dois adaptadores:
//   • TEXTO PARCIAL: "cam" acha "CAM-001";
//   • MÚLTIPLAS PALAVRAS: "camiseta vermelha" exige TODOS os termos (em
//     qualquer campo) — antes, a frase inteira era procurada como um bloco só;
//   • SEM CAIXA: "premium" acha "PREMIUM";
//   • NUNCA SQL INTERPOLADO: os termos viram PARÂMETROS; o que entra no SQL é
//     apenas o nome de coluna REAL do recurso, já validado contra `columnsOf`.
//
// O ACENTO é a única diferença documentada entre os adaptadores: o PostgreSQL
// compara pelo que está gravado, então "algodao" NÃO acha "Algodão"
// (comportamento que já existia); a memória normaliza o acento. Igualar exigiria
// a extensão `unaccent`, que não é pré-requisito do banco.
// ============================================================================
import type { Resource, ResourceSearchField } from './resources';
import { columnsOf, getResource } from './resources';
import { labelOf, type Row } from './store';

/** Termos da busca: sem repetição, no máximo 12. */
export function termosDeBusca(q: unknown): string[] {
  return [...new Set(String(q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 12);
}

export type AlvoDeBusca = { tipo: 'coluna'; coluna: string } | { tipo: 'ref'; ref: string; campo: string };

/**
 * Traduz `searchFields` em alvos que o SQL consegue usar: nome de COLUNA real
 * (validado contra o recurso) ou coluna do recurso REFERENCIADO (o rótulo vem
 * do JOIN). Um alvo que não existe é ignorado — nunca vira SQL.
 */
export function alvosDeBusca(r: Resource): AlvoDeBusca[] {
  const cols = new Set(columnsOf(r).map((f) => f.name));
  const declarados: ResourceSearchField[] | null = r.searchFields ?? null;
  const out: AlvoDeBusca[] = [];
  if (declarados) {
    for (const alvo of declarados) {
      if (typeof alvo === 'string') {
        if (cols.has(alvo)) out.push({ tipo: 'coluna', coluna: alvo });
        continue;
      }
      const alvoRef = getResource(alvo.ref);
      if (!alvoRef) continue;
      const campo = alvo.field ?? alvoRef.labelFields[0];
      if (!campo || !alvoRef.fields.some((f) => f.name === campo)) continue;
      out.push({ tipo: 'ref', ref: alvo.ref, campo });
    }
    return out;
  }
  // Padrão histórico: todo campo com `search: true`.
  for (const f of r.fields) {
    if (!f.search) continue;
    const alvoRef = f.type === 'ref' && f.ref ? getResource(f.ref) : undefined;
    if (alvoRef) out.push({ tipo: 'ref', ref: f.ref!, campo: alvoRef.labelFields[0] });
    else if (cols.has(f.name)) out.push({ tipo: 'coluna', coluna: f.name });
  }
  return out;
}

function normalizarTexto(valor: unknown): string {
  return String(valor ?? '').toLocaleLowerCase('pt-BR');
}

/**
 * A linha satisfaz a busca? Cada termo precisa aparecer em ALGUM dos campos
 * pesquisáveis (AND entre termos, OR entre campos) — a mesma semântica do SQL.
 *
 * `buscar(ref, id)` devolve a linha do recurso referenciado (o store em memória
 * entrega o acesso direto à tabela).
 */
export function linhaCorrespondeBusca(
  r: Resource,
  row: Row,
  termos: string[],
  buscar: (ref: string, id: number) => Row | undefined
): boolean {
  if (!termos.length) return true;
  const docs: string[] = [];
  for (const alvo of alvosDeBusca(r)) {
    if (alvo.tipo === 'coluna') {
      docs.push(normalizarTexto(row[alvo.coluna]));
      continue;
    }
    // O campo de ligação é o primeiro campo do recurso que aponta para `ref`.
    const ligacao = r.fields.find((f) => f.type === 'ref' && f.ref === alvo.ref)?.name;
    const alvoRecurso = getResource(alvo.ref);
    if (!ligacao || !alvoRecurso) continue;
    const alvoRow = buscar(alvo.ref, Number(row[ligacao]));
    if (!alvoRow) continue;
    docs.push(alvoRecurso.labelFields[0] === alvo.campo ? normalizarTexto(labelOf(alvoRecurso, alvoRow)) : normalizarTexto(alvoRow[alvo.campo]));
  }
  return termos.every((termo) => docs.some((doc) => doc.includes(termo)) || (/^\d+$/.test(termo) && Number(termo) === Number(row.id)));
}
