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
    pinned: Boolean,
    formatted: String,
  },
  { _id: false },
);

/** One answered question, as the customer saw it — kept readable even if the question later changes. */
const taskAnswerSchema = new mongoose.Schema(
  {
    key: String,
    label: String,
    labelHi: String,
    type: String,
    value: mongoose.Schema.Types.Mixed,
    display: String,
    displayHi: String,
    amount: { type: Number, default: 0 },
    minutes: { type: Number, default: 0 },
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
    /** What this service cost here, and what the catalog asks for it. */
    basePrice: Number,
    listPrice: Number,
    /** fixed — set for this locality; fallback — the locality's rule; catalog — no locality price. */
    priceSource: String,
    /** key → value, for code that needs the raw answer. */
    options: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** The same answers with their question text and what each added — what people read (UC-C05). */
    answers: { type: [taskAnswerSchema], default: [] },
    /** What the answers added to the base price. */
    optionsAmount: { type: Number, default: 0 },
    amount: { type: Number, required: true },
    /** How long this service is expected to take, answers included. */
    minutes: { type: Number, default: 0 },
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
    /** Locality pricing (UC-C43): the same booking at catalog prices, what the locality's prices added,
        and which price list — at which version — set them. */
    listServicesAmount: { type: Number, default: 0 },
    localityUplift: { type: Number, default: 0 },
    localityCode: { type: String, default: '' },
    localityName: { type: String, default: '' },
    priceVersion: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    discountPercent: { type: Number, default: 0 },
    discountLabel: { type: String, default: '' },
    platformFeePercent: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
    platformFeeLabel: { type: String, default: '' },
    surcharge: { type: Number, default: 0 },
    surchargeLabel: { type: String, default: '' },
    gst: { type: Number, default: 0 },
    gstPercent: { type: Number, default: 0 },
    /** 'all' — on the whole bill; 'fees' — on platform fee + surcharge only. */
    gstBase: { type: String, default: 'all' },
    gstLabel: { type: String, default: '' },
    taxableAmount: { type: Number, default: 0 },
    /** Paid from the customer's referral balance — the platform covers it, the helper is never short. */
    referralCredit: { type: Number, default: 0 },
    /** UC-C32 — the code used, what it took off, and how it read on the bill. */
    promoCode: { type: String, default: '' },
    promoDiscount: { type: Number, default: 0 },
    promoLabel: { type: String, default: '' },
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
    /** How the job was actually paid for — set only once payment is confirmed. */
    paymentMode: { type: String, enum: ['CASH', 'ONLINE'], default: null },
    paidAt: Date,
    /** Who confirmed the payment: the customer (paid in the app) or the helper (received cash/UPI). */
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    paidByRole: { type: String, enum: ['customer', 'helper'] },

    // --- start handshake: the customer's code proves the helper is at the door ---
    startOtp: {
      code: { type: String, select: false },
      attempts: { type: Number, default: 0 },
      issuedAt: Date,
    },

    // --- completion handshake (UC-C17) ---
    completionOtp: {
      code: { type: String, select: false },
      expiresAt: Date,
      attempts: { type: Number, default: 0 },
      issuedAt: Date,
      /** OTPs sent for this job in all — capped, so re-sending can't reset the attempt limit forever. */
      sends: { type: Number, default: 0 },
    },

    // --- matching bookkeeping ---
    searchStartedAt: Date,
    /** When the current search gives up. Set at the start of each search, so a
        settings change mid-search does not move a customer's deadline. */
    searchExpiresAt: Date,
    /** 'instant': short window with reminders. 'scheduled': spread-out waves, no countdown. */
    searchMode: { type: String, enum: ['instant', 'scheduled'], default: 'instant' },
    /** Scheduled searches only: how many waves were planned, and how many have gone out. */
    searchWaves: { type: Number, default: 0 },
    wavesSent: { type: Number, default: 0 },
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
      /** What the cancellation did to money: referral balance given back, anything charged. */
      financialImpact: {
        referralRefunded: { type: Number, default: 0 },
        charged: { type: Number, default: 0 },
        note: { type: String, default: '' },
      },
    },

    /**
     * Helpers who took this booking and then dropped it (UC-C22). The booking
     * itself goes on — back to searching — so this is where that is kept.
     */
    helperCancellations: [
      {
        _id: false,
        helperId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        helperName: String,
        by: { type: String, enum: ['helper', 'admin', 'system'] },
        reason: String,
        previousStatus: String,
        at: Date,
      },
    ],

    /** Who did the job, as they were when they took it — kept even if the account changes later (UC-C19). */
    helperSnapshot: {
      name: String,
      phone: String,
    },

    /** UC-C18: first flagged overdue, reminders sent, and the latest one. */
    overdueNotifiedAt: Date,
    overdueReminders: { type: Number, default: 0 },
    overdueLastRemindedAt: Date,
    ratedByCustomer: { type: Boolean, default: false },
    ratedByHelper: { type: Boolean, default: false },
  },
  { timestamps: true },
);

taskSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
taskSchema.index({ status: 1, nextDispatchAt: 1 });

export const Task = mongoose.model('Task', taskSchema);
