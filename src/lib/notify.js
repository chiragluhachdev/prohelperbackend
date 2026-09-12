import { Notification, User } from '../models/index.js';
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
