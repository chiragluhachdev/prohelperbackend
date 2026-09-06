import mongoose from 'mongoose';

/**
 * KYC files live in Cloudinary; we keep only the reference. These are never
 * served publicly — the API hands the URL out to the owning helper and to
 * admins only (UC-C25).
 */
const helperDocumentSchema = new mongoose.Schema(
  {
    helperId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: ['aadhaar_front', 'aadhaar_back', 'police_clearance', 'address_proof', 'photo', 'other'],
      required: true,
    },
    url: { type: String, required: true },
    publicId: { type: String, default: '' },
    originalName: { type: String, default: '' },
    mimeType: { type: String, default: '' },
    sizeBytes: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'REJECTED'],
      default: 'PENDING',
      index: true,
    },
    remark: { type: String, default: '' },
    reviewedAt: { type: Date },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const HelperDocument = mongoose.model('HelperDocument', helperDocumentSchema);
