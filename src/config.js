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
  /**
   * Which helpers a booking is sent to (UC-C08):
   *  anywhere  — every available helper
   *  society   — only helpers who work in the booking's locality
   * Helpers choose their localities; the admin chooses how strictly they apply.
   */
  match_mode: 'anywhere',
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
  dispatch_batch_size: 3,         // society mode: new helpers alerted per pass, nearest first
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
   * Locality pricing (UC-C43): where the extra goes when a locality is priced
   * above the catalog. 'helper' — the helper is paid on the price the customer
   * paid. 'platform' — the helper is paid as if it were the catalog price.
   */
  locality_uplift_to: 'helper', // helper | platform
  // --- promo codes (UC-C32) ---
  promo_enabled: true,
  // --- online payment (UC-C28) ---
  online_payment_enabled: true,
  // --- referrals ---
  referral_enabled: true,
  /*
   * Referral money comes in two kinds, and they are never the same thing:
   *
   *   Referral points — paid to the person whose code was used.
   *   Joining bonus   — paid to the person who joined with it.
   *
   * Each is set per role, and the rate follows the role of whoever is being
   * paid: a helper who refers earns helper referral points, a customer who
   * joins earns the customer joining bonus. A referral partner counts as a
   * helper on both sides. Nothing is paid until the person who joined
   * finishes their first booking.
   */
  helper_referral_points: 300,
  helper_joining_bonus: 200,
  customer_referral_points: 100,
  customer_joining_bonus: 100,
  referral_apply_window_days: 7,   // a code can only be entered this soon after signing up
  referral_max_booking_percent: 50, // at most this share of a booking's total can be paid with referral balance
  /**
   * What earns the reward (UC-C33): the referred person's first COMPLETED job,
   * or their first SETTLED one — settled meaning the money actually changed
   * hands. Installing the app never earns anything.
   */
  referral_qualify_event: 'COMPLETED', // COMPLETED | SETTLED
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
  /*
   * What each side can tick when rating the other (UC-C20 / UC-C21). Which
   * list they see follows the stars they gave, so the words always match the
   * mood: 1-2 low, 3 middling, 4-5 high. "Other", with the note box under it,
   * is always offered on top of these, so a list can never be a dead end.
   *
   * `_helper_` is what a customer says about a helper; `_customer_` is what a
   * helper says about the household they worked in.
   */
  rating_reasons_helper_low: [
    'Service quality was poor',
    'Helper was late',
    'Helper was unprofessional',
    'Work was incomplete',
    'Behaviour was not good',
    'Not satisfied',
  ],
  rating_reasons_helper_mid: [
    'Service was okay',
    'Could be improved',
    'Some issues with the service',
    'Helper was slightly late',
    'Expected better',
  ],
  rating_reasons_helper_high: [
    'Excellent service',
    'Helper was professional',
    'Work was done well',
    'Helper was punctual',
    'Good behaviour',
    'Very satisfied',
  ],
  rating_reasons_customer_low: [
    'Home was not ready',
    'Instructions were unclear',
    'Behaviour was not good',
    'Kept me waiting',
    'Asked for much more than booked',
    'Would rather not go back',
  ],
  rating_reasons_customer_mid: [
    'It was okay',
    'Instructions came late',
    'Took longer than expected',
    'Home could have been readier',
    'Expected better',
  ],
  rating_reasons_customer_high: [
    'Clear instructions',
    'Home was ready',
    'Polite and respectful',
    'Fair about the work',
    'Paid without fuss',
    'Would happily go back',
  ],

  // --- cancellation (UC-C22) ---
  /*
   * The reasons each app offers when someone cancels, in the order shown.
   * "Something else", with a written note, is always offered last and is not
   * listed here. An empty list leaves only that.
   */
  cancel_reasons_customer: [
    'My plans changed',
    'Wrong date or time',
    'Booked by mistake',
    'The price is too high',
    'Not happy with the helper',
  ],
  cancel_reasons_helper: [
    'I am unwell',
    'Family emergency',
    'The address is too far',
    'I have another job at this time',
  ],
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
  match_mode: ['anywhere', 'society'],
  platform_fee_type: ['percent', 'flat'],
  helper_commission_type: ['percent', 'flat'],
  locality_uplift_to: ['helper', 'platform'],
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
