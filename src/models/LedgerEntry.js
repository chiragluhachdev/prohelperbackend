import mongoose from 'mongoose';

/**
 * UC-C26/C27/C35 — money is never a mutable `balance` field. Every rupee is a
 * row, and `ref` is unique so a replayed webhook or a double-tap can only ever
 * be written once.
 */
const ledgerEntrySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', index: true },
    type: {
      type: String,
      enum: [
        'JOB_EARNING', 'PLATFORM_COMMISSION', 'ADJUSTMENT', 'PAYOUT', 'REFERRAL_REWARD', 'REFUND',
        // A helper paid part of what they owe from their referral balance.
        'DUES_PAYMENT',
        // A customer's referral credit on a cash job — the platform makes it up to the helper.
        'REFERRAL_CREDIT',
      ],
      required: true,
    },
    direction: { type: String, enum: ['CREDIT', 'DEBIT'], required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    note: { type: String, default: '' },
    /** Idempotency handle, e.g. `earning:<taskId>`. */
    ref: { type: String, required: true, unique: true },
    /** The id people quote: on statements, in support, in the admin panel (UC-C35). */
    txnId: { type: String, unique: true },
    /** Where the money came from: a booking, the gateway, an admin, a referral. */
    source: { type: String, enum: ['TASK', 'GATEWAY', 'ADMIN', 'REFERRAL', 'SYSTEM'], default: 'TASK' },
    settled: { type: Boolean, default: false },
    /** Kept in step with `settled`; REVERSED is for a row undone rather than paid. */
    status: { type: String, enum: ['PENDING', 'SETTLED', 'REVERSED'], default: 'PENDING', index: true },
  },
  { timestamps: true },
);

ledgerEntrySchema.index({ userId: 1, createdAt: -1 });

export const LedgerEntry = mongoose.model('LedgerEntry', ledgerEntrySchema);
