// ============================================================
// Tabela de medidas por grade.
//
//   GET  /api/grades/:id/medidas   grade + colunas (medidas) + valores
//   PUT  /api/grades/:id/medidas   salva colunas e valores em lote
//
// Cada grade (ex.: "Camiseta PP-GG") tem um conjunto de MEDIDAS (colunas:
// "Largura (A)", "Comprimento (B)", "Manga (C)"...) e um VALOR por tamanho.
// É a tabela de medidas que acompanha a etiqueta/tabela de tamanhos.
// ============================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { RESOURCES } from './resources';
import { checkAccess, getStore, toHttpError } from './services';
import { currentUser } from './auth';
import { parseId } from './validate';

const UNIDADES = new Set(['cm', 'mm', 'pol']);

export async function getMedidasGrade(req: Request, res: Response) {
  checkAccess(RESOURCES.grades, currentUser(req), 'read');
  const id = parseId(req.params.id);
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

  res.json({
    grade: { id, nome: String(grade.nome || `#${id}`) },
    medidas: medidas.rows.map((m) => ({ id: Number(m.id), nome: String(m.nome), unidade: String(m.unidade || 'cm'), ordem: Number(m.ordem || 0) })),
    tamanhos,
    valores,
  });
}

export async function saveMedidasGrade(req: Request, res: Response) {
  checkAccess(RESOURCES.grades, currentUser(req), 'update');
  const id = parseId(req.params.id);
  const s = getStore();

  const grade = await s.findOneWhere(RESOURCES.grades, { id });
  if (!grade) throw new HttpError(404, 'Grade não encontrada.');

  const body = (req.body || {}) as Record<string, unknown>;
  const medidasIn: { nome?: unknown; unidade?: unknown }[] = Array.isArray(body.medidas) ? (body.medidas as any[]) : [];
  const valoresIn: { medida_nome?: unknown; tamanho_id?: unknown; valor?: unknown }[] = Array.isArray(body.valores) ? (body.valores as any[]) : [];

  try {
    await s.transaction(async (tx) => {
      const existentes = await s.list(RESOURCES.medidas, { page: 1, pageSize: 500, filter: { grade_id: id } }, tx);
      const porNome = new Map(existentes.rows.map((m) => [String(m.nome).trim().toLowerCase(), m]));
      const nomesDesejados = new Set<string>();

      // Upsert das medidas (colunas) na ordem enviada
      let ordem = 1;
      for (const m of medidasIn) {
        const nome = String(m.nome ?? '').trim();
        if (!nome) continue;
        if (nomesDesejados.has(nome.toLowerCase())) throw new HttpError(400, `Medida "${nome}" duplicada.`);
        nomesDesejados.add(nome.toLowerCase());
        const unidade = UNIDADES.has(String(m.unidade)) ? String(m.unidade) : 'cm';
        const ex = porNome.get(nome.toLowerCase());
        if (ex) {
          await s.update(RESOURCES.medidas, Number(ex.id), { nome, unidade, ordem }, tx);
        } else {
          await s.insert(RESOURCES.medidas, { grade_id: id, nome, unidade, ordem }, tx);
        }
        ordem += 1;
      }

      // Remove medidas que saíram da lista (e seus valores)
      for (const ex of existentes.rows) {
        if (!nomesDesejados.has(String(ex.nome).trim().toLowerCase())) {
          const vals = await s.list(RESOURCES.medida_valores, { page: 1, pageSize: 1000, filter: { medida_id: Number(ex.id) } }, tx);
          for (const v of vals.rows) await s.remove(RESOURCES.medida_valores, Number(v.id), tx);
          await s.remove(RESOURCES.medidas, Number(ex.id), tx);
        }
      }

      // Mapeia nome → id após o upsert
      const atual = await s.list(RESOURCES.medidas, { page: 1, pageSize: 500, filter: { grade_id: id }, sort: 'ordem', dir: 'asc' }, tx);
      const idPorNome = new Map(atual.rows.map((m) => [String(m.nome).trim().toLowerCase(), Number(m.id)]));

      // Upsert dos valores (célula vazia remove o valor)
      for (const v of valoresIn) {
        const medidaId = idPorNome.get(String(v.medida_nome ?? '').trim().toLowerCase());
        const tamanhoId = Number(v.tamanho_id);
        if (!medidaId || !tamanhoId || !Number.isInteger(tamanhoId)) continue;
        const raw = String(v.valor ?? '').trim().replace(',', '.');
        const num = raw === '' ? null : Number(raw);
        const valorValido = num !== null && Number.isFinite(num);
        const ex = await s.findOneWhere(RESOURCES.medida_valores, { medida_id: medidaId, tamanho_id: tamanhoId }, tx);
        if (!valorValido) {
          if (ex) await s.remove(RESOURCES.medida_valores, Number(ex.id), tx);
        } else if (ex) {
          await s.update(RESOURCES.medida_valores, Number(ex.id), { valor: num }, tx);
        } else {
          await s.insert(RESOURCES.medida_valores, { medida_id: medidaId, tamanho_id: tamanhoId, valor: num }, tx);
        }
      }
    });
  } catch (e) {
    throw toHttpError(e, RESOURCES.medidas);
  }

  // Devolve a grade recarregada (mesmo formato do GET)
  await getMedidasGrade(req, res);
}
