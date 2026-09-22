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
        // Referral points: someone joined with this user's code. A referral partner is paid as a helper.
        'HELPER_REFERRAL_REWARD',
        'CUSTOMER_REFERRAL_REWARD',
        // Joining bonus: this user joined with someone else's code.
        'HELPER_JOINING_BONUS',
        'CUSTOMER_JOINING_BONUS',
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
    /** The id this transaction is known by outside the database (UC-C35). */
    txnId: { type: String, unique: true, sparse: true },
    /** REVERSED is a reward taken back; everything else takes effect at once. */
    status: { type: String, enum: ['SETTLED', 'REVERSED'], default: 'SETTLED' },
    note: { type: String, default: '' },
  },
  { timestamps: true },
);

referralEntrySchema.index({ userId: 1, createdAt: -1 });

export const ReferralEntry = mongoose.model('ReferralEntry', referralEntrySchema);
