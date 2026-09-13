import { JobRequest, Notification, User } from '../models/index.js';
import { sendDataPush } from './fcm.js';

/**
 * The notifications that also go to the phone as a push.
 *
 * A job request rings a helper. The two moments a customer is waiting on once
 * they have left the booking screen — a helper taking the job, or the search
 * ending without one — arrive as ordinary notifications. Everything else
 * stays in the in-app list.
 */
const PUSHED = new Set(['JOB_REQUEST', 'BOOKING_ACCEPTED', 'NO_HELPER_AVAILABLE']);

async function pushTo(userIds, type, title, body, data) {
  if (!PUSHED.has(type)) return;
  const users = await User.find({ _id: { $in: userIds }, fcmToken: { $ne: null } }).select('fcmToken').lean();
  // One batched call: sending in turn would delay the last phone by every send before it.
  await sendDataPush(users.map((u) => u.fcmToken), { type, title, body, ...data }).catch((err) =>
    console.error('[notify] push failed', err.message),
  );
}

/** Writes an in-app notification, and pushes it to the phone when it matters. */
export async function notify(userId, type, title, body = '', data = {}) {
  if (!userId) return null;
  try {
    const doc = await Notification.create({ userId, type, title, body, data });
    await pushTo([userId], type, title, body, data);
    return doc;
  } catch (err) {
    console.error('[notify] failed', type, err.message);
    return null;
  }
}

/**
 * The same, for many people at once.
 *
 * `store: false` pushes without adding to anyone's list — for reminders, which
 * ring the phone again but should not stack up as duplicates of an entry the
 * helper already has.
 */
export async function notifyMany(userIds, type, title, body = '', data = {}, { store = true } = {}) {
  const ids = userIds.filter(Boolean);
  if (!ids.length) return [];
  try {
    const result = store
      ? await Notification.insertMany(ids.map((userId) => ({ userId, type, title, body, data })), { ordered: false })
      : [];
    await pushTo(ids, type, title, body, data);
    return result;
  } catch (err) {
    console.error('[notify] bulk failed', type, err.message);
    return [];
  }
}

/**
 * Stop a job ringing on every phone it was sent to.
 *
 * The alert loops until answered, so "the job is gone" has to reach the phone
 * as well as the database — otherwise a helper's phone keeps ringing for a job
 * someone else has already taken, and Accept only tells them so after the fact.
 * It is a silent data push: the app cancels the notification and shows nothing.
 *
 * @param taskId the job
 * @param except a helper whose phone should be left alone (the one who won it)
 */
export async function closeJobAlerts(taskId, { except } = {}) {
  try {
    const alerted = await JobRequest.find({ taskId }).distinct('helperId');
    const ids = alerted.filter((id) => !except || String(id) !== String(except));
    if (!ids.length) return 0;

    const users = await User.find({ _id: { $in: ids }, fcmToken: { $ne: null } }).select('fcmToken').lean();
    return await sendDataPush(users.map((u) => u.fcmToken), { type: 'JOB_CLOSED', taskId: String(taskId) });
  } catch (err) {
    console.error('[notify] closing job alerts failed', err.message);
    return 0;
  }
}
