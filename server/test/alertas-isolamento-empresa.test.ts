// R-12 (Fase 4.2) — isolamento dos relatórios de alerta por empresa.
// LOCAL: store em memória, e-mail capturado por injeção (nenhum envio real), sem rede.
// Regras testadas: cada relatório lê só dados da empresa; destinatário é usuário ativo,
// vinculado à empresa e com acesso aos dados enviados; sem identificação segura não envia;
// falha de webhook (sem empresa) não entra em relatório por empresa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { getStore } = await import('../src/services');
const { getResource } = await import('../src/resources');
const { R_ENTREGAS, R_WEBHOOKS } = await import('../src/webhooks');
const S = await import('../src/scheduled');
const s = getStore();

type Envio = { to: string; html: string; assunto: string };
const capturar = () => {
  const envios: Envio[] = [];
  const enviar = async (o: any) => { envios.push({ to: o.to, html: o.html, assunto: o.assunto }); return { ok: true } as any; };
  return { envios, enviar };
};

async function cenario() {
  const sufixo = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const empA = Number((await s.insert(getResource('empresas')!, { nome: `Empresa Alfa ${sufixo}` } as any)).id);
  const empB = Number((await s.insert(getResource('empresas')!, { nome: `Empresa Beta ${sufixo}` } as any)).id);
  const ana = `ana.${sufixo}@teste.local`;
  const bia = `bia.${sufixo}@teste.local`;
  const exp = `exp.${sufixo}@teste.local`;
  const fantasma = `fantasma.${sufixo}@teste.local`;
  // O recurso `usuarios` não declara empresa_id (o banco tem a coluna pela migração 0017).
  // No store em memória, a coluna é semeada direto na linha, como o banco a guarda.
  const usuarios = (s as any).table('usuarios');
  const criarUsuario = async (nome: string, email: string, empresa: number, extra: Record<string, unknown> = {}) => {
    const u = await s.insert(getResource('usuarios')!, { nome, email, perfil: 'gerente', ...extra } as any);
    usuarios.rows.get(Number(u.id)).empresa_id = empresa;
    return u;
  };
  await criarUsuario('Ana', ana, empA);
  await criarUsuario('Bia', bia, empB);
  await criarUsuario('Exp', exp, empA, { acesso_expira_em: '2000-01-01' });
  const prodA = await s.insert(getResource('produtos')!, { empresa_id: empA, nome: `PROD-ALFA-${sufixo}` } as any);
  const prodB = await s.insert(getResource('produtos')!, { empresa_id: empB, nome: `PROD-BETA-${sufixo}` } as any);
  await s.insert(getResource('estoques')!, { empresa_id: empA, produto_id: Number(prodA.id), local: 'Loja A', quantidade: 1, estoque_min: 5 } as any);
  await s.insert(getResource('estoques')!, { empresa_id: empB, produto_id: Number(prodB.id), local: 'Loja B', quantidade: 2, estoque_min: 9 } as any);
  const agora = new Date().toISOString();
  const hoje = agora.slice(0, 10);
  await s.insert(getResource('vendas')!, { empresa_id: empA, status: 'faturada', total: 1234, faturada_em: hoje, comissao_valor: 0 } as any);
  await s.insert(getResource('vendas')!, { empresa_id: empB, status: 'faturada', total: 98765.43, faturada_em: hoje, comissao_valor: 0 } as any);
  await s.insert(getResource('commerce_outbox')!, { empresa_id: empA, tipo: `TIPO-ALFA-${sufixo}`, chave: `oa-${sufixo}`, estado: 'ERRO', tentativas: 10, criado_em: agora, atualizado_em: agora, proxima_tentativa_em: agora } as any);
  await s.insert(getResource('commerce_outbox')!, { empresa_id: empB, tipo: `TIPO-BETA-${sufixo}`, chave: `ob-${sufixo}`, estado: 'ERRO', tentativas: 10, criado_em: agora, atualizado_em: agora, proxima_tentativa_em: agora } as any);
  const w = await s.insert(R_WEBHOOKS, { nome: `W-GLOBAL-${sufixo}`, url: 'https://exemplo.test/global', eventos: 'x', ativo: true, segredo: 'x' } as any);
  await s.insert(R_ENTREGAS, { webhook_id: Number(w.id), evento: `EVENTO-GLOBAL-${sufixo}`, payload: '{}', estado: 'erro', tentativas: 1, concluida_em: agora } as any);
  return { sufixo, empA, empB, ana, bia, exp, fantasma };
}

test('alertas: cada destinatário recebe só os dados da própria empresa', async () => {
  const c = await cenario();
  process.env.SCHEDULE_EMAILS = `${c.ana},${c.bia}`;
  const { envios, enviar } = capturar();
  await S.relatorioAlertas(enviar);
  const paraAna = envios.filter((e) => e.to === c.ana);
  const paraBia = envios.filter((e) => e.to === c.bia);
  assert.ok(paraAna.length >= 1, 'ana (empresa A) recebe o relatório da empresa A');
  assert.ok(paraBia.length >= 1, 'bia (empresa B) recebe o relatório da empresa B');
  for (const e of paraAna) {
    assert.ok(e.html.includes(`PROD-ALFA-${c.sufixo}`), 'relatório de A traz produto de A');
    assert.ok(!e.html.includes(`PROD-BETA-${c.sufixo}`), 'relatório de A NÃO traz produto de B');
  }
  for (const e of paraBia) {
    assert.ok(e.html.includes(`PROD-BETA-${c.sufixo}`), 'relatório de B traz produto de B');
    assert.ok(!e.html.includes(`PROD-ALFA-${c.sufixo}`), 'relatório de B NÃO traz produto de A');
  }
});

test('alertas: falha de fila só aparece no relatório da empresa dona (sem vazamento cruzado)', async () => {
  const c = await cenario();
  process.env.SCHEDULE_EMAILS = `${c.ana},${c.bia}`;
  const { envios, enviar } = capturar();
  await S.relatorioAlertas(enviar);
  const htmlAna = envios.filter((e) => e.to === c.ana).map((e) => e.html).join('\n');
  const htmlBia = envios.filter((e) => e.to === c.bia).map((e) => e.html).join('\n');
  assert.ok(htmlAna.includes(`TIPO-ALFA-${c.sufixo}`), 'falha da empresa A aparece para A');
  assert.ok(!htmlAna.includes(`TIPO-BETA-${c.sufixo}`), 'falha da empresa B NÃO aparece para A');
  assert.ok(htmlBia.includes(`TIPO-BETA-${c.sufixo}`), 'falha da empresa B aparece para B');
  assert.ok(!htmlBia.includes(`TIPO-ALFA-${c.sufixo}`), 'falha da empresa A NÃO aparece para B');
});

test('alertas: falha de webhook (sem empresa no esquema) não entra em relatório por empresa', async () => {
  const c = await cenario();
  process.env.SCHEDULE_EMAILS = `${c.ana},${c.bia}`;
  const { envios, enviar } = capturar();
  await S.relatorioAlertas(enviar);
  for (const e of envios) assert.ok(!e.html.includes(`EVENTO-GLOBAL-${c.sufixo}`), 'webhook global não vaza para relatório de empresa');
});

test('alertas: destinatário sem vínculo/identificação segura não recebe nada', async () => {
  const c = await cenario();
  process.env.SCHEDULE_EMAILS = `${c.fantasma},${c.exp}`;
  const { envios, enviar } = capturar();
  await S.relatorioAlertas(enviar);
  assert.equal(envios.length, 0, 'e-mail sem usuário correspondente e acesso expirado não recebem relatório');
});

test('alertas: sem destinatário identificado para uma empresa, os dados dela não são enviados a ninguém', async () => {
  const c = await cenario();
  process.env.SCHEDULE_EMAILS = `${c.ana}`;
  const { envios, enviar } = capturar();
  await S.relatorioAlertas(enviar);
  assert.ok(envios.every((e) => e.to === c.ana), 'só o destinatário identificado de A recebe');
  assert.ok(envios.every((e) => !e.html.includes(`PROD-BETA-${c.sufixo}`)), 'dados de B não saem sem destinatário de B');
});

test('posição de estoque e vendas: relatório por empresa, sem totais de outra empresa', async () => {
  const c = await cenario();
  process.env.SCHEDULE_EMAILS = `${c.ana},${c.bia}`;
  const { envios, enviar } = capturar();
  await S.relatorioVendas(enviar);
  await S.relatorioPosicaoEstoque(enviar);
  const paraAna = envios.filter((e) => e.to === c.ana).map((e) => e.html).join('\n');
  assert.ok(!paraAna.includes('98.765,43'), 'total de vendas da empresa B não aparece para A');
  assert.ok(!paraAna.includes(`PROD-BETA-${c.sufixo}`), 'estoque de B não aparece para A');
  assert.ok(paraAna.includes(`PROD-ALFA-${c.sufixo}`), 'estoque de A aparece para A');
});

test('lembrete de CRM (ativo no agendador): só destinatários vinculados à empresa da atividade recebem', async () => {
  const c = await cenario();
  process.env.NOTIFICAR_EMAILS = `${c.ana},${c.bia}`;
  process.env.NOTIFICAR_CRM_LEMBRETE = 'true';
  const N = await import('../src/notifications');
  const { envios, enviar } = capturar();
  await N.notificarLembreteCrm({
    empresaId: c.empA, atividadeId: 1, tipo: 'ligar', resumo: 'r', quando: null, prioridade: 'alta',
    lead: `LEAD-ALFA-${c.sufixo}`, oportunidade: null,
  }, enviar as any);
  assert.ok(envios.some((e) => e.to === c.ana), 'ana (empresa A) recebe o lembrete de A');
  assert.ok(!envios.some((e) => e.to === c.bia), 'bia (empresa B) NÃO recebe lembrete de A');
  assert.ok(envios.every((e) => e.html.includes(`LEAD-ALFA-${c.sufixo}`)));
});

test('notificações de evento sem empresa explícita não são enviadas pela lista global', async () => {
  const c = await cenario();
  process.env.NOTIFICAR_EMAILS = `${c.ana},${c.bia}`;
  process.env.NOTIFICAR_ESTOQUE_MIN = 'true';
  const N = await import('../src/notifications');
  const { envios, enviar } = capturar();
  await N.notificarEstoqueMinimo(1, 1, 'Loja', 0, 5, enviar as any);
  assert.equal(envios.length, 0, 'evento sem escopo de empresa não vai para a lista global');
});
