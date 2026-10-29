import type { Request, Response } from 'express';
import { currentUser } from '../auth';
import { escopoDoAtor } from '../empresa';
import { HttpError } from '../errors';
import { readiness } from '../../../modules/payments/application/configuration';
import { getResource } from '../resources';
import { checkAccess } from '../services';
import { configDaLoja, empresaDaVitrine, freteDaConfig, responsavelCheckout } from './loja-base';
import { configuracaoFreteValida } from './frete';

/** Somente metadados: nunca retorna tokens, cifras ou resposta bruta do provedor.
 * Configurado NÃO significa conectado: não fazemos cobrança ou chamada externa aqui.
 * Ambiente só é reutilizado para a empresa determinística da loja, com webhook.
 * Credenciais do canal de relatórios não substituem o gateway de cobrança.
 */
export async function pagamentoDaLoja(empresaId: number) {
  const ready = await readiness(empresaId);
  const configured = ready.providers.filter(p=>!['NOT_CONFIGURED','DISABLED'].includes(p.status));
  return { origem:configured.some(p=>p.origin==='ambiente_commerce')?'ambiente_commerce':'banco', provider:'Payment Engine', configurado:ready.configured, ativo:ready.configured,
    tem_token:configured.length>0, tem_webhook:configured.some(p=>p.webhook), ambiente:configured[0]?.environment||null,
    conexao_validada:configured.some(p=>p.status==='CONNECTED'), credenciais_ambiente_detectadas:false, ...ready };

}

export async function estadoLoja(req: Request, res: Response) {
  const actor = currentUser(req);
  if (!actor) throw new HttpError(401, 'Autenticação necessária.');
  checkAccess(getResource('commerce_configuracoes')!, actor, 'read');
  const { empresaId } = escopoDoAtor(actor);
  const config = await configDaLoja(empresaId);
  const publica = await empresaDaVitrine();
  const pagamento = await pagamentoDaLoja(empresaId);
  const pendencias: { codigo: string; mensagem: string; caminho: string | null }[] = [];
  if (!config) pendencias.push({ codigo: 'configuracao', mensagem: 'Salve a configuração da loja nesta página.', caminho: '/commerce/loja' });
  if (!config?.loja_nome?.trim()) pendencias.push({ codigo: 'identidade', mensagem: 'Informe e salve o nome da loja.', caminho: '/commerce/loja#identidade' });
  if (publica !== empresaId) pendencias.push({ codigo: 'tenant_publico', mensagem: 'A vitrine pública não está vinculada a esta empresa. O responsável pelo deploy deve definir COMMERCE_LOJA_EMPRESA_ID com o ID desta empresa.', caminho: null });
  const freteOk = configuracaoFreteValida(freteDaConfig(config));
  if (!freteOk) pendencias.push({ codigo: 'frete', mensagem: 'Selecione e salve retirada na loja ou sua tabela real de frete, com valor positivo.', caminho: '/commerce/loja#frete' });
  let responsavel: number | null = null;
  try { responsavel = await responsavelCheckout(empresaId, config); }
  catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
    pendencias.push({ codigo: 'responsavel', mensagem: error.message, caminho: '/commerce/loja#responsavel' });
  }
  if (!pagamento.configurado) pendencias.push({ codigo: 'pagamento', mensagem: 'Payment Engine: configure um provider, métodos e regras de roteamento para esta empresa.', caminho: '/commerce/loja#pagamento' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ configuracao: config, empresa_id: empresaId, status: pendencias.length ? 'PENDENTE_DE_CONFIGURACAO' : 'CONFIGURADO', abrir_loja: pendencias.length === 0, vitrine_disponivel: !!config && publica === empresaId, frete_configurado: freteOk, responsavel_checkout_id: responsavel, pagamento, pendencias });
}
