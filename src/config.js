/**
 * Central configuration.
 *
 * Anything a business person might want to change lives in DEFAULT_SETTINGS,
 * which is written into the `settings` collection on first boot and read from
 * the database at runtime — never from this file (spec: "business rules must be
 * configurable rather than hard-coded").
 */
export const PORT = Number(process.env.PORT || 4000);
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const MONGO_URI = process.env.MONGO_URI;
export const JWT_SECRET = process.env.JWT_SECRET || 'prohelper-dev-secret';
export const JWT_TTL = process.env.JWT_TTL || '30d';
export const DEV_OTP = process.env.DEV_OTP !== 'false';

/**
 * Demo mode. Phone numbers are still stored and accounts are still created,
 * but ANY 6-digit code passes verification so the client can walk the flow
 * without an SMS gateway. Set DUMMY_AUTH=false to enforce real OTPs.
 */
export const DUMMY_AUTH = process.env.DUMMY_AUTH !== 'false';

export const CLOUDINARY = {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
};
export const CLOUDINARY_ENABLED = Boolean(
  CLOUDINARY.cloud_name && CLOUDINARY.api_key && CLOUDINARY.api_secret,
);

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@prohelper.in';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin@123';

export const ROLES = { CUSTOMER: 'customer', HELPER: 'helper', ADMIN: 'admin' };

/** Task lifecycle (spec §60). */
export const TASK_STATUS = {
  CREATED: 'CREATED',
  SEARCHING: 'SEARCHING',
  ACCEPTED: 'ACCEPTED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETION_PENDING: 'COMPLETION_PENDING',
  COMPLETED: 'COMPLETED',
  SETTLED: 'SETTLED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  NO_HELPER_AVAILABLE: 'NO_HELPER_AVAILABLE',
};

/**
 * The only legal transitions. Everything else is refused by moveTask(), so a
 * replayed request or a stale mobile screen can never corrupt a booking
 * (e.g. COMPLETED -> ACCEPTED is impossible).
 */
export const ALLOWED_TRANSITIONS = {
  CREATED: ['SEARCHING', 'CANCELLED'],
  SEARCHING: ['ACCEPTED', 'NO_HELPER_AVAILABLE', 'CANCELLED'],
  ACCEPTED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETION_PENDING', 'CANCELLED'],
  // The self-transition is a re-issued completion OTP, not a state change.
  COMPLETION_PENDING: ['COMPLETED', 'COMPLETION_PENDING', 'IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['SETTLED'],
  SETTLED: [],
  CANCELLED: [],
  EXPIRED: [],
  NO_HELPER_AVAILABLE: ['SEARCHING', 'CANCELLED'],
};

export const HELPER_APPROVAL = {
  DRAFT: 'DRAFT',
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
};

/** Initial values for the admin-tunable rules. Seeded once, then owned by the DB. */
export const DEFAULT_SETTINGS = {
  // --- matching (UC-C08 / UC-C10 / UC-C12) ---
  search_radius_km: 12,          // covers most of a metro on the first wave
  radius_step_km: 15,            // widen by this much each dispatch round
  max_dispatch_rounds: 3,
  dispatch_batch_size: 3,         // helpers alerted simultaneously per round
  accept_window_seconds: 60,      // the 60-second accept window
  // --- money (UC-C29 / UC-C30 / UC-C31) ---
  platform_fee_percent: 5,        // customer-side service fee
  helper_commission_percent: 15,  // deducted from the helper's gross
  gst_percent: 18,
  surcharge_flat: 20,
  currency: 'INR',
  // --- completion (UC-C17) ---
  completion_otp_ttl_seconds: 900,
  completion_otp_max_attempts: 5,
  // --- abuse control (UC-C23) ---
  rejection_block_threshold: 5,
  // --- overdue monitoring (UC-C18) ---
  overdue_reminder_minutes: 90,
};
