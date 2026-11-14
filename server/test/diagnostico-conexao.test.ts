// ============================================================================
// DIAGNÓSTICO DE CONEXÃO — decisão de destino (função PURA, sem banco).
//
// Prova que a confirmação do destino é FECHADA: só aprova quando o host é do
// Neon, o projeto está declarado, a branch esperada é confirmada e o schema é
// do ERP. Qualquer sinal ausente REPROVA — nunca aprova por omissão.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  avaliarDestino,
  MARCADOR_PADRAO,
  SUFIXO_HOST_NEON,
  type IdentidadeConexao,
} from '../src/ops/diagnostico-conexao';

function identidade(over: Partial<IdentidadeConexao> = {}): IdentidadeConexao {
  return {
    origem: 'ep-brobond-123456.sa-east-1.aws.neon.tech:5432/neondb',
    host: `ep-brobond-123456.sa-east-1.aws${SUFIXO_HOST_NEON}`,
    banco: 'neondb',
    usuario: 'neondb_owner',
    schema: 'public',
    versao: 'PostgreSQL 17.2 on x86_64-pc-linux-gnu',
    agora: '2026-11-12T14:00:00.000Z',
    ssl: true,
    neon: {
      projetoId: 'dry-heart-13671059',
      branchId: 'br-curly-wave-123456',
      branchNome: 'production',
      endpointId: 'ep-brobond-123456',
      timelineId: 'tl-abc',
    },
    migracoesPresentes: true,
    marcadorPresente: true,
    ...over,
  };
}

const esperadoProducao = { projetoId: 'dry-heart-13671059', branchNome: 'production' };

test('aprova a branch de produção do projeto no Neon', () => {
  const r = avaliarDestino(identidade(), esperadoProducao);
  assert.equal(r.ok, true);
  assert.deepEqual(r.verificacoes.filter((v) => !v.ok), []);
});

test('reprova host que não é do Neon', () => {
  const r = avaliarDestino(identidade({ host: 'db.internal.example.com' }), esperadoProducao);
  assert.equal(r.ok, false);
  assert.equal(r.verificacoes.find((v) => v.nome === 'host-neon')?.ok, false);
});

test('reprova projeto diferente do esperado', () => {
  const r = avaliarDestino(identidade({ neon: { ...identidade().neon, projetoId: 'outro-projeto' } }), esperadoProducao);
  assert.equal(r.ok, false);
  assert.equal(r.verificacoes.find((v) => v.nome === 'projeto-neon')?.ok, false);
});

test('reprova quando o servidor não declara o projeto Neon (sem sinal não há aprovação)', () => {
  const r = avaliarDestino(identidade({ neon: { ...identidade().neon, projetoId: null } }), esperadoProducao);
  assert.equal(r.ok, false);
  assert.match(r.verificacoes.find((v) => v.nome === 'projeto-neon')!.detalhe, /ausente/);
});

test('reprova branch diferente de production', () => {
  const r = avaliarDestino(identidade({ neon: { ...identidade().neon, branchNome: 'main' } }), esperadoProducao);
  assert.equal(r.ok, false);
  assert.equal(r.verificacoes.find((v) => v.nome === 'branch-confirmada')?.ok, false);
});

test('reprova branch não confirmável (sem nome e sem id esperado)', () => {
  const r = avaliarDestino(
    identidade({ neon: { projetoId: 'p', branchId: null, branchNome: null, endpointId: null, timelineId: null } }),
    esperadoProducao
  );
  assert.equal(r.ok, false);
  assert.match(r.verificacoes.find((v) => v.nome === 'branch-confirmada')!.detalhe, /não confirmável/);
});

test('confirma a branch pelo id quando o nome não é exposto', () => {
  const r = avaliarDestino(
    identidade({ neon: { ...identidade().neon, branchNome: null } }),
    { projetoId: 'dry-heart-13671059', branchId: 'br-curly-wave-123456' }
  );
  assert.equal(r.ok, true);
});

test('reprova schema sem a tabela-marcador do ERP', () => {
  const r = avaliarDestino(identidade({ marcadorPresente: false }), esperadoProducao);
  assert.equal(r.ok, false);
  assert.equal(r.verificacoes.find((v) => v.nome === 'schema-erp')?.ok, false);
});

test('o marcador padrão é `empresas`', () => {
  assert.equal(MARCADOR_PADRAO, 'empresas');
});
