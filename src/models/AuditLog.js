import mongoose from 'mongoose';

/** UC-C46 — every consequential admin action leaves a trace. */
const auditLogSchema = new mongoose.Schema(
  {
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: String },
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed },
    reason: { type: String, default: '' },
    ip: { type: String, default: '' },
  },
  { timestamps: true, versionKey: false },
);

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
