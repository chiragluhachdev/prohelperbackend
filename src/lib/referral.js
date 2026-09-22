import crypto from 'node:crypto';
import { LedgerEntry, ReferralEntry, User } from '../models/index.js';
import { ROLES } from '../config.js';
import { badRequest, conflict } from './http.js';
import { getSettings } from './settings.js';
import { notify } from './notify.js';
import { asId, DUES_MATCH, helperDues } from './wallet.js';
import { newTxnId } from './ledger.js';

const round2 = (n) => Math.round((n || 0) * 100) / 100;

// No 0/O or 1/I — a code read out over the phone should not be misheard.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
export const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

export const normaliseCode = (code) => String(code ?? '').trim().toUpperCase().replace(/\s/g, '');

function newCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

/**
 * Every account gets its code the first time it is asked for, and keeps it.
 * The unique index settles the rare collision; the filter makes two
 * simultaneous first requests agree on one code.
 */
export async function ensureReferralCode(user) {
  if (user.referralCode) return user.referralCode;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const updated = await User.findOneAndUpdate(
        { _id: user._id, $or: [{ referralCode: { $exists: false } }, { referralCode: null }] },
        { $set: { referralCode: newCode() } },
        { new: true },
      ).lean();
      if (updated) return updated.referralCode;
      const current = await User.findById(user._id).select('referralCode').lean();
      if (current?.referralCode) return current.referralCode;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new Error('Could not allocate a referral code');
}

/** A user's referral balance: every row added up. Never negative in practice. */
export async function referralBalance(userId) {
  const [row] = await ReferralEntry.aggregate([
    { $match: { userId: asId(userId) } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return round2(row?.total);
}

async function post(entry) {
  try {
    return await ReferralEntry.create({ txnId: newTxnId(), ...entry });
  } catch (err) {
    if (err?.code === 11000) return null; // already written
    throw err;
  }
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

const side = (role) => (role === ROLES.PARTNER ? 'partner' : role === ROLES.HELPER ? 'helper' : 'customer');

/**
 * What a referral pays the person who referred: set per pair, so signing up a
 * helper can be worth more than signing up a customer, and a referral partner
 * can be paid at their own rate (UC-C33 / UC-C34).
 */
export function rewardFor(settings, referrerRole, joinerRole) {
  return Number(settings[`referral_reward_${side(referrerRole)}_refers_${side(joinerRole)}`]) || 0;
}

/** What the person who joined with a code gets, by the kind of account they opened. */
export function welcomeFor(settings, joinerRole) {
  return Number(settings[`referral_welcome_${side(joinerRole)}`]) || 0;
}

/**
 * Whether `user` may join with `code`. Throws a coded error when not, so the
 * app can say exactly why; returns the referrer when it may.
 */
export async function checkReferralCode(user, rawCode) {
  const settings = await getSettings();
  if (!settings.referral_enabled) throw badRequest('Referral codes are not being accepted right now.', 'REFERRALS_DISABLED');

  const code = normaliseCode(rawCode);
  if (!CODE_RE.test(code)) throw badRequest('A referral code is 6 letters and numbers.', 'REFERRAL_CODE_INVALID');

  const referrer = await User.findOne({ referralCode: code, status: 'active' }).select('name phone role').lean();
  if (!referrer) throw badRequest('That referral code does not exist.', 'REFERRAL_CODE_INVALID');

  // The same number with the other role is the same person.
  if (String(referrer._id) === String(user._id) || (referrer.phone && referrer.phone === user.phone)) {
    throw badRequest('You cannot use your own referral code.', 'REFERRAL_OWN_CODE');
  }
  if (user.referredBy) throw conflict('You have already used a referral code.', 'REFERRAL_ALREADY_APPLIED');

  const windowDays = Number(settings.referral_apply_window_days) || 0;
  if (windowDays > 0 && user.createdAt && Date.now() - new Date(user.createdAt).getTime() > windowDays * 86_400_000) {
    throw badRequest('Referral codes can only be used when you first sign up.', 'REFERRAL_WINDOW_CLOSED');
  }

  return {
    referrer, code,
    reward: rewardFor(settings, referrer.role, user.role),
    welcome: welcomeFor(settings, user.role),
  };
}

/**
 * The referral itself. Claiming `referredBy` is the atomic step, so a code can
 * be applied to an account once however often the button is pressed; both
 * rewards are keyed to the new account, so neither can be paid twice.
 */
export async function applyReferral(user, rawCode) {
  const { referrer, code, reward, welcome } = await checkReferralCode(user, rawCode);

  const claimed = await User.findOneAndUpdate(
    { _id: user._id, referredBy: null },
    { $set: { referredBy: referrer._id, referredAt: new Date(), referralRewardEarned: false } },
    { new: true },
  );
  if (!claimed) throw conflict('You have already used a referral code.', 'REFERRAL_ALREADY_APPLIED');

  // We do NOT post rewards yet. They are posted when the first booking completes.

  return { user: claimed, referrerName: firstName(referrer.name), welcome, reward };
}

/**
 * Triggered when a task is completed. If this is the user's first completed booking
 * and they joined with a referral code, post the rewards to both parties.
 */
export async function triggerFirstBookingRewards(userId, task) {
  const user = await User.findById(userId).populate('referredBy', 'name role status').lean();
  if (!user || !user.referredBy || user.referralRewardEarned) return;

  const referrer = user.referredBy;
  if (referrer.status !== 'active') return;

  const settings = await getSettings();
  if (!settings.referral_enabled) return;

  // The rate depends on who referred and what kind of account joined.
  const isPartner = referrer.role === ROLES.PARTNER;
  const reward = rewardFor(settings, referrer.role, user.role);
  const welcome = welcomeFor(settings, user.role);

  // Mark the reward as earned atomically so we don't double-pay
  const marked = await User.findOneAndUpdate(
    { _id: user._id, referralRewardEarned: false },
    { $set: { referralRewardEarned: true } },
  );
  if (!marked) return; // Raced and lost, already paid

  if (reward > 0) {
    await post({
      userId: referrer._id, type: 'REFERRER_REWARD', amount: reward, counterpartyId: user._id, taskId: task?._id,
      ref: `referral:${user._id}:referrer`,
      note: isPartner ? `Cashback — ${firstName(user.name) || 'someone'} you signed up finished their first booking` : `Joined with code ${referrer.referralCode || ''}`,
    });
  }
  if (welcome > 0) {
    await post({
      userId: user._id, type: 'WELCOME_REWARD', amount: welcome, counterpartyId: referrer._id, taskId: task?._id,
      ref: `referral:${user._id}:welcome`, note: `Joined with code ${referrer.referralCode || ''}`,
    });
  }

  const joiner = firstName(user.name);
  await notify(referrer._id, 'REFERRAL_REWARD', 'Referral reward',
    `${joiner || 'Someone'} completed their first booking! ₹${reward} added to your referral balance.`,
    { name: joiner, amount: String(reward) });
}


/** The share of a booking's total that referral balance may pay — 50% unless an admin changes it. */
export function maxBookingPercent(settings) {
  const pct = Number(settings.referral_max_booking_percent);
  return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 50;
}

/**
 * Referral balance a customer can put toward a bill: as much as they have, but
 * never more than the capped share of that booking (50% by default), so every
 * booking is still at least half paid for. The rest stays for later bookings.
 *
 * Switching referral codes off stops new ones being entered; balance already
 * earned can still be spent. Helpers spend theirs on dues instead.
 */
export async function usableForBooking(user, total) {
  const settings = await getSettings();
  const balance = user.role === ROLES.CUSTOMER ? await referralBalance(user._id) : 0;
  const percent = maxBookingPercent(settings);
  const cap = round2(((total || 0) * percent) / 100);
  const usable = round2(Math.max(0, Math.min(balance, cap)));
  return { balance, usable, cap, percent };
}

/**
 * Spend referral balance on a booking. Written first and checked after, so two
 * bookings made at the same moment cannot both spend the same rupees: the one
 * that would take the balance below zero is undone.
 * @returns true if it stuck
 */
export async function redeemForBooking(userId, task, amount) {
  if (!(amount > 0)) return false;
  const row = await post({
    userId, type: 'BOOKING_REDEMPTION', amount: -round2(amount), taskId: task._id,
    ref: `redeem:${task._id}`, note: `Used on ${task.code}`,
  });
  if (!row) return true; // already redeemed for this booking
  if ((await referralBalance(userId)) < 0) {
    await ReferralEntry.deleteOne({ _id: row._id });
    return false;
  }
  return true;
}

/** A cancelled booking gives back whatever referral balance it used. */
export async function refundBookingCredit(task) {
  const credit = round2(task?.pricing?.referralCredit);
  if (!(credit > 0)) return null;
  const redeemed = await ReferralEntry.exists({ ref: `redeem:${task._id}` });
  if (!redeemed) return null;
  return post({
    userId: task.customerId, type: 'BOOKING_REFUND', amount: credit, taskId: task._id,
    ref: `refund:${task._id}`, note: `${task.code} was cancelled`,
  });
}

/**
 * A helper pays what they owe the platform from their referral balance — as
 * much as either allows. Both sides are written, then both re-checked: if two
 * taps raced and overspent either one, the second is undone. Paying the dues
 * off completely closes the underlying rows, as an admin collection would.
 */
export async function settleDuesFromReferral(helper) {
  const [balance, dues] = await Promise.all([referralBalance(helper._id), helperDues(helper._id)]);
  const amount = round2(Math.min(balance, dues));
  if (!(amount > 0)) {
    throw conflict(
      dues <= 0 ? 'You do not owe the platform anything right now.' : 'You have no referral balance to use.',
      dues <= 0 ? 'NOTHING_OWED' : 'NO_REFERRAL_BALANCE',
    );
  }

  const id = crypto.randomUUID();
  const spent = await ReferralEntry.create({
    userId: helper._id, type: 'DUES_SETTLEMENT', amount: -amount,
    ref: `settle:${id}`, note: 'Used to pay platform dues',
  });
  const paid = await LedgerEntry.create({
    userId: helper._id, type: 'DUES_PAYMENT', direction: 'CREDIT', amount,
    ref: `referral-settle:${id}`, note: 'Paid from referral balance',
  });

  const [balanceAfter, duesAfter] = await Promise.all([
    referralBalance(helper._id),
    LedgerEntry.aggregate([
      { $match: { userId: asId(helper._id), ...DUES_MATCH } },
      {
        $group: {
          _id: null,
          total: { $sum: { $cond: [{ $eq: ['$type', 'DUES_PAYMENT'] }, { $multiply: ['$amount', -1] }, '$amount'] } },
        },
      },
    ]).then(([row]) => round2(row?.total)),
  ]);
  if (balanceAfter < 0 || duesAfter < 0) {
    await Promise.all([ReferralEntry.deleteOne({ _id: spent._id }), LedgerEntry.deleteOne({ _id: paid._id })]);
    throw conflict('Your balance changed — please try again.', 'REFERRAL_BALANCE_CHANGED');
  }

  if (duesAfter === 0) {
    await LedgerEntry.updateMany({ userId: asId(helper._id), ...DUES_MATCH }, { $set: { settled: true, status: 'SETTLED' } });
  }

  return { settled: amount, referralBalance: balanceAfter, owedToPlatform: Math.max(0, duesAfter) };
}
