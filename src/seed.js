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
import { HINDI_CATALOG } from './scripts/hindiCatalog.js';
import {
  Address, HelperProfile, Service, User,
  Task, JobRequest, TaskEvent, Rating, LedgerEntry, Notification, AuditLog, Otp, HelperDocument,
} from './models/index.js';

const RESET = process.argv.includes('--reset');


/** The six categories in the MVP brief. Everything here is admin-editable later. */
const SERVICES = [
  {
    code: 'full_home', name: 'Full Home Cleaning', category: 'Cleaning', icon: '🏠',
    description: 'Dusting, floors, bathrooms and kitchen — the whole house in one visit.',
    basePrice: 249, durationLabel: '2 - 4 hours', defaultDurationMins: 180, sortOrder: 1,
    inclusions: [
      'Dusting all rooms and surfaces',
      'Sweeping and mopping all floors',
      'Bathroom deep cleaning',
      'Kitchen cleaning and organising',
      'Trash removal and disposal',
    ],
    /*
     * UC-C05 — the questions are data, not screens. Priced options default to
     * zero so the advertised "from ₹249" stays true until the customer adds
     * something.
     */
    options: [
      {
        key: 'home_size', label: 'Home size', type: 'select',
        choices: ['1 BHK', '2 BHK', '3 BHK', '4 BHK+'],
        required: true, defaultValue: '2 BHK',
      },
      {
        key: 'extra_bathrooms', label: 'Extra bathrooms', type: 'number',
        unit: 'bathrooms', pricePerUnit: 80, defaultValue: 0,
      },
      {
        key: 'balcony', label: 'Include balcony', type: 'boolean',
        pricePerUnit: 60, defaultValue: false,
      },
    ],
  },
  {
    code: 'kitchen', name: 'Kitchen Cleaning', category: 'Cleaning', icon: '🍲',
    description: 'Slabs, stove, chimney, sink and cabinet fronts scrubbed down.',
    basePrice: 149, durationLabel: '1 - 2 hours', defaultDurationMins: 90, sortOrder: 2,
    inclusions: [
      'Cleaning kitchen slabs and countertops',
      'Stove, hob and chimney cleaning',
      'Sink cleaning and descaling',
      'Outside cleaning of cabinets and drawers',
      'Floor cleaning and trash removal',
    ],
    options: [
      {
        key: 'load', label: 'How much is there?', type: 'select',
        choices: ['Light', 'Medium', 'Heavy'], required: true, defaultValue: 'Medium',
      },
      {
        key: 'chimney', label: 'Deep-clean the chimney', type: 'boolean',
        pricePerUnit: 99, defaultValue: false,
      },
    ],
  },
  {
    code: 'bathroom', name: 'Bathroom Cleaning', category: 'Cleaning', icon: '🚿',
    description: 'Commode, shower area, tiles, grout and fixtures disinfected.',
    basePrice: 149, durationLabel: '1 - 2 hours', defaultDurationMins: 90, sortOrder: 3,
    inclusions: [
      'Toilet and commode deep cleaning',
      'Shower area and glass cleaning',
      'Tile and grout scrubbing',
      'Mirror and fixture polishing',
      'Floor cleaning and disinfecting',
    ],
    options: [],
  },
  {
    code: 'sofa', name: 'Sofa & Upholstery Cleaning', category: 'Cleaning', icon: '🛋️',
    description: 'Vacuum, shampoo and stain treatment for sofas and upholstery.',
    basePrice: 199, durationLabel: '1 - 2 hours', defaultDurationMins: 90, sortOrder: 4,
    inclusions: [
      'Vacuuming sofa and cushions',
      'Stain removal treatment',
      'Deep fabric cleaning',
      'Deodorising and sanitising',
      'Drying and fluffing cushions',
    ],
    options: [],
  },
];

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
    await Service.updateOne({ code: s.code }, { $set: { ...s, ...(HINDI_CATALOG[s.code] || {}), active: true } }, { upsert: true });
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
