import { Task, TaskEvent } from '../models/index.js';
import { ALLOWED_TRANSITIONS } from '../config.js';
import { conflict } from './http.js';
import { refundBookingCredit, triggerFirstBookingRewards } from './referral.js';
import { releasePromoUse } from './promo.js';
import { getSettings } from './settings.js';

/**
 * The single door through which a task changes status.
 *
 * The status guard lives in the Mongo query itself, so two racing requests
 * cannot both succeed — the second one matches nothing and gets `null` back.
 * That is what makes double-taps and simultaneous accepts safe (UC-C50/C51).
 *
 * @param {string} taskId
 * @param {string[]} from   statuses the task is allowed to be in right now
 * @param {string} to       target status
 * @returns the updated task, or null if the task was not in an expected state
 */
export async function transition(taskId, from, to, options = {}) {
  const { set = {}, unset, actorType = 'system', actorId, reason = '', meta, extraFilter = {} } = options;

  for (const status of from) {
    if (!ALLOWED_TRANSITIONS[status]?.includes(to)) {
      throw new Error(`Illegal transition ${status} -> ${to}`);
    }
  }

  const update = { $set: { status: to, ...set } };
  if (unset) update.$unset = unset;
  // A cancelled booking's codes stop working with it — they can never start or close it (UC-C17).
  if (to === 'CANCELLED' || to === 'EXPIRED') {
    update.$unset = { ...(update.$unset || {}), 'startOtp.code': '', 'completionOtp.code': '' };
  }

  const before = await Task.findOne({ _id: taskId }).select('status').lean();
  const task = await Task.findOneAndUpdate(
    { _id: taskId, status: { $in: from }, ...extraFilter },
    update,
    { new: true },
  );
  if (!task) return null;

  await TaskEvent.create({
    taskId: task._id,
    from: before?.status,
    to,
    actorType,
    actorId,
    reason,
    meta,
  });

  if (to === 'CANCELLED' && ['SEARCHING', 'NO_HELPER_AVAILABLE'].includes(before?.status)) {
    await TaskEvent.create({
      taskId: task._id, kind: 'MATCHING', actorType, actorId,
      reason: before.status === 'SEARCHING' ? 'Search stopped — booking cancelled' : 'Booking cancelled after no helper was found',
      meta: { step: 'SEARCH_STOPPED' },
    }).catch(() => {});
  }

  // Referral balance spent on a booking comes back if the booking never happens,
  // and the cancellation records what it did to money (UC-C22).
  if (to === 'CANCELLED' || to === 'EXPIRED') {
    const refund = await refundBookingCredit(task).catch((err) => {
      console.error('[referral] refund failed', task.code, err.message);
      return null;
    });
    const referralRefunded = refund ? Math.round((task.pricing?.referralCredit || 0) * 100) / 100 : 0;
    const financialImpact = {
      referralRefunded,
      charged: 0,
      note: [
        'Nothing charged — payment is only taken once a job is completed.',
        referralRefunded > 0 ? `₹${referralRefunded} of referral balance returned to the customer.` : '',
      ].filter(Boolean).join(' '),
    };
    await Task.updateOne({ _id: task._id }, { $set: { 'cancellation.financialImpact': financialImpact } });
    task.set('cancellation.financialImpact', financialImpact);
    // A promo used on a booking that never happened is given back (UC-C32).
    await releasePromoUse(task._id).catch((err) => console.error('[promo] release failed', task.code, err.message));
  }
  
  /*
   * UC-C33 — the referral reward is earned by a real job, never by installing
   * the app. Which job counts is the admin's rule: the first one completed, or
   * the first one actually paid for (settled).
   */
  if (to === 'COMPLETED' || to === 'SETTLED') {
    const settings = await getSettings();
    const qualifying = settings.referral_qualify_event === 'SETTLED' ? 'SETTLED' : 'COMPLETED';
    if (to === qualifying) {
      // Both the customer and the helper may be finishing their own first booking.
      Promise.all([
        triggerFirstBookingRewards(task.customerId, task),
        task.helperId ? triggerFirstBookingRewards(task.helperId, task) : Promise.resolve(),
      ]).catch((err) => console.error('[referral] first booking rewards failed', task.code, err.message));
    }
  }
  return task;
}

/** Same as `transition`, but raises a 409 instead of returning null. */
export async function mustTransition(taskId, from, to, options = {}) {
  const task = await transition(taskId, from, to, options);
  if (!task) {
    const current = await Task.findById(taskId).select('status').lean();
    throw conflict(
      `This booking is ${current ? current.status.toLowerCase().replace(/_/g, ' ') : 'no longer available'}.`,
      'INVALID_STATE',
    );
  }
  return task;
}

/** Short, human-friendly booking reference — GH-4F2K91. */
export function newTaskCode() {
  const alphabet = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 6; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `GH-${out}`;
}
