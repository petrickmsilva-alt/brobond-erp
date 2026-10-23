// ============================================================================
// API LOCAL do agente — somente 127.0.0.1, somente o mínimo:
//
//   GET  /health  → { ok, version, pareado }           (a UI mostra status)
//   GET  /status  → { pareado, machine_id, printers }  (sem segredo nenhum)
//   POST /pair    → { codigo } troca o código no ERP e guarda o token
//
// Defesas:
//   • bind EXPLÍCITO em 127.0.0.1 — nunca 0.0.0.0/rede local;
//   • Origin, quando presente (navegador), precisa ser a origem do ERP
//     configurada — outro site aberto no mesmo navegador não fala com o
//     agente (anti DNS-rebinding/CSRF local);
//   • preflight de Private Network Access respondido só para essa origem;
//   • o token de máquina NUNCA sai por aqui.
// ============================================================================
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type LocalServerDeps = {
  version: string;
  erpOrigin: string | null;
  status: () => { pareado: boolean; machineId: string | null; printers: string[] };
  pair: (codigo: string) => Promise<{ machine_id: string; nome: string }>;
};

function lerBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let acc = '';
    req.on('data', (c) => {
      acc += c;
      if (acc.length > 16_384) reject(new Error('corpo grande demais'));
    });
    req.on('end', () => resolve(acc));
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
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (origin && origemPermitida(origin, deps.erpOrigin)) headers['access-control-allow-origin'] = origin;
    res.writeHead(code, headers);
    res.end(JSON.stringify(body));
  };

  return createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      if (req.method === 'OPTIONS') {
        // Private Network Access: página HTTPS pública → loopback exige
        // esta permissão explícita, e só a damos à origem do ERP.
        if (!origemPermitida(origin, deps.erpOrigin) || !origin) return json(res, 403, { error: 'origem não permitida' });
        res.writeHead(204, {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET, POST',
          'access-control-allow-headers': 'content-type',
          'access-control-allow-private-network': 'true',
        });
        return void res.end();
      }
      if (!origemPermitida(origin, deps.erpOrigin)) return json(res, 403, { error: 'origem não permitida' }, origin);

      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, version: deps.version, pareado: deps.status().pareado }, origin);
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        const st = deps.status();
        return json(res, 200, { pareado: st.pareado, machine_id: st.machineId, printers: st.printers }, origin);
      }
      if (req.method === 'POST' && url.pathname === '/pair') {
        const body = JSON.parse((await lerBody(req)) || '{}') as { codigo?: string };
        if (!body.codigo) return json(res, 400, { error: 'Informe o código de pareamento.' }, origin);
        const out = await deps.pair(body.codigo);
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
