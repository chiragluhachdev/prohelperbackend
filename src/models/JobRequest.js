import mongoose from 'mongoose';

/**
 * One row per (task, helper, round) — the audit trail the spec asks for in
 * UC-C09: who was alerted, when, when it expires and what they did.
 */
const jobRequestSchema = new mongoose.Schema(
  {
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
    helperId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    round: { type: Number, default: 1 },
    status: {
      type: String,
      enum: ['SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED'],
      default: 'SENT',
      index: true,
    },
    distanceKm: { type: Number, default: 0 },
    matchedAllServices: { type: Boolean, default: true },
    sentAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: true },
    respondedAt: Date,
    notificationStatus: { type: String, default: 'QUEUED' },
  },
  { timestamps: true },
);

jobRequestSchema.index({ taskId: 1, helperId: 1, round: 1 }, { unique: true });
jobRequestSchema.index({ helperId: 1, status: 1, expiresAt: 1 });

export const JobRequest = mongoose.model('JobRequest', jobRequestSchema);
