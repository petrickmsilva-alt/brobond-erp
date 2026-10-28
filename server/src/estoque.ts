// ============================================================
// Fase 4 — Estoque e inventário.
//
//   GET  /api/estoques/grade             matriz produto × tamanhos
//   GET  /api/inventarios/:id/itens      contagem do inventário
//   PUT  /api/inventarios/:id/itens      contagem em lote { itens: [...] }
//   POST /api/inventarios/:id/fechar     gera ajustes (gerente/admin)
//
// A abertura do inventário (POST /api/inventarios) passa pelo CRUD genérico,
// que congela o saldo (abrirInventarioSnapshot em services.ts).
// ============================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { assertRegistroDaEmpresaParaEscrita, empresaDoRegistroAudit, validarReferenciasDaEmpresa } from './empresa';
import { RESOURCES } from './resources';
import { checkAccess, escopoDe, getStore, toHttpError, validarReferenciasDeSaida, validarTamanhoNaGrade } from './services';
import { currentUser } from './auth';
import type { Row, Tx } from './store';
import { parseId } from './validate';
import { labelOf } from './store';
import { searchProducts as buscarProdutosGlobais } from './productSearch';
import { agregarPorTamanho, celulasDaEmpresa, chaveTamanho, saldoVendavel, type CelulaCanonica } from './estoqueCanonico';

// ----------------------------------------------------------------------------
// GET /api/estoques/grade — matriz produto × tamanhos
// ----------------------------------------------------------------------------
export async function estoqueGrade(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.estoques, actor, 'read');
  const escopo = escopoDe(actor);
  const s = getStore();
  const queryId = (key: string): number | undefined => {
    const raw = req.query[key];
    if (raw === undefined || raw === '') return undefined;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, `Filtro ${key} inválido.`);
    return id;
  };
  const colecaoId = queryId('colecao_id');
  const categoriaId = queryId('categoria_id');
  const gradeId = queryId('grade_id');
  const localNome = typeof req.query.local === 'string' && req.query.local.trim() ? String(req.query.local).trim() : null;
  const localIdQuery = queryId('local_id');
  if (colecaoId && !await s.findOneWhere(RESOURCES.colecoes, { id: colecaoId, empresa_id: escopo.empresaId })) {
    throw new HttpError(404, 'Coleção não encontrada.');
  }
  if (gradeId && !await s.findOneWhere(RESOURCES.grades, { id: gradeId })) throw new HttpError(404, 'Grade não encontrada.');
  if (categoriaId && !await s.findOneWhere(RESOURCES.categorias, { id: categoriaId })) throw new HttpError(404, 'Categoria não encontrada.');
  let localSelecionado: Row | null = null;
  if (localIdQuery) localSelecionado = await s.findOneWhere(RESOURCES.locais, { id: localIdQuery, empresa_id: escopo.empresaId });
  else if (localNome) {
    const filtroLocal = { nome: localNome, empresa_id: escopo.empresaId };
    if (await s.countWhere(RESOURCES.locais, filtroLocal) > 1) throw new HttpError(409, 'O nome do local não identifica um único local desta empresa. Selecione pelo ID.');
    localSelecionado = await s.findOneWhere(RESOURCES.locais, filtroLocal);
  }
  if ((localIdQuery || localNome) && !localSelecionado) throw new HttpError(404, 'Local não encontrado.');
  if (localSelecionado && localNome && String(localSelecionado.nome) !== localNome) throw new HttpError(404, 'Local não encontrado.');

  const filtroProdutos: Record<string, unknown> = { empresa_id: escopo.empresaId };
  if (colecaoId) filtroProdutos.colecao_id = colecaoId;
  if (categoriaId) filtroProdutos.categoria_id = categoriaId;
  const termo = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const encontrados = termo
    ? await buscarProdutosGlobais(escopo, {
        q: termo,
        pageSize: 50,
        localId: localSelecionado ? Number(localSelecionado.id) : null,
        includeInactive: true,
      })
    : null;
  const idsEncontrados = encontrados
    ? new Set(encontrados.rows.flatMap((row) => [row.id, ...row.variacoes.map((variant) => variant.id)]))
    : null;
  const [produtos, tamanhos, categorias, grades, gradeTamanhos, locais, colecoes, celulasCanonicas] = await Promise.all([
    s.list(RESOURCES.produtos, { page: 1, pageSize: 2000, filter: filtroProdutos }),
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 200, sort: 'ordem', dir: 'asc' }),
    s.list(RESOURCES.categorias, { page: 1, pageSize: 2000 }),
    s.list(RESOURCES.grades, { page: 1, pageSize: 2000 }),
    s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 10000, sort: 'ordem', dir: 'asc' }),
    s.list(RESOURCES.locais, { page: 1, pageSize: 2000, filter: { empresa_id: escopo.empresaId } }),
    s.list(RESOURCES.colecoes, { page: 1, pageSize: 20000, filter: { empresa_id: escopo.empresaId } }),
    // REGRA CANÔNICA (estoqueCanonico.ts): identidade empresa+produto+tamanho+
    // local, vínculo legado por nome e falha fechada em saldo duplicado. É a
    // MESMA leitura que o PDV usa — não existe uma segunda agregação de grade.
    celulasDaEmpresa(escopo),
  ]);
  if ([produtos, tamanhos, categorias, grades, gradeTamanhos, locais, colecoes].some((result) => result.total > result.rows.length)) {
    throw new HttpError(409, 'A grade do estoque excede o limite seguro de leitura. Nenhum resultado parcial foi retornado.');
  }
  await Promise.all([validarReferenciasDeSaida(RESOURCES.produtos, produtos.rows, escopo)]);
  const nomesLocais = new Set<string>();
  for (const local of locais.rows) {
    const nome = String(local.nome || '');
    if (nomesLocais.has(nome)) throw new HttpError(409, 'Há nomes de locais duplicados nesta empresa. Corrija-os antes de consultar o estoque.');
    nomesLocais.add(nome);
  }

  const codigoPor = new Map(tamanhos.rows.map((t) => [Number(t.id), String(t.codigo || '')]));
  const colecaoPorId = new Map(colecoes.rows.map((c) => [Number(c.id), c]));
  for (const produto of produtos.rows) {
    if (produto.colecao_id !== null && produto.colecao_id !== undefined && produto.colecao_id !== '' && !colecaoPorId.has(Number(produto.colecao_id))) {
      throw new HttpError(404, 'Coleção não encontrada.');
    }
  }
  const gradePorCategoria = new Map(categorias.rows.map((c) => [Number(c.id), Number(c.grade_id) || 0]));
  const nomePorGrade = new Map(grades.rows.map((g) => [Number(g.id), String(g.nome || '')]));
  const tamsPorGrade = new Map<number, number[]>();
  for (const it of gradeTamanhos.rows) {
    const g = Number(it.grade_id);
    if (!tamsPorGrade.has(g)) tamsPorGrade.set(g, []);
    tamsPorGrade.get(g)!.push(Number(it.tamanho_id));
  }
  const resolveGrade = (p: Row): number => Number(p.grade_id) || gradePorCategoria.get(Number(p.categoria_id)) || 0;
  const idSemTamanho = 0; // sentinela da API; não é um ID armazenado em tamanhos.
  const temSemTamanho = celulasCanonicas.some((celula) => celula.tamanho_id === null);
  const colunasBase = gradeId
    ? (tamsPorGrade.get(gradeId) ?? []).map((id) => ({ id, codigo: codigoPor.get(id) ?? `#${id}` }))
    : tamanhos.rows.map((t) => ({ id: Number(t.id), codigo: String(t.codigo || '') }));
  const colunas = temSemTamanho ? [...colunasBase, { id: idSemTamanho, codigo: 'Sem tamanho' }] : colunasBase;

  const filtrados = produtos.rows.filter((p) => {
    if (gradeId && resolveGrade(p) !== gradeId) return false;
    if (idsEncontrados && !idsEncontrados.has(Number(p.id))) return false;
    return true;
  });
  // A Grade tem UM escopo explícito: todos os locais (estoque físico) ou um
  // local. O PDV/Venda tem outro (a célula do local que a venda debita). Ambos
  // saem deste mesmo módulo — o que muda é o filtro de local, nunca a regra.
  const escopoLocalId = localSelecionado ? Number(localSelecionado.id) : null;
  const estoqueVisivel: CelulaCanonica[] = escopoLocalId === null
    ? celulasCanonicas
    : celulasCanonicas.filter((celula) => celula.local_id === escopoLocalId);
  const linhas = filtrados.map((p) => {
    const doProduto = estoqueVisivel.filter((celula) => celula.produto_id === Number(p.id));
    const porTamanho = agregarPorTamanho(doProduto);
    const gradeDoP = resolveGrade(p);
    const idsLinha = gradeId
      ? colunasBase.map((c) => c.id)
      : gradeDoP ? tamsPorGrade.get(gradeDoP) ?? [] : colunasBase.map((c) => c.id);
    const celulas = idsLinha.map((tid) => {
      const saldo = porTamanho.get(chaveTamanho(tid));
      return {
        tamanho_id: tid,
        quantidade: saldo?.quantidade ?? 0,
        estoque_min: saldo?.estoque_min ?? 0,
      };
    });
    if (temSemTamanho) {
      const semTamanho = porTamanho.get(chaveTamanho(null));
      celulas.push({
        tamanho_id: idSemTamanho,
        quantidade: semTamanho?.quantidade ?? 0,
        estoque_min: semTamanho?.estoque_min ?? 0,
      });
    }
    return {
      produto: {
        id: Number(p.id), sku: p.sku, nome: p.nome,
        cor: p.cor_id__label ?? p.cor ?? null,
        cor_hex: p.cor_id__color ?? null,
        categoria_id__label: p.categoria_id__label ?? null,
        colecao_id__label: p.colecao_id ? labelOf(RESOURCES.colecoes, colecaoPorId.get(Number(p.colecao_id))!) : null,
        grade_id: gradeDoP || null,
        grade_nome: gradeDoP ? nomePorGrade.get(gradeDoP) ?? null : null,
        foto_url: p.foto_url ?? null,
        preco_venda: Number(p.preco_venda || 0),
        custo: Number(p.custo || 0),
      },
      celulas,
      total: celulas.reduce((a, c) => a + c.quantidade, 0),
    };
  });

  res.json({
    colunas,
    colunasPorGrade: Object.fromEntries(
      Array.from(tamsPorGrade.entries()).map(([gid, ids]) => [gid, [
        ...ids.map((id) => ({ id, codigo: codigoPor.get(id) ?? `#${id}` })),
        ...(temSemTamanho ? [{ id: idSemTamanho, codigo: 'Sem tamanho' }] : []),
      ]])
    ),
    local: localSelecionado?.nome ?? 'todos',
    local_id: localSelecionado?.id ?? null,
    // Semântica explícita: a Grade mostra ESTOQUE FÍSICO. Com "todos" a célula
    // soma os locais; com um local, mostra só aquela célula. O disponível para
    // venda é sempre o da célula do local de saída da venda (PDV/Vendas), que
    // pode ser menor que o físico total — por desenho, não por divergência.
    escopo_saldo: {
      tipo: localSelecionado ? 'local' : 'todos',
      local_id: localSelecionado?.id ?? null,
      local: localSelecionado?.nome ?? null,
      semantica: localSelecionado
        ? 'estoque_fisico_do_local'
        : 'estoque_fisico_total_da_empresa',
      descricao: localSelecionado
        ? `Estoque físico do local "${String(localSelecionado.nome)}" (empresa + produto + tamanho + local).`
        : 'Estoque físico somado de todos os locais da empresa (empresa + produto + tamanho). O PDV/Venda mostra o disponível no local de saída.',
    },
    locaisDisponiveis: locais.rows.map((l) => String(l.nome)).sort(),
    totalPecas: linhas.reduce((a, l) => a + l.total, 0),
    busca: encontrados ? { q: termo, total: encontrados.total, exibidos: encontrados.rows.length, hasMore: encontrados.hasMore } : null,
    linhas,
  });
}

/**
 * GET /api/estoques/disponivel?produto_id=&tamanho_id=&local_id=
 *
 * Disponibilidade canônica de UMA célula para a venda: o que a linha consegue
 * baixar no local de saída (com o mesmo fallback para o Local padrão do
 * faturamento), ao lado do estoque físico do tamanho. PDV e Vendas exibem ESTE
 * número — nenhuma tela recalcula saldo a partir da grade.
 */
export async function estoqueDisponivel(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.estoques, actor, 'read');
  const escopo = escopoDe(actor);
  const produtoId = Number(req.query.produto_id);
  if (!Number.isInteger(produtoId) || produtoId <= 0) {
    throw new HttpError(400, 'Informe produto_id válido.', { produto_id: 'Obrigatório' });
  }
  const tamanhoRaw = req.query.tamanho_id;
  const tamanhoId = tamanhoRaw === undefined || tamanhoRaw === null || tamanhoRaw === '' ? null : Number(tamanhoRaw);
  if (tamanhoId !== null && (!Number.isInteger(tamanhoId) || tamanhoId <= 0)) {
    throw new HttpError(400, 'tamanho_id inválido.', { tamanho_id: 'Inválido' });
  }
  const localRaw = req.query.local_id;
  const localId = localRaw === undefined || localRaw === null || localRaw === '' ? null : Number(localRaw);
  if (localId !== null && (!Number.isInteger(localId) || localId <= 0)) {
    throw new HttpError(400, 'local_id inválido.', { local_id: 'Inválido' });
  }
  const saldo = await saldoVendavel(escopo, produtoId, tamanhoId, localId);
  res.json({
    produto_id: produtoId,
    tamanho_id: saldo.tamanho_id,
    // Vendável: o faturamento debita um local por item (saída → fallback padrão).
    quantidade: saldo.quantidade,
    local_id: saldo.local_id,
    local: saldo.local,
    por_local: saldo.por_local,
    // Físico: todos os locais; a diferença é legítima e explícita.
    estoque_fisico: saldo.fisico,
    outros_locais: saldo.outros_locais,
    semantica: 'estoque_vendavel_no_local_de_saida',
  });
}

// ----------------------------------------------------------------------------
// Inventário — itens e fechamento
// ----------------------------------------------------------------------------

async function getInventario(id: number, empresaId: number, tx?: Tx): Promise<Row> {
  const s = getStore();
  const row = await s.findOneWhere(RESOURCES.inventarios, { id, empresa_id: empresaId }, tx);
  if (!row) throw new HttpError(404, 'Inventário não encontrado.');
  if (row.local_id !== null && row.local_id !== undefined) {
    const localId = Number(row.local_id);
    const local = Number.isInteger(localId) && localId > 0 ? await s.findOneWhere(RESOURCES.locais, { id: localId, empresa_id: empresaId }, tx) : null;
    if (!local) throw new HttpError(404, 'Inventário não encontrado.');
    if (row.local && String(row.local) !== String(local.nome)) throw new HttpError(409, 'O inventário possui nome histórico inconsistente com seu vínculo de local.');
  }
  return row;
}

function validarItensInventarioUnicos(itens: Row[]): void {
  const chaves = new Set<string>();
  for (const item of itens) {
    const chave = `${Number(item.empresa_id)}:${Number(item.inventario_id)}:${Number(item.produto_id)}:${item.tamanho_id === null || item.tamanho_id === undefined ? 'null' : Number(item.tamanho_id)}`;
    if (chaves.has(chave)) throw new HttpError(409, 'Há linhas duplicadas para produto/tamanho neste inventário. Revise os dados históricos antes de consultar ou alterar a contagem.');
    chaves.add(chave);
  }
}

/** GET /api/inventarios/:id/itens */
export async function listItensInventario(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.inventarios, actor, 'read');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  await getInventario(id, escopo.empresaId);
  const s = getStore();
  const itens = await s.list(RESOURCES.itens_inventario, { page: 1, pageSize: 5000, filter: { inventario_id: id, empresa_id: escopo.empresaId }, sort: 'id', dir: 'asc' });
  if (itens.total > itens.rows.length) throw new HttpError(409, 'O inventário excede o limite seguro de leitura. Nenhum dado parcial foi retornado.');
  validarItensInventarioUnicos(itens.rows);
  // Anexa miniatura e a grade do produto: a contagem é agrupada por grade, do
  // mesmo jeito que o Estoque Físico, para a conferência seguir a mesma ordem.
  const [produtos, categorias, grades] = await Promise.all([
    s.list(RESOURCES.produtos, { page: 1, pageSize: 20000, filter: { empresa_id: escopo.empresaId } }),
    s.list(RESOURCES.categorias, { page: 1, pageSize: 20000 }),
    s.list(RESOURCES.grades, { page: 1, pageSize: 20000 }),
  ]);
  if ([produtos, categorias, grades].some((result) => result.total > result.rows.length)) throw new HttpError(409, 'Os cadastros do inventário excedem o limite seguro de leitura.');
  await validarReferenciasDeSaida(RESOURCES.produtos, produtos.rows, escopo);
  for (const item of itens.rows) {
    await validarTamanhoNaGrade(
      Number(item.produto_id),
      item.tamanho_id === null || item.tamanho_id === undefined ? null : Number(item.tamanho_id),
      undefined,
      escopo
    );
  }
  const { attachImages } = await import('./uploads');
  await attachImages(RESOURCES.produtos, produtos.rows);
  const fotoPor = new Map(produtos.rows.map((p) => [Number(p.id), p.foto_url ?? null]));
  const produtoPor = new Map(produtos.rows.map((p) => [Number(p.id), p]));
  const gradePorCategoria = new Map(categorias.rows.map((c) => [Number(c.id), Number(c.grade_id) || 0]));
  const nomePorGrade = new Map(grades.rows.map((g) => [Number(g.id), String(g.nome || '')]));
  /** Grade efetiva do produto: grade própria, senão a da categoria. */
  const gradeEfetiva = (produtoId: unknown): number => {
    const p = produtoPor.get(Number(produtoId));
    if (!p) return 0;
    return Number(p.grade_id) || gradePorCategoria.get(Number(p.categoria_id)) || 0;
  };
  for (const it of itens.rows) {
    it.produto_id__foto = fotoPor.get(Number(it.produto_id)) ?? null;
    const p = produtoPor.get(Number(it.produto_id));
    it.produto_id__label = it.produto_id__label ?? (p ? labelOf(RESOURCES.produtos, p) : null);
    it.tamanho_id__label = it.tamanho_id__label ?? null;
    const gid = gradeEfetiva(it.produto_id);
    it.produto_id__grade_id = gid || null;
    it.produto_id__grade_nome = gid ? nomePorGrade.get(gid) ?? `Grade #${gid}` : null;
    it.diferenca = it.contado === null || it.contado === undefined ? 0 : Number(it.contado) - Number(it.saldo_sistema);
  }
  res.json(itens.rows);
}

/**
 * PUT /api/inventarios/:id/itens — contagem em lote.
 * Body: { itens: [{ id?, produto_id?, tamanho_id?, contado }] }
 * Para produtos/tamanhos sem linha prévia (saldo zero), cria com saldo 0.
 */
export async function updateItensInventario(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.inventarios, actor, 'update');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const inv = await getInventario(id, escopo.empresaId, tx);
      if (String(inv.status) !== 'aberto') throw new HttpError(409, 'Este inventário já foi fechado e a contagem não pode mais mudar.');
      if (inv.modalidade === 'ciclica_abc' && inv.contagem_status === 'APROVADA') throw new HttpError(409, 'A contagem aprovada é imutável; cancele o plano e abra nova contagem para corrigir.');
      const itensExistentes = await s.list(RESOURCES.itens_inventario, { page: 1, pageSize: 5000, filter: { inventario_id: id, empresa_id: escopo.empresaId } }, tx);
      if (itensExistentes.total > itensExistentes.rows.length) throw new HttpError(409, 'O inventário excede o limite seguro de atualização. Nenhuma contagem foi alterada.');
      validarItensInventarioUnicos(itensExistentes.rows);

      const body = (req.body || {}) as { itens?: unknown };
      const lista = Array.isArray(body.itens) ? (body.itens as Record<string, unknown>[]) : [];
      if (!lista.length) throw new HttpError(400, 'Envie ao menos um item com a contagem (body: { itens: [...] }).');

      let alterados = 0;
      for (const raw of lista) {
        const itemIdRaw = raw.id;
        const itemId = itemIdRaw === undefined || itemIdRaw === null || itemIdRaw === '' ? null : Number(itemIdRaw);
        if (itemId !== null && (!Number.isInteger(itemId) || itemId <= 0)) throw new HttpError(400, 'ID do item de inventário inválido.');
        const contado = raw.contado === undefined || raw.contado === null || raw.contado === '' ? null : Number(raw.contado);
        if (contado !== null && (!Number.isInteger(contado) || contado < 0)) {
          throw new HttpError(400, 'A quantidade contada deve ser um número inteiro ≥ 0.', { contado: 'Valor inválido' });
        }
        if (itemId !== null) {
          const before = await s.findOneWhere(RESOURCES.itens_inventario, { id: itemId, inventario_id: id, empresa_id: escopo.empresaId }, tx);
          if (!before) throw new HttpError(404, 'Item não encontrado neste inventário.');
          await validarTamanhoNaGrade(
            Number(before.produto_id),
            before.tamanho_id === null || before.tamanho_id === undefined ? null : Number(before.tamanho_id),
            tx,
            escopo
          );
          const diferenca = contado === null ? 0 : contado - Number(before.saldo_sistema || 0);
          await s.update(RESOURCES.itens_inventario, itemId, { contado, diferenca, contado_por: actor.id || null, contado_em: new Date().toISOString() }, tx);
          alterados++;
          continue;
        }
        // Linha nova: permite contar item achado mesmo com saldo zero, inclusive
        // produto sem tamanho (`tamanho_id = NULL`).
        const produtoId = Number(raw.produto_id);
        if (!Number.isInteger(produtoId) || produtoId <= 0) throw new HttpError(400, 'Cada item deve ter id OU produto_id válido.');
        const tamanhoRaw = raw.tamanho_id;
        const tamanhoId = tamanhoRaw === undefined || tamanhoRaw === null || tamanhoRaw === '' ? null : Number(tamanhoRaw);
        if (tamanhoId !== null && (!Number.isInteger(tamanhoId) || tamanhoId <= 0)) throw new HttpError(400, 'Tamanho inválido.');
        const produto = await s.findOneWhere(RESOURCES.produtos, { id: produtoId, empresa_id: escopo.empresaId }, tx);
        if (!produto) throw new HttpError(404, 'Produto não encontrado.');
        if (tamanhoId !== null && !await s.findOneWhere(RESOURCES.tamanhos, { id: tamanhoId }, tx)) throw new HttpError(404, 'Tamanho não encontrado.');
        await validarTamanhoNaGrade(produtoId, tamanhoId, tx, escopo);
        if (contado === null) continue;
        const filtroExistente = {
          empresa_id: escopo.empresaId,
          inventario_id: id,
          produto_id: produtoId,
          tamanho_id: tamanhoId,
        };
        if (await s.countWhere(RESOURCES.itens_inventario, filtroExistente, tx) > 1) {
          throw new HttpError(409, 'Há linhas duplicadas para este produto/tamanho no inventário. Nada foi alterado; revise os dados históricos.');
        }
        const existente = await s.findOneWhere(RESOURCES.itens_inventario, filtroExistente, tx);
        if (existente) {
          await s.update(RESOURCES.itens_inventario, Number(existente.id), { contado, diferenca: contado - Number(existente.saldo_sistema || 0), contado_por: actor.id || null, contado_em: new Date().toISOString() }, tx);
        } else {
          await s.insert(RESOURCES.itens_inventario, { empresa_id: escopo.empresaId, inventario_id: id, produto_id: produtoId, tamanho_id: tamanhoId, saldo_sistema: 0, contado, diferenca: contado, contado_por: actor.id || null, contado_em: new Date().toISOString() }, tx);
        }
        alterados++;
      }
      if (alterados > 0 && inv.modalidade === 'ciclica_abc') {
        await s.update(RESOURCES.inventarios, id, { contagem_status: 'EM_CONTAGEM', conferido_por: null, conferido_em: null, aprovado_por: null, aprovado_em: null }, tx);
      }
      if (alterados > 0) {
        await s.audit(
          { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'inventarios', registro_id: id, descricao: `Inventário #${id}: contagem atualizada (${alterados} linha(s))`, empresa_id: empresaDoRegistroAudit(RESOURCES.inventarios, inv, actor) },
          tx
        );
      }
      return { ok: true, alterados };
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, RESOURCES.itens_inventario);
  }
}

/** A conferência é uma transição explícita; saldo congelado nunca é editável. */
export async function conferirContagemCiclica(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') throw new HttpError(403, 'Somente gerentes e administradores podem conferir uma contagem cíclica.');
  checkAccess(RESOURCES.inventarios, actor, 'update');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const result = await s.transaction(async (tx) => {
      const inv = await getInventario(id, escopo.empresaId, tx);
      if (inv.modalidade !== 'ciclica_abc') throw new HttpError(409, 'O inventário não é uma contagem cíclica ABC.');
      if (inv.status !== 'aberto') throw new HttpError(409, 'O inventário não está aberto.');
      if (!['EM_CONTAGEM', 'PLANEJADA', 'CONFERIDA'].includes(String(inv.contagem_status))) throw new HttpError(409, 'Estado inválido para conferência.');
      const itens = await s.list(RESOURCES.itens_inventario, { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId, inventario_id: id } }, tx);
      if (!itens.rows.length || itens.total > itens.rows.length) throw new HttpError(409, 'A contagem está vazia ou excede o limite seguro.');
      if (itens.rows.some((item) => item.contado === null || item.contado === undefined)) throw new HttpError(409, 'Todos os itens do snapshot precisam ser contados antes da conferência.');
      const agora = new Date().toISOString();
      await s.update(RESOURCES.inventarios, id, { contagem_status: 'CONFERIDA', conferido_por: actor.id || null, conferido_em: agora, aprovado_por: null, aprovado_em: null }, tx);
      await s.audit({ usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'inventarios', registro_id: id, descricao: `Contagem cíclica #${id} conferida (${itens.rows.length} itens)`, dados: { itens: itens.rows.length }, empresa_id: empresaDoRegistroAudit(RESOURCES.inventarios, inv, actor) }, tx);
      return { ok: true, contagem_status: 'CONFERIDA', itens: itens.rows.length, conferido_em: agora };
    });
    res.json(result);
  } catch (error) { throw toHttpError(error, RESOURCES.inventarios); }
}

/** Aprovação explícita por gerente/admin antecede o motor canônico de fechamento. */
export async function aprovarContagemCiclica(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') throw new HttpError(403, 'Somente gerentes e administradores podem aprovar uma contagem cíclica.');
  checkAccess(RESOURCES.inventarios, actor, 'update');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const result = await s.transaction(async (tx) => {
      const inv = await getInventario(id, escopo.empresaId, tx);
      if (inv.modalidade !== 'ciclica_abc') throw new HttpError(409, 'O inventário não é uma contagem cíclica ABC.');
      if (inv.status !== 'aberto' || inv.contagem_status !== 'CONFERIDA') throw new HttpError(409, 'Somente uma contagem conferida e aberta pode ser aprovada.');
      const itens = await s.list(RESOURCES.itens_inventario, { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId, inventario_id: id } }, tx);
      if (!itens.rows.length || itens.total > itens.rows.length || itens.rows.some((item) => item.contado === null || item.contado === undefined)) throw new HttpError(409, 'A contagem foi alterada ou está incompleta; confira novamente.');
      const agora = new Date().toISOString();
      await s.update(RESOURCES.inventarios, id, { contagem_status: 'APROVADA', aprovado_por: actor.id || null, aprovado_em: agora }, tx);
      await s.audit({ usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'inventarios', registro_id: id, descricao: `Contagem cíclica #${id} aprovada para ajuste de estoque`, dados: { itens: itens.rows.length }, empresa_id: empresaDoRegistroAudit(RESOURCES.inventarios, inv, actor) }, tx);
      return { ok: true, contagem_status: 'APROVADA', aprovado_em: agora };
    });
    res.json(result);
  } catch (error) { throw toHttpError(error, RESOURCES.inventarios); }
}

/** Cancelamento explícito do plano antes da aprovação; não toca saldo nem movimentos. */
export async function cancelarContagemCiclica(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') throw new HttpError(403, 'Somente gerentes e administradores podem cancelar uma contagem cíclica.');
  checkAccess(RESOURCES.inventarios, actor, 'update');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const result = await s.transaction(async (tx) => {
      const inv = await getInventario(id, escopo.empresaId, tx);
      if (inv.modalidade !== 'ciclica_abc') throw new HttpError(409, 'O inventário não é uma contagem cíclica ABC.');
      if (inv.contagem_status === 'CANCELADA') return { ok: true, idempotente: true, contagem_status: 'CANCELADA' };
      if (inv.status !== 'aberto' || inv.contagem_status === 'APROVADA') throw new HttpError(409, 'Somente plano aberto ainda não aprovado pode ser cancelado.');
      const agora = new Date().toISOString();
      await s.update(RESOURCES.inventarios, id, { status: 'fechado', fechado_por: actor.name, fechado_em: agora, contagem_status: 'CANCELADA' }, tx);
      await s.audit({ usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'inventarios', registro_id: id, descricao: `Plano de contagem cíclica #${id} cancelado; nenhum ajuste de estoque foi aplicado`, empresa_id: empresaDoRegistroAudit(RESOURCES.inventarios, inv, actor) }, tx);
      return { ok: true, contagem_status: 'CANCELADA', fechado_em: agora };
    });
    res.json(result);
  } catch (error) { throw toHttpError(error, RESOURCES.inventarios); }
}

/** POST /api/inventarios/:id/fechar — gera os ajustes de estoque (1ª e única vez). */
export async function fecharInventario(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') {
    throw new HttpError(403, 'Somente gerentes e administradores podem fechar inventários (os ajustes alteram o estoque).');
  }
  checkAccess(RESOURCES.inventarios, actor, 'update');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const inv = await getInventario(id, escopo.empresaId, tx);
      if (String(inv.status) === 'fechado') {
        if (inv.modalidade === 'ciclica_abc' && inv.contagem_status === 'CANCELADA') throw new HttpError(409, 'Este plano foi cancelado e não pode gerar ajustes de estoque.');
        if (inv.modalidade === 'ciclica_abc') {
          const existentes = await s.list(RESOURCES.movimentacoes, { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId, inventario_id: id } }, tx);
          if (existentes.total > existentes.rows.length) throw new HttpError(409, 'O histórico de ajustes deste inventário excede o limite seguro.');
          return { ok: true, idempotente: true, ajustes: existentes.total, fechado_em: inv.fechado_em };
        }
        throw new HttpError(409, `O inventário #${id} já foi fechado em ${String(inv.fechado_em || '').slice(0, 16)}. Os ajustes só podem ser gerados uma vez.`);
      }
      if (inv.modalidade === 'ciclica_abc' && inv.contagem_status !== 'APROVADA') {
        throw new HttpError(409, 'A contagem cíclica precisa ser conferida e aprovada explicitamente antes de gerar ajustes.');
      }
      const localId = Number(inv.local_id);
      if (!Number.isInteger(localId) || localId <= 0) {
        throw new HttpError(409, 'Este inventário não possui um vínculo canônico de local. Nenhum ajuste foi aplicado; revise o vínculo antes de fechar.');
      }
      const localRow = await s.findOneWhere(RESOURCES.locais, { id: localId, empresa_id: escopo.empresaId }, tx);
      if (!localRow) throw new HttpError(404, 'Local não encontrado.');
      const local = String(localRow.nome);
      if (await s.countWhere(RESOURCES.estoques, { empresa_id: escopo.empresaId, local, local_id: null }, tx) > 0) {
        throw new HttpError(409, 'Há saldos sem vínculo canônico para este local. Nenhum ajuste foi aplicado; revise os dados históricos.');
      }
      const itens = await s.list(RESOURCES.itens_inventario, {
        page: 1,
        pageSize: 5000,
        filter: { inventario_id: id, empresa_id: escopo.empresaId },
      }, tx);
      if (itens.total > itens.rows.length) throw new HttpError(409, 'O inventário excede o limite seguro de fechamento. Nenhum ajuste foi aplicado.');
      validarItensInventarioUnicos(itens.rows);
      let ajustes = 0;
      const detalhes: string[] = [];
      const deslocados: string[] = [];
      for (const it of itens.rows) {
        const produtoId = Number(it.produto_id);
        const tamanhoId = it.tamanho_id === null || it.tamanho_id === undefined ? null : Number(it.tamanho_id);
        await validarTamanhoNaGrade(produtoId, tamanhoId, tx, escopo);
        // linha não contada não gera ajuste
        if (it.contado === null || it.contado === undefined) continue;
        const saldoSistema = Number(it.saldo_sistema || 0);
        const contado = Number(it.contado);
        const p = await s.findOneWhere(RESOURCES.produtos, { id: produtoId, empresa_id: escopo.empresaId }, tx);
        if (!p) throw new HttpError(404, 'Produto não encontrado.');
        const t = tamanhoId === null ? null : await s.findOneWhere(RESOURCES.tamanhos, { id: tamanhoId }, tx);
        if (tamanhoId !== null && !t) throw new HttpError(404, 'Tamanho não encontrado.');
        const nome = `${labelOf(RESOURCES.produtos, p)}${t?.codigo ? ` ${t.codigo}` : ''}`;

        // O alvo é o CONTADO, e o ponto de partida é o saldo de AGORA: se alguém
        // movimentou o SKU com a contagem aberta, o saldo congelado na abertura já
        // não representa a realidade — fechar sobre ele deixava o estoque errado
        // (e, com sorte, negativo).
        const filtroSaldo = {
          empresa_id: escopo.empresaId,
          produto_id: produtoId,
          tamanho_id: tamanhoId,
          local,
        };
        if (await s.countWhere(RESOURCES.estoques, filtroSaldo, tx) > 1) {
          throw new HttpError(409, 'Há saldos duplicados para este produto/tamanho/local. Nenhum ajuste foi aplicado; revise os dados históricos antes de fechar o inventário.');
        }
        const linha = await s.findOneWhere(RESOURCES.estoques, filtroSaldo, tx);
        if (linha && (linha.local_id === null || linha.local_id === undefined || Number(linha.local_id) !== localId)) {
          throw new HttpError(409, 'O saldo possui vínculo de local inconsistente ou ausente. Nenhum ajuste foi aplicado.');
        }
        const saldoAtual = Number(linha?.quantidade ?? 0);
        if (saldoAtual !== saldoSistema) deslocados.push(`${nome}: congelado ${saldoSistema} → atual ${saldoAtual}`);
        const delta = contado - saldoAtual;
        if (delta === 0) continue;

        if (delta < 0) {
          const aplicado = await s.tryAdjustStock(produtoId, tamanhoId, local, delta, tx, 0, localId, escopo.empresaId);
          if (!aplicado) {
            throw new HttpError(409, `O inventário #${id} baixaria ${Math.abs(delta)} peça(s) de "${nome}", mas só há ${saldoAtual} em "${local}".`);
          }
        } else {
          await s.adjustStock(produtoId, tamanhoId, local, delta, tx, localId, escopo.empresaId);
        }
        const movimentacao = await s.insert(
          RESOURCES.movimentacoes,
          { empresa_id: escopo.empresaId, tipo: 'ajuste', produto_id: produtoId, tamanho_id: tamanhoId, local, local_id: localId, quantidade: delta, motivo: `Inventário #${id}`, inventario_id: inv.modalidade === 'ciclica_abc' ? id : null, usuario_id: actor.id || null },
          tx
        );
        if (inv.modalidade === 'ciclica_abc') await s.update(RESOURCES.itens_inventario, Number(it.id), { movimentacao_id: Number(movimentacao.id) }, tx);
        detalhes.push(`${nome}: ${saldoAtual} → ${contado}`);
        ajustes++;
      }
      await s.update(RESOURCES.inventarios, id, { status: 'fechado', fechado_por: actor.name, fechado_em: new Date().toISOString() }, tx);
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'ajuste',
          recurso: 'inventarios',
          registro_id: id,
          descricao: `Inventário #${id} fechado no local "${local}" — ${ajustes} ajuste(s) gerado(s): ${detalhes.join('; ')}${deslocados.length ? ` | movimentação durante a contagem: ${deslocados.join('; ')}` : ''}`,
          dados: { ajustes, local, deslocados },
          empresa_id: empresaDoRegistroAudit(RESOURCES.inventarios, inv, actor),
        },
        tx
      );
      return { ok: true, ajustes, deslocados, fechado_em: new Date().toISOString() };
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, RESOURCES.inventarios);
  }
}

/** GET /api/inventarios/:id — com resumo da contagem (diferenças). */
export async function getInventarioDetalhe(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.inventarios, actor, 'read');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const inv = await getInventario(id, escopo.empresaId);
  const s = getStore();
  const itens = await s.list(RESOURCES.itens_inventario, {
    page: 1,
    pageSize: 5000,
    filter: { inventario_id: id, empresa_id: escopo.empresaId },
  });
  if (itens.total > itens.rows.length) throw new HttpError(409, 'O inventário excede o limite seguro de leitura. Nenhum resumo parcial foi retornado.');
  validarItensInventarioUnicos(itens.rows);
  let contados = 0;
  let divergencias = 0;
  let totalSistema = 0;
  let totalContado = 0;
  for (const it of itens.rows) {
    await validarTamanhoNaGrade(
      Number(it.produto_id),
      it.tamanho_id === null || it.tamanho_id === undefined ? null : Number(it.tamanho_id),
      undefined,
      escopo
    );
    const saldo = Number(it.saldo_sistema || 0);
    const contado = it.contado === null || it.contado === undefined ? saldo : Number(it.contado);
    if (it.contado !== null && it.contado !== undefined) contados++;
    if (contado !== saldo) divergencias++;
    totalSistema += saldo;
    totalContado += contado;
  }
  res.json({
    ...inv,
    resumo: { itens: itens.rows.length, contados, divergencias, totalSistema, totalContado },
  });
}

// ----------------------------------------------------------------------------
// POST /api/movimentacoes/:id/estornar — estorna uma movimentação
// ----------------------------------------------------------------------------
export async function estornarMovimentacao(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') {
    throw new HttpError(403, 'Somente gerentes e administradores podem estornar movimentações.');
  }
  checkAccess(RESOURCES.movimentacoes, actor, 'create');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const s = getStore();

  try {
    const result = await s.transaction(async (tx) => {
      const mov = await s.findOneWhere(RESOURCES.movimentacoes, { id, empresa_id: escopo.empresaId }, tx);
      if (!mov) throw new HttpError(404, 'Movimentação não encontrada.');
      assertRegistroDaEmpresaParaEscrita(RESOURCES.movimentacoes, mov, escopo);
      await validarReferenciasDaEmpresa(RESOURCES.movimentacoes, mov, escopo, (alvo, alvoId, empresaId, t) => s.findOneWhere(alvo, { id: alvoId, empresa_id: empresaId }, t), tx);
      if (mov.compra_id !== null && mov.compra_id !== undefined && mov.compra_id !== '') {
        const compraId = Number(mov.compra_id);
        if (!Number.isInteger(compraId) || compraId <= 0 || !await s.findOneWhere(RESOURCES.compras, { id: compraId, empresa_id: escopo.empresaId }, tx)) {
          throw new HttpError(404, 'Compra não encontrada.');
        }
      }
      if (mov.estornado === true || mov.estornado === 1) throw new HttpError(409, 'Esta movimentação já foi estornada.');

      const tipo = String(mov.tipo);
      const quantidade = Number(mov.quantidade);
      if (!Number.isFinite(quantidade) || quantidade === 0 || (tipo !== 'ajuste' && quantidade < 0)) {
        throw new HttpError(409, 'A movimentação possui quantidade inválida; nenhum estorno foi aplicado.');
      }
      const produtoId = Number(mov.produto_id);
      const tamanhoRaw = mov.tamanho_id;
      const tamanhoId = tamanhoRaw === null || tamanhoRaw === undefined ? null : Number(tamanhoRaw);
      const produto = await s.findOneWhere(RESOURCES.produtos, { id: produtoId, empresa_id: escopo.empresaId }, tx);
      if (!produto) throw new HttpError(404, 'Produto não encontrado.');
      if (tamanhoId !== null && !await s.findOneWhere(RESOURCES.tamanhos, { id: tamanhoId }, tx)) throw new HttpError(404, 'Tamanho não encontrado.');
      await validarTamanhoNaGrade(produtoId, tamanhoId, tx, escopo);

      const resolverLocalDaMovimentacao = async (rawId: unknown, nomeRaw: unknown): Promise<{ id: number; nome: string }> => {
        const localId = rawId === null || rawId === undefined || rawId === '' ? null : Number(rawId);
        const nome = String(nomeRaw ?? '').trim();
        let local: Row | null = null;
        if (localId !== null) {
          if (!Number.isInteger(localId) || localId <= 0) throw new HttpError(404, 'Local não encontrado.');
          local = await s.findOneWhere(RESOURCES.locais, { id: localId, empresa_id: escopo.empresaId }, tx);
        } else if (nome) {
          const filtroLocal = { nome, empresa_id: escopo.empresaId };
          if (await s.countWhere(RESOURCES.locais, filtroLocal, tx) > 1) throw new HttpError(409, 'O local histórico não identifica um único local desta empresa. Nenhum estorno foi aplicado.');
          local = await s.findOneWhere(RESOURCES.locais, filtroLocal, tx);
        }
        if (!local) throw new HttpError(404, 'Local não encontrado.');
        return { id: Number(local.id), nome: String(local.nome) };
      };
      const origem = await resolverLocalDaMovimentacao(mov.local_id, mov.local);
      const destinoOriginal = tipo === 'transferencia'
        ? await resolverLocalDaMovimentacao(mov.local_destino_id, mov.local_destino)
        : null;
      const validarCelulaSaldo = async (local: { id: number; nome: string }) => {
        const filtro = { empresa_id: escopo.empresaId, produto_id: produtoId, tamanho_id: tamanhoId, local: local.nome };
        if (await s.countWhere(RESOURCES.estoques, filtro, tx) > 1) throw new HttpError(409, 'Há saldos duplicados para o produto/tamanho/local. Nenhum estorno foi aplicado.');
        const saldo = await s.findOneWhere(RESOURCES.estoques, filtro, tx);
        if (saldo && (saldo.local_id === null || saldo.local_id === undefined || Number(saldo.local_id) !== local.id)) {
          throw new HttpError(409, 'O saldo possui vínculo de local inconsistente ou ausente. Nenhum estorno foi aplicado.');
        }
      };
      await validarCelulaSaldo(origem);
      if (destinoOriginal) await validarCelulaSaldo(destinoOriginal);

      let tipoInverso: string;
      let quantidadeInversa: number;
      if (tipo === 'entrada') {
        tipoInverso = 'saida'; quantidadeInversa = quantidade;
      } else if (tipo === 'saida') {
        tipoInverso = 'entrada'; quantidadeInversa = quantidade;
      } else if (tipo === 'ajuste') {
        tipoInverso = 'ajuste'; quantidadeInversa = -quantidade;
      } else if (tipo === 'transferencia') {
        tipoInverso = 'transferencia'; quantidadeInversa = quantidade;
      } else {
        throw new HttpError(400, `Tipo de movimentação desconhecido: ${tipo}`);
      }

      const retirar = async (local: { id: number; nome: string }, retirada: number) => {
        const aplicado = await s.tryAdjustStock(produtoId, tamanhoId, local.nome, -retirada, tx, 0, local.id, escopo.empresaId);
        if (aplicado) return;
        const linha = await s.findOneWhere(RESOURCES.estoques, {
          empresa_id: escopo.empresaId,
          produto_id: produtoId,
          tamanho_id: tamanhoId,
          local: local.nome,
        }, tx);
        if (linha && (linha.local_id === null || linha.local_id === undefined || Number(linha.local_id) !== local.id)) throw new HttpError(409, 'O saldo possui vínculo de local inconsistente ou ausente.');
        const atual = Number(linha?.quantidade ?? 0);
        throw new HttpError(409, `O estorno retiraria ${retirada} peça(s) de "${local.nome}", mas só há ${atual} em estoque. Estorne primeiro as movimentações que consumiram essas peças.`, { quantidade: `Saldo atual: ${atual}` });
      };

      if (tipo === 'transferencia' && destinoOriginal) {
        await retirar(destinoOriginal, quantidade);
        await s.adjustStock(produtoId, tamanhoId, origem.nome, quantidade, tx, origem.id, escopo.empresaId);
      } else {
        const deltaOriginal = tipo === 'entrada' ? quantidade : tipo === 'saida' ? -quantidade : quantidade;
        const deltaInverso = -deltaOriginal;
        if (deltaInverso < 0) await retirar(origem, -deltaInverso);
        else await s.adjustStock(produtoId, tamanhoId, origem.nome, deltaInverso, tx, origem.id, escopo.empresaId);
      }

      const estornoData: Record<string, unknown> = {
        empresa_id: escopo.empresaId,
        tipo: tipoInverso,
        produto_id: produtoId,
        tamanho_id: tamanhoId,
        local: tipo === 'transferencia' && destinoOriginal ? destinoOriginal.nome : origem.nome,
        local_id: tipo === 'transferencia' && destinoOriginal ? destinoOriginal.id : origem.id,
        quantidade: quantidadeInversa,
        motivo: `Estorno da movimentação #${id}: ${mov.motivo || ''}`.trim(),
        usuario_id: actor.id || null,
      };
      if (tipo === 'transferencia' && destinoOriginal) {
        estornoData.local_destino = origem.nome;
        estornoData.local_destino_id = origem.id;
      }
      const movEstorno = await s.insert(RESOURCES.movimentacoes, estornoData, tx);
      await s.update(RESOURCES.movimentacoes, id, {
        estornado: true,
        estornado_em: new Date().toISOString(),
        estornado_por: actor.name,
        movimentacao_estorno_id: movEstorno.id,
      }, tx);
      await s.audit({
        usuario_id: actor.id || null,
        usuario: actor.name,
        acao: 'estornar',
        recurso: 'movimentacoes',
        registro_id: id,
        descricao: `Movimentação #${id} estornada (${tipo} de ${quantidade} peça(s))`,
        empresa_id: empresaDoRegistroAudit(RESOURCES.movimentacoes, mov, actor),
      }, tx);
      return {
        ok: true,
        movimentacao_original_id: id,
        movimentacao_estorno_id: movEstorno.id,
        tipo_inverso: tipoInverso,
        quantidade_inversa: quantidadeInversa,
      };
    });
    res.json(result);
  } catch (e) {
    throw toHttpError(e, RESOURCES.movimentacoes);
  }
}
