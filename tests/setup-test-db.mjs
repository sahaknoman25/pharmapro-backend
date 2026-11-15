// Test setup: recreates the pharmapro_test database and applies migrations.
// Run by `npm test` before the test file. Requires a local PostgreSQL
// server (see README) with a `postgres` superuser.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.join(__dirname, '..');
export const TEST_DATABASE_URL =
  'postgres://postgres:postgres@localhost:5432/pharmapro_test';

async function main() {
  const admin = new pg.Pool({
    connectionString: 'postgres://postgres:postgres@localhost:5432/postgres',
  });
  await admin.query('DROP DATABASE IF EXISTS pharmapro_test');
  await admin.query('CREATE DATABASE pharmapro_test');
  await admin.end();
  console.log('Test database pharmapro_test recreated.');

  // Apply migrations against the test database.
  await new Promise((resolve, reject) => {
    const child = spawn(
      'node',
      [path.join(BACKEND_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/migrate.ts'],
      {
        cwd: BACKEND_DIR,
        env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
        stdio: 'inherit',
      },
    );
    child.on('exit', (code) => (code === 0 ? resolve(null) : reject(new Error(`migrate exited ${code}`))));
  });
  console.log('Migrations applied to pharmapro_test.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
