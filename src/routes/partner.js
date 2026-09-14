import { Router } from 'express';
import { User, ReferralEntry, RedemptionRequest, Task } from '../models/index.js';
import { ROLES } from '../config.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { wrap, badRequest, conflict } from '../lib/http.js';
import { getSettings } from '../lib/settings.js';
import { ensureReferralCode, referralBalance } from '../lib/referral.js';

const router = Router();
router.use(authenticate, requireRole(ROLES.PARTNER));

const round2 = (n) => Math.round((n || 0) * 100) / 100;
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/**
 * PUT /api/partner/profile
 */
router.put(
  '/profile',
  wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) throw badRequest('Name is required.', 'MISSING_NAME');
    
    req.user.name = name;
    await req.user.save();
    
    res.json({ success: true });
  })
);

/**
 * GET /api/partner/dashboard
 */
router.get(
  '/dashboard',
  wrap(async (req, res) => {
    const settings = await getSettings();
    const code = await ensureReferralCode(req.user);

    // Get all users who joined with this partner's code
    const referredUsers = await User.find({ referredBy: req.user._id })
      .select('name role status referralRewardEarned createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const balance = await referralBalance(req.user._id);

    // Get ledger (wallet transactions)
    const ledger = await ReferralEntry.find({ userId: req.user._id })
      .populate('counterpartyId', 'name')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // Get redemption requests
    const redemptions = await RedemptionRequest.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const sum = (types) => round2(ledger.filter((r) => types.includes(r.type)).reduce((t, r) => t + r.amount, 0));
    const earned = sum(['REFERRER_REWARD', 'WELCOME_REWARD']);
    const redeemed = round2(-sum(['BOOKING_REDEMPTION', 'DUES_SETTLEMENT', 'BOOKING_REFUND', 'PARTNER_REDEMPTION']));
    
    // Total pending from referred users who haven't completed a booking
    const pendingReferrals = referredUsers.filter(u => !u.referralRewardEarned).length;
    const pendingRewards = pendingReferrals * (Number(settings.referral_reward_amount) || 0);

    res.json({
      code,
      enabled: Boolean(settings.referral_enabled),
      rewardAmount: Number(settings.referral_reward_amount) || 0,
      balance,
      totals: {
        totalReferrals: referredUsers.length,
        successfulReferrals: referredUsers.filter(u => u.referralRewardEarned).length,
        earned,
        redeemed,
        pendingRewards,
      },
      history: referredUsers.map(u => ({
        id: String(u._id),
        date: u.createdAt,
        name: firstName(u.name),
        role: u.role,
        status: u.referralRewardEarned ? 'Completed' : 'Pending',
        reward: u.referralRewardEarned ? (Number(settings.referral_reward_amount) || 0) : 0,
      })),
      ledger: ledger.map(r => ({
        id: String(r._id),
        date: r.createdAt,
        type: r.type,
        amount: round2(r.amount),
        name: firstName(r.counterpartyId?.name),
        note: r.note,
      })),
      redemptions: redemptions.map(r => ({
        id: String(r._id),
        date: r.createdAt,
        amount: r.amount,
        status: r.status,
      }))
    });
  })
);

/**
 * POST /api/partner/redeem
 */
router.post(
  '/redeem',
  wrap(async (req, res) => {
    const { amount, paymentDetails } = req.body;
    if (!amount || amount <= 0) throw badRequest('Enter a valid amount.', 'INVALID_AMOUNT');
    if (!paymentDetails || !paymentDetails.trim()) throw badRequest('Payment details are required.', 'INVALID_DETAILS');

    const balance = await referralBalance(req.user._id);
    if (amount > balance) {
      throw conflict('You do not have enough balance.', 'INSUFFICIENT_BALANCE');
    }

    const row = await ReferralEntry.create({
      userId: req.user._id,
      type: 'PARTNER_REDEMPTION',
      amount: -round2(amount),
      ref: `redemption_req:${req.user._id}:${Date.now()}`,
      note: 'Earnings redemption request',
    });

    await RedemptionRequest.create({
      userId: req.user._id,
      amount: round2(amount),
      paymentDetails,
      status: 'PROCESSING',
      referralEntryId: row._id,
    });

    res.json({ success: true, balance: await referralBalance(req.user._id) });
  })
);

export default router;
