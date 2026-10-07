// ============================================================================
// FISCAL contra Postgres REAL.
//
// A suíte em memória prova as regras do aplicativo. Esta prova as garantias
// que sobrevivem ao aplicativo — as que continuam de pé se alguém abrir o
// psql e tentar na mão:
//
//   • `autorizado` sem chave/protocolo é IMPOSSÍVEL (CHECK do banco);
//   • chave de acesso é única no universo e aqui também;
//   • a mesma numeração não se repete na empresa/modelo/série/ambiente;
//   • `idempotency_key` é única por empresa — não existem dois documentos
//     para a mesma requisição;
//   • uma venda não tem dois documentos vivos do mesmo modelo;
//   • a justificativa de inutilização tem o mínimo exigido pela SEFAZ;
//   • o fluxo completo de emissão autorizada baixa estoque UMA vez.
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';
process.env.SEGREDOS_ENCRYPTION_KEY = 'chave-pg-fiscal';

const sufixo = Date.now().toString(36).toUpperCase();
/** Chave de 44 DÍGITOS, distinta por execução (o banco exige ^[0-9]{44}$). */
const semente = String(Date.now()).slice(-9);
const chaveDe = (n: number) => `3526${semente}${String(n).padStart(31, '0')}`.slice(0, 44);

/**
 * CNPJ válido e diferente a cada execução.
 * O cadastro recusa dígito verificador errado (e o índice único de CNPJ por
 * empresa recusaria o repetido), então o teste não pode usar constante.
 */
function cnpjValidoAleatorio(): string {
  const base = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10));
  const dv = (nums: number[]) => {
    const pesos = nums.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = nums.reduce((acc, n, i) => acc + n * pesos[i], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = dv(base);
  const d2 = dv([...base, d1]);
  return [...base, d1, d2].join('');
}

test('FISCAL em Postgres real: a nota fantasma é impossível', { skip }, async (t) => {
  const { query, migrate } = await import('../src/db');
  await migrate();

  const { RESOURCES } = await import('../src/resources');
  const { createRecord, getStore } = await import('../src/services');
  const { registrarFiscalProvider } = await import('../src/fiscalProvider');
  const { cifrarSegredo, decifrarSegredo } = await import('../src/segredos');

  const admin = { id: 1, name: 'Admin fiscal', perfil: 'admin' as const };
  const emp = await createRecord(
    RESOURCES.empresas,
    {
      nome: `PG FISCAL ${sufixo}`,
      razao_social: `PG FISCAL ${sufixo} LTDA`,
      cnpj: cnpjValidoAleatorio(),
      ie: '1234567890',
      crt: '3',
      cep: '01001000',
      logradouro: 'Praça da Sé',
      numero: '1',
      bairro: 'Sé',
      cidade: 'São Paulo',
      codigo_municipio: '3550308',
      uf: 'SP',
    },
    admin
  );
  const EMPRESA = Number(emp.id);

  await t.test('o banco recusa `autorizado` sem chave e protocolo', async () => {
    await assert.rejects(
      () =>
        query(
          `INSERT INTO documentos_fiscais (empresa_id, modelo, status, provider) VALUES ($1, '55', 'autorizado', 'focus')`,
          [EMPRESA]
        ),
      (e: any) => {
        assert.equal(e.code, '23514', 'violação de CHECK');
        assert.match(String(e.constraint || ''), /autorizado_tem_prova/);
        return true;
      }
    );

    // Com provedor 'nenhum' também não passa, mesmo trazendo chave e protocolo.
    await assert.rejects(
      () =>
        query(
          `INSERT INTO documentos_fiscais (empresa_id, modelo, status, provider, chave_acesso, protocolo, numero, serie)
           VALUES ($1, '55', 'autorizado', 'nenhum', $2, '123', 1, 1)`,
          [EMPRESA, chaveDe(1)]
        ),
      (e: any) => e.code === '23514'
    );
  });

  await t.test('chave de acesso com formato inválido é recusada', async () => {
    await assert.rejects(
      () =>
        query(
          `INSERT INTO documentos_fiscais (empresa_id, modelo, status, provider, chave_acesso) VALUES ($1, '55', 'pendente', 'focus', '123')`,
          [EMPRESA]
        ),
      (e: any) => e.code === '23514' && /chave_formato/.test(String(e.constraint || ''))
    );
  });

  await t.test('chave de acesso é única', async () => {
    const chave = chaveDe(2);
    await query(
      `INSERT INTO documentos_fiscais (empresa_id, modelo, status, provider, chave_acesso, protocolo, numero, serie, ambiente)
       VALUES ($1, '55', 'autorizado', 'focus', $2, 'P1', 9001, 9, 'homologacao')`,
      [EMPRESA, chave]
    );
    await assert.rejects(
      () =>
        query(
          `INSERT INTO documentos_fiscais (empresa_id, modelo, status, provider, chave_acesso, protocolo, numero, serie, ambiente)
           VALUES ($1, '55', 'autorizado', 'focus', $2, 'P2', 9002, 9, 'homologacao')`,
          [EMPRESA, chave]
        ),
      (e: any) => e.code === '23505'
    );
  });

  await t.test('a mesma numeração não se repete na série', async () => {
    await assert.rejects(
      () =>
        query(
          `INSERT INTO documentos_fiscais (empresa_id, modelo, status, provider, numero, serie, ambiente)
           VALUES ($1, '55', 'pendente', 'focus', 9001, 9, 'homologacao')`,
          [EMPRESA]
        ),
      (e: any) => e.code === '23505'
    );
  });

  await t.test('idempotency_key é única por empresa', async () => {
    const chave = `idem-${sufixo}`;
    await query(`INSERT INTO documentos_fiscais (empresa_id, modelo, status, idempotency_key) VALUES ($1, '55', 'rascunho', $2)`, [EMPRESA, chave]);
    await assert.rejects(
      () => query(`INSERT INTO documentos_fiscais (empresa_id, modelo, status, idempotency_key) VALUES ($1, '55', 'rascunho', $2)`, [EMPRESA, chave]),
      (e: any) => e.code === '23505'
    );
  });

  await t.test('a justificativa de inutilização tem mínimo de 15 caracteres', async () => {
    await assert.rejects(
      () =>
        query(
          `INSERT INTO inutilizacoes_fiscais (empresa_id, modelo, serie, numero_inicial, numero_final, justificativa)
           VALUES ($1, '55', 1, 10, 20, 'curta')`,
          [EMPRESA]
        ),
      (e: any) => e.code === '23514'
    );
    await query(
      `INSERT INTO inutilizacoes_fiscais (empresa_id, modelo, serie, numero_inicial, numero_final, justificativa)
       VALUES ($1, '55', 1, 10, 20, 'Numeracao pulada por falha de energia no servidor')`,
      [EMPRESA]
    );
  });

  await t.test('o token do provedor fica cifrado na coluna', async () => {
    const s = getStore();
    // A configuração é criada sob demanda pela própria camada fiscal — e nasce
    // DESABILITADA, que é a regra: nenhuma empresa emite por acidente.
    const { obterConfigFiscalDaEmpresa } = await import('../src/fiscal');
    const cfg = await obterConfigFiscalDaEmpresa(EMPRESA);
    assert.ok(cfg);
    assert.equal(cfg.habilitado, false, 'nasce DESABILITADA');
    assert.equal(cfg.provider, 'nenhum');

    await s.update(RESOURCES.empresa_fiscal_config, Number(cfg.id), {
      provider: 'pgprovider',
      provider_token_cifrado: cifrarSegredo('token-pg-secreto'),
      habilitado: true,
    });
    const { rows } = await query<{ provider_token_cifrado: string }>(
      `SELECT provider_token_cifrado FROM empresa_fiscal_config WHERE empresa_id = $1`,
      [EMPRESA]
    );
    assert.ok(!rows[0].provider_token_cifrado.includes('token-pg-secreto'), 'nada de texto puro no banco');
    assert.equal(decifrarSegredo(rows[0].provider_token_cifrado), 'token-pg-secreto');
  });

  // --------------------------------------------------------------------------
  // Fluxo completo sobre Postgres: emitir → autorizar → faturar → baixar
  // --------------------------------------------------------------------------
  await t.test('emissão autorizada: estoque baixa uma vez e a repetição é idempotente', async () => {
    const s = getStore();
    const ator = { id: 0, name: 'Operador fiscal', perfil: 'gerente' as const, empresa_id: EMPRESA, empresas: [EMPRESA] };

    const cliente = await createRecord(
      RESOURCES.clientes,
      {
        nome: `Cliente PG ${sufixo}`,
        pessoa: 'pj',
        cnpj_cpf: '19131243000197',
        indicador_ie: '1',
        rg_ie: '111222333',
        cep: '20040002',
        logradouro: 'Av. Rio Branco',
        numero: '100',
        bairro: 'Centro',
        cidade: 'Rio de Janeiro',
        codigo_municipio: '3304557',
        uf: 'RJ',
      },
      ator
    );

    const produto = await createRecord(
      RESOURCES.produtos,
      {
        sku: `PGFISC-${sufixo}`,
        nome: 'Camiseta PG',
        ncm: '61091000',
        origem: '0',
        cfop_saida: '6102',
        icms_cst: '00',
        icms_aliquota: 12,
        pis_cst: '01',
        pis_aliquota: 1.65,
        cofins_cst: '01',
        cofins_aliquota: 7.6,
        preco_venda: 100,
        unidade: 'un',
      },
      ator
    );

    const tamanho =
      (await s.list(RESOURCES.tamanhos, { page: 1, pageSize: 1 })).rows[0] ??
      (await createRecord(RESOURCES.tamanhos, { codigo: 'M', ordem: 1 }, ator));
    const LOCAL = 'loja';
    await s.adjustStock(Number(produto.id), Number(tamanho.id), LOCAL, 30);

    const venda = await createRecord(
      RESOURCES.vendas,
      { cliente_id: Number(cliente.id), status: 'aberta', data: new Date().toISOString().slice(0, 10), local_saida: LOCAL },
      ator
    );
    await createRecord(
      RESOURCES.itens_venda,
      { venda_id: Number(venda.id), produto_id: Number(produto.id), tamanho_id: Number(tamanho.id), quantidade: 3, preco_unitario: 100, subtotal: 300 },
      ator
    );
    // O total do cabeçalho é recalculado pelo endpoint de itens; aqui os itens
    // entram pelo serviço, então o total é fixado explicitamente.
    await s.update(RESOURCES.vendas, Number(venda.id), { total: 300 });

    const chave = chaveDe(7);
    registrarFiscalProvider({
      nome: 'pgprovider',
      configurado: () => true,
      emitir: async () => ({
        status: 'autorizado',
        mensagem: 'Autorizado o uso da NF-e',
        chave_acesso: chave,
        protocolo: `PROTO-${sufixo}`,
        xml: '<nfeProc/>',
      }),
      consultar: async () => ({ status: 'autorizado', mensagem: 'ok', chave_acesso: chave, protocolo: `PROTO-${sufixo}` }),
      cancelar: async () => ({ status: 'cancelado', mensagem: 'cancelado' }),
      inutilizar: async () => ({ status: 'inutilizado', mensagem: 'inutilizado' }),
    } as any);

    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { emitirDocumento } = await import('../src/fiscal');
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.user = { ...ator, id: null, pode_consolidar: false };
      next();
    });
    app.post('/emitir/:id', (req: any, res: any, next: any) => Promise.resolve(emitirDocumento(req, res)).catch(next));
    app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).json({ error: err.message }));

    const idem = `pg-${sufixo}`;
    const resp = await request(app).post(`/emitir/${venda.id}`).set('idempotency-key', idem).send({ modelo: '55' });
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    assert.equal(resp.body.emitido, true);
    assert.equal(resp.body.chave_acesso, chave);

    const saldo = async () =>
      Number(
        (await s.findOneWhere(RESOURCES.estoques, { produto_id: Number(produto.id), tamanho_id: Number(tamanho.id), local: LOCAL }))
          ?.quantidade ?? 0
      );
    assert.equal(await saldo(), 27, '30 − 3 peças');

    const vendaDepois = await s.get(RESOURCES.vendas, Number(venda.id));
    assert.equal(String(vendaDepois!.status), 'faturada');
    assert.equal(vendaDepois!.nfe_chave, chave);

    // Idempotência no banco de verdade: mesma chave, mesmo documento.
    const repetida = await request(app).post(`/emitir/${venda.id}`).set('idempotency-key', idem).send({ modelo: '55' });
    assert.equal(Number(repetida.body.documento_id), Number(resp.body.documento_id));
    assert.equal(await saldo(), 27, 'a repetição não baixa estoque de novo');

    // Histórico do documento gravado.
    const { rows: eventos } = await query<{ para_status: string }>(
      `SELECT para_status FROM documentos_fiscais_eventos WHERE documento_id = $1 ORDER BY id`,
      [Number(resp.body.documento_id)]
    );
    assert.deepEqual(
      eventos.map((e) => e.para_status),
      ['processando', 'autorizado']
    );

    // A venda não aceita um segundo documento vivo do mesmo modelo.
    await assert.rejects(
      () =>
        query(
          `INSERT INTO documentos_fiscais (empresa_id, venda_id, modelo, status, provider) VALUES ($1, $2, '55', 'pendente', 'focus')`,
          [EMPRESA, Number(venda.id)]
        ),
      (e: any) => e.code === '23505'
    );

    // E o contas a receber nasceu junto com o faturamento.
    const { rows: lanc } = await query<{ total: string }>(
      `SELECT COUNT(*)::int AS total FROM lancamentos_financeiros WHERE referencia_tipo = 'venda' AND referencia_id = $1`,
      [Number(venda.id)]
    );
    assert.ok(Number(lanc[0].total) > 0, 'financeiro lançado na autorização');
  });
});
