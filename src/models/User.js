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

    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

userSchema.index({ phone: 1, role: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
userSchema.index({ email: 1 }, { unique: true, sparse: true });

export const User = mongoose.model('User', userSchema);
