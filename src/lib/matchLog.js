import { TaskEvent, User } from '../models/index.js';

/**
 * The history of how a booking looked for its helper (UC-C09): one row per
 * step, from the moment a search starts — who was alerted, who was reminded,
 * who declined, who accepted, and how the search ended. Kept alongside the
 * status history but marked as matching, so the admin sees it and the apps
 * (which only need status) do not.
 *
 * A failure here is logged and swallowed: history must never stop a booking.
 */
export async function logMatching(taskId, reason, meta = {}) {
  try {
    return await TaskEvent.create({ taskId, kind: 'MATCHING', actorType: 'system', reason, meta });
  } catch (err) {
    console.error('[match-log]', err.message);
    return null;
  }
}

/** Helper names for a log line, in the order given. */
export async function helperNames(ids) {
  if (!ids?.length) return [];
  const users = await User.find({ _id: { $in: ids } }).select('name phone').lean();
  const byId = new Map(users.map((u) => [String(u._id), u.name || u.phone || 'Helper']));
  return ids.map((id) => ({ id: String(id), name: byId.get(String(id)) || 'Helper' }));
}
