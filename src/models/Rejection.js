import mongoose from 'mongoose';

/**
 * UC-C23 — every rejection, kept. The count on the user decides blocking; these
 * rows are the record behind it, so an admin can see exactly what led there.
 *
 *  JOB_DECLINED        a helper declined a job request
 *  HELPER_CANCELLED    a helper dropped a job they had accepted
 *  CUSTOMER_CANCELLED  a customer cancelled after a helper was assigned
 */
const rejectionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ['customer', 'helper'], required: true },
    kind: { type: String, enum: ['JOB_DECLINED', 'HELPER_CANCELLED', 'CUSTOMER_CANCELLED'], required: true },
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task' },
    taskCode: String,
    reason: { type: String, default: '' },
    /** The user's count once this was added, the threshold in force then, and whether this one blocked them. */
    count: Number,
    threshold: Number,
    blocked: { type: Boolean, default: false },
  },
  { timestamps: true },
);

rejectionSchema.index({ userId: 1, createdAt: -1 });

export const Rejection = mongoose.model('Rejection', rejectionSchema);
