import { Notification } from '../models/index.js';

/**
 * Writes an in-app notification. A real push provider (FCM) would be called
 * here too — and per UC-C48 a push failure must never change business state,
 * which is why this never throws into the caller.
 */
export async function notify(userId, type, title, body = '', data = {}) {
  if (!userId) return null;
  try {
    return await Notification.create({ userId, type, title, body, data });
  } catch (err) {
    console.error('[notify] failed', type, err.message);
    return null;
  }
}

export async function notifyMany(userIds, type, title, body = '', data = {}) {
  const docs = userIds.filter(Boolean).map((userId) => ({ userId, type, title, body, data }));
  if (!docs.length) return [];
  try {
    return await Notification.insertMany(docs, { ordered: false });
  } catch (err) {
    console.error('[notify] bulk failed', type, err.message);
    return [];
  }
}
