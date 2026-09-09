// Camada de serviço: CRUD genérico + regras de negócio por módulo
// (estoque, movimentações, ordens, usuários) + auditoria.
import { randomBytes } from 'node:crypto';
import { HttpError } from './errors';
import { MemStore } from './memdb';
import { PgStore, isPgAvailable, translatePgError } from './pgstore';
import { getResource, RESOURCES, type Resource } from './resources';
import { labelOf, type ListParams, type Payload, type Row, type Store, type Tx } from './store';
import { validatePayload } from './validate';
import type { AuthUser } from './auth';
import { attachImages, removeAllFiles } from './uploads';
import { aplicarRegrasPedido } from './itens';
import { aplicarRegrasOrdem, recalcularFichaValores, validarOrdemPayload } from './producao';
import { syncAporte, syncLancamentoCompra, syncLancamentoVenda } from './financeiro';

const PERFIL_RANK: Record<string, number> = { operador: 1, gerente: 2, admin: 3 };

let store: Store | null = null;

export function getStore(): Store {
  if (!store) store = isPgAvailable() ? new PgStore() : new MemStore();
  return store;
}

/** Converte qualquer erro em HttpError legível para o cliente. */
export function toHttpError(e: any, r?: Resource): HttpError {
  if (e instanceof HttpError) return e;
  const pg = translatePgError(e, r);
  if (pg) return pg;
  if (e?.message === 'NO_DB') return new HttpError(503, 'Banco de dados indisponível.');
  console.error('Erro inesperado:', e);
  return new HttpError(500, 'Erro interno do servidor');
}

type Actor = Pick<AuthUser, 'id' | 'name' | 'perfil'> & Partial<AuthUser>;

function audit(tx: Tx, actor: Actor, acao: 'criar' | 'editar' | 'excluir', r: Resource, id: number | null, descricao: string, dados?: unknown) {
  return getStore().audit(
    { usuario_id: actor.id || null, usuario: actor.name, acao, recurso: r.key, registro_id: id, descricao, dados },
    tx
  );
}

/** Campos que mudaram entre o registro anterior e o payload (para a auditoria). */
function diff(before: Row, data: Payload): Record<string, { de: unknown; para: unknown }> {
  const out: Record<string, { de: unknown; para: unknown }> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'senha_hash') {
      out.senha = { de: '••••', para: '••••' };
      continue;
    }
    const prev = before[k];
    const same =
      prev === v ||
      (prev !== null && v !== null && prev !== undefined && v !== undefined && String(prev) === String(v)) ||
      (typeof prev === 'string' && typeof v === 'string' && prev.slice(0, 10) === v.slice(0, 10) && /^\d{4}-\d{2}-\d{2}/.test(v));
    if (!same) out[k] = { de: prev ?? null, para: v ?? null };
  }
  return out;
}

export type CapacidadeComercial = 'catalogos' | 'compartilhar' | 'metricas' | 'politicas' | 'aprovar';

export function podeComercial(actor: Actor, capacidade: CapacidadeComercial): boolean {
  if (actor.perfil === 'admin') return true;
  const valor = String(actor[`perm_${capacidade}` as keyof Actor] || 'herdar');
  if (valor === 'permitir') return true;
  if (valor === 'negar') return false;
  return actor.perfil === 'gerente';
}

export function exigirComercial(actor: Actor, capacidade: CapacidadeComercial) {
  if (!podeComercial(actor, capacidade)) throw new HttpError(403, 'Você não possui esta permissão comercial. Peça ao administrador para revisar sua alçada.');
}

export function checkAccess(r: Resource, actor: Actor, op: 'read' | 'create' | 'update' | 'delete') {
  if (r.key === 'catalogos') {
    if (op === 'read') {
      if (!podeComercial(actor, 'catalogos') && !podeComercial(actor, 'compartilhar') && !podeComercial(actor, 'metricas')) exigirComercial(actor, 'catalogos');
    } else exigirComercial(actor, 'catalogos');
  }
  if (r.key === 'politicas_comerciais') { exigirComercial(actor, 'politicas'); }
  const perfil = actor.perfil || 'operador';
  if (r.minPerfil && !['catalogos', 'politicas_comerciais'].includes(r.key) && (PERFIL_RANK[perfil] ?? 0) < PERFIL_RANK[r.minPerfil]) {
    throw new HttpError(403, r.minPerfil === 'admin' ? 'Apenas administradores acessam este módulo.' : 'Apenas gerentes e administradores acessam este módulo.');
  }
  if (r.adminOnly && perfil !== 'admin') {
    throw new HttpError(403, 'Apenas administradores acessam este módulo.');
  }
  if (op !== 'read' && !r.ops[op]) {
    const verbo = op === 'create' ? 'incluir' : op === 'update' ? 'alterar' : 'excluir';
    throw new HttpError(405, `Não é possível ${verbo} registros em ${r.label}.`);
  }
  if (op === 'delete' && actor.perfil === 'operador') {
    throw new HttpError(403, 'Operadores não podem excluir registros. Peça a um gerente ou administrador.');
  }
}

// ----------------------------------------------------------------------------
// Leitura
// ----------------------------------------------------------------------------
export async function listRecords(r: Resource, p: ListParams) {
  const out = await getStore().list(r, p);
  await attachImages(r, out.rows);
  anotarStatusSenha(r, out.rows);
  await anotarUsoLocal(r, out.rows);
  await attachGradeTamanhos(r, out.rows);
  return out;
}

export async function getRecord(r: Resource, id: number) {
  const row = await getStore().get(r, id);
  if (!row) throw new HttpError(404, `${r.singular} não encontrado(a).`);
  await attachImages(r, [row]);
  anotarStatusSenha(r, [row]);
  await anotarUsoLocal(r, [row]);
  await attachGradeTamanhos(r, [row]);
  return row;
}

/**
 * Coluna "Senha" da lista de usuários: mostra o ESTADO do acesso, nunca o valor.
 * A senha é guardada em hash Argon2id (mão única) — nem um administrador consegue
 * vê-la ou recuperá-la.
 *   • convite_pendente — usuário criado, aguardando definir a própria senha via convite;
 *   • provisoria — senha temporária definida por admin (troca obrigatória no próximo acesso);
 *   • propria — senha definida pelo próprio usuário.
 */
function anotarStatusSenha(r: Resource, rows: Row[]) {
  if (r.key !== 'usuarios') return;
  for (const row of rows) {
    row.senha_status = !row.senha_definida_em ? 'convite_pendente' : row.trocar_senha ? 'provisoria' : 'propria';
    row.convite_expirado = row.convite_expira_em ? new Date(String(row.convite_expira_em)).getTime() < Date.now() : false;
  }
}

export async function optionsFor(r: Resource) {
  return getStore().options(r);
}

// ----------------------------------------------------------------------------
// Grades de tamanhos (muitos-para-muitos grade × tamanho)
// ----------------------------------------------------------------------------

export type GradeInfo = {
  gradeId: number;
  gradeNome: string;
  tamanhos: { id: number; codigo: string }[];
};

/** Anexa `tamanhos` (ids) e `tamanhos__label` (códigos) aos registros de grades. */
async function attachGradeTamanhos(r: Resource, rows: Row[], tx?: Tx): Promise<void> {
  if (r.key !== 'grades' || !rows.length) return;
  const s = getStore();
  const [todos, itens] = await Promise.all([
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 1000 }, tx),
    s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 10000, sort: 'ordem', dir: 'asc' }, tx),
  ]);
  const codigoPor = new Map(todos.rows.map((t) => [Number(t.id), String(t.codigo || '')]));
  const porGrade = new Map<number, number[]>();
  for (const it of itens.rows) {
    const g = Number(it.grade_id);
    if (!porGrade.has(g)) porGrade.set(g, []);
    porGrade.get(g)!.push(Number(it.tamanho_id));
  }
  for (const row of rows) {
    const ids = porGrade.get(Number(row.id)) ?? [];
    row.tamanhos = ids;
    row.tamanhos__label = ids.map((id) => codigoPor.get(id) ?? `#${id}`).join(', ');
  }
}

/** Substitui os tamanhos de uma grade pelos ids fornecidos (ordem = posição). */
async function syncGradeTamanhos(gradeId: number, tamanhoIds: number[], tx: Tx): Promise<void> {
  const s = getStore();
  const existentes = await s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 1000, filter: { grade_id: gradeId } }, tx);
  for (const it of existentes.rows) await s.remove(RESOURCES.grade_tamanhos, Number(it.id), tx);
  let ordem = 1;
  for (const t of tamanhoIds) {
    await s.insert(RESOURCES.grade_tamanhos, { grade_id: gradeId, tamanho_id: t, ordem }, tx);
    ordem += 1;
  }
}

/** Resolve a grade efetiva de um produto (produto.grade_id ?? categoria.grade_id). */
export async function gradeDoProduto(produto: Row, tx?: Tx): Promise<GradeInfo | null> {
  const s = getStore();
  let gradeId = Number(produto.grade_id) || 0;
  if (!gradeId && Number(produto.categoria_id)) {
    const cat = await s.findOneWhere(RESOURCES.categorias, { id: produto.categoria_id }, tx);
    gradeId = Number(cat?.grade_id) || 0;
  }
  if (!gradeId) return null;
  const grade = await s.findOneWhere(RESOURCES.grades, { id: gradeId }, tx);
  if (!grade) return null;
  const [todos, itens] = await Promise.all([
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 1000 }),
    s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 1000, filter: { grade_id: gradeId }, sort: 'ordem', dir: 'asc' }, tx),
  ]);
  const codigoPor = new Map(todos.rows.map((t) => [Number(t.id), String(t.codigo || '')]));
  const tamanhos = itens.rows.map((it) => ({
    id: Number(it.tamanho_id),
    codigo: codigoPor.get(Number(it.tamanho_id)) ?? `#${it.tamanho_id}`,
  }));
  return { gradeId, gradeNome: String(grade.nome || `#${gradeId}`), tamanhos };
}

/**
 * O tamanho precisa existir na grade efetiva do produto (a do produto, senão a
 * da categoria). A tela já filtra, mas planilha de importação, integração e
 * chamada direta à API não passam pela tela — é aqui que a mistura PP–GG com
 * 36–48 para de verdade. Produto sem grade fica de fora (ainda não organizado).
 */
export async function validarTamanhoNaGrade(produtoId: number, tamanhoId: number, tx?: Tx): Promise<void> {
  if (!produtoId || !tamanhoId) return;
  const s = getStore();
  const produto = await s.findOneWhere(RESOURCES.produtos, { id: produtoId }, tx);
  if (!produto) return; // a validação de referência do payload cuida disso
  const grade = await gradeDoProduto(produto, tx);
  if (!grade || !grade.tamanhos.length) return;
  if (grade.tamanhos.some((t) => t.id === tamanhoId)) return;
  const tamanho = await s.findOneWhere(RESOURCES.tamanhos, { id: tamanhoId }, tx);
  throw new HttpError(
    400,
    `O tamanho "${String(tamanho?.codigo ?? `#${tamanhoId}`)}" não faz parte da grade "${grade.gradeNome}" de ${String(produto.sku ?? `#${produtoId}`)}.`,
    {
      tamanho_id:
        `A grade aceita: ${grade.tamanhos.map((t) => t.codigo).join(', ')}. ` +
        'Se o produto pertence a outra grade, ajuste a grade no cadastro dele.',
    }
  );
}

// ----------------------------------------------------------------------------
// Escrita (com regras por módulo)
// ----------------------------------------------------------------------------
export async function createRecord(r: Resource, body: unknown, actor: Actor): Promise<Row> {
  const data = validatePayload(r, body, 'create');
  const s = getStore();
  try {
    return await s.transaction(async (tx) => {
      // Regras específicas
      if (r.key === 'usuarios') await prepareUserPayload(data, null, actor);
      if (r.key === 'catalogos') await prepareCatalogosPayload(data, null, actor);
      if (r.key === 'politicas_comerciais') prepararPoliticaComercial(data, null);
      if (r.key === 'movimentacoes') return createMovimentacao(data, actor, tx);
      if (r.key === 'movimentacoes_insumos') return createMovimentacaoInsumo(data, actor, tx);
      if (r.key === 'estoques') {
        await resolveLocal(data, tx);
        await ensureUniqueStock(data, null, tx);
        await garantirSaldoNaoNegativo(data, null);
      }
      if (r.key === 'inventarios') {
        await resolveLocal(data, tx);
        // Abrir um inventário é sempre abrir: `status` é readonly na API e o
        // DEFAULT 'aberto' só existe no Postgres, então no modo demonstração o
        // registro nascia sem status e o snapshot do saldo nunca rodava.
        if (data.status === undefined || data.status === null || data.status === '') data.status = 'aberto';
      }
      // O estado fiscal pertence aos endpoints de NF-e: o formulário não cria nota.
      if (r.key === 'vendas') for (const k of ['nfe_status', 'nfe_numero', 'nfe_emitida_em', 'nfe_provider']) delete data[k];
      if (r.key === 'locais') await ensureLocalPadraoUnico(data, null, tx);
      if (r.key === 'ordens') await validarOrdemPayload(data, null);

      const gradeTamanhos = r.key === 'grades' ? ((data.tamanhos as number[]) || []) : null;
      if (gradeTamanhos) delete data.tamanhos;

      const row = await s.insert(r, data, tx);
      if (r.key === 'locais') await garantirLocalPadrao(tx);
      if (r.key === 'grades' && gradeTamanhos) await syncGradeTamanhos(Number(row.id), gradeTamanhos, tx);

      if (r.key === 'estoques' && Number(row.quantidade) !== 0) {
        await s.insert(
          getResource('movimentacoes')!,
          { tipo: 'ajuste', produto_id: row.produto_id, tamanho_id: row.tamanho_id, local: row.local, local_id: row.local_id ?? null, quantidade: Number(row.quantidade), motivo: 'Saldo inicial (cadastro de estoque)', usuario_id: actor.id || null },
          tx
        );
      }
      if (r.key === 'ordens') {
        const full = (await s.get(r, row.id, tx)) ?? row;
        await aplicarRegrasOrdem(null, full, data, { id: actor.id || null, name: actor.name, perfil: actor.perfil }, tx, { forcar: false });
      }
      if (r.key === 'fichas') {
        await recalcularFichaValores(Number(row.id), tx);
      }
      if (r.key === 'inventarios' && row.status === 'aberto') {
        await abrirInventarioSnapshot(row, actor, tx);
      }
      if (r.key === 'vendas' || r.key === 'compras') {
        await aplicarRegrasPedido(r.key === 'vendas' ? 'venda' : 'compra', null, row, data, { id: actor.id || null, name: actor.name }, tx);
        const full = (await s.get(r, row.id, tx)) ?? row;
        await (r.key === 'vendas' ? syncLancamentoVenda : syncLancamentoCompra)(null, full, data, { id: actor.id || null, name: actor.name }, tx);
      }
      if (r.key === 'aportes') {
        await syncAporte(null, row, actor, tx);
      }

      // Convite de acesso: usuário criado sem senha recebe um link por e-mail
      // para definir a própria senha (48 h). Sem SMTP, o link volta na resposta
      // (modo demonstração/desenvolvimento) em vez de ficar só no console.
      let conviteLink: string | undefined;
      if (r.key === 'usuarios' && !row.senha_hash) {
        const { gerarConvite } = await import('./usuariosAdmin');
        conviteLink = await gerarConvite(row, { id: actor.id || 0, name: actor.name }, tx);
      }

      await audit(tx, actor, 'criar', r, row.id, `${r.singular} ${labelOf(r, row)} incluído(a)`, sanitize(data));
      const final = (await s.get(r, row.id, tx)) ?? row;
      if (conviteLink) (final as Row).convite_link = conviteLink;
      await attachGradeTamanhos(r, [final], tx);
      return final;
    });
  } catch (e) {
    throw toHttpError(e, r);
  }
}

export type UpdateOpts = { forcar?: boolean };

export async function updateRecord(r: Resource, id: number, body: unknown, actor: Actor, opts: UpdateOpts = {}): Promise<Row> {
  const data = validatePayload(r, body, 'update');
  const s = getStore();
  try {
    return await s.transaction(async (tx) => {
      const before = await s.findOneWhere(r, { id }, tx);
      if (!before) throw new HttpError(404, `${r.singular} não encontrado(a).`);

      if (r.key === 'usuarios') await prepareUserPayload(data, before, actor);
      if (r.key === 'catalogos') await prepareCatalogosPayload(data, before, actor);
      if (r.key === 'politicas_comerciais') prepararPoliticaComercial(data, before);
      if (r.key === 'estoques') {
        // Edição parcial (ex.: só estoque_min) mantém o local atual do saldo —
        // sem isto o resolveLocal aplicaria o padrão "loja" e o
        // ensureUniqueStock acusaria 409 contra o saldo de outro local.
        if (before && (data.local === undefined || data.local === null || data.local === '') && !data.local_id && before.local) {
          data.local = String(before.local);
        }
        await resolveLocal(data, tx);
        await ensureUniqueStock(data, before, tx);
        await garantirSaldoNaoNegativo(data, before);
      }
      if (r.key === 'movimentacoes') throw new HttpError(405, 'Movimentações são imutáveis. Faça o lançamento inverso.');
      if (r.key === 'movimentacoes_insumos') throw new HttpError(405, 'Movimentações de insumos são imutáveis. Faça o lançamento inverso.');
      if (r.key === 'inventarios') await validarUpdateInventario(data, before);
      // Idem criação: editar à mão criaria uma NF-e "emitida" que não existe.
      if (r.key === 'vendas') {
        for (const k of ['nfe_status', 'nfe_numero', 'nfe_emitida_em', 'nfe_provider']) delete data[k];
        // Fase 3B: ao tentar faturar acima da alçada, encaminha para a fila em
        // vez de confiar no cliente ou simplesmente perder o trabalho digitado.
        if (['faturada', 'entregue'].includes(String(data.status || '')) && !podeComercial(actor, 'aprovar')) {
          const total = Number(before.total || 0);
          const desconto = Number(data.desconto ?? before.desconto ?? 0);
          const descontoPct = total > 0 ? (desconto / (total + desconto)) * 100 : 0;
          const limiteValor = actor.venda_sem_aprovacao_ate == null ? (actor.perfil === 'gerente' ? Infinity : 0) : Number(actor.venda_sem_aprovacao_ate);
          const limiteDesconto = actor.desconto_max_pct == null ? (actor.perfil === 'gerente' ? 100 : 0) : Number(actor.desconto_max_pct);
          if (total > limiteValor || descontoPct > limiteDesconto) {
            data.status = 'pendente_aprovacao';
            data.observacoes = [String(data.observacoes ?? before.observacoes ?? '').trim(), `Aguardando aprovação: alçada de ${actor.name} excedida.`].filter(Boolean).join('\n');
          }
        }
      }
      let renomeouLocal = false;
      if (r.key === 'locais') {
        renomeouLocal = await validarRenomeLocal(data, before, actor, tx);
        await ensureLocalPadraoUnico(data, before, tx);
      }
      if (r.key === 'estoque_insumos') {
        // Único campo editável diretamente: estoque mínimo.
        const extra = Object.keys(data).filter((k) => k !== 'estoque_min' && k !== 'atualizado_em');
        if (extra.length) {
          throw new HttpError(400, 'O saldo do insumo só muda por movimentações (compra, ajuste ou consumo de OP). Apenas o estoque mínimo pode ser editado aqui.', { quantidade: 'Use uma movimentação de insumo' });
        }
      }
      if (r.key === 'ordens') await validarOrdemPayload(data, before);

      const gradeTamanhos = r.key === 'grades' && data.tamanhos !== undefined ? ((data.tamanhos as number[]) || []) : null;
      if (gradeTamanhos) delete data.tamanhos;

      const changes = diff(before, data);
      const mudouGrade = gradeTamanhos !== null;
      if (!Object.keys(changes).length && !mudouGrade) return (await s.get(r, id, tx))!;

      const row = await s.update(r, id, data, tx);
      if (!row) throw new HttpError(404, `${r.singular} não encontrado(a).`);
      if (mudouGrade) await syncGradeTamanhos(id, gradeTamanhos, tx);

      if (r.key === 'locais') {
        await garantirLocalPadrao(tx);
        // Local renomeado: propaga o novo nome para saldos, movimentações,
        // inventários e vendas que guardavam o nome antigo como texto.
        if (renomeouLocal) await propagarRenomeLocal(before, String(data.nome), tx);
      }

      // Estoque: alteração manual de quantidade vira movimentação de ajuste
      if (r.key === 'estoques' && changes.quantidade) {
        const delta = Number(row.quantidade) - Number(before.quantidade);
        if (delta !== 0) {
          await s.insert(getResource('movimentacoes')!, { tipo: 'ajuste', produto_id: row.produto_id, tamanho_id: row.tamanho_id, local: row.local, local_id: row.local_id ?? null, quantidade: delta, motivo: 'Ajuste manual pelo Estoque Físico', usuario_id: actor.id || null }, tx);
        }
      }
      // Ordem concluída/reaberta: entrada/estorno no estoque + consumo de insumos
      if (r.key === 'ordens' && changes.status) {
        const full = (await s.get(r, id, tx)) ?? row;
        await aplicarRegrasOrdem(before, full, data, { id: actor.id || null, name: actor.name, perfil: actor.perfil }, tx, opts);
      }
      // Ficha técnica: recalcula custo/preço sugerido (mão de obra, indiretos, margem)
      if (r.key === 'fichas' && (changes.mao_obra || changes.custos_indiretos || changes.margem_pct || changes.produto_id)) {
        await recalcularFichaValores(id, tx);
      }
      // Vendas/Compras: faturamento/baixa de estoque, recebimento/custo médio e estornos
      if (r.key === 'vendas' || r.key === 'compras') {
        const full = (await s.get(r, id, tx)) ?? row;
        await aplicarRegrasPedido(r.key === 'vendas' ? 'venda' : 'compra', before, full, data, { id: actor.id || null, name: actor.name }, tx);
        await (r.key === 'vendas' ? syncLancamentoVenda : syncLancamentoCompra)(before, full, data, { id: actor.id || null, name: actor.name }, tx);
      }
      // Aporte confirmado/estornado → lançamento financeiro automático
      if (r.key === 'aportes' && (changes.status || changes.valor || changes.investidor_id || changes.conta_id || changes.forma_pagamento || changes.data)) {
        const full = (await s.get(r, id, tx)) ?? row;
        await syncAporte(before, full, actor, tx);
      }

      const campos = Object.keys(changes).join(', ');
      const descricao =
        r.key === 'locais' && renomeouLocal
          ? `${r.singular} "${String(before.nome)}" renomeado para "${String(data.nome)}" (saldos, movimentações, inventários e vendas atualizados com o novo nome)`
          : `${r.singular} ${labelOf(r, row)} alterado(a) (${campos})`;
      await audit(tx, actor, 'editar', r, id, descricao, changes);
      const final = (await s.get(r, id, tx)) ?? row;
      await attachGradeTamanhos(r, [final], tx);
      return final;
    });
  } catch (e) {
    throw toHttpError(e, r);
  }
}

export async function deleteRecord(r: Resource, id: number, actor: Actor): Promise<void> {
  const s = getStore();
  try {
    await s.transaction(async (tx) => {
      const before = await s.findOneWhere(r, { id }, tx);
      if (!before) throw new HttpError(404, `${r.singular} não encontrado(a).`);

      if (r.key === 'usuarios') {
        if (Number(before.id) === Number(actor.id)) throw new HttpError(400, 'Você não pode excluir o seu próprio usuário.');
        await ensureNotLastAdmin(before, { ativo: false, perfil: 'x' }, tx);
      }
      let usoLocal: UsoLocal | null = null;
      if (r.key === 'locais') {
        // A decisão é do administrador: o local pode ser excluído mesmo que o
        // sistema o use (saldos, movimentações, inventários) — o histórico não é
        // apagado, apenas o vínculo (FK) e o registro do cadastro. Gerente só
        // pode excluir local sem uso e que não seja o último local ativo.
        usoLocal = await usoDoLocal(before, tx);
        const ativos = await s.list(r, { page: 1, pageSize: 1000, filter: { ativo: true } }, tx);
        const ehUltimoAtivo = ativos.rows.length <= 1 && Number(ativos.rows[0]?.id) === Number(before.id);
        if ((usoLocal.emUso || ehUltimoAtivo) && actor.perfil !== 'admin') {
          throw new HttpError(
            403,
            usoLocal.emUso
              ? `O local "${String(before.nome)}" está em uso (${usoLocal.saldos} saldo(s), ${usoLocal.movimentacoes} movimentação(ões), ${usoLocal.inventarios} inventário(s)). Excluí-lo é uma decisão do administrador.`
              : 'Este é o único local ativo. Excluí-lo é uma decisão do administrador.'
          );
        }
        // Desfaz os vínculos de chave estrangeira: saldos, movimentações e
        // inventários continuam com o nome do local como histórico em texto.
        await desvincularLocal(before, tx);
      }
      if (r.key === 'ordens' && before.status === 'concluida') {
        throw new HttpError(409, 'Ordem concluída já deu entrada no estoque. Reabra ou cancele em vez de excluir.');
      }
      if (r.key === 'vendas' && ['faturada', 'entregue'].includes(String(before.status))) {
        throw new HttpError(409, 'Pedido faturado já baixou o estoque. Cancele o pedido (estorna automaticamente) em vez de excluí-lo.');
      }
      if (r.key === 'compras' && before.status === 'recebido') {
        throw new HttpError(409, 'Compra recebida já deu entrada nos insumos. Cancele a compra (estorna automaticamente) em vez de excluí-la.');
      }
      // Remove os itens do pedido junto (no Postgres o ON DELETE CASCADE faz;
      // aqui garantimos o mesmo comportamento no modo demonstração).
      const filhos: { r: Resource; col: string }[] = [];
      if (r.key === 'vendas' || r.key === 'compras') {
        filhos.push({ r: getResource(r.key === 'vendas' ? 'itens_venda' : 'itens_compra')!, col: r.key === 'vendas' ? 'venda_id' : 'compra_id' });
      }
      if (r.key === 'ordens') filhos.push({ r: getResource('itens_ordem')!, col: 'ordem_id' });
      if (r.key === 'fichas') filhos.push({ r: getResource('itens_ficha_tecnica')!, col: 'ficha_id' });
      for (const filho of filhos) {
        const itens = await s.list(filho.r, { page: 1, pageSize: 1000, filter: { [filho.col]: id } }, tx);
        for (const it of itens.rows) await s.remove(filho.r, Number(it.id), tx);
      }
      if (r.key === 'estoques' && Number(before.quantidade) !== 0) {
        throw new HttpError(409, 'Só é possível excluir saldos zerados. Lance uma saída/ajuste antes.');
      }
      if (r.key === 'grades') {
        // Grade em uso por categoria ou produto não pode ser excluída.
        const [emCategorias, emProdutos] = await Promise.all([
          s.countWhere(getResource('categorias')!, { grade_id: id }, tx),
          s.countWhere(getResource('produtos')!, { grade_id: id }, tx),
        ]);
        if (emCategorias || emProdutos) {
          throw new HttpError(
            409,
            `A grade "${String(before.nome)}" está em uso (${emCategorias} categoria(s) e ${emProdutos} produto(s)). Remova o vínculo antes de excluir.`
          );
        }
        // Remove os tamanhos da grade (no Postgres o ON DELETE CASCADE já faz;
        // aqui garantimos o mesmo no modo demonstração).
        const itensGrade = await s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 1000, filter: { grade_id: id } }, tx);
        for (const it of itensGrade.rows) await s.remove(RESOURCES.grade_tamanhos, Number(it.id), tx);
      }

      await removeAllFiles(r, id, tx);
      const ok = await s.remove(r, id, tx);
      if (!ok) throw new HttpError(404, `${r.singular} não encontrado(a).`);
      if (r.key === 'locais') await garantirLocalPadrao(tx);
      const detalheUso =
        usoLocal?.emUso
          ? ` — em uso na exclusão: ${usoLocal.saldos} saldo(s), ${usoLocal.movimentacoes} movimentação(ões), ${usoLocal.inventarios} inventário(s) (histórico preservado com o nome do local)`
          : '';
      await audit(tx, actor, 'excluir', r, id, `${r.singular} ${labelOf(r, before)} excluído(a)${detalheUso}`, sanitize(before));
    });
  } catch (e) {
    throw toHttpError(e, r);
  }
}

// ----------------------------------------------------------------------------
// Regras específicas
// ----------------------------------------------------------------------------
function sanitize(row: Row | Payload): Row {
  const out: Row = { ...row };
  delete out.senha;
  delete out.senha_hash;
  delete out.mfa_secret;
  delete out.convite_token_hash;
  delete out.reset_token_hash;
  return out;
}

/** Fraquezas de senha conhecidas (política da Fase 6). */
const SENHAS_FRACAS = ['123456', '12345678', '123456789', '1234567890', 'senha', 'senha123', 'password', 'password123', 'qwerty', 'abc123', 'brobond', 'brobond123', 'admin', 'administrador', 'lojinha', 'brasil', 'batata'];

/** Política de senha: mínimo 8, ≠ e-mail, fora da lista de senhas óbvias. */
export function validarPoliticaSenha(senha: string, email?: string): string | null {
  if (!senha) return 'Informe uma senha.';
  if (senha.length < 8) return 'A senha deve ter pelo menos 8 caracteres.';
  const lower = senha.toLowerCase();
  if (email && lower === String(email || '').trim().toLowerCase()) return 'A senha não pode ser igual ao e-mail.';
  const parteEmail = String(email || '').split('@')[0].toLowerCase();
  if (parteEmail.length >= 4 && lower.includes(parteEmail)) return 'A senha não pode conter o e-mail.';
  if (SENHAS_FRACAS.includes(lower) || /^(.)\1{6,}$/.test(lower)) return 'Escolha uma senha menos óbvia.';
  return null;
}

async function prepareUserPayload(data: Payload, before: Row | null, actor: Actor) {
  const { invalidateUserCache } = await import('./auth');
  // A senha NUNCA é digitada pelo admin no cadastro/edição: novos usuários
  // recebem um convite por e-mail e o admin pode gerar senha temporária de
  // exibição única (endpoint próprio). Qualquer `senha` no payload é rejeitada.
  if (typeof data.senha === 'string' && data.senha.length > 0) {
    throw new HttpError(400, 'Senhas não são mais definidas neste formulário: convide o usuário por e-mail ou use "Gerar senha temporária" (exibição única).');
  }
  delete data.senha;

  if (before) {
    if (Number(before.id) === Number(actor.id)) {
      if (data.ativo === false) throw new HttpError(400, 'Você não pode desativar o seu próprio usuário.');
      if (data.perfil && data.perfil !== 'admin') throw new HttpError(400, 'Você não pode remover o seu próprio perfil de administrador.');
    }
    await ensureNotLastAdmin(before, data, null);
    invalidateUserCache(Number(before.id));
  }
}


function prepararPoliticaComercial(data: Payload, before: Row | null) {
  const p = { ...(before || {}), ...data };
  const escopo = String(p.escopo || 'geral');
  const exigido: Record<string, string> = { canal: 'canal', colecao: 'colecao_id', catalogo: 'catalogo_id', cliente: 'cliente_id' };
  const campo = exigido[escopo];
  if (campo && !p[campo]) throw new HttpError(400, `Informe ${campo.replace('_id', '')} para o escopo selecionado.`, { [campo]: 'Campo obrigatório neste escopo' });
  if (p.inicio_em && p.fim_em && String(p.inicio_em).slice(0, 10) > String(p.fim_em).slice(0, 10)) throw new HttpError(400, 'O início da vigência não pode ser posterior ao fim.', { fim_em: 'Data anterior ao início' });
  if (Number(p.multiplo_qtd || 1) < 1) throw new HttpError(400, 'O múltiplo deve ser ao menos 1.', { multiplo_qtd: 'Mínimo 1' });
}

async function prepareCatalogosPayload(data: Payload, before: Row | null, _actor: Actor) {
  const { hashPassword } = await import('./auth');
  const senha = typeof data.senha === 'string' ? data.senha : '';
  if (senha) {
    const erro = validarPoliticaSenha(senha, '');
    if (erro) throw new HttpError(400, `Senha do catálogo: ${erro}`, { senha: erro });
    data.senha_hash = await hashPassword(senha);
  }
  delete data.senha;
  if (!before) {
    data.token = randomBytes(12).toString('hex');
  }
}

async function ensureNotLastAdmin(before: Row, data: Payload, tx: Tx) {
  const losingAdmin = before.perfil === 'admin' && before.ativo !== false && ((data.perfil !== undefined && data.perfil !== 'admin') || data.ativo === false);
  if (!losingAdmin) return;
  const s = getStore();
  const usuarios = getResource('usuarios')!;
  const admins = await s.list(usuarios, { page: 1, pageSize: 1000 }, tx ?? undefined);
  const others = admins.rows.filter((u) => u.perfil === 'admin' && u.ativo !== false && Number(u.id) !== Number(before.id));
  if (!others.length) throw new HttpError(400, 'Este é o único administrador ativo. Cadastre outro administrador antes.');
}

/**
 * Espelha no código a constraint `estoques_quantidade_nao_negativo` (Postgres):
 * no modo demonstração não há banco para segurar, e um saldo negativo editado à
 * mão invalidaria tudo que a matriz de estoque mostra.
 */
async function garantirSaldoNaoNegativo(data: Payload, before: Row | null): Promise<void> {
  if (data.quantidade === undefined || data.quantidade === null) return;
  const qtd = Number(data.quantidade);
  if (!Number.isFinite(qtd)) return; // a validação de tipo cuida disso
  if (qtd < 0) {
    const local = String(data.local ?? before?.local ?? 'estoque');
    throw new HttpError(
      400,
      `O saldo não pode ser negativo. Para lançar uma diferença de contagem use uma Saída ou um Ajuste em "${local}".`,
      { quantidade: 'Saldo não pode ser negativo' }
    );
  }
}

async function ensureUniqueStock(data: Payload, before: Row | null, tx: Tx) {
  const merged = { ...(before || {}), ...data };
  if (!merged.produto_id || !merged.tamanho_id) return;
  const s = getStore();
  const local = merged.local ?? (await getDefaultLocal(tx));
  const existing = await s.findOneWhere(getResource('estoques')!, { produto_id: merged.produto_id, tamanho_id: merged.tamanho_id, local }, tx ?? undefined);
  if (existing && (!before || Number(existing.id) !== Number(before.id))) {
    throw new HttpError(409, 'Já existe saldo para este produto, tamanho e local. Edite o registro existente ou lance uma movimentação.');
  }
}

/** Nome do Local padrão (origem das movimentações) ou 'loja' por segurança. */
export async function getDefaultLocal(tx?: Tx): Promise<string> {
  const info = await getDefaultLocalInfo(tx);
  return info?.nome ?? 'loja';
}

/**
 * Local padrão: o cadastrado com `padrao = true` e ativo; senão o primeiro
 * local ativo (por nome); senão null (aí os fluxos usam 'loja' por segurança).
 */
export async function getDefaultLocalInfo(tx?: Tx): Promise<{ id: number | null; nome: string } | null> {
  const s = getStore();
  const r = getResource('locais')!;
  const padrao = await s.findOneWhere(r, { padrao: true }, tx ?? undefined);
  if (padrao && ativoYn(padrao)) return { id: Number(padrao.id) || null, nome: String(padrao.nome) };
  const ativos = await s.list(r, { page: 1, pageSize: 1, sort: 'nome', dir: 'asc', filter: { ativo: true } }, tx ?? undefined);
  if (ativos.rows.length) return { id: Number(ativos.rows[0].id) || null, nome: String(ativos.rows[0].nome) };
  return null;
}

function ativoYn(row: Row): boolean {
  const v = row.ativo;
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'TRUE' || v === 'on' || v === 'sim';
}

/** Ao marcar um local como padrão, desmarca os demais (apenas um pode ser o padrão). */
async function ensureLocalPadraoUnico(data: Payload, before: Row | null, tx: Tx): Promise<void> {
  if (data.padrao !== true) return;
  const s = getStore();
  const r = getResource('locais')!;
  const demais = await s.list(r, { page: 1, pageSize: 1000, filter: { padrao: true } }, tx ?? undefined);
  for (const l of demais.rows) {
    if (!before || Number(l.id) !== Number(before.id)) {
      await s.update(r, Number(l.id), { padrao: false }, tx);
    }
  }
}

/** Garante que sempre exista um Local padrão ativo. */
async function garantirLocalPadrao(tx: Tx): Promise<void> {
  const s = getStore();
  const r = getResource('locais')!;
  const padrao = await s.findOneWhere(r, { padrao: true }, tx ?? undefined);
  if (padrao && ativoYn(padrao)) return;
  const ativos = await s.list(r, { page: 1, pageSize: 1, sort: 'nome', dir: 'asc', filter: { ativo: true } }, tx ?? undefined);
  if (!ativos.rows.length) return;
  await s.update(r, Number(ativos.rows[0].id), { padrao: true }, tx);
}

// ----------------------------------------------------------------------------
// Locais de estoque: gestão livre — a decisão é do administrador
// ----------------------------------------------------------------------------
// O local NÃO fica preso ao sistema: pode ser incluído, alterado e excluído
// mesmo quando já está em uso (saldos, movimentações, inventários, vendas).
//   • Renomear propaga o novo nome para todo o sistema (o nome do local é a
//     chave de texto do estoque).
//   • Excluir desfaz apenas os vínculos (chaves estrangeiras); o histórico
//     permanece com o nome do local como texto — nada é apagado.
// Gerente mantém o acesso normal, mas excluir/renomear local EM USO (ou excluir
// o último local ativo) é decisão exclusiva do administrador.

export type UsoLocal = { saldos: number; movimentacoes: number; inventarios: number; emUso: boolean };

/** Conta registros de `r` que apontam para o local pelo texto (`colTexto`) ou pelo id (`colId`). */
async function contarVinculos(r: Resource, colTexto: string, colId: string, nome: string, id: number, tx?: Tx): Promise<number> {
  const s = getStore();
  const porTexto = await s.countWhere(r, { [colTexto]: nome }, tx);
  const porId = await s.countWhere(r, { [colId]: id }, tx);
  const ambos = await s.countWhere(r, { [colTexto]: nome, [colId]: id }, tx);
  return porTexto + porId - ambos;
}

/** Quantos saldos, movimentações e inventários usam o local (por nome ou id). */
export async function usoDoLocal(local: Row, tx?: Tx): Promise<UsoLocal> {
  const id = Number(local.id);
  const nome = String(local.nome || '');
  const saldos = await contarVinculos(getResource('estoques')!, 'local', 'local_id', nome, id, tx);
  const movOrigem = await contarVinculos(getResource('movimentacoes')!, 'local', 'local_id', nome, id, tx);
  const movDestino = await contarVinculos(getResource('movimentacoes')!, 'local_destino', 'local_destino_id', nome, id, tx);
  const inventarios = await contarVinculos(getResource('inventarios')!, 'local', 'local_id', nome, id, tx);
  const movimentacoes = movOrigem + movDestino;
  return { saldos, movimentacoes, inventarios, emUso: saldos + movimentacoes + inventarios > 0 };
}

/** Anota cada local com o uso (a UI usa isso para avisar o administrador antes de excluir/renomear). */
async function anotarUsoLocal(r: Resource, rows: Row[]): Promise<void> {
  if (r.key !== 'locais' || !rows.length) return;
  const s = getStore();
  const ativos = await s.list(r, { page: 1, pageSize: 1, filter: { ativo: true } });
  for (const row of rows) {
    const uso = await usoDoLocal(row);
    row.em_uso = uso.emUso;
    row.uso_saldos = uso.saldos;
    row.uso_movimentacoes = uso.movimentacoes;
    row.uso_inventarios = uso.inventarios;
    row.eh_ultimo_ativo = ativoYn(row) && ativos.total <= 1;
  }
}

/**
 * Valida a alteração de nome de um local. Retorna true quando o nome muda.
 * Local em uso só o administrador renomeia; o nome novo não pode colidir com
 * outro local nem com saldos já gravados (chave produto+tamanho+local).
 */
async function validarRenomeLocal(data: Payload, before: Row, actor: Actor, tx: Tx): Promise<boolean> {
  if (data.nome === undefined || data.nome === null) return false;
  const novo = String(data.nome).trim();
  const antigo = String(before.nome || '');
  if (!novo || novo === antigo) return false;
  const s = getStore();
  const uso = await usoDoLocal(before, tx);
  if (uso.emUso && actor.perfil !== 'admin') {
    throw new HttpError(
      403,
      `O local "${antigo}" está em uso (${uso.saldos} saldo(s), ${uso.movimentacoes} movimentação(ões), ${uso.inventarios} inventário(s)). Renomeá-lo é uma decisão do administrador.`
    );
  }
  const outro = await s.findOneWhere(getResource('locais')!, { nome: novo }, tx);
  if (outro && Number(outro.id) !== Number(before.id)) {
    throw new HttpError(409, `Já existe outro local chamado "${novo}".`, { nome: 'Nome já cadastrado' });
  }
  const colisao = await s.countWhere(getResource('estoques')!, { local: novo }, tx);
  if (colisao > 0) {
    throw new HttpError(409, `Já existem saldos de estoque gravados com o nome "${novo}". Escolha outro nome para não misturar os estoques.`, { nome: 'Conflito com saldos existentes' });
  }
  return true;
}

/** Propaga o novo nome do local para os registros que guardavam o nome antigo como texto. */
async function propagarRenomeLocal(before: Row, novo: string, tx: Tx): Promise<void> {
  const antigo = String(before.nome || '');
  await renomearOnde(getResource('estoques')!, 'local', antigo, novo, tx);
  await renomearOnde(getResource('movimentacoes')!, 'local', antigo, novo, tx);
  await renomearOnde(getResource('movimentacoes')!, 'local_destino', antigo, novo, tx);
  await renomearOnde(getResource('inventarios')!, 'local', antigo, novo, tx);
  await renomearOnde(getResource('vendas')!, 'local_saida', antigo, novo, tx);
}

/** Renomeia em lotes os registros que guardam o nome do local em `col`. */
async function renomearOnde(r: Resource, col: string, antigo: string, novo: string, tx: Tx): Promise<void> {
  const s = getStore();
  for (;;) {
    const rows = await s.list(r, { page: 1, pageSize: 1000, filter: { [col]: antigo }, sort: 'id', dir: 'asc' }, tx);
    if (!rows.rows.length) break;
    for (const row of rows.rows) await s.update(r, Number(row.id), { [col]: novo }, tx);
    if (rows.rows.length < 1000) break;
  }
}

/**
 * Exclusão com o local em uso: zera as chaves estrangeiras (`*_id`) que apontam
 * para o local. O nome do local permanece nos registros como texto — saldos,
 * movimentações e inventários continuam legíveis e auditáveis.
 */
async function desvincularLocal(local: Row, tx: Tx): Promise<void> {
  const id = Number(local.id);
  await desvincularTodos(getResource('estoques')!, 'local_id', id, tx);
  await desvincularTodos(getResource('movimentacoes')!, 'local_id', id, tx);
  await desvincularTodos(getResource('movimentacoes')!, 'local_destino_id', id, tx);
  await desvincularTodos(getResource('inventarios')!, 'local_id', id, tx);
}

/** Zera a coluna de vínculo em todos os registros que apontam para o local. */
async function desvincularTodos(r: Resource, col: string, id: number, tx: Tx): Promise<void> {
  const s = getStore();
  for (;;) {
    const rows = await s.list(r, { page: 1, pageSize: 1000, filter: { [col]: id }, sort: 'id', dir: 'asc' }, tx);
    if (!rows.rows.length) break;
    for (const row of rows.rows) await s.update(r, Number(row.id), { [col]: null }, tx);
    if (rows.rows.length < 1000) break;
  }
}

/** Preenche `local` (e `local_id`) a partir do cadastro de Locais. */
async function resolveLocal(data: Payload, tx: Tx): Promise<void> {
  const s = getStore();
  let local = data.local === undefined || data.local === null ? '' : String(data.local).trim();
  const rawId = data.local_id;
  const localId = rawId === undefined || rawId === null || rawId === '' ? null : Number(rawId);

  if (localId && Number.isInteger(localId) && localId > 0) {
    const l = await s.findOneWhere(getResource('locais')!, { id: localId }, tx ?? undefined);
    if (!l) throw new HttpError(400, 'Local inválido: o registro selecionado não existe.', { local_id: 'Registro não encontrado' });
    if (!local) local = String(l.nome);
    data.local_id = localId;
  }
  if (!local) local = await getDefaultLocal(tx);
  if (local.length > 60) throw new HttpError(400, 'O nome do local é muito longo.', { local: 'Máximo de 60 caracteres' });
  data.local = local;
}

/** Movimentação de produtos acabados (entrada/saída/ajuste/transferência). */
async function createMovimentacao(data: Payload, actor: Actor, tx: Tx): Promise<Row> {
  const s = getStore();
  const mov = getResource('movimentacoes')!;
  const qtd = Number(data.quantidade);
  const tipo = String(data.tipo);

  if (tipo !== 'transferencia' && tipo !== 'ajuste' && qtd <= 0) {
    throw new HttpError(400, 'Para entrada e saída informe uma quantidade maior que zero.', { quantidade: 'Deve ser maior que zero' });
  }
  if (qtd === 0) throw new HttpError(400, 'A quantidade não pode ser zero.', { quantidade: 'Não pode ser zero' });

  await resolveLocal(data, tx);
  const local = String(data.local);
  const produtoId = Number(data.produto_id);
  const tamanhoId = Number(data.tamanho_id);
  const usuarioId = actor.id || null;

  // Nenhum tamanho fora da grade do produto (ver validarTamanhoNaGrade).
  await validarTamanhoNaGrade(produtoId, tamanhoId, tx);

  // Transferência entre locais: em UMA transação, saída na origem + entrada no
  // destino — duas linhas ligadas por transferencia_id.
  if (tipo === 'transferencia') {
    if (qtd <= 0) throw new HttpError(400, 'Informe uma quantidade maior que zero.', { quantidade: 'Deve ser maior que zero' });
    const rawDest = data.local_destino_id;
    const destId = rawDest === undefined || rawDest === null || rawDest === '' ? null : Number(rawDest);
    if (!destId || !Number.isInteger(destId)) {
      throw new HttpError(400, 'Escolha o local de destino da transferência.', { local_destino_id: 'Campo obrigatório' });
    }
    const destino = await s.findOneWhere(getResource('locais')!, { id: destId }, tx ?? undefined);
    if (!destino) throw new HttpError(400, 'Local de destino inválido: o registro selecionado não existe.', { local_destino_id: 'Registro não encontrado' });
    const localDestino = String(destino.nome);
    if (localDestino === local) throw new HttpError(400, 'A origem e o destino da transferência devem ser locais diferentes.', { local_destino_id: 'Escolha outro local' });

    const motivo = data.motivo ? String(data.motivo) : `Transferência para ${localDestino}`;
    // Retira na origem com a condição dentro do próprio UPDATE — ver tryAdjustStock.
    const retirado = await s.tryAdjustStock(produtoId, tamanhoId, local, -qtd, tx);
    if (!retirado) {
      const origem = await s.findOneWhere(getResource('estoques')!, { produto_id: produtoId, tamanho_id: tamanhoId, local }, tx ?? undefined);
      const atual = Number(origem?.quantidade ?? 0);
      throw new HttpError(409, `Saldo insuficiente para transferir: há ${atual} peça(s) em "${local}" e você quer transferir ${qtd}.`, { quantidade: `Saldo atual: ${atual}` });
    }
    const saida = await s.insert(mov, { tipo: 'saida', produto_id: produtoId, tamanho_id: tamanhoId, local, local_id: data.local_id ?? null, local_destino: localDestino, local_destino_id: destId, quantidade: qtd, motivo, usuario_id: usuarioId }, tx);
    await s.insert(mov, { tipo: 'entrada', produto_id: produtoId, tamanho_id: tamanhoId, local: localDestino, local_id: destId, transferencia_id: Number(saida.id), quantidade: qtd, motivo: `Transferência de ${local}`, usuario_id: usuarioId }, tx);
    await s.adjustStock(produtoId, tamanhoId, localDestino, qtd, tx);
    await s.update(mov, Number(saida.id), { transferencia_id: Number(saida.id) }, tx);
    await audit(tx, actor, 'criar', mov, Number(saida.id), `Transferência de ${qtd} un. de "${local}" para "${localDestino}" — ${await produtoTamanhoLabel(produtoId, tamanhoId, tx)}`, sanitize({ ...data, local, local_destino: localDestino }));
    return (await s.get(mov, Number(saida.id), tx)) ?? saida;
  }

  const delta = tipo === 'saida' ? -qtd : qtd;
  if (delta < 0) {
    // O abatimento é a primeira coisa e é condicional na própria escrita: checar
    // o saldo antes e gravar depois deixaria duas vendas concorrentes tirarem a
    // mesma peça (e o saldo virar negativo).
    const aplicado = await s.tryAdjustStock(produtoId, tamanhoId, local, delta, tx);
    if (!aplicado) {
      const saldo = await s.findOneWhere(getResource('estoques')!, { produto_id: produtoId, tamanho_id: tamanhoId, local }, tx ?? undefined);
      const atual = Number(saldo?.quantidade ?? 0);
      throw new HttpError(409, `Saldo insuficiente: há ${atual} peça(s) em "${local}" e a movimentação retiraria ${Math.abs(delta)}.`, { quantidade: `Saldo atual: ${atual}` });
    }
  }

  const row = await s.insert(mov, { ...data, local, local_id: data.local_id ?? null, local_destino: data.local_destino ?? null, local_destino_id: data.local_destino_id ?? null, usuario_id: usuarioId }, tx);
  if (delta > 0) await s.adjustStock(produtoId, tamanhoId, local, delta, tx);
  const full = (await s.get(mov, row.id, tx)) ?? row;
  await audit(tx, actor, 'criar', mov, row.id, `${tipo === 'entrada' ? 'Entrada' : tipo === 'saida' ? 'Saída' : 'Ajuste'} de ${qtd} un. — ${full.produto_id__label ?? '#' + produtoId} ${full.tamanho_id__label ?? ''} (${local})`, sanitize(data));
  return full;
}

/** Rótulo "Produto tam. X" para auditoria. */
async function produtoTamanhoLabel(produtoId: number, tamanhoId: number, tx?: Tx): Promise<string> {
  const s = getStore();
  const p = await s.findOneWhere(getResource('produtos')!, { id: produtoId }, tx);
  const t = await s.findOneWhere(getResource('tamanhos')!, { id: tamanhoId }, tx);
  const nome = p ? labelOf(getResource('produtos')!, p) : `#${produtoId}`;
  return `${nome}${t ? ` tam. ${t.codigo}` : ''}`.trim();
}

/** Movimentação manual de insumo (módulo Estoque de Insumos). */
async function createMovimentacaoInsumo(data: Payload, actor: Actor, tx: Tx): Promise<Row> {
  const s = getStore();
  const mov = getResource('movimentacoes_insumos')!;
  const qtd = Number(data.quantidade);
  const tipo = String(data.tipo);
  if (qtd === 0) throw new HttpError(400, 'A quantidade não pode ser zero.', { quantidade: 'Não pode ser zero' });
  if (tipo !== 'ajuste' && qtd <= 0) {
    throw new HttpError(400, 'Para entrada e saída informe uma quantidade maior que zero.', { quantidade: 'Deve ser maior que zero' });
  }
  const insumoId = Number(data.insumo_id);
  const delta = tipo === 'saida' ? -qtd : qtd;
  const atual = await s.insumoStock(insumoId, tx);
  if (atual + delta < 0) {
    const ins = await s.findOneWhere(getResource('insumos')!, { id: insumoId }, tx);
    const nome = ins ? labelOf(getResource('insumos')!, ins) : `#${insumoId}`;
    throw new HttpError(409, `Saldo insuficiente do insumo: há ${atual} de ${nome} e a movimentação retiraria ${Math.abs(delta)}.`, { quantidade: `Saldo atual: ${atual}` });
  }
  const row = await s.insert(mov, { ...data, usuario_id: actor.id || null }, tx);
  await s.adjustInsumoStock(insumoId, delta, tx);
  const ins = await s.findOneWhere(getResource('insumos')!, { id: insumoId }, tx);
  const nome = ins ? labelOf(getResource('insumos')!, ins) : `#${insumoId}`;
  const un = ins?.unidade || 'un';
  await audit(tx, actor, 'criar', mov, row.id, `${tipo === 'entrada' ? 'Entrada' : tipo === 'saida' ? 'Saída' : 'Ajuste'} de ${qtd} ${un} de ${nome}${data.motivo ? ` — ${data.motivo}` : ''}`, sanitize(data));
  return row;
}

/** Abrir inventário: congela o saldo do local em itens_inventario. */
async function abrirInventarioSnapshot(row: Row, actor: Actor, tx: Tx) {
  const s = getStore();
  const local = row.local ? String(row.local) : await getDefaultLocal(tx);
  const aberto = await s.findOneWhere(getResource('inventarios')!, { local, status: 'aberto' }, tx);
  if (aberto && Number(aberto.id) !== Number(row.id)) {
    throw new HttpError(409, `Já existe um inventário aberto para o local "${local}" (inventário #${aberto.id}). Feche-o antes de abrir outro.`);
  }
  const estoques = await s.list(getResource('estoques')!, { page: 1, pageSize: 20000, filter: { local } }, tx);
  // 2000 era o teto antigo e virava contagem silenciosa pela metade num local
  // maior — melhor recusar do que fechar um inventário incompleto.
  if (estoques.total > estoques.rows.length) {
    throw new HttpError(409, `O local "${local}" tem ${estoques.total} saldos e o snapshot só suporta ${estoques.rows.length} por inventário. Abra um inventário por produto/categoria.`);
  }
  const itensR = getResource('itens_inventario')!;
  const linhas = estoques.rows
    .filter((e) => Number(e.quantidade) !== 0 || Number(e.estoque_min || 0) !== 0)
    .map((e) => ({
      inventario_id: Number(row.id),
      produto_id: e.produto_id,
      tamanho_id: e.tamanho_id,
      saldo_sistema: Number(e.quantidade),
      contado: null,
      diferenca: 0,
    }));
  // Um INSERT por linha tornava abrir a contagem O(n) em round-trips (2 mil saldos
  // = 2 mil ida-e-volta no Postgres). Em lote é um statement só.
  await s.insertMany(itensR, linhas, tx);
  const n = linhas.length;
  await s.update(getResource('inventarios')!, Number(row.id), { aberto_por: actor.name }, tx);
  await s.audit(
    { usuario_id: actor.id || null, usuario: actor.name, acao: 'criar', recurso: 'inventarios', registro_id: Number(row.id), descricao: `Inventário #${row.id} aberto no local "${local}" — ${n} itens com saldo congelado`, dados: { itens: n } },
    tx
  );
}

/** Inventários: em edição, apenas observações, e somente enquanto estiver aberto. */
async function validarUpdateInventario(data: Payload, before: Row) {
  const permitidos = new Set(['observacoes', 'local', 'local_id']);
  const invalidos = Object.keys(data).filter((k) => !permitidos.has(k) && k !== 'atualizado_em' && k !== 'criado_em');
  if (invalidos.length) {
    throw new HttpError(400, 'Um inventário não pode ser alterado diretamente: use o fechamento (gera os ajustes) ou abra um novo.', { status: 'Use a ação "Fechar inventário"' });
  }
  if (before.status === 'fechado') {
    throw new HttpError(409, 'Este inventário já foi fechado e não pode mais ser alterado.');
  }
}
