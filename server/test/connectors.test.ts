// ============================================================
// Testes do módulo de conectores de marketplace (Fase 2):
//   • registro estrito dos QUATRO canais de produção — MERCADOLIVRE,
//     MERCADOPAGO, NUVEMSHOP e INSTAGRAM (Shopee e TikTok não existem
//     mais)
//   • criptografia AES-256-GCM dos tokens em repouso
//   • assinaturas de webhook (Mercado Pago, Nuvemshop, Instagram/Meta)
//   • conector do Instagram: handshake hub.challenge, assinatura
//     x-hub-signature-256, parsing do payload multi-entrada da Meta,
//     canal INSTAGRAM_SHOPPING e o contrato de "nada é inventado"
//     (interação NUNCA vira venda)
//   • callbacks OAuth apontando ESTRITAMENTE para o host unificado
//     da Render (https://brobond-erp.onrender.com/api/connectors/...)
//   • redirect_uri dinâmico do painel (origem da Render validada)
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
// Chave de cifra do ambiente de mock: string Base64 VÁLIDA e ESTÁVEL que
// decodifica para exatamente 32 bytes (o crypto.service aceita base64 ou
// 64 hex; aqui travamos o formato base64 documentado no render.yaml —
// `openssl rand -base64 32`). É o mesmo valor em toda a suíte para que a
// ida e volta AES-256-GCM seja determinística.
process.env.CONNECTOR_ENCRYPTION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

const {
  CONNECTOR_PROVIDERS,
  parseConnectorProvider,
  isConnectorProviderName,
  saleChannelFromConnectorProvider,
  decodeConnectorEncryptionKey,
  encryptConnectorSecret,
  decryptConnectorSecret,
  maskConnectorSecretPreview,
  getConnector,
  getConnectorFromInput,
  listConnectors,
  REGISTERED_CONNECTOR_COUNT,
  createConnectorService,
  createConnectorOAuthStateService,
  createSalesService,
  marketplaceSaleReference,
  normalizeSaleCurrency,
  matchCatalogItem,
  isSaleIngestionEvent,
  appUrl,
  connectorCallbackPath,
  connectorWebhookPath,
  resolveDynamicCallbackUri,
} = await import('../../modules/connectors/index');

const { buildNuvemshopAuthorizationUrl, resolveNuvemshopRedirectUri, verifyNuvemshopWebhookSignature } = await import(
  '../../modules/connectors/nuvemshop/nuvemshop.service'
);
const { buildMercadoLivreAuthorizationUrl, resolveMercadoLivreRedirectUri } = await import('../../modules/connectors/mercadolivre/mercadolivre.service');
const { verifyMercadoPagoWebhookSignature } = await import('../../modules/connectors/mercadopago/mercadopago.service');
const {
  InstagramConnectorService,
  INSTAGRAM_SALE_CHANNEL,
  buildInstagramAuthorizationUrl,
  isInstagramSaleTopic,
  mapInstagramOrderPayload,
  parseInstagramWebhookPayload,
  resolveInstagramRedirectUri,
  verifyInstagramWebhookChallenge,
  verifyInstagramWebhookSignature,
} = await import('../../modules/connectors/instagram/index');

/** Host unificado do ERP na Render — único domínio aceito nos callbacks. */
const HOST_UNIFICADO = 'https://brobond-erp.onrender.com';

/** Roda o bloco com variáveis de ambiente sobrescritas e restaura tudo depois. */
async function comEnv(valores: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
  const antes = new Map<string, string | undefined>();
  for (const nome of Object.keys(valores)) {
    antes.set(nome, process.env[nome]);
    if (valores[nome] === undefined) delete process.env[nome];
    else process.env[nome] = valores[nome];
  }
  try {
    await fn();
  } finally {
    for (const [nome, valor] of antes) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
  }
}

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
  test('conhece exatamente os quatro canais de produção', () => {
    assert.deepEqual([...CONNECTOR_PROVIDERS].sort(), ['INSTAGRAM', 'MERCADOLIVRE', 'MERCADOPAGO', 'NUVEMSHOP']);
    assert.equal(REGISTERED_CONNECTOR_COUNT, 4);
    assert.equal(listConnectors().length, 4);
  });

  test('o Instagram Shopping tem adaptador próprio e resolve pelos apelidos de URL', () => {
    assert.equal(parseConnectorProvider('instagram'), 'INSTAGRAM');
    assert.equal(parseConnectorProvider('Instagram-Shopping'), 'INSTAGRAM');
    assert.equal(isConnectorProviderName('INSTAGRAM'), true);
    assert.equal(getConnectorFromInput('instagram')?.provider, 'INSTAGRAM');
    assert.equal(connectorWebhookPath('instagram'), '/api/webhooks/instagram');
  });

  test('Shopee e TikTok foram removidos e não resolvem em lugar nenhum', () => {
    for (const literal of ['shopee', 'SHOPEE', 'tiktok', 'TikTok', 'tiktok-shop']) {
      assert.equal(parseConnectorProvider(literal), null);
      assert.equal(getConnectorFromInput(literal), null);
    }
    assert.equal(isConnectorProviderName('SHOPEE'), false);
    assert.equal(isConnectorProviderName('TIKTOK'), false);
  });

  test('a Nuvemshop entrou como plataforma-ponte', () => {
    assert.equal(parseConnectorProvider('nuvemshop'), 'NUVEMSHOP');
    assert.equal(parseConnectorProvider('tiendanube'), 'NUVEMSHOP');
    assert.equal(isConnectorProviderName('NUVEMSHOP'), true);
    assert.equal(getConnectorFromInput('nuvemshop')?.provider, 'NUVEMSHOP');
  });

  test('aceita apelidos de URL e rejeita lixo', () => {
    assert.equal(parseConnectorProvider('mercado-livre'), 'MERCADOLIVRE');
    assert.equal(parseConnectorProvider('Nuvemshop'), 'NUVEMSHOP');
    assert.equal(parseConnectorProvider('nuvem-shop'), 'NUVEMSHOP');
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
    assert.equal(saleChannelFromConnectorProvider('NUVEMSHOP'), 'NUVEMSHOP');
    // O provedor é a CONTA (INSTAGRAM); o canal da receita é a VITRINE.
    assert.equal(saleChannelFromConnectorProvider('INSTAGRAM'), 'INSTAGRAM_SHOPPING');
  });

  test('o caminho público do webhook é derivado do slug', () => {
    assert.equal(connectorWebhookPath('mercadolivre'), '/api/webhooks/mercadolivre');
  });
});

// ------------------------------------------------------------
// Host unificado: TODO callback OAuth do ERP mora em
// https://brobond-erp.onrender.com/api/connectors/<slug>/callback.
// As URIs antigas do brobond-ai-commerce não existem mais — uma asserção
// que apontar para outro host aqui é bug, não configuração.
// ------------------------------------------------------------
describe('Conectores — callback OAuth no host unificado da Render', () => {
  const REDIRECT_ML = `${HOST_UNIFICADO}/api/connectors/mercadolivre/callback`;

  test('o caminho canônico de callback é /api/connectors/<slug>/callback para o trio', () => {
    assert.equal(connectorCallbackPath('mercadolivre'), '/api/connectors/mercadolivre/callback');
    assert.equal(connectorCallbackPath('mercadopago'), '/api/connectors/mercadopago/callback');
    assert.equal(connectorCallbackPath('nuvemshop'), '/api/connectors/nuvemshop/callback');
  });

  test('com APP_URL da Render, o redirect de cada provedor aponta estritamente para o host unificado', () => {
    return comEnv({ APP_URL: HOST_UNIFICADO, MERCADOLIVRE_REDIRECT_URI: undefined }, () => {
      assert.equal(resolveMercadoLivreRedirectUri(), REDIRECT_ML);
      assert.equal(resolveNuvemshopRedirectUri(), `${HOST_UNIFICADO}/api/connectors/nuvemshop/callback`);
    });
  });

  test('a URL de autorização do Mercado Livre embute o redirect_uri do host unificado', () => {
    return comEnv(
      { APP_URL: HOST_UNIFICADO, MERCADOLIVRE_CLIENT_ID: '1234567890', MERCADOLIVRE_CLIENT_SECRET: 'segredo-app', MERCADOLIVRE_REDIRECT_URI: undefined },
      () => {
        const url = new URL(buildMercadoLivreAuthorizationUrl('csrf-1'));
        assert.equal(url.origin, 'https://auth.mercadolivre.com.br');
        assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_ML);
        assert.equal(url.searchParams.get('state'), 'csrf-1');
      }
    );
  });

  test('o redirect_uri explícito do provedor segue valendo quando não há base dinâmica', () => {
    return comEnv({ APP_URL: HOST_UNIFICADO, MERCADOLIVRE_REDIRECT_URI: `${HOST_UNIFICADO}/api/connectors/mercadolivre/callback` }, () => {
      assert.equal(resolveMercadoLivreRedirectUri(), REDIRECT_ML);
    });
  });

  test('webhook público do Mercado Pago também é montado no host unificado', () => {
    return comEnv({ APP_URL: HOST_UNIFICADO }, () => {
      assert.equal(appUrl(connectorWebhookPath('mercadopago')), `${HOST_UNIFICADO}/api/webhooks/mercadopago`);
      assert.equal(appUrl(connectorWebhookPath('mercadolivre')), `${HOST_UNIFICADO}/api/webhooks/mercadolivre`);
    });
  });
});

// ------------------------------------------------------------
// Redirect_uri DINÂMICO: o painel envia a origem onde o navegador está
// (na Render, o host unificado). O servidor valida, deriva o caminho
// canônico e persiste a URI com o state para repeti-la na troca.
// ------------------------------------------------------------
describe('Conectores — redirect_uri dinâmico lido da Render', () => {
  const REDIRECT_ML = `${HOST_UNIFICADO}/api/connectors/mercadolivre/callback`;

  test('origem da Render vira o callback canônico no host unificado', () => {
    return comEnv({ APP_URL: 'https://erp-antigo.example.com', NODE_ENV: undefined }, () => {
      assert.equal(resolveDynamicCallbackUri(HOST_UNIFICADO, 'mercadolivre'), REDIRECT_ML);
      // barra final e callback pronto também normalizam para o MESMO valor
      assert.equal(resolveDynamicCallbackUri(`${HOST_UNIFICADO}/`, 'mercadolivre'), REDIRECT_ML);
      assert.equal(resolveDynamicCallbackUri(REDIRECT_ML, 'mercadolivre'), REDIRECT_ML);
      // dev local continua funcionando
      assert.equal(
        resolveDynamicCallbackUri('http://localhost:5173', 'mercadolivre'),
        'http://localhost:5173/api/connectors/mercadolivre/callback'
      );
    });
  });

  test('valor inválido nunca vira redirect: lixo, esquema estranho e caminho estranho são rejeitados', () => {
    return comEnv({ NODE_ENV: undefined }, () => {
      assert.equal(resolveDynamicCallbackUri('', 'mercadolivre'), null);
      assert.equal(resolveDynamicCallbackUri('   ', 'mercadolivre'), null);
      assert.equal(resolveDynamicCallbackUri('javascript:alert(1)', 'mercadolivre'), null);
      assert.equal(resolveDynamicCallbackUri('ftp://evil.example.com', 'mercadolivre'), null);
      assert.equal(resolveDynamicCallbackUri(`${HOST_UNIFICADO}/outra/pagina`, 'mercadolivre'), null);
      assert.equal(resolveDynamicCallbackUri(undefined, 'mercadolivre'), null);
    });
  });

  test('em produção só https público é aceito como base dinâmica', () => {
    return comEnv({ NODE_ENV: 'production' }, () => {
      assert.equal(resolveDynamicCallbackUri(HOST_UNIFICADO, 'mercadolivre'), REDIRECT_ML);
      assert.equal(resolveDynamicCallbackUri('http://localhost:5173', 'mercadolivre'), null);
      assert.equal(resolveDynamicCallbackUri('http://10.0.0.7:10000', 'mercadolivre'), null);
      assert.equal(resolveDynamicCallbackUri('https://localhost', 'mercadolivre'), null);
    });
  });

  test('o state OAuth carrega o redirect_uri escolhido e o devolve inteiro na consumição', async () => {
    const linhas: Array<Record<string, unknown>> = [];
    const db = {
      async query(sql: string, params: readonly unknown[] = []) {
        const responder = (): Array<Record<string, unknown>> => {
          if (sql.includes('DELETE FROM connector_oauth_states') && sql.includes('expires_at <= $3')) return []; // limpeza
          if (sql.startsWith('INSERT INTO connector_oauth_states')) {
            linhas.push({ usuario_id: params[1], redirect_uri: params[4] ?? null });
            return [];
          }
          if (sql.includes('RETURNING usuario_id, redirect_uri')) {
            const linha = linhas.shift();
            return linha ? [linha] : [];
          }
          return [];
        };
        const rows = responder();
        return { rows, rowCount: rows.length };
      },
    };
    const states = createConnectorOAuthStateService(db, {
      now: () => new Date('2026-10-05T12:00:00Z'),
      randomState: () => 'state-unificado-1',
    });
    const state = await states.issue(7, 'MERCADOLIVRE', { redirectUri: REDIRECT_ML });
    assert.equal(state, 'state-unificado-1');
    const consumido = await states.consume(state, 'MERCADOLIVRE');
    assert.equal(consumido.usuarioId, 7);
    assert.equal(consumido.redirectUri, REDIRECT_ML);
  });

  test('startAuthorization usa a origem da Render e a repassa ao state e à URL do provedor', async () => {
    const emitidos: Array<{ usuarioId: number; provider: string; redirectUri: string | null }> = [];
    const oauthStates = {
      issue: async (usuarioId: number, provider: string, metadata?: { redirectUri?: string | null }) => {
        emitidos.push({ usuarioId, provider, redirectUri: metadata?.redirectUri ?? null });
        return 'state-dinamico';
      },
      consume: async () => {
        throw new Error('não deve consumir state neste teste');
      },
    };
    const service = createConnectorService({ repository: {} as never, oauthStates: oauthStates as never });
    return comEnv(
      { APP_URL: 'https://erp-antigo.example.com', MERCADOLIVRE_CLIENT_ID: '1234567890', MERCADOLIVRE_CLIENT_SECRET: 'segredo-app', MERCADOLIVRE_REDIRECT_URI: undefined },
      async () => {
        const resultado = await service.startAuthorization(7, 'MERCADOLIVRE', { redirectBase: HOST_UNIFICADO });
        assert.equal(resultado.redirectUri, REDIRECT_ML, 'o redirect devolvido é o do host unificado');
        assert.deepEqual(emitidos, [{ usuarioId: 7, provider: 'MERCADOLIVRE', redirectUri: REDIRECT_ML }], 'o state persiste a URI para a troca');
        const url = new URL(resultado.authorizationUrl);
        assert.equal(url.origin, 'https://auth.mercadolivre.com.br');
        assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_ML);
      }
    );
  });

  test('base dinâmica inválida cai de volta na resolução estática do ambiente', async () => {
    const oauthStates = {
      issue: async () => 'state-estatico',
      consume: async () => {
        throw new Error('não deve consumir state neste teste');
      },
    };
    const service = createConnectorService({ repository: {} as never, oauthStates: oauthStates as never });
    return comEnv(
      { APP_URL: HOST_UNIFICADO, MERCADOLIVRE_CLIENT_ID: '1234567890', MERCADOLIVRE_CLIENT_SECRET: 'segredo-app', MERCADOLIVRE_REDIRECT_URI: undefined },
      async () => {
        const resultado = await service.startAuthorization(7, 'MERCADOLIVRE', { redirectBase: 'https://evil.example.com/outra' });
        assert.equal(resultado.redirectUri, REDIRECT_ML, 'ignorou a base inválida e usou o APP_URL unificado');
      }
    );
  });
});

describe('Conectores — tokens cifrados em repouso', () => {
  test('a chave de teste é uma string Base64 válida de exatamente 32 bytes', () => {
    const chave = process.env.CONNECTOR_ENCRYPTION_KEY!;
    // Base64 canônico (com padding) — nada de passphrase solta disfarçada.
    assert.match(chave, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(Buffer.from(chave, 'base64').length, 32, 'a chave injetada precisa decodificar para 32 bytes');
    assert.equal(decodeConnectorEncryptionKey(chave).length, 32, 'o crypto.service aceita a chave base64 da suíte');
  });

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
  test('Nuvemshop: HMAC-SHA256 hex do corpo cru com o client secret', () => {
    return comEnv({ NUVEMSHOP_CLIENT_SECRET: 'segredo-app-nuvem' }, () => {
      const body = JSON.stringify({ store_id: 2093261, event: 'order/paid', id: 450789469 });
      const assinatura = createHmac('sha256', 'segredo-app-nuvem').update(body).digest('hex');
      assert.equal(verifyNuvemshopWebhookSignature(body, assinatura), true);
      // Um byte a mais no corpo invalida a entrega inteira.
      assert.equal(verifyNuvemshopWebhookSignature(`${body} `, assinatura), false);
      assert.equal(verifyNuvemshopWebhookSignature(body, 'deadbeef'), false);
      assert.equal(verifyNuvemshopWebhookSignature(body, null), false);
    });
  });

  test('Nuvemshop: sem client secret no ambiente, nenhuma assinatura é aceita', () => {
    return comEnv({ NUVEMSHOP_CLIENT_SECRET: undefined }, () => {
      const body = JSON.stringify({ store_id: 1, event: 'order/paid', id: 2 });
      const assinatura = createHmac('sha256', 'qualquer').update(body).digest('hex');
      assert.equal(verifyNuvemshopWebhookSignature(body, assinatura), false);
    });
  });

  test('Nuvemshop: a URL de autorização leva o app id no caminho e o state CSRF', () => {
    return comEnv({ NUVEMSHOP_CLIENT_ID: '4321', NUVEMSHOP_CLIENT_SECRET: 'segredo-app-nuvem' }, () => {
      const url = new URL(buildNuvemshopAuthorizationUrl('csrf-state'));
      assert.equal(url.origin, 'https://www.nuvemshop.com.br');
      assert.equal(url.pathname, '/apps/4321/authorize');
      assert.equal(url.searchParams.get('state'), 'csrf-state');
    });
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
    assert.equal(marketplaceSaleReference('NUVEMSHOP', 'NS-1'), 'nuvemshop:NS-1');
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
              reference: 'nuvemshop:NS-1',
              quantity: 3,
              amount_cents: 9900,
              currency: 'BRL',
              status: 'PAID',
              occurred_at: new Date('2026-01-10T12:00:00Z'),
              channel: 'NUVEMSHOP',
              external_order_id: 'NS-1',
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
      channel: 'NUVEMSHOP' as any,
      externalOrderId: 'NS-1',
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
            reference: 'nuvemshop:NS-1',
            quantity: 3,
            amount_cents: 9900,
            currency: 'BRL',
            status: 'PAID',
            occurred_at: new Date('2026-01-10T12:00:00Z'),
            channel: 'NUVEMSHOP',
            external_order_id: 'NS-1',
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
      channel: 'NUVEMSHOP' as any,
      externalOrderId: 'NS-1',
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
    assert.equal(isSaleIngestionEvent('NUVEMSHOP', 'order/paid'), true);
    assert.equal(isSaleIngestionEvent('NUVEMSHOP', 'order/cancelled'), true);
    assert.equal(isSaleIngestionEvent('NUVEMSHOP', 'product/updated'), false);
    assert.equal(isSaleIngestionEvent('MERCADOPAGO', 'plan'), false);
    assert.equal(isSaleIngestionEvent('MERCADOLIVRE', null), false);
    // O Instagram não passa pelo despachante genérico: tem motor próprio.
    assert.equal(isSaleIngestionEvent('INSTAGRAM', 'comments'), false);
  });
});

// ============================================================
// INSTAGRAM SHOPPING — conector independente (Graph API da Meta)
//
// Estes testes travam DUAS coisas ao mesmo tempo:
//   1. o contrato técnico real da Meta (handshake hub.challenge,
//      assinatura `sha256=` sobre os bytes crus, payload multi-entrada
//      com `changes[]` e `messaging[]`);
//   2. o CONTRATO DE HONESTIDADE do painel: interação não é receita.
//      Comentário, menção, DM e clique de sacolinha entram na caixa de
//      eventos e NUNCA viram linha em `sales`. Um teste que passe a
//      aceitar venda fabricada aqui é regressão de produto, não de
//      código.
// ============================================================

/** App secret e verify token usados em toda a suíte do Instagram. */
const IG_APP_SECRET = 'segredo-do-app-da-meta';
const IG_VERIFY_TOKEN = 'token-combinado-com-a-meta';

/** Assina um corpo cru exatamente como a Meta faria. */
function assinaturaMeta(body: string, secret = IG_APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('Instagram — handshake e assinatura do webhook da Meta', () => {
  test('o handshake devolve o hub.challenge quando o verify token confere', () => {
    return comEnv({ INSTAGRAM_WEBHOOK_VERIFY_TOKEN: IG_VERIFY_TOKEN }, () => {
      const challenge = verifyInstagramWebhookChallenge({
        'hub.mode': 'subscribe',
        'hub.verify_token': IG_VERIFY_TOKEN,
        'hub.challenge': '1158201444',
      });
      assert.equal(challenge, '1158201444');
    });
  });

  test('token errado, modo errado ou ambiente sem token recusam o cadastro', () => {
    return comEnv({ INSTAGRAM_WEBHOOK_VERIFY_TOKEN: IG_VERIFY_TOKEN }, () => {
      assert.equal(
        verifyInstagramWebhookChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'outro', 'hub.challenge': '1' }),
        null
      );
      assert.equal(
        verifyInstagramWebhookChallenge({ 'hub.mode': 'unsubscribe', 'hub.verify_token': IG_VERIFY_TOKEN, 'hub.challenge': '1' }),
        null
      );
      return comEnv({ INSTAGRAM_WEBHOOK_VERIFY_TOKEN: undefined }, () => {
        assert.equal(
          verifyInstagramWebhookChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': IG_VERIFY_TOKEN, 'hub.challenge': '1' }),
          null
        );
      });
    });
  });

  test('x-hub-signature-256: HMAC-SHA256 do corpo CRU com o app secret', () => {
    return comEnv({ INSTAGRAM_APP_SECRET: IG_APP_SECRET }, () => {
      const body = JSON.stringify({ object: 'instagram', entry: [{ id: '17841400000000000', time: 1790000000, changes: [] }] });
      assert.equal(verifyInstagramWebhookSignature(body, assinaturaMeta(body)), true);
      // Um byte a mais no corpo invalida a entrega inteira.
      assert.equal(verifyInstagramWebhookSignature(`${body} `, assinaturaMeta(body)), false);
      // Hex sem o prefixo `sha256=` é formato de outro provedor.
      assert.equal(verifyInstagramWebhookSignature(body, createHmac('sha256', IG_APP_SECRET).update(body).digest('hex')), false);
      assert.equal(verifyInstagramWebhookSignature(body, assinaturaMeta(body, 'segredo-errado')), false);
      assert.equal(verifyInstagramWebhookSignature(body, null), false);
    });
  });

  test('sem app secret no ambiente, nenhuma assinatura é aceita', () => {
    return comEnv({ INSTAGRAM_APP_SECRET: undefined }, () => {
      const body = '{}';
      assert.equal(verifyInstagramWebhookSignature(body, assinaturaMeta(body)), false);
    });
  });

  test('a URL de consentimento usa o diálogo oficial da Meta com o redirect do host unificado', () => {
    return comEnv(
      { INSTAGRAM_APP_ID: '1234567890', INSTAGRAM_APP_SECRET: IG_APP_SECRET, APP_URL: HOST_UNIFICADO, INSTAGRAM_REDIRECT_URI: undefined },
      () => {
        const url = new URL(buildInstagramAuthorizationUrl('csrf-state', undefined, resolveInstagramRedirectUri()));
        assert.equal(url.origin, 'https://www.facebook.com');
        assert.ok(url.pathname.endsWith('/dialog/oauth'));
        assert.equal(url.searchParams.get('client_id'), '1234567890');
        assert.equal(url.searchParams.get('state'), 'csrf-state');
        assert.equal(url.searchParams.get('redirect_uri'), `${HOST_UNIFICADO}/api/connectors/instagram/callback`);
        assert.ok(url.searchParams.get('scope')?.includes('instagram_basic'));
      }
    );
  });
});

describe('Instagram — normalização do payload da Meta', () => {
  test('lê changes[] e messaging[] da mesma entrega e deduplica por chave estável', () => {
    const eventos = parseInstagramWebhookPayload({
      object: 'instagram',
      entry: [
        {
          id: '17841400000000000',
          time: 1790000000,
          changes: [{ field: 'comments', value: { id: 'c-1', text: 'quanto custa?', from: { id: 'u-9', username: 'cliente' } } }],
        },
        {
          id: '17841400000000000',
          time: 1790000001,
          messaging: [
            {
              sender: { id: 'u-9' },
              recipient: { id: '17841400000000000' },
              timestamp: 1790000001000,
              // Clique na sacolinha que abre a DM: é REFERRAL, não pedido.
              referral: { ref: 'produto-123', source: 'SHOPPING', type: 'OPEN_THREAD' },
            },
          ],
        },
      ],
    });

    assert.equal(eventos.length, 2);
    assert.equal(eventos[0].topic, 'comments');
    assert.equal(eventos[0].igUserId, '17841400000000000');
    assert.equal(eventos[0].externalEventId, 'instagram:comments:17841400000000000:c-1');
    assert.equal(eventos[1].topic, 'messaging_referral');

    // Reentrega do MESMO corpo gera a MESMA chave de dedupe.
    const reentrega = parseInstagramWebhookPayload({
      object: 'instagram',
      entry: [{ id: '17841400000000000', time: 1790000000, changes: [{ field: 'comments', value: { id: 'c-1' } }] }],
    });
    assert.equal(reentrega[0].externalEventId, eventos[0].externalEventId);
  });

  test('corpo de outro objeto da Meta não produz evento nenhum', () => {
    assert.deepEqual(parseInstagramWebhookPayload({ object: 'page', entry: [{ id: '1', changes: [{ field: 'feed', value: {} }] }] }), []);
    assert.deepEqual(parseInstagramWebhookPayload({}), []);
  });
});

describe('Instagram — o caminho de receita é dirigido por payload', () => {
  test('NENHUMA interação da Meta é convertida em venda', () => {
    // Estes são os campos que o objeto `instagram` realmente emite.
    const interacoes = [
      { field: 'comments', value: { id: 'c-1', text: 'eu quero!' } },
      { field: 'mentions', value: { media_id: 'm-1', comment_id: 'c-2' } },
      { field: 'messages', value: { sender: { id: 'u-1' }, message: { mid: 'mid-1', text: 'vou comprar' } } },
      { field: 'messaging_referral', value: { referral: { ref: 'produto-123', source: 'SHOPPING' } } },
      { field: 'story_insights', value: { impressions: 42, reach: 40 } },
    ];
    for (const payload of interacoes) {
      assert.equal(mapInstagramOrderPayload(payload), null, `${payload.field} jamais pode virar receita`);
    }
    // E nenhum desses tópicos entra no motor financeiro.
    for (const payload of interacoes) assert.equal(isInstagramSaleTopic(payload.field), false);
  });

  test('um pedido COMPLETO é convertido para o contrato de ingestão do ERP', () => {
    const order = mapInstagramOrderPayload({
      field: 'orders',
      value: {
        order: {
          id: 'IG-ORDER-77',
          order_status: { state: 'COMPLETED' },
          created: '2026-10-01T15:04:05+0000',
          order_total: { amount: '249.90', currency: 'BRL' },
          items: [
            { retailer_id: 'CAM-AZ', product_name: 'Camisa Azul', quantity: 2, price_per_unit: { amount: '99.95', currency: 'BRL' }, variant: 'M' },
            { retailer_id: 'MEI-PR', product_name: 'Meia Preta', quantity: 1, price_per_unit: { amount: '50.00', currency: 'BRL' } },
          ],
        },
      },
    });

    assert.ok(order);
    assert.equal(order!.id, 'IG-ORDER-77');
    assert.equal(order!.status, 'PAID');
    assert.equal(order!.currency, 'BRL');
    assert.equal(order!.totalAmountCents, 24990);
    assert.equal(order!.items.length, 2);
    assert.equal(order!.items[0].sku, 'CAM-AZ');
    assert.equal(order!.items[0].unitPriceCents, 9995);
    assert.equal(order!.items[0].sizeLabel, 'M');
    assert.equal(isInstagramSaleTopic('orders'), true);
  });

  test('pedido sem item ou sem identificador externo é descartado', () => {
    assert.equal(mapInstagramOrderPayload({ value: { order: { id: 'IG-1', items: [] } } }), null);
    assert.equal(mapInstagramOrderPayload({ value: { order: { items: [{ retailer_id: 'X', quantity: 1 }] } } }), null);
  });
});

describe('Instagram — ingestão idempotente no canal INSTAGRAM_SHOPPING', () => {
  test('o canal gravado em sales é estritamente INSTAGRAM_SHOPPING', () => {
    assert.equal(INSTAGRAM_SALE_CHANNEL, 'INSTAGRAM_SHOPPING');
    assert.equal(marketplaceSaleReference(INSTAGRAM_SALE_CHANNEL, 'IG-ORDER-77'), 'instagram_shopping:IG-ORDER-77');
  });

  test('o pedido entra em sales pelo upsert guardado pela chave única', async () => {
    const db = fakeDb((sql) => {
      if (sql.includes('FROM sales')) return [];
      if (sql.startsWith('INSERT INTO sales')) {
        return [
          {
            id: 'ig-sale-1',
            reference: 'instagram_shopping:IG-ORDER-77',
            quantity: 3,
            amount_cents: 24990,
            currency: 'BRL',
            status: 'PAID',
            occurred_at: new Date('2026-10-01T15:04:05Z'),
            channel: 'INSTAGRAM_SHOPPING',
            external_order_id: 'IG-ORDER-77',
            usuario_id: 7,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    });

    const contadores: any[] = [];
    const service = new InstagramConnectorService({
      resolveDb: () => db,
      repository: {
        incrementIngestionCounters: async (usuarioId: number, provider: string, counters: unknown) => {
          contadores.push({ usuarioId, provider, counters });
          return null;
        },
      } as any,
    });

    const order = mapInstagramOrderPayload({
      value: {
        order: {
          id: 'IG-ORDER-77',
          order_status: { state: 'COMPLETED' },
          order_total: { amount: '249.90', currency: 'BRL' },
          items: [
            { retailer_id: 'CAM-AZ', product_name: 'Camisa Azul', quantity: 2, price_per_unit: { amount: '99.95' } },
            { retailer_id: 'MEI-PR', product_name: 'Meia Preta', quantity: 1, price_per_unit: { amount: '50.00' } },
          ],
        },
      },
    });

    const result = await service.ingestOrder(7, order!);
    assert.equal(result.saleId, 'ig-sale-1');
    assert.equal(result.outcome, 'created');
    assert.equal(result.amountCents, 24990);

    const insert = db.log.find((q: any) => q.sql.startsWith('INSERT INTO sales'));
    assert.ok(insert.sql.includes('ON CONFLICT (usuario_id, channel, external_order_id)'));
    assert.ok(insert.params.includes('INSTAGRAM_SHOPPING'));
    // O KPI "Pedidos Importados" do cartão vem DAQUI — contagem real.
    assert.deepEqual(contadores[0], { usuarioId: 7, provider: 'INSTAGRAM', counters: { imported: 1, duplicated: 0, failed: 0 } });
  });

  test('entrega forjada não chega ao banco', async () => {
    return comEnv({ INSTAGRAM_APP_SECRET: IG_APP_SECRET }, async () => {
      const service = new InstagramConnectorService({
        resolveDb: () => fakeDb(() => []),
        repository: {} as any,
      });
      await assert.rejects(
        () =>
          service.handleWebhook({
            headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
            rawBody: JSON.stringify({ object: 'instagram', entry: [] }),
            query: {},
          }),
        /Assinatura de webhook inválida/
      );
    });
  });

  test('entrega assinada de interação vira EVENTO, nunca venda', async () => {
    return comEnv({ INSTAGRAM_APP_SECRET: IG_APP_SECRET }, async () => {
      const body = JSON.stringify({
        object: 'instagram',
        entry: [
          {
            id: '17841400000000000',
            time: 1790000000,
            changes: [{ field: 'comments', value: { id: 'c-1', text: 'quanto custa?' } }],
          },
        ],
      });

      const gravados: any[] = [];
      const processados: string[] = [];
      const db = fakeDb(() => []);
      const service = new InstagramConnectorService({
        resolveDb: () => db,
        repository: {
          findByShopId: async (provider: string, shopId: string) => {
            assert.equal(provider, 'INSTAGRAM');
            assert.equal(shopId, '17841400000000000');
            return { id: 'conn-1', usuarioId: 7, provider: 'INSTAGRAM', shopId };
          },
          hasEvent: async () => false,
          recordEvent: async (_usuarioId: number, event: unknown) => {
            gravados.push(event);
            return null;
          },
          markEventProcessed: async (_u: number, _p: string, externalEventId: string) => {
            processados.push(externalEventId);
          },
        } as any,
      });

      const result = await service.handleWebhook({
        headers: { 'x-hub-signature-256': assinaturaMeta(body) },
        rawBody: body,
        query: {},
      });

      assert.deepEqual({ accepted: result.accepted, duplicates: result.duplicates, ignored: result.ignored }, { accepted: 1, duplicates: 0, ignored: 0 });
      assert.equal(result.orders.length, 0, 'interação JAMAIS produz venda');
      assert.equal(gravados[0].topic, 'comments');
      assert.equal(gravados[0].provider, 'INSTAGRAM');
      assert.equal(processados.length, 1);
      // Nenhuma consulta a `sales` foi disparada por um comentário.
      assert.equal(db.log.length, 0);
    });
  });

  test('reentrega da mesma chave é reconhecida e descartada', async () => {
    return comEnv({ INSTAGRAM_APP_SECRET: IG_APP_SECRET }, async () => {
      const body = JSON.stringify({
        object: 'instagram',
        entry: [{ id: '17841400000000000', time: 1790000000, changes: [{ field: 'comments', value: { id: 'c-1' } }] }],
      });
      const service = new InstagramConnectorService({
        resolveDb: () => fakeDb(() => []),
        repository: {
          findByShopId: async () => ({ id: 'conn-1', usuarioId: 7, provider: 'INSTAGRAM', shopId: '17841400000000000' }),
          hasEvent: async () => true,
          recordEvent: async () => {
            throw new Error('reentrega NUNCA pode gravar de novo');
          },
        } as any,
      });

      const result = await service.handleWebhook({ headers: { 'x-hub-signature-256': assinaturaMeta(body) }, rawBody: body, query: {} });
      assert.equal(result.duplicates, 1);
      assert.equal(result.accepted, 0);
    });
  });

  test('conta do Instagram sem dono no ERP é ignorada em silêncio', async () => {
    return comEnv({ INSTAGRAM_APP_SECRET: IG_APP_SECRET }, async () => {
      const body = JSON.stringify({
        object: 'instagram',
        entry: [{ id: '17841499999999999', time: 1790000000, changes: [{ field: 'mentions', value: { media_id: 'm-1' } }] }],
      });
      const service = new InstagramConnectorService({
        resolveDb: () => fakeDb(() => []),
        repository: { findByShopId: async () => null } as any,
      });
      const result = await service.handleWebhook({ headers: { 'x-hub-signature-256': assinaturaMeta(body) }, rawBody: body, query: {} });
      assert.deepEqual({ accepted: result.accepted, ignored: result.ignored }, { accepted: 0, ignored: 1 });
    });
  });
});

describe('Instagram — consultas que alimentam o painel analítico', () => {
  test('receita, pedidos e eventos saem de consultas reais escopadas ao operador', async () => {
    const db = fakeDb((sql) => {
      if (sql.includes('COALESCE(SUM(amount_cents)')) return [{ total: '24990' }];
      if (sql.includes('COUNT(*) AS total') && sql.includes('FROM sales')) return [{ total: '1' }];
      if (sql.includes('COUNT(*) AS total') && sql.includes('connector_events')) return [{ total: '12' }];
      if (sql.includes('FROM sales')) {
        return [
          {
            id: 'ig-sale-1',
            reference: 'instagram_shopping:IG-ORDER-77',
            external_order_id: 'IG-ORDER-77',
            status: 'PAID',
            quantity: 3,
            amount_cents: 24990,
            currency: 'BRL',
            occurred_at: new Date('2026-10-01T15:04:05Z'),
          },
        ];
      }
      if (sql.includes('FROM sale_items')) return [];
      return [];
    });

    const service = new InstagramConnectorService({
      resolveDb: () => db,
      repository: {
        listRecentEvents: async () => [
          { id: 'e1', externalEventId: 'instagram:comments:1:c-1', topic: 'comments', processedAt: new Date(), createdAt: new Date() },
        ],
      } as any,
    });

    const panel = await service.getPanel(7, 10);
    assert.equal(panel.provider, 'INSTAGRAM');
    assert.equal(panel.revenueCents, 24990);
    assert.equal(panel.salesCount, 1);
    assert.equal(panel.eventCount, 12);
    assert.equal(panel.events[0].topic, 'comments');
    assert.equal(panel.sales[0].externalOrderId, 'IG-ORDER-77');

    // TODA consulta do painel é escopada ao operador e ao canal.
    for (const q of db.log) {
      assert.equal(q.params[0], 7);
      if (q.sql.includes('sale_channel')) assert.ok(q.params.includes('INSTAGRAM_SHOPPING'));
    }
  });

  test('canal sem dado nenhum devolve ZERO — nunca um número estimado', async () => {
    const service = new InstagramConnectorService({
      resolveDb: () => fakeDb(() => []),
      repository: { listRecentEvents: async () => [] } as any,
    });
    const panel = await service.getPanel(7, 10);
    assert.deepEqual(
      { revenueCents: panel.revenueCents, salesCount: panel.salesCount, eventCount: panel.eventCount },
      { revenueCents: 0, salesCount: 0, eventCount: 0 }
    );
    assert.deepEqual(panel.sales, []);
    assert.deepEqual(panel.events, []);
    assert.deepEqual(panel.importedContent, []);
  });
});
