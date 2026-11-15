// PostgreSQL pool + migration runner + transaction helper.
import { promises as fs } from 'fs';
import path from 'path';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set (see .env.example)');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected pg pool error', err);
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export type Tx = PoolClient;

export async function txQuery<T extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return client.query<T>(text, params as never[]);
}

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/** Applies pending numbered migrations in order. Safe to run repeatedly. */
export async function runMigrations(): Promise<string[]> {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const applied = await query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  const done = new Set(applied.rows.map((r) => r.version));
  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    // eslint-disable-next-line no-console
    console.log(`Applying migration ${file}...`);
    await withTx(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    });
    newlyApplied.push(file);
  }
  return newlyApplied;
}
