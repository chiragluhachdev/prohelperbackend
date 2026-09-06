import mongoose from 'mongoose';

/** Append-only status history — "who did what, when, and why" (spec §61). */
const taskEventSchema = new mongoose.Schema(
  {
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
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
