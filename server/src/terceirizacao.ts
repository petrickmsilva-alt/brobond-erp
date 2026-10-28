import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { currentUser } from './auth';
import { RESOURCES } from './resources';
import { checkAccess, escopoDe, getStore, lancarMovimentacaoInsumoDaOrdem, toHttpError } from './services';
import { parseId } from './validate';

const E = RESOURCES.terceirizacao_eventos!;
const rank: Record<string, number> = { operador: 1, gerente: 2, admin: 3 };

type CustodyInput = {
  terceiro_id?: unknown; evento?: unknown; tipo_material?: unknown; insumo_id?: unknown; produto_id?: unknown;
  proprietario_tipo?: unknown; proprietario_terceiro_id?: unknown;
  custodiante_anterior_tipo?: unknown; custodiante_anterior_terceiro_id?: unknown;
  custodiante_novo_tipo?: unknown; custodiante_novo_terceiro_id?: unknown;
  quantidade?: unknown; referencia_evento_id?: unknown; idempotency_key?: unknown; observacoes?: unknown;
};

const positiveId = (value: unknown, label: string): number => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, `${label} inválido.`);
  return id;
};

/** Feed rastreável por OP; cada linha guarda empresa, titularidade, custodiante, terceiro e material. */
export async function listarEventosTerceirizacao(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.ordens!, actor, 'read');
  const escopo = escopoDe(actor);
  const ordemId = parseId(req.params.id);
  const s = getStore();
  const ordem = await s.findOneWhere(RESOURCES.ordens!, { id: ordemId, empresa_id: escopo.empresaId });
  if (!ordem) throw new HttpError(404, 'Ordem de fabricação não encontrada.');
  const events = await s.list(E, { page: 1, pageSize: 1000, filter: { empresa_id: escopo.empresaId, ordem_id: ordemId }, sort: 'id', dir: 'asc' });
  if (events.total > events.rows.length) throw new HttpError(409, 'A trilha de custódia excede o limite seguro.');
  res.json(events.rows);
}

/** Registra custody events; apenas ENVIO/RETORNO de insumo de propriedade da empresa cria movimentação canônica. */
export async function registrarEventoTerceirizacao(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.ordens!, actor, 'update');
  if ((rank[actor.perfil || 'operador'] ?? 0) < rank.gerente) throw new HttpError(403, 'Somente gerentes e administradores podem registrar eventos de custódia com impacto operacional.');
  const escopo = escopoDe(actor);
  const ordemId = parseId(req.params.id);
  const input = (req.body || {}) as CustodyInput;
  const s = getStore();
  try {
    const result = await s.transaction(async (tx) => {
      const ordem = await s.findOneWhere(RESOURCES.ordens!, { id: ordemId, empresa_id: escopo.empresaId }, tx);
      if (!ordem) throw new HttpError(404, 'Ordem de fabricação não encontrada.');
      if (!['liberada', 'em_producao', 'parcial'].includes(String(ordem.status))) throw new HttpError(409, 'A custódia só pode ser movimentada em OP liberada, em produção ou parcial.');
      const terceiroId = positiveId(input.terceiro_id, 'Terceiro');
      const terceiro = await s.findOneWhere(RESOURCES.terceiros_operacionais!, { id: terceiroId, empresa_id: escopo.empresaId, ativo: true }, tx);
      if (!terceiro) throw new HttpError(404, 'Terceiro operacional não encontrado.');
      if (ordem.terceiro_id && Number(ordem.terceiro_id) !== terceiroId) throw new HttpError(409, 'A OP já está vinculada a outro terceiro.');
      if (!ordem.terceiro_id) await s.update(RESOURCES.ordens!, ordemId, { terceiro_id: terceiroId }, tx);

      const evento = String(input.evento || '');
      const tipoMaterial = String(input.tipo_material || '');
      if (!['ENVIO_INSUMO', 'RETORNO_INSUMO', 'RETORNO_PRODUTO', 'PERDA_PRODUTO', 'CUSTODIA'].includes(evento)) throw new HttpError(400, 'Evento de custódia não suportado.');
      if (!['insumo', 'produto'].includes(tipoMaterial)) throw new HttpError(400, 'Tipo de material inválido.');
      const insumoId = tipoMaterial === 'insumo' ? positiveId(input.insumo_id, 'Insumo') : null;
      const produtoId = tipoMaterial === 'produto' ? positiveId(input.produto_id, 'Produto') : null;
      const quantidade = Number(input.quantidade);
      if (!Number.isFinite(quantidade) || quantidade <= 0) throw new HttpError(400, 'A quantidade precisa ser maior que zero.');
      const chave = String(input.idempotency_key || '').trim();
      if (chave.length < 8 || chave.length > 120) throw new HttpError(400, 'Informe uma chave idempotente de 8 a 120 caracteres.');

      const ownerType = String(input.proprietario_tipo || '');
      const ownerThird = input.proprietario_terceiro_id == null || input.proprietario_terceiro_id === '' ? null : positiveId(input.proprietario_terceiro_id, 'Terceiro proprietário');
      const fromType = String(input.custodiante_anterior_tipo || '');
      const fromThird = input.custodiante_anterior_terceiro_id == null || input.custodiante_anterior_terceiro_id === '' ? null : positiveId(input.custodiante_anterior_terceiro_id, 'Custodiante anterior');
      const toType = String(input.custodiante_novo_tipo || '');
      const toThird = input.custodiante_novo_terceiro_id == null || input.custodiante_novo_terceiro_id === '' ? null : positiveId(input.custodiante_novo_terceiro_id, 'Novo custodiante');
      if (!['empresa', 'terceiro'].includes(ownerType) || !['empresa', 'terceiro'].includes(fromType) || !['empresa', 'terceiro'].includes(toType)) throw new HttpError(400, 'Informe proprietário, custodiante anterior e novo custodiante.');
      if ((ownerType === 'terceiro') !== (ownerThird !== null) || (fromType === 'terceiro') !== (fromThird !== null) || (toType === 'terceiro') !== (toThird !== null)) throw new HttpError(400, 'Os IDs de terceiro devem corresponder ao tipo de proprietário/custodiante.');
      const referencedThirds = [ownerThird, fromThird, toThird].filter((value): value is number => value !== null);
      for (const id of new Set(referencedThirds)) if (!await s.findOneWhere(RESOURCES.terceiros_operacionais!, { id, empresa_id: escopo.empresaId }, tx)) throw new HttpError(404, 'Terceiro de propriedade/custódia não encontrado.');

      const referenceId = input.referencia_evento_id == null || input.referencia_evento_id === '' ? null : positiveId(input.referencia_evento_id, 'Evento de referência');
      const item = tipoMaterial === 'insumo'
        ? await s.findOneWhere(RESOURCES.insumos!, { id: insumoId, empresa_id: escopo.empresaId }, tx)
        : await s.findOneWhere(RESOURCES.produtos!, { id: produtoId, empresa_id: escopo.empresaId }, tx);
      if (!item) throw new HttpError(404, tipoMaterial === 'insumo' ? 'Insumo não encontrado.' : 'Produto não encontrado.');
      const unidade = String(item.unidade || 'un');

      const fingerprint = { ordem_id: ordemId, terceiro_id: terceiroId, evento, tipo_material: tipoMaterial, insumo_id: insumoId, produto_id: produtoId, proprietario_tipo: ownerType, proprietario_terceiro_id: ownerThird, custodiante_anterior_tipo: fromType, custodiante_anterior_terceiro_id: fromThird, custodiante_novo_tipo: toType, custodiante_novo_terceiro_id: toThird, quantidade, referencia_evento_id: referenceId };
      const existente = await s.findOneWhere(E, { empresa_id: escopo.empresaId, idempotency_key: chave }, tx);
      if (existente) {
        const same = Object.entries(fingerprint).every(([key, value]) => String((existente as any)[key] ?? '') === String(value ?? ''));
        if (!same) throw new HttpError(409, 'A chave idempotente já foi usada com outro evento ou conteúdo.');
        return { ...existente, idempotente: true };
      }

      let referencia: Record<string, any> | null = null;
      let movement: Record<string, any> | null = null;
      if (evento === 'ENVIO_INSUMO') {
        if (tipoMaterial !== 'insumo' || ownerType !== 'empresa' || fromType !== 'empresa' || toType !== 'terceiro' || toThird !== terceiroId || referenceId !== null) throw new HttpError(400, 'Envio de insumo da empresa exige custódia empresa → terceiro e não aceita referência a outro evento.');
        movement = await lancarMovimentacaoInsumoDaOrdem({ tipo: 'saida', insumo_id: insumoId, quantidade, custo_unitario: Number(item.custo_medio || 0), motivo: `Envio à facção ${terceiro.nome} — OP #${ordemId}`, ordem_id: ordemId }, actor, tx, escopo);
      } else if (evento === 'RETORNO_INSUMO') {
        if (tipoMaterial !== 'insumo' || ownerType !== 'empresa' || fromType !== 'terceiro' || fromThird !== terceiroId || toType !== 'empresa' || referenceId === null) throw new HttpError(400, 'Retorno de insumo da empresa exige custódia terceiro → empresa e referência ao envio.');
        referencia = await s.findOneWhere(E, { id: referenceId, empresa_id: escopo.empresaId, ordem_id: ordemId, terceiro_id: terceiroId, evento: 'ENVIO_INSUMO', tipo_material: 'insumo', insumo_id: insumoId }, tx);
        if (!referencia) throw new HttpError(404, 'Envio de insumo de referência não encontrado para esta OP, terceiro e material.');
        const anteriores = await s.list(E, { page: 1, pageSize: 1000, filter: { empresa_id: escopo.empresaId, referencia_evento_id: referenceId, evento: 'RETORNO_INSUMO' } }, tx);
        if (anteriores.total > anteriores.rows.length) throw new HttpError(409, 'Histórico de retornos excede o limite seguro.');
        const retornado = anteriores.rows.reduce((sum, row) => sum + Number(row.quantidade), 0);
        if (retornado + quantidade > Number(referencia.quantidade)) throw new HttpError(409, 'O retorno excede a quantidade enviada ainda em custódia do terceiro.');
        movement = await lancarMovimentacaoInsumoDaOrdem({ tipo: 'entrada', insumo_id: insumoId, quantidade, custo_unitario: Number(referencia.movimentacao_insumo_id ? (await s.findOneWhere(RESOURCES.movimentacoes_insumos!, { id: Number(referencia.movimentacao_insumo_id), empresa_id: escopo.empresaId }, tx))?.custo_unitario : 0) || 0, motivo: `Retorno da facção ${terceiro.nome} — OP #${ordemId}`, ordem_id: ordemId }, actor, tx, escopo);
      } else if (evento === 'RETORNO_PRODUTO' || evento === 'PERDA_PRODUTO') {
        if (tipoMaterial !== 'produto' || produtoId !== Number(ordem.produto_id) || ownerType !== 'empresa' || fromType !== 'terceiro' || fromThird !== terceiroId || toType !== 'empresa' || referenceId !== null) throw new HttpError(400, 'Retorno/perda de produto exige o produto da OP, proprietário empresa e custódia terceiro → empresa.');
      } else {
        if (ownerType !== 'terceiro' || ownerThird !== terceiroId || referenceId !== null) throw new HttpError(400, 'Evento de custódia sem movimento de estoque é permitido apenas para material de propriedade do terceiro.');
      }

      const row = await s.insert(E, {
        empresa_id: escopo.empresaId, ordem_id: ordemId, terceiro_id: terceiroId, evento, tipo_material: tipoMaterial,
        insumo_id: insumoId, produto_id: produtoId, proprietario_tipo: ownerType, proprietario_terceiro_id: ownerThird,
        custodiante_anterior_tipo: fromType, custodiante_anterior_terceiro_id: fromThird,
        custodiante_novo_tipo: toType, custodiante_novo_terceiro_id: toThird, quantidade, unidade,
        referencia_evento_id: referenceId, movimentacao_insumo_id: movement?.id ?? null, idempotency_key: chave,
        observacoes: String(input.observacoes || '').trim().slice(0, 1000) || null, usuario_id: actor.id || null,
      }, tx);
      await s.audit({ usuario_id: actor.id || null, usuario: actor.name, acao: 'criar', recurso: 'terceirizacao_eventos', registro_id: Number(row.id), descricao: `${evento} — ${quantidade} ${unidade} — OP #${ordemId} / ${terceiro.nome}${movement ? `; movimentação de insumo #${movement.id}` : '; sem impacto de saldo'}`, dados: { ...fingerprint, movimentacao_insumo_id: movement?.id ?? null, proprietario: ownerType === 'empresa' ? `empresa ${escopo.empresaId}` : `terceiro ${ownerThird}`, custodiante_de: fromType === 'empresa' ? `empresa ${escopo.empresaId}` : `terceiro ${fromThird}`, custodiante_para: toType === 'empresa' ? `empresa ${escopo.empresaId}` : `terceiro ${toThird}` }, empresa_id: escopo.empresaId }, tx);
      return row;
    });
    res.status(result.idempotente ? 200 : 201).json(result);
  } catch (error) { throw toHttpError(error, E); }
}
