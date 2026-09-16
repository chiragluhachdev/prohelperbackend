import mongoose from 'mongoose';

/**
 * Locality pricing.
 *
 * A zone is a group of societies that pay the same prices: one rule for
 * everything ("+10%", "+₹20"), and an exact price for the services that do not
 * follow it. A society in no zone pays the catalog price, so nothing changes
 * until a zone says so.
 *
 * Zones are read when a bill is worked out; every booking keeps the prices it
 * was made with, so changing a zone never touches what has already happened.
 */
const overrideSchema = new mongoose.Schema(
  {
    _id: false,
    serviceCode: { type: String, required: true },
    /** The exact price in this zone, instead of the rule below. */
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const priceZoneSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    /** The societies this zone covers. A society belongs to one zone at most. */
    societies: [{ type: String, index: true }],
    /** percent: a share on top of the catalog price. flat: an amount per service. none: overrides only. */
    adjustType: { type: String, enum: ['percent', 'flat', 'none'], default: 'percent' },
    /** Signed: +10 is ten percent more, −5 is five percent less. */
    adjustValue: { type: Number, default: 0 },
    overrides: [overrideSchema],
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const PriceZone = mongoose.model('PriceZone', priceZoneSchema);
