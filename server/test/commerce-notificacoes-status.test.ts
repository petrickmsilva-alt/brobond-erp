import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import nodemailer from 'nodemailer';
import type { Resource } from '../src/resources';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { requireAuth, signToken, invalidateUserCache } = await import('../src/auth');
const { abrirSessao } = await import('../src/sessoes');
const { invalidarCacheEmpresas } = await import('../src/empresasAcesso');
const { HttpError } = await import('../src/errors');
const { log } = await import('../src/log');
const { EVENTOS_NOTIFICACAO, statusNotificacoesCommerce, statusCanaisNotificacao } = await import('../src/commerce/notificacoes');

const s = getStore();
const empresaB = Number((await s.insert(RESOURCES.empresas, { nome: 'Empresa B — diagnóstico teste', ativo: true })).id);
// Colunas reais de identidade do banco, intencionalmente ausentes do formulário
// CRUD de usuários. A fixture em memória precisa persistir essas colunas; o
// requireAuth continua relendo a identidade, a sessão e as concessões reais.
const R_USUARIOS_SESSAO: Resource = {
  ...RESOURCES.usuarios,
  fields: [
    ...RESOURCES.usuarios.fields,
    { name: 'empresa_id', label: 'Empresa padrão', type: 'integer' },
    { name: 'pode_consolidar', label: 'Pode consolidar', type: 'boolean' },
  ],
};
const caminho = '/api/commerce/notificacoes/status';
const variaveis = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'WHATSAPP_CLOUD_API_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_TEMPLATE_TRANSACIONAL',
  'WHATSAPP_TEMPLATE_IDIOMA',
  ...EVENTOS_NOTIFICACAO.map((evento) => `WHATSAPP_TEMPLATE_${evento}`),
  'APP_URL',
  'PUBLIC_BASE_URL',
];
const ambienteOriginal = Object.fromEntries(variaveis.map((nome) => [nome, process.env[nome]]));
const configuracaoCompleta = {
  SMTP_HOST: 'smtp-privado.example.invalid',
  SMTP_PORT: '2465',
  SMTP_USER: 'usuario-smtp-privado',
  SMTP_PASS: 'senha-smtp-somente-fixture',
  SMTP_FROM: 'remetente-privado@example.invalid',
  WHATSAPP_CLOUD_API_TOKEN: 'EAAG-token-meta-somente-fixture',
  WHATSAPP_PHONE_NUMBER_ID: '100000000000007',
  WHATSAPP_TEMPLATE_ORDER_CREATED: 'modelo-privado-pedido-fixture',
  WHATSAPP_TEMPLATE_PAYMENT_APPROVED: 'modelo-privado-pagamento-fixture',
  WHATSAPP_TEMPLATE_TRANSACIONAL: 'modelo-privado-transacional-fixture',
  WHATSAPP_TEMPLATE_IDIOMA: 'pt_BR',
  APP_URL: 'https://base-privada.example.invalid',
};

const wrap = (fn: (req: Request, res: Response, next: NextFunction) => unknown) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Mesmos middleware JWT e handler da rota de produção; não injeta req.user nem
// substitui checkAccess/escopoDoAtor. Nenhum servidor externo é necessário.
const app = express();
app.use(express.json());
app.use('/api', wrap(requireAuth));
app.get(caminho, wrap(statusNotificacoesCommerce));
app.use((erro: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(erro instanceof HttpError ? erro.status : 500).json({ error: erro instanceof HttpError ? erro.message : 'Falha interna.' });
});

let sequencia = 0;
async function sessao(perfil: 'admin' | 'gerente' | 'operador' = 'admin', empresaId = 1, podeConsolidar = false) {
  const user = await s.insert(R_USUARIOS_SESSAO, {
    nome: 'Diagnóstico teste',
    email: `notificacoes-status-${++sequencia}@example.invalid`,
    perfil,
    empresa_id: empresaId,
    pode_consolidar: podeConsolidar,
    ativo: true,
    token_versao: 0,
  });
  const sid = await abrirSessao({ usuarioId: Number(user.id), lembrar: false, req: { headers: {}, socket: {} } as Request });
  const identidade = { id: Number(user.id), name: String(user.nome), email: String(user.email), perfil };
  return { id: Number(user.id), sid, identidade, token: signToken(identidade, { sid, emp: empresaId }) };
}

async function tentativa(empresaId: number, canal: 'EMAIL' | 'WHATSAPP', estado: 'ENVIADO' | 'PENDENTE', erro?: string) {
  return s.insert(RESOURCES.commerce_notificacoes, {
    empresa_id: empresaId,
    pedido_id: 999000 + empresaId,
    evento: 'ORDER_CREATED',
    canal,
    destinatario: 'destinatario-privado@example.invalid',
    template: 'template-privado-fixture',
    chave_idempotencia: `diagnostico:${empresaId}:${canal}:${++sequencia}`,
    tentativas: 1,
    estado,
    provider_status: estado === 'ENVIADO' ? 'REQUEST_ACCEPTED' : null,
    provider_message_id: 'wamid-id-privado-fixture',
    ultimo_erro: erro || null,
    enviado_em: estado === 'ENVIADO' ? '2026-11-03T12:15:00.000Z' : null,
  });
}

beforeEach(async () => {
  for (const nome of variaveis) delete process.env[nome];
  invalidateUserCache();
  invalidarCacheEmpresas();
  const registros = await s.list(RESOURCES.commerce_notificacoes, { page: 1, pageSize: 200 });
  for (const registro of registros.rows) await s.remove(RESOURCES.commerce_notificacoes, Number(registro.id));
});

after(() => {
  for (const [nome, valor] of Object.entries(ambienteOriginal)) {
    if (valor === undefined) delete process.env[nome];
    else process.env[nome] = valor;
  }
});

describe('GET /api/commerce/notificacoes/status — JWT, RBAC e contrato seguro', () => {
  test('a única rota de produção permanece registrada DEPOIS do requireAuth', () => {
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const registro = "app.get('/api/commerce/notificacoes/status', wrap(statusNotificacoesCommerce))";
    assert.equal(index.split(registro).length - 1, 1);
    assert.ok(index.indexOf("app.use('/api', wrap(requireAuth))") < index.indexOf(registro));
  });

  test('administrador e gerente autenticados consultam com 200, data da consulta e no-store', async () => {
    for (const perfil of ['admin', 'gerente'] as const) {
      const ator = await sessao(perfil);
      const res = await request(app).get(caminho).set('Authorization', `Bearer ${ator.token}`).expect(200);
      assert.equal(res.body.ok, true);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.ok(Number.isFinite(new Date(res.body.consultado_em).getTime()));
      assert.equal(res.body.email.status_configuracao, 'NAO_CONFIGURADO');
    }
  });

  test('barra de endereço sem Authorization, JWT inválido e JWT sem sessão recebem HTTP 401', async () => {
    const res = await request(app).get(caminho).expect(401);
    assert.deepEqual(res.body, { error: 'Não autenticado' });
    await request(app).get(caminho).set('Authorization', 'Bearer token-invalido').expect(401);
    const ator = await sessao();
    const semSessao = signToken(ator.identidade);
    await request(app).get(caminho).set('Authorization', `Bearer ${semSessao}`).expect(401);
    const expirado = signToken(ator.identidade, { sid: ator.sid, expiresIn: -60 });
    await request(app).get(caminho).set('Authorization', `Bearer ${expirado}`).expect(401);
  });

  test('operador recebe HTTP 403 e não pode forjar privilégio por headers, query ou claims obsoletos', async () => {
    const ator = await sessao('operador');
    const tokenComPerfilFalso = signToken({ ...ator.identidade, perfil: 'admin' }, { sid: ator.sid });
    await request(app)
      .get(`${caminho}?perfil=admin&role=admin`)
      .set('Authorization', `Bearer ${tokenComPerfilFalso}`)
      .set('x-role', 'admin')
      .expect(403);
    await request(app).get(caminho).set('Authorization', `Bearer ${ator.token}`).expect(403);
  });

  test('revogar a sessão ou rebaixar o perfil continua fechando o acesso', async () => {
    const ator = await sessao();
    await request(app).get(caminho).set('Authorization', `Bearer ${ator.token}`).expect(200);
    await s.update(RESOURCES.usuarios, ator.id, { perfil: 'operador' });
    invalidateUserCache(ator.id);
    await request(app).get(caminho).set('Authorization', `Bearer ${ator.token}`).expect(403);
    await s.revogarSessao(ator.sid);
    invalidateUserCache(ator.id);
    await request(app).get(caminho).set('Authorization', `Bearer ${ator.token}`).expect(401);
  });

  test('ausências são nomes de variáveis; presença de token/phone/modelos e idioma padrão são explícitos', async () => {
    const ator = await sessao();
    const { body } = await request(app).get(caminho).set('Authorization', `Bearer ${ator.token}`).expect(200);
    assert.equal(body.email.smtp_configurado, false);
    assert.equal(body.email.remetente_dedicado, false);
    assert.deepEqual(body.email.variaveis_ausentes, ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']);
    assert.equal(body.whatsapp.token_configurado, false);
    assert.equal(body.whatsapp.phone_number_id_configurado, false);
    assert.deepEqual(body.whatsapp.modelos_configurados, {
      WHATSAPP_TEMPLATE_ORDER_CREATED: false,
      WHATSAPP_TEMPLATE_PAYMENT_APPROVED: false,
      WHATSAPP_TEMPLATE_TRANSACIONAL: false,
    });
    assert.deepEqual(body.whatsapp.variaveis_ausentes, [
      'WHATSAPP_CLOUD_API_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_TEMPLATE_ORDER_CREATED',
      'WHATSAPP_TEMPLATE_PAYMENT_APPROVED',
      'WHATSAPP_TEMPLATE_TRANSACIONAL',
      'WHATSAPP_TEMPLATE_IDIOMA',
    ]);
    assert.ok(body.whatsapp.eventos_sem_template.includes('ORDER_CREATED'));
    assert.ok(body.whatsapp.eventos_sem_template.includes('PAYMENT_APPROVED'));
    assert.equal(body.whatsapp.idioma, 'pt_BR');
    assert.equal(body.whatsapp.idioma_configurado, false);
    assert.deepEqual(body.link_publico.variaveis_ausentes, ['APP_URL', 'PUBLIC_BASE_URL']);
    for (const canal of [body.email, body.whatsapp, body.link_publico]) {
      assert.ok(canal.variaveis_ausentes.every((nome: string) => /^[A-Z][A-Z0-9_]+$/.test(nome)));
    }
  });

  test('resposta não contém valores de configuração, IDs, dados de pedidos nem erros brutos de provedores', async () => {
    Object.assign(process.env, configuracaoCompleta);
    const tokenPedido = 'cafebabe'.repeat(8);
    const segredos = Object.values(configuracaoCompleta).filter((valor) => valor !== 'pt_BR');
    await tentativa(1, 'WHATSAPP', 'PENDENTE', `${segredos.join(' ')} ${tokenPedido} destinatario-privado@example.invalid`);
    const ator = await sessao();
    const { body } = await request(app).get(caminho).set('Authorization', `Bearer ${ator.token}`).expect(200);
    const json = JSON.stringify(body);
    for (const segredo of [
      ...segredos,
      tokenPedido,
      'destinatario-privado@example.invalid',
      'wamid-id-privado-fixture',
      'template-privado-fixture',
    ]) {
      assert.ok(!json.includes(segredo), 'um valor privado não pode aparecer no diagnóstico');
    }
    assert.equal(body.whatsapp.status, 'ERRO');
    assert.equal(body.whatsapp.status_configuracao, 'CONFIGURADO');
    assert.equal(body.whatsapp.ultimo_erro, 'A última tentativa de envio não foi concluída pelo provedor.');
    assert.equal(body.whatsapp.token_configurado, true);
    assert.equal(body.whatsapp.phone_number_id_configurado, true);
    assert.equal(body.whatsapp.idioma, 'pt_BR');
    assert.equal(body.whatsapp.idioma_configurado, true);
    assert.deepEqual(body.whatsapp.eventos_sem_template, []);
    assert.deepEqual(body.whatsapp.variaveis_ausentes, []);
  });

  test('timestamp legado inválido não é copiado como texto arbitrário na resposta', async () => {
    Object.assign(process.env, configuracaoCompleta);
    const linha = await tentativa(1, 'EMAIL', 'ENVIADO');
    await s.update(RESOURCES.commerce_notificacoes, Number(linha.id), { enviado_em: 'segredo-em-timestamp-legado' });
    const ator = await sessao();
    const { body } = await request(app).get(caminho).set('Authorization', `Bearer ${ator.token}`).expect(200);
    assert.equal(body.email.ultimo_envio_em, null);
    assert.ok(!JSON.stringify(body).includes('segredo-em-timestamp-legado'));
  });

  test('código de idioma inválido fica oculto; não há inferência de aprovação dos modelos', async () => {
    process.env.WHATSAPP_TEMPLATE_IDIOMA = 'Bearer segredo-configurado-no-campo-errado';
    const status = statusCanaisNotificacao();
    assert.equal(status.whatsapp.idioma, null);
    assert.equal(status.whatsapp.idioma_configurado, true);
    assert.ok(!JSON.stringify(status).includes(process.env.WHATSAPP_TEMPLATE_IDIOMA));
    assert.doesNotMatch(JSON.stringify(status), /"(?:aprovado|approved|aprovacao|approval_status)"\s*:/i);
  });

  test('modelo específico cobre só seu evento; fallback transacional cobre todos sem revelar nomes configurados', () => {
    process.env.WHATSAPP_CLOUD_API_TOKEN = 'token-fixture';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'phone-fixture';
    process.env.WHATSAPP_TEMPLATE_ORDER_CREATED = 'modelo-especifico-privado';
    const parcial = statusCanaisNotificacao().whatsapp;
    assert.equal(parcial.status_configuracao, 'CONFIGURADO');
    assert.equal(parcial.templates.ORDER_CREATED, true);
    assert.equal(parcial.templates.PAYMENT_APPROVED, false);
    assert.ok(!parcial.eventos_sem_template.includes('ORDER_CREATED'));
    assert.ok(parcial.eventos_sem_template.includes('PAYMENT_APPROVED'));
    process.env.WHATSAPP_TEMPLATE_TRANSACIONAL = 'fallback-privado';
    const completo = statusCanaisNotificacao().whatsapp;
    assert.deepEqual(completo.eventos_sem_template, []);
    assert.ok(Object.values(completo.templates).every(Boolean));
    assert.equal(completo.modelos_configurados.WHATSAPP_TEMPLATE_PAYMENT_APPROVED, false);
    assert.equal(completo.modelos_configurados.WHATSAPP_TEMPLATE_TRANSACIONAL, true);
    assert.ok(!JSON.stringify(completo).includes('privado'));
  });

  test('PUBLIC_BASE_URL continua sendo alternativa válida a APP_URL, sem retornar o endereço', () => {
    process.env.PUBLIC_BASE_URL = 'https://fallback-privado.example.invalid';
    const status = statusCanaisNotificacao().link_publico;
    assert.equal(status.status_configuracao, 'CONFIGURADO');
    assert.deepEqual(status.variaveis_ausentes, []);
    assert.ok(!JSON.stringify(status).includes(process.env.PUBLIC_BASE_URL));
  });
});

describe('Diagnóstico — isolamento multiempresa e ausência de efeitos colaterais', () => {
  test('histórico só da empresa ativa; query, header e consolidação não selecionam outra empresa', async () => {
    Object.assign(process.env, configuracaoCompleta);
    await tentativa(1, 'EMAIL', 'ENVIADO');
    await tentativa(empresaB, 'WHATSAPP', 'PENDENTE', 'ERRO-PRIVADO-OUTRA-EMPRESA');
    const ator = await sessao('admin', 1, true);
    const outraEmpresa = await sessao('gerente', empresaB);
    const { body: a } = await request(app)
      .get(`${caminho}?empresa_id=${empresaB}&f.empresa_id=${empresaB}&consolidado=1`)
      .set('x-empresa-id', String(empresaB))
      .set('Authorization', `Bearer ${ator.token}`)
      .expect(200);
    assert.equal(a.email.status, 'CONECTADO');
    assert.equal(a.email.status_configuracao, 'CONFIGURADO', 'aceite anterior não redefine a configuração local');
    assert.equal(a.email.ultimo_envio_em, '2026-11-03T12:15:00.000Z');
    assert.equal(a.whatsapp.status, 'CONFIGURADO');
    assert.equal(a.whatsapp.ultimo_erro, null);
    assert.ok(!JSON.stringify(a).includes('OUTRA-EMPRESA'));
    const { body: b } = await request(app).get(caminho).set('Authorization', `Bearer ${outraEmpresa.token}`).expect(200);
    assert.equal(b.email.status, 'CONFIGURADO');
    assert.equal(b.email.ultimo_envio_em, null);
    assert.equal(b.whatsapp.status, 'ERRO');
  });

  test('claim emp só seleciona empresa concedida; revogar concessão mantém o isolamento', async () => {
    Object.assign(process.env, configuracaoCompleta);
    await tentativa(1, 'EMAIL', 'ENVIADO');
    await tentativa(empresaB, 'WHATSAPP', 'ENVIADO');
    const ator = await sessao('gerente');
    const tokenEmpresa2 = signToken(ator.identidade, { sid: ator.sid, emp: empresaB });
    const consultar = () => request(app).get(caminho).set('Authorization', `Bearer ${tokenEmpresa2}`).expect(200);
    const semConcessao = await consultar();
    assert.equal(semConcessao.body.email.status, 'CONECTADO');
    assert.equal(semConcessao.body.whatsapp.status, 'CONFIGURADO');
    const concessao = await s.insert(RESOURCES.usuario_empresas, { usuario_id: ator.id, empresa_id: empresaB });
    invalidarCacheEmpresas(ator.id);
    const autorizado = await consultar();
    assert.equal(autorizado.body.email.status, 'CONFIGURADO');
    assert.equal(autorizado.body.whatsapp.status, 'CONECTADO');
    await s.remove(RESOURCES.usuario_empresas, Number(concessao.id));
    invalidarCacheEmpresas(ator.id);
    const revogado = await consultar();
    assert.equal(revogado.body.email.status, 'CONECTADO');
    assert.equal(revogado.body.whatsapp.status, 'CONFIGURADO');
  });

  test('consultar e atualizar não envia mensagens, não abre SMTP, não modifica dados nem registra segredos', async (t) => {
    Object.assign(process.env, configuracaoCompleta);
    await tentativa(1, 'WHATSAPP', 'PENDENTE', 'erro-com-segredo-fixture');
    const ator = await sessao();
    const rede = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('Diagnóstico não pode disparar requisições externas.');
    });
    const smtp = t.mock.method(nodemailer, 'createTransport', () => {
      throw new Error('Diagnóstico não pode abrir SMTP.');
    });
    const escritas = [t.mock.method(s, 'insert'), t.mock.method(s, 'update'), t.mock.method(s, 'remove'), t.mock.method(s, 'tryUpdateIf')];
    const logs = [t.mock.method(log, 'info'), t.mock.method(log, 'warn'), t.mock.method(log, 'error')];
    for (let consulta = 0; consulta < 2; consulta++) {
      await request(app).get(caminho).set('Authorization', `Bearer ${ator.token}`).expect(200);
    }
    assert.equal(rede.mock.callCount(), 0);
    assert.equal(smtp.mock.callCount(), 0);
    for (const escrita of escritas) assert.equal(escrita.mock.callCount(), 0);
    for (const logger of logs) assert.equal(logger.mock.callCount(), 0);
  });
});
