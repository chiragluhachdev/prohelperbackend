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

export const ROLES = { CUSTOMER: 'customer', HELPER: 'helper', ADMIN: 'admin', PARTNER: 'partner' };

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
  // ACCEPTED -> SEARCHING: the helper dropped the job (or was blocked), and the search goes on.
  ACCEPTED: ['IN_PROGRESS', 'SEARCHING', 'CANCELLED'],
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
  /**
   * Whether a helper may still take a job after their own alert stopped
   * ringing, as long as the search is open (UC-C52). Off: only a live alert
   * can be accepted. Either way the phone's countdown decides nothing — the
   * server's clock and the booking's own state do.
   */
  accept_after_ring_enabled: true,
  // --- money (UC-C29 / UC-C30 / UC-C31) — every charge can be switched off ---
  // The customer's side of the commission (UC-C29): a share, or a flat amount.
  platform_fee_enabled: true,
  platform_fee_type: 'percent',   // percent | flat
  platform_fee_percent: 5,        // customer-side service fee, on services after discounts
  platform_fee_flat: 20,          // used when the type is flat
  platform_fee_label: 'Platform fee',
  discount_enabled: false,
  discount_percent: 10,           // off the services amount
  discount_max: 100,              // ₹ cap per booking (0 = no cap)
  discount_min_order: 0,          // services amount needed before it applies
  discount_label: 'Discount',
  surcharge_enabled: false,
  surcharge_flat: 20,             // ₹ per booking
  surcharge_applies_to: 'all',    // all | instant | scheduled
  surcharge_label: 'Special surcharge',
  gst_enabled: true,
  gst_percent: 18,
  gst_base: 'all',                // all (the whole bill) | fees (platform fee + surcharge only)
  gst_label: 'GST',
  // The helper's side of the commission (UC-C29). Either can be 0, or switched off entirely.
  helper_commission_enabled: true,
  helper_commission_type: 'percent', // percent | flat
  helper_commission_percent: 15,  // deducted from the helper's gross
  helper_commission_flat: 0,      // used when the type is flat
  currency: 'INR',
  /**
   * Locality pricing: where the extra goes when a society is priced above the
   * catalog. 'helper' — the helper is paid on the price the customer paid.
   * 'platform' — the helper is paid as if it were the catalog price.
   */
  zone_uplift_to: 'helper', // helper | platform
  // --- promo codes (UC-C32) ---
  promo_enabled: true,
  // --- online payment (UC-C28) ---
  online_payment_enabled: true,
  // --- referrals ---
  referral_enabled: true,
  referral_reward_amount: 100,     // to the person whose code was used
  referral_welcome_amount: 100,    // to the person who joined with it
  referral_apply_window_days: 7,   // a code can only be entered this soon after signing up
  referral_max_booking_percent: 50, // at most this share of a booking's total can be paid with referral balance
  /**
   * What earns the reward (UC-C33): the referred person's first COMPLETED job,
   * or their first SETTLED one — settled meaning the money actually changed
   * hands. Installing the app never earns anything.
   */
  referral_qualify_event: 'COMPLETED', // COMPLETED | SETTLED
  // What a referral partner gets when someone they signed up qualifies (UC-C34).
  partner_reward_amount: 100,
  // --- start (UC-C16): the customer's code before work begins ---
  start_otp_enabled: true,
  start_early_minutes: 60,          // a booking for later can be started at most this long before its slot (0 = any time)
  // --- completion (UC-C17) ---
  completion_otp_ttl_seconds: 900,
  completion_otp_max_attempts: 5,   // wrong codes per issued OTP (also used for the start code)
  completion_otp_resend_seconds: 30, // wait before another completion OTP can be sent
  completion_otp_max_sends: 5,      // completion OTPs one job can send in all
  // --- overdue monitoring (UC-C18) ---
  overdue_reminder_minutes: 90,     // this long past the expected finish, remind both sides
  overdue_repeat_minutes: 60,       // and again this often (0 = remind once)
  overdue_max_reminders: 3,
  // --- cancellation (UC-C22) ---
  customer_cancel_until: 'IN_PROGRESS', // the last status a customer can cancel in: SEARCHING | ACCEPTED | IN_PROGRESS
  helper_cancel_enabled: true,
  helper_cancel_min_minutes_before: 60, // a booking for later can't be dropped closer to its slot than this (0 = any time)
  helper_cancel_action: 'research', // research (find another helper) | cancel (end the booking)
  auto_cancel_unstarted_hours: 6,   // accepted but not started this long after the slot → cancelled by the system (0 = off)
  auto_cancel_no_helper_hours: 24,  // no helper found and not retried for this long → cancelled by the system (0 = off)
  // --- rejection and blocking (UC-C23) — 0 switches a rule off ---
  rejection_block_threshold: 5,     // helpers: declined requests + accepted jobs dropped
  customer_rejection_block_threshold: 5, // customers: bookings cancelled after a helper was assigned
};

/** Settings that take one of a fixed set of words — anything else is refused on save. */
export const SETTING_CHOICES = {
  surcharge_applies_to: ['all', 'instant', 'scheduled'],
  gst_base: ['all', 'fees'],
  customer_cancel_until: ['SEARCHING', 'ACCEPTED', 'IN_PROGRESS'],
  platform_fee_type: ['percent', 'flat'],
  helper_commission_type: ['percent', 'flat'],
  zone_uplift_to: ['helper', 'platform'],
  referral_qualify_event: ['COMPLETED', 'SETTLED'],
  helper_cancel_action: ['research', 'cancel'],
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
