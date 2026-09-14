import mongoose from 'mongoose';

const redemptionRequestSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true },
    /** E.g., 'UPI: 9999999999@ybl' */
    paymentDetails: { type: String, required: true },
    status: {
      type: String,
      enum: ['PROCESSING', 'PAID', 'REJECTED'],
      default: 'PROCESSING',
      index: true,
    },
    /** The ReferralEntry row that debited this amount from their balance. */
    referralEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralEntry', required: true },
    /** Who processed this request. */
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    processedAt: { type: Date },
    rejectionReason: { type: String, default: '' },
  },
  { timestamps: true },
);

redemptionRequestSchema.index({ userId: 1, createdAt: -1 });

export const RedemptionRequest = mongoose.model('RedemptionRequest', redemptionRequestSchema);
