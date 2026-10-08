// ============================================================
// Tabela de medidas por grade.
//
//   GET  /api/grades/:id/medidas        grade + colunas (medidas) + valores + resumo
//   PUT  /api/grades/:id/medidas        salva colunas e valores em lote (com auditoria)
//   GET  /api/grades/medidas-resumo     status de completude de TODAS as grades
//
// Cada grade (ex.: "Camiseta PP-GG") tem um conjunto de MEDIDAS (colunas:
// "Largura (A)", "Comprimento (B)", "Manga (C)"...) e um VALOR por tamanho.
// É a tabela de medidas que acompanha a etiqueta e a tabela de tamanhos
// vista pelo cliente no catálogo público.
//
// Garantias (auditoria de 2026-09-08 — docs/AUDITORIA-MEDIDAS-2026-09-08.md):
//   • valor é validado POR UNIDADE (cm ≤ 300, mm ≤ 3000, pol ≤ 150) e rejeitado
//     com 400 e mensagem clara — antes, "abc" virava NULL silenciosamente;
//   • toda gravação deixa entrada na cadeia de auditoria (quem, quando, o quê);
//   • cada célula carrega `atualizado_em` e o cliente vê "tabela atualizada em".
// ============================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { empresaDoAtorAudit } from './empresa';
import { RESOURCES } from './resources';
import { checkAccess, getStore, toHttpError } from './services';
import { currentUser } from './auth';
import { parseId } from './validate';
import type { Tx } from './store';

const UNIDADES = new Set(['cm', 'mm', 'pol']);

/** Maior valor fisicamente plausível POR UNIDADE (3 metros, em cada escala). */
export const LIMITE_POR_UNIDADE: Record<string, number> = { cm: 300, mm: 3000, pol: 150 };
const LIMITE_PADRAO = LIMITE_POR_UNIDADE.cm;

export function limiteParaUnidade(unidade: string | null | undefined): number {
  return LIMITE_POR_UNIDADE[String(unidade || 'cm')] ?? LIMITE_PADRAO;
}

/**
 * Normaliza carimbo de tempo: no Postgres o `pg` devolve `Date` para
 * TIMESTAMPTZ, no modo demonstração é string ISO — com ISO único, a ordenação
 * e o "atualizada em" ficam iguais nos dois modos.
 */
export function tsIso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const s = String(v).trim();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

/** Tabela de medidas pronta para exibição (colunas + linhas por tamanho). */
export type TabelaMedidas = {
  medidas: { id: number; nome: string; unidade: string }[];
  linhas: { tamanho_id: number; codigo: string; valores: Record<string, number | null> }[];
  /** Instruções de medição/tolerância da grade — exibidas ao cliente. */
  instrucoes: string | null;
  /** Última alteração de qualquer célula/coluna (ISO) — null se nunca. */
  atualizada_em: string | null;
  resumo: { celulas_total: number; celulas_preenchidas: number; pct: number };
};

/** Converte o texto de uma célula em número validado (null = célula vazia). */
export function parseValorMedida(raw: unknown): number | null {
  const txt = String(raw ?? '')
    .trim()
    .replace(',', '.');
  if (txt === '') return null;
  const n = Number(txt);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Valida um valor de célula contra a unidade da coluna.
 * Devolve a mensagem do erro (ou null se ok) — nunca lança.
 */
export function erroValorMedida(nome: string, unidade: string, valor: number | null): string | null {
  if (valor === null) return null;
  if (Number.isNaN(valor)) return `Valor não numérico em "${nome}".`;
  const limite = limiteParaUnidade(unidade);
  if (valor <= 0) return `Medida inválida em "${nome}": deve ser maior que 0 ${unidade || 'cm'}.`;
  if (valor > limite) return `Medida fora do plausível em "${nome}": ${valor} (máximo ${limite} ${unidade || 'cm'}).`;
  return null;
}

function pctCompleto(preenchidas: number, total: number): number {
  return total > 0 ? Math.round((preenchidas / total) * 100) : 0;
}

/** Monta a tabela (colunas × linhas) + resumo de completude a partir de linhas cruas do store. */
export function montarTabelaMedidas(
  medidas: { id: number; nome: string; unidade: string }[],
  tamanhos: { tamanho_id: number; codigo: string }[],
  valorPor: Map<string, number | null>,
  extra?: { instrucoes?: string | null; datas?: (string | null)[] }
): TabelaMedidas {
  const linhas = tamanhos.map((t) => {
    const valores: Record<string, number | null> = {};
    for (const m of medidas) valores[String(m.id)] = valorPor.get(`${m.id}:${t.tamanho_id}`) ?? null;
    return { tamanho_id: t.tamanho_id, codigo: t.codigo, valores };
  });
  let preenchidas = 0;
  for (const l of linhas) for (const m of medidas) if (l.valores[String(m.id)] !== null) preenchidas++;
  const celulas_total = linhas.length * medidas.length;
  const datas = extra?.datas ?? [];
  const validas = datas.filter((d): d is string => Boolean(d));
  const atualizada_em = validas.length ? validas.sort().slice(-1)[0] : null;
  return {
    medidas,
    linhas,
    instrucoes: extra?.instrucoes ?? null,
    atualizada_em,
    resumo: { celulas_total, celulas_preenchidas: preenchidas, pct: pctCompleto(preenchidas, celulas_total) },
  };
}

/**
 * Resolve a tabela de medidas de uma grade (null se a grade não tem medidas).
 * Usada pelo detalhe do produto — uma consulta pequena por coluna, em vez de
 * carregar todos os valores do sistema.
 */
export async function medidasDaGrade(gradeId: number, tx?: Tx): Promise<TabelaMedidas | null> {
  const s = getStore();
  const [grade, itens, medidas, todosTamanhos] = await Promise.all([
    s.findOneWhere(RESOURCES.grades, { id: gradeId }, tx),
    s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 500, filter: { grade_id: gradeId }, sort: 'ordem', dir: 'asc' }, tx),
    s.list(RESOURCES.medidas, { page: 1, pageSize: 500, filter: { grade_id: gradeId }, sort: 'ordem', dir: 'asc' }, tx),
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 500, sort: 'ordem', dir: 'asc' }, tx),
  ]);
  if (!medidas.rows.length) return null;

  const colunas = medidas.rows.map((m) => ({ id: Number(m.id), nome: String(m.nome), unidade: String(m.unidade || 'cm') }));
  const valorPor = new Map<string, number | null>();
  const datas: string[] = [];
  const valorPorColuna = await Promise.all(
    colunas.map((c) => s.list(RESOURCES.medida_valores, { page: 1, pageSize: 500, filter: { medida_id: c.id } }, tx).then((r) => r.rows))
  );
  for (const m of medidas.rows) {
    const t = tsIso(m.atualizado_em);
    if (t) datas.push(t);
  }
  for (const rows of valorPorColuna) {
    for (const v of rows) {
      if (v.valor === null || v.valor === undefined) continue;
      valorPor.set(`${v.medida_id}:${v.tamanho_id}`, Number(v.valor));
      const t = tsIso(v.atualizado_em);
      if (t) datas.push(t);
    }
  }
  const codigoPor = new Map(todosTamanhos.rows.map((t) => [Number(t.id), String(t.codigo || '')]));
  const tamanhosGrade = itens.rows.map((it) => ({
    tamanho_id: Number(it.tamanho_id),
    codigo: codigoPor.get(Number(it.tamanho_id)) ?? `#${it.tamanho_id}`,
  }));
  const instrucoes = String(grade?.instrucoes_medidas || '').trim() || null;
  return montarTabelaMedidas(colunas, tamanhosGrade, valorPor, { instrucoes, datas });
}

/** Carrega o conjunto de dados do editor (GET) — mesmas leituras para GET e para a resposta do PUT. */
async function carregarEditor(id: number) {
  const s = getStore();
  const grade = await s.findOneWhere(RESOURCES.grades, { id });
  if (!grade) throw new HttpError(404, 'Grade não encontrada.');

  const [todosTamanhos, medidas, itens, todosValores] = await Promise.all([
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 1000 }),
    s.list(RESOURCES.medidas, { page: 1, pageSize: 500, filter: { grade_id: id }, sort: 'ordem', dir: 'asc' }),
    s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 500, filter: { grade_id: id }, sort: 'ordem', dir: 'asc' }),
    s.list(RESOURCES.medida_valores, { page: 1, pageSize: 20000 }),
  ]);

  const codigoPor = new Map(todosTamanhos.rows.map((t) => [Number(t.id), String(t.codigo || '')]));
  const tamanhos = itens.rows.map((it) => ({
    id: Number(it.tamanho_id),
    codigo: codigoPor.get(Number(it.tamanho_id)) ?? `#${it.tamanho_id}`,
  }));

  const medidaIds = new Set(medidas.rows.map((m) => Number(m.id)));
  const valores = todosValores.rows
    .filter((v) => medidaIds.has(Number(v.medida_id)))
    .map((v) => ({
      id: Number(v.id),
      medida_id: Number(v.medida_id),
      tamanho_id: Number(v.tamanho_id),
      valor: v.valor === null || v.valor === undefined ? null : Number(v.valor),
    }));

  const celulas_total = tamanhos.length * medidas.rows.length;
  const preenchidas = valores.filter((v) => v.valor !== null).length;
  const datas: string[] = [
    ...medidas.rows.map((m) => tsIso(m.atualizado_em)),
    // os valores brutos carregam a data da célula (quando existe)
    ...todosValores.rows.filter((v) => medidaIds.has(Number(v.medida_id))).map((v) => tsIso(v.atualizado_em)),
  ].filter((d): d is string => Boolean(d));

  return {
    grade: {
      id,
      nome: String(grade.nome || `#${id}`),
      instrucoes_medidas: String(grade.instrucoes_medidas || '').trim() || null,
    },
    medidas: medidas.rows.map((m) => ({
      id: Number(m.id),
      nome: String(m.nome),
      unidade: String(m.unidade || 'cm'),
      ordem: Number(m.ordem || 0),
    })),
    tamanhos,
    valores,
    resumo: {
      celulas_total,
      celulas_preenchidas: preenchidas,
      pct: pctCompleto(preenchidas, celulas_total),
      atualizada_em: datas.length ? [...datas].sort().slice(-1)[0] : null,
    },
  };
}

export async function getMedidasGrade(req: Request, res: Response) {
  checkAccess(RESOURCES.grades, currentUser(req), 'read');
  const id = parseId(req.params.id);
  const d = await carregarEditor(id);
  res.json(d);
}

export async function saveMedidasGrade(req: Request, res: Response) {
  checkAccess(RESOURCES.grades, currentUser(req), 'update');
  const id = parseId(req.params.id);
  const s = getStore();
  const actor = currentUser(req);

  const grade = await s.findOneWhere(RESOURCES.grades, { id });
  if (!grade) throw new HttpError(404, 'Grade não encontrada.');

  const body = (req.body || {}) as Record<string, unknown>;
  const medidasIn: { nome?: unknown; unidade?: unknown }[] = Array.isArray(body.medidas) ? (body.medidas as any[]) : [];
  const valoresIn: { medida_nome?: unknown; tamanho_id?: unknown; valor?: unknown }[] = Array.isArray(body.valores)
    ? (body.valores as any[])
    : [];

  // Colunas desejadas (valida nomes/unidades ANTES de tocar no banco)
  const colunas: { nome: string; unidade: string }[] = [];
  const nomesVistos = new Set<string>();
  for (const m of medidasIn) {
    const nome = String(m.nome ?? '').trim();
    if (!nome) continue;
    if (nome.length > 60) throw new HttpError(400, `Nome da medida muito grande (máx. 60): "${nome.slice(0, 40)}..."`);
    if (nomesVistos.has(nome.toLowerCase())) throw new HttpError(400, `Medida "${nome}" duplicada.`);
    nomesVistos.add(nome.toLowerCase());
    const unidade = UNIDADES.has(String(m.unidade)) ? String(m.unidade) : 'cm';
    colunas.push({ nome, unidade });
  }

  // Valida TODOS os valores antes de gravar (erro único e claro, nada de
  // "silenciou metade do lote"): a unidade é a da coluna no nome enviado.
  const unidadePorNome = new Map(colunas.map((c) => [c.nome.toLowerCase(), c.unidade]));
  const valorPorCelula = new Map<string, number | null>(); // "nome:tamanho_id" → número
  const erros: string[] = [];
  const seen = new Set<string>();
  for (const v of valoresIn) {
    const nome = String(v.medida_nome ?? '').trim();
    const tamanhoId = Number(v.tamanho_id);
    if (!nome || !Number.isInteger(tamanhoId) || tamanhoId <= 0) continue;
    const chave = `${nome.toLowerCase()}:${tamanhoId}`;
    if (seen.has(chave)) continue;
    seen.add(chave);
    const unidade = unidadePorNome.get(nome.toLowerCase()) ?? 'cm';
    const num = parseValorMedida(v.valor);
    const erro = erroValorMedida(nome, unidade, num === null ? null : num);
    if (erro) {
      if (erros.length < 5) erros.push(erro);
      continue;
    }
    valorPorCelula.set(chave, num);
  }
  if (erros.length) {
    const mais = erros.length === 5 ? ' (e mais...)' : '';
    throw new HttpError(400, `${erros[0]}${mais}`);
  }

  try {
    await s.transaction(async (tx) => {
      const existentes = await s.list(RESOURCES.medidas, { page: 1, pageSize: 500, filter: { grade_id: id } }, tx);
      const porNome = new Map(existentes.rows.map((m) => [String(m.nome).trim().toLowerCase(), m]));

      const colunasNovas: string[] = [];
      const colunasRemovidas: string[] = [];

      // Upsert das medidas (colunas) na ordem enviada
      let ordem = 1;
      for (const c of colunas) {
        const ex = porNome.get(c.nome.toLowerCase());
        if (ex) {
          if (String(ex.nome) !== c.nome || String(ex.unidade || 'cm') !== c.unidade) {
            await s.update(RESOURCES.medidas, Number(ex.id), { nome: c.nome, unidade: c.unidade, ordem }, tx);
          }
        } else {
          colunasNovas.push(c.nome);
          // INSERT não carimba atualizado_em sozinho (só o update faz) —
          // sem o carimbo aqui a coluna nova não conta na data da tabela.
          await s.insert(
            RESOURCES.medidas,
            { grade_id: id, nome: c.nome, unidade: c.unidade, ordem, atualizado_em: new Date().toISOString() },
            tx
          );
        }
        ordem += 1;
      }

      // Remove medidas que saíram da lista (e seus valores)
      for (const ex of existentes.rows) {
        if (!nomesVistos.has(String(ex.nome).trim().toLowerCase())) {
          const vals = await s.list(RESOURCES.medida_valores, { page: 1, pageSize: 1000, filter: { medida_id: Number(ex.id) } }, tx);
          for (const v of vals.rows) await s.remove(RESOURCES.medida_valores, Number(v.id), tx);
          await s.remove(RESOURCES.medidas, Number(ex.id), tx);
          colunasRemovidas.push(String(ex.nome));
        }
      }

      // Mapeia nome → id após o upsert
      const atual = await s.list(RESOURCES.medidas, { page: 1, pageSize: 500, filter: { grade_id: id }, sort: 'ordem', dir: 'asc' }, tx);
      const idPorNome = new Map(atual.rows.map((m) => [String(m.nome).trim().toLowerCase(), Number(m.id)]));

      // Upsert dos valores + contagem para auditoria
      let valoresCriados = 0;
      let valoresAlterados = 0;
      let valoresRemovidos = 0;
      for (const [chave, num] of valorPorCelula) {
        const [nomeKey, tid] = chave.split(':');
        const medidaId = idPorNome.get(nomeKey);
        const tamanhoId = Number(tid);
        if (!medidaId || !tamanhoId) continue;
        const ex = await s.findOneWhere(RESOURCES.medida_valores, { medida_id: medidaId, tamanho_id: tamanhoId }, tx);
        const exValor = ex && ex.valor !== null && ex.valor !== undefined ? Number(ex.valor) : null;
        if (num === null || (exValor !== null && exValor === num)) {
          // célula vazia ou sem mudança: remove só se existia
          if (ex && num === null) {
            await s.remove(RESOURCES.medida_valores, Number(ex.id), tx);
            valoresRemovidos += 1;
          }
          continue;
        }
        if (ex) {
          await s.update(RESOURCES.medida_valores, Number(ex.id), { valor: num }, tx);
          valoresAlterados += 1;
        } else {
          await s.insert(
            RESOURCES.medida_valores,
            { medida_id: medidaId, tamanho_id: tamanhoId, valor: num, atualizado_em: new Date().toISOString() },
            tx
          );
          valoresCriados += 1;
        }
      }

      // O PUT é substituição integral: célula que estava preenchida e veio
      // vazia (o front só envia o que tem) perde o valor antigo — sem isso
      // "deixar em branco para remover" nunca acontecia e o cliente via dado
      // que o time já tinha apagado.
      for (const m of atual.rows) {
        const nomeLower = String(m.nome).trim().toLowerCase();
        const vals = await s.list(RESOURCES.medida_valores, { page: 1, pageSize: 1000, filter: { medida_id: Number(m.id) } }, tx);
        for (const v of vals.rows) {
          if (valorPorCelula.has(`${nomeLower}:${Number(v.tamanho_id)}`)) continue;
          await s.remove(RESOURCES.medida_valores, Number(v.id), tx);
          valoresRemovidos += 1;
        }
      }

      // Auditoria: a tabela de medidas é dado que o cliente vê — toda mudança
      // precisa deixar trilha (quem, quando, o que mudou), como o resto do ERP.
      if (colunasNovas.length || colunasRemovidas.length || valoresCriados || valoresAlterados || valoresRemovidos) {
        await s.audit(
          {
            usuario_id: actor.id ?? null,
            usuario: actor.name,
            acao: 'editar',
            recurso: 'grades',
            registro_id: id,
            empresa_id: empresaDoAtorAudit(actor),
            descricao: `Tabela de medidas de "${String(grade.nome)}" atualizada — colunas: +${colunasNovas.length}${colunasRemovidas.length ? ` −${colunasRemovidas.length}` : ''} · valores: ${valoresCriados + valoresAlterados} gravado(s), ${valoresRemovidos} removido(s)`,
            dados: {
              colunas_novas: colunasNovas,
              colunas_removidas: colunasRemovidas,
              valores_criados: valoresCriados,
              valores_alterados: valoresAlterados,
              valores_removidos: valoresRemovidos,
            },
          },
          tx
        );
      }
    });
  } catch (e) {
    throw toHttpError(e, RESOURCES.medidas);
  }

  // Devolve a grade recarregada (mesmo formato do GET)
  const d = await carregarEditor(id);
  res.json(d);
}

/**
 * GET /api/grades/medidas-resumo — status de TODAS as grades em um olhar só:
 * quantas colunas, quantas células preenchidas, percentual e quando foi
 * atualizada. É o que alimenta o painel de completude do módulo e o alerta
 * de "grade publicada no catálogo sem tabela preenchida".
 */
export async function resumoMedidasGrades(req: Request, res: Response) {
  checkAccess(RESOURCES.grades, currentUser(req), 'read');
  const s = getStore();
  const [grades, itens, medidas, valores] = await Promise.all([
    s.list(RESOURCES.grades, { page: 1, pageSize: 2000, sort: 'nome', dir: 'asc' }),
    s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 20000, sort: 'ordem', dir: 'asc' }),
    s.list(RESOURCES.medidas, { page: 1, pageSize: 5000, sort: 'ordem', dir: 'asc' }),
    s.list(RESOURCES.medida_valores, { page: 1, pageSize: 20000 }),
  ]);

  const tamsPorGrade = new Map<number, number>();
  for (const it of itens.rows) tamsPorGrade.set(Number(it.grade_id), (tamsPorGrade.get(Number(it.grade_id)) ?? 0) + 1);

  const medidasPorGrade = new Map<number, { id: number; atualizado_em: string | null }[]>();
  const gradeDaMedida = new Map<number, number>();
  for (const m of medidas.rows) {
    const g = Number(m.grade_id);
    if (!medidasPorGrade.has(g)) medidasPorGrade.set(g, []);
    medidasPorGrade.get(g)!.push({ id: Number(m.id), atualizado_em: tsIso(m.atualizado_em) });
    gradeDaMedida.set(Number(m.id), g);
  }

  const preenchidasPorGrade = new Map<number, number>();
  const datasPorGrade = new Map<number, string[]>();
  for (const v of valores.rows) {
    if (v.valor === null || v.valor === undefined) continue;
    const g = gradeDaMedida.get(Number(v.medida_id));
    if (!g) continue;
    preenchidasPorGrade.set(g, (preenchidasPorGrade.get(g) ?? 0) + 1);
    const t = tsIso(v.atualizado_em);
    if (t) {
      if (!datasPorGrade.has(g)) datasPorGrade.set(g, []);
      datasPorGrade.get(g)!.push(t);
    }
  }

  const lista = grades.rows.map((g) => {
    const gid = Number(g.id);
    const meds = medidasPorGrade.get(gid) ?? [];
    const tamanhos = tamsPorGrade.get(gid) ?? 0;
    const celulas_total = meds.length * tamanhos;
    const preenchidas = preenchidasPorGrade.get(gid) ?? 0;
    const datas: string[] = [
      ...meds.map((m) => m.atualizado_em).filter((d): d is string => Boolean(d)),
      ...(datasPorGrade.get(gid) ?? []),
    ].sort();
    return {
      id: gid,
      nome: String(g.nome || `#${gid}`),
      ativo: g.ativo !== false,
      tamanhos,
      colunas: meds.length,
      celulas_total,
      celulas_preenchidas: preenchidas,
      pct: pctCompleto(preenchidas, celulas_total),
      atualizada_em: datas.length ? datas.slice(-1)[0] : null,
    };
  });

  res.json({ total: lista.length, grades: lista });
}
