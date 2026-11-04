import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.NOTIFICAR_CRM_LEMBRETE = 'true';

const { getStore } = await import('../src/services');
const { getResource } = await import('../src/resources');
const crm = await import('../src/crm');
const s = getStore();

async function atividadeVencida() {
  const sufixo = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const emp = await s.insert(getResource('empresas')!, { nome: `CRM ${sufixo}` } as any);
  const ontem = new Date(Date.now() - 86400000).toISOString();
  const at = await s.insert(getResource('crm_atividades')!, {
    empresa_id: Number(emp.id), status: 'pendente', tipo: 'ligacao', resumo: `R-${sufixo}`, data_atividade: ontem,
  } as any);
  return { emp, at };
}

test('CRM: falha antes do envio não carimba lembrete_enviado_em', async () => {
  const { at } = await atividadeVencida();
  crm.definirEntregaLembreteCrmParaTeste(async (p) => p.atividadeId === Number(at.id) ? false : true);
  try {
    await crm.dispararLembretesCrm();
    const atual = await s.findOneWhere(getResource('crm_atividades')!, { id: Number(at.id) });
    assert.equal(atual?.lembrete_enviado_em ?? null, null);
  } finally {
    crm.definirEntregaLembreteCrmParaTeste(undefined);
  }
});

test('CRM: timeout do canal não carimba e permite retry', async () => {
  const { at } = await atividadeVencida();
  let tentativas = 0;
  crm.definirEntregaLembreteCrmParaTeste(async (p) => {
    if (p.atividadeId !== Number(at.id)) return true;
    tentativas += 1;
    if (tentativas === 1) throw new Error('timeout');
    return true;
  });
  try {
    await crm.dispararLembretesCrm();
    assert.equal((await s.findOneWhere(getResource('crm_atividades')!, { id: Number(at.id) }))?.lembrete_enviado_em ?? null, null);
    await crm.dispararLembretesCrm();
    assert.ok((await s.findOneWhere(getResource('crm_atividades')!, { id: Number(at.id) }))?.lembrete_enviado_em);
    assert.equal(tentativas, 2);
  } finally {
    crm.definirEntregaLembreteCrmParaTeste(undefined);
  }
});

test('CRM: confirmação do canal carimba uma vez; segunda passagem não reenvia', async () => {
  const { at } = await atividadeVencida();
  const envios: number[] = [];
  crm.definirEntregaLembreteCrmParaTeste(async (p) => {
    if (p.atividadeId !== Number(at.id)) return true;
    envios.push(p.atividadeId);
    return true;
  });
  try {
    await crm.dispararLembretesCrm();
    await crm.dispararLembretesCrm();
    const atual = await s.findOneWhere(getResource('crm_atividades')!, { id: Number(at.id) });
    assert.ok(atual?.lembrete_enviado_em, 'carimbo após confirmação');
    assert.equal(envios.filter((id) => id === Number(at.id)).length, 1);
  } finally {
    crm.definirEntregaLembreteCrmParaTeste(undefined);
  }
});

test('CRM: envio ok e CAS perdido não duplica carimbo', async () => {
  const { at } = await atividadeVencida();
  const quando = new Date().toISOString();
  crm.definirEntregaLembreteCrmParaTeste(async (p) => {
    if (p.atividadeId !== Number(at.id)) return true;
    await s.tryUpdateIf(getResource('crm_atividades')!, p.atividadeId, { lembrete_enviado_em: null }, { lembrete_enviado_em: quando });
    return true;
  });
  try {
    await crm.dispararLembretesCrm();
    const atual = await s.findOneWhere(getResource('crm_atividades')!, { id: Number(at.id) });
    assert.equal(String(atual?.lembrete_enviado_em), quando);
  } finally {
    crm.definirEntregaLembreteCrmParaTeste(undefined);
  }
});
