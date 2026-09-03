import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from './db';

const SECRET = process.env.JWT_SECRET || 'brobond-dev-secret';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@brobond.com.br').trim().toLowerCase();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'brobond123').trim();

type AuthUser = { id: number; name: string; email: string };

function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

function extractToken(header: string): string {
  if (!header) return '';
  // Suporta "Bearer <token>" case-insensitive e também token puro
  const trimmed = header.trim();
  if (/^Bearer\s+/i.test(trimmed)) {
    return trimmed.replace(/^Bearer\s+/i, '').trim();
  }
  return trimmed;
}

export async function login(req: Request, res: Response) {
  const rawEmail = req.body?.email || '';
  const rawPassword = req.body?.password || '';
  const email = normalizeEmail(rawEmail);
  const password = (rawPassword || '').trim();

  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios' });
  }

  // 1) Login via variáveis de ambiente (admin padrão)
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const user: AuthUser = { id: 1, name: 'Admin BROBOND', email };
    const token = jwt.sign(user, SECRET, { expiresIn: '8h' });
    return res.json({ token, user });
  }

  // 2) Se tiver banco, tenta validar na tabela usuarios
  if (pool) {
    try {
      const { rows } = await pool.query(
        'SELECT id, nome, email, senha_hash FROM usuarios WHERE LOWER(email) = LOWER($1) AND ativo = TRUE LIMIT 1',
        [email]
      );
      if (rows.length > 0) {
        const dbUser = rows[0];
        let ok = false;

        if (dbUser.senha_hash) {
          // Se for hash bcrypt ($2a$, $2b$), tenta comparar com bcryptjs se disponível
          if (dbUser.senha_hash.startsWith('$2a$') || dbUser.senha_hash.startsWith('$2b$')) {
            try {
              // import dinâmico para não quebrar se bcryptjs não estiver instalado
              const bcrypt = await import('bcryptjs').then(m => (m as any).default || m).catch(() => null);
              if (bcrypt) {
                ok = await bcrypt.compare(password, dbUser.senha_hash);
              } else {
                // fallback: compara plain se bcryptjs não disponível (não ideal, mas evita bloqueio)
                ok = password === dbUser.senha_hash;
              }
            } catch {
              ok = password === dbUser.senha_hash;
            }
          } else {
            // senha em texto puro ou hash simples
            ok = password === dbUser.senha_hash;
          }
        } else {
          // sem senha_hash, permite se senha for igual ao admin default (para seed inicial)
          ok = password === ADMIN_PASSWORD;
        }

        if (ok) {
          const user: AuthUser = {
            id: dbUser.id,
            name: dbUser.nome || 'Usuário',
            email: dbUser.email,
          };
          const token = jwt.sign(user, SECRET, { expiresIn: '8h' });
          return res.json({ token, user });
        }
      }
    } catch (e) {
      console.warn('⚠️  Falha ao consultar usuarios no banco, usando apenas login ENV:', (e as any).message);
      // continua para retornar 401 abaixo
    }
  }

  return res.status(401).json({ error: 'Credenciais inválidas' });
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = (req.headers.authorization as string) || '';
  const token = extractToken(header);

  if (!token) {
    return res.status(401).json({ error: 'Não autenticado' });
  }

  try {
    (req as any).user = jwt.verify(token, SECRET);
    next();
  } catch (err: any) {
    // Log para debug mas não expõe detalhes ao cliente
    if (process.env.NODE_ENV !== 'production') {
      console.warn('Token inválido:', err.message);
    }
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

export function me(req: Request, res: Response) {
  res.json({ user: (req as any).user });
}
