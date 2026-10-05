/**
 * Geração dos identificadores TEXT das tabelas da fusão.
 *
 * No commerce o `id` era `cuid()` gerado pelo Prisma. O ERP escreve a
 * mesma coluna por SQL puro, então a geração passa a ser daqui — mantendo
 * as propriedades que importam: opaco, ordenável por tempo (prefixo de
 * timestamp), sem colisão prática e sem revelar volume (contador +
 * aleatoriedade de 64 bits).
 */

import { randomBytes } from 'node:crypto';

let counter = Math.floor(Math.random() * 1_000_000);

/** Identificador colidível só na prática impossível, com 25+ caracteres. */
export function connectorCuid(): string {
  const timestamp = Date.now().toString(36);
  const sequence = (counter = (counter + 1) % 1_679_616).toString(36).padStart(4, '0');
  const entropy = randomBytes(8).toString('hex');
  return `c${timestamp}${sequence}${entropy}`;
}
