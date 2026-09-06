import { LedgerEntry } from '../models/index.js';

/**
 * Appends a ledger row. `ref` is unique, so calling this twice for the same
 * event is a no-op rather than double-paying anyone (UC-C50).
 * @returns the entry, or null if it already existed.
 */
export async function postEntry({ userId, taskId, type, direction, amount, note, ref, currency = 'INR' }) {
  try {
    return await LedgerEntry.create({ userId, taskId, type, direction, amount, note, ref, currency });
  } catch (err) {
    if (err?.code === 11000) return null; // already posted
    throw err;
  }
}

/** Rolls the helper's rows up into the numbers the Earnings screen shows. */
export async function earningsSummary(userId) {
  const [agg] = await LedgerEntry.aggregate([
    { $match: { userId, type: { $in: ['JOB_EARNING', 'ADJUSTMENT', 'PAYOUT'] } } },
    {
      $group: {
        _id: null,
        credits: { $sum: { $cond: [{ $eq: ['$direction', 'CREDIT'] }, '$amount', 0] } },
        debits: { $sum: { $cond: [{ $eq: ['$direction', 'DEBIT'] }, '$amount', 0] } },
        paid: { $sum: { $cond: [{ $eq: ['$type', 'PAYOUT'] }, '$amount', 0] } },
      },
    },
  ]);

  const startOfWeek = new Date();
  startOfWeek.setHours(0, 0, 0, 0);
  startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7)); // Monday

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [week] = await LedgerEntry.aggregate([
    { $match: { userId, type: 'JOB_EARNING', direction: 'CREDIT', createdAt: { $gte: startOfWeek } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const [today] = await LedgerEntry.aggregate([
    { $match: { userId, type: 'JOB_EARNING', direction: 'CREDIT', createdAt: { $gte: startOfDay } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  const credits = agg?.credits || 0;
  const debits = agg?.debits || 0;
  return {
    totalEarnings: Math.round((credits - debits) * 100) / 100,
    thisWeek: Math.round((week?.total || 0) * 100) / 100,
    today: Math.round((today?.total || 0) * 100) / 100,
    paidOut: Math.round((agg?.paid || 0) * 100) / 100,
  };
}
