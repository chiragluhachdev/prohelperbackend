import crypto from 'node:crypto';
import { Task } from '../models/index.js';
import { TASK_STATUS } from '../config.js';

/** Four digits: quick to read out at the door, and the attempt limit makes guessing useless. */
export const START_CODE_LENGTH = 4;

export const newStartCode = () =>
  String(crypto.randomInt(0, 10 ** START_CODE_LENGTH)).padStart(START_CODE_LENGTH, '0');

/** A fresh start code, as $set fields — also resets the wrong-attempt count. */
export const startCodeFields = () => ({
  'startOtp.code': newStartCode(),
  'startOtp.attempts': 0,
  'startOtp.issuedAt': new Date(),
});

/**
 * The start code of an assigned booking, creating one if it has none — for
 * bookings accepted before start codes existed. Only fills a missing code, so
 * two callers at once agree on the same one.
 */
export async function ensureStartCode(taskId) {
  const filled = await Task.findOneAndUpdate(
    { _id: taskId, status: TASK_STATUS.ACCEPTED, $or: [{ 'startOtp.code': { $exists: false } }, { 'startOtp.code': null }] },
    { $set: startCodeFields() },
    { new: true },
  ).select('+startOtp.code');
  if (filled) return filled.startOtp.code;
  const current = await Task.findById(taskId).select('+startOtp.code').lean();
  return current?.startOtp?.code ?? null;
}
