import crypto from 'node:crypto';
import { Otp } from '../models/index.js';
import { DEV_OTP, DUMMY_AUTH } from '../config.js';
import { badRequest } from './http.js';

const OTP_LENGTH = 6;
const OTP_TTL_SECONDS = 300;
const MAX_ATTEMPTS = 5;
const RESEND_WINDOW_MS = 60_000;
const MAX_SENDS_PER_WINDOW = 3;

export const OTP_DIGITS = OTP_LENGTH;
export const generateCode = () => String(crypto.randomInt(100000, 1000000));

/**
 * Issues a login OTP (UC-C01). The code is still generated and stored so the
 * real flow is exercised end to end; in DEV_OTP mode it also comes back in the
 * response and is printed, so the app can be demoed without an SMS gateway.
 */
export async function issueOtp(phone, { role = '', purpose = 'login' } = {}) {
  if (!DUMMY_AUTH) {
    const since = new Date(Date.now() - RESEND_WINDOW_MS);
    const recent = await Otp.countDocuments({ phone, purpose, createdAt: { $gte: since } });
    if (recent >= MAX_SENDS_PER_WINDOW) {
      throw badRequest('Too many OTP requests. Please wait a minute and try again.', 'OTP_RATE_LIMITED');
    }
  }

  // Any earlier code for this number stops working the moment a new one is sent.
  await Otp.updateMany({ phone, purpose, consumedAt: null }, { $set: { consumedAt: new Date() } });

  const code = generateCode();
  await Otp.create({
    phone,
    role,
    code,
    purpose,
    expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
  });

  console.log(`[otp] ${purpose} code for ${phone} → ${code}${DUMMY_AUTH ? ' (any 6 digits will pass)' : ''}`);

  if (process.env.FAST2SMS_API_KEY) {
    try {
      // Fast2SMS requires 10-digit Indian numbers without +91
      const cleanPhone = phone.replace(/\D/g, '').slice(-10);
      
      const response = await fetch('https://www.fast2sms.com/dev/bulkV2', {
        method: 'POST',
        headers: {
          'authorization': process.env.FAST2SMS_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          route: 'q',
          message: `Your GetHelper verification code is ${code}. Do not share this with anyone.`,
          numbers: cleanPhone
        })
      });
      
      const data = await response.json();
      if (data.return === false) {
        console.error('[otp] Fast2SMS Error:', data.message);
      } else {
        console.log(`[otp] SMS sent successfully to ${cleanPhone}`);
      }
    } catch (err) {
      console.error('[otp] Failed to send SMS via Fast2SMS:', err.message);
    }
  }

  return {
    sent: true,
    length: OTP_LENGTH,
    expiresInSeconds: OTP_TTL_SECONDS,
    dummyAuth: DUMMY_AUTH,
    devCode: DEV_OTP ? code : undefined,
  };
}

/**
 * Consumes an OTP.
 *
 * With DUMMY_AUTH on, any 6-digit number is accepted — the account is still
 * created and the phone number is still stored, only the code check is relaxed.
 * With it off this is a strict check: right code, not expired, attempts capped.
 */
export async function verifyOtp(phone, code, purpose = 'login') {
  const entered = String(code ?? '').trim();

  if (DUMMY_AUTH) {
    if (!new RegExp(`^\\d{${OTP_LENGTH}}$`).test(entered)) {
      throw badRequest(`Enter the ${OTP_LENGTH}-digit OTP.`, 'OTP_INVALID');
    }
    await Otp.updateMany({ phone, purpose, consumedAt: null }, { $set: { consumedAt: new Date() } });
    return true;
  }

  const record = await Otp.findOne({ phone, purpose, consumedAt: null }).sort({ createdAt: -1 });
  if (!record) throw badRequest('Please request a new OTP.', 'OTP_NOT_FOUND');
  if (record.expiresAt < new Date()) throw badRequest('This OTP has expired.', 'OTP_EXPIRED');
  if (record.attempts >= MAX_ATTEMPTS) {
    throw badRequest('Too many incorrect attempts. Request a new OTP.', 'OTP_ATTEMPTS_EXCEEDED');
  }

  if (record.code !== entered) {
    record.attempts += 1;
    await record.save();
    const left = Math.max(MAX_ATTEMPTS - record.attempts, 0);
    throw badRequest(`Incorrect OTP. ${left} attempt${left === 1 ? '' : 's'} left.`, 'OTP_INVALID');
  }

  record.consumedAt = new Date();
  await record.save();
  return true;
}
