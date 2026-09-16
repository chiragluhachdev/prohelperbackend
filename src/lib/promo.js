import { PromoCode, PromoRedemption, Task } from '../models/index.js';
import { TASK_STATUS } from '../config.js';
import { badRequest, conflict } from './http.js';
import { getSettings } from './settings.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const normalisePromo = (code) => String(code ?? '').trim().toUpperCase().replace(/\s+/g, '');

/** What a promo takes off a given services amount, within its own cap. */
export function promoDiscountFor(promo, servicesAmount) {
  if (!promo) return 0;
  const raw = promo.type === 'PERCENT' ? (servicesAmount * Math.max(0, promo.value)) / 100 : Math.max(0, promo.value);
  const capped = promo.maxDiscount > 0 ? Math.min(raw, promo.maxDiscount) : raw;
  // Never more than the services themselves — the platform funds this, not the helper.
  return round2(Math.min(capped, servicesAmount));
}

/**
 * UC-C32 — whether this customer may use this code on this booking, checked
 * against every rule the admin set. Throws a coded error saying which rule
 * stopped it; returns the promo when it may be used.
 *
 * Nothing is reserved here: the use is only written when the booking is made
 * (see `recordPromoUse`), so a bill preview never burns someone's one chance.
 */
export async function checkPromo(user, rawCode, { servicesAmount = 0, at = new Date() } = {}) {
  const settings = await getSettings();
  if (settings.promo_enabled === false) throw badRequest('Promo codes are not being accepted right now.', 'PROMO_DISABLED');

  const code = normalisePromo(rawCode);
  if (!code) throw badRequest('Enter a promo code.', 'PROMO_REQUIRED');

  const promo = await PromoCode.findOne({ code }).lean();
  if (!promo || !promo.active) throw badRequest('That promo code does not exist.', 'PROMO_INVALID');
  if (promo.startsAt && at < new Date(promo.startsAt)) throw badRequest('That promo code is not active yet.', 'PROMO_NOT_STARTED');
  if (promo.endsAt && at > new Date(promo.endsAt)) throw badRequest('That promo code has expired.', 'PROMO_EXPIRED');
  if (promo.minBill > 0 && servicesAmount < promo.minBill) {
    throw badRequest(`This code needs a booking of at least ₹${promo.minBill}.`, 'PROMO_MIN_BILL', { minBill: promo.minBill });
  }

  if (promo.eligibility === 'SELECTED' && !(promo.customerIds || []).some((id) => String(id) === String(user._id))) {
    throw badRequest('This promo code is not available on your account.', 'PROMO_NOT_ELIGIBLE');
  }

  // Which booking of theirs this is: the ones that count are the ones that happened.
  const booked = await Task.countDocuments({
    customerId: user._id,
    status: { $nin: [TASK_STATUS.CANCELLED, TASK_STATUS.EXPIRED, TASK_STATUS.NO_HELPER_AVAILABLE] },
  });
  const taskNumber = booked + 1;

  if (promo.eligibility === 'NEW' && booked > 0) {
    throw badRequest('This promo code is for a first booking only.', 'PROMO_NOT_ELIGIBLE');
  }
  if ((promo.taskNumbers || []).length && !promo.taskNumbers.includes(taskNumber)) {
    const which = promo.taskNumbers.map((n) => (n === 1 ? 'first' : n === 2 ? 'second' : `booking ${n}`)).join(' or ');
    throw badRequest(`This promo code can only be used on your ${which} booking.`, 'PROMO_TASK_NUMBER', { taskNumbers: promo.taskNumbers });
  }

  const [usedTotal, usedByMe] = await Promise.all([
    PromoRedemption.countDocuments({ promoId: promo._id, status: 'APPLIED' }),
    PromoRedemption.countDocuments({ promoId: promo._id, userId: user._id, status: 'APPLIED' }),
  ]);
  if (promo.maxUses > 0 && usedTotal >= promo.maxUses) throw conflict('This promo code has been fully used.', 'PROMO_LIMIT_REACHED');
  if (promo.maxUsesPerCustomer > 0 && usedByMe >= promo.maxUsesPerCustomer) {
    throw conflict('You have already used this promo code.', 'PROMO_ALREADY_USED');
  }

  return { promo, taskNumber };
}

/** Writes the use against the booking. Unique on the booking, so it cannot be double-counted. */
export async function recordPromoUse(promo, user, task, amount) {
  if (!promo || !(amount > 0)) return null;
  try {
    return await PromoRedemption.create({
      promoId: promo._id, code: promo.code, userId: user._id, taskId: task._id, amount: round2(amount),
    });
  } catch (err) {
    if (err?.code === 11000) return null; // already recorded for this booking
    throw err;
  }
}

/** A cancelled booking gives the promo back: the use stops counting towards the limits. */
export async function releasePromoUse(taskId) {
  const res = await PromoRedemption.updateOne(
    { taskId, status: 'APPLIED' },
    { $set: { status: 'REVERSED', reversedAt: new Date() } },
  );
  return res.modifiedCount > 0;
}

/** How often a code has been used, for the admin list. */
export async function promoUsage(promoId) {
  const [applied, reversed] = await Promise.all([
    PromoRedemption.countDocuments({ promoId, status: 'APPLIED' }),
    PromoRedemption.countDocuments({ promoId, status: 'REVERSED' }),
  ]);
  return { applied, reversed };
}
