/*
 * Modular imports. In firebase-admin v12+ the default export has no
 * credential namespace, so the old cert(...) call threw on every boot and
 * Firebase was never initialised — locally or on Railway.
 */
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { User } from '../models/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the service account comes from, in order:
 *
 *   1. FIREBASE_SERVICE_ACCOUNT — the JSON itself, or the JSON base64-encoded.
 *      This is the one that works on Railway: the key file is (rightly)
 *      gitignored, so a deploy from git never has it, and with the file as the
 *      only source every push on the live server was silently skipped.
 *   2. firebase-service-account.json in the backend root, for local runs.
 */
function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (raw) {
    const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const account = JSON.parse(json);
    // Railway and most dashboards store the key with literal "\n"s.
    if (account.private_key) account.private_key = account.private_key.replace(/\\n/g, '\n');
    return { account, source: 'FIREBASE_SERVICE_ACCOUNT' };
  }

  const file = path.resolve(__dirname, '../../firebase-service-account.json');
  if (fs.existsSync(file)) {
    return { account: JSON.parse(fs.readFileSync(file, 'utf8')), source: 'firebase-service-account.json' };
  }
  return null;
}

try {
  const loaded = loadServiceAccount();
  if (loaded) {
    initializeApp({ credential: cert(loaded.account) });
    console.log(`[fcm] ready — project ${loaded.account.project_id} (from ${loaded.source})`);
  } else {
    console.warn('[fcm] no credentials: set FIREBASE_SERVICE_ACCOUNT. Job pushes are OFF.');
  }
} catch (err) {
  console.error('[fcm] could not initialise Firebase Admin:', err.message);
}

export const fcmEnabled = () => getApps().length > 0;

/**
 * FCM rejects the whole message if any data value is not a string
 * ("data must only contain string values"). A Date, a number or a nested
 * object anywhere in the payload used to fail every job push, so everything
 * is flattened to strings here, once, for every caller.
 */
function toStringData(data) {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined || value === null) continue;
    if (value instanceof Date) out[key] = value.toISOString();
    else if (typeof value === 'object') out[key] = JSON.stringify(value);
    else out[key] = String(value);
  }
  return out;
}

/**
 * Errors that mean the token itself is dead. Deliberately not
 * `invalid-argument`: FCM also returns that for a malformed payload, and
 * treating it as a dead token would wipe every helper's token on one bad send.
 */
const DEAD_TOKEN = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/**
 * High-priority data-only push to one or more devices.
 *
 * Data-only (no `notification` block) so the app's background handler runs
 * and draws the ringing alert itself; `priority: high` so Doze wakes the
 * device for it. Tokens that FCM reports as dead are cleared from their user,
 * so a reinstalled app does not leave a helper silently unreachable forever.
 *
 * @returns number of devices the push was accepted for
 */
export async function sendDataPush(tokens, data) {
  const list = [...new Set((Array.isArray(tokens) ? tokens : [tokens]).filter(Boolean))];
  if (!list.length) return 0;
  if (!fcmEnabled()) {
    console.warn('[fcm] skipped — Firebase is not initialised');
    return 0;
  }

  const payload = toStringData(data);
  const response = await getMessaging().sendEach(
    list.map((token) => ({
      token,
      data: payload,
      android: {
        priority: 'high',
        // A job alert is worthless once the 60-second window has gone.
        ttl: 60 * 1000,
      },
    })),
  );

  const dead = [];
  response.responses.forEach((r, i) => {
    if (r.success) return;
    const code = r.error?.code;
    console.error(`[fcm] send failed (${code}): ${r.error?.message}`);
    if (DEAD_TOKEN.has(code)) dead.push(list[i]);
  });

  if (dead.length) {
    await User.updateMany({ fcmToken: { $in: dead } }, { $set: { fcmToken: null } });
    console.warn(`[fcm] cleared ${dead.length} dead token(s)`);
  }

  if (response.successCount) console.log(`[fcm] delivered to ${response.successCount}/${list.length} device(s)`);
  return response.successCount;
}
