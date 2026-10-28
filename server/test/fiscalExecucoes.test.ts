import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chaveExecucaoFiscal } from '../src/fiscalExecucoes';

describe('SPED/EFD: identificador e migration segura', () => {
  it('gera o mesmo hash de idempotência para a mesma empresa/obrigação/período/versão', () => {
    const a = chaveExecucaoFiscal(1, 27, '2026-09', 'manifesto-oficial-nao-configurado');
    const b = chaveExecucaoFiscal(1, 27, '2026-09', 'manifesto-oficial-nao-configurado');
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);
  });

  it('separa hashes quando qualquer dimensão de idempotência muda', () => {
    const base = chaveExecucaoFiscal(1, 27, '2026-09', 'layout-x');
    assert.notEqual(base, chaveExecucaoFiscal(2, 27, '2026-09', 'layout-x'));
    assert.notEqual(base, chaveExecucaoFiscal(1, 28, '2026-09', 'layout-x'));
    assert.notEqual(base, chaveExecucaoFiscal(1, 27, '2026-10', 'layout-x'));
    assert.notEqual(base, chaveExecucaoFiscal(1, 27, '2026-09', 'layout-y'));
  });

  it('define unicidade tenant-scoped e estados fiscais sem gerar leiaute oficial', () => {
    const sql = readFileSync(new URL('../../db/migrations/0063_fiscal_execucoes_evidencias.sql', import.meta.url), 'utf8');
    assert.match(sql, /UNIQUE \(empresa_id, obrigacao_id, periodo, versao\)/);
    assert.match(sql, /'PENDENTE','EM_PROCESSAMENTO','VALIDADO','ERRO','ENTREGUE'/);
    const migration = readFileSync(new URL('../../db/migrations/0067_fiscal_nao_suportado.sql', import.meta.url), 'utf8');
    assert.match(migration, /'NAO_SUPORTADO'/);
    assert.match(migration, /fiscal_execucoes_status_valido/);
    assert.match(sql, /FOREIGN KEY \(empresa_id, obrigacao_id\)/);
    assert.match(sql, /FOREIGN KEY \(empresa_id, execucao_id\)/);
    assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\s+(?:TABLE|INDEX)\b/i);
    assert.doesNotMatch(sql, /CREATE TABLE[^;]*(?:sped_registros|efd_registros)/i);
  });
});
