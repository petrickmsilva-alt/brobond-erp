// ============================================================================
// GESTÃO CONSOLIDADA DE CHAVES DE CIFRA (segredos de integração e MFA).
//
// Fonte única de material de chave para os domínios AES-256-GCM do servidor:
//   • segredos → SEGREDOS_ENCRYPTION_KEY, APP_ENCRYPTION_KEY (fallback JWT_SECRET)
//   • mfa      → MFA_ENCRYPTION_KEY (fallback JWT_SECRET)
// A cifra de credenciais de conector (CONNECTOR_ENCRYPTION_KEY, 32 bytes exatos)
// é validada em modules/connectors/core/crypto.service.ts.
//
// Compatibilidade (regra de migração):
//   • a chave PRIMÁRIA cifra todo valor novo;
//   • as chaves LEGADAS (derivadas do JWT_SECRET, como sempre foi) são aceitas
//     SOMENTE para decifrar. Definir uma chave dedicada nunca torna ilegíveis os
//     segredos já gravados. A reescrita para a chave nova é um procedimento
//     separado (docs/seguranca/plano-migracao-segredos.md).
//
// Produção: sem nenhuma chave, cifrar/decifrar falha — o literal de
// desenvolvimento NÃO é usado. Fora de produção existe o fallback documentado.
// Nenhum valor de chave é registrado em log ou em diagnóstico.
// ============================================================================
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** Literal de DESENVOLVIMENTO. Nunca alcançável com NODE_ENV=production. */
export const SEGREDO_DESENVOLVIMENTO = 'brobond-dev-secret';

export type DominioCifra = 'segredos' | 'mfa';
export type FonteChave = 'dedicada' | 'derivada_jwt' | 'desenvolvimento';

const SAL: Record<DominioCifra, string> = {
  segredos: 'brobond-segredos-v1',
  mfa: 'brobond-mfa-v1',
};

export class ErroChaveCifra extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroChaveCifra';
  }
}

const emProducao = () => process.env.NODE_ENV === 'production';

function materialDedicado(dominio: DominioCifra): string | null {
  const valor =
    dominio === 'segredos'
      ? process.env.SEGREDOS_ENCRYPTION_KEY || process.env.APP_ENCRYPTION_KEY
      : process.env.MFA_ENCRYPTION_KEY;
  return valor && valor.trim() ? valor : null;
}

/** Segredo do JWT (também base da derivação legada). Nunca usa o literal em produção. */
export function segredoJwt(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (emProducao()) throw new ErroChaveCifra('JWT_SECRET ausente em produção.');
  return SEGREDO_DESENVOLVIMENTO;
}

const cache = new Map<string, Buffer>();

function derivar(material: string, dominio: DominioCifra): Buffer {
  const chaveCache = `${dominio}\u0000${material}`;
  let chave = cache.get(chaveCache);
  if (!chave) {
    chave = scryptSync(material, SAL[dominio], 32);
    cache.set(chaveCache, chave);
  }
  return chave;
}

export type CandidataChave = { fonte: FonteChave; chave: Buffer };

/**
 * Chaves de um domínio: primeira = primária (cifra); demais = legadas (só leitura).
 * Lança `ErroChaveCifra` quando não há nenhum material e o ambiente é produção.
 */
export function chavesDoDominio(dominio: DominioCifra): { primaria: CandidataChave; legadas: CandidataChave[] } {
  const candidatas: CandidataChave[] = [];
  const dedicado = materialDedicado(dominio);
  if (dedicado) candidatas.push({ fonte: 'dedicada', chave: derivar(dedicado, dominio) });
  const jwt = process.env.JWT_SECRET;
  if (jwt) candidatas.push({ fonte: 'derivada_jwt', chave: derivar(jwt, dominio) });
  if (candidatas.length === 0) {
    if (emProducao()) {
      throw new ErroChaveCifra(
        dominio === 'segredos'
          ? 'Nenhuma chave de cifra de segredos configurada em produção (SEGREDOS_ENCRYPTION_KEY).'
          : 'Nenhuma chave de cifra de MFA configurada em produção (MFA_ENCRYPTION_KEY).'
      );
    }
    candidatas.push({ fonte: 'desenvolvimento', chave: derivar(SEGREDO_DESENVOLVIMENTO, dominio) });
  }
  const [primaria, ...legadas] = candidatas;
  return { primaria, legadas };
}

/** Diagnóstico SEM valores: que fonte está ativa por domínio. */
export function diagnosticoChaves(): Array<{ dominio: DominioCifra; fonte: FonteChave | 'ausente'; legadaDisponivel: boolean }> {
  return (['segredos', 'mfa'] as DominioCifra[]).map((dominio) => {
    try {
      const { primaria, legadas } = chavesDoDominio(dominio);
      return { dominio, fonte: primaria.fonte, legadaDisponivel: legadas.length > 0 };
    } catch {
      return { dominio, fonte: 'ausente', legadaDisponivel: false };
    }
  });
}

/** Limpa o cache de derivação (testes que trocam variáveis de ambiente). */
export function limparCacheChaves(): void {
  cache.clear();
}

// ----------------------------------------------------------------------------
// Formato único `v1.<iv>.<tag>.<texto>` (AES-256-GCM, base64url).
// ----------------------------------------------------------------------------

export function cifrarComDominio(texto: string, dominio: DominioCifra): string {
  const { primaria } = chavesDoDominio(dominio);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', primaria.chave, iv);
  const dados = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), dados.toString('base64url')].join('.');
}

/**
 * Tenta a chave primária e depois as legadas. Devolve `null` em qualquer
 * falha (formato, tag, chave) — nunca lança, nunca revela qual chave falhou.
 */
export function decifrarComDominio(payload: string, dominio: DominioCifra): string | null {
  const [versao, iv, tag, dados] = String(payload).split('.');
  if (versao !== 'v1' || !iv || !tag || !dados) return null;
  let candidatas: CandidataChave[];
  try {
    const { primaria, legadas } = chavesDoDominio(dominio);
    candidatas = [primaria, ...legadas];
  } catch {
    return null;
  }
  for (const candidata of candidatas) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', candidata.chave, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(dados, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      /* tenta a próxima chave legada */
    }
  }
  return null;
}
