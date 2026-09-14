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
 * The lines a paid booking puts on the helper's wallet statement, from the
 * bill frozen on the booking:
 *  - online: the job value comes in, the helper's commission goes out
 *  - cash:   what the customer handed over comes in, then the commission and
 *            the customer's service fee go out — both are the platform's. If
 *            the customer paid part with referral balance, the platform makes
 *            that part up to the helper.
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

  // The bottom line covers every paid booking, not just the ones listed.
  const [all] = await Task.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        net: {
          $sum: {
            $cond: [
              { $eq: ['$paymentMode', 'ONLINE'] },
              { $subtract: ['$pricing.servicesAmount', '$pricing.helperCommission'] },
              { $subtract: ['$pricing.total', { $add: ['$pricing.helperCommission', '$pricing.platformFee'] }] },
            ],
          },
        },
      },
    },
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
      services: (t.services || []).map((s) => ({ code: s.code, name: s.name, nameHi: s.nameHi || '' })),
      lines: walletLines(t),
    })),
  };
}
