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
import { ADMIN_EMAIL, ADMIN_PASSWORD, ROLES, HELPER_APPROVAL, CLOUDINARY } from './config.js';
import {
  Address, HelperProfile, Service, User,
  Task, JobRequest, TaskEvent, Rating, LedgerEntry, Notification, AuditLog, Otp, HelperDocument,
} from './models/index.js';

const RESET = process.argv.includes('--reset');

/** Stand-in for a scanned Aadhaar. Every Cloudinary account ships `sample.jpg`. */
const PLACEHOLDER_DOC = `https://res.cloudinary.com/${CLOUDINARY.cloud_name || 'demo'}/image/upload/sample.jpg`;

/** The six categories in the MVP brief. Everything here is admin-editable later. */
const SERVICES = [
  {
    code: 'full_home', name: 'Full Home Cleaning', category: 'Cleaning', icon: '🏠',
    description: 'Dusting, floors, bathrooms and kitchen — the whole house in one visit.',
    basePrice: 249, durationLabel: '2 - 4 hours', defaultDurationMins: 180, sortOrder: 1,
    options: [],
  },
  {
    code: 'kitchen', name: 'Kitchen Cleaning', category: 'Cleaning', icon: '🍲',
    description: 'Slabs, stove, chimney, sink and cabinet fronts scrubbed down.',
    basePrice: 149, durationLabel: '1 - 2 hours', defaultDurationMins: 90, sortOrder: 2,
    options: [],
  },
  {
    code: 'bathroom', name: 'Bathroom Cleaning', category: 'Cleaning', icon: '🚿',
    description: 'Commode, shower area, tiles, grout and fixtures disinfected.',
    basePrice: 149, durationLabel: '1 - 2 hours', defaultDurationMins: 90, sortOrder: 3,
    options: [],
  },
  {
    code: 'sofa', name: 'Sofa & Upholstery Cleaning', category: 'Cleaning', icon: '🛋️',
    description: 'Vacuum, shampoo and stain treatment for sofas and upholstery.',
    basePrice: 199, durationLabel: '1 - 2 hours', defaultDurationMins: 90, sortOrder: 4,
    options: [],
  },
];

/** Demo cast, all around Koramangala so the matcher has something to find. */
const DEMO_HELPERS = [
  {
    phone: '9876511001', name: 'Priya Sharma', documentStatus: 'APPROVED',
    profile: {
      gender: 'female', experienceYears: 6,
      bio: 'Six years of household work across Koramangala and HSR. Punctual and thorough.',
      aadhaarLast4: '4819', aadhaarName: 'Priya Sharma', kycStatus: 'VERIFIED',
      kycMethod: 'aadhaar-otp', kycVerifiedAt: new Date(),
      approvalStatus: HELPER_APPROVAL.APPROVED, submittedAt: new Date(), reviewedAt: new Date(),
      services: ['full_home', 'kitchen', 'bathroom', 'sofa'],
      serviceArea: { label: 'Koramangala, HSR Layout', lat: 12.9352, lng: 77.6245, radiusKm: 30 },
      workDays: [0, 1, 2, 3, 4, 5, 6], workStart: '00:00', workEnd: '23:59',
      isOnline: false, ratingAvg: 4.8, ratingCount: 96, completedJobs: 138,
    },
  },
  {
    phone: '9876511002', name: 'Anita Devi', documentStatus: 'APPROVED',
    profile: {
      gender: 'female', experienceYears: 4,
      bio: 'Cleaning and dishwashing specialist. Available mornings and evenings.',
      aadhaarLast4: '2276', aadhaarName: 'Anita Devi', kycStatus: 'VERIFIED',
      kycMethod: 'digilocker', kycVerifiedAt: new Date(),
      approvalStatus: HELPER_APPROVAL.APPROVED, submittedAt: new Date(), reviewedAt: new Date(),
      services: ['full_home', 'kitchen', 'bathroom'],
      serviceArea: { label: 'Ejipura, Viveknagar', lat: 12.9279, lng: 77.6271, radiusKm: 30 },
      workDays: [0, 1, 2, 3, 4, 5, 6], workStart: '00:00', workEnd: '23:59',
      isOnline: false, ratingAvg: 4.6, ratingCount: 41, completedJobs: 57,
    },
  },
  {
    // Left in the queue on purpose so the admin dashboard has something to approve.
    phone: '9876511003', name: 'Sunita Kumari', documentStatus: 'PENDING',
    profile: {
      gender: 'female', experienceYears: 2,
      bio: 'New to the platform. Kitchen assistance and laundry.',
      aadhaarLast4: '7710', aadhaarName: 'Sunita Kumari', kycStatus: 'VERIFIED',
      kycMethod: 'aadhaar-otp', kycVerifiedAt: new Date(),
      approvalStatus: HELPER_APPROVAL.PENDING_VERIFICATION, submittedAt: new Date(),
      services: ['kitchen', 'bathroom'],
      serviceArea: { label: 'Indiranagar, Domlur', lat: 12.9698, lng: 77.6500, radiusKm: 30 },
      workDays: [0, 1, 2, 3, 4, 5, 6], workStart: '00:00', workEnd: '23:59',
      isOnline: false, ratingAvg: 0, ratingCount: 0, completedJobs: 0,
    },
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

  // --- demo customer ---
  const customer = await User.findOneAndUpdate(
    { phone: '9876500001', role: ROLES.CUSTOMER },
    { $set: { name: 'Rahul Verma', status: 'active' } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const hasAddress = await Address.countDocuments({ userId: customer._id, active: true });
  if (!hasAddress) {
    await Address.create({
      userId: customer._id, label: 'Home',
      line1: '№ 412, Sterling Residency', line2: '5th Block, Koramangala',
      landmark: 'Near Jyoti Nivas College', city: 'Bengaluru', pincode: '560095',
      lat: 12.9345, lng: 77.6260, isDefault: true,
    });
  }
  console.log(`[seed] customer ${customer.phone} (${customer.name})`);

  // --- demo helpers ---
  for (const h of DEMO_HELPERS) {
    const user = await User.findOneAndUpdate(
      { phone: h.phone, role: ROLES.HELPER },
      { $set: { name: h.name, status: 'active' } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await HelperProfile.updateOne(
      { userId: user._id },
      { $set: { ...h.profile, userId: user._id } },
      { upsert: true },
    );

    // Placeholder KYC files so the admin dashboard has something to review.
    // `sample.jpg` exists in every Cloudinary account.
    for (const type of ['aadhaar_front', 'aadhaar_back']) {
      await HelperDocument.updateOne(
        { helperId: user._id, type },
        {
          $set: {
            helperId: user._id, type,
            url: PLACEHOLDER_DOC,
            originalName: `${type}.jpg`,
            mimeType: 'image/jpeg',
            sizeBytes: 120_000,
            status: h.documentStatus,
          },
        },
        { upsert: true },
      );
    }

    console.log(`[seed] helper ${h.phone} (${h.name}) — ${h.profile.approvalStatus}`);
  }

  console.log(`
──────────────────────────────────────────────────────────────
  Demo logins — any 6-digit OTP works (DUMMY_AUTH=true)

  Customer     9876500001   Rahul Verma
  Helper       9876511001   Priya Sharma    (approved, all services)
  Helper       9876511002   Anita Devi      (approved, cleaning)
  Helper       9876511003   Sunita Kumari   (pending — approve her in the dashboard)

  Admin web    ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}
──────────────────────────────────────────────────────────────
`);

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error('[seed] failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
