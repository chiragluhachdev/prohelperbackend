import { AuditLog } from '../models/index.js';

/** Records an admin action. Never allowed to break the request it describes. */
export async function audit(req, { action, entity, entityId, before, after, reason = '' }) {
  try {
    await AuditLog.create({
      adminId: req.user?._id,
      action,
      entity,
      entityId: entityId ? String(entityId) : undefined,
      before,
      after,
      reason,
      ip: req.ip || '',
    });
  } catch (err) {
    console.error('[audit] failed to write entry', err.message);
  }
}
