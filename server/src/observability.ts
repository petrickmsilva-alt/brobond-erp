import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { log } from './log';

// IDs are bounded opaque tokens; never echo arbitrary user-controlled text into
// headers/logs. Body, query string, raw URL, cookies and authorization are not logged.
// Only UUID v4 identifiers are accepted from callers; arbitrary opaque-looking
// strings can in fact contain CPF, email fragments or credentials.
const VALID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function requestObservability(req: Request, res: Response, next: NextFunction) {
  const supplied = req.get('X-Request-ID') || '';
  const suppliedCorrelation = req.get('X-Correlation-ID') || '';
  const requestId = VALID_ID.test(supplied) ? supplied : randomUUID();
  const correlationId = VALID_ID.test(suppliedCorrelation) ? suppliedCorrelation : requestId;
  const start = process.hrtime.bigint();
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('X-Correlation-ID', correlationId);
  res.locals.requestId = requestId;
  res.locals.correlationId = correlationId;
  res.once('finish', () => {
    // req.route.path is the declared pattern, not the value of :token or :id.
    // Some mounted middleware has no route: do not fall back to the raw path.
    if (!req.originalUrl.startsWith('/api')) return;
    const details = {
      request_id: requestId, correlation_id: correlationId, method: req.method,
      route: typeof req.route?.path === 'string' ? req.route.path : '(middleware)',
      status: res.statusCode, latency_ms: Math.round(Number(process.hrtime.bigint() - start) / 1e6),
    };
    if (res.statusCode >= 500) log.error('http_request', details);
    else log.info('http_request', details);
  });
  next();
}
