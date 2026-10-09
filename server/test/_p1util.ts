// ============================================================================
// Harness compartilhado dos testes da FASE P1.
//
// Não é um arquivo de teste (o runner pega só `*.test.ts`): são as peças que
// todos os testes P1 repetem — requisição/resposta falsas, fábrica de cadastros
// e asserções de status HTTP.
// ============================================================================
import { RESOURCES } from '../src/resources';
import { getStore } from '../src/services';

export type Ator = {
  id: number;
  name: string;
  perfil: 'admin' | 'gerente' | 'operador';
  empresa_id?: number;
  empresas?: number[];
  pode_consolidar?: boolean;
  consolidar?: boolean;
};

/**
 * O ADMIN dos testes é um usuário REAL no banco.
 *
 * Não é detalhe: `listas_preco_historico.usuario_id`, `propostas.criado_por` e
 * cia. são `type: 'ref'` para `usuarios`, e o store valida a referência. Com um
 * id que não existe, o teste estaria provando menos do que a produção exige.
 */
export const ADMIN: Ator = { id: 1, name: 'Admin Teste', perfil: 'admin', empresa_id: 1, empresas: [1] };

let adminPronto: Promise<void> | null = null;

export function garantirAdmin(): Promise<void> {
  if (!adminPronto) {
    adminPronto = (async () => {
      const s = getStore();
      const existe = await s.get(RESOURCES.usuarios, ADMIN.id);
      if (existe) return;
      await s.insert(RESOURCES.usuarios, {
        id: ADMIN.id,
        nome: ADMIN.name,
        email: 'admin-p1@brobond.test',
        perfil: 'admin',
        empresa_id: ADMIN.empresa_id,
        ativo: true,
      });
    })();
  }
  return adminPronto;
}

/**
 * Cria um usuário REAL e devolve o ator correspondente.
 *
 * O id vem do banco: o store em memória atribui a chave, então escolher o id à
 * mão criaria um ator apontando para um usuário que não existe — e os campos
 * `criado_por`/`usuario_id` (todos `type: 'ref'`) seriam recusados.
 */
let seqAtor = 0;
export async function criarAtor(empresaId: number, perfil: Ator['perfil'] = 'gerente'): Promise<Ator> {
  seqAtor++;
  const row = await getStore().insert(RESOURCES.usuarios, {
    nome: `Usuário E${empresaId} ${seqAtor}`,
    email: `e${empresaId}u${seqAtor}@brobond.test`,
    perfil,
    empresa_id: empresaId,
    ativo: true,
  });
  return {
    id: Number(row.id),
    name: String(row.nome),
    perfil,
    empresa_id: empresaId,
    empresas: [empresaId],
  };
}

export function reqDe(
  body: Record<string, unknown> = {},
  opts: { params?: Record<string, unknown>; query?: Record<string, unknown>; user?: Ator; headers?: Record<string, string> } = {}
): any {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers || {})) headers[k.toLowerCase()] = v;
  return {
    headers,
    // O Express expõe os dois: `req.headers` e `req.header(nome)`. Handler que
    // usa o segundo precisa encontrar o método aqui também.
    header: (nome: string) => headers[String(nome).toLowerCase()],
    get: (nome: string) => headers[String(nome).toLowerCase()],
    params: opts.params || {},
    query: opts.query || {},
    body,
    path: '',
    user: opts.user || ADMIN,
    socket: { remoteAddress: '203.0.113.10' },
  };
}

export function resFake(): { res: any; saida: { json?: any; status?: number } } {
  const saida: { json?: any; status?: number } = {};
  const res: any = {
    json: (d: any) => ((saida.json = d), res),
    status: (s: number) => ((saida.status = s), res),
    setHeader: () => res,
    end: () => res,
  };
  return { res, saida };
}

/** Executa o handler e devolve o corpo; lança se o status não for o esperado. */
export async function chamar(handler: (req: any, res: any) => Promise<void>, req: any, esperado = 200): Promise<any> {
  const { res, saida } = resFake();
  await handler(req, res);
  if (saida.status !== undefined && saida.status !== esperado) {
    throw new Error(`esperava HTTP ${esperado}, veio ${saida.status}: ${JSON.stringify(saida.json)}`);
  }
  return saida.json;
}

/** Espera que o handler lance HttpError com o status (e opcionalmente a mensagem). */
export async function esperarErro(fn: () => Promise<unknown>, status: number, re?: RegExp): Promise<any> {
  try {
    await fn();
  } catch (e: any) {
    const veio = e?.status ?? e?.statusCode;
    if (veio !== status) {
      throw new Error(`esperava HTTP ${status}, veio ${veio}: ${e?.message}`);
    }
    if (re && !re.test(String(e?.message || ''))) {
      throw new Error(`a mensagem "${e?.message}" não corresponde a ${re}`);
    }
    return e;
  }
  throw new Error(`esperava HTTP ${status}, mas a operação foi permitida`);
}

let seq = 0;

export async function novoProduto(dados: Record<string, unknown> = {}) {
  seq++;
  return getStore().insert(RESOURCES.produtos, {
    sku: String(dados.sku ?? `P1-SKU-${seq}`),
    nome: dados.nome ?? `Produto P1 ${seq}`,
    preco_venda: dados.preco_venda ?? 100,
    custo: dados.custo ?? 40,
    ativo: true,
    ...dados,
  });
}

export async function novoCliente(dados: Record<string, unknown> = {}) {
  seq++;
  return getStore().insert(RESOURCES.clientes, {
    nome: dados.nome ?? `Cliente P1 ${seq}`,
    tipo: 'pf',
    ativo: true,
    ...dados,
  });
}

export async function novoFornecedor(dados: Record<string, unknown> = {}) {
  seq++;
  return getStore().insert(RESOURCES.fornecedores, {
    nome: dados.nome ?? `Fornecedor P1 ${seq}`,
    ativo: true,
    ...dados,
  });
}

export async function novoTamanho(codigo: string) {
  const existente = await getStore().findOneWhere(RESOURCES.tamanhos, { codigo });
  if (existente) return existente;
  return getStore().insert(RESOURCES.tamanhos, { codigo, nome: codigo, ativo: true });
}

export async function novoLocal(nome: string, empresaId = 1, padrao = false) {
  const s = getStore();
  const existente = await s.findOneWhere(RESOURCES.locais, { nome, empresa_id: empresaId });
  if (existente) return existente;
  return s.insert(RESOURCES.locais, { codigo: nome.slice(0, 10).toUpperCase(), nome, tipo: 'loja', ativo: true, padrao, empresa_id: empresaId });
}

/**
 * Dá saldo inicial a um produto.
 *
 * O estoque deste ERP é (produto, TAMANHO, local) e `itens_venda.tamanho_id` é
 * obrigatório — sem um tamanho real, a linha entra no pedido e o faturamento
 * recusa por falta de saldo. Por isso a fábrica de saldo devolve o tamanho que
 * ela usou, e é esse tamanho que a linha da venda precisa resolver.
 */
export async function saldoInicial(produto: any, quantidade: number, opts: { codigoTamanho?: string; local?: string; custo?: number } = {}) {
  const tam = await novoTamanho(opts.codigoTamanho ?? 'U');
  const local = opts.local ?? 'loja';
  const empresaId = Number(produto.empresa_id ?? 1);
  const s = getStore();
  let localRow = await novoLocal(local, empresaId, true);
  if (await s.countWhere(RESOURCES.locais, { empresa_id: empresaId, padrao: true }) === 0 && localRow.padrao !== true) {
    localRow = (await s.update(RESOURCES.locais, Number(localRow.id), { padrao: true })) ?? localRow;
  }
  const existente = await s.findOneWhere(RESOURCES.estoques, {
    empresa_id: empresaId,
    produto_id: Number(produto.id),
    tamanho_id: Number(tam.id),
    local_id: Number(localRow.id),
  });
  if (existente && (Number(existente.local_id) !== Number(localRow.id) || String(existente.local) !== String(localRow.nome))) {
    throw new Error('Fixture de saldo encontrou vínculo canônico de local inconsistente.');
  }
  const row = existente
    ? await s.update(RESOURCES.estoques, Number(existente.id), { quantidade })
    : await s.insert(RESOURCES.estoques, {
        empresa_id: empresaId,
        produto_id: Number(produto.id),
        tamanho_id: Number(tam.id),
        local: String(localRow.nome),
        local_id: Number(localRow.id),
        quantidade,
        custo_medio: opts.custo ?? Number(produto.custo ?? 40),
      });
  return { estoque: row, tamanho: tam, local: String(localRow.nome), local_id: Number(localRow.id) };
}

export async function saldoDe(produtoId: number, tamanhoId: number | null, local: string): Promise<number> {
  const s = getStore();
  const produto = await s.findOneWhere(RESOURCES.produtos, { id: produtoId });
  if (!produto) return 0;
  const dono = Number(produto.empresa_id ?? 1);
  const localRow = await s.findOneWhere(RESOURCES.locais, { empresa_id: dono, nome: local });
  if (!localRow) return 0;
  const row = await s.findOneWhere(RESOURCES.estoques, {
    empresa_id: dono,
    produto_id: produtoId,
    tamanho_id: tamanhoId,
    local_id: Number(localRow.id),
  });
  return Number(row?.quantidade ?? 0);
}
