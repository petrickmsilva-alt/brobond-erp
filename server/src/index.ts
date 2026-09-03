import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, isDbConnected } from './db';
import { login, requireAuth, me } from './auth';
import { RESOURCES } from './resources';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());

// Health check (usado pelo Render)
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Autenticação
app.post('/api/auth/login', login);
app.get('/api/auth/me', requireAuth, me);

// Dashboard (KPIs) — com DB conectado, troque pelos cálculos reais
app.get('/api/dashboard', requireAuth, async (_req, res) => {
  res.json({
    valorEstoque: 'R$ 0,00',
    itensAlerta: 0,
    producao: 0,
    vendas: 0,
  });
});

// Leitura genérica de recursos (cadastros e listas)
app.get('/api/:resource', requireAuth, async (req, res) => {
  const r = RESOURCES[req.params.resource];
  if (!r) return res.status(404).json({ error: 'Recurso não encontrado' });

  try {
    const { rows } = await query(
      `SELECT * FROM ${r.table} ORDER BY 1 LIMIT 100`
    );
    res.json(rows);
  } catch {
    // Sem banco (ou tabela ainda não criada): devolve mock
    res.json(r.mock ?? []);
  }
});

// Em produção, serve o front buildado (mesmo serviço na Render)
if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const port = Number(process.env.PORT) || 3001;
app.listen(port, '0.0.0.0', () => {
  console.log(`⚡ BROBOND API rodando em http://localhost:${port}`);
  console.log(
    isDbConnected()
      ? '🗄️  Conectado ao Postgres.'
      : '⚠️  Sem DATABASE_URL — usando dados mock.'
  );
});
