// ============================================================================
// MASTER — MÓDULO COMERCIAL (territórios, carteira, metas, equipes,
// atribuição e motor de comissão)
//
// Este arquivo concentra as REGRAS de domínio que não são CRUD puro:
//
//   • validações de integridade que o banco também protege (defesa em
//     profundidade, e o que dá paridade ao modo memória): hierarquia sem ciclo,
//     carteira sem sobreposição, metas sem período ambíguo, participações
//     somando no máximo 100%;
//   • o MOTOR DE COMISSÃO (resolução de regra + apuração por venda);
//   • os INDICADORES derivados (MA-08) e o ACOMPANHAMENTO DE META (MA-04).
//
// REGRA GERAL: nada aqui é digitado pelo usuario. Indicador, realizado,
// variação, % de atingimento e comissão são CALCULADOS. As únicas grandezas
// gravadas são as que representam um FATO (venda, atribuição, regra, apuração).
//
// POR QUE A AGREGAÇÃO É EM MEMÓRIA (JS) E NÃO EM SQL
// --------------------------------------------------
// É o padrão já estabelecido dos relatórios do ERP (ver server/src/comissoes.ts
// e server/src/financeiro.ts): o Store é a única porta de leitura, então o
// MESMO código roda em PostgreSQL e no banco em memória — sem SQL paralelo,
// sem divergência silenciosa entre os dois modos e sem endpoints que só
// funcionam em produção. O número de CONSULTAS é constante (uma lista por
// tabela envolvida, nunca uma por registro): não há N+1.
// ============================================================================
import type { Request, Response } from 'express';
import { currentUser } from './auth';
import { HttpError } from './errors';
import { getResource, type Resource } from './resources';
import type { Row, Store, Tx } from './store';
import { checkAccess, getStore } from './services';
import { aplicarFiltroEmpresa, escopoDoAtor, type EscopoEmpresa } from './empresa';

/**
 * RECURSO INTERNO `comissoes_apuradas`.
 *
 * Não entra em RESOURCES de propósito: não existe tela nem endpoint genérico
 * de CRUD para apuração. A linha é escrita SÓ pelo motor (`apurarComissaoDaVenda`)
 * e lida pelos indicadores/relatórios. Expor um POST aqui permitiria "digitar"
 * comissão — exatamente o que o domínio proíbe.
 */
export const R_COMISSOES_APURADAS: Resource = {
  key: 'comissoes_apuradas',
  table: 'comissoes_apuradas',
  label: 'Comissões apuradas',
  singular: 'Apuração de comissão',
  labelFields: ['id'],
  internal: true,
  empresa: true,
  ops: { create: false, update: false, delete: false },
  orderBy: { field: 'id', dir: 'asc' },
  fields: [
    { name: 'empresa_id', label: 'Empresa', type: 'integer', readonly: true },
    { name: 'venda_id', label: 'Venda', type: 'integer' },
    { name: 'representante_id', label: 'Representante', type: 'integer' },
    { name: 'atribuicao_id', label: 'Atribuição', type: 'integer' },
    { name: 'plano_id', label: 'Plano', type: 'integer' },
    { name: 'regra_id', label: 'Regra', type: 'integer' },
    { name: 'base_tipo', label: 'Base', type: 'text' },
    { name: 'base_valor', label: 'Valor da base', type: 'money' },
    { name: 'percentual', label: 'Percentual', type: 'percent' },
    { name: 'participacao_pct', label: 'Participação', type: 'percent' },
    { name: 'valor', label: 'Valor', type: 'money' },
    { name: 'origem', label: 'Origem', type: 'text' },
    { name: 'status', label: 'Situação', type: 'text' },
    { name: 'criado_por', label: 'Criado por', type: 'integer' },
    { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true },
    { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true },
  ],
};

// ----------------------------------------------------------------------------
// Utilidades de data — sempre string YYYY-MM-DD (o fuso não entra na conta:
// `data` de venda é DATE, e comparar DATE com DATE é o que o operador espera).
// ----------------------------------------------------------------------------
export function diaISO(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Soma dias a uma data ISO (aritmética em UTC — sem horário de verão). */
export function somarDias(iso: string, dias: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

const hojeISO = () => new Date().toISOString().slice(0, 10);

/** Vigência [inicio, fim] com `fim` aberto (null) valendo "para sempre". */
export function periodoCobre(inicio: string | null, fim: string | null, dia: string): boolean {
  if (inicio && dia < inicio) return false;
  if (fim && dia > fim) return false;
  return true;
}

/** Dois períodos se sobrepõem quando um começa antes do outro terminar. */
export function periodosSobrepostos(
  a: { inicio: string | null; fim: string | null },
  b: { inicio: string | null; fim: string | null }
): boolean {
  const aFim = a.fim ?? '9999-12-31';
  const bFim = b.fim ?? '9999-12-31';
  const aIni = a.inicio ?? '0001-01-01';
  const bIni = b.inicio ?? '0001-01-01';
  return aIni <= bFim && bIni <= aFim;
}

function numero(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function idOuNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Lê um registro da MESMA empresa (404 quando não existir no escopo). */
async function lerDaEmpresa(
  s: Store,
  key: string,
  id: number,
  escopo: EscopoEmpresa,
  tx?: Tx
): Promise<Row> {
  const r = getResource(key)!;
  const where: Row = { id };
  if (r.empresa) where.empresa_id = escopo.empresaId;
  const row = await s.findOneWhere(r, where, tx);
  if (!row) throw new HttpError(404, `${r.singular} não encontrado(a).`);
  return row;
}

/** Lista TODAS as linhas de um recurso no escopo (uma consulta, nunca N+1). */
async function listarTudo(
  s: Store,
  key: string | Resource,
  escopo: EscopoEmpresa,
  filtro: Record<string, unknown> = {},
  tx?: Tx
): Promise<Row[]> {
  const r = (typeof key === 'string' ? getResource(key) : key)!;
  const paginado = await s.list(
    r,
    { page: 1, pageSize: 50_000, filter: aplicarFiltroEmpresa(r, filtro, escopo) },
    tx
  );
  return paginado.rows;
}

// ============================================================================
// MA-02 — TERRITÓRIOS
// ============================================================================

/**
 * Valida e COMPLETA o payload de território:
 *   • o pai precisa existir na MESMA empresa;
 *   • o pai não pode ser descendente do próprio território (ciclo);
 *   • `nivel` é DERIVADO do pai (o cliente não escolhe nível);
 *   • nome não colide entre irmãos (mesma empresa + mesmo pai);
 *   • código único por empresa.
 *
 * O banco repete estas regras (trigger em db/migrations/0041) — a duplicação é
 * intencional: aqui a mensagem é legível e o modo memória tem a mesma garantia.
 */
export async function validarTerritorio(
  s: Store,
  data: Row,
  atual: Row | null,
  escopo: EscopoEmpresa,
  tx?: Tx
): Promise<void> {
  const id = atual ? Number(atual.id) : null;
  const paiId = data.territorio_pai_id === undefined ? idOuNull(atual?.territorio_pai_id) : idOuNull(data.territorio_pai_id);

  if (paiId === null) {
    data.nivel = 1;
  } else {
    if (id !== null && paiId === id) {
      throw new HttpError(409, 'Um território não pode ser pai de si mesmo.', { territorio_pai_id: 'Escolha outro território' });
    }
    const pai = await lerDaEmpresa(s, 'territorios', paiId, escopo, tx);
    // Sobe a cadeia a partir do pai: se o próprio território aparecer, é ciclo.
    let cursor: Row | null = pai;
    let passos = 0;
    while (cursor) {
      if (id !== null && Number(cursor.id) === id) {
        throw new HttpError(409, 'Hierarquia inválida: o território pai é descendente deste território (ciclo).', { territorio_pai_id: 'Escolha um território acima na hierarquia' });
      }
      passos += 1;
      if (passos > 10) {
        throw new HttpError(409, 'Hierarquia de territórios excede 10 níveis.');
      }
      const proximo = idOuNull(cursor.territorio_pai_id);
      cursor = proximo ? await s.findOneWhere(getResource('territorios')!, { id: proximo }, tx) : null;
    }
    data.nivel = numero(pai.nivel) + 1;
    if (data.nivel > 10) throw new HttpError(409, 'Hierarquia de territórios excede 10 níveis.');
  }

  // Irmãos: mesmo pai (ou ambos raiz) na mesma empresa.
  const nome = data.nome === undefined ? String(atual?.nome ?? '') : String(data.nome ?? '');
  if (nome.trim()) {
    const irmaos = await listarTudo(s, 'territorios', escopo, {}, tx);
    const colisao = irmaos.find((r) => {
      if (id !== null && Number(r.id) === id) return false;
      if (String(r.nome ?? '').trim().toUpperCase() !== nome.trim().toUpperCase()) return false;
      const paiDoOutro = idOuNull(r.territorio_pai_id);
      return paiDoOutro === paiId;
    });
    if (colisao) {
      throw new HttpError(409, `Já existe um território chamado "${nome.trim()}" neste mesmo nível.`, { nome: 'Nome já usado neste nível' }, 'territorio_duplicado');
    }
  }

  const codigo = data.codigo === undefined ? String(atual?.codigo ?? '') : String(data.codigo ?? '');
  if (codigo.trim()) {
    const todos = await listarTudo(s, 'territorios', escopo, {}, tx);
    const colisao = todos.find((r) => id === null || Number(r.id) !== id
      ? String(r.codigo ?? '').trim().toUpperCase() === codigo.trim().toUpperCase()
      : false);
    if (colisao) {
      throw new HttpError(409, `Já existe um território com o código "${codigo.trim()}".`, { codigo: 'Código já usado' }, 'territorio_codigo_duplicado');
    }
  }
}

// ============================================================================
// MA-03 — CARTEIRA TEMPORAL
// ============================================================================

/**
 * Valida a carteira e ENCERRA a vigência anterior quando um novo vínculo
 * aberto é registrado para o mesmo cliente.
 *
 * A troca de representante é o caso real: o cliente muda de mão, o vínculo
 * antigo ganha `fim = véspera do novo início` e status `encerrado`. O registro
 * antigo NUNCA é apagado nem sobrescrito — é isso que preserva a história.
 *
 * Sobreposição (dois vínculos cobrindo o mesmo dia) é 409: nesse dia não
 * existiria UM responsável, e o relatório passaria a depender da ordem da
 * consulta.
 */
export async function validarCarteira(
  s: Store,
  data: Row | null,
  atual: Row | null,
  escopo: EscopoEmpresa,
  tx?: Tx
): Promise<void> {
  const id = atual ? Number(atual.id) : null;
  const clienteId = idOuNull(data?.cliente_id ?? atual?.cliente_id);
  const representanteId = idOuNull(data?.representante_id ?? atual?.representante_id);
  if (!clienteId || !representanteId) return;

  await lerDaEmpresa(s, 'clientes', clienteId, escopo, tx);
  await lerDaEmpresa(s, 'representantes', representanteId, escopo, tx);

  const inicio = diaISO(data?.inicio ?? atual?.inicio) ?? hojeISO();
  const fimBruto = data && 'fim' in data ? data.fim : atual?.fim;
  const fim = diaISO(fimBruto);
  const status = String(data?.status ?? atual?.status ?? 'ativo');

  if (fim && fim < inicio) {
    throw new HttpError(400, 'A data final da carteira não pode ser anterior ao início.', { fim: 'Data anterior ao início' });
  }
  if (status === 'encerrado' && !fim) {
    throw new HttpError(400, 'Um vínculo encerrado precisa de data final.', { fim: 'Informe a data final' });
  }
  if (data) data.inicio = inicio;

  const participacao = numero(data?.participacao_pct ?? atual?.participacao_pct ?? 100);
  const existentes = (await listarTudo(s, 'representante_cliente', escopo, {}, tx))
    .filter((r) => id === null || Number(r.id) !== id)
    .filter((r) => idOuNull(r.cliente_id) === clienteId)
    .filter((r) => String(r.status ?? 'ativo') !== 'cancelado');

  // O vínculo ABERTO que este novo vai substituir sai da checagem de
  // sobreposição: ele deixa de valer na véspera do novo início (é o mecanismo
  // de troca de representante, não uma sobreposição).
  // Só um vínculo de 100% SUBSTITUI o anterior. Participação parcial significa
  // carteira COMPARTILHADA: os dois continuam abertos (e a soma tem de caber
  // em 100%, checada abaixo).
  const abertoAnterior = existentes.find((r) => !diaISO(r.fim) && String(r.status ?? 'ativo') === 'ativo');
  const substituivel = abertoAnterior && !fim && participacao >= 100 && inicio > (diaISO(abertoAnterior.inicio) ?? '0001-01-01')
    ? abertoAnterior
    : null;
  // CARTEIRA COMPARTILHADA: dois vínculos ABERTOS com participação PARCIAL
  // (< 100%) no mesmo cliente são legítimos — eles dividem o cliente e a soma
  // das participações é checada adiante. A exclusividade vale para o vínculo
  // integral: nesse caso, um novo 100% encerra o anterior (takeover).
  const compartilhado = (r: Row) => !diaISO(r.fim) && String(r.status ?? 'ativo') === 'ativo'
    && numero(r.participacao_pct) < 100 && participacao < 100 && !fim;
  const conflitantes = existentes
    .filter((r) => !substituivel || Number(r.id) !== Number(substituivel.id))
    .filter((r) => !compartilhado(r));

  // 1) Sobreposição de vigência — recusa explícita.
  const sobreposto = conflitantes.find((r) => periodosSobrepostos(
    { inicio: diaISO(r.inicio), fim: diaISO(r.fim) },
    { inicio, fim }
  ));
  if (sobreposto) {
    const de = diaISO(sobreposto.inicio) ?? '—';
    const ate = diaISO(sobreposto.fim) ?? 'em aberto';
    throw new HttpError(
      409,
      `Sobreposição de carteira: já existe vínculo deste cliente no período ${de} a ${ate}. Encerre o vínculo anterior (ou ajuste as datas) antes de registrar outro.`,
      { inicio: 'Período sobreposto' },
      'carteira_sobreposta'
    );
  }

  // 2) Um único vínculo ABERTO por cliente: o novo encerra o anterior.
  if (abertoAnterior && !fim && participacao >= 100) {
    if (!substituivel) {
      throw new HttpError(
        409,
        'Já existe um vínculo de carteira aberto para este cliente. Encerre-o antes de registrar outro com a mesma data de início.',
        { inicio: 'Encerre o vínculo aberto' },
        'carteira_aberta'
      );
    }
    await s.update(getResource('representante_cliente')!, Number(abertoAnterior.id), {
      fim: somarDias(inicio, -1),
      status: 'encerrado',
      atualizado_em: new Date().toISOString(),
    }, tx);
  }

  // 3) Carteira compartilhada: a soma das participações ABERTAS não passa de 100.
  // A soma considera TODOS os vínculos abertos do cliente, menos o que este
  // registro substitui (integrar 100% encerra o anterior).
  const abertos = existentes
    .filter((r) => !substituivel || Number(r.id) !== Number(substituivel.id))
    .filter((r) => !diaISO(r.fim) && String(r.status ?? 'ativo') === 'ativo');
  const total = abertos.reduce((soma, r) => soma + numero(r.participacao_pct), 0) + participacao;
  if (!fim && total > 100.0001) {
    throw new HttpError(
      409,
      `A soma das participações abertas deste cliente passaria de 100% (${total.toFixed(2)}%).`,
      { participacao_pct: 'Participação excede o total' },
      'carteira_participacao'
    );
  }
}

// ============================================================================
// MA-04 — METAS
// ============================================================================

/** Metas: alvo/recorte coerentes, período válido e sem sobreposição ambígua. */
export async function validarMeta(
  s: Store,
  data: Row,
  atual: Row | null,
  escopo: EscopoEmpresa,
  tx?: Tx
): Promise<void> {
  const id = atual ? Number(atual.id) : null;
  const valor = (campo: string) => (data[campo] === undefined ? atual?.[campo] : data[campo]);

  const alvoTipo = String(valor('alvo_tipo') ?? 'representante');
  const alvos: Record<string, number | null> = {
    representante: idOuNull(valor('representante_id')),
    equipe: idOuNull(valor('equipe_id')),
    territorio: idOuNull(valor('territorio_id')),
  };
  const preenchidos = Object.entries(alvos).filter(([, v]) => v !== null).map(([k]) => k);
  if (alvoTipo !== 'empresa') {
    if (!alvos[alvoTipo]) {
      throw new HttpError(400, `Informe o(a) ${alvoTipo} desta meta.`, { [`${alvoTipo}_id`]: 'Obrigatório para este tipo de alvo' });
    }
    if (preenchidos.some((k) => k !== alvoTipo)) {
      throw new HttpError(400, 'A meta tem apenas UM alvo: remova os alvos que não correspondem ao tipo escolhido.', { alvo_tipo: 'Alvo conflitante' });
    }
    const recursoAlvo = alvoTipo === 'representante' ? 'representantes' : alvoTipo === 'equipe' ? 'equipes_comerciais' : 'territorios';
    await lerDaEmpresa(s, recursoAlvo, Number(alvos[alvoTipo]), escopo, tx);
  } else if (preenchidos.length) {
    throw new HttpError(400, 'Meta da empresa não leva representante, equipe ou território.', { alvo_tipo: 'Alvo conflitante' });
  }

  const recorteTipo = String(valor('recorte_tipo') ?? 'todos');
  const recortes: Record<string, number | null> = {
    produto: idOuNull(valor('produto_id')),
    categoria: idOuNull(valor('categoria_id')),
    colecao: idOuNull(valor('colecao_id')),
  };
  const recortesPreenchidos = Object.entries(recortes).filter(([, v]) => v !== null).map(([k]) => k);
  if (recorteTipo !== 'todos') {
    if (!recortes[recorteTipo]) {
      throw new HttpError(400, `Informe o(a) ${recorteTipo} do recorte desta meta.`, { [`${recorteTipo}_id`]: 'Obrigatório para este recorte' });
    }
    if (recortesPreenchidos.some((k) => k !== recorteTipo)) {
      throw new HttpError(400, 'A meta tem apenas UM recorte: remova os recortes que não correspondem ao tipo escolhido.', { recorte_tipo: 'Recorte conflitante' });
    }
  } else if (recortesPreenchidos.length) {
    throw new HttpError(400, 'Meta sem recorte não leva produto, categoria nem coleção.', { recorte_tipo: 'Recorte conflitante' });
  }

  const inicio = diaISO(valor('periodo_inicio'));
  const fim = diaISO(valor('periodo_fim'));
  if (!inicio || !fim) throw new HttpError(400, 'Informe o início e o fim do período da meta.');
  if (fim < inicio) throw new HttpError(400, 'O fim do período não pode ser anterior ao início.', { periodo_fim: 'Data anterior ao início' });
  if (data.periodo_inicio !== undefined) data.periodo_inicio = inicio;
  if (data.periodo_fim !== undefined) data.periodo_fim = fim;

  const metaValor = valor('valor_meta');
  const metaQtd = valor('quantidade_meta');
  if (numero(metaValor) <= 0 && numero(metaQtd) <= 0) {
    throw new HttpError(400, 'Informe o valor da meta (R$) ou a quantidade alvo.', { valor_meta: 'Informe ao menos um alvo' });
  }

  const status = String(valor('status') ?? 'ativa');
  if (status !== 'ativa') return;

  const metrica = String(valor('metrica') ?? 'faturamento');
  const outras = (await listarTudo(s, 'metas', escopo, {}, tx))
    .filter((r) => (id === null || Number(r.id) !== id) && String(r.status ?? '') === 'ativa')
    .filter((r) => String(r.alvo_tipo) === alvoTipo && String(r.metrica) === metrica && String(r.recorte_tipo) === recorteTipo)
    .filter((r) => idOuNull(r.representante_id) === alvos.representante
      && idOuNull(r.equipe_id) === alvos.equipe
      && idOuNull(r.territorio_id) === alvos.territorio
      && idOuNull(r.produto_id) === recortes.produto
      && idOuNull(r.categoria_id) === recortes.categoria
      && idOuNull(r.colecao_id) === recortes.colecao);
  const conflito = outras.find((r) => periodosSobrepostos(
    { inicio: diaISO(r.periodo_inicio), fim: diaISO(r.periodo_fim) },
    { inicio, fim }
  ));
  if (conflito) {
    throw new HttpError(
      409,
      `Já existe uma meta ativa para este mesmo alvo, métrica e recorte no período ${diaISO(conflito.periodo_inicio)} a ${diaISO(conflito.periodo_fim)}. Encerre a meta anterior antes de criar outra no mesmo período.`,
      { periodo_inicio: 'Período sobreposto' },
      'meta_sobreposta'
    );
  }
}

// ============================================================================
// MA-06 — EQUIPES E HIERARQUIA
// ============================================================================

/** Composição da equipe: sem duplicidade aberta e sem passar de 100% ativos. */
export async function validarEquipeMembro(
  s: Store,
  data: Row,
  atual: Row | null,
  escopo: EscopoEmpresa,
  tx?: Tx
): Promise<void> {
  const id = atual ? Number(atual.id) : null;
  const equipeId = idOuNull(data.equipe_id ?? atual?.equipe_id);
  const representanteId = idOuNull(data.representante_id ?? atual?.representante_id);
  if (!equipeId || !representanteId) return;

  await lerDaEmpresa(s, 'equipes_comerciais', equipeId, escopo, tx);
  await lerDaEmpresa(s, 'representantes', representanteId, escopo, tx);

  const entrada = diaISO(data.entrada ?? atual?.entrada) ?? hojeISO();
  const saida = diaISO(data.saida === undefined ? atual?.saida : data.saida);
  if (saida && saida < entrada) {
    throw new HttpError(400, 'A saída não pode ser anterior à entrada.', { saida: 'Data anterior à entrada' });
  }
  if (data.entrada !== undefined) data.entrada = entrada;

  const status = String(data.status ?? atual?.status ?? 'ativo');
  const membros = (await listarTudo(s, 'equipe_membros', escopo, { equipe_id: equipeId }, tx))
    .filter((r) => id === null || Number(r.id) !== id)
    .filter((r) => String(r.status ?? 'ativo') === 'ativo' && !diaISO(r.saida));

  if (!saida && status === 'ativo') {
    const jaEsta = membros.find((r) => idOuNull(r.representante_id) === representanteId);
    if (jaEsta) {
      throw new HttpError(409, 'Este representante já está ativo nesta equipe.', { representante_id: 'Já participa da equipe' }, 'equipe_membro_duplicado');
    }
    const total = membros.reduce((soma, r) => soma + numero(r.participacao_pct), 0) + numero(data.participacao_pct ?? atual?.participacao_pct ?? 100);
    if (total > 100.0001) {
      throw new HttpError(
        409,
        `A soma das participações ativas da equipe passaria de 100% (${total.toFixed(2)}%).`,
        { participacao_pct: 'Participação excede o total' },
        'equipe_participacao'
      );
    }
  }
}

/**
 * Hierarquia comercial: cada subordinado tem UM supervisor ativo e a cadeia
 * não pode fechar ciclo (A→B→C→A). O banco tem o índice único parcial e o
 * trigger de ciclo; aqui a mensagem é legível e o modo memória é equivalente.
 */
export async function validarHierarquia(
  s: Store,
  data: Row,
  atual: Row | null,
  escopo: EscopoEmpresa,
  tx?: Tx
): Promise<void> {
  const id = atual ? Number(atual.id) : null;
  const supervisorId = idOuNull(data.supervisor_id ?? atual?.supervisor_id);
  const subordinadoId = idOuNull(data.subordinado_id ?? atual?.subordinado_id);
  if (!supervisorId || !subordinadoId) return;

  if (supervisorId === subordinadoId) {
    throw new HttpError(409, 'Um representante não pode ser supervisor de si mesmo.', { supervisor_id: 'Escolha outro representante' });
  }
  await lerDaEmpresa(s, 'representantes', supervisorId, escopo, tx);
  await lerDaEmpresa(s, 'representantes', subordinadoId, escopo, tx);

  const inicio = diaISO(data.inicio ?? atual?.inicio) ?? hojeISO();
  const fim = diaISO(data.fim === undefined ? atual?.fim : data.fim);
  if (fim && fim < inicio) {
    throw new HttpError(400, 'O fim da vigência não pode ser anterior ao início.', { fim: 'Data anterior ao início' });
  }
  if (data.inicio !== undefined) data.inicio = inicio;

  const status = String(data.status ?? atual?.status ?? 'ativo');
  const vinculos = await listarTudo(s, 'representante_hierarquia', escopo, {}, tx);
  const ativos = vinculos
    .filter((r) => id === null || Number(r.id) !== id)
    .filter((r) => String(r.status ?? 'ativo') === 'ativo' && !diaISO(r.fim));

  if (!fim && status === 'ativo') {
    const outro = ativos.find((r) => idOuNull(r.subordinado_id) === subordinadoId);
    if (outro) {
      throw new HttpError(
        409,
        'Este representante já tem um supervisor ativo. Encerre o vínculo atual (data de fim) antes de definir outro.',
        { subordinado_id: 'Já possui supervisor ativo' },
        'hierarquia_supervisor_unico'
      );
    }
    // Ciclo: sobe a cadeia a partir do supervisor proposto.
    let atualCursor: number | null = supervisorId;
    let passos = 0;
    while (atualCursor) {
      if (atualCursor === subordinadoId) {
        throw new HttpError(409, 'Hierarquia inválida: este vínculo criaria um ciclo de supervisão.', { supervisor_id: 'Ciclo de hierarquia' }, 'hierarquia_ciclo');
      }
      passos += 1;
      if (passos > 25) throw new HttpError(409, 'Hierarquia comercial excede 25 níveis.');
      const superior = ativos.find((r) => idOuNull(r.subordinado_id) === atualCursor);
      atualCursor = superior ? idOuNull(superior.supervisor_id) : null;
    }
  }
}

// ============================================================================
// MA-07 — ATRIBUIÇÃO COMERCIAL
// ============================================================================

/** A soma das participações de uma venda não passa de 100%; um principal só. */
export async function validarAtribuicaoVenda(
  s: Store,
  data: Row,
  atual: Row | null,
  escopo: EscopoEmpresa,
  tx?: Tx
): Promise<void> {
  const id = atual ? Number(atual.id) : null;
  const vendaId = idOuNull(data.venda_id ?? atual?.venda_id);
  const representanteId = idOuNull(data.representante_id ?? atual?.representante_id);
  if (!vendaId || !representanteId) return;

  const venda = await lerDaEmpresa(s, 'vendas', vendaId, escopo, tx);
  if (['faturada', 'entregue'].includes(String(venda.status))) {
    // Atribuição de venda já faturada muda quem recebe comissão: é decisão
    // administrativa, não edição de tela. A comissão congelada não é reescrita.
    throw new HttpError(
      409,
      'Venda já faturada: a atribuição comercial não pode ser alterada por aqui. A comissão congelada no documento permanece.',
      { venda_id: 'Venda faturada' },
      'atribuicao_venda_faturada'
    );
  }

  const representantes = await listarTudo(s, 'venda_atribuicao', escopo, { venda_id: vendaId }, tx);
  const outras = representantes.filter((r) => id === null || Number(r.id) !== id);
  if (outras.some((r) => idOuNull(r.representante_id) === representanteId)) {
    throw new HttpError(409, 'Este representante já está atribuído a esta venda.', { representante_id: 'Já atribuído' }, 'atribuicao_duplicada');
  }

  const participacao = numero(data.participacao_pct ?? atual?.participacao_pct ?? 100);
  const total = outras.reduce((soma, r) => soma + numero(r.participacao_pct), 0) + participacao;
  if (total > 100.0001) {
    throw new HttpError(409, `A soma das participações desta venda passaria de 100% (${total.toFixed(2)}%).`, { participacao_pct: 'Excede 100%' }, 'atribuicao_participacao');
  }

  const papel = String(data.papel ?? atual?.papel ?? 'principal');
  if (papel === 'principal') {
    const principal = outras.find((r) => String(r.papel) === 'principal');
    if (principal) {
      throw new HttpError(
        409,
        'Esta venda já tem um representante principal. O principal é único — atribua os demais como secundários.',
        { papel: 'Já existe principal' },
        'atribuicao_principal'
      );
    }
  }
}

/**
 * PONTO ÚNICO de entrada das regras comerciais no CRUD genérico
 * (createRecord/updateRecord). Mantém `services.ts` sem cadeia de `if` novo e
 * garante que a MESMA regra vale para POST e PUT.
 */
export async function validarRegrasComerciais(
  r: Resource,
  data: Row,
  atual: Row | null,
  s: Store,
  escopo: EscopoEmpresa,
  tx?: Tx
): Promise<void> {
  switch (r.key) {
    case 'territorios':
      await validarTerritorio(s, data, atual, escopo, tx);
      return;
    case 'representante_cliente':
      await validarCarteira(s, data, atual, escopo, tx);
      return;
    case 'metas':
      await validarMeta(s, data, atual, escopo, tx);
      return;
    case 'equipe_membros':
      await validarEquipeMembro(s, data, atual, escopo, tx);
      return;
    case 'representante_hierarquia':
      await validarHierarquia(s, data, atual, escopo, tx);
      return;
    case 'venda_atribuicao':
      await validarAtribuicaoVenda(s, data, atual, escopo, tx);
      return;
    default:
      return;
  }
}

// ============================================================================
// MA-05 — MOTOR DE COMISSÃO
// ============================================================================

/** Peso do escopo: quanto mais específico, maior o peso na resolução. */
export const PESO_ESCOPO: Record<string, number> = {
  produto: 8,
  categoria: 7,
  colecao: 6,
  cliente: 5,
  territorio: 4,
  equipe: 3,
  representante: 2,
  geral: 1,
};

export type ContextoRegra = {
  dia: string;
  representanteId: number | null;
  equipeId: number | null;
  territorioId: number | null;
  clienteId: number | null;
  produtoId?: number | null;
  categoriaId?: number | null;
  colecaoId?: number | null;
};

/**
 * A regra se aplica a este contexto? Devolve a pontuação (escopo + prioridade)
 * ou `null` quando não serve. Uma regra de escopo X só casa quando o alvo de X
 * está presente no contexto E é o mesmo — não existe "regra de produto valendo
 * para qualquer produto".
 */
export function pontuarRegra(regra: Row, plano: Row | null, ctx: ContextoRegra): number | null {
  const escopo = String(regra.escopo ?? 'geral');
  const peso = PESO_ESCOPO[escopo];
  if (!peso) return null;

  if (plano) {
    const vinicio = diaISO(plano.vigencia_inicio);
    const vfim = diaISO(plano.vigencia_fim);
    if (String(plano.status ?? 'ativo') !== 'ativo') return null;
    if (!periodoCobre(vinicio, vfim, ctx.dia)) return null;
  }
  const inicio = diaISO(regra.vigencia_inicio);
  const fim = diaISO(regra.vigencia_fim);
  if (!periodoCobre(inicio, fim, ctx.dia)) return null;

  switch (escopo) {
    case 'geral':
      return peso * 1_000_000 + numero(regra.prioridade);
    case 'representante':
      return idOuNull(regra.representante_id) === ctx.representanteId ? peso * 1_000_000 + numero(regra.prioridade) : null;
    case 'equipe':
      return ctx.equipeId !== null && idOuNull(regra.equipe_id) === ctx.equipeId ? peso * 1_000_000 + numero(regra.prioridade) : null;
    case 'territorio':
      return ctx.territorioId !== null && idOuNull(regra.territorio_id) === ctx.territorioId ? peso * 1_000_000 + numero(regra.prioridade) : null;
    case 'cliente':
      return ctx.clienteId !== null && idOuNull(regra.cliente_id) === ctx.clienteId ? peso * 1_000_000 + numero(regra.prioridade) : null;
    case 'produto':
      return ctx.produtoId && idOuNull(regra.produto_id) === ctx.produtoId ? peso * 1_000_000 + numero(regra.prioridade) : null;
    case 'categoria':
      return ctx.categoriaId && idOuNull(regra.categoria_id) === ctx.categoriaId ? peso * 1_000_000 + numero(regra.prioridade) : null;
    case 'colecao':
      return ctx.colecaoId && idOuNull(regra.colecao_id) === ctx.colecaoId ? peso * 1_000_000 + numero(regra.prioridade) : null;
    default:
      return null;
  }
}

export type CandidatoRegra = { regra: Row; plano: Row };

/**
 * RESOLUÇÃO DETERMINÍSTICA. Ordem: pontuação (escopo específico + prioridade),
 * depois vigência mais recente, depois maior id. Empate nunca é resolvido pela
 * ordem em que as linhas vieram do banco.
 */
export function escolherRegra(candidatos: CandidatoRegra[], ctx: ContextoRegra): CandidatoRegra | null {
  let melhor: CandidatoRegra | null = null;
  let melhorPeso = -1;
  let melhorVigencia = '';
  let melhorId = -1;
  for (const c of candidatos) {
    if (String(c.regra.status ?? 'ativa') !== 'ativa') continue;
    const peso = pontuarRegra(c.regra, c.plano, ctx);
    if (peso === null) continue;
    const vigencia = diaISO(c.regra.vigencia_inicio) ?? diaISO(c.plano.vigencia_inicio) ?? '';
    const id = numero(c.regra.id);
    if (
      peso > melhorPeso
      || (peso === melhorPeso && vigencia > melhorVigencia)
      || (peso === melhorPeso && vigencia === melhorVigencia && id > melhorId)
    ) {
      melhor = c;
      melhorPeso = peso;
      melhorVigencia = vigencia;
      melhorId = id;
    }
  }
  return melhor;
}

/** Base de cálculo de um item, conforme a regra/plano. */
function baseDoItem(item: Row, produto: Row | null, base: string): number {
  const subtotal = numero(item.subtotal) || numero(item.preco_unitario) * numero(item.quantidade) * (1 - numero(item.desconto_pct) / 100);
  if (base === 'liquido') return subtotal;
  if (base === 'margem') {
    const custo = numero(produto?.custo);
    return Math.max(0, subtotal - custo * numero(item.quantidade));
  }
  // bruto: preço cheio do item, antes do desconto do cabeçalho/itens.
  const precoTabela = numero(item.preco_tabela) || numero(item.preco_unitario);
  return precoTabela * numero(item.quantidade);
}

export type ApuracaoComissao = {
  venda_id: number;
  representantes: {
    representante_id: number;
    representante: string | null;
    participacao_pct: number;
    base_valor: number;
    valor: number;
    plano_id: number | null;
    plano: string | null;
    escopos: string[];
    regra_id: number | null;
  }[];
  total: number;
  recalculada: boolean;
};

/**
 * APURAÇÃO DA COMISSÃO DE UMA VENDA — explícita, auditada e idempotente.
 *
 * • só roda em venda FATURADA/ENTREGUE (antes disso não há fato econômico);
 * • cada representante atribuído recebe sua parte conforme a participação;
 * • a regra de cada item é resolvida pelo motor (produto/categoria/coleção
 *   valem por item; cliente/território/equipe/representante, pela venda);
 * • a apuração anterior do mesmo par venda×representante é marcada como
 *   `estornada` (não é apagada) e a nova é gravada — o histórico é append;
 * • `vendas.comissao_pct`/`comissao_valor` do representante PRINCIPAL são
 *   atualizados, preservando o contrato que faturamento e relatórios já leem.
 *
 * Nada recalcula sozinho: quem apura é o endpoint/ato explícito.
 */
export async function apurarComissaoDaVenda(
  s: Store,
  vendaId: number,
  actor: { id: number; name: string },
  escopo: EscopoEmpresa
): Promise<ApuracaoComissao> {
  return s.transaction(async (tx) => {
    const venda = await lerDaEmpresa(s, 'vendas', vendaId, escopo, tx);
    const status = String(venda.status ?? '');
    if (!['faturada', 'entregue'].includes(status)) {
      throw new HttpError(409, `A comissão só é apurada em venda faturada ou entregue (status atual: ${status || '—'}).`, { status: 'Fature a venda antes de apurar' }, 'comissao_venda_nao_faturada');
    }

    const atribuicoes = await listarTudo(s, 'venda_atribuicao', escopo, { venda_id: vendaId }, tx);
    const participantes = (atribuicoes.length
      ? atribuicoes.map((a) => ({
        representante_id: idOuNull(a.representante_id),
        equipe_id: idOuNull(a.equipe_id),
        territorio_id: idOuNull(a.territorio_id),
        participacao_pct: numero(a.participacao_pct) || 100,
        papel: String(a.papel ?? 'secundario'),
        atribuicao_id: Number(a.id),
      }))
      : [{
        representante_id: idOuNull(venda.representante_id),
        equipe_id: null,
        territorio_id: null,
        participacao_pct: 100,
        papel: 'principal',
        atribuicao_id: null,
      }])
      .filter((p) => p.representante_id !== null);

    if (!participantes.length) {
      throw new HttpError(409, 'A venda não tem representante atribuído — não há comissão a apurar.', { representante_id: 'Atribua um representante' }, 'comissao_sem_representante');
    }

    const [planos, regras, itens, produtos, reps] = await Promise.all([
      listarTudo(s, 'planos_comissao', escopo, { status: 'ativo' }, tx),
      listarTudo(s, 'regras_comissao', escopo, { status: 'ativa' }, tx),
      listarTudo(s, 'itens_venda', escopo, { venda_id: vendaId }, tx),
      listarTudo(s, 'produtos', escopo, {}, tx),
      listarTudo(s, 'representantes', escopo, {}, tx),
    ]);

    const planoPorId = new Map(planos.map((p) => [Number(p.id), p]));
    const produtoPorId = new Map(produtos.map((p) => [Number(p.id), p]));
    const repNome = new Map(reps.map((r) => [Number(r.id), String(r.nome ?? '')]));
    const candidatos: CandidatoRegra[] = regras
      .map((regra) => ({ regra, plano: planoPorId.get(Number(regra.plano_id)) }))
      .filter((c): c is CandidatoRegra => !!c.plano);

    const dia = diaISO(venda.data) ?? hojeISO();
    const clienteId = idOuNull(venda.cliente_id);
    const resultados: ApuracaoComissao['representantes'] = [];

    for (const p of participantes) {
      const ctxBase: ContextoRegra = {
        dia,
        representanteId: p.representante_id,
        equipeId: p.equipe_id,
        territorioId: p.territorio_id,
        clienteId,
      };
      let baseTotal = 0;
      let valorTotal = 0;
      let planoUsado: Row | null = null;
      let regraPrincipal: Row | null = null;
      const escopos = new Set<string>();

      // Cada item resolve a própria regra (produto/categoria/coleção valem por
      // item). Se NENHUMA regra casar, cai na comissão do cadastro logo abaixo.
      for (const item of itens) {
        const produto = produtoPorId.get(Number(item.produto_id)) ?? null;
        const ctx: ContextoRegra = {
          ...ctxBase,
          produtoId: idOuNull(item.produto_id),
          categoriaId: idOuNull(produto?.categoria_id),
          colecaoId: idOuNull(produto?.colecao_id),
        };
        const escolhido = escolherRegra(candidatos, ctx);
        if (!escolhido) continue;
        escopos.add(String(escolhido.regra.escopo));
        const base = String(escolhido.regra.base ?? escolhido.plano.base_calculo ?? 'bruto');
        const baseItem = baseDoItem(item, produto, base);
        baseTotal += baseItem;
        if (String(escolhido.regra.tipo_valor) === 'fixo') {
          // Valor fixo é por VENDA, não por item: entra uma única vez.
          if (!regraPrincipal) valorTotal += numero(escolhido.regra.valor);
        } else {
          valorTotal += baseItem * numero(escolhido.regra.valor) / 100;
        }
        if (!regraPrincipal) {
          regraPrincipal = escolhido.regra;
          planoUsado = escolhido.plano;
        }
      }

      if (!regraPrincipal) {
        // Fallback legado.
        const rep = reps.find((r) => Number(r.id) === p.representante_id);
        const pct = numero(rep?.comissao_pct);
        const baseVenda = numero(venda.total);
        baseTotal = baseVenda;
        valorTotal = baseVenda * pct / 100;
        escopos.add('cadastro');
        resultados.push({
          representante_id: p.representante_id!,
          representante: repNome.get(p.representante_id!) ?? null,
          participacao_pct: p.participacao_pct,
          base_valor: arredondar(baseTotal),
          valor: arredondar(valorTotal * p.participacao_pct / 100),
          plano_id: null,
          plano: null,
          escopos: ['cadastro'],
          regra_id: null,
        });
        continue;
      }

      resultados.push({
        representante_id: p.representante_id!,
        representante: repNome.get(p.representante_id!) ?? null,
        participacao_pct: p.participacao_pct,
        base_valor: arredondar(baseTotal),
        valor: arredondar(valorTotal * p.participacao_pct / 100),
        plano_id: planoUsado ? Number(planoUsado.id) : null,
        plano: planoUsado ? String(planoUsado.nome ?? '') : null,
        escopos: [...escopos],
        regra_id: regraPrincipal ? Number(regraPrincipal.id) : null,
      });
    }

    // Substitui a apuração ATIVA anterior (marcando como estornada, nunca
    // apagando) e grava a nova linha.
    const anteriores = await listarTudo(s, R_COMISSOES_APURADAS, escopo, { venda_id: vendaId }, tx);
    const ativas = anteriores.filter((r) => String(r.status ?? 'apurada') === 'apurada');
    const eraRecalculo = ativas.length > 0;
    for (const a of ativas) {
      await s.update(R_COMISSOES_APURADAS, Number(a.id), {
        status: 'estornada',
        atualizado_em: new Date().toISOString(),
      }, tx);
    }

    for (const r of resultados) {
      const atribuicao = participantes.find((p) => p.representante_id === r.representante_id);
      await s.insert(R_COMISSOES_APURADAS, {
        empresa_id: escopo.empresaId,
        venda_id: vendaId,
        representante_id: r.representante_id,
        atribuicao_id: atribuicao?.atribuicao_id ?? null,
        plano_id: r.plano_id,
        regra_id: r.regra_id,
        base_tipo: 'bruto',
        base_valor: r.base_valor,
        percentual: r.base_valor > 0 ? arredondar((r.valor / r.base_valor) * 100 * (100 / (r.participacao_pct || 100))) : null,
        participacao_pct: r.participacao_pct,
        valor: r.valor,
        origem: r.escopos.includes('cadastro') ? 'cadastro' : 'motor',
        status: 'apurada',
        criado_por: actor.id || null,
      }, tx);
    }

    // Contrato legado: a venda guarda a comissão do representante principal.
    const principal = resultados.find((r) => {
      const p = participantes.find((x) => x.representante_id === r.representante_id);
      return p?.papel === 'principal';
    }) ?? resultados[0];
    if (principal) {
      await s.update(getResource('vendas')!, vendaId, {
        comissao_pct: principal.base_valor > 0 ? arredondar(principal.valor * 100 / principal.base_valor) : 0,
        comissao_valor: principal.valor,
      }, tx);
    }

    // Auditoria: a apuração é um FATO registrado (quem apurou, quando, valores).
    await s.audit({
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao: 'editar',
      recurso: 'vendas',
      registro_id: vendaId,
      descricao: `Comissão ${eraRecalculo ? 'REAPURADA' : 'apurada'} para ${resultados.length} representante(s) — total ${arredondar(resultados.reduce((s2, r) => s2 + r.valor, 0)).toFixed(2)}`,
      dados: { apuracao: resultados },
      empresa_id: escopo.empresaId,
    }, tx);

    return {
      venda_id: vendaId,
      representantes: resultados,
      total: arredondar(resultados.reduce((s2, r) => s2 + r.valor, 0)),
      recalculada: eraRecalculo,
    };
  });
}

function arredondar(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

// ============================================================================
// MA-08 — INDICADORES e MA-04 — ACOMPANHAMENTO DE META
// ============================================================================

export type PeriodoIndicador = { de: string | null; ate: string | null };

export type Indicadores = {
  janela: { de: string | null; ate: string | null };
  filtros: Record<string, number | null>;
  vendas: number;
  faturamento: number;
  pedidos: number;
  clientes: number;
  pecas: number;
  ticket_medio: number;
  comissao: number;
  meta: number | null;
  realizado: number | null;
  variacao: number | null;
  atingimento_pct: number | null;
  por_representante: {
    representante_id: number;
    representante: string;
    vendas: number;
    faturamento: number;
    pedidos: number;
    clientes: number;
    pecas: number;
    ticket_medio: number;
    comissao: number;
    meta: number | null;
    atingimento_pct: number | null;
  }[];
  por_territorio: { territorio_id: number; territorio: string; faturamento: number; pedidos: number }[];
  por_equipe: { equipe_id: number; equipe: string; faturamento: number; pedidos: number }[];
};

const STATUS_FATURADO = new Set(['faturada', 'entregue']);

/**
 * INDICADORES DERIVADOS (MA-08). Nenhum número aqui é cadastrado: tudo sai de
 * vendas faturadas + itens + atribuição/carteira e das metas ativas.
 *
 * Filtros: representante, equipe, território e janela de datas. O recorte de
 * equipe/território usa a ATRIBUIÇÃO CONGELADA na venda; quando a venda é
 * antiga (sem atribuição), cai para `vendas.representante_id` e para a carteira
 * vigente — documentado, nunca silencioso.
 */
export async function calcularIndicadores(
  s: Store,
  escopo: EscopoEmpresa,
  filtros: { representante_id?: number | null; equipe_id?: number | null; territorio_id?: number | null },
  periodo: PeriodoIndicador
): Promise<Indicadores> {
  const [vendas, itens, atribuicoes, metas, reps, territorios, equipes] = await Promise.all([
    listarTudo(s, 'vendas', escopo),
    listarTudo(s, 'itens_venda', escopo),
    listarTudo(s, 'venda_atribuicao', escopo),
    listarTudo(s, 'metas', escopo),
    listarTudo(s, 'representantes', escopo),
    listarTudo(s, 'territorios', escopo),
    listarTudo(s, 'equipes_comerciais', escopo),
  ]);

  const repNome = new Map(reps.map((r) => [Number(r.id), String(r.nome ?? `#${r.id}`)]));
  const terrNome = new Map(territorios.map((t) => [Number(t.id), String(t.nome ?? `#${t.id}`)]));
  const eqpNome = new Map(equipes.map((e) => [Number(e.id), String(e.nome ?? `#${e.id}`)]));

  const itensPorVenda = new Map<number, Row[]>();
  for (const item of itens) {
    const vid = Number(item.venda_id);
    const lista = itensPorVenda.get(vid);
    if (lista) lista.push(item);
    else itensPorVenda.set(vid, [item]);
  }
  const atribPorVenda = new Map<number, Row[]>();
  for (const a of atribuicoes) {
    const vid = Number(a.venda_id);
    const lista = atribPorVenda.get(vid);
    if (lista) lista.push(a);
    else atribPorVenda.set(vid, [a]);
  }

  const dentro = (d: string | null) => (!d ? false : (!periodo.de || d >= periodo.de) && (!periodo.ate || d <= periodo.ate));

  type Acumulado = { vendas: number; faturamento: number; clientes: Set<number>; pecas: number; comissao: number };
  const vazio = (): Acumulado => ({ vendas: 0, faturamento: 0, clientes: new Set(), pecas: 0, comissao: 0 });
  const total = vazio();
  const porRep = new Map<number, Acumulado>();
  const porTerr = new Map<number, { faturamento: number; pedidos: number }>();
  const porEqp = new Map<number, { faturamento: number; pedidos: number }>();

  for (const venda of vendas) {
    if (!STATUS_FATURADO.has(String(venda.status ?? ''))) continue;
    const dia = diaISO(venda.data);
    if (!dentro(dia)) continue;

    const lista = atribPorVenda.get(Number(venda.id));
    const atribuida = (lista ?? []).filter((a) => a.representante_id !== null);
    const participantes = atribuida.length
      ? atribuida
      : [{ representante_id: idOuNull(venda.representante_id), equipe_id: null, territorio_id: null, participacao_pct: 100 }];

    const casaFiltro = participantes.some((a) => {
      if (filtros.representante_id && idOuNull(a.representante_id) !== filtros.representante_id) return false;
      if (filtros.equipe_id && idOuNull(a.equipe_id) !== filtros.equipe_id) return false;
      if (filtros.territorio_id && idOuNull(a.territorio_id) !== filtros.territorio_id) return false;
      return true;
    });
    if (!casaFiltro) continue;

    const valor = numero(venda.total);
    const pecasVenda = (itensPorVenda.get(Number(venda.id)) ?? []).reduce((soma, i) => soma + numero(i.quantidade), 0);
    const comissaoVenda = numero(venda.comissao_valor);
    const clienteId = idOuNull(venda.cliente_id);

    total.vendas += 1;
    total.faturamento += valor;
    total.pecas += pecasVenda;
    total.comissao += comissaoVenda;
    if (clienteId) total.clientes.add(clienteId);

    for (const a of participantes) {
      const repId = idOuNull(a.representante_id);
      if (!repId) continue;
      const fatia = numero(a.participacao_pct) / 100;
      const acc = porRep.get(repId) ?? vazio();
      acc.vendas += 1;
      acc.faturamento += valor * fatia;
      acc.pecas += pecasVenda * fatia;
      acc.comissao += comissaoVenda * fatia;
      if (clienteId) acc.clientes.add(clienteId);
      porRep.set(repId, acc);

      const terrId = idOuNull(a.territorio_id);
      if (terrId) {
        const t = porTerr.get(terrId) ?? { faturamento: 0, pedidos: 0 };
        t.faturamento += valor * fatia;
        t.pedidos += 1;
        porTerr.set(terrId, t);
      }
      const eqpId = idOuNull(a.equipe_id);
      if (eqpId) {
        const e = porEqp.get(eqpId) ?? { faturamento: 0, pedidos: 0 };
        e.faturamento += valor * fatia;
        e.pedidos += 1;
        porEqp.set(eqpId, e);
      }
    }
  }

  // META do período: soma das metas ATIVAS que cobrem a janela e casam o filtro.
  const metrica = 'faturamento';
  const daJanela = metas.filter((m) => {
    if (String(m.status ?? '') !== 'ativa') return false;
    if (String(m.metrica) !== metrica) return false;
    if (filtros.representante_id && idOuNull(m.representante_id) !== filtros.representante_id) return false;
    if (filtros.equipe_id && idOuNull(m.equipe_id) !== filtros.equipe_id) return false;
    if (filtros.territorio_id && idOuNull(m.territorio_id) !== filtros.territorio_id) return false;
    const inicio = diaISO(m.periodo_inicio);
    const fim = diaISO(m.periodo_fim);
    if (!inicio || !fim) return false;
    return (!periodo.de || fim >= periodo.de) && (!periodo.ate || inicio <= periodo.ate);
  });
  const meta = daJanela.length ? daJanela.reduce((soma, m) => soma + numero(m.valor_meta), 0) : null;
  const realizado = meta === null ? null : total.faturamento;

  const linhas = [...porRep.entries()]
    .map(([id, acc]) => {
      const metaRep = daJanela
        .filter((m) => idOuNull(m.representante_id) === id && String(m.alvo_tipo) === 'representante')
        .reduce((soma, m) => soma + numero(m.valor_meta), 0);
      const metasRep = metaRep > 0 ? metaRep : null;
      return {
        representante_id: id,
        representante: repNome.get(id) ?? `#${id}`,
        vendas: acc.vendas,
        faturamento: arredondar(acc.faturamento),
        pedidos: acc.vendas,
        clientes: acc.clientes.size,
        pecas: arredondar(acc.pecas),
        ticket_medio: acc.vendas ? arredondar(acc.faturamento / acc.vendas) : 0,
        comissao: arredondar(acc.comissao),
        meta: metasRep,
        atingimento_pct: metasRep ? arredondar((acc.faturamento / metasRep) * 100) : null,
      };
    })
    .sort((a, b) => b.faturamento - a.faturamento);

  return {
    janela: { de: periodo.de, ate: periodo.ate },
    filtros: {
      representante_id: filtros.representante_id ?? null,
      equipe_id: filtros.equipe_id ?? null,
      territorio_id: filtros.territorio_id ?? null,
    },
    vendas: total.vendas,
    faturamento: arredondar(total.faturamento),
    pedidos: total.vendas,
    clientes: total.clientes.size,
    pecas: arredondar(total.pecas),
    ticket_medio: total.vendas ? arredondar(total.faturamento / total.vendas) : 0,
    comissao: arredondar(total.comissao),
    meta,
    realizado,
    variacao: meta === null || realizado === null ? null : arredondar(realizado - meta),
    atingimento_pct: meta === null || !meta ? null : arredondar((total.faturamento / meta) * 100),
    por_representante: linhas,
    por_territorio: [...porTerr.entries()].map(([id, t]) => ({
      territorio_id: id,
      territorio: terrNome.get(id) ?? `#${id}`,
      faturamento: arredondar(t.faturamento),
      pedidos: t.pedidos,
    })).sort((a, b) => b.faturamento - a.faturamento),
    por_equipe: [...porEqp.entries()].map(([id, e]) => ({
      equipe_id: id,
      equipe: eqpNome.get(id) ?? `#${id}`,
      faturamento: arredondar(e.faturamento),
      pedidos: e.pedidos,
    })).sort((a, b) => b.faturamento - a.faturamento),
  };
}

/**
 * ACOMPANHAMENTO DE UMA META: realizado DERIVADO (nunca coluna), variação e
 * % de atingimento. A distribuição mensal é PROPORCIONAL AOS DIAS do período
 * (documentada como estimativa de planejamento — o realizado é fato).
 */
export async function acompanharMeta(s: Store, metaId: number, escopo: EscopoEmpresa) {
  const marco = await lerDaEmpresa(s, 'metas', metaId, escopo);
  const inicio = diaISO(marco.periodo_inicio);
  const fim = diaISO(marco.periodo_fim);
  if (!inicio || !fim) throw new HttpError(400, 'Meta sem período definido.');

  const alvoTipo = String(marco.alvo_tipo);
  const filtros = {
    representante_id: alvoTipo === 'representante' ? idOuNull(marco.representante_id) : null,
    equipe_id: alvoTipo === 'equipe' ? idOuNull(marco.equipe_id) : null,
    territorio_id: alvoTipo === 'territorio' ? idOuNull(marco.territorio_id) : null,
  };
  const indicadores = await calcularIndicadores(s, escopo, filtros, { de: inicio, ate: fim });
  const metrica = String(marco.metrica);
  const realizado = metrica === 'faturamento' ? indicadores.faturamento
    : metrica === 'quantidade' ? indicadores.pecas
      : metrica === 'pedidos' ? indicadores.pedidos
        : metrica === 'clientes' ? indicadores.clientes
          // margem: derivada do faturamento das vendas (custo não entra na venda)
          : 0;
  const meta = metrica === 'quantidade' ? numero(marco.quantidade_meta) : numero(marco.valor_meta);

  const diasPeriodo = Math.max(1, Math.round((new Date(`${fim}T00:00:00Z`).getTime() - new Date(`${inicio}T00:00:00Z`).getTime()) / 86_400_000) + 1);
  const meses: { mes: string; dias: number; meta: number }[] = [];
  let cursor = new Date(`${inicio}T00:00:00Z`);
  while (cursor.toISOString().slice(0, 7) <= fim.slice(0, 7)) {
    const mes = cursor.toISOString().slice(0, 7);
    const primeiro = new Date(`${mes}-01T00:00:00Z`);
    const proximo = new Date(`${primeiro.toISOString().slice(0, 7)}-01T00:00:00Z`);
    proximo.setUTCMonth(proximo.getUTCMonth() + 1);
    const iniMes = primeiro.toISOString().slice(0, 10) < inicio ? inicio : primeiro.toISOString().slice(0, 10);
    const fimMes = new Date(proximo.getTime() - 86_400_000).toISOString().slice(0, 10) > fim ? fim : new Date(proximo.getTime() - 86_400_000).toISOString().slice(0, 10);
    const dias = Math.round((new Date(`${fimMes}T00:00:00Z`).getTime() - new Date(`${iniMes}T00:00:00Z`).getTime()) / 86_400_000) + 1;
    meses.push({ mes, dias, meta: String(marco.distribuicao) === 'unica' ? 0 : arredondar((meta * dias) / diasPeriodo) });
    cursor = new Date(`${proximo.toISOString().slice(0, 7)}-01T00:00:00Z`);
  }

  return {
    meta: marco,
    metrica,
    meta_valor: meta,
    realizado: arredondar(realizado),
    variacao: arredondar(realizado - meta),
    atingimento_pct: meta > 0 ? arredondar((realizado / meta) * 100) : null,
    falta: arredondar(Math.max(0, meta - realizado)),
    dias_periodo: diasPeriodo,
    distribuicao_mensal: meses,
    indicadores,
  };
}

// ============================================================================
// ENDPOINTS
// ============================================================================

function escopoDaRequisicao(req: Request): EscopoEmpresa {
  return escopoDoAtor(currentUser(req));
}

/** GET /api/comercial/indicadores?representante_id=&equipe_id=&territorio_id=&de=&ate= */
export async function apiIndicadores(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  const periodo = {
    de: req.query.de ? diaISO(req.query.de) : null,
    ate: req.query.ate ? diaISO(req.query.ate) : null,
  };
  const filtros = {
    representante_id: idOuNull(req.query.representante_id),
    equipe_id: idOuNull(req.query.equipe_id),
    territorio_id: idOuNull(req.query.territorio_id),
  };
  res.json(await calcularIndicadores(getStore(), escopoDaRequisicao(req), filtros, periodo));
}

/** GET /api/comercial/metas/:id/acompanhamento */
export async function apiAcompanhamentoMeta(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('metas')!, actor, 'read');
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Meta inválida.');
  res.json(await acompanharMeta(getStore(), id, escopoDaRequisicao(req)));
}

/** POST /api/comercial/vendas/:id/apurar-comissao */
export async function apiApurarComissao(req: Request, res: Response) {
  const actor = currentUser(req);
  // Apurar comissão é ato de GESTÃO: operador não movimenta valor financeiro.
  if (actor.perfil === 'operador') throw new HttpError(403, 'Apenas gerente ou administrador pode apurar comissão.');
  checkAccess(getResource('vendas')!, actor, 'update');
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Venda inválida.');
  const resultado = await apurarComissaoDaVenda(
    getStore(),
    id,
    { id: Number(actor.id) || 0, name: String(actor.name ?? '') },
    escopoDaRequisicao(req)
  );
  res.status(resultado.recalculada ? 200 : 201).json(resultado);
}

/** GET /api/comercial/territorios/arvore — hierarquia pronta para a tela. */
export async function apiArvoreTerritorios(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('territorios')!, actor, 'read');
  const escopo = escopoDaRequisicao(req);
  const s = getStore();
  const linhas = await listarTudo(s, 'territorios', escopo);
  const porPai = new Map<number, Row[]>();
  const raizes: Row[] = [];
  for (const t of linhas) {
    const pai = idOuNull(t.territorio_pai_id);
    if (pai) {
      const lista = porPai.get(pai);
      if (lista) lista.push(t);
      else porPai.set(pai, [t]);
    } else {
      raizes.push(t);
    }
  }
  const montar = (no: Row, profundidade: number): Row => ({
    id: Number(no.id),
    nome: no.nome,
    codigo: no.codigo,
    tipo: no.tipo,
    nivel: Number(no.nivel ?? 1),
    status: no.status,
    uf: no.uf,
    cidade: no.cidade,
    responsavel_id: no.responsavel_id,
    profundidade,
    filhos: (porPai.get(Number(no.id)) ?? []).map((filho) => montar(filho, profundidade + 1)),
  });
  res.json({ total: linhas.length, arvore: raizes.map((r) => montar(r, 1)) });
}

/** GET /api/comercial/representantes/:id/painel — carteira + equipe + hierarquia. */
export async function apiPainelRepresentante(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('representantes')!, actor, 'read');
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Representante inválido.');
  const escopo = escopoDaRequisicao(req);
  const s = getStore();
  await lerDaEmpresa(s, 'representantes', id, escopo);

  const [carteira, membros, hierarquia, indicadores] = await Promise.all([
    listarTudo(s, 'representante_cliente', escopo, { representante_id: id }),
    listarTudo(s, 'equipe_membros', escopo, { representante_id: id }),
    listarTudo(s, 'representante_hierarquia', escopo, {}),
    calcularIndicadores(s, escopo, { representante_id: id }, { de: null, ate: null }),
  ]);

  const hoje = hojeISO();
  res.json({
    representante_id: id,
    indicadores,
    carteira: {
      ativos: carteira.filter((c) => !diaISO(c.fim) && String(c.status ?? 'ativo') === 'ativo').length,
      total: carteira.length,
      clientes: carteira
        .filter((c) => String(c.status ?? 'ativo') !== 'cancelado')
        .map((c) => ({
          cliente_id: Number(c.cliente_id),
          territorio_id: c.territorio_id,
          inicio: diaISO(c.inicio),
          fim: diaISO(c.fim),
          status: c.status,
          participacao_pct: numero(c.participacao_pct),
          vigente: periodoCobre(diaISO(c.inicio), diaISO(c.fim), hoje) && String(c.status ?? 'ativo') === 'ativo',
        })),
    },
    equipes: membros.map((m) => ({
      equipe_id: Number(m.equipe_id),
      papel: m.papel,
      participacao_pct: numero(m.participacao_pct),
      entrada: diaISO(m.entrada),
      saida: diaISO(m.saida),
      status: m.status,
    })),
    hierarquia: {
      supervisores: hierarquia
        .filter((h) => idOuNull(h.subordinado_id) === id && String(h.status ?? 'ativo') === 'ativo' && !diaISO(h.fim))
        .map((h) => ({ supervisor_id: Number(h.supervisor_id), nivel: h.nivel })),
      subordinados: hierarquia
        .filter((h) => idOuNull(h.supervisor_id) === id && String(h.status ?? 'ativo') === 'ativo' && !diaISO(h.fim))
        .map((h) => ({ subordinado_id: Number(h.subordinado_id), nivel: h.nivel })),
    },
  });
}
