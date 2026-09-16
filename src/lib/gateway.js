import crypto from 'node:crypto';
import { JWT_SECRET } from '../config.js';

/**
 * The payment gateway, behind one small interface (UC-C28).
 *
 * No real gateway is connected yet, so this one stands in: it issues order ids
 * and signs its callbacks exactly as a real one would, and the backend
 * verifies every callback the same way. Swapping in Razorpay (or anyone else)
 * means replacing these three functions — the order, webhook, verification and
 * settlement flow around them does not change.
 */
export const GATEWAY = process.env.PAYMENT_GATEWAY || 'mock';

/** The shared secret callbacks are signed with. */
const SECRET = process.env.PAYMENT_WEBHOOK_SECRET || `${JWT_SECRET}:payments`;

const rand = (n = 12) => crypto.randomBytes(n).toString('hex').slice(0, n);

/** Creates the order the customer's app hands to the gateway. */
export async function createOrder({ amount, currency = 'INR', receipt }) {
  return {
    gateway: GATEWAY,
    gatewayOrderId: `${GATEWAY}_order_${rand(14)}`,
    // Real gateways take the amount in the smallest unit — paise here.
    amountMinor: Math.round(amount * 100),
    currency,
    receipt,
    /** Public key the app would use to open the gateway's sheet. */
    key: process.env.PAYMENT_PUBLIC_KEY || 'ph_test_key',
  };
}

/** The signature a gateway puts on its callback: HMAC of the ids it is about. */
export function signPayload(parts) {
  return crypto.createHmac('sha256', SECRET).update(parts.join('|')).digest('hex');
}

/** True only for a signature this server would have produced — compared in constant time. */
export function verifySignature(parts, signature) {
  const expected = Buffer.from(signPayload(parts));
  const given = Buffer.from(String(signature || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** A gateway's own id for the money that moved. */
export const newGatewayPaymentId = () => `${GATEWAY}_pay_${rand(14)}`;
export const newEventId = () => `${GATEWAY}_evt_${rand(16)}`;
