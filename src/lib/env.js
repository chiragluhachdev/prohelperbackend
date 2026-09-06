import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads a local `.env` if one exists — nothing more.
 *
 * Hosts like Railway inject configuration as real environment variables and
 * have no `.env` file, so `node --env-file=.env` crashes there with ENOENT.
 * This does the same job without a flag, without a dependency, and without
 * ever overwriting a variable the platform has already set.
 *
 * Import this before anything that reads `process.env`.
 */
function loadEnvFile() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envPath = process.env.ENV_FILE || path.resolve(here, '../../.env');

  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    return false; // no local file — the platform is supplying the config
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!key || key in process.env) continue; // a real env var always wins

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  return true;
}

export const loadedFromFile = loadEnvFile();
