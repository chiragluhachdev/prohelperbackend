import crypto from 'node:crypto';

/**
 * Text messages to a phone number. The MVP has no SMS gateway switched on, so
 * this only logs; the booking's code still reaches the customer in the app
 * and as a notification. Wiring a gateway in means filling in `deliver`.
 */
export async function sendSms(phone, message) {
  if (!phone) return { sent: false };
  console.log(`[sms] → ${phone}: ${message}`);

  // Fast2SMS, as used for sign-in codes — switched off with them (see lib/otp.js).
  //
  // if (process.env.FAST2SMS_API_KEY) {
  //   const numbers = phone.replace(/\D/g, '').slice(-10);
  //   const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
  //     method: 'POST',
  //     headers: { authorization: process.env.FAST2SMS_API_KEY, 'Content-Type': 'application/json' },
  //     body: JSON.stringify({ route: 'q', message, numbers }),
  //   });
  //   const data = await res.json().catch(() => ({}));
  //   return { sent: data.return !== false };
  // }

  return { sent: false, logged: true };
}

/** Compares two codes in constant time, so response timing reveals nothing about the right one. */
export function sameCode(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
