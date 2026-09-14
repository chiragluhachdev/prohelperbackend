import mongoose from 'mongoose';

/**
 * Referral money, kept apart from the wallet ledger on purpose: it is not cash
 * and cannot be withdrawn. A customer spends it on bookings; a helper spends it
 * on what they owe the platform. The balance is the sum of the rows, and `ref`
 * is unique so no reward or redemption can ever be written twice.
 */
const referralEntrySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: [
        'REFERRER_REWARD', // someone joined with this user's code
        'WELCOME_REWARD', // this user joined with someone's code
        'BOOKING_REDEMPTION', // customer: spent on a booking
        'BOOKING_REFUND', // customer: that booking was cancelled, so it comes back
        'DUES_SETTLEMENT', // helper: spent on what they owe the platform
        'PARTNER_REDEMPTION', // partner: requested a payout
      ],
      required: true,
    },
    /** Signed: + earned or returned, − spent. */
    amount: { type: Number, required: true },
    /** For rewards: the other person in the referral. */
    counterpartyId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task' },
    ref: { type: String, required: true, unique: true },
    note: { type: String, default: '' },
  },
  { timestamps: true },
);

referralEntrySchema.index({ userId: 1, createdAt: -1 });

export const ReferralEntry = mongoose.model('ReferralEntry', referralEntrySchema);
