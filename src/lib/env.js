import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads `.env` into process.env when the file exists.
 *
 * Deliberately not `node --env-file=.env`: that flag throws ENOENT when the
 * file is absent, which is exactly the case on a hosting platform where the
 * variables are supplied by the environment instead. Real environment
 * variables always win, so a platform value is never overwritten by a stale
 * local file.
 *
 * Must be imported before ./config.js, which reads process.env at load time.
 */
function loadEnv() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const file = process.env.ENV_FILE || path.join(root, '.env');

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false; // no local .env — the platform is providing the variables
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!key || key in process.env) continue; // never clobber a real env var

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

export const loadedFromFile = loadEnv();
