// Consulta de CEP e endpoint legado de frete, sem valores inventados.
import type { Request, Response } from 'express';
import { HttpError } from './errors';

export async function consultarCEP(req: Request, res: Response) {
  const cep = String(req.query.cep || '').replace(/\D/g, '');
  if (cep.length !== 8) throw new HttpError(400, 'CEP invalido.');
  try {
    const resp = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    const data = (await resp.json()) as any;
    if (data.erro) throw new HttpError(404, 'CEP nao encontrado.');
    res.json({ cep: data.cep, logradouro: data.logradouro || '', bairro: data.bairro || '', cidade: data.localidade || '', estado: data.uf || '' });
  } catch (e: any) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'Falha ao consultar CEP.');
  }
}

/** O endpoint legado não dispõe de cotação contratada; não fabrica preços. */
export async function calcularFrete(req: Request, res: Response) {
  const cepDestino = String(req.body?.cep_destino || '').replace(/\D/g, '');
  if (cepDestino.length !== 8) throw new HttpError(400, 'CEP destino invalido.');
  res.status(503).json({ disponivel: false, codigo: 'PROVIDER_UNAVAILABLE', motivo: 'Cotação real não disponível neste endpoint.', opcoes: [] });
}
