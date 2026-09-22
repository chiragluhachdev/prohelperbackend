import { Router } from 'express';
import { ReferralEntry } from '../models/index.js';
import { ROLES } from '../config.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { wrap, forbidden } from '../lib/http.js';
import { getSettings } from '../lib/settings.js';
import { helperDues } from '../lib/wallet.js';
import {
  applyReferral, checkReferralCode, ensureReferralCode, maxBookingPercent, referralBalance,
  REFERRAL_EARNING_TYPES, REFERRAL_POINT_TYPES, rewardFor, settleDuesFromReferral, welcomeFor,
} from '../lib/referral.js';

const router = Router();
/*
 * Partners belong here too: they can join with someone else's code like
 * anyone, and are paid at the helper rate for it. Spending is still each
 * role's own business — a partner takes their money out through a payout
 * request, not by settling dues.
 */
router.use(authenticate, requireRole(ROLES.CUSTOMER, ROLES.HELPER, ROLES.PARTNER));

const round2 = (n) => Math.round((n || 0) * 100) / 100;
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/**
 * GET /api/referrals — the Referral & Earnings screen: the code to share, the
 * balance, what it has been earned and spent on, and — for a helper — what
 * that balance could pay off.
 */
router.get(
  '/',
  wrap(async (req, res) => {
    const settings = await getSettings();
    const [code, rows, balance] = await Promise.all([
      ensureReferralCode(req.user),
      ReferralEntry.find({ userId: req.user._id })
        .populate('counterpartyId', 'name')
        .populate('taskId', 'code')
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),
      referralBalance(req.user._id),
    ]);

    const sum = (types) => round2(rows.filter((r) => types.includes(r.type)).reduce((t, r) => t + r.amount, 0));
    const earned = sum(REFERRAL_EARNING_TYPES);
    const windowDays = Number(settings.referral_apply_window_days) || 0;
    const withinWindow = !windowDays || Date.now() - new Date(req.user.createdAt).getTime() <= windowDays * 86_400_000;

    res.json({
      code,
      role: req.user.role,
      enabled: Boolean(settings.referral_enabled),
      // Referral points at this person's own rate, whoever ends up joining.
      rewardAmount: rewardFor(settings, req.user.role),
      // The joining bonus their friend gets depends on the friend's own role.
      welcome: {
        customer: welcomeFor(settings, ROLES.CUSTOMER),
        helper: welcomeFor(settings, ROLES.HELPER),
      },
      // The single figure older app versions read.
      welcomeAmount: welcomeFor(settings, ROLES.CUSTOMER),
      // Customers: the most of any one booking the balance can pay.
      maxBookingPercent: maxBookingPercent(settings),
      balance,
      totals: {
        referrals: rows.filter((r) => REFERRAL_POINT_TYPES.includes(r.type)).length,
        earned,
        // Spent on bookings or dues, less anything a cancelled booking gave back.
        used: round2(-sum(['BOOKING_REDEMPTION', 'DUES_SETTLEMENT', 'BOOKING_REFUND'])),
        available: balance,
      },
      history: rows.map((r) => ({
        id: String(r._id),
        at: r.createdAt,
        type: r.type,
        amount: round2(r.amount),
        name: firstName(r.counterpartyId?.name),
        taskCode: r.taskId?.code || '',
      })),
      canApply: Boolean(settings.referral_enabled) && !req.user.referredBy && withinWindow,
      referred: Boolean(req.user.referredBy),
      owedToPlatform: req.user.role === ROLES.HELPER ? await helperDues(req.user._id) : undefined,
    });
  }),
);

/** GET /api/referrals/check?code= — is this code usable by me, before I commit to it? */
router.get(
  '/check',
  wrap(async (req, res) => {
    const { referrer, code, welcome } = await checkReferralCode(req.user, req.query.code);
    res.json({ valid: true, code, referrerName: firstName(referrer.name), welcome });
  }),
);

/** POST /api/referrals/apply — join with a code. Once per account, at sign-up. */
router.post(
  '/apply',
  wrap(async (req, res) => {
    const result = await applyReferral(req.user, req.body.code);
    res.status(201).json({
      applied: true,
      welcome: result.welcome,
      referrerName: result.referrerName,
      balance: await referralBalance(req.user._id),
    });
  }),
);

/** POST /api/referrals/settle — helpers only: pay platform dues from referral balance. */
router.post(
  '/settle',
  wrap(async (req, res) => {
    if (req.user.role !== ROLES.HELPER) throw forbidden('Only helpers can settle dues with referral balance.');
    res.json(await settleDuesFromReferral(req.user));
  }),
);

export default router;
