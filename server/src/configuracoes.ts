// ============================================================
// Configurações persistidas do sistema (tabela `configuracoes`).
//
// Um lugar só para os ajustes que o administrador faz pela interface e que
// precisam sobreviver a restart/deploy — sem exigir variável de ambiente nem
// redeploy na Render. Hoje guarda:
//   • `politica_senha` (ver politicaSenha.ts)
//   • `app_url`        — endereço público do ERP (ver urlPublica.ts)
//
// Fica isolado de services.ts de propósito: urlPublica.ts precisa ler daqui
// sem importar a camada de serviço (services → uploads/auth → urlPublica
// formaria ciclo). O `getStore()` é importado dinamicamente dentro das
// funções, quando os módulos já estão todos carregados.
// ============================================================
import type { Resource } from './resources';

/** Recurso interno (fora de RESOURCES: sem CRUD genérico, só via endpoints próprios). */
export const R_CONFIGURACOES: Resource = {
  key: 'configuracoes',
  table: 'configuracoes',
  label: 'Configurações',
  singular: 'Configuração',
  labelFields: ['chave'],
  internal: true,
  ops: { create: false, update: false, delete: false },
  fields: [
    { name: 'chave', label: 'Chave', type: 'text' },
    { name: 'valor', label: 'Valor', type: 'textarea' },
    { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true },
    { name: 'atualizado_por', label: 'Atualizado por', type: 'text', readonly: true },
  ],
};

/** Chave do endereço público do ERP (base dos links de e-mail/portal/QR). */
export const CHAVE_APP_URL = 'app_url';

/**
 * Lê uma configuração ('' quando nunca gravada).
 *
 * Nunca lança: configuração é acessório — se o banco estiver fora, o sistema
 * continua funcionando com o padrão/ambiente em vez de derrubar a requisição.
 */
export async function lerConfig(chave: string): Promise<string> {
  try {
    const { getStore } = await import('./services');
    const row = await getStore().findOneWhere(R_CONFIGURACOES, { chave });
    return row?.valor == null ? '' : String(row.valor);
  } catch {
    return '';
  }
}

/** Grava (ou substitui) uma configuração, registrando quem alterou. */
export async function gravarConfig(chave: string, valor: string, atualizadoPor: string): Promise<void> {
  const { getStore } = await import('./services');
  const store = getStore();
  const existente = await store.findOneWhere(R_CONFIGURACOES, { chave });
  if (existente) {
    await store.update(R_CONFIGURACOES, Number(existente.id), {
      valor,
      atualizado_em: new Date().toISOString(),
      atualizado_por: atualizadoPor,
    });
  } else {
    await store.insert(R_CONFIGURACOES, { chave, valor, atualizado_por: atualizadoPor });
  }
}

/** Remove a configuração (volta ao comportamento padrão/ambiente). */
export async function removerConfig(chave: string): Promise<boolean> {
  try {
    const { getStore } = await import('./services');
    const store = getStore();
    const existente = await store.findOneWhere(R_CONFIGURACOES, { chave });
    if (!existente) return false;
    await store.remove(R_CONFIGURACOES, Number(existente.id));
    return true;
  } catch {
    return false;
  }
}
