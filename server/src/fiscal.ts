// ============================================================================
// EMISSÃO FISCAL — orquestração NF-e (55) / NFC-e (65).
//
// Este arquivo é o único lugar que escreve em `documentos_fiscais`. Ele junta
// três peças que já existem e NÃO são reimplementadas aqui:
//   • `fiscalRegras.ts`  → qual tributação vai no item;
//   • `fiscalProvider.ts`→ quem fala com a SEFAZ (Focus/PlugNotas/nenhum);
//   • `itens.ts`         → baixa de estoque e comissão do faturamento;
//     `financeiro.ts`    → contas a receber. Nenhum motor novo foi criado.
//
// A MÁQUINA DE ESTADOS, na prática:
//
//   rascunho/pendente ──reserva numeração──► processando
//        ▲                                      │
//        │                            provedor respondeu
//        │                     ┌────────────────┼────────────────┐
//        │                 autorizado        rejeitado          erro
//        │                     │              (número           (número
//        └─────── correção ────┴── devolvido)  devolvido) ───────┘
//
// Três garantias que o código mantém de pé:
//
//   1. NENHUMA NOTA FANTASMA. `autorizado` só é escrito com chave + protocolo
//      vindos do provedor. Sem provedor configurado a resposta é 409 com
//      `emitido: false` e o documento fica em `pendente` com o motivo — e o
//      CHECK do banco (migration 0020) recusaria a gravação de qualquer jeito.
//   2. EFEITOS SÓ NA AUTORIZAÇÃO. Estoque e financeiro são tocados uma única
//      vez, carimbados em `estoque_baixado_em` / `financeiro_lancado_em`.
//      Rejeição não baixa estoque.
//   3. IDEMPOTÊNCIA. `idempotency_key` é única por empresa: reenviar a mesma
//      requisição devolve o MESMO documento, nunca um segundo.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore, escopoDe } from './services';
import { currentUser, type AuthUser } from './auth';
import { parseId } from './validate';
import { labelOf, type Row, type Tx } from './store';
import { assertRegistroDaEmpresa, escopoDoAtor, type EscopoEmpresa, empresaDoAtorAudit, empresaDoRegistroAudit } from './empresa';
import { aplicarRegrasPedido } from './itens';
import { syncLancamentoVenda } from './financeiro';
import { cifrarSegredo, decifrarSegredo, mascararSegredo, pareceCifrado, chaveFraca } from './segredos';
import {
  carregarRegras,
  impostoCentavos,
  pendenciasFiscais,
  resolverTributacao,
  type ContextoFiscal,
} from './fiscalRegras';
import {
  credenciaisDaEmpresa,
  obterFiscalProvider,
  provedoresDisponiveis,
  type DocumentoFiscalPayload,
  type ItemFiscal,
  type RespostaFiscal,
} from './fiscalProvider';
import { tipoDocumento } from './documentos';

const R_DOC = () => getResource('documentos_fiscais')!;
const R_EVT = () => getResource('documentos_fiscais_eventos')!;
const R_CFG = () => getResource('empresa_fiscal_config')!;
const R_VENDA = () => getResource('vendas')!;
const R_INUT = () => getResource('inutilizacoes_fiscais')!;

const reais = (cents: number) => Math.round(cents) / 100;

/**
 * `criado_por` só é gravado quando o usuário existe de fato.
 * No modo demonstração (memdb, sem DATABASE_URL) o ator do request pode não
 * ter linha em `usuarios`, e a FK derrubaria a emissão por um campo que é
 * apenas informativo.
 */
async function autorValido(actorId: number | null, tx?: Tx): Promise<number | null> {
  if (!actorId) return null;
  const u = await getStore().findOneWhere(getResource('usuarios')!, { id: actorId }, tx);
  return u ? actorId : null;
}
const cents = (valor: unknown) => Math.round(Number(valor || 0) * 100);

// ----------------------------------------------------------------------------
// Configuração fiscal da empresa
// ----------------------------------------------------------------------------

/** Configuração da empresa; cria a linha desabilitada se ainda não existir. */
export async function obterConfigFiscalDaEmpresa(empresaId: number, tx?: Tx): Promise<Row> {
  return configDaEmpresa(empresaId, tx);
}

async function configDaEmpresa(empresaId: number, tx?: Tx): Promise<Row> {
  const s = getStore();
  const atual = await s.findOneWhere(R_CFG(), { empresa_id: empresaId }, tx);
  if (atual) return atual;
  return s.insert(R_CFG(), { empresa_id: empresaId, provider: 'nenhum', ambiente: 'homologacao', habilitado: false }, tx);
}

async function empresaAtiva(empresaId: number, tx?: Tx): Promise<Row> {
  const empresa = await getStore().findOneWhere(getResource('empresas')!, { id: empresaId }, tx);
  if (!empresa) throw new HttpError(409, 'Empresa ativa não encontrada. Selecione uma empresa válida antes de emitir.');
  return empresa;
}

function endereco(row: Row) {
  return {
    cep: (row.cep as string) || null,
    logradouro: (row.logradouro as string) || null,
    numero: (row.numero as string) || null,
    complemento: (row.complemento as string) || null,
    bairro: (row.bairro as string) || null,
    cidade: (row.cidade as string) || null,
    codigo_municipio: (row.codigo_municipio as string) || null,
    uf: row.uf ? String(row.uf).toUpperCase() : null,
    pais: String(row.pais || 'Brasil'),
  };
}

// ----------------------------------------------------------------------------
// Montagem do documento a partir da venda
// ----------------------------------------------------------------------------

export type MontagemFiscal = {
  payload: DocumentoFiscalPayload;
  pendencias: string[];
  venda: Row;
  config: Row;
  empresa: Row;
};

/**
 * Traduz uma venda do ERP no payload canônico de documento fiscal.
 *
 * Não inventa dado nenhum: o que falta volta em `pendencias`, e quem chama
 * decide se bloqueia (emissão) ou apenas mostra (pré-visualização).
 */
export async function montarDocumentoDaVenda(
  vendaId: number,
  modelo: '55' | '65',
  empresaId: number,
  numeracao: { serie: number; numero: number } | null,
  referencia: string,
  tx?: Tx
): Promise<MontagemFiscal> {
  const s = getStore();
  const venda = await s.get(R_VENDA(), vendaId, tx);
  if (!venda) throw new HttpError(404, 'Pedido não encontrado.');

  const [empresa, config] = await Promise.all([empresaAtiva(empresaId, tx), configDaEmpresa(empresaId, tx)]);
  const pendencias: string[] = [];

  // --- Emitente -------------------------------------------------------------
  const cnpjEmitente = String(empresa.cnpj || '').replace(/\D/g, '');
  if (!cnpjEmitente) pendencias.push('CNPJ da empresa emitente');
  if (!empresa.ie) pendencias.push('Inscrição estadual da empresa emitente');
  if (!empresa.uf) pendencias.push('UF da empresa emitente');
  if (!empresa.codigo_municipio) pendencias.push('Código IBGE do município da empresa emitente');

  // --- Destinatário ---------------------------------------------------------
  const cliente = venda.cliente_id
    ? await s.findOneWhere(getResource('clientes')!, { id: Number(venda.cliente_id) }, tx)
    : null;
  // NFC-e aceita venda sem identificação do consumidor; NF-e não.
  if (!cliente && modelo === '55') throw new HttpError(400, 'Informe o cliente do pedido antes de emitir a NF-e.');

  const docCliente = String(cliente?.cnpj_cpf || '').replace(/\D/g, '');
  const tipoDoc = tipoDocumento(docCliente);
  if (modelo === '55') {
    if (!docCliente) pendencias.push('CPF/CNPJ do cliente');
    else if (!tipoDoc) pendencias.push('CPF/CNPJ do cliente é inválido');
    if (!cliente?.uf) pendencias.push('UF do cliente');
    if (!cliente?.codigo_municipio) pendencias.push('Código IBGE do município do cliente');
    if (!cliente?.logradouro) pendencias.push('Endereço (logradouro) do cliente');
    if (String(cliente?.indicador_ie || '9') === '1' && !cliente?.rg_ie) {
      pendencias.push('Inscrição estadual do cliente (ele está marcado como contribuinte de ICMS)');
    }
  }

  // --- Itens ----------------------------------------------------------------
  const itens = await s.list(getResource('itens_venda')!, { page: 1, pageSize: 1000, filter: { venda_id: vendaId } }, tx);
  if (!itens.rows.length) throw new HttpError(409, 'O pedido não tem itens.');

  const ufDestino = modelo === '65' ? String(empresa.uf || '') : String(cliente?.uf || '');
  const ctx: ContextoFiscal = {
    empresaId,
    modelo,
    operacao: 'saida',
    ufDestino: ufDestino || null,
    ufEmitente: empresa.uf ? String(empresa.uf) : null,
    // NFC-e é sempre consumidor final; na NF-e, quem não é contribuinte também é.
    consumidorFinal: modelo === '65' || String(cliente?.indicador_ie || '9') !== '1',
    regime: empresa.crt ? String(empresa.crt) : null,
  };
  const regras = await carregarRegras(empresaId, tx);
  const padrao = {
    cfop_dentro: String(config.cfop_padrao_dentro_uf || '5102'),
    cfop_fora: String(config.cfop_padrao_fora_uf || '6102'),
  };

  const itensFiscais: ItemFiscal[] = [];
  let totalProdutos = 0;
  let totalIcms = 0;
  let totalPis = 0;
  let totalCofins = 0;
  let totalIpi = 0;

  for (const [idx, it] of itens.rows.entries()) {
    const produto = await s.findOneWhere(getResource('produtos')!, { id: Number(it.produto_id) }, tx);
    if (!produto) throw new HttpError(409, `Produto #${it.produto_id} do pedido não existe mais.`);
    const tam = it.tamanho_id ? await s.findOneWhere(getResource('tamanhos')!, { id: Number(it.tamanho_id) }, tx) : null;

    const trib = resolverTributacao(produto, ctx, regras, padrao);
    const faltas = pendenciasFiscais(trib, ctx);
    const nomeProduto = labelOf(getResource('produtos')!, produto);
    for (const f of faltas) pendencias.push(`${f} — item ${idx + 1} (${nomeProduto})`);

    const totalItemCents = cents(it.subtotal ?? Number(it.quantidade) * Number(it.preco_unitario));
    const descontoItemCents = cents(it.desconto);
    const baseCents = Math.max(0, totalItemCents - descontoItemCents);
    const baseIcmsCents = trib.icms_reducao_pct
      ? Math.round(baseCents * (1 - trib.icms_reducao_pct / 100))
      : baseCents;

    const icms = impostoCentavos(baseIcmsCents, trib.icms_aliquota);
    const pis = impostoCentavos(baseCents, trib.pis_aliquota);
    const cofins = impostoCentavos(baseCents, trib.cofins_aliquota);
    const ipi = impostoCentavos(baseCents, trib.ipi_aliquota);

    itensFiscais.push({
      numero: idx + 1,
      codigo: String(produto.sku || produto.id),
      descricao: `${nomeProduto}${tam?.codigo ? ` ${tam.codigo}` : ''}`.trim(),
      gtin: (produto.codigo_barras as string) || null,
      gtin_tributario: (produto.gtin_tributario as string) || (produto.codigo_barras as string) || null,
      ncm: trib.ncm,
      cest: trib.cest,
      cfop: trib.cfop,
      origem: trib.origem,
      unidade: String(produto.unidade || 'UN').toUpperCase(),
      quantidade: Number(it.quantidade),
      valor_unitario_cents: cents(it.preco_unitario),
      valor_total_cents: totalItemCents,
      desconto_cents: descontoItemCents,
      icms_cst: trib.icms_cst,
      csosn: trib.csosn,
      icms_aliquota: trib.icms_aliquota,
      icms_valor_cents: icms,
      pis_cst: trib.pis_cst,
      pis_aliquota: trib.pis_aliquota,
      pis_valor_cents: pis,
      cofins_cst: trib.cofins_cst,
      cofins_aliquota: trib.cofins_aliquota,
      cofins_valor_cents: cofins,
      ipi_cst: trib.ipi_cst,
      ipi_aliquota: trib.ipi_aliquota,
      ipi_valor_cents: ipi,
    });

    totalProdutos += totalItemCents;
    totalIcms += icms;
    totalPis += pis;
    totalCofins += cofins;
    totalIpi += ipi;
  }

  const freteCents = cents(venda.frete);
  const descontoCents = cents(venda.desconto);
  const totalCents = Math.max(0, totalProdutos + freteCents - descontoCents);

  const payload: DocumentoFiscalPayload = {
    modelo,
    serie: numeracao?.serie ?? Number((modelo === '65' ? config.serie_nfce : config.serie_nfe) || 1),
    numero: numeracao?.numero ?? 0,
    natureza_operacao: String(config.natureza_operacao_padrao || 'Venda de mercadoria'),
    ambiente: String(config.ambiente) === 'producao' ? 'producao' : 'homologacao',
    consumidor_final: ctx.consumidorFinal,
    emitente: {
      cnpj: cnpjEmitente,
      ie: (empresa.ie as string) || null,
      razao_social: String(empresa.razao_social || empresa.nome || ''),
      nome_fantasia: (empresa.nome_fantasia as string) || (empresa.nome as string) || null,
      crt: (empresa.crt as string) || null,
      endereco: endereco(empresa),
    },
    destinatario: {
      documento: docCliente,
      tipo: tipoDoc,
      nome: String(cliente?.razao_social || cliente?.nome || 'CONSUMIDOR'),
      ie: (cliente?.rg_ie as string) || null,
      indicador_ie: (String(cliente?.indicador_ie || '9') as '1' | '2' | '9'),
      email: (cliente?.email as string) || null,
      telefone: (cliente?.telefone as string) || null,
      endereco: cliente ? endereco(cliente) : endereco({}),
    },
    itens: itensFiscais,
    frete_cents: freteCents,
    desconto_cents: descontoCents,
    total_produtos_cents: totalProdutos,
    total_cents: totalCents,
    total_icms_cents: totalIcms,
    total_pis_cents: totalPis,
    total_cofins_cents: totalCofins,
    total_ipi_cents: totalIpi,
    informacoes_complementares: `Pedido nº ${vendaId}${venda.observacoes ? `. ${venda.observacoes}` : ''}`,
    referencia,
  };

  return { payload, pendencias, venda, config, empresa };
}

// ----------------------------------------------------------------------------
// Eventos e transições
// ----------------------------------------------------------------------------

async function registrarEvento(
  doc: Row,
  para: string,
  evento: string,
  mensagem: string,
  payload: unknown,
  actor: { id: number | null },
  tx: Tx
): Promise<void> {
  await getStore().insert(
    R_EVT(),
    {
      documento_id: Number(doc.id),
      empresa_id: Number(doc.empresa_id),
      de_status: doc.status ?? null,
      para_status: para,
      evento,
      mensagem: mensagem.slice(0, 2000),
      payload: payload ? JSON.stringify(payload).slice(0, 20000) : null,
      usuario_id: await autorValido(actor.id, tx),
    },
    tx
  );
}

/**
 * Reserva o próximo número da série por compare-and-swap.
 *
 * O CAS é o que impede duas emissões simultâneas de pegarem o mesmo número —
 * quem perde a corrida tenta de novo com o valor relido.
 */
async function reservarNumeracao(
  config: Row,
  modelo: '55' | '65',
  tx: Tx
): Promise<{ serie: number; numero: number }> {
  const s = getStore();
  const campoNumero = modelo === '65' ? 'proximo_numero_nfce' : 'proximo_numero_nfe';
  const campoSerie = modelo === '65' ? 'serie_nfce' : 'serie_nfe';

  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const atual = await s.findOneWhere(R_CFG(), { empresa_id: Number(config.empresa_id) }, tx);
    if (!atual) throw new HttpError(409, 'Configuração fiscal da empresa não encontrada.');
    const numero = Number(atual[campoNumero] || 1);
    const ok = await s.tryUpdateIf(
      R_CFG(),
      Number(atual.id),
      { [campoNumero]: numero },
      { [campoNumero]: numero + 1 },
      tx
    );
    if (ok) return { serie: Number(atual[campoSerie] || 1), numero };
  }
  throw new HttpError(
    409,
    'Não foi possível reservar a numeração fiscal (muitas emissões simultâneas). Tente novamente em instantes.'
  );
}

/** Devolve o número à série quando o documento não chegou a existir na SEFAZ. */
async function devolverNumeracao(config: Row, modelo: '55' | '65', numero: number, tx: Tx): Promise<void> {
  const s = getStore();
  const campoNumero = modelo === '65' ? 'proximo_numero_nfce' : 'proximo_numero_nfe';
  const atual = await s.findOneWhere(R_CFG(), { empresa_id: Number(config.empresa_id) }, tx);
  // Só devolve se ninguém mais consumiu a série depois: o último número é o nosso.
  if (atual && Number(atual[campoNumero]) === numero + 1) {
    await s.tryUpdateIf(R_CFG(), Number(atual.id), { [campoNumero]: numero + 1 }, { [campoNumero]: numero }, tx);
  }
}

// ----------------------------------------------------------------------------
// POST /api/vendas/:id/fiscal/emitir
// ----------------------------------------------------------------------------

export async function emitirDocumento(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_VENDA(), actor, 'update');
  const vendaId = parseId(req.params.id);
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const empresaId = escopo.empresaId;
  const s = getStore();

  const body = (req.body || {}) as Record<string, unknown>;
  const modelo: '55' | '65' = String(body.modelo || '55') === '65' ? '65' : '55';
  const idempotencyKey =
    String(body.idempotency_key || req.header('idempotency-key') || `venda:${vendaId}:${modelo}`).slice(0, 120);

  // ---- 1) Documento: reaproveita o da mesma chave, nunca cria um segundo ----
  const existente = await s.findOneWhere(R_DOC(), { empresa_id: empresaId, idempotency_key: idempotencyKey });
  if (existente) {
    assertRegistroDaEmpresa(R_DOC(), existente, escopo);
    const st = String(existente.status);
    if (st === 'autorizado' || st === 'processando' || st === 'cancelado') {
      // Repetição da mesma requisição: devolve o MESMO documento.
      return res.json(await respostaDocumento(existente, st === 'autorizado'));
    }
  }

  const venda = await s.get(R_VENDA(), vendaId);
  if (!venda) throw new HttpError(404, 'Pedido não encontrado.');
  assertRegistroDaEmpresa(R_VENDA(), venda, escopo);
  if (String(venda.status) === 'cancelada') throw new HttpError(409, 'Pedido cancelado não emite documento fiscal.');

  // Outro documento vivo do mesmo modelo para esta venda? Não duplica nota.
  const vivo = await s.list(R_DOC(), { page: 1, pageSize: 5, filter: { venda_id: vendaId, modelo, status: 'autorizado' } });
  if (vivo.rows.length) {
    throw new HttpError(
      409,
      `Este pedido já tem ${modelo === '65' ? 'NFC-e' : 'NF-e'} autorizada (nº ${vivo.rows[0].numero}, chave ${vivo.rows[0].chave_acesso}).`
    );
  }

  // ---- 2) Monta e valida ANTES de qualquer reserva de numeração ------------
  const montagemPrevia = await montarDocumentoDaVenda(vendaId, modelo, empresaId, null, idempotencyKey);
  const { config, empresa } = montagemPrevia;
  const provider = obterFiscalProvider(config.provider as string);
  const credenciais = credenciaisDaEmpresa(config, empresa.cnpj);

  // Documento sempre existe no banco: o usuário precisa VER a pendência.
  const doc =
    existente ??
    (await s.insert(R_DOC(), {
      empresa_id: empresaId,
      venda_id: vendaId,
      modelo,
      operacao: 'saida',
      natureza_operacao: montagemPrevia.payload.natureza_operacao,
      status: 'rascunho',
      provider: String(config.provider || 'nenhum'),
      ambiente: montagemPrevia.payload.ambiente,
      idempotency_key: idempotencyKey,
      criado_por: await autorValido(actor.id),
    }));

  if (montagemPrevia.pendencias.length) {
    const motivo = `Documento NÃO emitido — faltam dados obrigatórios: ${montagemPrevia.pendencias.join('; ')}.`;
    await s.transaction(async (tx) => {
      await registrarEvento(doc, 'pendente', 'validacao', motivo, { pendencias: montagemPrevia.pendencias }, actor, tx);
      await s.update(R_DOC(), Number(doc.id), { status: 'pendente', motivo }, tx);
    });
    throw new HttpError(422, motivo);
  }

  if (!config.habilitado || !provider.configurado(credenciais)) {
    const motivo =
      'Documento NÃO emitido: a emissão fiscal desta empresa não está habilitada/configurada ' +
      `(provedor "${config.provider || 'nenhum'}"). Nenhuma nota foi transmitida à SEFAZ, nenhum estoque foi baixado ` +
      'e nenhum número fiscal foi gerado. Configure o provedor em Configurações Fiscais.';
    await s.transaction(async (tx) => {
      await registrarEvento(doc, 'pendente', 'erro', motivo, null, actor, tx);
      await s.update(R_DOC(), Number(doc.id), { status: 'pendente', motivo }, tx);
    });
    throw new HttpError(409, motivo);
  }

  // ---- 3) Reserva numeração e marca "processando" --------------------------
  const numeracao = await s.transaction(async (tx) => {
    const n = await reservarNumeracao(config, modelo, tx);
    await registrarEvento(doc, 'processando', 'emitir', `Enviando ${modelo === '65' ? 'NFC-e' : 'NF-e'} nº ${n.numero} série ${n.serie} ao provedor ${provider.nome}.`, null, actor, tx);
    await s.update(
      R_DOC(),
      Number(doc.id),
      {
        status: 'processando',
        serie: n.serie,
        numero: n.numero,
        provider: provider.nome,
        ambiente: montagemPrevia.payload.ambiente,
        motivo: null,
        tentativas: Number(doc.tentativas || 0) + 1,
        valor_produtos: reais(montagemPrevia.payload.total_produtos_cents),
        valor_frete: reais(montagemPrevia.payload.frete_cents),
        valor_desconto: reais(montagemPrevia.payload.desconto_cents),
        valor_total: reais(montagemPrevia.payload.total_cents),
        valor_icms: reais(montagemPrevia.payload.total_icms_cents),
        valor_pis: reais(montagemPrevia.payload.total_pis_cents),
        valor_cofins: reais(montagemPrevia.payload.total_cofins_cents),
        valor_ipi: reais(montagemPrevia.payload.total_ipi_cents),
      },
      tx
    );
    return n;
  });

  // ---- 4) Chamada ao provedor — FORA da transação (é rede) -----------------
  const payload = { ...montagemPrevia.payload, serie: numeracao.serie, numero: numeracao.numero };
  let resposta: RespostaFiscal;
  try {
    resposta = await provider.emitir(payload, credenciais);
  } catch (e: any) {
    resposta = { status: 'erro', mensagem: `Falha de comunicação com ${provider.nome}: ${e?.message || e}` };
  }

  const atualizado = await aplicarResposta(Number(doc.id), resposta, actor, { config, modelo, numero: numeracao.numero });
  const autorizado = String(atualizado.status) === 'autorizado';
  res.status(autorizado ? 200 : 202).json(await respostaDocumento(atualizado, autorizado));
}

/**
 * Grava a resposta do provedor e, SOMENTE na autorização, dispara os efeitos.
 *
 * Toda a escrita acontece numa transação: ou a nota fica autorizada com
 * estoque baixado e financeiro lançado, ou nada disso aconteceu.
 */
async function aplicarResposta(
  docId: number,
  resposta: RespostaFiscal,
  actor: { id: number | null; name: string },
  ctx: { config: Row; modelo: '55' | '65'; numero: number | null }
): Promise<Row> {
  const s = getStore();
  const gravado = await s.transaction(async (tx) => {
    const doc = await s.get(R_DOC(), docId, tx);
    if (!doc) throw new HttpError(404, 'Documento fiscal não encontrado.');
    const agora = new Date().toISOString();

    if (resposta.status === 'autorizado') {
      const chave = String(resposta.chave_acesso || '').replace(/\D/g, '');
      const protocolo = resposta.protocolo ? String(resposta.protocolo) : '';
      // Cinto e suspensório: o banco também recusa, mas a mensagem daqui é melhor.
      if (chave.length !== 44 || !protocolo) {
        const motivo = `O provedor ${doc.provider} respondeu "autorizado" sem chave de acesso e protocolo válidos. O documento NÃO foi considerado autorizado — consulte o status antes de refaturar.`;
        await registrarEvento(doc, 'erro', 'erro', motivo, resposta.bruto ?? null, actor, tx);
        return (await s.update(R_DOC(), docId, { status: 'erro', motivo }, tx))!;
      }

      await registrarEvento(doc, 'autorizado', 'emitir', resposta.mensagem, resposta.bruto ?? null, actor, tx);
      const atualizado = (await s.update(
        R_DOC(),
        docId,
        {
          status: 'autorizado',
          chave_acesso: chave,
          protocolo,
          numero: resposta.numero ?? doc.numero,
          serie: resposta.serie ?? doc.serie,
          autorizado_em: agora,
          xml: resposta.xml ?? doc.xml ?? null,
          danfe_url: resposta.danfe_url ?? null,
          provider_ref: resposta.provider_ref ?? doc.provider_ref ?? null,
          motivo: null,
        },
        tx
      ))!;

      return atualizado;
    }

    // --- Não autorizado: nada de efeitos colaterais --------------------------
    const estado = resposta.status === 'processando' ? 'processando' : resposta.status === 'rejeitado' ? 'rejeitado' : 'erro';
    const motivo = resposta.mensagem;
    await registrarEvento(doc, estado, estado === 'rejeitado' ? 'rejeicao' : 'erro', motivo, resposta.bruto ?? null, actor, tx);

    const patch: Record<string, unknown> = { status: estado, motivo };
    if (estado !== 'processando' && ctx.numero !== null) {
      // Número rejeitado/não transmitido volta para a série — é reutilizável.
      patch.numero = null;
      patch.serie = null;
      await devolverNumeracao(ctx.config, ctx.modelo, ctx.numero, tx);
    }
    return (await s.update(R_DOC(), docId, patch, tx))!;
  });

  if (String(gravado.status) !== 'autorizado') return gravado;

  // ---- Efeitos colaterais: transação SEPARADA, de propósito ---------------
  // A autorização já foi gravada acima. Se a baixa de estoque falhar (saldo
  // insuficiente, por exemplo), a nota continua existindo na SEFAZ — fingir
  // que não existe seria pior do que registrar a pendência. O documento fica
  // autorizado SEM o carimbo `estoque_baixado_em`, com o erro no histórico,
  // e a reaplicação pode ser feita depois sem emitir nada de novo.
  try {
    await s.transaction(async (tx) => {
      const doc = await s.get(R_DOC(), docId, tx);
      if (doc) await aplicarEfeitosDaAutorizacao(doc, actor, tx);
    });
  } catch (e: any) {
    const motivo =
      `NOTA AUTORIZADA na SEFAZ, mas os efeitos no ERP não puderam ser aplicados: ${e?.message || e} ` +
      'O documento fiscal é válido; o estoque e o financeiro deste pedido precisam de ajuste manual.';
    await s.transaction(async (tx) => {
      const doc = await s.get(R_DOC(), docId, tx);
      if (doc) {
        await registrarEvento(doc, 'autorizado', 'erro', motivo, null, actor, tx);
        await s.update(R_DOC(), docId, { motivo }, tx);
      }
    });
  }

  return (await s.get(R_DOC(), docId))!;
}

/**
 * Efeitos da autorização, aplicados UMA vez só.
 *
 * Não há motor novo: a venda é levada a `faturada` e quem baixa estoque,
 * congela comissão e gera o contas a receber continua sendo
 * `aplicarRegrasPedido` (itens.ts + financeiro.ts), exatamente como no
 * faturamento manual.
 */
async function aplicarEfeitosDaAutorizacao(doc: Row, actor: { id: number | null; name: string }, tx: Tx): Promise<void> {
  const s = getStore();
  if (doc.estoque_baixado_em) return; // já aplicado — idempotente
  if (!doc.venda_id) return;

  const venda = await s.get(R_VENDA(), Number(doc.venda_id), tx);
  if (!venda) return;

  const jaFaturada = ['faturada', 'entregue'].includes(String(venda.status));
  if (!jaFaturada) {
    const atualizada = (await s.update(R_VENDA(), Number(venda.id), { status: 'faturada' }, tx))!;
    // Mesmos dois hooks que o faturamento manual dispara em services.ts:
    // estoque + comissão (itens.ts) e contas a receber (financeiro.ts).
    // Nenhum motor novo — só a mesma sequência, agora disparada pela
    // autorização da SEFAZ.
    await aplicarRegrasPedido('venda', venda, atualizada, { status: 'faturada' }, actor, tx);
    await syncLancamentoVenda(venda, atualizada, { status: 'faturada' }, actor, tx);
  }

  await s.update(
    R_VENDA(),
    Number(venda.id),
    {
      documento_fiscal_id: Number(doc.id),
      nfe_chave: doc.chave_acesso,
      nfe_status: 'emitida',
      nfe_numero: String(doc.numero ?? ''),
      nfe_emitida_em: doc.autorizado_em,
      nfe_provider: doc.provider,
    },
    tx
  );

  const agora = new Date().toISOString();
  await s.update(R_DOC(), Number(doc.id), { estoque_baixado_em: agora, financeiro_lancado_em: agora }, tx);

  await s.audit(
    {
      usuario_id: actor.id,
      usuario: actor.name,
      acao: 'editar',
      recurso: 'vendas',
      registro_id: Number(venda.id),
      descricao: `${doc.modelo === '65' ? 'NFC-e' : 'NF-e'} nº ${doc.numero} AUTORIZADA (chave ${doc.chave_acesso}) — venda faturada, estoque baixado e financeiro lançado`,
      empresa_id: empresaDoRegistroAudit(R_VENDA(), venda, actor),
      dados: { documento_fiscal_id: doc.id, chave: doc.chave_acesso, protocolo: doc.protocolo, provider: doc.provider, ambiente: doc.ambiente },
    },
    tx
  );
}

// ----------------------------------------------------------------------------
// Consulta, cancelamento, inutilização
// ----------------------------------------------------------------------------

async function carregarDocumento(id: number, escopo: EscopoEmpresa): Promise<Row> {
  const doc = await getStore().get(R_DOC(), id);
  if (!doc) throw new HttpError(404, 'Documento fiscal não encontrado.');
  assertRegistroDaEmpresa(R_DOC(), doc, escopo);
  return doc;
}

/** Resposta padronizada — deixa explícito se existe ou não nota de verdade. */
async function respostaDocumento(doc: Row, emitido: boolean) {
  return {
    documento_id: Number(doc.id),
    venda_id: doc.venda_id ?? null,
    modelo: doc.modelo,
    status: doc.status,
    /** `true` SÓ quando há documento autorizado pela SEFAZ. */
    emitido,
    emitida: emitido,
    numero: doc.numero ?? null,
    serie: doc.serie ?? null,
    chave_acesso: doc.chave_acesso ?? null,
    protocolo: doc.protocolo ?? null,
    ambiente: doc.ambiente,
    provider: doc.provider,
    danfe_url: doc.danfe_url ?? null,
    motivo: doc.motivo ?? null,
    autorizado_em: doc.autorizado_em ?? null,
    valor_total: doc.valor_total ?? null,
  };
}

/** GET /api/vendas/:id/fiscal — situação fiscal do pedido. */
export async function situacaoFiscalVenda(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_VENDA(), actor, 'read');
  const vendaId = parseId(req.params.id);
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const s = getStore();

  const venda = await s.get(R_VENDA(), vendaId);
  if (!venda) throw new HttpError(404, 'Pedido não encontrado.');
  assertRegistroDaEmpresa(R_VENDA(), venda, escopo);

  const docs = await s.list(R_DOC(), { page: 1, pageSize: 20, sort: 'id', dir: 'desc', filter: { venda_id: vendaId, empresa_id: escopo.empresaId } });
  const autorizado = docs.rows.find((d) => String(d.status) === 'autorizado') ?? null;
  const config = await configDaEmpresa(escopo.empresaId);

  res.json({
    venda_id: vendaId,
    emitido: !!autorizado,
    documento: autorizado ? await respostaDocumento(autorizado, true) : null,
    documentos: await Promise.all(docs.rows.map((d) => respostaDocumento(d, String(d.status) === 'autorizado'))),
    configuracao: {
      habilitado: !!config.habilitado,
      provider: config.provider,
      ambiente: config.ambiente,
    },
  });
}

/** GET /api/fiscal/documentos/:id/eventos — trilha completa do documento. */
export async function eventosDocumento(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_DOC(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const doc = await carregarDocumento(parseId(req.params.id), escopo);
  const eventos = await getStore().list(R_EVT(), { page: 1, pageSize: 200, sort: 'id', dir: 'desc', filter: { documento_id: Number(doc.id) } });
  res.json({ documento: await respostaDocumento(doc, String(doc.status) === 'autorizado'), eventos: eventos.rows });
}

/** POST /api/fiscal/documentos/:id/consultar — pergunta a situação ao provedor. */
export async function consultarDocumento(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_VENDA(), actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const doc = await carregarDocumento(parseId(req.params.id), escopo);

  const config = await configDaEmpresa(escopo.empresaId);
  const empresa = await empresaAtiva(escopo.empresaId);
  const provider = obterFiscalProvider(doc.provider as string);
  const credenciais = credenciaisDaEmpresa(config, empresa.cnpj);

  const referencia = String(doc.provider_ref || doc.idempotency_key || '');
  if (!referencia) throw new HttpError(409, 'Este documento nunca foi enviado a um provedor — não há o que consultar.');

  const resposta = await provider.consultar(referencia, credenciais);
  if (resposta.status === 'nao_configurado') {
    return res.status(409).json({ emitido: false, status: doc.status, mensagem: resposta.mensagem });
  }
  const atualizado = await aplicarResposta(Number(doc.id), resposta, actor, {
    config,
    modelo: String(doc.modelo) === '65' ? '65' : '55',
    // Na consulta a numeração não é devolvida: o documento pode existir lá.
    numero: null,
  });
  res.json(await respostaDocumento(atualizado, String(atualizado.status) === 'autorizado'));
}

/** POST /api/fiscal/documentos/:id/cancelar — cancelamento com justificativa. */
export async function cancelarDocumento(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_VENDA(), actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const doc = await carregarDocumento(parseId(req.params.id), escopo);
  const s = getStore();

  const justificativa = String((req.body || {}).justificativa || '').trim();
  if (justificativa.length < 15) {
    throw new HttpError(400, 'A SEFAZ exige uma justificativa de cancelamento com pelo menos 15 caracteres.');
  }
  if (String(doc.status) !== 'autorizado') {
    throw new HttpError(409, `Só é possível cancelar documento autorizado. Este está "${doc.status}".`);
  }

  const config = await configDaEmpresa(escopo.empresaId);
  const empresa = await empresaAtiva(escopo.empresaId);
  const provider = obterFiscalProvider(doc.provider as string);
  const credenciais = credenciaisDaEmpresa(config, empresa.cnpj);
  const referencia = String(doc.provider_ref || doc.idempotency_key || '');

  const resposta = await provider.cancelar(referencia, justificativa, credenciais);
  if (resposta.status !== 'cancelado') {
    await s.transaction(async (tx) => {
      await registrarEvento(doc, String(doc.status), 'cancelar', resposta.mensagem, resposta.bruto ?? null, actor, tx);
    });
    throw new HttpError(
      resposta.status === 'nao_configurado' ? 409 : 502,
      `A nota NÃO foi cancelada: ${resposta.mensagem}`
    );
  }

  const agora = new Date().toISOString();
  const atualizado = await s.transaction(async (tx) => {
    await registrarEvento(doc, 'cancelado', 'cancelar', resposta.mensagem, resposta.bruto ?? null, actor, tx);
    const row = (await s.update(
      R_DOC(),
      Number(doc.id),
      {
        status: 'cancelado',
        cancelado_em: agora,
        cancelamento_protocolo: resposta.protocolo ?? null,
        cancelamento_justificativa: justificativa,
      },
      tx
    ))!;
    if (doc.venda_id) {
      // O estoque NÃO volta sozinho: cancelar a nota é um ato fiscal. A
      // devolução ao estoque acontece ao cancelar a VENDA (estorno existente),
      // decisão do operador — evita estornar duas vezes.
      await s.update(R_VENDA(), Number(doc.venda_id), { nfe_status: 'cancelada' }, tx);
    }
    await s.audit(
      {
        usuario_id: actor.id,
        usuario: actor.name,
        acao: 'estornar',
        recurso: 'documentos_fiscais',
        registro_id: Number(doc.id),
        descricao: `Documento fiscal nº ${doc.numero} (chave ${doc.chave_acesso}) CANCELADO na SEFAZ — ${justificativa}`,
        empresa_id: empresaDoRegistroAudit(R_DOC(), doc, actor),
        dados: { protocolo: resposta.protocolo, justificativa },
      },
      tx
    );
    return row;
  });

  res.json({
    ...(await respostaDocumento(atualizado, false)),
    aviso:
      'A nota foi cancelada na SEFAZ. O estoque NÃO foi devolvido automaticamente — cancele a venda se as peças voltarem.',
  });
}

/** POST /api/fiscal/inutilizar — inutiliza faixa de numeração. */
export async function inutilizarNumeracao(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_INUT(), actor, 'create');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const s = getStore();
  const body = (req.body || {}) as Record<string, unknown>;

  const modelo: '55' | '65' = String(body.modelo || '55') === '65' ? '65' : '55';
  const serie = Number(body.serie);
  const inicial = Number(body.numero_inicial);
  const final = Number(body.numero_final);
  const justificativa = String(body.justificativa || '').trim();

  if (!Number.isInteger(serie) || serie <= 0) throw new HttpError(400, 'Informe a série.');
  if (!Number.isInteger(inicial) || !Number.isInteger(final) || inicial <= 0 || final < inicial) {
    throw new HttpError(400, 'Faixa de numeração inválida.');
  }
  if (justificativa.length < 15) throw new HttpError(400, 'A justificativa precisa ter pelo menos 15 caracteres.');

  const config = await configDaEmpresa(escopo.empresaId);
  const empresa = await empresaAtiva(escopo.empresaId);
  const provider = obterFiscalProvider(config.provider as string);
  const credenciais = credenciaisDaEmpresa(config, empresa.cnpj);

  const registro = await s.insert(R_INUT(), {
    empresa_id: escopo.empresaId,
    modelo,
    serie,
    numero_inicial: inicial,
    numero_final: final,
    justificativa,
    ambiente: config.ambiente,
    status: 'pendente',
    provider: provider.nome,
    criado_por: await autorValido(actor.id),
  });

  const resposta = await provider.inutilizar(
    { serie, numero_inicial: inicial, numero_final: final, justificativa, modelo },
    credenciais
  );

  const homologado = resposta.status === 'inutilizado';
  const atualizado = await s.update(R_INUT(), Number(registro.id), {
    status: homologado ? 'homologado' : resposta.status === 'processando' ? 'pendente' : 'erro',
    protocolo: resposta.protocolo ?? null,
    motivo: resposta.mensagem,
  });

  await s.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'ajuste',
    recurso: 'inutilizacoes_fiscais',
    registro_id: Number(registro.id),
    descricao: `Inutilização ${homologado ? 'HOMOLOGADA' : 'solicitada'} — modelo ${modelo}, série ${serie}, nº ${inicial} a ${final}`,
    empresa_id: empresaDoRegistroAudit(R_INUT(), registro, actor),
    dados: { justificativa, protocolo: resposta.protocolo ?? null, status: resposta.status },
  });

  res.status(homologado ? 200 : 202).json({ ...atualizado, homologado, mensagem: resposta.mensagem });
}

// ----------------------------------------------------------------------------
// Configuração fiscal (segredos cifrados, nunca devolvidos)
// ----------------------------------------------------------------------------

/** GET /api/fiscal/config — configuração da empresa ativa, sem segredos. */
export async function obterConfigFiscal(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Só administradores veem a configuração fiscal.');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const config = await configDaEmpresa(escopo.empresaId);
  const empresa = await empresaAtiva(escopo.empresaId);
  const provider = obterFiscalProvider(config.provider as string);
  const credenciais = credenciaisDaEmpresa(config, empresa.cnpj);

  res.json({
    empresa_id: escopo.empresaId,
    provider: config.provider,
    provider_base_url: config.provider_base_url ?? null,
    // Nunca o token: apenas a máscara, o suficiente para conferir qual é.
    provider_token: mascararSegredo(decifrarSegredo(config.provider_token_cifrado as string | null)),
    certificado_ref: config.certificado_ref ?? null,
    certificado_validade: config.certificado_validade ?? null,
    certificado_senha_definida: !!config.certificado_senha_cifrada,
    csc_id: config.csc_id ?? null,
    csc_token_definido: !!config.csc_token_cifrado,
    ambiente: config.ambiente,
    serie_nfe: config.serie_nfe,
    proximo_numero_nfe: config.proximo_numero_nfe,
    serie_nfce: config.serie_nfce,
    proximo_numero_nfce: config.proximo_numero_nfce,
    natureza_operacao_padrao: config.natureza_operacao_padrao,
    cfop_padrao_dentro_uf: config.cfop_padrao_dentro_uf,
    cfop_padrao_fora_uf: config.cfop_padrao_fora_uf,
    habilitado: !!config.habilitado,
    /** Pronto para emitir de verdade? É isto que a UI mostra. */
    pronto_para_emitir: !!config.habilitado && provider.configurado(credenciais),
    providers_disponiveis: provedoresDisponiveis(),
    avisos: [
      ...(chaveFraca()
        ? ['Defina SEGREDOS_ENCRYPTION_KEY no ambiente: hoje os tokens fiscais são cifrados com a chave de fallback.']
        : []),
      ...(String(config.ambiente) === 'homologacao' && config.habilitado
        ? ['Ambiente de HOMOLOGAÇÃO: as notas emitidas não têm valor fiscal.']
        : []),
    ],
  });
}

/** PUT /api/fiscal/config — grava a configuração; segredos entram cifrados. */
export async function salvarConfigFiscal(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Só administradores alteram a configuração fiscal.');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const s = getStore();
  const config = await configDaEmpresa(escopo.empresaId);
  const body = (req.body || {}) as Record<string, unknown>;

  // `atualizado_em` é carimbado pela própria camada de persistência.
  const patch: Record<string, unknown> = {};

  if (body.provider !== undefined) {
    const p = String(body.provider);
    if (!provedoresDisponiveis().includes(p)) throw new HttpError(400, `Provedor desconhecido: ${p}.`);
    patch.provider = p;
  }
  if (body.ambiente !== undefined) {
    const a = String(body.ambiente);
    if (a !== 'homologacao' && a !== 'producao') throw new HttpError(400, 'Ambiente deve ser homologacao ou producao.');
    patch.ambiente = a;
  }
  if (body.provider_base_url !== undefined) patch.provider_base_url = String(body.provider_base_url || '') || null;
  if (body.certificado_ref !== undefined) patch.certificado_ref = String(body.certificado_ref || '') || null;
  if (body.certificado_validade !== undefined) patch.certificado_validade = body.certificado_validade || null;
  if (body.csc_id !== undefined) patch.csc_id = String(body.csc_id || '') || null;
  if (body.natureza_operacao_padrao !== undefined) patch.natureza_operacao_padrao = String(body.natureza_operacao_padrao || 'Venda de mercadoria');
  if (body.cfop_padrao_dentro_uf !== undefined) patch.cfop_padrao_dentro_uf = String(body.cfop_padrao_dentro_uf || '5102');
  if (body.cfop_padrao_fora_uf !== undefined) patch.cfop_padrao_fora_uf = String(body.cfop_padrao_fora_uf || '6102');

  for (const [campo, coluna] of [
    ['provider_token', 'provider_token_cifrado'],
    ['certificado_senha', 'certificado_senha_cifrada'],
    ['csc_token', 'csc_token_cifrado'],
  ] as const) {
    if (body[campo] === undefined) continue;
    const valor = String(body[campo] ?? '');
    // String vazia = apagar a credencial; valor já cifrado passa intacto.
    patch[coluna] = valor === '' ? null : pareceCifrado(valor) ? valor : cifrarSegredo(valor);
  }

  // A numeração só pode AVANÇAR — recuar reemitiria números já usados.
  for (const campo of ['serie_nfe', 'serie_nfce', 'proximo_numero_nfe', 'proximo_numero_nfce'] as const) {
    if (body[campo] === undefined) continue;
    const novo = Number(body[campo]);
    if (!Number.isInteger(novo) || novo <= 0) throw new HttpError(400, `${campo} deve ser um inteiro positivo.`);
    if (campo.startsWith('proximo_numero') && novo < Number(config[campo] || 1)) {
      throw new HttpError(
        409,
        `A numeração fiscal não pode retroceder (${campo}: ${config[campo]} → ${novo}). Reutilizar número já emitido é rejeitado pela SEFAZ.`
      );
    }
    patch[campo] = novo;
  }

  if (body.habilitado !== undefined) {
    const habilitar = body.habilitado === true || body.habilitado === 'true';
    if (habilitar) {
      // Habilitar sem credencial criaria a expectativa falsa de que emite.
      const provisorio = { ...config, ...patch } as Row;
      const empresa = await empresaAtiva(escopo.empresaId);
      const provider = obterFiscalProvider(provisorio.provider as string);
      if (!provider.configurado(credenciaisDaEmpresa(provisorio, empresa.cnpj))) {
        throw new HttpError(409, 'Não é possível habilitar a emissão sem um provedor com token configurado.');
      }
      if (!String(empresa.cnpj || '').replace(/\D/g, '')) {
        throw new HttpError(409, 'Cadastre o CNPJ da empresa antes de habilitar a emissão fiscal.');
      }
    }
    patch.habilitado = habilitar;
  }

  const atualizado = await s.update(R_CFG(), Number(config.id), patch);
  await s.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'seguranca',
    recurso: 'empresa_fiscal_config',
    registro_id: Number(config.id),
    descricao: `Configuração fiscal da empresa ${escopo.empresaId} alterada (provedor ${atualizado?.provider}, ambiente ${atualizado?.ambiente}, ${atualizado?.habilitado ? 'HABILITADA' : 'desabilitada'})`,
    empresa_id: empresaDoAtorAudit(actor),
    // Jamais os segredos — apenas quais campos foram tocados.
    dados: { campos: Object.keys(patch) },
  });

  req.params.id = String(config.id);
  return obterConfigFiscal(req, res);
}

/** GET /api/vendas/:id/fiscal/previa — o que iria na nota, sem emitir nada. */
export async function previaDocumento(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_VENDA(), actor, 'read');
  const vendaId = parseId(req.params.id);
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const modelo: '55' | '65' = String(req.query.modelo || '55') === '65' ? '65' : '55';

  const venda = await getStore().get(R_VENDA(), vendaId);
  if (!venda) throw new HttpError(404, 'Pedido não encontrado.');
  assertRegistroDaEmpresa(R_VENDA(), venda, escopo);

  const montagem = await montarDocumentoDaVenda(vendaId, modelo, escopo.empresaId, null, `previa:${vendaId}`);
  const provider = obterFiscalProvider(montagem.config.provider as string);
  const credenciais = credenciaisDaEmpresa(montagem.config, montagem.empresa.cnpj);

  res.json({
    documento: montagem.payload,
    pendencias: montagem.pendencias,
    pode_emitir: montagem.pendencias.length === 0 && !!montagem.config.habilitado && provider.configurado(credenciais),
    provider: provider.nome,
    ambiente: montagem.payload.ambiente,
  });
}

/** Usado pelo escopo das rotas genéricas. */
export { escopoDe };
