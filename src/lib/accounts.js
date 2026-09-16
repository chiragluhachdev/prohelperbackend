import { HelperProfile, JobRequest, Rejection, Task, User } from '../models/index.js';
import { ROLES, TASK_STATUS } from '../config.js';
import { getSettings } from './settings.js';
import { closeJobAlerts, notify, notifyMany } from './notify.js';
import { cancelBooking } from './cancellation.js';
import { releaseHelperJob } from '../matching.js';

/** Tells every active admin — auto-blocks and overdue jobs are theirs to look at. */
export async function notifyAdmins(type, title, body, data = {}) {
  const admins = await User.find({ role: ROLES.ADMIN, status: 'active' }).select('_id').lean();
  return notifyMany(admins.map((a) => a._id), type, title, body, data);
}

const KIND_LABEL = {
  JOB_DECLINED: 'declined requests',
  HELPER_CANCELLED: 'dropped jobs',
  CUSTOMER_CANCELLED: 'cancellations after a helper was assigned',
};

/**
 * UC-C23 — records one rejection and blocks the account once it reaches the
 * admin's threshold.
 *
 * Helpers: every declined request and every accepted job they drop.
 * Customers: every booking they cancel after a helper was assigned — before
 * that nobody has been let down.
 *
 * The count lives on the user (an admin unblock resets it); each rejection is
 * also kept as its own row, so the record of what led to a block survives.
 * A threshold of 0 still records, but never blocks.
 */
export async function recordRejection(userId, { kind, task = null, reason = '' }) {
  const user = await User.findOneAndUpdate(
    { _id: userId, status: 'active', role: { $in: [ROLES.HELPER, ROLES.CUSTOMER] } },
    { $inc: { rejectionCount: 1 } },
    { new: true },
  );
  if (!user) return null;

  const settings = await getSettings();
  const threshold = Math.max(0, Number(
    user.role === ROLES.HELPER ? settings.rejection_block_threshold : settings.customer_rejection_block_threshold,
  ) || 0);
  const blocking = threshold > 0 && user.rejectionCount >= threshold;

  const row = await Rejection.create({
    userId: user._id, role: user.role, kind,
    taskId: task?._id, taskCode: task?.code, reason,
    count: user.rejectionCount, threshold, blocked: blocking,
  });

  if (blocking) {
    const what = user.role === ROLES.HELPER ? 'declined or dropped jobs' : KIND_LABEL[kind];
    await blockAccount(user._id, {
      by: 'system',
      reason: `Automatically blocked after ${user.rejectionCount} ${what}. Contact support to restore your account.`,
      rejectionCount: user.rejectionCount,
    });
  }
  return row;
}

/**
 * Blocks an account and stops everything it was doing (UC-C23). Used by the
 * automatic rule and by admins alike. Only an admin can undo it.
 *
 *  helper    offline now; open alerts withdrawn; jobs accepted but not
 *            started go back to searching, so no customer is left waiting on
 *            someone who can no longer come.
 *  customer  bookings not yet under way are cancelled by the system, and any
 *            helper already assigned is told.
 *
 * Jobs already in progress are left alone for an admin to handle.
 *
 * @returns the blocked user, or null if they were already blocked
 */
export async function blockAccount(userId, { by = 'system', actorId, reason, rejectionCount }) {
  const user = await User.findOneAndUpdate(
    { _id: userId, status: 'active', role: { $ne: ROLES.ADMIN } },
    { $set: { status: 'blocked', blockReason: reason, blockedAt: new Date() } },
    { new: true },
  );
  if (!user) return null;

  if (user.role === ROLES.HELPER) {
    await HelperProfile.updateOne({ userId: user._id }, { $set: { isOnline: false, dnd: false } });
    const ringing = await JobRequest.find({ helperId: user._id, status: 'SENT' }).distinct('taskId');
    await JobRequest.updateMany({ helperId: user._id, status: 'SENT' }, { $set: { status: 'CANCELLED' } });
    for (const taskId of ringing) await closeJobAlerts(taskId);

    const accepted = await Task.find({ helperId: user._id, status: TASK_STATUS.ACCEPTED }).select('_id').lean();
    for (const t of accepted) {
      await releaseHelperJob(t._id, {
        by: 'system', reason: 'Helper account blocked', action: 'research', countRejection: false,
      }).catch((err) => console.error('[block] releasing job failed', String(t._id), err.message));
    }
  } else if (user.role === ROLES.CUSTOMER) {
    const open = await Task.find({
      customerId: user._id,
      status: { $in: [TASK_STATUS.CREATED, TASK_STATUS.SEARCHING, TASK_STATUS.NO_HELPER_AVAILABLE, TASK_STATUS.ACCEPTED] },
    }).select('_id').lean();
    for (const t of open) {
      try {
        const { task, previousStatus } = await cancelBooking(t._id, {
          by: 'system', reason: 'Customer account blocked',
          from: [TASK_STATUS.CREATED, TASK_STATUS.SEARCHING, TASK_STATUS.NO_HELPER_AVAILABLE, TASK_STATUS.ACCEPTED],
        });
        if (task.helperId && previousStatus === TASK_STATUS.ACCEPTED) {
          await notify(task.helperId, 'BOOKING_CANCELLED', 'Booking cancelled',
            `${task.code} was cancelled by Pro Helper.`, { taskId: String(task._id), code: task.code, by: 'system', reason: 'Customer account blocked' });
        }
      } catch (err) {
        console.error('[block] cancelling booking failed', String(t._id), err.message);
      }
    }
  }

  await notify(user._id, 'ACCOUNT_BLOCKED', 'Account blocked', reason, { reason });

  if (by === 'system') {
    const who = user.name || user.phone;
    await notifyAdmins(
      'ACCOUNT_AUTO_BLOCKED',
      `${user.role === ROLES.HELPER ? 'Helper' : 'Customer'} auto-blocked`,
      `${who} was blocked after ${rejectionCount ?? user.rejectionCount} rejections.`,
      { userId: String(user._id), role: user.role, count: String(rejectionCount ?? user.rejectionCount) },
    );
  }
  console.log(`[block] ${user.role} ${user.name || user.phone} blocked by ${by}`);
  return user;
}
