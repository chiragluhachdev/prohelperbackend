import { Setting } from '../models/index.js';
import { DEFAULT_SETTINGS } from '../config.js';

/**
 * Settings are read on nearly every request, so they are cached for a few
 * seconds. Any write clears the cache immediately, so an admin change takes
 * effect on the very next booking.
 */
let cache = null;
let cachedAt = 0;
const TTL_MS = 5000;

export async function ensureSettings() {
  const ops = Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({
    updateOne: { filter: { key }, update: { $setOnInsert: { key, value } }, upsert: true },
  }));
  if (ops.length) await Setting.bulkWrite(ops);
  invalidateSettings();
}

export async function getSettings() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const rows = await Setting.find().lean();
  cache = { ...DEFAULT_SETTINGS };
  for (const r of rows) cache[r.key] = r.value;
  cachedAt = Date.now();
  return cache;
}

export async function getSetting(key) {
  return (await getSettings())[key];
}

export async function updateSettings(patch, adminId) {
  const ops = Object.entries(patch).map(([key, value]) => ({
    updateOne: { filter: { key }, update: { $set: { key, value, updatedBy: adminId } }, upsert: true },
  }));
  if (ops.length) await Setting.bulkWrite(ops);
  invalidateSettings();
  return getSettings();
}

export function invalidateSettings() {
  cache = null;
  cachedAt = 0;
}
