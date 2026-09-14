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
    settled: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const LedgerEntry = mongoose.model('LedgerEntry', ledgerEntrySchema);
