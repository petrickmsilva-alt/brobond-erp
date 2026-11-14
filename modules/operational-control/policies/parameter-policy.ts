// ============================================================================
// CONTROL PLANE › POLÍTICA › PARÂMETROS (PURO)
//
// O cliente só pode enviar os parâmetros DECLARADOS no registro do workflow.
// Chave desconhecida, tipo errado ou valor fora do `enum` são recusados com
// 400. Repositório, arquivo de workflow, comando shell, token ou branch NÃO
// são parâmetros aceitos por construção — o registro não os declara.
//
// O `parameters_hash` é o vínculo entre a operação e a aprovação: mudar
// qualquer parâmetro muda o hash e invalida a aprovação anterior.
// ============================================================================
import { createHash } from 'node:crypto';
import { OperationalError } from '../domain/errors';
import type { WorkflowDefinition, WorkflowParameterSpec } from '../domain/workflow-registry';

/** JSON canônico (chaves ordenadas) — estável entre Postgres (JSONB) e memória. */
function jsonCanonico(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(jsonCanonico).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + jsonCanonico(obj[k]))
      .join(',') +
    '}'
  );
}

export function hashParametros(parameters: Record<string, unknown>): string {
  return createHash('sha256').update(jsonCanonico(parameters)).digest('hex');
}

function validarValor(chave: string, spec: WorkflowParameterSpec, bruto: unknown): unknown {
  if (bruto === undefined || bruto === null) {
    if (spec.required) throw new OperationalError('PARAMETRO_INVALIDO', `O parâmetro "${chave}" é obrigatório.`, { [chave]: 'obrigatório' });
    return null;
  }
  switch (spec.type) {
    case 'integer': {
      const n = typeof bruto === 'number' ? bruto : Number(String(bruto).trim());
      if (!Number.isInteger(n)) throw new OperationalError('PARAMETRO_INVALIDO', `O parâmetro "${chave}" deve ser inteiro.`, { [chave]: 'inteiro' });
      return n;
    }
    case 'boolean': {
      if (typeof bruto === 'boolean') return bruto;
      const s = String(bruto).trim().toLowerCase();
      if (['true', '1', 'sim'].includes(s)) return true;
      if (['false', '0', 'nao', 'não'].includes(s)) return false;
      throw new OperationalError('PARAMETRO_INVALIDO', `O parâmetro "${chave}" deve ser booleano.`, { [chave]: 'booleano' });
    }
    case 'string':
    default: {
      const s = String(bruto);
      if (spec.maxLength && s.length > spec.maxLength) {
        throw new OperationalError('PARAMETRO_INVALIDO', `O parâmetro "${chave}" excede ${spec.maxLength} caracteres.`, { [chave]: 'muito longo' });
      }
      if (spec.enum && !spec.enum.includes(s)) {
        throw new OperationalError('PARAMETRO_INVALIDO', `O parâmetro "${chave}" tem valor não permitido.`, { [chave]: [...spec.enum] });
      }
      return s;
    }
  }
}

/**
 * Valida e NORMALIZA os parâmetros contra o registro. Chave desconhecida é
 * recusada (fail-closed): o cliente não amplia a superfície por conta própria.
 */
export function validarParametros(def: WorkflowDefinition, entrada: unknown): Record<string, unknown> {
  const params = (entrada ?? {}) as Record<string, unknown>;
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new OperationalError('PARAMETRO_INVALIDO', 'Os parâmetros devem ser um objeto.');
  }
  const conhecidos = new Set(Object.keys(def.parameters));
  for (const chave of Object.keys(params)) {
    if (!conhecidos.has(chave)) {
      throw new OperationalError('PARAMETRO_INVALIDO', `O parâmetro "${chave}" não é aceito pelo workflow "${def.key}".`, { [chave]: 'desconhecido' });
    }
  }
  const saida: Record<string, unknown> = {};
  for (const [chave, spec] of Object.entries(def.parameters)) {
    const valor = validarValor(chave, spec, params[chave]);
    if (valor !== null) saida[chave] = valor;
  }
  return saida;
}
