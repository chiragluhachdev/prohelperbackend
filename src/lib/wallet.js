import mongoose from 'mongoose';
import { LedgerEntry, Task } from '../models/index.js';
import { TASK_STATUS } from '../config.js';

const round2 = (n) => Math.round((n || 0) * 100) / 100;

/**
 * What the platform owes a helper, as ledger rows:
 *  - the earning on a job paid online (the platform took the money), and
 *  - a customer's referral credit on a cash job (the helper was handed less).
 * A cash job's own earning is not one of them — the helper already has it —
 * and bookings closed before payment modes existed posted their earnings
 * unsettled, so "unsettled" alone would wrongly read as a payout due.
 */
export const PAYOUT_MATCH = { type: { $in: ['JOB_EARNING', 'REFERRAL_CREDIT'] }, settled: false };
export const PAYOUT_STAGES = [
  { $lookup: { from: Task.collection.name, localField: 'taskId', foreignField: '_id', as: 'task' } },
  { $match: { $or: [{ type: 'REFERRAL_CREDIT' }, { 'task.paymentMode': 'ONLINE' }] } },
];

/**
 * What a helper owes the platform: the platform's share of cash they collected,
 * less anything already paid toward it from their referral balance. Both kinds
 * of row are closed together once the rest is collected.
 */
export const DUES_MATCH = { type: { $in: ['PLATFORM_COMMISSION', 'DUES_PAYMENT'] }, settled: false };
export const SIGNED_DUES = { $cond: [{ $eq: ['$type', 'DUES_PAYMENT'] }, { $multiply: ['$amount', -1] }, '$amount'] };

export const asId = (id) => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)));

/** A helper's ledger rows for money the platform still has to pay them. */
export async function openPayoutEntries(userId) {
  return LedgerEntry.aggregate([
    { $match: { userId: asId(userId), ...PAYOUT_MATCH } },
    ...PAYOUT_STAGES,
    { $project: { _id: 1, amount: 1 } },
  ]);
}

/** What a helper owes the platform right now, net of referral payments. */
export async function helperDues(userId) {
  const [row] = await LedgerEntry.aggregate([
    { $match: { userId: asId(userId), ...DUES_MATCH } },
    { $group: { _id: null, total: { $sum: SIGNED_DUES } } },
  ]);
  return Math.max(0, round2(row?.total));
}

/**
 * Where a helper stands with the platform right now.
 *  - payoutDue: online-paid jobs the platform still has to pay them for
 *  - owedToPlatform: cash they collected that is the platform's share
 *  - balance: the two netted — negative means the helper owes
 */
export async function helperBalances(userId) {
  const [payout, owedToPlatform] = await Promise.all([openPayoutEntries(userId), helperDues(userId)]);
  const payoutDue = round2(payout.reduce((sum, e) => sum + e.amount, 0));
  return { payoutDue, owedToPlatform, balance: round2(payoutDue - owedToPlatform) };
}

/**
 * UC-C26 — the whole of a helper's money in one place, every figure read off
 * the ledger and the bills frozen on their bookings, never a running total
 * kept in a field.
 *
 *  gross        what their jobs were worth (the services, before charges)
 *  commission   the platform's share of that
 *  adjustments  anything an admin added or took off, signed
 *  paid         money already in their hands: cash jobs, and payouts sent
 *  payable      what the platform still owes them
 *  outstanding  what they owe the platform, from cash they collected
 */
export async function helperEarnings(userId) {
  const uid = asId(userId);
  const done = { $in: [TASK_STATUS.COMPLETED, TASK_STATUS.SETTLED] };

  const [jobs] = await Task.aggregate([
    { $match: { helperId: uid, status: done } },
    {
      $group: {
        _id: null,
        completedJobs: { $sum: 1 },
        gross: { $sum: '$pricing.servicesAmount' },
        commission: { $sum: '$pricing.helperCommission' },
        payout: { $sum: '$pricing.helperPayout' },
      },
    },
  ]);

  const [adjusted] = await LedgerEntry.aggregate([
    { $match: { userId: uid, type: 'ADJUSTMENT' } },
    {
      $group: {
        _id: null,
        total: { $sum: { $cond: [{ $eq: ['$direction', 'CREDIT'] }, '$amount', { $multiply: ['$amount', -1] }] } },
      },
    },
  ]);

  // Paid: a cash job (the customer handed it over), a payout the platform has
  // settled, or a payout row written by hand.
  const [paid] = await LedgerEntry.aggregate([
    { $match: { userId: uid, type: { $in: ['JOB_EARNING', 'PAYOUT'] } } },
    { $lookup: { from: Task.collection.name, localField: 'taskId', foreignField: '_id', as: 'task' } },
    { $addFields: { mode: { $first: '$task.paymentMode' } } },
    { $match: { $or: [{ type: 'PAYOUT' }, { mode: 'CASH' }, { settled: true }] } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  const balances = await helperBalances(userId);
  const adjustments = round2(adjusted?.total);
  return {
    completedJobs: jobs?.completedJobs || 0,
    gross: round2(jobs?.gross),
    commission: round2(jobs?.commission),
    netEarning: round2((jobs?.payout || 0) + adjustments),
    adjustments,
    paid: round2(paid?.total),
    payable: round2(balances.payoutDue + adjustments),
    outstanding: balances.owedToPlatform,
    balance: round2(balances.payoutDue + adjustments - balances.owedToPlatform),
  };
}

/**
 * The lines a paid booking puts on the helper's wallet statement, from the
 * bill frozen on the booking:
 *  - online: the job value comes in, the helper's commission goes out
 *  - cash:   what the customer handed over comes in; then everything that is
 *            the platform's goes out — commission, platform fee, surcharge,
 *            GST — and anything the platform gave the customer (a discount,
 *            their referral balance) comes back in, since the helper was
 *            handed that much less.
 * Either way the lines add up to the helper's payout.
 */
export function walletLines(task) {
  const p = task.pricing || {};
  const commission = { kind: 'COMMISSION', percent: p.helperCommissionPercent || 0, amount: -round2(p.helperCommission) };
  if (task.paymentMode === 'ONLINE') {
    return [{ kind: 'PAID_ONLINE', amount: round2(p.servicesAmount) }, commission];
  }
  const credit = round2(p.referralCredit);
  const lines = [{ kind: 'PAID_CASH', amount: round2((p.total || 0) - credit) }, commission];
  if (p.platformFee > 0) lines.push({ kind: 'PLATFORM_FEE', percent: p.platformFeePercent || 0, amount: -round2(p.platformFee) });
  if (p.surcharge > 0) lines.push({ kind: 'SURCHARGE', label: p.surchargeLabel || '', amount: -round2(p.surcharge) });
  if (p.gst > 0) lines.push({ kind: 'GST', percent: p.gstPercent || 0, amount: -round2(p.gst) });
  if (p.discount > 0) lines.push({ kind: 'DISCOUNT', amount: round2(p.discount) });
  if (credit > 0) lines.push({ kind: 'REFERRAL_CREDIT', amount: credit });
  return lines;
}

const PAID = {
  status: { $in: [TASK_STATUS.COMPLETED, TASK_STATUS.SETTLED] },
  paymentStatus: 'PAID',
};

/** A helper's wallet statement: newest bookings first, one group per booking. */
export async function walletStatement(userId, { limit = 100 } = {}) {
  const helperId = asId(userId);
  const filter = { helperId, ...PAID };

  const [tasks, count, balances] = await Promise.all([
    Task.find(filter)
      .select('code services pricing paymentMode paidAt completedAt')
      .sort({ paidAt: -1, completedAt: -1 })
      .limit(limit)
      .lean(),
    Task.countDocuments(filter),
    helperBalances(helperId),
  ]);

  // The bottom line covers every paid booking, not just the ones listed. Each
  // booking's lines add up to its payout, so the net is simply the payouts.
  const [all] = await Task.aggregate([
    { $match: filter },
    { $group: { _id: null, net: { $sum: '$pricing.helperPayout' } } },
  ]);

  return {
    ...balances,
    netEarning: round2(all?.net),
    bookings: count,
    truncated: count > tasks.length,
    groups: tasks.map((t) => ({
      taskId: String(t._id),
      code: t.code,
      at: t.paidAt || t.completedAt,
      method: t.paymentMode === 'ONLINE' ? 'ONLINE' : 'CASH',
      services: (t.services || []).map((s) => ({ code: s.code, name: s.name })),
      lines: walletLines(t),
    })),
  };
}
