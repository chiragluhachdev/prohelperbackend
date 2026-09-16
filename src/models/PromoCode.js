import mongoose from 'mongoose';

/**
 * UC-C32 — a discount the platform funds. Every rule an admin can set lives
 * here; nothing about a promo is written into the apps.
 */
const promoCodeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, default: '' },
    /** FLAT: ₹ off. PERCENT: a share of the services amount, capped by maxDiscount. */
    type: { type: String, enum: ['FLAT', 'PERCENT'], default: 'FLAT' },
    value: { type: Number, required: true, min: 0 },
    maxDiscount: { type: Number, default: 0 },
    minBill: { type: Number, default: 0 },
    startsAt: { type: Date },
    endsAt: { type: Date },
    /** 0 = as many as people want. */
    maxUses: { type: Number, default: 0 },
    maxUsesPerCustomer: { type: Number, default: 1 },
    /** ALL customers, only those who have never booked, or a chosen few. */
    eligibility: { type: String, enum: ['ALL', 'NEW', 'SELECTED'], default: 'ALL' },
    customerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    /**
     * Which booking of the customer's it may be used on: [1] first only,
     * [2] second only, [1, 2] either. Empty means any booking.
     */
    taskNumbers: [{ type: Number }],
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const PromoCode = mongoose.model('PromoCode', promoCodeSchema);

/** Every use of a promo, kept — including ones a cancelled booking gave back. */
const promoRedemptionSchema = new mongoose.Schema(
  {
    promoId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromoCode', required: true, index: true },
    code: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true },
    amount: { type: Number, required: true },
    /** REVERSED once the booking it was used on is cancelled — it stops counting against the limits. */
    status: { type: String, enum: ['APPLIED', 'REVERSED'], default: 'APPLIED', index: true },
    reversedAt: { type: Date },
  },
  { timestamps: true },
);

// One redemption per booking, so a retried request cannot spend a promo twice.
promoRedemptionSchema.index({ taskId: 1 }, { unique: true });

export const PromoRedemption = mongoose.model('PromoRedemption', promoRedemptionSchema);
