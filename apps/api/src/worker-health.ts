import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
try {
  const health = JSON.parse(await readFile(join(tmpdir(), 'astrama-worker-health.json'), 'utf8')) as { successful: boolean; checkedAt: number };
  if (!health.successful || Date.now() - health.checkedAt > 120000) process.exitCode = 1;
} catch { process.exitCode = 1; }
