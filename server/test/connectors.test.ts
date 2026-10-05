// ============================================================
// Testes do módulo de conectores de marketplace (Fase 2):
//   • registro estrito dos 4 provedores (Nuvemshop não existe mais)
//   • criptografia AES-256-GCM dos tokens em repouso
//   • assinaturas de webhook (Mercado Pago, Shopee, TikTok)
//   • upsert IDEMPOTENTE de venda com banco de dados fingido
//   • casamento de item com produtos/tamanhos do ERP
// Modo memória: o módulo só fala SQL por uma porta injetável, então
// aqui injetamos um executor de consultas de mentira.
// ============================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.CONNECTOR_ENCRYPTION_KEY = 'a'.repeat(64);

const {
  CONNECTOR_PROVIDERS,
  parseConnectorProvider,
  isConnectorProviderName,
  saleChannelFromConnectorProvider,
  encryptConnectorSecret,
  decryptConnectorSecret,
  maskConnectorSecretPreview,
  getConnector,
  getConnectorFromInput,
  listConnectors,
  REGISTERED_CONNECTOR_COUNT,
  createSalesService,
  marketplaceSaleReference,
  normalizeSaleCurrency,
  matchCatalogItem,
  isSaleIngestionEvent,
  connectorWebhookPath,
} = await import('../../modules/connectors/index');

const { verifyShopeeWebhookSignature } = await import('../../modules/connectors/shopee/shopee.service');
const { buildTikTokAuthorizationUrl, verifyTikTokWebhookSignature } = await import('../../modules/connectors/tiktok/tiktok.service');
const { verifyMercadoPagoWebhookSignature } = await import('../../modules/connectors/mercadopago/mercadopago.service');

// ------------------------------------------------------------
// Banco de mentira: guarda as consultas e devolve o que mandarmos.
// ------------------------------------------------------------
function fakeDb(responder: (sql: string, params: readonly unknown[]) => any[]) {
  const log: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db: any = {
    log,
    async query(sql: string, params: readonly unknown[] = []) {
      log.push({ sql, params });
      const rows = responder(sql, params) ?? [];
      return { rows, rowCount: rows.length };
    },
  };
  return db;
}

describe('Conectores — registro de provedores', () => {
  test('conhece exatamente os quatro canais suportados', () => {
    assert.deepEqual([...CONNECTOR_PROVIDERS].sort(), ['MERCADOLIVRE', 'MERCADOPAGO', 'SHOPEE', 'TIKTOK']);
    assert.equal(REGISTERED_CONNECTOR_COUNT, 4);
    assert.equal(listConnectors().length, 4);
  });

  test('a Nuvemshop foi removida e não resolve em lugar nenhum', () => {
    assert.equal(parseConnectorProvider('nuvemshop'), null);
    assert.equal(isConnectorProviderName('NUVEMSHOP'), false);
    assert.equal(getConnectorFromInput('nuvemshop'), null);
  });

  test('aceita apelidos de URL e rejeita lixo', () => {
    assert.equal(parseConnectorProvider('mercado-livre'), 'MERCADOLIVRE');
    assert.equal(parseConnectorProvider('TikTok'), 'TIKTOK');
    assert.equal(parseConnectorProvider('shopee'), 'SHOPEE');
    assert.equal(parseConnectorProvider(''), null);
    assert.equal(parseConnectorProvider(42), null);
  });

  test('cada provedor tem adaptador estável e canal de venda próprio', () => {
    for (const provider of CONNECTOR_PROVIDERS) {
      const connector = getConnector(provider);
      assert.equal(connector.provider, provider);
      assert.equal(getConnector(provider), connector); // singleton por provedor
      assert.equal(typeof connector.fetchCatalog, 'function');
      assert.ok(saleChannelFromConnectorProvider(provider));
    }
    assert.equal(saleChannelFromConnectorProvider('SHOPEE'), 'SHOPEE');
  });

  test('o caminho público do webhook é derivado do slug', () => {
    assert.equal(connectorWebhookPath('mercadolivre'), '/api/webhooks/mercadolivre');
  });
});

describe('Conectores — tokens cifrados em repouso', () => {
  test('ida e volta AES-256-GCM preserva o segredo', () => {
    const segredo = 'APP_USR-1234567890-abcdef';
    const cifrado = encryptConnectorSecret(segredo);
    assert.notEqual(cifrado, segredo);
    assert.match(cifrado as string, /^v1\./);
    assert.equal(decryptConnectorSecret(cifrado), segredo);
  });

  test('duas cifragens do mesmo segredo diferem (IV aleatório)', () => {
    assert.notEqual(encryptConnectorSecret('igual'), encryptConnectorSecret('igual'));
  });

  test('texto cifrado adulterado não decifra', () => {
    const cifrado = String(encryptConnectorSecret('APP_USR-token'));
    const partes = cifrado.split('.');
    partes[3] = Buffer.from('conteudo-falsificado').toString('base64url');
    assert.throws(() => decryptConnectorSecret(partes.join('.')));
  });

  test('a prévia mascarada nunca revela o segredo inteiro', () => {
    const preview = maskConnectorSecretPreview('APP_USR-1234567890-abcdef');
    assert.ok(!preview.includes('1234567890'));
    assert.ok(preview.includes('•') || preview.includes('*'));
  });
});

describe('Conectores — assinatura dos webhooks', () => {
  test('Shopee: assinatura válida passa, alterada no corpo falha', () => {
    process.env.SHOPEE_PARTNER_ID = '1001';
    process.env.SHOPEE_PARTNER_KEY = 'chave-parceiro';
    const url = 'https://erp.brobond.com.br/api/webhooks/shopee';
    const body = JSON.stringify({ code: 3, shop_id: 777, data: { ordersn: 'SN1' } });
    const assinatura = createHmac('sha256', 'chave-parceiro').update(`${url}|${body}`).digest('hex');
    assert.equal(verifyShopeeWebhookSignature(body, url, assinatura), true);
    assert.equal(verifyShopeeWebhookSignature(`${body} `, url, assinatura), false);
    assert.equal(verifyShopeeWebhookSignature(body, url, 'deadbeef'), false);
  });

  test('TikTok Shop: autorização usa service_id do Partner Center, não Login Kit', () => {
    const url = new URL(
      buildTikTokAuthorizationUrl('csrf-state', {
        serviceId: 'service-123',
        appKey: 'app-key',
        appSecret: 'app-secret',
        redirectUri: 'https://erp.example.com/api/connectors/tiktok/callback',
        authorizeUrl: 'https://services.tiktokshop.com/open/authorize',
        tokenBaseUrl: 'https://auth.tiktok-shops.com',
      })
    );
    assert.equal(url.origin, 'https://services.tiktokshop.com');
    assert.equal(url.searchParams.get('service_id'), 'service-123');
    assert.equal(url.searchParams.get('state'), 'csrf-state');
    assert.equal(url.searchParams.has('client_key'), false);
  });

  test('TikTok: assinatura sobre appKey + corpo cru', () => {
    process.env.TIKTOK_APP_KEY = 'app-key';
    process.env.TIKTOK_APP_SECRET = 'app-secret';
    const body = JSON.stringify({ type: 1, shop_id: 'abc', data: { order_id: '99' } });
    const assinatura = createHmac('sha256', 'app-secret').update(`app-key${body}`).digest('hex');
    assert.equal(verifyTikTokWebhookSignature({ rawBody: body, signature: assinatura }), true);
    assert.equal(verifyTikTokWebhookSignature({ rawBody: body, signature: 'xx' }), false);
  });

  test('Mercado Pago: manifesto ts/v1 do cabeçalho x-signature', () => {
    process.env.MERCADOPAGO_WEBHOOK_SECRET = 'segredo-mp';
    const ts = '1700000000';
    const manifesto = `id:12345;request-id:req-1;ts:${ts};`;
    const v1 = createHmac('sha256', 'segredo-mp').update(manifesto).digest('hex');
    assert.equal(
      verifyMercadoPagoWebhookSignature({
        dataId: '12345',
        xSignature: `ts=${ts},v1=${v1}`,
        xRequestId: 'req-1',
      }),
      true
    );
    assert.equal(
      verifyMercadoPagoWebhookSignature({
        dataId: '12345',
        xSignature: `ts=${ts},v1=${'0'.repeat(64)}`,
        xRequestId: 'req-1',
      }),
      false
    );
    delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
  });
});

describe('Conectores — ingestão idempotente de vendas', () => {
  test('a referência da venda é determinística por canal + pedido', () => {
    assert.equal(marketplaceSaleReference('SHOPEE', 'SN-1'), 'shopee:SN-1');
    assert.equal(normalizeSaleCurrency('usd'), 'USD');
    assert.equal(normalizeSaleCurrency('xx'), 'BRL');
  });

  test('primeira entrega cria a venda e grava os itens', async () => {
    const sales = createSalesService(() =>
      fakeDb((sql) => {
        if (sql.includes('FROM sales')) return []; // ainda não existe
        if (sql.startsWith('INSERT INTO sales')) {
          return [
            {
              id: 's1',
              reference: 'shopee:SN-1',
              quantity: 3,
              amount_cents: 9900,
              currency: 'BRL',
              status: 'PAID',
              occurred_at: new Date('2026-01-10T12:00:00Z'),
              channel: 'SHOPEE',
              external_order_id: 'SN-1',
              usuario_id: 7,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ];
        }
        return [];
      })
    );

    const result = await sales.upsertIngestedSale(7, {
      channel: 'SHOPEE' as any,
      externalOrderId: 'SN-1',
      amountCents: 9900,
      currency: 'BRL',
      status: 'PAID' as any,
      quantity: 3,
      occurredAt: new Date('2026-01-10T12:00:00Z'),
      items: [
        { sku: 'CAM-AZ', title: 'Camisa Azul', quantity: 2, unitPriceCents: 3300 },
        { sku: 'CAM-VM', title: 'Camisa Vermelha', quantity: 1, unitPriceCents: 3300 },
      ],
    });

    assert.equal(result.outcome, 'created');
    assert.equal(result.sale.id, 's1');
    assert.equal(result.itemCount, 2);
  });

  test('reentrega idêntica não reescreve nada (idempotência)', async () => {
    const db = fakeDb((sql) => {
      if (sql.includes('FROM sales')) {
        return [
          {
            id: 's1',
            reference: 'shopee:SN-1',
            quantity: 3,
            amount_cents: 9900,
            currency: 'BRL',
            status: 'PAID',
            occurred_at: new Date('2026-01-10T12:00:00Z'),
            channel: 'SHOPEE',
            external_order_id: 'SN-1',
            usuario_id: 7,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const sales = createSalesService(() => db);

    const result = await sales.upsertIngestedSale(7, {
      channel: 'SHOPEE' as any,
      externalOrderId: 'SN-1',
      amountCents: 9900,
      currency: 'BRL',
      status: 'PAID' as any,
      quantity: 3,
      occurredAt: new Date('2026-01-10T12:00:00Z'),
      items: [{ sku: 'CAM-AZ', title: 'Camisa Azul', quantity: 3, unitPriceCents: 3300 }],
    });

    assert.equal(result.outcome, 'unchanged');
    assert.equal(result.itemCount, 0);
    assert.equal(db.log.length, 1); // só o SELECT de conferência
  });

  test('o upsert sempre aterrissa na chave única de idempotência', async () => {
    const db = fakeDb((sql) => {
      if (sql.includes('FROM sales')) return [];
      if (sql.startsWith('INSERT INTO sales')) {
        return [
          {
            id: 's2',
            reference: 'mercadolivre:200',
            quantity: 1,
            amount_cents: 1000,
            currency: 'BRL',
            status: 'PAID',
            occurred_at: new Date(),
            channel: 'MERCADOLIVRE',
            external_order_id: '200',
            usuario_id: 1,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    });
    const sales = createSalesService(() => db);
    await sales.upsertIngestedSale(1, {
      channel: 'MERCADOLIVRE' as any,
      externalOrderId: '200',
      amountCents: 1000,
      currency: 'BRL',
      status: 'PAID' as any,
      quantity: 1,
      occurredAt: new Date(),
      items: [],
    });
    const insert = db.log.find((q: any) => q.sql.startsWith('INSERT INTO sales'));
    assert.ok(insert.sql.includes('ON CONFLICT (usuario_id, channel, external_order_id)'));
  });
});

describe('Conectores — casamento com o catálogo do ERP', () => {
  test('casa o SKU com produtos e o tamanho com tamanhos', async () => {
    const db = fakeDb((sql) => {
      if (sql.includes('FROM produtos')) return [{ id: 12, sku: 'CAM-AZ' }];
      if (sql.includes('FROM tamanhos')) return [{ id: 4, codigo: 'M' }];
      return [];
    });
    const match = await matchCatalogItem(db, { sku: 'CAM-AZ', title: 'Camisa', sizeLabel: 'M' });
    assert.deepEqual(match, { productId: 12, sizeId: 4 });
  });

  test('item sem correspondência entra sem vínculo, nunca com erro', async () => {
    const db = fakeDb(() => []);
    const match = await matchCatalogItem(db, { sku: 'DESCONHECIDO', title: 'X' });
    assert.deepEqual(match, { productId: null, sizeId: null });
  });

  test('falha de banco no casamento não derruba a ingestão', async () => {
    const db: any = {
      async query() {
        throw new Error('sem banco');
      },
    };
    const match = await matchCatalogItem(db, { sku: 'A', title: 'B' });
    assert.deepEqual(match, { productId: null, sizeId: null });
  });
});

describe('Conectores — tópicos que carregam venda', () => {
  test('reconhece os tópicos de pedido de cada provedor', () => {
    assert.equal(isSaleIngestionEvent('MERCADOLIVRE', 'orders_v2'), true);
    assert.equal(isSaleIngestionEvent('MERCADOPAGO', 'payment'), true);
    assert.equal(isSaleIngestionEvent('SHOPEE', '3'), true);
    assert.equal(isSaleIngestionEvent('TIKTOK', '1'), true);
    assert.equal(isSaleIngestionEvent('MERCADOPAGO', 'plan'), false);
    assert.equal(isSaleIngestionEvent('MERCADOLIVRE', null), false);
  });
});
