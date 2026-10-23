// ============================================================================
// API LOCAL do agente — somente 127.0.0.1, somente o mínimo:
//
//   GET  /health   → { ok, version, pareado, protocols } (a UI mostra status)
//   GET  /status   → { pareado, machine_id, terminal, printers, protocols }
//   GET  /printers → { printers }
//   POST /pair     → { codigo } troca o código no ERP e guarda o token
//
// Defesas (P1 + P6):
//   • bind EXPLÍCITO em 127.0.0.1 — nunca 0.0.0.0/rede local;
//   • Origin, quando presente (navegador), precisa ser a origem do ERP;
//   • Sec-Fetch-Site: cross-site é recusado mesmo sem Origin;
//   • cabeçalhos X-Content-Type-Options: nosniff e Cache-Control: no-store;
//   • limite estrito de corpo (16 KiB) e validação JSON;
//   • o token de máquina NUNCA sai por aqui.
// ============================================================================
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type LocalAgentStatus = {
  pareado: boolean;
  machineId: string | null;
  terminal?: string | null;
  printers: string[];
  protocols?: string[];
};

export type LocalServerDeps = {
  version: string;
  erpOrigin: string | null;
  status: () => LocalAgentStatus | Promise<LocalAgentStatus>;
  pair: (codigo: string) => Promise<{ machine_id: string; nome: string }>;
};

function lerBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      bytes += c.length;
      if (bytes > 16_384) {
        req.destroy();
        reject(new Error('corpo grande demais'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function origemPermitida(origin: string | undefined, erpOrigin: string | null): boolean {
  if (!origin) return true; // chamada não-navegador (curl local, testes)
  if (!erpOrigin) return false;
  return origin === erpOrigin;
}

export function criarLocalServer(deps: LocalServerDeps): Server {
  const json = (res: ServerResponse, code: number, body: unknown, origin?: string) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    };
    if (origin && origemPermitida(origin, deps.erpOrigin)) {
      headers['access-control-allow-origin'] = origin;
      headers['vary'] = 'Origin';
    }
    res.writeHead(code, headers);
    res.end(JSON.stringify(body));
  };

  return createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();

      if (req.method === 'OPTIONS') {
        if (!origemPermitida(origin, deps.erpOrigin) || !origin) return json(res, 403, { error: 'origem não permitida' });
        res.writeHead(204, {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET, POST',
          'access-control-allow-headers': 'content-type',
          'access-control-allow-private-network': 'true',
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        });
        return void res.end();
      }

      const hostHdr = String(req.headers.host || '').trim().toLowerCase();
      if (hostHdr && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(hostHdr)) {
        return json(res, 403, { error: 'host não permitido (DNS rebinding bloqueado)' });
      }
      if (!origemPermitida(origin, deps.erpOrigin)) {
        return json(res, 403, { error: 'origem não permitida' }, origin);
      }
      if (fetchSite === 'cross-site' && origin !== deps.erpOrigin) {
        return json(res, 403, { error: 'requisição cross-site recusada' }, origin);
      }

      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        const st = await deps.status();
        return json(
          res,
          200,
          { ok: true, version: deps.version, pareado: st.pareado, protocols: st.protocols ?? ['text', 'escpos', 'zpl', 'epl2'] },
          origin
        );
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        const st = await deps.status();
        return json(
          res,
          200,
          {
            pareado: st.pareado,
            machine_id: st.machineId,
            terminal: st.terminal ?? null,
            printers: st.printers,
            protocols: st.protocols ?? ['text', 'escpos', 'zpl', 'epl2'],
          },
          origin
        );
      }
      if (req.method === 'GET' && url.pathname === '/printers') {
        const st = await deps.status();
        return json(res, 200, { printers: st.printers }, origin);
      }
      if (req.method === 'POST' && url.pathname === '/pair') {
        const ct = String(req.headers['content-type'] || '').toLowerCase();
        if (ct && !ct.includes('application/json')) {
          return json(res, 415, { error: 'Content-Type deve ser application/json.' }, origin);
        }
        let body: { codigo?: unknown };
        try {
          body = JSON.parse((await lerBody(req)) || '{}') as { codigo?: unknown };
        } catch (err) {
          if (err instanceof Error && err.message === 'corpo grande demais') {
            return json(res, 413, { error: 'Payload excede o limite permitido.' }, origin);
          }
          return json(res, 400, { error: 'JSON inválido.' }, origin);
        }
        const codigo = typeof body.codigo === 'string' ? body.codigo.trim() : '';
        if (!codigo || codigo.length > 40) return json(res, 400, { error: 'Informe o código de pareamento.' }, origin);
        const out = await deps.pair(codigo);
        return json(res, 200, { ok: true, machine_id: out.machine_id, nome: out.nome }, origin);
      }
      return json(res, 404, { error: 'rota não encontrada' }, origin);
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : 'erro no agente' });
    }
  });
}

/** Sobe o servidor SOMENTE no loopback. */
export function ouvirLoopback(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}
