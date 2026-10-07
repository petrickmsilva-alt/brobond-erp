// ============================================================================
// BUSCA DE CEP — atrás de uma interface, com mais de um fornecedor.
//
// A especificação é explícita: o domínio do ERP não pode ficar acoplado a um
// único provedor de CEP. Aqui existe um contrato (`CepProvider`), uma lista
// ordenada de implementações e um resolvedor que tenta a próxima quando a
// anterior falha. Trocar de fornecedor (ou adicionar o seu) é acrescentar um
// objeto a `PROVIDERS` — nada no cadastro de clientes muda.
//
// Configuração:
//   CEP_PROVIDERS=brasilapi,viacep   (ordem de tentativa; padrão: esta)
//   CEP_TIMEOUT_MS=4000
//
// O endpoint antigo `GET /api/frete/cep` continua funcionando (frete.ts) —
// este módulo adiciona `GET /api/cep/:cep`, que devolve também o código IBGE
// do município, obrigatório na NF-e.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { cepNormalizado, ufValida } from './documentos';

export type EnderecoCep = {
  cep: string;
  logradouro: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
  /** Código IBGE do município — obrigatório na NF-e. */
  codigo_municipio: string | null;
  fonte: string;
};

export interface CepProvider {
  readonly nome: string;
  buscar(cep: string, signal: AbortSignal): Promise<EnderecoCep | null>;
}

const TIMEOUT_MS = Number(process.env.CEP_TIMEOUT_MS) || 4000;

/** BrasilAPI — devolve o código IBGE direto, por isso é a primeira opção. */
const brasilApi: CepProvider = {
  nome: 'brasilapi',
  async buscar(cep, signal) {
    const resp = await fetch(`https://brasilapi.com.br/api/cep/v2/${cep}`, { signal });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`brasilapi ${resp.status}`);
    const d = (await resp.json()) as Record<string, any>;
    if (!d?.city) return null;
    return {
      cep,
      logradouro: String(d.street || ''),
      complemento: '',
      bairro: String(d.neighborhood || ''),
      cidade: String(d.city || ''),
      uf: String(d.state || '').toUpperCase(),
      codigo_municipio: d.city_ibge ? String(d.city_ibge) : null,
      fonte: 'brasilapi',
    };
  },
};

/** ViaCEP — o fallback histórico; o IBGE vem no campo `ibge`. */
const viaCep: CepProvider = {
  nome: 'viacep',
  async buscar(cep, signal) {
    const resp = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal });
    if (!resp.ok) throw new Error(`viacep ${resp.status}`);
    const d = (await resp.json()) as Record<string, any>;
    if (d?.erro) return null;
    return {
      cep,
      logradouro: String(d.logradouro || ''),
      complemento: String(d.complemento || ''),
      bairro: String(d.bairro || ''),
      cidade: String(d.localidade || ''),
      uf: String(d.uf || '').toUpperCase(),
      codigo_municipio: d.ibge ? String(d.ibge) : null,
      fonte: 'viacep',
    };
  },
};

const DISPONIVEIS: Record<string, CepProvider> = {
  brasilapi: brasilApi,
  viacep: viaCep,
};

/** Permite registrar um provedor próprio (ex.: base interna dos Correios). */
export function registrarCepProvider(provider: CepProvider): void {
  DISPONIVEIS[provider.nome] = provider;
}

function providersConfigurados(): CepProvider[] {
  const ordem = (process.env.CEP_PROVIDERS || 'brasilapi,viacep')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const lista = ordem.map((n) => DISPONIVEIS[n]).filter(Boolean) as CepProvider[];
  return lista.length ? lista : [brasilApi, viaCep];
}

/**
 * Consulta o CEP tentando os provedores em ordem.
 *
 * Distingue três desfechos, porque eles pedem reações diferentes:
 *   • endereço encontrado;
 *   • `null` — CEP inexistente (um provedor respondeu com autoridade);
 *   • exceção 502 — nenhum provedor respondeu (rede/fornecedor fora).
 */
export async function buscarCep(valor: unknown): Promise<EnderecoCep | null> {
  const cep = cepNormalizado(valor);
  if (!cep) throw new HttpError(400, 'CEP inválido: informe 8 dígitos.');

  const erros: string[] = [];
  let respondeuNaoEncontrado = false;

  for (const provider of providersConfigurados()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const achado = await provider.buscar(cep, controller.signal);
      if (achado) {
        if (achado.uf && !ufValida(achado.uf)) achado.uf = '';
        return achado;
      }
      respondeuNaoEncontrado = true;
    } catch (e: any) {
      erros.push(`${provider.nome}: ${e?.message || 'falha'}`);
    } finally {
      clearTimeout(timer);
    }
  }

  if (respondeuNaoEncontrado) return null;
  throw new HttpError(502, `Nenhum serviço de CEP respondeu (${erros.join('; ') || 'sem detalhes'}). Preencha o endereço manualmente.`);
}

/** GET /api/cep/:cep — endereço normalizado, pronto para o formulário. */
export async function consultarCepHandler(req: Request, res: Response) {
  const endereco = await buscarCep(req.params.cep);
  if (!endereco) throw new HttpError(404, 'CEP não encontrado.');
  res.json(endereco);
}
