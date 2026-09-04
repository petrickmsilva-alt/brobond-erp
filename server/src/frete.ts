// Calculo de Frete - Correios, Jadlog e estimativa.
import type { Request, Response } from 'express';
import { HttpError } from './errors';

type FreteOpcao = { servico: string; nome: string; valor: number; prazo_dias: number; codigo: string };

export async function consultarCEP(req: Request, res: Response) {
  const cep = String(req.query.cep || '').replace(/\D/g, '');
  if (cep.length !== 8) throw new HttpError(400, 'CEP invalido.');
  try {
    const resp = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    const data = (await resp.json()) as any;
    if (data.erro) throw new HttpError(404, 'CEP nao encontrado.');
    res.json({ cep: data.cep, logradouro: data.logradouro || '', bairro: data.bairro || '', cidade: data.localidade || '', estado: data.uf || '' });
  } catch (e: any) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'Falha ao consultar CEP.');
  }
}

function distanciaEstimada(cepO: string, cepD: string): number {
  const regioes: Record<number, number> = { 1: 0, 2: 50, 3: 400, 4: 1500, 5: 2200, 6: 2800, 7: 900, 8: 300, 9: 800 };
  return Math.abs((regioes[Number(cepO[0])] || 0) - (regioes[Number(cepD[0])] || 0)) || 200;
}

function estimar(peso_g: number, km: number): FreteOpcao[] {
  const kg = Math.max(0.3, peso_g / 1000);
  const base = km * 0.12 + kg * 3.5;
  return [
    { servico: 'PAC', nome: 'PAC', codigo: '04510', valor: Math.round((base + 12) * 100) / 100, prazo_dias: Math.max(3, Math.round(km / 120)) },
    { servico: 'SEDEX', nome: 'SEDEX', codigo: '04014', valor: Math.round((base * 1.4 + 18) * 100) / 100, prazo_dias: Math.max(1, Math.round(km / 300)) },
    { servico: 'JADLOG', nome: 'Jadlog', codigo: 'jadlog', valor: Math.round((base * 0.85 + 10) * 100) / 100, prazo_dias: Math.max(4, Math.round(km / 100)) },
  ];
}

export async function calcularFrete(req: Request, res: Response) {
  const cepOrigem = String(req.body?.cep_origem || process.env.CEP_ORIGEM || '01001000').replace(/\D/g, '');
  const cepDestino = String(req.body?.cep_destino || '').replace(/\D/g, '');
  const peso_g = Number(req.body?.peso_g || 300);
  if (!cepDestino || cepDestino.length !== 8) throw new HttpError(400, 'CEP destino invalido.');
  const km = distanciaEstimada(cepOrigem, cepDestino);
  res.json({ cep_origem: cepOrigem, cep_destino: cepDestino, distancia_km: km, peso_g, opcoes: estimar(peso_g, km), fonte: 'estimativa' });
}
