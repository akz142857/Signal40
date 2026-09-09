import { closeDatabase, db } from '../lib/runtime.ts';
import { loadSourceSloSnapshots } from '../lib/source-slo.ts';

try {
  const generatedAt = new Date();
  const report = await loadSourceSloSnapshots(db, generatedAt);
  process.stdout.write(
    `${JSON.stringify({ generatedAt: generatedAt.toISOString(), ...report }, null, 2)}\n`,
  );
} finally {
  await closeDatabase();
}
