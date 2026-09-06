import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { User, HelperProfile, Address, HelperDocument } from '../models/index.js';
import { JWT_SECRET, ROLES, HELPER_APPROVAL } from '../config.js';
import { issueOtp, verifyOtp } from '../lib/otp.js';
import { signToken, verifyPassword, authenticate } from '../lib/auth.js';
import { wrap, badRequest, unauthorized, forbidden } from '../lib/http.js';

const router = Router();

const PHONE_RE = /^[6-9]\d{9}$/;
const normalisePhone = (raw) => String(raw || '').replace(/[^\d]/g, '').slice(-10);

/** POST /api/auth/otp/request — step 1 of every customer/helper sign-in. */
router.post(
  '/otp/request',
  wrap(async (req, res) => {
    const phone = normalisePhone(req.body.phone);
    if (!PHONE_RE.test(phone)) throw badRequest('Enter a valid 10-digit mobile number.', 'INVALID_PHONE');

    const blocked = await User.findOne({ phone, status: 'blocked' }).lean();
    if (blocked) throw forbidden(blocked.blockReason || 'This number has been blocked. Please contact support.');

    const result = await issueOtp(phone);
    res.json({ phone, ...result });
  }),
);

/**
 * POST /api/auth/otp/verify — step 2. Does not sign you in on its own: it
 * returns a short-lived ticket plus the roles this number already holds, so the
 * app can show "I'm a Customer / I'm a Helper" and then exchange it.
 */
router.post(
  '/otp/verify',
  wrap(async (req, res) => {
    const phone = normalisePhone(req.body.phone);
    const { code } = req.body;
    if (!PHONE_RE.test(phone)) throw badRequest('Enter a valid 10-digit mobile number.', 'INVALID_PHONE');
    if (!code) throw badRequest('Enter the OTP.', 'OTP_REQUIRED');

    await verifyOtp(phone, code);

    const accounts = await User.find({ phone, role: { $in: [ROLES.CUSTOMER, ROLES.HELPER] } })
      .select('role name status')
      .lean();

    const verificationToken = jwt.sign({ phone, purpose: 'role-select' }, JWT_SECRET, { expiresIn: '10m' });
    res.json({
      verified: true,
      phone,
      verificationToken,
      accounts: accounts.map((a) => ({ role: a.role, name: a.name, status: a.status })),
    });
  }),
);

/** POST /api/auth/session — exchange the ticket for a real session in one role. */
router.post(
  '/session',
  wrap(async (req, res) => {
    const { verificationToken, role } = req.body;
    if (![ROLES.CUSTOMER, ROLES.HELPER].includes(role)) {
      throw badRequest('Choose whether you are a customer or a helper.', 'INVALID_ROLE');
    }

    let payload;
    try {
      payload = jwt.verify(verificationToken, JWT_SECRET);
    } catch {
      throw unauthorized('Verification expired. Please request a new OTP.');
    }
    if (payload.purpose !== 'role-select') throw unauthorized('Invalid verification token.');

    const phone = payload.phone;
    let user = await User.findOne({ phone, role });
    let isNew = false;

    if (!user) {
      user = await User.create({ phone, role, name: '' });
      isNew = true;
      if (role === ROLES.HELPER) {
        await HelperProfile.create({ userId: user._id, approvalStatus: HELPER_APPROVAL.DRAFT });
      }
    }

    if (user.status === 'blocked') {
      throw forbidden(user.blockReason || 'This account has been blocked. Please contact support.');
    }

    user.lastLoginAt = new Date();
    await user.save();

    res.json({ token: signToken(user), isNew, user: publicUser(user) });
  }),
);

/** POST /api/auth/admin/login — the web dashboard only. Never OTP. */
router.post(
  '/admin/login',
  wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) throw badRequest('Enter your email and password.', 'MISSING_CREDENTIALS');

    const user = await User.findOne({ email, role: ROLES.ADMIN }).select('+passwordHash');
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw unauthorized('Incorrect email or password.');
    }
    if (user.status === 'blocked') throw forbidden('This admin account is disabled.');

    user.lastLoginAt = new Date();
    await user.save();
    res.json({ token: signToken(user), user: publicUser(user) });
  }),
);

/** GET /api/auth/me — whatever the app needs to decide which screen to show. */
router.get(
  '/me',
  authenticate,
  wrap(async (req, res) => {
    const user = req.user;
    const body = { user: publicUser(user) };

    if (user.role === ROLES.CUSTOMER) {
      const addresses = await Address.find({ userId: user._id, active: true }).sort({ isDefault: -1 }).lean();
      body.addresses = addresses;
      body.profileComplete = Boolean(user.name && addresses.length);
    }

    if (user.role === ROLES.HELPER) {
      const profile = await HelperProfile.findOne({ userId: user._id });
      const docCount = await HelperDocument.countDocuments({ helperId: user._id });
      body.profile = profile ? profile.toObject() : null;
      body.checklist = profile ? profile.checklist(docCount) : null;
      body.documentCount = docCount;
    }

    res.json(body);
  }),
);

export function publicUser(user) {
  return {
    id: String(user._id),
    phone: user.phone,
    role: user.role,
    name: user.name,
    email: user.email,
    photoUrl: user.photoUrl,
    status: user.status,
    createdAt: user.createdAt,
  };
}

export default router;
