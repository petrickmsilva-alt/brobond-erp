import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasDatabaseUrl, isDbConnected, migrate } from './db';
import { ADMIN_EMAIL, changePassword, currentUser, ensureAdmin, login, me, requireAuth } from './auth';
import { getResource, publicMeta } from './resources';
import {
  checkAccess,
  createRecord,
  deleteRecord,
  getRecord,
  getStore,
  listRecords,
  optionsFor,
  toHttpError,
  updateRecord,
} from './services';
import { parseId } from './validate';
import { HttpError } from './errors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Log simples de requisições em dev
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    if (req.path.startsWith('/api')) console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

/** Envolve handlers async e encaminha erros para o middleware global. */
const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

/** Carrega o recurso da rota (404 se não existir). */
function resourceParam(req: Request, _res: Response, next: NextFunction) {
  const r = getResource(req.params.resource);
  if (!r) return next(new HttpError(404, 'Recurso não encontrado'));
  (req as any).resource = r;
  next();
}

// ----------------------------------------------------------------------------
// Público
// ----------------------------------------------------------------------------
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, db: isDbConnected() ? 'postgres' : 'memory', version: '0.2.0' })
);
app.post('/api/auth/login', wrap(login));

// ----------------------------------------------------------------------------
// Autenticado
// ----------------------------------------------------------------------------
app.use('/api', wrap(requireAuth));

app.get('/api/auth/me', me);
app.post('/api/auth/change-password', wrap(changePassword));

// Metadados dos módulos (campos, tipos, opções) — o front monta formulários com isso
app.get('/api/meta', (req, res) => {
  res.json({
    resources: publicMeta(),
    mode: getStore().kind,
    user: currentUser(req),
  });
});

app.get(
  '/api/dashboard',
  wrap(async (_req, res) => {
    res.json(await getStore().dashboard());
  })
);

// Opções para selects (id + rótulo)
app.get(
  '/api/:resource/options',
  resourceParam,
  wrap(async (req, res) => {
    const r = (req as any).resource;
    checkAccess(r, currentUser(req), 'read');
    res.json(await optionsFor(r));
  })
);

// Listagem com busca, paginação e ordenação
app.get(
  '/api/:resource',
  resourceParam,
  wrap(async (req, res) => {
    const r = (req as any).resource;
    checkAccess(r, currentUser(req), 'read');
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 25));
    const dir = String(req.query.dir || '').toLowerCase() === 'desc' ? 'desc' : String(req.query.dir || '').toLowerCase() === 'asc' ? 'asc' : undefined;
    res.json(
      await listRecords(r, {
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        page,
        pageSize,
        sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
        dir,
      })
    );
  })
);

app.get(
  '/api/:resource/:id',
  resourceParam,
  wrap(async (req, res) => {
    const r = (req as any).resource;
    checkAccess(r, currentUser(req), 'read');
    res.json(await getRecord(r, parseId(req.params.id)));
  })
);

// Incluir
app.post(
  '/api/:resource',
  resourceParam,
  wrap(async (req, res) => {
    const r = (req as any).resource;
    const actor = currentUser(req);
    checkAccess(r, actor, 'create');
    res.status(201).json(await createRecord(r, req.body, actor));
  })
);

// Salvar (editar)
const updateHandler = wrap(async (req: Request, res: Response) => {
  const r = (req as any).resource;
  const actor = currentUser(req);
  checkAccess(r, actor, 'update');
  res.json(await updateRecord(r, parseId(req.params.id), req.body, actor));
});
app.put('/api/:resource/:id', resourceParam, updateHandler);
app.patch('/api/:resource/:id', resourceParam, updateHandler);

// Excluir
app.delete(
  '/api/:resource/:id',
  resourceParam,
  wrap(async (req, res) => {
    const r = (req as any).resource;
    const actor = currentUser(req);
    checkAccess(r, actor, 'delete');
    await deleteRecord(r, parseId(req.params.id), actor);
    res.json({ ok: true });
  })
);

// Rotas /api desconhecidas
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Rota não encontrada')));

// ----------------------------------------------------------------------------
// Front buildado (produção — mesmo serviço na Render). Depois das rotas /api.
// ----------------------------------------------------------------------------
if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(dist, { maxAge: '1h', index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

// ----------------------------------------------------------------------------
// Erros
// ----------------------------------------------------------------------------
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido no corpo da requisição' });
  }
  const httpErr = toHttpError(err, (req as any).resource);
  if (httpErr.status >= 500) console.error('Erro não tratado:', err);
  res.status(httpErr.status).json({ error: httpErr.message, fields: httpErr.fields });
});

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
async function start() {
  if (hasDatabaseUrl()) {
    try {
      await migrate();
    } catch (e: any) {
      console.error('❌ Falha ao migrar o banco:', e?.message || e);
    }
  }
  await ensureAdmin();

  const port = Number(process.env.PORT) || 3001;
  app.listen(port, '0.0.0.0', () => {
    console.log(`⚡ BROBOND API rodando em http://localhost:${port}`);
    console.log(
      isDbConnected()
        ? '🗄️  Conectado ao Postgres.'
        : hasDatabaseUrl()
          ? '⚠️  DATABASE_URL definida, mas a migração falhou — verifique a conexão.'
          : '⚠️  Sem DATABASE_URL — MODO DEMONSTRAÇÃO (dados em memória, somem ao reiniciar).'
    );
    console.log(`🔐 Administrador: ${ADMIN_EMAIL}`);
  });
}

start().catch((e) => {
  console.error('Falha ao iniciar:', e);
  process.exit(1);
});
