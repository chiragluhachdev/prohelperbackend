import mongoose from 'mongoose';
import { HELPER_APPROVAL } from '../config.js';

/**
 * Everything the matcher needs to decide whether a helper may be alerted:
 * approval, block status, online/DND, services and service area.
 */
const helperProfileSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

    gender: { type: String, enum: ['female', 'male', 'other', ''], default: '' },
    dob: { type: Date },
    experienceYears: { type: Number, default: 0 },
    bio: { type: String, default: '' },

    // --- identity (UC-C24 / UC-C25). Never store the full Aadhaar number. ---
    aadhaarLast4: { type: String, default: '' },
    aadhaarName: { type: String, default: '' },
    kycStatus: {
      type: String,
      enum: ['NOT_STARTED', 'VERIFIED', 'FAILED'],
      default: 'NOT_STARTED',
    },
    kycMethod: { type: String, default: '' }, // 'digilocker' | 'aadhaar-otp'
    kycVerifiedAt: { type: Date },

    // --- what the admin gates on ---
    approvalStatus: {
      type: String,
      enum: Object.values(HELPER_APPROVAL),
      default: HELPER_APPROVAL.DRAFT,
      index: true,
    },
    rejectionReason: { type: String, default: '' },
    submittedAt: { type: Date },
    reviewedAt: { type: Date },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // --- capability & reach ---
    services: [{ type: String, index: true }], // Service.code
    /**
     * Societies this helper will work in. The MVP matches on society overlap
     * rather than distance, so this is the field that matters; serviceArea
     * below is kept as the centre of the first one for the distance helper.
     */
    societies: [{ type: String, index: true }],

    serviceArea: {
      label: { type: String, default: '' },
      lat: { type: Number },
      lng: { type: Number },
      radiusKm: { type: Number, default: 5 },
    },

    /*
     * Availability is the online switch and nothing else: a helper is
     * reachable when isOnline is true and DND is off. There are deliberately
     * no working days or hours — the toggle is the whole story.
     */
    isOnline: { type: Boolean, default: false, index: true },
    dnd: { type: Boolean, default: false },

    // --- reputation & stats ---
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    completedJobs: { type: Number, default: 0 },

    // --- payment details ---
    paymentDetails: {
      method: { type: String, enum: ['UPI', 'BANK'], default: 'UPI' },
      upiId: { type: String, default: '' },
      accountNo: { type: String, default: '' },
      ifsc: { type: String, default: '' },
    },
  },
  { timestamps: true },
);

helperProfileSchema.index({ 'serviceArea.lat': 1, 'serviceArea.lng': 1 });

/** Onboarding checklist shown on the helper's "Verification status" screen. */
helperProfileSchema.methods.checklist = function checklist(docCount) {
  return {
    profile: this.experienceYears >= 0 && this.bio !== undefined,
    identity: this.kycStatus === 'VERIFIED',
    documents: docCount > 0,
    services: (this.services || []).length > 0,
    serviceArea: (this.societies || []).length > 0,
  };
};

export const HelperProfile = mongoose.model('HelperProfile', helperProfileSchema);
