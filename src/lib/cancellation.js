import { JobRequest, Task } from '../models/index.js';
import { TASK_STATUS } from '../config.js';
import { conflict, notFound } from './http.js';
import { closeJobAlerts } from './notify.js';
import { mustTransition } from './taskflow.js';

/**
 * The statuses a customer may still cancel in, from the admin's
 * `customer_cancel_until` rule (UC-C22). Before a helper is on the way it is
 * always allowed; how far past that is the business's call.
 */
export function customerCancellable(settings) {
  const base = [TASK_STATUS.CREATED, TASK_STATUS.SEARCHING, TASK_STATUS.NO_HELPER_AVAILABLE];
  const until = settings.customer_cancel_until || 'IN_PROGRESS';
  if (until === 'SEARCHING') return base;
  if (until === 'ACCEPTED') return [...base, TASK_STATUS.ACCEPTED];
  return [...base, TASK_STATUS.ACCEPTED, TASK_STATUS.IN_PROGRESS];
}

/** Everything an admin can still call off: any booking that is not finished. */
export const ADMIN_CANCELLABLE = [
  TASK_STATUS.CREATED,
  TASK_STATUS.SEARCHING,
  TASK_STATUS.NO_HELPER_AVAILABLE,
  TASK_STATUS.ACCEPTED,
  TASK_STATUS.IN_PROGRESS,
  TASK_STATUS.COMPLETION_PENDING,
];

/**
 * Cancels a booking, whoever asked (UC-C22). One place, so every cancellation
 * records the same things: who, when, why, and the status it was in — the
 * money side (referral balance returned) is added by the state machine.
 * Any helper still being alerted is stood down.
 *
 * Notifications are left to the caller: each side is told in its own words.
 *
 * @returns {{ task, previousStatus }}
 */
export async function cancelBooking(taskId, { by, actorId, reason, from, filter = {} }) {
  const task = await Task.findOne({ _id: taskId, ...filter });
  if (!task) throw notFound('Booking not found.');
  if (!from.includes(task.status)) {
    throw conflict('This booking can no longer be cancelled.', 'NOT_CANCELLABLE');
  }

  const updated = await mustTransition(task._id, from, TASK_STATUS.CANCELLED, {
    set: {
      nextDispatchAt: null,
      cancellation: { by, byUserId: actorId, reason, previousStatus: task.status, at: new Date() },
    },
    actorType: by,
    actorId,
    reason,
    meta: { cancelledBy: by },
  });

  await JobRequest.updateMany({ taskId: task._id, status: 'SENT' }, { $set: { status: 'CANCELLED' } });
  await closeJobAlerts(task._id);
  return { task: updated, previousStatus: task.status };
}
