// ============================================================================
// GATES DA AUDITORIA DE CAPACIDADES (PR #95)
//   Garantir que o problema encontrado neste ciclo não volte:
//   • capacidade operacional sem entrada no menu → falha;
//   • rota sem página → falha;
//   • resource operacional sem dono funcional → falha;
//   • módulo "planned" com backend funcional → falha.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditarCapacidades, carregarRegistro, type Capacidade } from '../../scripts/capacidades-audit';
import type { Module } from '../../client/src/modules';

test('o registro canônico de capacidades passa sem ERRO', () => {
  const { erros, contadores } = auditarCapacidades(carregarRegistro());
  assert.equal(erros.length, 0, `erros: ${JSON.stringify(erros, null, 2)}`);
  assert.ok(contadores.capacidades > 0);
});

test('capacidade com menu:true sem módulo na árvore falha (CAPACIDADE_SEM_MENU)', () => {
  const reg = {
    versao: 't',
    capacidades: [{ id: 'cap-fantasma', label: 'Fantasma', tipo: 'submodulo', menu: true } as Capacidade],
  };
  const { erros } = auditarCapacidades(reg);
  assert.ok(erros.some((e) => e.regra === 'CAPACIDADE_SEM_MENU'), JSON.stringify(erros));
});

test('rota sem página falha (ROTA_SEM_PAGINA)', () => {
  const reg = {
    versao: 't',
    capacidades: [
      { id: 'cap-rota', label: 'Rota órfã', tipo: 'acao', rota: '/rota-que-nao-existe-xyz', menu: false, justificativa: 'teste de gate' },
    ],
  };
  const { erros } = auditarCapacidades(reg);
  assert.ok(erros.some((e) => e.regra === 'ROTA_SEM_PAGINA'), JSON.stringify(erros));
});

test('resource operacional sem dono funcional falha (RECURSO_SEM_DONO)', () => {
  // Registro vazio de capacidades: nenhum resource tem dono.
  const { erros } = auditarCapacidades({ versao: 't', capacidades: [] });
  assert.ok(erros.some((e) => e.regra === 'RECURSO_SEM_DONO'), JSON.stringify(erros.slice(0, 3)));
});

test('módulo "planned" com backend funcional falha (PLANNED_OBSOLETO)', () => {
  const moduloFake = {
    id: 'fake-modulo',
    label: 'Fake',
    icon: () => null,
    space: 'erp',
    area: 'Administração',
    group: 'Governança',
    subgroup: 'fake',
    path: '/fake',
    resource: 'produtos',
    planned: ['implementação pendente'],
  } as unknown as Module;
  const { erros } = auditarCapacidades({ versao: 't', capacidades: [] }, undefined, { modulos: [moduloFake] });
  assert.ok(erros.some((e) => e.regra === 'PLANNED_OBSOLETO'), JSON.stringify(erros));
});

test('infraestrutura não pode aparecer no menu (INFRA_NO_MENU)', () => {
  const reg = {
    versao: 't',
    capacidades: [{ id: 'infra-x', label: 'Infra', tipo: 'infra', menu: true } as Capacidade],
  };
  const { erros } = auditarCapacidades(reg);
  assert.ok(erros.some((e) => e.regra === 'INFRA_NO_MENU'), JSON.stringify(erros));
});
