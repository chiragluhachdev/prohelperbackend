import mongoose from 'mongoose';

/** Admin-tunable business rules. Seeded from DEFAULT_SETTINGS, then owned here. */
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const Setting = mongoose.model('Setting', settingSchema);
