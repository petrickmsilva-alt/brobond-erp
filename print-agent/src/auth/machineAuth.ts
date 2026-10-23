// Autenticação de máquina: machine_id + Bearer (token revogável do ERP) e,
// nas chamadas mutantes, nonce único + timestamp (o servidor recusa replay
// e relógio fora de ±5 min — ver printAgents.ts no ERP).
import { randomUUID } from 'node:crypto';

export type MachineIdentity = { machineId: string; token: string };

export function authHeaders(id: MachineIdentity, comNonce = true): Record<string, string> {
  const h: Record<string, string> = {
    'x-print-machine-id': id.machineId,
    authorization: `Bearer ${id.token}`,
  };
  if (comNonce) {
    h['x-print-nonce'] = randomUUID();
    h['x-print-timestamp'] = String(Date.now());
  }
  return h;
}
