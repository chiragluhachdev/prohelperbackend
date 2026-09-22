import { Router } from 'express';
import { User, ReferralEntry, RedemptionRequest, Task } from '../models/index.js';
import { ROLES } from '../config.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { wrap, badRequest, conflict } from '../lib/http.js';
import { getSettings } from '../lib/settings.js';
import { ensureReferralCode, referralBalance, rewardFor } from '../lib/referral.js';
import { newTxnId } from '../lib/ledger.js';
import { upload, uploadBuffer } from '../lib/cloudinary.js';
import { publicUser } from './auth.js';

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
    
    res.json({ success: true, user: publicUser(req.user) });
  })
);

/**
 * POST /api/partner/profile/photo
 */
router.post(
  '/profile/photo',
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw badRequest('Choose a photo to upload.', 'FILE_REQUIRED');
    const result = await uploadBuffer(req.file.buffer, {
      folder: 'prohelper/partners',
      publicId: `partner_${req.user._id}`,
      resourceType: 'image',
    });
    req.user.photoUrl = result.secure_url;
    req.user.photoPublicId = result.public_id;
    await req.user.save();
    res.json({ success: true, user: publicUser(req.user) });
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

    /*
     * A partner is paid at their own rate, and signing up a helper can be
     * worth more than signing up a customer (UC-C34).
     */
    const rates = {
      customer: rewardFor(settings, ROLES.PARTNER, ROLES.CUSTOMER),
      helper: rewardFor(settings, ROLES.PARTNER, ROLES.HELPER),
    };
    const rateFor = (role) => (role === ROLES.HELPER ? rates.helper : rates.customer);
    // What each referral really paid, so changing the rate never rewrites history.
    const paidFor = new Map(
      ledger.filter((r) => r.type === 'REFERRER_REWARD' && r.counterpartyId)
        .map((r) => [String(r.counterpartyId._id || r.counterpartyId), round2(r.amount)]),
    );

    const sum = (types) => round2(ledger.filter((r) => types.includes(r.type)).reduce((t, r) => t + r.amount, 0));
    const earned = sum(['REFERRER_REWARD', 'WELCOME_REWARD']);
    const redeemed = round2(-sum(['BOOKING_REDEMPTION', 'DUES_SETTLEMENT', 'BOOKING_REFUND', 'PARTNER_REDEMPTION']));
    
    // Total pending from referred users who haven't completed a booking
    const pending = referredUsers.filter((u) => !u.referralRewardEarned);
    const pendingReferrals = pending.length;
    const pendingRewards = round2(pending.reduce((sum, u) => sum + rateFor(u.role), 0));

    res.json({
      code,
      enabled: Boolean(settings.referral_enabled),
      rates,
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
        reward: u.referralRewardEarned ? paidFor.get(String(u._id)) ?? rateFor(u.role) : 0,
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
      txnId: newTxnId(),
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
