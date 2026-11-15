// Standalone migration runner: `npm run migrate`.
import 'dotenv/config';
import { runMigrations, pool } from './db';

async function main(): Promise<void> {
  const applied = await runMigrations();
  if (applied.length === 0) {
    // eslint-disable-next-line no-console
    console.log('Database is up to date.');
  } else {
    // eslint-disable-next-line no-console
    console.log(`Applied: ${applied.join(', ')}`);
  }
  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Migration failed:', err);
  process.exit(1);
});
