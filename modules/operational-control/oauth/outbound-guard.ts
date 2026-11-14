// ============================================================================
// OAUTH 2.1 › GUARDA DE SAÍDA (anti-SSRF) PARA O CIMD
//
// O Client ID Metadata Document (CIMD) faz o servidor BUSCAR a URL do
// `client_id`. Um fetch cru disso é SSRF: qualquer usuário autenticado poderia
// apontar para `https://169.254.169.254/...` (metadados de nuvem), para
// `http://localhost/...` ou para um host que resolve para a rede interna.
//
// Esta guarda fecha as classes exigidas:
//   • só HTTPS;
//   • bloqueia loopback/privado/link-local/reservado (IPv4 e IPv6, inclusive
//     IPv4-mapeado) — reaproveita `enderecoInterno`/`hostnameInterno`;
//   • valida APÓS a resolução DNS e CONECTA no endereço validado, fixando o IP
//     na conexão (`servername` mantém o SNI e o Host o virtual host) — fecha o
//     DNS rebinding, que uma checagem textual/prévia não cobre;
//   • redirecionamentos são seguidos MANUALMENTE, revalidando cada destino;
//   • limite de tamanho da resposta e timeout TOTAL;
//   • erros não revelam a URL (que pode conter dados sensíveis) nem stack.
//
// O CIMD nasce DESLIGADO (`OAUTH_CIMD_ENABLED=true` para ligar): sem uma
// infraestrutura que garanta o pinning, a especificação manda bloquear por
// padrão e documentar a limitação — nunca manter o fetch arbitrário como
// fallback.
// ============================================================================
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { enderecoInterno, hostnameInterno } from '../../../server/src/webhooks';

const MAX_BYTES = Number(process.env.OAUTH_CIMD_MAX_BYTES ?? 64 * 1024);
const TIMEOUT_MS = Number(process.env.OAUTH_CIMD_TIMEOUT_MS ?? 4000);
const MAX_REDIRECIONAMENTOS = 2;

/** O CIMD está habilitado? Desligado por padrão (fail-closed). */
export function cimdHabilitado(): boolean {
  return String(process.env.OAUTH_CIMD_ENABLED ?? '').toLowerCase() === 'true';
}

export type ResolvedorDns = (host: string) => Promise<string[]>;
const resolverPadrao: ResolvedorDns = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((r) => r.address);

/** Erro de guarda — mensagem pública fixa, sem a URL (pode ter dado sensível). */
export class CimdBloqueado extends Error {
  constructor(motivo: string) {
    super(`CIMD recusado: ${motivo}`);
    this.name = 'CimdBloqueado';
  }
}

/**
 * Resolve o host e devolve os endereços válidos, ou lança. Endereços IP literais
 * não passam por DNS. Qualquer endereço interno na resolução bloqueia tudo
 * (fail-closed) — não basta o primeiro.
 */
export async function resolverDestinoSeguro(host: string, resolver: ResolvedorDns = resolverPadrao): Promise<string[]> {
  const cru = String(host).replace(/^\[|\]$/g, '');
  if (isIP(cru)) {
    if (enderecoInterno(cru)) throw new CimdBloqueado('destino interno não é permitido');
    return [cru];
  }
  if (hostnameInterno(cru)) throw new CimdBloqueado('destino interno não é permitido');
  let enderecos: string[];
  try {
    enderecos = await resolver(cru);
  } catch {
    throw new CimdBloqueado('não foi possível resolver o destino');
  }
  if (!enderecos.length) throw new CimdBloqueado('não foi possível resolver o destino');
  if (enderecos.some(enderecoInterno)) throw new CimdBloqueado('o destino resolve para a rede interna');
  return enderecos;
}

type RespostaHttp = { status: number; location: string | null; corpo: string };

/**
 * Conector injetável: recebe a URL e o ENDEREÇO JÁ VALIDADO e conecta nele
 * (fixando o IP). Em produção é o `conectarHttpsFixo` (TLS padrão); os testes
 * injetam um conector para exercitar a lógica de redirect/status sem rede.
 */
export type Conector = (url: URL, endereco: string) => Promise<RespostaHttp>;

/** GET https fixando o IP validado; sem seguir redirect automático; com teto e timeout. */
export function conectarHttpsFixo(url: URL, endereco: string, tls: { ca?: string } = {}): Promise<RespostaHttp> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: endereco,
        servername: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { Host: url.host, Accept: 'application/json', 'User-Agent': 'brobond-operational-control' },
        timeout: TIMEOUT_MS,
        ...(tls.ca ? { ca: tls.ca } : {}),
      },
      (res) => {
        let bytes = 0;
        const partes: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) {
            req.destroy();
            reject(new CimdBloqueado('resposta excede o tamanho máximo'));
            return;
          }
          partes.push(chunk);
        });
        res.on('end', () =>
          resolve({ status: Number(res.statusCode ?? 0), location: (res.headers.location as string) ?? null, corpo: Buffer.concat(partes).toString('utf8') })
        );
        res.on('error', reject);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new CimdBloqueado('tempo esgotado ao buscar o documento'));
    });
    req.on('error', () => reject(new CimdBloqueado('falha de conexão com o destino')));
    req.end();
  });
}

/**
 * Busca o documento CIMD com TODAS as guardas. Segue no máximo
 * `MAX_REDIRECIONAMENTOS` saltos, revalidando (resolução + endereço) cada
 * destino. Devolve o JSON já parseado.
 */
export async function buscarDocumentoCimd(
  clientId: string,
  resolver: ResolvedorDns = resolverPadrao,
  conectar: Conector = conectarHttpsFixo
): Promise<Record<string, unknown>> {
  if (!cimdHabilitado()) throw new CimdBloqueado('CIMD desabilitado nesta implantação');
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new CimdBloqueado('client_id não é uma URL válida');
  }
  for (let salto = 0; salto <= MAX_REDIRECIONAMENTOS; salto++) {
    if (url.protocol !== 'https:') throw new CimdBloqueado('apenas https é permitido');
    const enderecos = await resolverDestinoSeguro(url.hostname, resolver);
    const resp = await conectar(url, enderecos[0]);
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      if (!resp.location) throw new CimdBloqueado('redirecionamento sem destino');
      try {
        url = new URL(resp.location, url);
      } catch {
        throw new CimdBloqueado('redirecionamento inválido');
      }
      continue;
    }
    if (resp.status < 200 || resp.status >= 300) throw new CimdBloqueado('o destino não respondeu 2xx');
    try {
      const doc = JSON.parse(resp.corpo) as unknown;
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('não é objeto');
      return doc as Record<string, unknown>;
    } catch {
      throw new CimdBloqueado('o documento não é um JSON de objeto');
    }
  }
  throw new CimdBloqueado('redirecionamentos em excesso');
}
