import mongoose from 'mongoose';
import { TASK_STATUS } from '../config.js';

/** A frozen copy of the address at booking time (UC-C03). */
const addressSnapshotSchema = new mongoose.Schema(
  {
    addressId: { type: mongoose.Schema.Types.ObjectId, ref: 'Address' },
    label: String,
    society: String,
    line1: String,
    line2: String,
    landmark: String,
    city: String,
    pincode: String,
    lat: Number,
    lng: Number,
  },
  { _id: false },
);

/** A frozen copy of the service + its answers + the price it carried (UC-C19). */
const taskServiceSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    // Snapshotted with the English name, so a booking reads the same in Hindi
    // even if the catalog's Hindi copy is later changed or removed.
    nameHi: { type: String, default: '' },
    icon: String,
    basePrice: Number,
    options: { type: mongoose.Schema.Types.Mixed, default: {} },
    amount: { type: Number, required: true },
  },
  { _id: false },
);

/**
 * The pricing breakdown is snapshotted too. Changing GST or commission
 * tomorrow must not rewrite what this booking cost (UC-C30, UC-C43).
 */
const pricingSchema = new mongoose.Schema(
  {
    servicesAmount: { type: Number, default: 0 },
    platformFeePercent: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
    surcharge: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    promoCode: { type: String, default: '' },
    taxablePercent: { type: Number, default: 0 },
    gstPercent: { type: Number, default: 0 },
    gst: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    helperCommissionPercent: { type: Number, default: 0 },
    helperCommission: { type: Number, default: 0 },
    helperPayout: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
  },
  { _id: false },
);

const taskSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true }, // human-readable, e.g. GH-4821
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    helperId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    status: {
      type: String,
      enum: Object.values(TASK_STATUS),
      default: TASK_STATUS.CREATED,
      index: true,
    },

    services: { type: [taskServiceSchema], required: true },
    address: { type: addressSnapshotSchema, required: true },

    /**
     * 'instant' means "as soon as a helper accepts" — scheduledAt is stamped
     * with the moment the request was made, not a slot the customer chose, so
     * every screen can say "now" instead of showing a time that reads like an
     * appointment.
     */
    bookingType: { type: String, enum: ['instant', 'scheduled'], default: 'scheduled', index: true },
    scheduledAt: { type: Date, required: true, index: true },
    scheduledDate: String, // 'YYYY-MM-DD', as the customer picked it
    scheduledTime: String, // 'HH:mm'
    durationMins: { type: Number, default: 60 },
    instructions: { type: String, default: '' },

    pricing: { type: pricingSchema, default: () => ({}) },
    paymentStatus: {
      type: String,
      enum: ['PENDING', 'PAID', 'SETTLED', 'REFUNDED'],
      default: 'PENDING',
    },
    paymentMode: { type: String, enum: ['CASH', 'ONLINE'], default: 'CASH' },

    // --- completion handshake (UC-C17) ---
    completionOtp: {
      code: { type: String, select: false },
      expiresAt: Date,
      attempts: { type: Number, default: 0 },
      issuedAt: Date,
    },

    // --- matching bookkeeping ---
    searchStartedAt: Date,
    dispatchRound: { type: Number, default: 0 },
    nextDispatchAt: { type: Date, index: true },

    // --- UC-C49/C50: the same key can only ever create one task ---
    idempotencyKey: { type: String },

    acceptedAt: Date,
    startedAt: Date,
    completionRequestedAt: Date,
    completedAt: Date,
    settledAt: Date,

    cancellation: {
      by: { type: String, enum: ['customer', 'helper', 'admin', 'system'] },
      byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      reason: String,
      previousStatus: String,
      at: Date,
    },

    overdueNotifiedAt: Date,
    ratedByCustomer: { type: Boolean, default: false },
    ratedByHelper: { type: Boolean, default: false },
  },
  { timestamps: true },
);

taskSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
taskSchema.index({ status: 1, nextDispatchAt: 1 });

export const Task = mongoose.model('Task', taskSchema);
