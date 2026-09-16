import { TASK_STATUS } from '../config.js';
import { badRequest } from './http.js';

/** The helper app's tabs, mapped onto real statuses. */
export const TASK_TABS = {
  upcoming: [TASK_STATUS.CREATED, TASK_STATUS.SEARCHING, TASK_STATUS.ACCEPTED],
  active: [TASK_STATUS.IN_PROGRESS, TASK_STATUS.COMPLETION_PENDING],
  completed: [TASK_STATUS.COMPLETED, TASK_STATUS.SETTLED],
  cancelled: [TASK_STATUS.CANCELLED, TASK_STATUS.EXPIRED, TASK_STATUS.NO_HELPER_AVAILABLE],
};

/**
 * UC-C19 — the customer's booking history, one filter per tab.
 *
 *  cancelled   the customer called it off
 *  rejected    it was called off on their side of the table: by the helper,
 *              Pro Helper (an admin), or the system — or it expired
 *  no_helper   the search ended without anyone accepting
 */
export const CUSTOMER_TABS = {
  upcoming: { status: { $in: TASK_TABS.upcoming } },
  active: { status: { $in: TASK_TABS.active } },
  completed: { status: { $in: TASK_TABS.completed } },
  cancelled: { status: TASK_STATUS.CANCELLED, 'cancellation.by': 'customer' },
  rejected: {
    $or: [
      { status: TASK_STATUS.CANCELLED, 'cancellation.by': { $ne: 'customer' } },
      { status: TASK_STATUS.EXPIRED },
    ],
  },
  no_helper: { status: TASK_STATUS.NO_HELPER_AVAILABLE },
};

/** A rating as sent by either app, checked: whole stars 1–5, a short comment, a few short tags. */
export function ratingInput(body = {}) {
  const stars = Number(body.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw badRequest('Choose between 1 and 5 stars.', 'INVALID_RATING');
  const comment = String(body.comment ?? '').trim().slice(0, 500);
  const tags = (Array.isArray(body.tags) ? body.tags : [])
    .map((tag) => String(tag).trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 8);
  return { stars, comment, tags };
}

/** When a job should be done by: its start (or slot, if not started) plus how long it was booked for. */
export function expectedEndAt(t) {
  const start = new Date(t.startedAt || t.scheduledAt || t.createdAt);
  return new Date(start.getTime() + (Number(t.durationMins) || 60) * 60_000);
}

export const STATUS_LABELS = {
  CREATED: 'Creating',
  SEARCHING: 'Finding a helper',
  ACCEPTED: 'Confirmed',
  IN_PROGRESS: 'In progress',
  COMPLETION_PENDING: 'Awaiting OTP',
  COMPLETED: 'Completed',
  SETTLED: 'Settled',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  NO_HELPER_AVAILABLE: 'No helper available',
};

export const DEFAULT_JOBS_SHOWN = 50;

/**
 * "50+" while the admin-set figure is higher than the real count, the real
 * number once the helper has actually done more. Setting it to 0 shows only
 * the true count.
 */
export function jobsLabel(profile) {
  const real = profile?.completedJobs ?? 0;
  const shown = profile?.jobsShown ?? DEFAULT_JOBS_SHOWN;
  return real >= shown ? String(real) : `${shown}+`;
}

const person = (u) =>
  u && typeof u === 'object' && u._id
    ? { id: String(u._id), name: u.name || '', phone: u.phone || '', photoUrl: u.photoUrl || '' }
    : null;

/**
 * One task shape for both apps. `audience` decides which side's contact
 * details and money numbers are attached.
 */
export function serializeTask(task, { audience = 'customer', helperProfile = null } = {}) {
  const t = task.toObject ? task.toObject() : task;

  const base = {
    id: String(t._id),
    code: t.code,
    status: t.status,
    statusLabel: STATUS_LABELS[t.status] || t.status,
    services: (t.services || []).map((s) => ({
      code: s.code,
      name: s.name,
      nameHi: s.nameHi || '',
      icon: s.icon,
      options: s.options || {},
      answers: s.answers || [],
      basePrice: s.basePrice,
      // What the catalog asks, and where this price came from (locality pricing, UC-C43).
      listPrice: s.listPrice ?? s.basePrice,
      priceSource: s.priceSource || 'catalog',
      optionsAmount: s.optionsAmount || 0,
      amount: s.amount,
      minutes: s.minutes || 0,
    })),
    address: t.address,
    bookingType: t.bookingType || 'scheduled',
    searchStartedAt: t.searchStartedAt,
    searchExpiresAt: t.searchExpiresAt,
    searchMode: t.searchMode || 'instant',
    scheduledAt: t.scheduledAt,
    scheduledDate: t.scheduledDate,
    scheduledTime: t.scheduledTime,
    durationMins: t.durationMins,
    instructions: t.instructions,
    paymentStatus: t.paymentStatus,
    paymentMode: t.paymentMode,
    paidAt: t.paidAt,
    paidByRole: t.paidByRole,
    createdAt: t.createdAt,
    acceptedAt: t.acceptedAt,
    startedAt: t.startedAt,
    completedAt: t.completedAt,
    settledAt: t.settledAt,
    cancellation: t.cancellation?.at
      ? {
          by: t.cancellation.by,
          reason: t.cancellation.reason,
          previousStatus: t.cancellation.previousStatus,
          at: t.cancellation.at,
          financialImpact: t.cancellation.financialImpact || null,
        }
      : null,
    expectedEndAt: expectedEndAt(t),
    overdue: Boolean(t.overdueNotifiedAt) && ['ACCEPTED', 'IN_PROGRESS', 'COMPLETION_PENDING'].includes(t.status),
  };

  if (audience === 'customer') {
    return {
      ...base,
      pricing: t.pricing,
      total: t.pricing?.total ?? 0,
      referralCredit: t.pricing?.referralCredit ?? 0,
      // What the customer actually pays: the bill less any referral balance used.
      amountDue: Math.round(((t.pricing?.total ?? 0) - (t.pricing?.referralCredit ?? 0)) * 100) / 100,
      helper: person(t.helperId)
        ? {
            ...person(t.helperId),
            rating: helperProfile?.ratingAvg ?? null,
            completedJobs: helperProfile?.completedJobs ?? null,
            jobsLabel: helperProfile ? jobsLabel(helperProfile) : null,
            experienceYears: helperProfile?.experienceYears ?? null,
          }
        : t.helperId && t.helperSnapshot?.name
          // The account is gone or wasn't loaded: the booking still says who did it.
          ? { id: String(t.helperId), name: t.helperSnapshot.name, phone: '', photoUrl: '' }
          : null,
      // How many helpers took this booking and then dropped it.
      helperChanges: (t.helperCancellations || []).length,
      rated: Boolean(t.ratedByCustomer),
      // Read out to the helper at the door; gone once work has started.
      startOtp: t.status === 'ACCEPTED' ? t.startOtp?.code ?? null : null,
      // Only meaningful once the helper has asked to close the job (UC-C17).
      completionOtp: t.status === 'COMPLETION_PENDING' ? t.completionOtp?.code ?? null : null,
      completionOtpExpiresAt: t.status === 'COMPLETION_PENDING' ? t.completionOtp?.expiresAt ?? null : null,
    };
  }

  // Helper view: the payout, not the customer's bill — except once the job is
  // done, when a helper collecting cash/UPI needs to know the full amount the
  // customer owes, not just their own share of it.
  return {
    ...base,
    customer: person(t.customerId),
    earning: t.pricing?.helperPayout ?? 0,
    commission: t.pricing?.helperCommission ?? 0,
    gross: t.pricing?.servicesAmount ?? 0,
    total: [TASK_STATUS.COMPLETED, TASK_STATUS.SETTLED].includes(t.status) ? t.pricing?.total ?? 0 : undefined,
    // The cash to collect: the bill less any referral balance the customer used.
    amountDue: [TASK_STATUS.COMPLETED, TASK_STATUS.SETTLED].includes(t.status)
      ? Math.round(((t.pricing?.total ?? 0) - (t.pricing?.referralCredit ?? 0)) * 100) / 100
      : undefined,
    referralCredit: t.pricing?.referralCredit ?? 0,
    currency: t.pricing?.currency || 'INR',
    rated: Boolean(t.ratedByHelper),
  };
}
