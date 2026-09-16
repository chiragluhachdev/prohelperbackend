import mongoose from 'mongoose';

/**
 * UC-C05 — the per-service questions are data, not hard-coded screens.
 * The rules for reading and pricing them live in lib/serviceOptions.js.
 */
const serviceOptionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    labelHi: { type: String, default: '' },
    help: { type: String, default: '' },
    helpHi: { type: String, default: '' },
    placeholder: { type: String, default: '' },
    placeholderHi: { type: String, default: '' },
    type: {
      type: String,
      enum: ['select', 'multiselect', 'number', 'boolean', 'text', 'textarea', 'time', 'date'],
      default: 'text',
    },
    // Choice lists: parallel arrays, lined up by position.
    choices: [{ type: String }],
    choicesHi: [{ type: String }],
    choicePrices: [{ type: Number }],
    choiceMinutes: [{ type: Number }],
    unit: { type: String, default: '' },
    unitHi: { type: String, default: '' },
    min: { type: Number, default: null },
    max: { type: Number, default: null },
    step: { type: Number, default: 1 },
    required: { type: Boolean, default: false },
    defaultValue: { type: mongoose.Schema.Types.Mixed },
    /** number: × value · boolean: when yes · multiselect: × how many picked */
    pricePerUnit: { type: Number, default: 0 },
    /** The same, for how long the job takes. */
    minutesPerUnit: { type: Number, default: 0 },
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
    /** The "what's included" checklist the app shows. Data, not app copy. */
    inclusions: { type: [String], default: [] },

    /*
     * Hindi copy. Optional: an empty field falls back to the English one, so a
     * service added in a hurry still shows *something* to a Hindi reader.
     */
    nameHi: { type: String, default: '' },
    descriptionHi: { type: String, default: '' },
    durationLabelHi: { type: String, default: '' },
    inclusionsHi: { type: [String], default: [] },
    defaultDurationMins: { type: Number, default: 60 },
    options: [serviceOptionSchema],
    /**
     * Off unless an admin turns it on. A service with questions nobody has
     * reviewed should not start interrogating customers at checkout, and a
     * priced option left on by accident would quietly change the bill.
     */
    optionsEnabled: { type: Boolean, default: false },
    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const Service = mongoose.model('Service', serviceSchema);
