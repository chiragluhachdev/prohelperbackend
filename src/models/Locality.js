import mongoose from 'mongoose';

/**
 * A place Pro Helper serves — an estate like RPS Savana — and what things cost
 * there (UC-C43).
 *
 * Localities are data, not code: an admin adds one, switches one off, and
 * prices it, without a release. Addresses, helpers' service areas and matching
 * all refer to a locality by its code, which never changes once made.
 */
const localityPriceSchema = new mongoose.Schema(
  {
    serviceCode: { type: String, required: true },
    /** The fixed price of this service here, before any answers add to it. */
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const localitySchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    area: { type: String, default: '' },
    city: { type: String, default: '' },
    pincode: { type: String, default: '' },
    /** The estate's centre, and how far from it still counts as this locality when a customer drops a map pin. */
    lat: { type: Number, default: 0 },
    lng: { type: Number, default: 0 },
    radiusKm: { type: Number, default: 1.5, min: 0.1, max: 50 },
    /** Off: no longer offered in the apps, and no new bookings. Existing ones carry on. */
    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },

    pricing: {
      /**
       * What a service costs here when it has no fixed price below:
       * catalog — the catalog price; percent — catalog ± a percentage;
       * flat — catalog ± an amount.
       */
      fallback: { type: String, enum: ['catalog', 'percent', 'flat'], default: 'catalog' },
      fallbackValue: { type: Number, default: 0 },
      prices: { type: [localityPriceSchema], default: [] },
      /** Goes up by one on every saved change; bookings keep the version they were priced with. */
      version: { type: Number, default: 0 },
      updatedAt: { type: Date },
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
  },
  { timestamps: true },
);

export const Locality = mongoose.model('Locality', localitySchema);

/**
 * Every price change, one row per service per save — so "who changed Cooking
 * in RPS Palms from ₹149 to ₹169, and when" always has an answer.
 */
const priceHistorySchema = new mongoose.Schema(
  {
    localityCode: { type: String, required: true, index: true },
    /** Blank for a change to the locality's fallback rule rather than one service. */
    serviceCode: { type: String, default: '' },
    field: { type: String, enum: ['price', 'fallback'], default: 'price' },
    from: { type: mongoose.Schema.Types.Mixed },
    to: { type: mongoose.Schema.Types.Mixed },
    version: { type: Number, required: true },
    byId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, default: '' },
    reason: { type: String, default: '' },
  },
  { timestamps: true },
);

priceHistorySchema.index({ localityCode: 1, createdAt: -1 });

export const PriceHistory = mongoose.model('PriceHistory', priceHistorySchema);
