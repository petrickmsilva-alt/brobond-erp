import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { log } from './log';
import {
  agoraMs,
  comContexto,
  registrarHttp,
  requisicaoFinalizada,
  requisicaoIniciada,
  type ContextoRequisicao,
} from './metrics';

// IDs are bounded opaque tokens; never echo arbitrary user-controlled text into
// headers/logs. Body, query string, raw URL, cookies and authorization are not logged.
// Only UUID v4 identifiers are accepted from callers; arbitrary opaque-looking
// strings can in fact contain CPF, email fragments or credentials.
const VALID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Slugs de recurso vêm do METADADO (`resourceParam` garante que existe), mas o
// nome só é aceito no rótulo da métrica se for um identificador simples: nunca
// ecoamos texto arbitrário do cliente em log, header ou série temporal.
const SLUG_RECURSO = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Rótulo da rota: PADRÃO declarado (`/api/:resource`), nunca a URL bruta.
 *
 * O nome do recurso é lido de `res.locals.recurso`, preenchido por
 * `resourceParam` DEPOIS de validar que o recurso existe. Não usamos
 * `req.params`: o Express restaura os params da camada ao sair do handler, e no
 * evento `finish` eles podem já não ser os da rota — o que produziria um rótulo
 * errado (ou vazio) justamente na métrica.
 */
function rotuloDaRota(req: Request, prefixo: string, res?: Response): string {
  const padrao = typeof req.route?.path === 'string' ? req.route.path : '(middleware)';
  // `route.path` é ABSOLUTO quando a rota foi declarada direto no app
  // (`app.get('/api/produtos')`) e RELATIVO quando vem de um router montado
  // (`app.use('/api', router)` + `router.get('/produtos')`). Montar sempre com
  // `baseUrl` produzia `/api/api/produtos`; montar sempre sem, `/produtos`.
  const absoluto = padrao.startsWith('/api') || padrao === '(middleware)';
  const base = absoluto ? padrao : `${prefixo || ''}${padrao}`;
  const doLocals = (res?.locals as { recurso?: unknown } | undefined)?.recurso;
  const recurso = typeof doLocals === 'string' ? doLocals : '';
  // O placeholder pode ter qualquer nome (`:resource` no código, `:recurso` em
  // testes/montagens): trocamos o PRIMEIRO parâmetro do padrão pelo slug
  // validado, preservando o resto da rota (`/api/:resource/:id` →
  // `/api/produtos/:id`).
  const placeholder = /:[a-zA-Z_][a-zA-Z0-9_]*/.exec(base);
  if (recurso && SLUG_RECURSO.test(recurso) && placeholder) {
    return base.replace(placeholder[0], recurso);
  }
  return base;
}

/**
 * Instrumentação de cada requisição HTTP.
 *
 * Produz, por rota: tempo total, status, bytes e — via AsyncLocalStorage — a
 * parcela gasta em PostgreSQL (`db_ms`), esperando conexão do pool
 * (`espera_ms`) e em serviços externos (`externo_ms`). O cabeçalho
 * `Server-Timing` expõe as mesmas fases para o navegador (DevTools › Timing),
 * o que permite comparar "lento no servidor" × "lento na rede/frontend".
 *
 * Nada de corpo, query string, cookie ou header de autenticação é registrado.
 */
export function requestObservability(req: Request, res: Response, next: NextFunction) {
  const supplied = req.get('X-Request-ID') || '';
  const suppliedCorrelation = req.get('X-Correlation-ID') || '';
  const requestId = VALID_ID.test(supplied) ? supplied : randomUUID();
  const correlationId = VALID_ID.test(suppliedCorrelation) ? suppliedCorrelation : requestId;
  const inicio = agoraMs();
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('X-Correlation-ID', correlationId);
  res.locals.requestId = requestId;
  res.locals.correlationId = correlationId;

  const contexto: ContextoRequisicao = {
    requestId,
    metodo: req.method,
    rota: '(pendente)',
    inicio,
    dbMs: 0,
    dbConsultas: 0,
    esperaMs: 0,
    externoMs: 0,
    externoChamadas: 0,
  };

  requisicaoIniciada();
  let finalizada = false;
  let bytesEscritos = 0;

  // Bytes REALMENTE enviados. `content-length` desaparece quando o corpo é
  // comprimido ou enviado em chunks — justamente os casos em que o payload é
  // grande e a métrica importa. Contamos o que passa por `write`/`end`.
  const writeOriginal = res.write.bind(res) as (...args: unknown[]) => boolean;
  (res as unknown as { write: (...args: unknown[]) => boolean }).write = function (
    ...args: unknown[]
  ): boolean {
    const parte = args[0];
    if (typeof parte === 'string') bytesEscritos += Buffer.byteLength(parte);
    else if (parte && typeof (parte as Uint8Array).byteLength === 'number') {
      bytesEscritos += (parte as Uint8Array).byteLength;
    }
    return writeOriginal(...args);
  } as never;
  const endOriginal = res.end.bind(res) as (...args: unknown[]) => Response;
  (res as unknown as { end: (...args: unknown[]) => Response }).end = function (
    ...args: unknown[]
  ): Response {
    const parte = args[0];
    if (typeof parte === 'string') bytesEscritos += Buffer.byteLength(parte);
    else if (parte && typeof (parte as Uint8Array).byteLength === 'number') {
      bytesEscritos += (parte as Uint8Array).byteLength;
    }
    return endOriginal(...args);
  } as never;

  // `Server-Timing` precisa entrar ANTES do envio dos headers; `finish` é tarde.
  const writeHeadOriginal = res.writeHead.bind(res) as (...args: unknown[]) => Response;
  (res as unknown as { writeHead: (...args: unknown[]) => Response }).writeHead = function (
    ...args: unknown[]
  ): Response {
    if (!res.headersSent) {
      try {
        const partes = [`app;dur=${Math.round(agoraMs() - inicio)}`];
        partes.push(`db;dur=${Math.round(contexto.dbMs)};desc="${contexto.dbConsultas} consultas"`);
        if (contexto.esperaMs > 0) partes.push(`pool;dur=${Math.round(contexto.esperaMs)}`);
        if (contexto.externoMs > 0) partes.push(`externo;dur=${Math.round(contexto.externoMs)}`);
        res.setHeader('Server-Timing', partes.join(', '));
      } catch {
        // Nunca derruba a resposta por causa de diagnóstico.
      }
    }
    return writeHeadOriginal(...args);
  } as never;

  res.once('finish', () => {
    finalizada = true;
    requisicaoFinalizada();
    const total = agoraMs() - inicio;
    // O rótulo é resolvido AGORA, não no `next()`: `requireAuth` é assíncrono e
    // devolve o controle antes de a rota ser casada, então `req.route` ainda
    // estava vazio naquele momento. No `finish` ele já reflete a rota real.
    const agora = rotuloDaRota(req, req.baseUrl, res);
    const rota =
      agora !== '(middleware)' ? agora : contexto.rota !== '(pendente)' ? contexto.rota : agora;
    const bytes = Number(res.getHeader('content-length')) || bytesEscritos;

    if (req.originalUrl.startsWith('/api')) {
      registrarHttp(rota, req.method, res.statusCode, total, bytes);
      const details = {
        request_id: requestId,
        correlation_id: correlationId,
        method: req.method,
        route: rota,
        status: res.statusCode,
        latency_ms: Math.round(total),
        // Parcelas do tempo: separam banco de espera de pool e de terceiros.
        db_ms: Math.round(contexto.dbMs),
        db_queries: contexto.dbConsultas,
        pool_wait_ms: Math.round(contexto.esperaMs),
        external_ms: Math.round(contexto.externoMs),
        bytes,
      };
      if (res.statusCode >= 500) log.error('http_request', details);
      else log.info('http_request', details);
    }
  });

  // A resposta pode ser abortada pelo cliente: mantém o contador de "em voo" e
  // o tempo de banco corretos sem registrar requisição concluída.
  res.once('close', () => {
    if (!finalizada) requisicaoFinalizada();
  });

  comContexto(contexto, () => {
    // `req.route` só existe depois do roteamento; capturamos no handler.
    next();
    contexto.rota = rotuloDaRota(req, req.baseUrl, res);
  });
}
