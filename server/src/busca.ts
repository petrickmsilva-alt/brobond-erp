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
//   • ID EXATO: um termo puramente numérico (até 10 dígitos, faixa de int32)
//     casa com `id` — o `t.id = $n` é PARÂMETRO, nunca concatenado;
//   • DOCUMENTO/TELEFONE POR DÍGITOS: "62999998888" acha "(62) 99999-8888" —
//     compara só os dígitos dos dois lados, então a pontuação que o operador
//     digita (ou omite) não muda o resultado;
//   • NUNCA SQL INTERPOLADO: os termos viram PARÂMETROS; o que entra no SQL é
//     apenas o nome de coluna REAL do recurso, já validado contra `columnsOf`.
//
// O ACENTO é a única diferença documentada entre os adaptadores: o PostgreSQL
// compara pelo que está gravado, então "algodao" NÃO acha "Algodão"
// (comportamento que já existia); a memória normaliza o acento. Igualar exigiria
// a extensão `unaccent`, que não é pré-requisito do banco.
// ============================================================================
import type { Field, Resource, ResourceSearchField } from './resources';
import { columnsOf, getResource } from './resources';
import { labelOf, type Row } from './store';

/** Termos da busca: sem repetição, no máximo 12. */
export function termosDeBusca(q: unknown): string[] {
  return [...new Set(String(q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 12);
}

/** Só os dígitos de um valor (o que sobra de "(62) 99999-8888" é "62999998888"). */
export function digitosDe(valor: unknown): string {
  return String(valor ?? '').replace(/\D/g, '');
}

/**
 * O termo pode ser buscado como `id`? Só quando é um inteiro positivo dentro da
 * faixa de int32 — o mesmo limite da coluna. Sem isso, "99999999999999999999"
 * viraria um número que o banco recusa (22003), derrubando a listagem.
 */
export function idDoTermo(termo: string): number | null {
  if (!/^\d{1,10}$/.test(termo)) return null;
  const n = Number(termo);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

/** Campo cujo valor tem pontuação livre: compara-se pelos dígitos. */
export function campoPorDigitos(f: Field): boolean {
  return f.type === 'document' || f.type === 'phone';
}

export type AlvoDeBusca =
  | { tipo: 'coluna'; coluna: string; campo: Field }
  | { tipo: 'ref'; ref: string; campo: string };

/**
 * Traduz `searchFields` em alvos que o SQL consegue usar: nome de COLUNA real
 * (validado contra o recurso) ou coluna do recurso REFERENCIADO (o rótulo vem
 * do JOIN). Um alvo que não existe é ignorado — nunca vira SQL.
 */
export function alvosDeBusca(r: Resource): AlvoDeBusca[] {
  const cols = new Set(columnsOf(r).map((f) => f.name));
  const campos = new Map(r.fields.map((f) => [f.name, f]));
  const declarados: ResourceSearchField[] | null = r.searchFields ?? null;
  const out: AlvoDeBusca[] = [];
  if (declarados) {
    for (const alvo of declarados) {
      if (typeof alvo === 'string') {
        const campo = campos.get(alvo);
        if (campo && cols.has(alvo)) out.push({ tipo: 'coluna', coluna: alvo, campo });
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
    else if (cols.has(f.name)) out.push({ tipo: 'coluna', coluna: f.name, campo: f });
  }
  return out;
}

function normalizarTexto(valor: unknown): string {
  return String(valor ?? '').toLocaleLowerCase('pt-BR');
}

/**
 * A linha satisfaz a busca?
 *
 * Duas vias, e a linha passa se QUALQUER uma casar:
 *  1. TEXTO: cada termo precisa aparecer em ALGUM campo pesquisável (AND entre
 *     termos, OR entre campos) — a mesma semântica do SQL;
 *  2. DOCUMENTO/TELEFONE POR DÍGITOS: a consulta INTEIRA é comparada pelos
 *     dígitos. É o que faz "(62) 99123-4567" achar o telefone gravado como
 *     "62991234567" — se a via 1 fosse a única, o termo "(62)" (2 dígitos)
 *     reprovaria a linha antes de o telefone ser considerado.
 *
 * `buscar(ref, id)` devolve a linha do recurso referenciado (o store em memória
 * entrega o acesso direto à tabela).
 */
export function linhaCorrespondeBusca(
  r: Resource,
  row: Row,
  termos: string[],
  buscar: (ref: string, id: number) => Row | undefined,
  consulta = ''
): boolean {
  if (!termos.length) return true;
  // Cada alvo guarda o texto E se ele casa por dígitos: sem essa distinção,
  // um número de telefone digitado sem pontuação não acharia o cadastrado.
  const alvos: { texto: string; porDigitos: boolean }[] = [];
  for (const alvo of alvosDeBusca(r)) {
    if (alvo.tipo === 'coluna') {
      alvos.push({ texto: normalizarTexto(row[alvo.coluna]), porDigitos: campoPorDigitos(alvo.campo) });
      continue;
    }
    // O campo de ligação é o primeiro campo do recurso que aponta para `ref`.
    const ligacao = r.fields.find((f) => f.type === 'ref' && f.ref === alvo.ref)?.name;
    const alvoRecurso = getResource(alvo.ref);
    if (!ligacao || !alvoRecurso) continue;
    const alvoRow = buscar(alvo.ref, Number(row[ligacao]));
    if (!alvoRow) continue;
    const texto =
      alvoRecurso.labelFields[0] === alvo.campo
        ? normalizarTexto(labelOf(alvoRecurso, alvoRow))
        : normalizarTexto(alvoRow[alvo.campo]);
    alvos.push({ texto, porDigitos: false });
  }
  const id = idDoTermo(String(row.id));
  const casaTexto = termos.every((termo) => {
    if (alvos.some((a) => a.texto.includes(termo))) return true;
    return id !== null && idDoTermo(termo) === id;
  });
  if (casaTexto) return true;
  const digitos = digitosDe(consulta);
  return (
    digitos.length >= 3 &&
    alvos.some((a) => a.porDigitos && digitosDe(a.texto).includes(digitos))
  );
}
