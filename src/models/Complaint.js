import mongoose from 'mongoose';

/**
 * UC-C39/C40 — something a customer or a helper says went wrong. Raised from
 * the apps, reviewed by an admin, and kept afterwards: a complaint is part of
 * an account's history, so it is never deleted, only closed.
 */
const complaintSchema = new mongoose.Schema(
  {
    /** Short, readable, and quotable in support: CMP-4F2K91. */
    code: { type: String, required: true, unique: true },
    byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    byRole: { type: String, enum: ['customer', 'helper', 'partner'], required: true },
    /** The other side, when the complaint is about a person rather than the service. */
    againstUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', index: true },
    taskCode: { type: String, default: '' },
    category: {
      type: String,
      enum: ['SERVICE_QUALITY', 'BEHAVIOUR', 'PAYMENT', 'DAMAGE', 'SAFETY', 'APP', 'OTHER'],
      default: 'OTHER',
      index: true,
    },
    message: { type: String, required: true },
    status: { type: String, enum: ['OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED'], default: 'OPEN', index: true },
    /** What the admin did about it — sent to the person who raised it. */
    resolution: { type: String, default: '' },
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    handledAt: { type: Date },
    /** The admin it belongs to. Unassigned complaints are everyone's problem, which is why this matters. */
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    assignedAt: { type: Date },
    /** Raised above the queue — for anything that cannot wait its turn. */
    escalated: { type: Boolean, default: false, index: true },
    escalatedAt: { type: Date },
    escalationReason: { type: String, default: '' },
    /**
     * The working notes behind the decision: what was tried, who was called,
     * what they said. Kept with the complaint, never shown to the reporter.
     */
    notes: [
      {
        _id: false,
        byId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        byName: String,
        kind: { type: String, enum: ['NOTE', 'CONTACT', 'STATUS', 'ASSIGN', 'ESCALATE'], default: 'NOTE' },
        text: String,
        at: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

complaintSchema.index({ status: 1, createdAt: -1 });

export const Complaint = mongoose.model('Complaint', complaintSchema);
