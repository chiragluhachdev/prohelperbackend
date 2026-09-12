import { JobRequest, Notification, User } from '../models/index.js';
import { sendDataPush } from './fcm.js';

/**
 * Writes an in-app notification. Also pushes high-priority FCM messages
 * to helpers for new job requests.
 */
export async function notify(userId, type, title, body = '', data = {}) {
  if (!userId) return null;
  try {
    const doc = await Notification.create({ userId, type, title, body, data });
    
    // Only job requests ring the phone.
    if (type === 'JOB_REQUEST') {
      const user = await User.findById(userId).select('fcmToken').lean();
      if (user?.fcmToken) {
        await sendDataPush(user.fcmToken, { type, title, body, ...data }).catch((err) =>
          console.error('[notify] push failed', err.message),
        );
      }
    }
    
    return doc;
  } catch (err) {
    console.error('[notify] failed', type, err.message);
    return null;
  }
}

export async function notifyMany(userIds, type, title, body = '', data = {}) {
  const docs = userIds.filter(Boolean).map((userId) => ({ userId, type, title, body, data }));
  if (!docs.length) return [];
  try {
    const result = await Notification.insertMany(docs, { ordered: false });
    
    if (type === 'JOB_REQUEST') {
      const users = await User.find({ _id: { $in: userIds }, fcmToken: { $ne: null } })
        .select('fcmToken')
        .lean();
      /* One batched call for the whole wave. Awaiting each helper in turn
         delayed the last helper's alert by every send before it — eating into
         their 60-second window before their phone had even rung. */
      await sendDataPush(users.map((u) => u.fcmToken), { type, title, body, ...data }).catch((err) =>
        console.error('[notify] push failed', err.message),
      );
    }
    
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
