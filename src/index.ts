// PharmaPro backend — Express server.
// Serves POST /api/v1/actions/<actionName> (see docs/API_CONTRACT.md).
import 'dotenv/config';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { runMigrations, pool } from './db';
import { ApiError } from './errors';
import { ACTION_NAMES, dispatch } from './actions';

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Rate limiting on login (brute-force protection). Other actions are
// token-authenticated and cheap; a light global limiter applies.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ ok: false, error: 'Too many login attempts. Try again in 15 minutes.' });
  },
});
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ ok: false, error: 'Too many requests. Slow down and try again.' });
  },
});
app.use('/api/v1/actions/login', loginLimiter);
app.use('/api/v1/actions', globalLimiter);

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'pharmapro-backend', time: new Date().toISOString() });
});

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'PharmaPro backend API (SWM — Sahak Web & Media)',
    actions: ACTION_NAMES,
    docs: 'POST /api/v1/actions/<actionName> with JSON body { token, ...fields }',
  });
});

app.post('/api/v1/actions/:action', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError('Request body must be a JSON object', 400);
    }
    const data = await dispatch(String(req.params.action), body, req.headers.authorization);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

// Unknown routes
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// Error handler — always { ok: false, error }.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ ok: false, error: err.message });
    return;
  }
  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

async function main(): Promise<void> {
  if (process.env.DISABLE_AUTO_MIGRATE !== '1') {
    await runMigrations();
  }
  const server = app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`PharmaPro backend listening on port ${PORT}`);
  });
  const shutdown = async () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start:', err);
  process.exit(1);
});
