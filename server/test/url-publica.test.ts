// ============================================================
// Testes da origem dos links que saem do servidor (server/src/urlPublica.ts).
//
// Motivo real: um sócio convidado recebeu um e-mail cujo link era
// "/convite/<token>" — sem protocolo nem domínio. O cliente de e-mail não tem
// para onde ir e responde "URL inválida". Estes testes travam o contrato:
//   • todo link de convite/reset é ABSOLUTO (http(s)://host/…);
//   • APP_URL é a fonte canônica, aceito com/sem esquema e com/sem barra;
//   • sem APP_URL, a origem vem da requisição que gerou o convite;
//   • Host adulterado (CRLF/espaço/`@`/caminho) nunca vira link.
// Modo memória (sem SMTP): o link volta na resposta para entrega manual.
// ============================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.SMTP_HOST;
delete process.env.SMTP_PORT;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { linkPublico, normalizarOrigem, origemDaRequisicao, urlAbsoluta, urlBasePublica } = await import('../src/urlPublica');

const APP_URL_TESTE = 'https://erp.brobond.com.br';
const SENHA_FORTE = () => `Reset#Seguro${Date.now()}`;

/** Captura o que o mail.ts escreve no console quando não há SMTP. */
async function capturarConsole(fn: () => Promise<unknown>): Promise<string> {
  const linhas: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    linhas.push(args.map(String).join(' '));
  };
  try {
    await fn();
    return linhas.join('\n');
  } finally {
    console.log = original;
  }
}

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

function mockReq(headers: Record<string, string> = {}, extras: Record<string, unknown> = {}): any {
  return { headers, protocol: 'http', secure: false, socket: { remoteAddress: '203.0.113.10' }, ...extras };
}
const reqPublico = () => mockReq({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'erp.brobond.com.br' });

let seq = 0;
async function novoUsuario(dados: Record<string, unknown> = {}) {
  seq++;
  return getStore().insert(RESOURCES.usuarios, {
    nome: dados.nome ?? `Sócio Teste ${seq}`,
    email: dados.email ?? `socio${seq}@brobond.com.br`,
    perfil: dados.perfil ?? 'admin',
    ativo: true,
    senha_hash: null,
  });
}

// ---------- 1) normalização da origem ----------
describe('normalizarOrigem — base dos links de e-mail', () => {
  test('aceita com ou sem esquema/barra final e conserva subpath', () => {
    assert.equal(normalizarOrigem('https://erp.brobond.com.br'), 'https://erp.brobond.com.br');
    assert.equal(normalizarOrigem('https://erp.brobond.com.br/'), 'https://erp.brobond.com.br');
    assert.equal(normalizarOrigem('https://erp.brobond.com.br///'), 'https://erp.brobond.com.br');
    // Erro de configuração comum: domínio sem esquema → assume https (nunca http).
    assert.equal(normalizarOrigem('erp.brobond.com.br'), 'https://erp.brobond.com.br');
    assert.equal(normalizarOrigem('  erp.brobond.com.br/  '), 'https://erp.brobond.com.br');
    assert.equal(normalizarOrigem('http://localhost:3001'), 'http://localhost:3001');
    assert.equal(normalizarOrigem('https://erp.brobond.com.br/app'), 'https://erp.brobond.com.br/app');
    assert.equal(
      normalizarOrigem('https://usuario:senha@erp.brobond.com.br'),
      'https://erp.brobond.com.br',
      'credencial nunca vai para o link'
    );
  });

  test('rejeita o que não pode virar link', () => {
    for (const bruto of ['', '   ', 'javascript:alert(1)', 'ftp://x.com', 'http://', '///', 'http:// ', 'https://:8080']) {
      assert.equal(normalizarOrigem(bruto), '', `"${bruto}" não pode ser usado como origem`);
    }
  });
});

describe('origemDaRequisicao — só cabeçalho bem-formado', () => {
  test('X-Forwarded-Proto/Host (Render/proxy) têm prioridade; lista usa o 1º valor', () => {
    assert.equal(
      origemDaRequisicao(mockReq({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'erp.brobond.com.br', host: '10.0.0.5:10000' })),
      'https://erp.brobond.com.br'
    );
    assert.equal(
      origemDaRequisicao(mockReq({ 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'erp.brobond.com.br, outro.com' })),
      'https://erp.brobond.com.br'
    );
    assert.equal(
      origemDaRequisicao(mockReq({ host: 'erp.brobond.com.br' })),
      'http://erp.brobond.com.br',
      'sem x-forwarded-proto usa req.protocol'
    );
    assert.equal(
      origemDaRequisicao(mockReq({ 'x-forwarded-proto': 'http', host: '[::1]:3001' })),
      'http://[::1]:3001',
      'IPv6 literal entre colchetes é host válido'
    );
    assert.equal(origemDaRequisicao(null), '');
  });

  test('descarta Host adulterado em vez de montar link perigoso', () => {
    for (const host of [
      'evil.com/x',
      'a b.com',
      'x.com\r\nY: 1',
      'user@evil.com',
      'evil.com:99999',
      '.evil.com',
      "ev'il.com",
      'HTTP://x.com',
      '',
    ]) {
      assert.equal(origemDaRequisicao(mockReq({ 'x-forwarded-host': host })), '', `host ${JSON.stringify(host)} deve ser rejeitado`);
    }
  });

  test('proto desconhecido nunca é aceito às cegas (assume https)', () => {
    assert.equal(origemDaRequisicao(mockReq({ 'x-forwarded-proto': 'gopher', host: 'erp.brobond.com.br' })), 'https://erp.brobond.com.br');
    assert.equal(origemDaRequisicao(mockReq({ 'x-forwarded-proto': 'http', host: 'erp.brobond.com.br' })), 'http://erp.brobond.com.br');
  });
});

describe('linkPublico — APP_URL manda, a requisição é a rede de segurança', () => {
  test('APP_URL (mesmo digitada sem esquema) é a base do link', () => {
    return comAppUrl('erp.brobond.com.br/', () => {
      const link = linkPublico('convite/abc123', mockReq({ host: 'outro-site.com' }));
      assert.equal(link, 'https://erp.brobond.com.br/convite/abc123');
      assert.ok(urlAbsoluta(link));
    });
  });

  test('sem APP_URL o link usa a origem da requisição — nunca relativo', () => {
    return comAppUrl(undefined, () => {
      const link = linkPublico('convite/abc123', reqPublico());
      assert.equal(link, 'https://erp.brobond.com.br/convite/abc123');
    });
  });

  test('em dev a porta da API vira a porta do front (senão o link abre 404)', () => {
    return comAppUrl(undefined, () => {
      const antes = process.env.PORT;
      process.env.PORT = '3001';
      try {
        assert.equal(urlBasePublica(mockReq({ 'x-forwarded-proto': 'http', host: 'localhost:3001' })), 'http://localhost:5173');
        // host não-local (ex.: túnel/preview) é preservado tal como está
        assert.equal(
          urlBasePublica(mockReq({ 'x-forwarded-proto': 'https', host: 'abc-5173.preview.app' })),
          'https://abc-5173.preview.app'
        );
      } finally {
        if (antes === undefined) delete process.env.PORT;
        else process.env.PORT = antes;
      }
    });
  });

  test('produção sem APP_URL e sem requisição (cron): sem origem inventada', () => {
    const antes = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      return comAppUrl(undefined, () => {
        assert.equal(urlBasePublica(), '', 'nada de origem falsa em produção');
        assert.equal(linkPublico('convite/abc'), '/convite/abc');
        assert.equal(urlAbsoluta(linkPublico('convite/abc')), false, 'o chamador detecta (urlAbsoluta) e avisa');
      });
    } finally {
      process.env.NODE_ENV = antes;
    }
  });

  test('APP_URL inválida não derruba o convite: cai para a origem da requisição', () => {
    return comAppUrl('javascript:alert(1)', () => {
      assert.equal(linkPublico('convite/abc', reqPublico()), 'https://erp.brobond.com.br/convite/abc');
    });
  });
});

// ---------- 2) o fluxo do convite ----------
describe('Convite de acesso — link que abre no e-mail', () => {
  test('gerarConvite devolve link ABSOLUTO mesmo sem APP_URL (origem da requisição)', async () => {
    await comAppUrl(undefined, async () => {
      const { gerarConvite } = await import('../src/usuariosAdmin');
      const row = await novoUsuario({ nome: 'Sócio Admin' });
      const r = await gerarConvite(row as any, { id: 1, name: 'Admin' }, undefined, reqPublico());
      assert.equal(r.entregue, false, 'sem SMTP o e-mail não sai — o link volta para entrega manual');
      assert.match(String(r.link), /^https:\/\/erp\.brobond\.com\.br\/convite\/[a-f0-9]{64}$/, 'link completo, com esquema e domínio');
    });
  });

  test('usuário criado pela API recebe convite com link absoluto (regressão do "URL inválida")', async () => {
    await comAppUrl(APP_URL_TESTE, async () => {
      const { createRecord, getRecord } = await import('../src/services');
      const criado: any = await createRecord(
        RESOURCES.usuarios,
        { nome: 'Sócio Brobond', email: `socio.api${Date.now()}@brobond.com.br`, perfil: 'admin' },
        { id: 1, name: 'Admin', perfil: 'admin' },
        { req: reqPublico() }
      );
      assert.ok(criado.id, 'usuário criado');
      const link = String(criado.convite_link || '');
      assert.ok(link, 'sem SMTP o link volta na resposta para entrega manual');
      assert.match(link, /^https:\/\/erp\.brobond\.com\.br\/convite\/[a-f0-9]{64}$/, 'link absoluto montado a partir do APP_URL');
      assert.ok(!link.includes('//convite'), 'sem barra duplicada');

      // O link precisa resolver de fato: o mesmo token é aceito pela tela de convite.
      const token = link.split('/').pop()!;
      const { infoConvite } = await import('../src/usuariosAdmin');
      let payload: any;
      let status = 0;
      const res: any = {
        json: (d: any) => ((payload = d), res),
        status: (s: number) => ((status = s), res),
      };
      await infoConvite({ params: { token } } as any, res);
      assert.equal(status, 0, `o token do link deve ser válido (status=${status})`);
      assert.equal(payload.nome, 'Sócio Brobond');
      assert.equal(payload.expirado, false);
      const visto = await getRecord(RESOURCES.usuarios, Number(criado.id));
      assert.equal(visto.senha_status, 'convite_pendente', 'conta fica pendente até o aceite');
    });
  });

  test('e-mail do convite traz o endereço copiável e escapa o nome', async () => {
    await comAppUrl(APP_URL_TESTE, async () => {
      const { gerarConvite } = await import('../src/usuariosAdmin');
      const row = await novoUsuario({ nome: '<script>alert(1)</script> Sócio', email: `socio.html${Date.now()}@brobond.com.br` });
      const saida = await capturarConsole(async () => {
        await gerarConvite(row as any, { id: 1, name: 'Admin' }, undefined, reqPublico());
      });
      assert.ok(saida.includes('https://erp.brobond.com.br/convite/'), 'endereço completo também em texto');
      assert.ok(!saida.includes('<script>'), 'nome nunca é injetado como HTML');
    });
  });

  test('reenviar-convite mantém a origem absoluta do link', async () => {
    await comAppUrl(APP_URL_TESTE, async () => {
      const { reenviarConvite } = await import('../src/usuariosAdmin');
      const row: any = await novoUsuario({ nome: 'Sócio Reenvio' });
      let payload: any;
      const res: any = { json: (d: any) => ((payload = d), res) };
      const req: any = { ...reqPublico(), user: { id: 1, name: 'Admin', perfil: 'admin' }, params: { id: String(row.id) } };
      await reenviarConvite(req, res);
      assert.match(String(payload.convite_link), /^https:\/\/erp\.brobond\.com\.br\/convite\/[a-f0-9]{64}$/);
    });
  });
});

// ---------- 3) "esqueci minha senha" ----------
describe('Redefinição de senha — mesmo contrato de link', () => {
  test('link do reset é absoluto mesmo sem APP_URL', async () => {
    await comAppUrl(undefined, async () => {
      const row: any = await novoUsuario({ email: `socio.reset${Date.now()}@brobond.com.br` });
      const { hashPassword } = await import('../src/password');
      await getStore().update(RESOURCES.usuarios, Number(row.id), {
        senha_hash: await hashPassword(SENHA_FORTE()),
        senha_definida_em: new Date().toISOString(),
      });
      const { forgotPassword } = await import('../src/auth');
      let respondido: any;
      const res: any = { json: (d: any) => ((respondido = d), res) };
      const req = { ...reqPublico(), body: { email: row.email } };
      const saida = await capturarConsole(async () => {
        await forgotPassword(req as any, res);
      });
      assert.equal(respondido.ok, true, 'resposta sempre ok (não revela se o e-mail existe)');
      assert.match(saida, /https:\/\/erp\.brobond\.com\.br\/redefinir\/[a-f0-9]{64}/, 'link absoluto no e-mail de reset');
      assert.ok(!/(?:^|\s)\/redefinir\//.test(saida), 'nunca sai link pela metade');
    });
  });
});
// ---------- 4) o token que chega sujo do e-mail ----------
describe('Token copiado do link — tolerante à pontuação do cliente de e-mail', () => {
  test('limparToken remove o que a borda do link gruda no token', async () => {
    const { limparToken } = await import('../src/validate');
    const hex = 'a'.repeat(64);
    assert.equal(limparToken(`  ${hex}  `), hex, 'espaços');
    assert.equal(limparToken(`${hex}.`), hex, 'ponto final da frase');
    assert.equal(limparToken(`${hex}/`), hex, 'barra final');
    assert.equal(limparToken(`${hex})`), hex, 'parêntese do parágrafo');
    assert.equal(limparToken(`<${hex}>`), hex, 'colchetes do <a href>');
    assert.equal(limparToken(`"${hex}",`), hex, 'aspas + vírgula');
    assert.equal(limparToken(`${hex}?utm=1`), `${hex}?utm=1`, 'query não é pontuação de borda: o hash não casa e o convite é recusado');
    assert.equal(limparToken(undefined), '');
  });

  test('convite aceito mesmo com o token chegando sujo do link', async () => {
    await comAppUrl(APP_URL_TESTE, async () => {
      const { gerarConvite, aceitarConvite } = await import('../src/usuariosAdmin');
      const row: any = await novoUsuario({ nome: 'Sócio Pontuação' });
      const r = await gerarConvite(row, { id: 1, name: 'Admin' }, undefined, reqPublico());
      const token = String(r.link).split('/').pop()!;
      assert.match(token, /^[a-f0-9]{64}$/, 'token hex no link');
      const senha = `Convite#Forte${Date.now()}`;
      const res: any = { json: () => res, status: () => res };
      // foi assim que o link chegou do e-mail: com ponto e barra sobrando
      await aceitarConvite(mockReq({}, { body: { token: `${token}.`, senha } }), res);
      const { verifyPasswordDetailed } = await import('../src/password');
      const bruto: any = (await getStore().listUsuariosRaw()).find((u: any) => Number(u.id) === Number(row.id));
      assert.equal((await verifyPasswordDetailed(senha, String(bruto.senha_hash))).ok, true, 'senha definida pelo convite');
      assert.equal(bruto.convite_token_hash, null, 'token de uso único consumido');
    });
  });
});
