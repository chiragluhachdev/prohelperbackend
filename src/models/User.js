import mongoose from 'mongoose';
import { ROLES } from '../config.js';

/**
 * One account per (phone, role). A person may genuinely be a customer at home
 * and a helper for work, so the phone number alone is not unique — the pair is.
 * Admins log in with email + password instead and have no phone.
 */
const userSchema = new mongoose.Schema(
  {
    phone: { type: String, trim: true, index: true },
    role: { type: String, enum: Object.values(ROLES), required: true, index: true },
    name: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true },
    photoUrl: { type: String, default: '' },
    photoPublicId: { type: String, default: '' },

    status: { type: String, enum: ['active', 'blocked'], default: 'active', index: true },
    blockReason: { type: String, default: '' },
    blockedAt: { type: Date },

    // admin only
    passwordHash: { type: String, select: false },

    // UC-C23 — rejection tracking feeds the auto-block rule
    rejectionCount: { type: Number, default: 0 },

    fcmToken: { type: String, default: null },

    /*
     * Numbers this account used before, newest last. Support needs this when
     * someone says "that is not my number" — a silent overwrite would leave no
     * trace of what it was changed from.
     */
    previousPhones: [
      {
        _id: false,
        phone: String,
        changedAt: Date,
      },
    ],

    lastLoginAt: { type: Date },

    /** Six characters, handed out once and never reused — see lib/referral.js. */
    referralCode: { type: String, uppercase: true, trim: true },
    /** Who referred this account, set once at sign-up and never changed. */
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    referredAt: { type: Date },
  },
  { timestamps: true },
);

userSchema.index({ phone: 1, role: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
userSchema.index({ email: 1 }, { unique: true, sparse: true });
userSchema.index({ referralCode: 1 }, { unique: true, partialFilterExpression: { referralCode: { $type: 'string' } } });

export const User = mongoose.model('User', userSchema);
