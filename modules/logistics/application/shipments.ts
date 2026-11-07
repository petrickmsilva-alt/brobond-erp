// ============================================================================
// MOTOR DE FRETE › APLICAÇÃO › REMESSAS, VOLUMES E ETIQUETAS
//
// Ciclo logístico completo sobre a tabela `envios` já existente (migration
// 0024, ampliada pela 0102):
//
//   PEDIDO → COTADO → PRONTO_EXPEDICAO → SEPARACAO → EMBALADA →
//   ETIQUETA_PENDENTE → ETIQUETA_GERADA → POSTADO → EM_TRANSITO → EM_ROTA →
//   ENTREGUE  (+ exceções: TENTATIVA_FALHA, DEVOLVIDO, EXTRAVIADO, CANCELADO)
//
// IDEMPOTÊNCIA em dois níveis:
//   • a criação de remessa usa `envios.idempotency_key` (índice único parcial);
//   • a geração de etiqueta usa `logistics_labels.idempotency_key`.
// Reenviar a requisição devolve o MESMO recurso — nunca duplica operação.
//
// "POSTADO" exige prova (código de rastreamento OU referência do provedor) —
// regra no banco (CHECK) e adiantada aqui para dar mensagem acionável.
// ============================================================================
import { getStore } from '../../../server/src/services';
import { getResource } from '../../../server/src/resources';
import { round2 } from '../../../server/src/utils';
import { podeAvancar, ehStatusLogistico, type StatusLogistico, type StoreKey, type VolumeFrete } from '../domain/contract';
import { validarVolumes } from '../domain/contract';
import { carrier, CARRIER_NULO, type CarrierAdapter } from '../providers/contract';
import { R_PACKAGES, R_LABELS } from '../infrastructure/resources';
import { auditarLogistica } from '../infrastructure/audit';
import { normalizarStatus } from '../domain/status';
import type { Row, Tx } from '../../../server/src/store';

const R_ENVIO = () => getResource('envios')!;
const R_EVENTO = () => getResource('envio_eventos')!;

export type ResultadoRemessa = {
  envio: Row;
  idempotente: boolean;
  /** quando o operador falhou: o envio fica PENDENTE com o motivo */
  pendente?: boolean;
};

async function registrarEvento(
  envioId: number,
  de: string | null,
  para: string,
  opts: { codigo?: string; mensagem?: string; local?: string | null; payload?: unknown; origem?: string; statusNormalizado?: string; dedupe?: string },
  empresaId: number,
  tx?: Tx
): Promise<void> {
  await getStore().insert(
    R_EVENTO(),
    {
      empresa_id: empresaId,
      envio_id: envioId,
      de_status: de,
      para_status: para,
      status_normalizado: opts.statusNormalizado ?? para,
      codigo: opts.codigo ?? null,
      origem: opts.origem ?? 'manual',
      dedupe_key: opts.dedupe ?? null,
      mensagem: opts.mensagem ?? null,
      local: opts.local ?? null,
      payload: opts.payload === undefined ? null : opts.payload,
    },
    tx
  );
}

/** Grava os volumes de uma remessa (idempotente por (envio, indice)). */
export async function gravarVolumes(empresaId: number, envioId: number, volumes: VolumeFrete[], tx?: Tx): Promise<void> {
  const s = getStore();
  const { volumes: validados } = validarVolumes(volumes);
  for (const [i, v] of validados.entries()) {
    const existente = await s.findOneWhere(R_PACKAGES(), { empresa_id: empresaId, envio_id: envioId, indice: i + 1 }, tx);
    const dados = {
      empresa_id: empresaId,
      envio_id: envioId,
      indice: i + 1,
      peso_g: v.peso_g,
      altura_cm: v.altura_cm,
      largura_cm: v.largura_cm,
      comprimento_cm: v.comprimento_cm,
    };
    if (existente) await s.update(R_PACKAGES(), Number(existente.id), dados, tx);
    else await s.insert(R_PACKAGES(), dados, tx);
  }
}

export type EntradaRemessa = {
  empresaId: number;
  vendaId: number;
  storeKey: StoreKey | null;
  quoteId: number | null;
  provider: string;
  servico: string | null;
  servicoNome: string | null;
  modalidade: string;
  volumes: VolumeFrete[];
  pesoTotalG: number;
  cepDestino: string;
  valorDeclarado: number;
  valorPedido: number;
  custoPrevisto: number;
  prazoDias: number | null;
  idempotencyKey: string;
  usuarioId: number | null;
  origemCep: string;
};

/**
 * Cria a remessa. Idempotente pela chave. Quando o operador falha, grava o
 * envio PENDENTE com o motivo (prova de que foi tentado e NÃO postado).
 */
export async function criarRemessa(entrada: EntradaRemessa, tx?: Tx): Promise<ResultadoRemessa> {
  const s = getStore();
  const existente = await s.findOneWhere(R_ENVIO(), { empresa_id: entrada.empresaId, idempotency_key: entrada.idempotencyKey }, tx);
  if (existente) return { envio: existente, idempotente: true };

  const adapter: CarrierAdapter = carrier(entrada.provider) ?? CARRIER_NULO;
  const temCapacidade = adapter.capacidades.remessa;

  // Sem capacidade de remessa no operador: registra PENDENTE com o motivo.
  if (!temCapacidade) {
    const envio = await s.insert(
      R_ENVIO(),
      {
        empresa_id: entrada.empresaId,
        venda_id: entrada.vendaId,
        provider: adapter.slug,
        servico: entrada.servico,
        servico_nome: entrada.servicoNome,
        store_key: entrada.storeKey,
        modalidade: entrada.modalidade,
        quote_id: entrada.quoteId,
        status: 'pendente',
        custo: 0,
        custo_previsto: round2(entrada.custoPrevisto),
        peso_g: Math.round(entrada.pesoTotalG),
        volumes: Math.max(1, entrada.volumes.length),
        cep_destino: entrada.cepDestino,
        prazo_dias: entrada.prazoDias,
        erro: `O operador ${adapter.nome} não gera remessa por API. Registre o código de rastreamento manualmente.`,
        idempotency_key: entrada.idempotencyKey,
        criado_por: entrada.usuarioId,
      },
      tx
    );
    await gravarVolumes(entrada.empresaId, Number(envio.id), entrada.volumes, tx);
    await registrarEvento(Number(envio.id), null, 'pendente', { mensagem: 'NÃO POSTADO — operador sem geração de remessa por API.', origem: 'sistema' }, entrada.empresaId, tx);
    return { envio, idempotente: false, pendente: true };
  }

  const resultado = await adapter.criarRemessa!({
    empresaId: entrada.empresaId,
    origem: { cep: entrada.origemCep },
    destino: { cep: entrada.cepDestino },
    volumes: entrada.volumes,
    pesoTotalG: entrada.pesoTotalG,
    valorDeclarado: entrada.valorDeclarado,
    servico: entrada.servico ?? undefined,
    referenciaPedido: String(entrada.vendaId),
  });

  if (!resultado.ok) {
    const envio = await s.insert(
      R_ENVIO(),
      {
        empresa_id: entrada.empresaId,
        venda_id: entrada.vendaId,
        provider: adapter.slug,
        servico: entrada.servico,
        servico_nome: entrada.servicoNome,
        store_key: entrada.storeKey,
        modalidade: entrada.modalidade,
        quote_id: entrada.quoteId,
        status: 'pendente',
        custo: 0,
        custo_previsto: round2(entrada.custoPrevisto),
        peso_g: Math.round(entrada.pesoTotalG),
        volumes: Math.max(1, entrada.volumes.length),
        cep_destino: entrada.cepDestino,
        prazo_dias: entrada.prazoDias,
        erro: resultado.mensagem,
        idempotency_key: entrada.idempotencyKey,
        criado_por: entrada.usuarioId,
      },
      tx
    );
    await gravarVolumes(entrada.empresaId, Number(envio.id), entrada.volumes, tx);
    await registrarEvento(Number(envio.id), null, 'pendente', { mensagem: `NÃO POSTADO — ${resultado.mensagem}`, origem: 'provedor' }, entrada.empresaId, tx);
    return { envio, idempotente: false, pendente: true };
  }

  const d = resultado.data;
  const prova = d.codigo_rastreamento || d.provider_ref;
  const status: StatusLogistico = prova ? 'postado' : 'etiqueta_gerada';
  const envio = await s.insert(
    R_ENVIO(),
    {
      empresa_id: entrada.empresaId,
      venda_id: entrada.vendaId,
      provider: adapter.slug,
      servico: d.servico || entrada.servico,
      servico_nome: entrada.servicoNome,
      store_key: entrada.storeKey,
      modalidade: entrada.modalidade,
      quote_id: entrada.quoteId,
      provider_ref: d.provider_ref,
      codigo_rastreamento: d.codigo_rastreamento,
      etiqueta_url: d.etiqueta_url,
      status,
      custo: round2(d.custo),
      custo_previsto: round2(entrada.custoPrevisto),
      custo_efetivo: round2(d.custo),
      peso_g: Math.round(entrada.pesoTotalG),
      volumes: Math.max(1, entrada.volumes.length),
      cep_destino: entrada.cepDestino,
      prazo_dias: entrada.prazoDias,
      idempotency_key: entrada.idempotencyKey,
      criado_por: entrada.usuarioId,
    },
    tx
  );
  await gravarVolumes(entrada.empresaId, Number(envio.id), entrada.volumes, tx);
  await registrarEvento(Number(envio.id), null, status, { codigo: d.codigo_rastreamento ?? undefined, mensagem: d.mensagem || 'Remessa criada no operador.', origem: 'provedor', payload: { provider_ref: d.provider_ref, custo: d.custo } }, entrada.empresaId, tx);
  await auditarLogistica(
    { empresaId: entrada.empresaId, storeKey: entrada.storeKey, entidade: 'envio', entidadeId: Number(envio.id), acao: 'remessa_criada', descricao: `Remessa criada via ${adapter.nome} para a venda #${entrada.vendaId}`, dados: { provider: adapter.slug, codigo: d.codigo_rastreamento, custo: d.custo }, usuarioId: entrada.usuarioId },
    tx
  );
  return { envio, idempotente: false };
}

/** Avança o status de um envio respeitando a ordem (não regride). */
export async function avancarStatusEnvio(
  empresaId: number,
  envioId: number,
  alvo: StatusLogistico,
  opts: { mensagem?: string; codigo?: string; origem?: string; usuarioId?: number | null } = {},
  tx?: Tx
): Promise<{ ok: boolean; status: string; motivo?: string }> {
  const s = getStore();
  const envio = await s.get(R_ENVIO(), envioId, tx);
  if (!envio || Number(envio.empresa_id) !== empresaId) return { ok: false, status: 'pendente', motivo: 'Envio não encontrado.' };
  const atual: StatusLogistico = ehStatusLogistico(envio.status) ? envio.status : 'pendente';
  if (!podeAvancar(atual, alvo)) {
    return { ok: false, status: atual, motivo: `Transição ${atual} → ${alvo} não é permitida (não regride).` };
  }
  const patch: Record<string, unknown> = { status: alvo };
  if (opts.codigo) patch.codigo_rastreamento = String(opts.codigo).slice(0, 60);
  // "postado" exige prova — mesma regra do CHECK do banco.
  if (['postado', 'em_transito', 'em_rota', 'entregue'].includes(alvo)) {
    const prova = (patch.codigo_rastreamento as string | undefined) ?? (envio.codigo_rastreamento as string | null) ?? (envio.provider_ref as string | null);
    if (!prova) return { ok: false, status: atual, motivo: `Não é possível marcar "${alvo}" sem código de rastreamento nem referência do provedor.` };
  }
  const atualizado = await s.tryUpdateIf(R_ENVIO(), envioId, { status: atual }, patch, tx);
  if (!atualizado) return { ok: false, status: atual, motivo: 'O envio mudou durante a atualização. Recarregue.' };
  await registrarEvento(envioId, atual, alvo, { mensagem: opts.mensagem, codigo: opts.codigo, origem: opts.origem ?? 'manual' }, empresaId, tx);
  return { ok: true, status: alvo };
}

export type ResultadoEtiqueta = {
  etiqueta: Row;
  idempotente: boolean;
  ok: boolean;
  motivo?: string;
};

/**
 * Gera a etiqueta de uma remessa. Idempotente por chave. Quando o operador não
 * oferece geração por API, grava o registro em PENDENTE com o procedimento
 * operacional — SEM fingir que a geração ocorreu.
 */
export async function gerarEtiqueta(
  empresaId: number,
  envioId: number,
  idempotencyKey: string,
  usuarioId: number | null,
  tx?: Tx
): Promise<ResultadoEtiqueta> {
  const s = getStore();
  const existente = await s.findOneWhere(R_LABELS(), { empresa_id: empresaId, idempotency_key: idempotencyKey }, tx);
  if (existente) return { etiqueta: existente, idempotente: true, ok: existente.estado === 'GERADA' };

  const envio = await s.get(R_ENVIO(), envioId, tx);
  if (!envio || Number(envio.empresa_id) !== empresaId) throw new Error('Envio não encontrado.');
  const adapter: CarrierAdapter = carrier(String(envio.provider)) ?? CARRIER_NULO;

  if (!adapter.capacidades.etiqueta || !adapter.gerarEtiqueta) {
    const etiqueta = await s.insert(
      R_LABELS(),
      {
        empresa_id: empresaId,
        envio_id: envioId,
        provider: adapter.slug,
        estado: 'PENDENTE',
        idempotency_key: idempotencyKey,
        erro: `O operador ${adapter.nome} não gera etiqueta por API. Procedimento operacional: gere no portal do operador e registre a URL/referência manualmente.`,
        criado_por: usuarioId,
      },
      tx
    );
    return { etiqueta, idempotente: false, ok: false, motivo: etiqueta.erro as string };
  }

  const providerRef = String(envio.provider_ref || '');
  if (!providerRef) {
    const etiqueta = await s.insert(
      R_LABELS(),
      { empresa_id: empresaId, envio_id: envioId, provider: adapter.slug, estado: 'ERRO', idempotency_key: idempotencyKey, erro: 'A remessa não tem referência no operador — não há etiqueta a gerar.', criado_por: usuarioId },
      tx
    );
    return { etiqueta, idempotente: false, ok: false, motivo: etiqueta.erro as string };
  }

  const r = await adapter.gerarEtiqueta(empresaId, providerRef);
  if (!r.ok) {
    const etiqueta = await s.insert(
      R_LABELS(),
      { empresa_id: empresaId, envio_id: envioId, provider: adapter.slug, provider_ref: providerRef, estado: 'ERRO', idempotency_key: idempotencyKey, erro: r.mensagem, criado_por: usuarioId },
      tx
    );
    return { etiqueta, idempotente: false, ok: false, motivo: r.mensagem };
  }
  const d = r.data;
  const etiqueta = await s.insert(
    R_LABELS(),
    {
      empresa_id: empresaId,
      envio_id: envioId,
      provider: adapter.slug,
      provider_ref: d.provider_ref ?? providerRef,
      url_externa: d.url_externa,
      mime: d.mime || 'application/pdf',
      tamanho_bytes: d.conteudo_base64 ? Math.floor((d.conteudo_base64.length * 3) / 4) : null,
      estado: 'GERADA',
      idempotency_key: idempotencyKey,
      gerada_em: new Date().toISOString(),
      criado_por: usuarioId,
    },
    tx
  );
  if (d.url_externa) await s.update(R_ENVIO(), envioId, { etiqueta_url: d.url_externa }, tx);
  const atual: StatusLogistico = ehStatusLogistico(envio.status) ? envio.status : 'pendente';
  if (podeAvancar(atual, 'etiqueta_gerada')) await s.update(R_ENVIO(), envioId, { status: 'etiqueta_gerada' }, tx);
  await auditarLogistica(
    { empresaId, entidade: 'etiqueta', entidadeId: Number(etiqueta.id), acao: 'etiqueta_gerada', descricao: `Etiqueta gerada para o envio #${envioId} via ${adapter.nome}`, dados: { provider_ref: d.provider_ref }, usuarioId },
    tx
  );
  return { etiqueta, idempotente: false, ok: true };
}

/** Converte um status bruto de operador no vocabulário do ERP (reexport). */
export { normalizarStatus };
