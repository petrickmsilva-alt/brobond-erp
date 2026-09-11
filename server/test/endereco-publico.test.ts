// ============================================================
// Endereço público do ERP salvo pela interface (self-service).
//
// Cobre a correção do defeito "convite abre como URL inválida": antes a única
// saída era definir APP_URL na Render e fazer redeploy; agora o admin salva o
// endereço em Configurações › Sistema (tabela `configuracoes`) e o próximo
// convite já sai com a base certa.
//
// Contratos travados aqui:
//   • o endereço salvo é usado quando não há APP_URL (mesmo sem requisição);
//   • APP_URL (ambiente) continua com a precedência;
//   • endereço interno (localhost/IP privado) é recusado em produção — tanto
//     ao salvar quanto ao usar;
//   • o endereço detectado na requisição NUNCA é gravado sozinho (o Host é
//     controlado por quem requisita: confiar nele entregaria tokens de convite
//     a outro domínio);
//   • gravar/apagar exige admin + reautenticação, e vai para a auditoria.
// ============================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.SMTP_HOST;
delete process.env.SMTP_PORT;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
delete process.env.APP_URL;
delete process.env.APP_URL_PERMITIR_INTERNA;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { CHAVE_APP_URL, gravarConfig, lerConfig, removerConfig } = await import('../src/configuracoes');
const {
  carregarOrigemDoBanco,
  linkPublicoAsync,
  registrarOrigemDoBanco,
  statusOrigemAsync,
  urlAbsoluta,
  urlBasePublicaAsync,
  validarOrigemPublica,
} = await import('../src/urlPublica');

const ENDERECO = 'https://erp.brobond.com.br';

function mockReq(headers: Record<string, string> = {}): any {
  return { headers, protocol: 'http', secure: false, socket: { remoteAddress: '203.0.113.10' } };
}
const reqPublico = () => mockReq({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'erp.brobond.com.br' });

/** Roda com APP_URL definida (ou ausente) e restaura depois. */
async function comAppUrl<T>(valor: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const antes = process.env.APP_URL;
  if (valor === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = valor;
  try {
    return await fn();
  } finally {
    if (antes === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = antes;
  }
}

/** Roda com NODE_ENV=production (o filtro de endereço interno só vale lá). */
async function emProducao<T>(fn: () => Promise<T> | T): Promise<T> {
  const antes = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = antes;
  }
}

async function limparEndereco(): Promise<void> {
  await removerConfig(CHAVE_APP_URL);
  registrarOrigemDoBanco('');
}

/** Grava o endereço como o endpoint faria (banco + cache). */
async function salvarComoAdmin(valor: string): Promise<void> {
  const v = validarOrigemPublica(valor);
  assert.equal(v.ok, true, `esperava aceitar "${valor}"`);
  await gravarConfig(CHAVE_APP_URL, v.ok ? v.origem : '', 'Admin Teste');
  await carregarOrigemDoBanco(true);
}

describe('Endereço público salvo — precedência', () => {
  test('sem APP_URL e sem requisição, o endereço salvo é a base do link', async () => {
    await comAppUrl(undefined, async () => {
      await salvarComoAdmin(ENDERECO);
      const base = await urlBasePublicaAsync(null);
      assert.equal(base, ENDERECO);
      assert.equal(await linkPublicoAsync('convite/abc'), `${ENDERECO}/convite/abc`);
      await limparEndereco();
    });
  });

  test('APP_URL do ambiente continua com a precedência sobre o salvo', async () => {
    await comAppUrl('https://app.brobond.com.br', async () => {
      await salvarComoAdmin(ENDERECO);
      assert.equal(await urlBasePublicaAsync(reqPublico()), 'https://app.brobond.com.br');
      const status = await statusOrigemAsync(reqPublico());
      assert.equal(status.fonte, 'env');
      await limparEndereco();
    });
  });

  test('APP_URL interna em produção é descartada e o valor salvo assume', async () => {
    await emProducao(async () => {
      await comAppUrl('http://localhost:5173', async () => {
        await salvarComoAdmin(ENDERECO);
        const status = await statusOrigemAsync(null);
        assert.equal(status.base, ENDERECO, 'localhost no ambiente não pode virar link de e-mail');
        assert.equal(status.appUrlIgnorada, true);
        assert.equal(status.fonte, 'banco');
        await limparEndereco();
      });
    });
  });

  test('valor salvo interno em produção é descartado e cai na requisição', async () => {
    await emProducao(async () => {
      await comAppUrl(undefined, async () => {
        // Em produção a validação da rota barra esse valor; se ele chegou ao
        // banco por outra via (importação, SQL), também não pode ser usado.
        await gravarConfig(CHAVE_APP_URL, 'http://10.0.0.7:10000', 'Admin Teste');
        await carregarOrigemDoBanco(true);
        const status = await statusOrigemAsync(reqPublico());
        assert.equal(status.base, 'https://erp.brobond.com.br', 'IP privado não serve como link de e-mail');
        assert.equal(status.fonte, 'requisicao');
        await limparEndereco();
      });
    });
  });

  test('a detecção da requisição NUNCA é gravada sozinha (Host é de quem requisita)', async () => {
    await comAppUrl(undefined, async () => {
      await limparEndereco();
      assert.equal(await urlBasePublicaAsync(reqPublico()), 'https://erp.brobond.com.br');
      assert.equal(await lerConfig(CHAVE_APP_URL), '', 'nada foi persistido sem o admin salvar');
    });
  });
});

describe('validarOrigemPublica — o que pode ser salvo', () => {
  test('aceita domínio com ou sem esquema e remove a barra final', () => {
    for (const bruto of ['https://erp.brobond.com.br', 'erp.brobond.com.br', 'https://erp.brobond.com.br/', '  erp.brobond.com.br  ']) {
      const v = validarOrigemPublica(bruto);
      assert.equal(v.ok, true, `esperava aceitar "${bruto}"`);
      assert.equal(v.ok ? v.origem : '', ENDERECO, `"${bruto}" normaliza para ${ENDERECO}`);
    }
  });

  test('recusa vazio, esquema não-http e lixo', () => {
    for (const bruto of ['', '   ', 'javascript:alert(1)', 'ftp://erp.brobond.com.br', 'http://']) {
      const v = validarOrigemPublica(bruto);
      assert.equal(v.ok, false, `esperava recusar "${bruto}"`);
    }
  });

  test('em produção recusa endereço interno (é o que vira "URL inválida")', () => {
    return emProducao(() => {
      for (const bruto of [
        'http://localhost:5173',
        'http://127.0.0.1',
        'http://10.0.0.8',
        'http://192.168.0.10',
        'http://brobond-erp',
        'https://erp.local',
      ]) {
        const v = validarOrigemPublica(bruto);
        assert.equal(v.ok, false, `esperava recusar "${bruto}" em produção`);
        assert.ok(!v.ok && v.erro.includes('URL inválida'), 'o erro explica o efeito para quem recebe o e-mail');
      }
      assert.equal(validarOrigemPublica(ENDERECO).ok, true);
    });
  });

  test('APP_URL_PERMITIR_INTERNA libera endereço interno (ERP só na rede da fábrica)', () => {
    return emProducao(() => {
      process.env.APP_URL_PERMITIR_INTERNA = 'true';
      try {
        assert.equal(validarOrigemPublica('http://10.0.0.8:3001').ok, true);
      } finally {
        delete process.env.APP_URL_PERMITIR_INTERNA;
      }
    });
  });

  test('em desenvolvimento localhost é aceito (é o endereço normal do dev)', () => {
    assert.equal(validarOrigemPublica('http://localhost:5173').ok, true);
  });
});

const { obterEnderecoPublico, salvarEnderecoPublico, removerEnderecoPublico } = await import('../src/configSistema');

describe('Endpoint de administração — quem pode mudar o endereço', () => {
  function reqDe(perfil: string): any {
    return { ...reqPublico(), user: { id: 1, name: 'Admin Teste', perfil }, params: {}, body: {}, query: {} };
  }
  /** Resposta falsa: `saida.json` guarda o payload que o handler devolveu. */
  function resFake(): { res: any; saida: { json?: any; status?: number } } {
    const saida: { json?: any; status?: number } = {};
    const res: any = { json: (d: any) => ((saida.json = d), res), status: (s: number) => ((saida.status = s), res) };
    return { res, saida };
  }

  test('só administrador lê e altera (403 para os demais perfis)', async () => {
    const { res } = resFake();
    await assert.rejects(
      () => obterEnderecoPublico(reqDe('operador'), res),
      (e: any) => e.status === 403
    );
    await assert.rejects(
      () => salvarEnderecoPublico({ ...reqDe('gerente'), body: { valor: ENDERECO } }, res),
      (e: any) => e.status === 403
    );
  });

  test('gravar sem reautenticação é barrado (403 reauth_necessaria)', async () => {
    const { res } = resFake();
    await assert.rejects(
      () => salvarEnderecoPublico({ ...reqDe('admin'), body: { valor: ENDERECO } }, res),
      (e: any) => e.status === 403 && e.code === 'reauth_necessaria'
    );
    await assert.rejects(
      () => removerEnderecoPublico(reqDe('admin'), res),
      (e: any) => e.status === 403 && e.code === 'reauth_necessaria'
    );
  });

  test('admin reautenticado grava, o link passa a usar o endereço, e apagar volta ao padrão', async () => {
    await comAppUrl(undefined, async () => {
      await limparEndereco();
      const { registrarReautenticacao } = await import('../src/auth');
      registrarReautenticacao(1); // mesma janela de 5 min que o POST /auth/reautenticar abre
      try {
        const { res, saida } = resFake();
        await salvarEnderecoPublico({ ...reqDe('admin'), body: { valor: 'erp.brobond.com.br/' } }, res);
        assert.equal(saida.json.ok, true);
        assert.equal(saida.json.status.base, ENDERECO);
        assert.equal(saida.json.status.fonte, 'banco');
        assert.equal(await lerConfig(CHAVE_APP_URL), ENDERECO, 'normalizado e persistido');
        assert.equal(urlAbsoluta(await linkPublicoAsync('convite/abc')), true);

        const apagado = resFake();
        await removerEnderecoPublico(reqDe('admin'), apagado.res);
        assert.equal(apagado.saida.json.ok, true);
        assert.equal(await lerConfig(CHAVE_APP_URL), '');
      } finally {
        const { limparReautenticacao } = await import('../src/auth');
        limparReautenticacao(1);
        await limparEndereco();
      }
    });
  });

  test('valor recusado pela validação não chega ao banco (400)', async () => {
    await emProducao(async () => {
      await limparEndereco();
      const { registrarReautenticacao, limparReautenticacao } = await import('../src/auth');
      registrarReautenticacao(1);
      try {
        const { res } = resFake();
        await assert.rejects(
          () => salvarEnderecoPublico({ ...reqDe('admin'), body: { valor: 'http://localhost:5173' } }, res),
          (e: any) => e.status === 400
        );
        assert.equal(await lerConfig(CHAVE_APP_URL), '', 'nada gravado');
      } finally {
        limparReautenticacao(1);
      }
    });
  });
});

describe('Convite gerado depois de salvar o endereço', () => {
  test('link do convite sai absoluto com o endereço salvo (regressão do "URL inválida")', async () => {
    await comAppUrl(undefined, async () => {
      await salvarComoAdmin(ENDERECO);
      try {
        const { gerarConvite } = await import('../src/usuariosAdmin');
        const row = await getStore().insert(RESOURCES.usuarios, {
          nome: 'Sócio Endereço',
          email: `socio.endereco${Date.now()}@brobond.com.br`,
          perfil: 'operador',
          ativo: true,
          senha_hash: null,
        });
        // Sem requisição: antes cairia em link relativo ("/convite/…").
        const r = await gerarConvite(row as any, { id: 1, name: 'Admin Teste' });
        assert.match(String(r.link), /^https:\/\/erp\.brobond\.com\.br\/convite\/[a-f0-9]{64}$/);
      } finally {
        await limparEndereco();
      }
    });
  });
});
