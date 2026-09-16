import mongoose from 'mongoose';

/** Append-only status history — "who did what, when, and why" (spec §61). */
const taskEventSchema = new mongoose.Schema(
  {
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
    /**
     * 'STATUS': the booking moved. 'MATCHING': a step in finding a helper —
     * search started, helpers alerted, reminded, declined, search closed. The
     * matching steps are the admin's history of how a booking was dispatched.
     */
    kind: { type: String, enum: ['STATUS', 'MATCHING'], default: 'STATUS', index: true },
    from: String,
    to: String,
    actorType: { type: String, enum: ['customer', 'helper', 'admin', 'system'], default: 'system' },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reason: String,
    meta: { type: mongoose.Schema.Types.Mixed },
    at: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

export const TaskEvent = mongoose.model('TaskEvent', taskEventSchema);
