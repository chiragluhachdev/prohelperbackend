import mongoose from 'mongoose';

/** UC-C05 — the per-service questions are data, not hard-coded screens. */
const serviceOptionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    type: { type: String, enum: ['number', 'text', 'select', 'boolean'], default: 'text' },
    choices: [{ type: String }],
    unit: { type: String, default: '' },
    required: { type: Boolean, default: false },
    defaultValue: { type: mongoose.Schema.Types.Mixed },
    // adds `pricePerUnit * value` to the line item when set
    pricePerUnit: { type: Number, default: 0 },
  },
  { _id: false },
);

const serviceSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    category: { type: String, default: 'Household' },
    description: { type: String, default: '' },
    icon: { type: String, default: '🧹' },
    basePrice: { type: Number, required: true },
    durationLabel: { type: String, default: '1 - 2 hours' },
    defaultDurationMins: { type: Number, default: 60 },
    options: [serviceOptionSchema],
    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const Service = mongoose.model('Service', serviceSchema);
