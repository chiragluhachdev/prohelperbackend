import mongoose from 'mongoose';

/**
 * Login OTPs. Mongo's TTL monitor deletes them shortly after they expire, so
 * a stale code can never be replayed.
 */
const otpSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    role: { type: String, default: '' },
    code: { type: String, required: true },
    purpose: { type: String, default: 'login' },
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 300 });

export const Otp = mongoose.model('Otp', otpSchema);
