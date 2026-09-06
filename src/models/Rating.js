import mongoose from 'mongoose';

/** One rating per direction per completed task (UC-C20 / UC-C21). */
const ratingSchema = new mongoose.Schema(
  {
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
    direction: {
      type: String,
      enum: ['customer_to_helper', 'helper_to_customer'],
      required: true,
    },
    fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    toUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    stars: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, default: '' },
    tags: [{ type: String }],
  },
  { timestamps: true },
);

ratingSchema.index({ taskId: 1, direction: 1 }, { unique: true });

export const Rating = mongoose.model('Rating', ratingSchema);
