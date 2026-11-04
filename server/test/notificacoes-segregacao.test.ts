// R-12 (Ordem integral, Fase 4.2/4.3) — segregação integral das notificações.
// LOCAL: store em memória, envio capturado por injeção (nenhum e-mail real, nenhuma rede).
// Regras: (A) operacional = dados de uma empresa, só para destinatários ativos vinculados a ela;
// (B) corporativo = comunicado institucional, sem dados operacionais, só para administradores ativos.
// Os dois fluxos não se misturam. Variável global (NOTIFICAR_EMAILS) só restringe, nunca amplia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { getStore } = await import('../src/services');
const { getResource } = await import('../src/resources');
const N = await import('../src/notifications');
const s = getStore();

type Envio = { to: string; html: string; assunto: string };
const capturar = () => {
  const envios: Envio[] = [];
  const enviar = async (o: any) => { envios.push({ to: o.to, html: o.html, assunto: o.assunto }); return { ok: true } as any; };
  return { envios, enviar };
};

const ENV_KEYS = ['NOTIFICAR_EMAILS', 'SCHEDULE_EMAILS', 'NOTIFICAR_PEDIDO', 'NOTIFICAR_OP_CONCLUIDA', 'NOTIFICAR_ESTOQUE_MIN'];
const envAnterior: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function restaurarEnv() {
  for (const k of ENV_KEYS) {
    if (envAnterior[k] === undefined) delete process.env[k]; else process.env[k] = envAnterior[k];
  }
}
process.env.NOTIFICAR_PEDIDO = 'true';
process.env.NOTIFICAR_OP_CONCLUIDA = 'true';
process.env.NOTIFICAR_ESTOQUE_MIN = 'true';

async function cenario() {
  const sufixo = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const empA = Number((await s.insert(getResource('empresas')!, { nome: `Alfa ${sufixo}` } as any)).id);
  const empB = Number((await s.insert(getResource('empresas')!, { nome: `Beta ${sufixo}` } as any)).id);
  const usuarios = (s as any).table('usuarios');
  const vinculos = getResource('usuario_empresas')!;
  const criar = async (nome: string, empresa: number, extra: Record<string, unknown> = {}) => {
    const email = `${nome.toLowerCase()}.${sufixo}@teste.local`;
    const u = await s.insert(getResource('usuarios')!, { nome, email, perfil: 'gerente', ...extra } as any);
    usuarios.rows.get(Number(u.id)).empresa_id = empresa;
    await s.insert(vinculos, { usuario_id: Number(u.id), empresa_id: empresa } as any);
    return email;
  };
  const ana = await criar('Ana', empA);
  const bia = await criar('Bia', empB);
  const exp = await criar('Exp', empA, { acesso_expira_em: '2000-01-01' });
  const prodA = await s.insert(getResource('produtos')!, { empresa_id: empA, nome: `PROD-ALFA-${sufixo}` } as any);
  const prodB = await s.insert(getResource('produtos')!, { empresa_id: empB, nome: `PROD-BETA-${sufixo}` } as any);
  const prodSemEmpresa = await s.insert(getResource('produtos')!, { nome: `PROD-ORFAO-${sufixo}` } as any);
  const insA = await s.insert(getResource('insumos')!, { empresa_id: empA, nome: `INS-ALFA-${sufixo}`, unidade: 'kg' } as any);
  const insB = await s.insert(getResource('insumos')!, { empresa_id: empB, nome: `INS-BETA-${sufixo}`, unidade: 'kg' } as any);
  const cliA = await s.insert(getResource('clientes')!, { empresa_id: empA, nome: `CLI-ALFA-${sufixo}` } as any);
  const vendaA = await s.insert(getResource('vendas')!, { empresa_id: empA, status: 'faturada', total: 1111, cliente_id: Number(cliA.id) } as any);
  const vendaB = await s.insert(getResource('vendas')!, { empresa_id: empB, status: 'faturada', total: 2222 } as any);
  return { sufixo, empA, empB, ana, bia, exp, prodA: Number(prodA.id), prodB: Number(prodB.id), prodSemEmpresa: Number(prodSemEmpresa.id), insA: Number(insA.id), insB: Number(insB.id), vendaA: Number(vendaA.id), vendaB: Number(vendaB.id), cliA: Number(cliA.id) };
}

test('operacional: estoque mínimo de A vai só para o vinculado a A (global inclui B: não recebe)', async () => {
  const c = await cenario();
  process.env.NOTIFICAR_EMAILS = `${c.ana},${c.bia},${c.exp}`;
  const { envios, enviar } = capturar();
  await N.notificarEstoqueMinimo(c.prodA, 0, 'Loja A', 1, 5, enviar as any);
  assert.ok(envios.some((e) => e.to === c.ana), 'Ana (A) recebe');
  assert.ok(!envios.some((e) => e.to === c.bia), 'Bia (B) NÃO recebe dado de A via variável global');
  assert.ok(!envios.some((e) => e.to === c.exp), 'acesso expirado NÃO recebe');
});

test('operacional: insumo mínimo de A não chega a B e não traz dado de B', async () => {
  const c = await cenario();
  process.env.NOTIFICAR_EMAILS = `${c.ana},${c.bia}`;
  const { envios, enviar } = capturar();
  await (N as any).notificarInsumoMinimo(c.insA, 1, 5, enviar);
  assert.ok(envios.some((e) => e.to === c.ana), 'Ana recebe o alerta de insumo de A');
  assert.ok(!envios.some((e) => e.to === c.bia), 'Bia NÃO recebe');
  assert.ok(envios.every((e) => !e.html.includes(`INS-BETA-`)), 'nenhum e-mail traz insumo de B');
});

test('operacional: OP concluída (produto de A) não chega a B', async () => {
  const c = await cenario();
  process.env.NOTIFICAR_EMAILS = `${c.ana},${c.bia}`;
  const { envios, enviar } = capturar();
  await (N as any).notificarOPConcluida(1, c.prodA, 10, 'op', enviar);
  assert.ok(envios.some((e) => e.to === c.ana), 'Ana recebe');
  assert.ok(!envios.some((e) => e.to === c.bia), 'Bia NÃO recebe');
});

test('operacional: venda faturada de A traz cliente de A e não chega a B', async () => {
  const c = await cenario();
  process.env.NOTIFICAR_EMAILS = `${c.ana},${c.bia}`;
  const { envios, enviar } = capturar();
  await (N as any).notificarVendaFaturada(c.vendaA, c.cliA, 1111, 'op', enviar);
  assert.ok(envios.some((e) => e.to === c.ana), 'Ana recebe a venda de A');
  assert.ok(!envios.some((e) => e.to === c.bia), 'Bia NÃO recebe a venda de A');
  assert.ok(envios.every((e) => !e.html.includes('2222')), 'nenhum e-mail traz valor da venda de B');
});

test('operacional: registro sem empresa identificada não é enviado a ninguém', async () => {
  const c = await cenario();
  process.env.NOTIFICAR_EMAILS = `${c.ana},${c.bia}`;
  const { envios, enviar } = capturar();
  await N.notificarEstoqueMinimo(c.prodSemEmpresa, 0, 'Loja X', 1, 5, enviar as any);
  assert.equal(envios.length, 0, 'sem empresa, nada é enviado');
});

test('operacional: sem destinatário vinculado à empresa, não envia (lista global não serve de fallback)', async () => {
  const c = await cenario();
  process.env.NOTIFICAR_EMAILS = `${c.bia}`;
  const { envios, enviar } = capturar();
  await N.notificarEstoqueMinimo(c.prodA, 0, 'Loja A', 1, 5, enviar as any);
  assert.equal(envios.length, 0, 'nenhum destinatário de A na lista: nada enviado (nem a B)');
});

test('status de notificações não expõe a lista global de e-mails', async () => {
  const c = await cenario();
  process.env.NOTIFICAR_EMAILS = `${c.ana},${c.bia}`;
  const st = JSON.stringify(N.notificacoesStatus());
  assert.ok(!st.includes(c.ana) && !st.includes(c.bia), 'nenhum e-mail da lista global no status');
});

test('corporativo: canal separado recusa qualquer dado operacional', async () => {
  const C: any = await import('../src/notificacoesCorporativas');
  process.env.NOTIFICAR_EMAILS = 'admin@x.test';
  await assert.rejects(
    () => C.enviarComunicadoCorporativo({ finalidade: 'comunicado_institucional', assunto: 'A', html: '<p>x</p>', dadosOperacionais: true }, async () => ({ ok: true })),
    /dados operacionais/i,
  );
});

test('corporativo: finalidade sem autorização própria é recusada', async () => {
  const C: any = await import('../src/notificacoesCorporativas');
  await assert.rejects(
    () => C.enviarComunicadoCorporativo({ finalidade: 'marketing', assunto: 'A', html: '<p>x</p>', dadosOperacionais: false }, async () => ({ ok: true })),
    /finalidade/i,
  );
});

test('corporativo: só administradores ativos da lista recebem; gerente da lista não', async () => {
  const C: any = await import('../src/notificacoesCorporativas');
  const sufixo = `${Date.now()}-corp`;
  const usuarios = (s as any).table('usuarios');
  const admin = await s.insert(getResource('usuarios')!, { nome: 'Adm', email: `adm.${sufixo}@teste.local`, perfil: 'admin' } as any);
  const ger = await s.insert(getResource('usuarios')!, { nome: 'Ger', email: `ger.${sufixo}@teste.local`, perfil: 'gerente' } as any);
  void usuarios;
  process.env.NOTIFICAR_EMAILS = `adm.${sufixo}@teste.local,ger.${sufixo}@teste.local`;
  const { envios, enviar } = capturar();
  await C.enviarComunicadoCorporativo({ finalidade: 'comunicado_institucional', assunto: 'Comunicado', html: '<p>Institucional</p>', dadosOperacionais: false }, enviar);
  assert.ok(envios.some((e) => e.to === `adm.${sufixo}@teste.local`), 'admin ativo recebe');
  assert.ok(!envios.some((e) => e.to === `ger.${sufixo}@teste.local`), 'gerente NÃO recebe comunicado corporativo');
  void admin; void ger;
});

test.after(() => restaurarEnv());
