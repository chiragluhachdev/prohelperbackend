import mongoose from 'mongoose';

/**
 * UC-C03 — customers keep multiple addresses. Note that a task never references
 * an Address by id; it stores a *snapshot*, so editing an address later cannot
 * rewrite where a past booking happened.
 */
const addressSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    label: { type: String, default: 'Home' },
    /** Which serviced society this address sits in — what matching keys off. */
    society: { type: String, default: '', index: true },
    line1: { type: String, required: true },
    line2: { type: String, default: '' },
    landmark: { type: String, default: '' },
    city: { type: String, default: '' },
    pincode: { type: String, default: '' },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    isDefault: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Address = mongoose.model('Address', addressSchema);
