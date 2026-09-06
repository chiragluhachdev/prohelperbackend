import { Task, TaskEvent } from '../models/index.js';
import { ALLOWED_TRANSITIONS } from '../config.js';
import { conflict } from './http.js';

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
