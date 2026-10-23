// ============================================================================
// IMPRESSÃO P2 + P3 + P4 + P5 + P6 — Suíte integrada completa:
//   • P2: Venda PDV idempotente, cupom ESC/POS não-bloqueante, reimpressão
//         auditada (reprint_of + motivo + RBAC allow_operator_reprint) e PDF/HTML.
//   • P3: Documentos ERP (vendas, compras, propostas, cotações-compra, ordens,
//         usuários) reconstruídos do banco + reimpressão + contingência PDF/HTML.
//   • P4: Etiquetas térmicas ZPL/EPL2, validação estrita GS1 (422 INVALID_EAN),
//         bloqueio de protocolo inválido e limites de lote (500 unidades).
//   • P5: Terminais multi-impressora, descoberta honesta, rotação/revogação/
//         reativação de agentes, filtros operacionais e resumo da fila.
//   • P6: Hardening XSS/CSP, command injection em printer_name, poison-pill
//         lease expirado, retenção periódica, isolamento multi-empresa e cadeia
//         de auditoria íntegra.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const {
  ADMIN,
  chamar,
  criarAtor,
  esperarErro,
  garantirAdmin,
  novoCliente,
  novoFornecedor,
  novoProduto,
  reqDe,
  saldoInicial,
} = await import('./_p1util');

const pdv = await import('../src/pdv');
const printJobs = await import('../src/printJobs');
const printAgents = await import('../src/printAgents');
const printTerminals = await import('../src/printTerminals');
const printLabels = await import('../src/printLabels');
const printDocs = await import('../src/printDocuments');
const printFallback = await import('../src/printFallback');
void printFallback;

await garantirAdmin();
const s = getStore();

function resBinFake() {
  const headers: Record<string, string> = {};
  let status = 200;
  let directBody: any = null;
  const streamChunks: Buffer[] = [];
  const pt = new PassThrough();
  pt.on('data', (c: Buffer) => streamChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));

  const res: any = Object.assign(pt, {
    status(c: number) {
      status = c;
      return res;
    },
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = String(v);
      return res;
    },
    json(d: any) {
      directBody = d;
      return res;
    },
    send(d: any) {
      directBody = d;
      return res;
    },
  });
  return {
    res,
    getStatus: () => status,
    headers,
    getBody: () => (directBody !== null ? directBody : Buffer.concat(streamChunks)),
  };
}

// ============================================================================
// P2 — PDV: Venda idempotente + Cupom ESC/POS + Reimpressão + Contingência
// ============================================================================

test('P2 PDV: venda persiste troco/recebido, enfileira recibo_pdv idempotente, suporta replay de venda e reimpressão auditada com RBAC', async () => {
  // Garante segunda empresa cadastrada para testes posteriores de isolamento
  if (!(await s.get(RESOURCES.empresas, 2))) {
    await s.insert(RESOURCES.empresas, { id: 2, nome: 'Empresa Rival', razao_social: 'Rival LTDA', ativo: true });
  }

  const operador = await criarAtor(1, 'operador');
  const gerente = await criarAtor(1, 'gerente');

  // Configura terminal CAIXA-P2 com impressora de recibo ESC/POS
  const termCreated = await chamar(
    printTerminals.criarTerminalHandler as any,
    reqDe(
      {
        codigo: 'CAIXA-P2',
        nome: 'Caixa Balcão P2',
        receipt_printer: 'Elgin_i9_Balcao',
        receipt_protocol: 'escpos',
        receipt_width_cols: 48,
        auto_print_pdv: true,
        allow_operator_reprint: true,
      },
      { user: gerente }
    ),
    201
  );
  assert.equal(termCreated.terminal.codigo, 'CAIXA-P2');

  // Produto com saldo no local padrão
  const prod = await novoProduto({ nome: 'Jaqueta Corta-Vento', preco_venda: 150, codigo_barras: '7891000100103' });
  const { tamanho, local } = await saldoInicial(prod, 10, { codigoTamanho: 'M' });

  // Gerente abre o caixa e operador realiza a venda (RBAC real do módulo PDV)
  const caixaOut = await chamar(
    pdv.abrirCaixa as any,
    reqDe({ numero: 'CAIXA-P2', local, valor_abertura: 100 }, { user: gerente }),
    201
  );
  const caixaId = Number(caixaOut.id);

  // Venda com R$ 200 em dinheiro para compra de R$ 150 (troco R$ 50)
  const saleIdemKey = `pdv-sale-${randomUUID()}`;
  const payloadVenda = {
    caixa_id: caixaId,
    idempotency_key: saleIdemKey,
    terminal: 'CAIXA-P2',
    itens: [{ produto_id: Number(prod.id), tamanho_id: Number(tamanho.id), quantidade: 1 }],
    pagamentos: [{ forma: 'dinheiro', valor: 200 }],
    faturar: true,
  };

  const v1 = await chamar(pdv.venderPdv as any, reqDe(payloadVenda, { user: operador }), 201);
  assert.equal(v1.calculo.total, 150);
  assert.equal(v1.calculo.total_pago, 200);
  assert.equal(v1.calculo.troco, 50);
  assert.equal(v1.cupom_impressao.enfileirado, true);
  assert.ok(v1.cupom_impressao.job_public_id, 'cupom deve gerar job na fila automaticamente');

  // Replay com a MESMA idempotency_key não duplica venda nem estoque!
  const vReplay = await chamar(pdv.venderPdv as any, reqDe(payloadVenda, { user: operador }), 200);
  assert.equal(vReplay.idempotente, true);
  assert.equal(vReplay.venda_id, v1.venda_id);
  assert.equal(vReplay.cupom_impressao.job_public_id, v1.cupom_impressao.job_public_id);

  // Gaveta líquida continua íntegra: abertura 100 + venda líquida 150 = 250 (e não 300!)
  const resumo = await chamar(pdv.resumoCaixaHandler as any, reqDe({}, { params: { id: String(caixaId) }, user: gerente }));
  assert.equal(resumo.esperado_em_dinheiro, 250);

  // Verifica que o PrintIR reconstruído do banco contém valor recebido (200) e troco (50)
  const detCupom = await chamar(
    printJobs.detalheJobHandler as any,
    reqDe({}, { params: { id: v1.cupom_impressao.job_public_id }, user: operador })
  );
  assert.equal(detCupom.job.doc_type, 'recibo_pdv');
  assert.equal(detCupom.job.printer_name, 'Elgin_i9_Balcao');
  assert.equal(detCupom.job.printer_protocol, 'escpos');
  const kvs = detCupom.print_ir.content.filter((b: any) => b.kind === 'kv');
  assert.ok(kvs.some((b: any) => /Troco/i.test(b.label) && b.value.includes('50,00')), 'PrintIR do banco deve exibir troco de R$ 50,00');

  // Reimpressão auditada pelo operador (permitida inicialmente)
  const reimp1 = await chamar(
    pdv.reimprimirCupomPdvHandler as any,
    reqDe(
      { motivo: 'Bobina enroscou no corte', terminal: 'CAIXA-P2', idempotency_key: `reimp-${randomUUID()}` },
      { params: { id: String(v1.venda_id) }, user: operador }
    ),
    201
  );
  assert.notEqual(reimp1.job.public_id, v1.cupom_impressao.job_public_id, 'reimpressão cria NOVO job');
  assert.equal(reimp1.reprint_of, v1.cupom_impressao.job_public_id, 'aponta para o cupom original via reprint_of');
  assert.equal(reimp1.job.reprint_reason, 'Bobina enroscou no corte');

  // Agora restringe allow_operator_reprint = false no terminal: operador recebe 403, gerente consegue!
  await chamar(
    printTerminals.atualizarTerminalHandler as any,
    reqDe({ allow_operator_reprint: false }, { params: { id: String(termCreated.terminal.id) }, user: gerente })
  );
  await esperarErro(
    () =>
      chamar(
        pdv.reimprimirCupomPdvHandler as any,
        reqDe({ terminal: 'CAIXA-P2' }, { params: { id: String(v1.venda_id) }, user: operador }),
        201
      ),
    403
  );
  const reimpGerente = await chamar(
    pdv.reimprimirCupomPdvHandler as any,
    reqDe({ terminal: 'CAIXA-P2', motivo: 'Autorizado pela gerência' }, { params: { id: String(v1.venda_id) }, user: gerente }),
    201
  );
  assert.equal(reimpGerente.reprint_of, v1.cupom_impressao.job_public_id);

  // Contingência HTML e PDF do cupom funcionam independentemente do agente local
  const htmlRes = resBinFake();
  await pdv.cupomPdvHtmlHandler(reqDe({}, { params: { id: String(v1.venda_id) }, user: operador }), htmlRes.res);
  assert.equal(htmlRes.getStatus(), 200);
  assert.ok(String(htmlRes.getBody()).includes('Jaqueta Corta-Vento'));
  assert.ok(String(htmlRes.headers['content-security-policy']).includes("default-src 'none'"));

  const pdfRes = resBinFake();
  await pdv.cupomPdvPdfHandler(reqDe({}, { params: { id: String(v1.venda_id) }, user: operador }), pdfRes.res);
  assert.equal(pdfRes.getStatus(), 200);
  assert.ok(Buffer.isBuffer(pdfRes.getBody()));
  assert.equal(pdfRes.getBody().subarray(0, 5).toString('ascii'), '%PDF-');
});

// ============================================================================
// P3 — Documentos ERP (6 tipos canônicos reconstruídos do banco)
// ============================================================================

test('P3 Documentos ERP: imprime, reimprime com auditoria e gera contingência HTML/PDF para vendas, compras, propostas, cotações, OPs e usuários', async () => {
  const cli = await novoCliente({ nome: 'Maria Compradora <script>alert(1)</script>' });
  const forn = await novoFornecedor({ nome: 'Têxtil Brasil LTDA' });
  const prod = await novoProduto({ nome: 'Camisa Linho', preco_venda: 220, custo: 80 });
  const { tamanho } = await saldoInicial(prod, 20, { codigoTamanho: 'G' });

  // 1. Venda (pedido)
  const venda = await s.insert(RESOURCES.vendas, {
    empresa_id: 1,
    cliente_id: Number(cli.id),
    data: '2026-10-23',
    status: 'orcamento',
    subtotal_itens: 440,
    total: 440,
  });
  await s.insert(RESOURCES.itens_venda, {
    empresa_id: 1,
    venda_id: Number(venda.id),
    produto_id: Number(prod.id),
    tamanho_id: Number(tamanho.id),
    quantidade: 2,
    preco_unitario: 220,
  });

  // 2. Compra
  const compra = await s.insert(RESOURCES.compras, {
    empresa_id: 1,
    fornecedor_id: Number(forn.id),
    data: '2026-10-23',
    status: 'aberta',
    total: 800,
  });

  // 3. Proposta comercial
  const proposta = await s.insert(RESOURCES.propostas, {
    empresa_id: 1,
    numero: `PROP-${Date.now()}`,
    cliente_id: Number(cli.id),
    status: 'enviada',
    valor_total: 1100,
    criado_por: ADMIN.id,
  });

  // 4. Cotação de compra
  const cotacao = await s.insert(RESOURCES.cotacoes_compra, {
    empresa_id: 1,
    titulo: 'Cotação Tecidos Verão',
    criterio: 'menor_preco',
    status: 'aberta',
  });

  // 5. Ordem de produção
  const op = await s.insert(RESOURCES.ordens, {
    empresa_id: 1,
    codigo: `OP-${Date.now()}`,
    produto_id: Number(prod.id),
    quantidade: 50,
    status: 'planejada',
  });

  const casos: Array<{ tipo: string; id: number; docTypeEsperado: string }> = [
    { tipo: 'vendas', id: Number(venda.id), docTypeEsperado: 'pedido' },
    { tipo: 'compras', id: Number(compra.id), docTypeEsperado: 'compra' },
    { tipo: 'propostas', id: Number(proposta.id), docTypeEsperado: 'orcamento' },
    { tipo: 'cotacoes-compra', id: Number(cotacao.id), docTypeEsperado: 'orcamento' },
    { tipo: 'ordens', id: Number(op.id), docTypeEsperado: 'ordem_producao' },
    { tipo: 'usuarios', id: ADMIN.id, docTypeEsperado: 'ficha_usuario' },
  ];

  for (const c of casos) {
    const imp = await chamar(
      printDocs.imprimirDocumentoHandler as any,
      reqDe({ copies: 2, idempotency_key: `doc-${c.tipo}-${c.id}-${randomUUID()}` }, { params: { tipo: c.tipo, id: String(c.id) } }),
      201
    );
    assert.equal(imp.job.doc_type, c.docTypeEsperado);
    assert.equal(imp.job.copies, 2);

    // Reimpressão vinculada ao job anterior
    const reimp = await chamar(
      printDocs.reimprimirDocumentoHandler as any,
      reqDe(
        { copies: 1, motivo: 'Via extra arquivo', idempotency_key: `reimp-doc-${c.tipo}-${randomUUID()}` },
        { params: { tipo: c.tipo, id: String(c.id) } }
      ),
      201
    );
    assert.equal(reimp.job.reprint_of, imp.job.public_id);

    // Contingência HTML escapa XSS (<script>alert(1)</script>)
    const h = resBinFake();
    await printDocs.fallbackDocumentoHtmlHandler(reqDe({}, { params: { tipo: c.tipo, id: String(c.id) } }), h.res);
    assert.equal(h.getStatus(), 200);
    const htmlStr = String(h.getBody());
    assert.ok(!htmlStr.includes('<script>alert(1)</script>'), `HTML de ${c.tipo} deve escapar tags <script>`);

    // Contingência PDF válida
    const p = resBinFake();
    await printDocs.fallbackDocumentoPdfHandler(reqDe({}, { params: { tipo: c.tipo, id: String(c.id) } }), p.res);
    assert.equal(p.getStatus(), 200);
    assert.equal(p.getBody().subarray(0, 5).toString('ascii'), '%PDF-');
  }
});

// ============================================================================
// P4 — Etiquetas de Produto (ZPL / EPL2 / Validação GS1 / Limites de Lote)
// ============================================================================

test('P4 Etiquetas: gera ZPL/EPL2 válido, recusa EAN com dígito inválido (422 INVALID_EAN), bloqueia protocolo errado e limita lote', async () => {
  const prodValido = await novoProduto({
    sku: 'CAM-PRETA-01',
    nome: 'Camiseta Preta Básica',
    preco_venda: 79.9,
    codigo_barras: '7894900011517', // EAN-13 válido distinto
  });
  const { tamanho } = await saldoInicial(prodValido, 30, { codigoTamanho: 'P' });

  // 1. Lote ZPL válido
  const outZpl = await chamar(
    printLabels.imprimirEtiquetasHandler as any,
    reqDe({
      protocol: 'zpl',
      itens: [{ produto_id: Number(prodValido.id), tamanho_id: Number(tamanho.id), quantidade: 12 }],
      idempotency_key: `lbl-zpl-${randomUUID()}`,
    }),
    201
  );
  assert.equal(outZpl.protocol, 'zpl');
  assert.equal(outZpl.total_etiquetas, 12);
  assert.equal(outZpl.job.doc_type, 'etiqueta_produto');

  // 2. Lote EPL2 válido via atalho /api/produtos/:id/etiquetas com SKU Code128
  const prodSemEan = await novoProduto({
    sku: 'SKU-INTERNO-77',
    nome: 'Boné BroBond',
    preco_venda: 59.9,
    codigo_barras: null,
  });
  const outEpl = await chamar(
    printLabels.imprimirEtiquetasProdutoHandler as any,
    reqDe(
      { protocol: 'epl2', quantidade: 5, idempotency_key: `lbl-epl-${randomUUID()}` },
      { params: { id: String(prodSemEan.id) } }
    ),
    201
  );
  assert.equal(outEpl.protocol, 'epl2');
  assert.equal(outEpl.total_etiquetas, 5);

  // 3. Produto com EAN-13 de dígito verificador FALSO no banco -> 422 INVALID_EAN (jamais falsifica!)
  const prodEanRuim = await novoProduto({
    sku: 'EAN-CORROMPIDO',
    nome: 'Produto EAN Errado',
    preco_venda: 49.9,
    codigo_barras: '7891000100109', // dígito correto seria 3, não 9
  });
  await esperarErro(
    () =>
      chamar(
        printLabels.imprimirEtiquetasHandler as any,
        reqDe({
          protocol: 'zpl',
          itens: [{ produto_id: Number(prodEanRuim.id), quantidade: 1 }],
        }),
        201
      ),
    422,
    /dígito verificador/i
  );

  // 4. Protocolo não térmico (ex.: escpos para etiqueta) -> erro explícito 400 (nunca imprime errado!)
  await esperarErro(
    () =>
      chamar(
        printLabels.imprimirEtiquetasHandler as any,
        reqDe({
          protocol: 'escpos',
          itens: [{ produto_id: Number(prodValido.id), quantidade: 1 }],
        }),
        201
      ),
    400
  );

  // 5. Lote acima do teto de segurança (> 500 etiquetas totais) -> 400
  await esperarErro(
    () =>
      chamar(
        printLabels.imprimirEtiquetasHandler as any,
        reqDe({
          protocol: 'zpl',
          itens: [
            { produto_id: Number(prodValido.id), quantidade: 200 },
            { produto_id: Number(prodSemEan.id), quantidade: 200 },
            { produto_id: Number(prodValido.id), tamanho_id: Number(tamanho.id), quantidade: 150 },
          ],
        }),
        201
      ),
    400,
    /500/
  );
});

// ============================================================================
// P5 & P6 — Agentes, Terminais, Poison-Pill, Multi-Empresa e Segurança
// ============================================================================

test('P5/P6 Operação & Hardening: ciclo completo de agentes sem vazar hash/token, poison-pill lease, isolamento multi-empresa e auditoria íntegra', async () => {
  const adminEmp2 = await criarAtor(2, 'admin');

  // 1. Pareamento + Heartbeat com sanitização de impressoras + Rotação + Revogação + Reativação
  const pairCode = await chamar(printAgents.criarCodigoPareamentoHandler as any, reqDe({ terminal: 'EXPEDICAO-1' }), 201);
  const paired = await chamar(
    printAgents.parearAgenteHandler as any,
    reqDe({ codigo: pairCode.codigo, nome: 'PC Expedição', agent_version: '0.2.0', platform: 'win32' }),
    201
  );
  const agRow: any = await s.findOneWhere(RESOURCES.print_agents, { machine_id: paired.machine_id });

  // Heartbeat com lista de impressoras contendo entrada maliciosa (que deve ser descartada!)
  const hbReq = reqDe({
    agent_version: '0.2.0',
    platform: 'win32',
    printers: ['Zebra_ZD220', 'Elgin_L42', 'Maliciosa; rm -rf /', ''],
  });
  (hbReq as any).printAgent = agRow;
  await chamar(printAgents.heartbeatHandler as any, hbReq);

  const detectadas = await chamar(printAgents.listarImpressorasDetectadasHandler as any, reqDe({}));
  assert.ok(detectadas.impressoras.includes('Zebra_ZD220'));
  assert.ok(!detectadas.impressoras.some((p: string) => p.includes('rm -rf')), 'impressora com metacaracteres nunca entra na descoberta');

  // Listagem administrativa NUNCA expõe token_hash nem token completo
  const listaAg = await chamar(printAgents.listarAgentesHandler as any, reqDe({}));
  const meuAg = listaAg.rows.find((a: any) => a.machine_id === paired.machine_id);
  assert.ok(meuAg);
  assert.equal(meuAg.online, true);
  assert.equal(meuAg.token_hash, undefined, 'token_hash jamais pode sair na API');
  assert.equal(meuAg.token, undefined, 'token completo jamais sai na listagem');

  // Revogar e reativar emite novo token e invalida o anterior
  await chamar(printAgents.revogarAgenteHandler as any, reqDe({}, { params: { id: paired.machine_id } }));
  const reativado = await chamar(printAgents.reativarAgenteHandler as any, reqDe({}, { params: { id: paired.machine_id } }));
  assert.ok(String(reativado.token).startsWith('bpa_'));
  assert.notEqual(reativado.token, paired.token);
  assert.equal(reativado.agente.status, 'ativo');

  // 2. Isolamento multi-empresa: admin da Empresa 2 NÃO vê nem opera agente/terminal/job da Empresa 1
  await esperarErro(
    () => chamar(printAgents.revogarAgenteHandler as any, reqDe({}, { params: { id: paired.machine_id }, user: adminEmp2 })),
    404
  );
  const jobsEmp2 = await chamar(printJobs.listarJobsHandler as any, reqDe({}, { user: adminEmp2 }));
  assert.equal(jobsEmp2.rows.length, 0, 'Empresa 2 não enxerga nenhum job da Empresa 1');

  // 3. Bloqueio de printer_name malicioso na criação de job e de terminal
  await esperarErro(
    () =>
      chamar(
        printJobs.criarJobHandler as any,
        reqDe({
          doc_type: 'teste',
          source: 'sistema',
          printer_name: 'Zebra; calc.exe',
          content: [{ kind: 'text', text: 'x' }],
          idempotency_key: `bad-printer-${randomUUID()}`,
        }),
        201
      ),
    400
  );

  // 4. Poison-pill recovery: job CLAIMED cujo lease expirou já tendo atingido max_attempts
  //    vira FAILED permanente (LEASE_EXPIRED_MAX_ATTEMPTS) em vez de entrar em loop infinito!
  const jobOrfaoOut = await printJobs.enfileirarJob(1, { usuario_id: ADMIN.id, usuario: ADMIN.name }, {
    docType: 'teste',
    source: 'sistema',
    sourceRef: null,
    terminal: 'ORFAO-TERM',
    printerName: null,
    copies: 1,
    priority: 0,
    content: [{ kind: 'text', text: 'Teste orfao' }],
    metadata: {},
    idempotencyKey: `orfao-${randomUUID()}`,
    maxAttempts: 2,
  });
  await s.update(RESOURCES.print_jobs, Number(jobOrfaoOut.job.id), {
    status: 'PRINTING',
    attempts: 2,
    max_attempts: 2,
    lease_expires_at: new Date(Date.now() - 120_000).toISOString(),
  });

  const rec = await printJobs.recuperarJobsOrfaos(1);
  assert.ok(rec.falhados >= 1, 'job órfão com tentativas esgotadas deve encerrar como FAILED permanente');
  const jobApos = await s.get(RESOURCES.print_jobs, Number(jobOrfaoOut.job.id));
  assert.equal(jobApos?.status, 'FAILED');
  assert.equal(jobApos?.last_error_code, 'LEASE_EXPIRED_MAX_ATTEMPTS');
  assert.equal(jobApos?.permanent_error, true);

  // 5. Resumo operacional + Limpeza periódica + Integridade da cadeia de auditoria
  const resumoOp = await chamar(printJobs.resumoOperacionalImpressaoHandler as any, reqDe({}));
  assert.equal(typeof resumoOp.fila.queued, 'number');
  assert.equal(typeof resumoOp.agentes.ativos, 'number');

  await printJobs.limparFilaImpressaoPeriodica();

  const integridade = await s.verificarAuditoria();
  assert.equal(integridade.ok, true, `cadeia criptográfica de auditoria deve permanecer 100% íntegra (${integridade.total} eventos)`);
});
