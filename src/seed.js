// Must be first: populates process.env from .env when running locally.
// On a host like Railway the variables already exist and this is a no-op.
import './lib/env.js';
/**
 * Seeds the catalog, the admin account and a small demo cast.
 *
 *   npm run seed          — upsert (safe to re-run)
 *   npm run seed:reset    — drop every Pro Helper collection first
 */
import mongoose from 'mongoose';
import { connectDb } from './lib/db.js';
import { ensureSettings } from './lib/settings.js';
import { hashPassword } from './lib/auth.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, ROLES } from './config.js';
import { CATALOG } from './scripts/catalog.js';
import { normaliseOptions } from './lib/serviceOptions.js';
import {
  Address, HelperProfile, Service, User,
  Task, JobRequest, TaskEvent, Rating, LedgerEntry, Notification, AuditLog, Otp, HelperDocument,
} from './models/index.js';

const RESET = process.argv.includes('--reset');


/** The launch catalog lives in one place, shared with `npm run catalog:sync`. */
const SERVICES = CATALOG.map((service) => ({ ...service, options: normaliseOptions(service.options || []) }));

async function run() {
  await connectDb();

  if (RESET) {
    console.log('[seed] --reset: dropping existing collections');
    const models = [User, Address, Service, HelperProfile, HelperDocument, Task, JobRequest,
      TaskEvent, Rating, LedgerEntry, Notification, AuditLog, Otp];
    for (const model of models) {
      await model.collection.drop().catch((e) => {
        if (e.codeName !== 'NamespaceNotFound') throw e;
      });
    }
    // Left over from an earlier prototype — not used by any current model.
    for (const stale of ['helpers', 'bookings']) {
      await mongoose.connection.db.collection(stale).drop().catch(() => {});
    }
    await Promise.all(models.map((m) => m.syncIndexes()));
  }

  await ensureSettings();
  console.log('[seed] settings ready');

  for (const s of SERVICES) {
    await Service.updateOne({ code: s.code }, { $set: { ...s, active: true } }, { upsert: true });
  }
  // Anything no longer offered is retired rather than deleted, so past bookings
  // keep pointing at a real catalog entry (UC-C42).
  const retired = await Service.updateMany(
    { code: { $nin: SERVICES.map((s) => s.code) }, active: true },
    { $set: { active: false } },
  );
  console.log(
    `[seed] ${SERVICES.length} services` +
      (retired.modifiedCount ? ` (${retired.modifiedCount} retired)` : ''),
  );

  // --- admin (web dashboard) ---
  const admin = await User.findOneAndUpdate(
    { email: ADMIN_EMAIL, role: ROLES.ADMIN },
    { $set: { name: 'Platform Admin', status: 'active' }, $setOnInsert: { passwordHash: hashPassword(ADMIN_PASSWORD) } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  console.log(`[seed] admin ${admin.email}`);

  console.log(`
──────────────────────────────────────────────────────────────
  Catalog and admin are ready. No customers, no helpers —
  register them through the app.

  Admin web    ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}
  OTP          any 6 digits (DUMMY_AUTH=true)
──────────────────────────────────────────────────────────────
`);

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error('[seed] failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
