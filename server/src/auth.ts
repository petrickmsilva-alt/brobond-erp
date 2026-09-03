import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'brobond-dev-secret';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@brobond.com.br';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'brobond123';

type AuthUser = { id: number; name: string; email: string };

export async function login(req: Request, res: Response) {
  const { email, password } = req.body || {};

  // Login inicial via variáveis de ambiente. Depois pode validar na tabela `usuarios`.
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const user: AuthUser = { id: 1, name: 'Admin BROBOND', email };
    const token = jwt.sign(user, SECRET, { expiresIn: '8h' });
    return res.json({ token, user });
  }

  return res.status(401).json({ error: 'Credenciais inválidas' });
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');

  if (!token) {
    return res.status(401).json({ error: 'Não autenticado' });
  }

  try {
    (req as any).user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

export function me(req: Request, res: Response) {
  res.json({ user: (req as any).user });
}
