import mongoose from 'mongoose';

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, index: true },
    icon: { type: String, default: 'grid' },
    color: { type: String, default: 'forest700' },
    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
    comingSoon: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const Category = mongoose.model('Category', categorySchema);
