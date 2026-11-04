// R-14 (Fase 4.2) — associação segura de evento de webhook a empresa.
//
// Contrato (ver docs/auditoria/fase-4-2-correcoes.md, seção R-14):
//  1. A assinatura/origem é verificada ANTES (responsabilidade do chamador). Sem assinatura válida,
//     o evento é recusado e não é associado a nenhuma empresa.
//  2. Empresa da CONFIGURAÇÃO (endpoint/conexão cadastrada) é a fonte confiável. O payload não decide tenant
//     sozinho.
//  3. Identificador do provedor (ex.: id da loja) só associa quando resolve para UMA empresa.
//     Conflito entre configuração e identificador, ou mais de uma empresa: recusado (ambíguo), nunca associado.
//  4. Evento sem empresa (configuração global e sem identificador resolvível) permanece GLOBAL.
//  5. Função pura: sem banco, sem consulta cruzada. Quem chama fornece os dados já lidos.

export type ResolucaoEventoEmpresa =
  | { tipo: 'empresa'; empresaId: number; origem: 'configuracao' | 'identificador' }
  | { tipo: 'global' }
  | { tipo: 'recusado'; motivo: 'assinatura_invalida' | 'identificador_ambiguo' };

export interface EntradaResolucaoEvento {
  /** Resultado da verificação de assinatura/origem feita antes. */
  assinaturaValida: boolean;
  /** Empresa da configuração cadastrada (endpoint/conexão). `null` = configuração global. */
  empresaDaConfiguracao: number | null;
  /** Empresas que o identificador do provedor resolve (0, 1 ou várias). */
  empresasPorIdentificador: number[];
}

const positivo = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

export function resolverEmpresaDoEvento(entrada: EntradaResolucaoEvento): ResolucaoEventoEmpresa {
  if (!entrada.assinaturaValida) return { tipo: 'recusado', motivo: 'assinatura_invalida' };
  const empresas = [...new Set(entrada.empresasPorIdentificador.filter(positivo))];
  const config = positivo(entrada.empresaDaConfiguracao) ? entrada.empresaDaConfiguracao : null;

  if (config !== null) {
    // Identificador que aponta para outra empresa contradiz a configuração: não associa.
    if (empresas.some((id) => id !== config)) return { tipo: 'recusado', motivo: 'identificador_ambiguo' };
    return { tipo: 'empresa', empresaId: config, origem: 'configuracao' };
  }

  if (empresas.length === 0) return { tipo: 'global' };
  if (empresas.length === 1) return { tipo: 'empresa', empresaId: empresas[0], origem: 'identificador' };
  return { tipo: 'recusado', motivo: 'identificador_ambiguo' };
}

/** Chave de idempotência por (provedor, id do evento no provedor). Sem id, recusa: não há como deduplicar. */
export function chaveIdempotenciaEvento(provedor: string, eventoId: string): string {
  const id = String(eventoId ?? '').trim();
  if (!id) throw new Error('Evento sem id do evento no provedor: não é possível deduplicar.');
  const prov = String(provedor ?? '').trim().toLowerCase();
  if (!prov) throw new Error('Provedor ausente na chave de idempotência.');
  return `${prov}:${id}`;
}
