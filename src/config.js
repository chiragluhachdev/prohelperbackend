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
  /*
   * The search is a window, not a fixed number of rounds: it stays open this
   * long, alerting helpers as they become available, then closes as
   * NO_HELPER_AVAILABLE.
   */
  search_duration_seconds: 300,    // 5 minutes
  renotify_interval_seconds: 90,   // an unanswered helper is alerted again this often
  /*
   * Bookings for later have no countdown. The time until shortly before the
   * slot is split into this many evenly spaced alert waves.
   */
  scheduled_notify_waves: 5,
  scheduled_close_minutes_before: 30, // stop searching this long before the slot
  /**
   * MVP: alert every eligible helper regardless of distance.
   *
   * The other gates still apply — approved, not blocked, online, not on DND,
   * offers the service, working that day and hour. Only the distance and
   * service-area checks are skipped. Set to false to switch the radius back on.
   */
  match_ignore_location: true,
  dispatch_batch_size: 3,         // with location on: new helpers alerted at a time, nearest first
  accept_window_seconds: 60,      // how long each alert rings (never longer than the re-notify interval)
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

/**
 * The day boundaries charts are drawn on. Mongo buckets dates in UTC unless
 * told otherwise, while the zero-fill used the server's local calendar — so
 * between midnight and 05:30 IST today's bookings landed on yesterday's bar.
 * Railway runs in UTC and a laptop in IST; naming the zone makes them agree.
 */
export const BUSINESS_TZ = process.env.BUSINESS_TZ || 'Asia/Kolkata';

/** 'YYYY-MM-DD' for a moment, as a calendar day in BUSINESS_TZ. */
export function dayKey(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}
