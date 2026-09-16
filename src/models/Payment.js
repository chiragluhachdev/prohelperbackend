import mongoose from 'mongoose';

/**
 * UC-C28 — an online payment, from the order we create to the gateway's
 * callback. The gateway's own payment id is unique here, so a callback
 * delivered twice can only ever be recorded once.
 */
const paymentSchema = new mongoose.Schema(
  {
    /** Our order id, shown to the customer and sent to the gateway. */
    orderId: { type: String, required: true, unique: true },
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    gateway: { type: String, default: 'mock' },
    gatewayOrderId: { type: String, default: '' },
    /** The gateway's id for the money itself — unique, and the reason a replayed callback is harmless. */
    gatewayPaymentId: { type: String, default: null },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    method: { type: String, default: '' },
    status: { type: String, enum: ['CREATED', 'PAID', 'FAILED', 'REFUNDED'], default: 'CREATED', index: true },
    failureReason: { type: String, default: '' },
    paidAt: { type: Date },
    refundedAt: { type: Date },
  },
  { timestamps: true },
);

paymentSchema.index({ gatewayPaymentId: 1 }, { unique: true, sparse: true });
// One open order per booking; a finished one never blocks a retry.
paymentSchema.index({ taskId: 1, status: 1 });

export const Payment = mongoose.model('Payment', paymentSchema);

/**
 * Every callback the gateway sends, kept by its own event id. Writing this row
 * is what makes handling a webhook idempotent: the second delivery of the same
 * event loses the race on the unique index and is ignored.
 */
const paymentEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
    orderId: { type: String, default: '' },
    type: { type: String, default: '' },
    payload: { type: mongoose.Schema.Types.Mixed },
    handled: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const PaymentEvent = mongoose.model('PaymentEvent', paymentEventSchema);
