import { Payment, PaymentEvent, Task, User } from '../models/index.js';
import { TASK_STATUS } from '../config.js';
import { badRequest, conflict, notFound } from './http.js';
import { getSettings } from './settings.js';
import { mustTransition } from './taskflow.js';
import { postEntry } from './ledger.js';
import { notify } from './notify.js';
import { createOrder, newGatewayPaymentId, verifySignature } from './gateway.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** What the customer still has to pay for a booking: the bill less referral balance used. */
export const amountDue = (task) =>
  round2((task.pricing?.total || 0) - (task.pricing?.referralCredit || 0));

/**
 * UC-C28 step 2 — the payment order.
 *
 * One open order per booking: asking again while one is open returns the same
 * order rather than creating another, so a customer who backs out of the
 * gateway and tries again does not leave a trail of half-made payments.
 */
export async function createPaymentOrder(task, user) {
  const settings = await getSettings();
  if (settings.online_payment_enabled === false) {
    throw badRequest('Online payment is switched off right now. Please pay your helper directly.', 'ONLINE_PAYMENT_DISABLED');
  }
  if (task.status !== TASK_STATUS.COMPLETED) throw conflict('This booking is not awaiting payment.', 'NOT_AWAITING_PAYMENT');
  if (task.paymentStatus === 'PAID') throw conflict('This booking has already been paid for.', 'ALREADY_PAID');

  const open = await Payment.findOne({ taskId: task._id, status: 'CREATED' }).lean();
  if (open) return open;

  const amount = amountDue(task);
  if (!(amount > 0)) throw conflict('There is nothing to pay on this booking.', 'NOTHING_TO_PAY');

  const orderId = `PH-${task.code.replace(/^GH-/, '')}-${Date.now().toString(36).toUpperCase()}`;
  const order = await createOrder({ amount, currency: task.pricing?.currency || 'INR', receipt: task.code });

  return (
    await Payment.create({
      orderId,
      taskId: task._id,
      userId: user._id,
      gateway: order.gateway,
      gatewayOrderId: order.gatewayOrderId,
      amount,
      currency: order.currency,
      status: 'CREATED',
    })
  ).toObject();
}

/**
 * UC-C28 steps 4–8 — a callback from the gateway.
 *
 * Nothing here trusts the caller: the signature is checked first, the event id
 * is written before anything else (so the same callback delivered twice is a
 * no-op), and the booking only moves once, guarded by its own status. The
 * money rows are written last, each keyed to the booking, so even a
 * hand-replayed event cannot pay a helper twice.
 *
 * @returns {{ handled: boolean, duplicate?: boolean, payment?: object }}
 */
export async function handlePaymentCallback(body, signature) {
  const { eventId, orderId, gatewayPaymentId, status = 'PAID', method = 'UPI', reason = '' } = body || {};
  if (!eventId || !orderId) throw badRequest('Malformed payment callback.', 'BAD_CALLBACK');

  if (!verifySignature([orderId, gatewayPaymentId || '', status], signature)) {
    throw badRequest('Payment callback signature does not match.', 'BAD_SIGNATURE');
  }

  // The event id is the idempotency key: writing it is how we claim this callback.
  let claimed;
  try {
    claimed = await PaymentEvent.create({ eventId, orderId, type: `payment.${String(status).toLowerCase()}`, payload: body });
  } catch (err) {
    if (err?.code === 11000) return { handled: false, duplicate: true };
    throw err;
  }

  const payment = await Payment.findOne({ orderId });
  if (!payment) throw notFound('Unknown payment order.');
  await PaymentEvent.updateOne({ _id: claimed._id }, { $set: { paymentId: payment._id } });

  if (status !== 'PAID') {
    await Payment.updateOne(
      { _id: payment._id, status: 'CREATED' },
      { $set: { status: 'FAILED', failureReason: String(reason || 'Payment failed at the gateway') } },
    );
    await PaymentEvent.updateOne({ _id: claimed._id }, { $set: { handled: true } });
    return { handled: true, payment: await Payment.findById(payment._id).lean() };
  }

  // Claim the payment itself: only the first PAID callback gets through.
  const paid = await Payment.findOneAndUpdate(
    { _id: payment._id, status: 'CREATED' },
    {
      $set: {
        status: 'PAID',
        gatewayPaymentId: gatewayPaymentId || newGatewayPaymentId(),
        method: String(method || ''),
        paidAt: new Date(),
      },
    },
    { new: true },
  );
  if (!paid) {
    await PaymentEvent.updateOne({ _id: claimed._id }, { $set: { handled: true } });
    return { handled: false, duplicate: true, payment: payment.toObject() };
  }

  await settlePaidBooking(paid);
  await PaymentEvent.updateOne({ _id: claimed._id }, { $set: { handled: true } });
  return { handled: true, payment: paid.toObject() };
}

/**
 * UC-C28 steps 7–8 — the booking is paid, so it settles and the money rows are
 * written: the helper's earning is now owed to them by the platform, which
 * holds the customer's money. The helper owes nothing back on an online
 * payment; commission was already taken out of their payout.
 */
export async function settlePaidBooking(payment) {
  const task = await Task.findById(payment.taskId);
  if (!task) return null;

  const settled =
    task.status === TASK_STATUS.SETTLED
      ? task
      : await mustTransition(task._id, [TASK_STATUS.COMPLETED], TASK_STATUS.SETTLED, {
          set: {
            settledAt: new Date(),
            paymentStatus: 'PAID',
            paymentMode: 'ONLINE',
            paidAt: payment.paidAt || new Date(),
            paidBy: payment.userId,
            paidByRole: 'customer',
          },
          actorType: 'customer',
          actorId: payment.userId,
          reason: `Paid online (${payment.orderId})`,
          meta: { orderId: payment.orderId, gatewayPaymentId: payment.gatewayPaymentId },
        });

  const { helperPayout = 0, currency = 'INR' } = settled.pricing || {};
  if (settled.helperId) {
    await postEntry({
      userId: settled.helperId,
      taskId: settled._id,
      type: 'JOB_EARNING',
      direction: 'CREDIT',
      amount: helperPayout,
      currency,
      note: `Earning for ${settled.code} (paid online)`,
      ref: `earning:${settled._id}`,
      source: 'GATEWAY',
    });
    await notify(settled.helperId, 'PAYMENT_RECEIVED', 'Paid online',
      `The customer paid online for ${settled.code}.`,
      { taskId: String(settled._id), code: settled.code, amount: String(helperPayout) });
  }
  return settled;
}

/** The payment a customer or admin is shown for a booking. */
export function publicPayment(p) {
  if (!p) return null;
  return {
    orderId: p.orderId,
    gateway: p.gateway,
    gatewayOrderId: p.gatewayOrderId,
    gatewayPaymentId: p.gatewayPaymentId || null,
    amount: round2(p.amount),
    currency: p.currency,
    method: p.method || '',
    status: p.status,
    failureReason: p.failureReason || '',
    createdAt: p.createdAt,
    paidAt: p.paidAt || null,
  };
}
