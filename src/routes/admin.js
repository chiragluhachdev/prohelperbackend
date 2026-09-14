import mongoose from 'mongoose';
import { Router } from 'express';
import {
  Address, AuditLog, HelperDocument, HelperProfile, JobRequest,
  LedgerEntry, Rating, ReferralEntry, Service, Task, TaskEvent, User, Category
} from '../models/index.js';
import { ROLES, TASK_STATUS, HELPER_APPROVAL, BUSINESS_TZ, dayKey } from '../config.js';
import { authenticate, requireAdmin } from '../lib/auth.js';
import { wrap, badRequest, notFound, conflict } from '../lib/http.js';
import { serializeTask, STATUS_LABELS, jobsLabel, DEFAULT_JOBS_SHOWN } from '../lib/views.js';
import { getSettings, updateSettings } from '../lib/settings.js';
import { closeJobAlerts, notify } from '../lib/notify.js';
import { audit } from '../lib/audit.js';
import { mustTransition } from '../lib/taskflow.js';
import { DUES_MATCH, PAYOUT_MATCH, PAYOUT_STAGES, SIGNED_DUES, openPayoutEntries } from '../lib/wallet.js';
import { ensureReferralCode, referralBalance } from '../lib/referral.js';
import { SOCIETIES } from '../constants/societies.js';

const router = Router();
router.use(authenticate, requireAdmin);

/** The referral facts support needs on a customer or helper page. */
async function referralSummary(user) {
  const [code, balance, referrals, referredBy] = await Promise.all([
    ensureReferralCode(user),
    referralBalance(user._id),
    ReferralEntry.countDocuments({ userId: user._id, type: 'REFERRER_REWARD' }),
    user.referredBy ? User.findById(user.referredBy).select('name phone role').lean() : null,
  ]);
  return {
    code, balance, referrals,
    referredBy: referredBy
      ? { id: String(referredBy._id), name: referredBy.name, phone: referredBy.phone, role: referredBy.role }
      : null,
  };
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const search = (q, fields) =>
  q ? { $or: fields.map((f) => ({ [f]: { $regex: escapeRegex(q), $options: 'i' } })) } : {};

/* ------------------------------------------------------------ list filters */

/**
 * `from` / `to` are ISO timestamps the dashboard computes from the admin's own
 * calendar day, so "today" means their today. Either end may be left open.
 */
function dateRange(query, field) {
  const range = {};
  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;
  if (from && !Number.isNaN(from.getTime())) range.$gte = from;
  if (to && !Number.isNaN(to.getTime())) range.$lte = to;
  return Object.keys(range).length ? { [field]: range } : {};
}

/** `page` is 1-based; `limit` is capped so a list can never pull the whole collection. */
function pageOf(query, fallback = 50) {
  const limit = Math.min(Math.max(Number(query.limit) || fallback, 1), 200);
  const page = Math.max(Number(query.page) || 1, 1);
  return { page, limit, skip: (page - 1) * limit };
}

const paged = (total, { page, limit }) => ({ total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });

/** `status=A,B` — one status or a group of them. */
const statusList = (value) => String(value || '').split(',').map((v) => v.trim()).filter(Boolean);

/** Users whose name or phone matches — to search bookings by the people on them. */
async function userIdsMatching(q, role) {
  if (!q) return [];
  const users = await User.find({ ...(role ? { role } : {}), ...search(q, ['name', 'phone']) }).select('_id').limit(500).lean();
  return users.map((u) => u._id);
}

/** GET /api/admin/filter-options — what the dashboard's filter dropdowns offer. */
router.get(
  '/filter-options',
  wrap(async (_req, res) => {
    const [services, categories, actions, entities] = await Promise.all([
      Service.find().select('code name active category').sort({ sortOrder: 1, name: 1 }).lean(),
      Category.find().select('name').sort({ sortOrder: 1 }).lean(),
      AuditLog.distinct('action'),
      AuditLog.distinct('entity'),
    ]);
    res.json({
      services: services.map((sv) => ({ code: sv.code, name: sv.name, active: sv.active, category: sv.category })),
      categories: categories.map((c) => ({ id: String(c._id), name: c.name })),
      societies: SOCIETIES.map((so) => ({ code: so.code, name: so.name })),
      auditActions: actions.sort(),
      auditEntities: entities.filter(Boolean).sort(),
    });
  }),
);

/* ---------------------------------------------------------------- dashboard */

/** GET /api/admin/dashboard — UC-C39. */
router.get(
  '/dashboard',
  wrap(async (_req, res) => {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay); endOfDay.setDate(endOfDay.getDate() + 1);

    // Midnight seven days ago, so "the last 7 days" means seven whole days.
    const weekStart = new Date(Date.now() - 8 * 86_400_000);

    const [
      customers, helpers, pendingApprovals, activeHelpers, onlineHelpers,
      todayBookings, activeTasks, completedTasks, cancelledTasks, noHelperTasks,
      blockedAccounts, revenueAgg, commissionAgg, recentTasks, pendingHelpers,
      trendAgg,
    ] = await Promise.all([
      User.countDocuments({ role: ROLES.CUSTOMER }),
      User.countDocuments({ role: ROLES.HELPER }),
      HelperProfile.countDocuments({ approvalStatus: HELPER_APPROVAL.PENDING_VERIFICATION }),
      HelperProfile.countDocuments({ approvalStatus: HELPER_APPROVAL.APPROVED }),
      HelperProfile.countDocuments({ approvalStatus: HELPER_APPROVAL.APPROVED, isOnline: true }),
      Task.countDocuments({ createdAt: { $gte: startOfDay, $lt: endOfDay } }),
      Task.countDocuments({ status: { $in: [TASK_STATUS.SEARCHING, TASK_STATUS.ACCEPTED, TASK_STATUS.IN_PROGRESS, TASK_STATUS.COMPLETION_PENDING] } }),
      Task.countDocuments({ status: { $in: [TASK_STATUS.COMPLETED, TASK_STATUS.SETTLED] } }),
      Task.countDocuments({ status: TASK_STATUS.CANCELLED }),
      Task.countDocuments({ status: TASK_STATUS.NO_HELPER_AVAILABLE }),
      User.countDocuments({ status: 'blocked' }),
      Task.aggregate([
        { $match: { status: { $in: [TASK_STATUS.COMPLETED, TASK_STATUS.SETTLED] } } },
        { $group: { _id: null, total: { $sum: '$pricing.total' } } },
      ]),
      LedgerEntry.aggregate([
        { $match: DUES_MATCH },
        { $group: { _id: null, total: { $sum: SIGNED_DUES } } },
      ]),
      Task.find()
        .populate('customerId', 'name phone')
        .populate('helperId', 'name phone')
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      HelperProfile.find({ approvalStatus: HELPER_APPROVAL.PENDING_VERIFICATION })
        .populate('userId', 'name phone photoUrl createdAt')
        .sort({ submittedAt: 1 })
        .limit(6)
        .lean(),
      /* Bookings per day for the last week. Grouped in the database rather
         than by pulling every task back and counting them here. */
      Task.aggregate([
        { $match: { createdAt: { $gte: weekStart } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: BUSINESS_TZ } },
            bookings: { $sum: 1 },
            completed: {
              $sum: { $cond: [{ $in: ['$status', [TASK_STATUS.COMPLETED, TASK_STATUS.SETTLED]] }, 1, 0] },
            },
            revenue: {
              $sum: {
                $cond: [
                  { $in: ['$status', [TASK_STATUS.COMPLETED, TASK_STATUS.SETTLED]] },
                  '$pricing.total',
                  0,
                ],
              },
            },
          },
        },
      ]),
    ]);

    // Days with no bookings still need a bar, or the chart lies about the shape.
    // Keys walk back from now in the same zone the database grouped in.
    const byDay = new Map(trendAgg.map((d) => [d._id, d]));
    const trend = [];
    for (let i = 6; i >= 0; i -= 1) {
      const key = dayKey(new Date(Date.now() - i * 86_400_000));
      const row = byDay.get(key);
      trend.push({
        date: key,
        bookings: row?.bookings || 0,
        completed: row?.completed || 0,
        revenue: Math.round((row?.revenue || 0) * 100) / 100,
      });
    }

    res.json({
      stats: {
        customers, helpers, pendingApprovals, activeHelpers, onlineHelpers,
        todayBookings, activeTasks, completedTasks, cancelledTasks, noHelperTasks,
        blockedAccounts,
        revenue: Math.round((revenueAgg[0]?.total || 0) * 100) / 100,
        outstandingCommission: Math.round((commissionAgg[0]?.total || 0) * 100) / 100,
      },
      trend,
      recentTasks: recentTasks.map(adminTask),
      pendingHelpers: pendingHelpers.map((p) => ({
        id: String(p.userId?._id),
        name: p.userId?.name || 'Unnamed',
        phone: p.userId?.phone,
        photoUrl: p.userId?.photoUrl,
        submittedAt: p.submittedAt,
        services: p.services,
        kycStatus: p.kycStatus,
      })),
    });
  }),
);

function adminTask(t) {
  return {
    id: String(t._id),
    code: t.code,
    status: t.status,
    statusLabel: STATUS_LABELS[t.status] || t.status,
    services: (t.services || []).map((s) => s.name),
    total: t.pricing?.total ?? 0,
    bookingType: t.bookingType || 'scheduled',
    scheduledAt: t.scheduledAt,
    createdAt: t.createdAt,
    customer: t.customerId ? { id: String(t.customerId._id), name: t.customerId.name, phone: t.customerId.phone } : null,
    helper: t.helperId ? { id: String(t.helperId._id), name: t.helperId.name, phone: t.helperId.phone } : null,
    area: t.address?.label || t.address?.city || '',
  };
}

/* ------------------------------------------------------------------ helpers */

/** GET /api/admin/helpers?status=PENDING_VERIFICATION&q= */
router.get(
  '/helpers',
  wrap(async (req, res) => {
    const { status, q, online, account, kyc, service, society, sort = 'newest' } = req.query;
    const userFilter = { role: ROLES.HELPER, ...search(q, ['name', 'phone']), ...dateRange(req.query, 'createdAt') };
    if (account === 'active' || account === 'blocked') userFilter.status = account;
    const users = await User.find(userFilter).sort({ createdAt: -1 }).limit(5000).lean();

    // Every filter except verification status, so the tab counts show what each tab would hold.
    const profileFilter = { userId: { $in: users.map((u) => u._id) } };
    if (online === 'online') profileFilter.isOnline = true;
    if (online === 'offline') profileFilter.isOnline = { $ne: true };
    if (kyc) profileFilter.kycStatus = kyc;
    if (service) profileFilter.services = service;
    if (society) profileFilter.societies = society;
    const profiles = await HelperProfile.find(profileFilter).lean();
    const byUser = new Map(profiles.map((p) => [String(p.userId), p]));

    const counts = { DRAFT: 0, PENDING_VERIFICATION: 0, APPROVED: 0, REJECTED: 0 };
    for (const p of profiles) counts[p.approvalStatus] = (counts[p.approvalStatus] || 0) + 1;

    const rows = users
      .filter((u) => byUser.has(String(u._id)) && (!status || byUser.get(String(u._id)).approvalStatus === status))
      .map((u) => {
        const p = byUser.get(String(u._id));
        return {
          id: String(u._id),
          name: u.name || 'Unnamed',
          phone: u.phone,
          photoUrl: u.photoUrl,
          accountStatus: u.status,
          approvalStatus: p.approvalStatus,
          kycStatus: p.kycStatus,
          services: p.services,
          serviceArea: p.serviceArea,
          isOnline: p.isOnline,
          rating: p.ratingAvg,
          ratingCount: p.ratingCount,
          completedJobs: p.completedJobs,
          jobsShown: p.jobsShown ?? DEFAULT_JOBS_SHOWN,
          jobsLabel: jobsLabel(p),
          submittedAt: p.submittedAt,
          createdAt: u.createdAt,
        };
      });

    const sorters = {
      newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
      oldest: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
      rating: (a, b) => (b.rating || 0) - (a.rating || 0) || (b.ratingCount || 0) - (a.ratingCount || 0),
      jobs: (a, b) => (b.completedJobs || 0) - (a.completedJobs || 0),
      name: (a, b) => String(a.name).localeCompare(String(b.name)),
      submitted: (a, b) => new Date(a.submittedAt || 8.64e15) - new Date(b.submittedAt || 8.64e15),
    };
    rows.sort(sorters[sort] || sorters.newest);

    const pg = pageOf(req.query, 50);
    res.json({ helpers: rows.slice(pg.skip, pg.skip + pg.limit), counts, ...paged(rows.length, pg) });
  }),
);

async function helperCounts() {
  const rows = await HelperProfile.aggregate([{ $group: { _id: '$approvalStatus', n: { $sum: 1 } } }]);
  const counts = { DRAFT: 0, PENDING_VERIFICATION: 0, APPROVED: 0, REJECTED: 0 };
  for (const r of rows) counts[r._id] = r.n;
  return counts;
}

/** GET /api/admin/helpers/:id — profile, documents, KYC and history in one call. */
router.get(
  '/helpers/:id',
  wrap(async (req, res) => {
    const user = await User.findOne({ _id: req.params.id, role: ROLES.HELPER }).lean();
    if (!user) throw notFound('Helper not found.');

    const [profile, documents, tasks, ratings, ledger] = await Promise.all([
      HelperProfile.findOne({ userId: user._id }).lean(),
      HelperDocument.find({ helperId: user._id }).sort({ createdAt: -1 }).lean(),
      Task.find({ helperId: user._id }).populate('customerId', 'name phone').sort({ createdAt: -1 }).limit(20).lean(),
      Rating.find({ toUserId: user._id })
        .populate('fromUserId', 'name role')
        .populate('taskId', 'shortId')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      LedgerEntry.aggregate([
        { $match: { userId: user._id } },
        { $group: { _id: '$type', total: { $sum: '$amount' } } },
      ]),
    ]);

    res.json({
      helper: {
        id: String(user._id),
        name: user.name, phone: user.phone, email: user.email,
        previousPhones: user.previousPhones || [],
        photoUrl: user.photoUrl, accountStatus: user.status,
        blockReason: user.blockReason, createdAt: user.createdAt,
        referral: await referralSummary(user),
      },
      profile,
      documents,
      tasks: tasks.map(adminTask),
      ratings,
      earnings: Object.fromEntries(ledger.map((l) => [l._id, Math.round(l.total * 100) / 100])),
    });
  }),
);

/**
 * PATCH /api/admin/helpers/:id/profile — the figures customers see on a helper:
 * years of experience, and the job count shown alongside their name.
 *
 * The real completed-jobs counter is deliberately not editable here: earnings
 * and reporting depend on it matching the bookings that actually happened.
 */
router.patch(
  '/helpers/:id/profile',
  wrap(async (req, res) => {
    const profile = await HelperProfile.findOne({ userId: req.params.id });
    if (!profile) throw notFound('Helper not found.');

    const before = { experienceYears: profile.experienceYears, jobsShown: profile.jobsShown };

    if (req.body.experienceYears !== undefined) {
      const years = Number(req.body.experienceYears);
      if (!Number.isFinite(years) || years < 0 || years > 60) {
        throw badRequest('Experience must be between 0 and 60 years.', 'INVALID_EXPERIENCE');
      }
      profile.experienceYears = Math.round(years * 2) / 2; // half-years are fine
    }
    if (req.body.jobsShown !== undefined) {
      const jobs = Number(req.body.jobsShown);
      if (!Number.isInteger(jobs) || jobs < 0 || jobs > 100000) {
        throw badRequest('Jobs shown must be a whole number, 0 or more.', 'INVALID_JOBS');
      }
      profile.jobsShown = jobs;
    }
    await profile.save();

    await audit(req, {
      action: 'HELPER_PROFILE_EDITED',
      entity: 'HelperProfile',
      entityId: profile.userId,
      before,
      after: { experienceYears: profile.experienceYears, jobsShown: profile.jobsShown },
      reason: req.body.reason || '',
    });

    res.json({
      profile: {
        experienceYears: profile.experienceYears,
        jobsShown: profile.jobsShown,
        completedJobs: profile.completedJobs,
        jobsLabel: jobsLabel(profile),
      },
    });
  }),
);

/** POST /api/admin/helpers/:id/approve — UC-C25. This is the gate to receiving jobs. */
router.post(
  '/helpers/:id/approve',
  wrap(async (req, res) => {
    const profile = await HelperProfile.findOne({ userId: req.params.id });
    if (!profile) throw notFound('Helper not found.');
    if (profile.approvalStatus === HELPER_APPROVAL.APPROVED) {
      throw conflict('This helper is already approved.', 'ALREADY_APPROVED');
    }

    const before = { approvalStatus: profile.approvalStatus };
    profile.approvalStatus = HELPER_APPROVAL.APPROVED;
    profile.rejectionReason = '';
    profile.reviewedAt = new Date();
    profile.reviewedBy = req.user._id;
    await profile.save();

    await HelperDocument.updateMany(
      { helperId: profile.userId, status: 'PENDING' },
      { $set: { status: 'APPROVED', reviewedAt: new Date(), reviewedBy: req.user._id } },
    );

    await notify(profile.userId, 'ACCOUNT_APPROVED', 'You are approved 🎉',
      'Your profile has been verified. Go online to start receiving jobs.');
    await audit(req, {
      action: 'HELPER_APPROVED', entity: 'HelperProfile', entityId: profile.userId,
      before, after: { approvalStatus: profile.approvalStatus }, reason: req.body.reason || '',
    });

    res.json({ profile: profile.toObject() });
  }),
);

router.post(
  '/helpers/:id/reject',
  wrap(async (req, res) => {
    const reason = String(req.body.reason || '').trim();
    if (!reason) throw badRequest('Give a reason so the helper knows what to fix.', 'REASON_REQUIRED');

    const profile = await HelperProfile.findOne({ userId: req.params.id });
    if (!profile) throw notFound('Helper not found.');

    const before = { approvalStatus: profile.approvalStatus };
    profile.approvalStatus = HELPER_APPROVAL.REJECTED;
    profile.rejectionReason = reason;
    profile.reviewedAt = new Date();
    profile.reviewedBy = req.user._id;
    profile.isOnline = false;
    await profile.save();

    await notify(profile.userId, 'ACCOUNT_REJECTED', 'Verification needs attention', reason, { reason });
    await audit(req, {
      action: 'HELPER_REJECTED', entity: 'HelperProfile', entityId: profile.userId,
      before, after: { approvalStatus: profile.approvalStatus }, reason,
    });

    res.json({ profile: profile.toObject() });
  }),
);

/** Approve or reject a single document, with a remark the helper can act on. */
router.post(
  '/documents/:id/review',
  wrap(async (req, res) => {
    const { status, remark = '' } = req.body;
    if (!['APPROVED', 'REJECTED'].includes(status)) throw badRequest('Status must be APPROVED or REJECTED.', 'INVALID_STATUS');

    const doc = await HelperDocument.findById(req.params.id);
    if (!doc) throw notFound('Document not found.');

    const before = { status: doc.status };
    doc.status = status;
    doc.remark = remark;
    doc.reviewedAt = new Date();
    doc.reviewedBy = req.user._id;
    await doc.save();

    await notify(doc.helperId, 'DOCUMENT_REVIEWED', `Document ${status.toLowerCase()}`,
      remark || `Your ${doc.type.replace(/_/g, ' ')} was ${status.toLowerCase()}.`,
      { status, docType: doc.type, remark: remark || '' });
    await audit(req, {
      action: 'DOCUMENT_REVIEWED', entity: 'HelperDocument', entityId: doc._id,
      before, after: { status }, reason: remark,
    });

    res.json({ document: doc });
  }),
);

/* ---------------------------------------------------------------- customers */

router.get(
  '/customers',
  wrap(async (req, res) => {
    const { status, has, sort = 'newest' } = req.query;
    const users = await User.find({
      role: ROLES.CUSTOMER, ...search(req.query.q, ['name', 'phone']), ...dateRange(req.query, 'createdAt'),
    })
      .sort({ createdAt: -1 })
      .limit(5000)
      .lean();

    const totals = await Task.aggregate([
      { $match: { customerId: { $in: users.map((u) => u._id) } } },
      {
        $group: {
          _id: '$customerId',
          n: { $sum: 1 },
          // Spend is what completed bookings cost — a cancelled one was never paid for.
          spend: { $sum: { $cond: [{ $in: ['$status', [TASK_STATUS.COMPLETED, TASK_STATUS.SETTLED]] }, '$pricing.total', 0] } },
          lastBookingAt: { $max: '$createdAt' },
        },
      },
    ]);
    const byUser = new Map(totals.map((c) => [String(c._id), c]));

    let rows = users.map((u) => ({
      id: String(u._id),
      name: u.name || 'Unnamed',
      phone: u.phone,
      photoUrl: u.photoUrl,
      accountStatus: u.status,
      createdAt: u.createdAt,
      bookings: byUser.get(String(u._id))?.n || 0,
      spend: Math.round((byUser.get(String(u._id))?.spend || 0) * 100) / 100,
      lastBookingAt: byUser.get(String(u._id))?.lastBookingAt || null,
    }));
    if (has === 'booked') rows = rows.filter((r) => r.bookings > 0);
    if (has === 'never') rows = rows.filter((r) => r.bookings === 0);

    const counts = {
      all: rows.length,
      active: rows.filter((r) => r.accountStatus === 'active').length,
      blocked: rows.filter((r) => r.accountStatus === 'blocked').length,
    };
    if (status === 'active' || status === 'blocked') rows = rows.filter((r) => r.accountStatus === status);

    const sorters = {
      newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
      oldest: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
      bookings: (a, b) => b.bookings - a.bookings,
      spend: (a, b) => b.spend - a.spend,
      recent: (a, b) => new Date(b.lastBookingAt || 0) - new Date(a.lastBookingAt || 0),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    rows.sort(sorters[sort] || sorters.newest);

    const pg = pageOf(req.query, 50);
    res.json({ customers: rows.slice(pg.skip, pg.skip + pg.limit), counts, ...paged(rows.length, pg) });
  }),
);

router.get(
  '/customers/:id',
  wrap(async (req, res) => {
    const user = await User.findOne({ _id: req.params.id, role: ROLES.CUSTOMER }).lean();
    if (!user) throw notFound('Customer not found.');

    const [addresses, tasks, ratings] = await Promise.all([
      Address.find({ userId: user._id, active: true }).lean(),
      Task.find({ customerId: user._id }).populate('helperId', 'name phone').sort({ createdAt: -1 }).limit(20).lean(),
      Rating.find({ toUserId: user._id })
        .populate('fromUserId', 'name role')
        .populate('taskId', 'shortId')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
    ]);

    res.json({
      customer: {
        id: String(user._id), name: user.name, phone: user.phone, email: user.email,
        previousPhones: user.previousPhones || [],
        photoUrl: user.photoUrl, accountStatus: user.status, blockReason: user.blockReason,
        createdAt: user.createdAt,
        referral: await referralSummary(user),
      },
      addresses,
      tasks: tasks.map(adminTask),
      ratings,
    });
  }),
);

/* ------------------------------------------------------ block / unblock ⛔ */

router.post(
  '/users/:id/block',
  wrap(async (req, res) => {
    const reason = String(req.body.reason || '').trim();
    if (!reason) throw badRequest('Give a reason for blocking.', 'REASON_REQUIRED');

    const user = await User.findById(req.params.id);
    if (!user) throw notFound('User not found.');
    if (user.role === ROLES.ADMIN) throw badRequest('Admin accounts cannot be blocked here.', 'CANNOT_BLOCK_ADMIN');

    const before = { status: user.status };
    user.status = 'blocked';
    user.blockReason = reason;
    user.blockedAt = new Date();
    await user.save();

    // A blocked helper must stop receiving work immediately (UC-C23).
    if (user.role === ROLES.HELPER) {
      await HelperProfile.updateOne({ userId: user._id }, { $set: { isOnline: false } });
      await JobRequest.updateMany({ helperId: user._id, status: 'SENT' }, { $set: { status: 'CANCELLED' } });
    }

    await notify(user._id, 'ACCOUNT_BLOCKED', 'Account blocked', reason, { reason });
    await audit(req, { action: 'USER_BLOCKED', entity: 'User', entityId: user._id, before, after: { status: 'blocked' }, reason });

    res.json({ ok: true, status: user.status });
  }),
);

router.post(
  '/users/:id/unblock',
  wrap(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw notFound('User not found.');

    const before = { status: user.status };
    user.status = 'active';
    user.blockReason = '';
    user.blockedAt = undefined;
    user.rejectionCount = 0;
    await user.save();

    await notify(user._id, 'ACCOUNT_UNBLOCKED', 'Account restored', 'Your account is active again.');
    await audit(req, { action: 'USER_UNBLOCKED', entity: 'User', entityId: user._id, before, after: { status: 'active' }, reason: req.body.reason || '' });

    res.json({ ok: true, status: user.status });
  }),
);

/* ----------------------------------------------------------------- bookings */

router.get(
  '/bookings',
  wrap(async (req, res) => {
    const { q, type, service, payment, society, dateField, sort = 'newest' } = req.query;

    // Everything but status, so each status tab can show how many it would hold.
    const base = { ...dateRange(req.query, dateField === 'scheduled' ? 'scheduledAt' : 'createdAt') };
    if (q) {
      const people = await userIdsMatching(q);
      base.$or = [
        { code: { $regex: escapeRegex(q), $options: 'i' } },
        ...(people.length ? [{ customerId: { $in: people } }, { helperId: { $in: people } }] : []),
      ];
    }
    if (type === 'instant' || type === 'scheduled') base.bookingType = type;
    if (service) base['services.code'] = service;
    if (society) base['address.society'] = society;
    // One person's bookings — ids cast here, since the count aggregation does not cast for us.
    for (const [param, field] of [['customer', 'customerId'], ['helper', 'helperId']]) {
      const id = req.query[param];
      if (id) base[field] = mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(String(id)) : null;
    }
    if (payment === 'paid') base.paymentStatus = 'PAID';
    if (payment === 'awaiting') Object.assign(base, { status: TASK_STATUS.COMPLETED, paymentStatus: { $ne: 'PAID' } });
    if (payment === 'online') base.paymentMode = 'ONLINE';
    if (payment === 'cash') base.paymentMode = 'CASH';
    if (payment === 'referral') base['pricing.referralCredit'] = { $gt: 0 };

    const statuses = statusList(req.query.status);
    const filter = { ...base };
    if (statuses.length) {
      filter.status = base.status ? (statuses.includes(base.status) ? base.status : '__none__') : { $in: statuses };
    }

    const sorts = {
      newest: { createdAt: -1 },
      oldest: { createdAt: 1 },
      scheduled: { scheduledAt: 1 },
      latestSlot: { scheduledAt: -1 },
      value: { 'pricing.total': -1 },
    };
    const pg = pageOf(req.query, 50);

    const [tasks, total, counts] = await Promise.all([
      Task.find(filter)
        .populate('customerId', 'name phone')
        .populate('helperId', 'name phone')
        .sort(sorts[sort] || sorts.newest)
        .skip(pg.skip)
        .limit(pg.limit)
        .lean(),
      Task.countDocuments(filter),
      Task.aggregate([{ $match: base }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);

    res.json({
      bookings: tasks.map(adminTask),
      counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
      ...paged(total, pg),
    });
  }),
);

/** Full monitoring view: timeline plus every helper who was alerted. */
router.get(
  '/bookings/:id',
  wrap(async (req, res) => {
    const task = await Task.findById(req.params.id)
      .populate('customerId', 'name phone photoUrl')
      .populate('helperId', 'name phone photoUrl');
    if (!task) throw notFound('Booking not found.');

    const [timeline, requests, ratings, ledger] = await Promise.all([
      TaskEvent.find({ taskId: task._id }).sort({ at: 1 }).lean(),
      JobRequest.find({ taskId: task._id }).populate('helperId', 'name phone').sort({ round: 1, sentAt: 1 }).lean(),
      Rating.find({ taskId: task._id }).lean(),
      LedgerEntry.find({ taskId: task._id, type: { $in: ['JOB_EARNING', 'PLATFORM_COMMISSION'] } }).lean(),
    ]);
    const owedByHelper = ledger.find((l) => l.type === 'PLATFORM_COMMISSION');
    const payoutToHelper = ledger.find((l) => l.type === 'JOB_EARNING');

    res.json({
      task: {
        ...serializeTask(task, { audience: 'customer' }),
        customer: task.customerId
          ? { id: String(task.customerId._id), name: task.customerId.name, phone: task.customerId.phone }
          : null,
        owedByHelper: owedByHelper ? { amount: round(owedByHelper.amount), settled: owedByHelper.settled } : null,
        // A cash job has an earning row too, but nothing is owed to the helper for it.
        payoutToHelper: payoutToHelper && task.paymentMode === 'ONLINE'
          ? { amount: round(payoutToHelper.amount), settled: payoutToHelper.settled }
          : null,
      },
      timeline,
      requests: requests.map((r) => ({
        id: String(r._id),
        round: r.round,
        status: r.status,
        distanceKm: r.distanceKm,
        sentAt: r.sentAt,
        expiresAt: r.expiresAt,
        respondedAt: r.respondedAt,
        helper: r.helperId ? { id: String(r.helperId._id), name: r.helperId.name, phone: r.helperId.phone } : null,
      })),
      ratings,
    });
  }),
);

/** UC-C22 — admin cancellation, always with a reason on the record. */
router.post(
  '/bookings/:id/cancel',
  wrap(async (req, res) => {
    const reason = String(req.body.reason || '').trim();
    if (!reason) throw badRequest('Give a reason for cancelling.', 'REASON_REQUIRED');

    const task = await Task.findById(req.params.id);
    if (!task) throw notFound('Booking not found.');

    const cancellable = [TASK_STATUS.CREATED, TASK_STATUS.SEARCHING, TASK_STATUS.ACCEPTED, TASK_STATUS.IN_PROGRESS];
    if (!cancellable.includes(task.status)) throw conflict('This booking can no longer be cancelled.', 'NOT_CANCELLABLE');

    const updated = await mustTransition(task._id, cancellable, TASK_STATUS.CANCELLED, {
      set: {
        nextDispatchAt: null,
        cancellation: { by: 'admin', byUserId: req.user._id, reason, previousStatus: task.status, at: new Date() },
      },
      actorType: 'admin', actorId: req.user._id, reason,
    });

    await JobRequest.updateMany({ taskId: task._id, status: 'SENT' }, { $set: { status: 'CANCELLED' } });
    await closeJobAlerts(task._id);
    const cancelData = { taskId: String(updated._id), code: updated.code, reason, by: 'admin' };
    await notify(updated.customerId, 'BOOKING_CANCELLED', 'Booking cancelled', reason, cancelData);
    if (updated.helperId) await notify(updated.helperId, 'BOOKING_CANCELLED', 'Booking cancelled', reason, cancelData);
    await audit(req, { action: 'BOOKING_CANCELLED', entity: 'Task', entityId: task._id, before: { status: task.status }, after: { status: 'CANCELLED' }, reason });

    res.json({ task: serializeTask(updated) });
  }),
);

/* ------------------------------------------------------- services & settings */

router.get(
  '/services',
  wrap(async (_req, res) => {
    const services = await Service.find().sort({ sortOrder: 1 }).lean();
    res.json({ services });
  }),
);

/**
 * UC-C42 — services are data, not code. Everything the customer app renders for
 * a service (name, copy, price, duration) is edited here and picked up by the
 * apps on their next catalog fetch, with no release needed.
 */
router.patch(
  '/services/:code',
  wrap(async (req, res) => {
    const service = await Service.findOne({ code: req.params.code });
    if (!service) throw notFound('Service not found.');

    const before = {
      name: service.name, basePrice: service.basePrice, active: service.active,
      durationLabel: service.durationLabel, defaultDurationMins: service.defaultDurationMins,
      description: service.description, category: service.category, icon: service.icon,
      inclusions: service.inclusions, sortOrder: service.sortOrder,
      optionsEnabled: service.optionsEnabled, options: service.options,
    };

    if (req.body.name != null) {
      const name = String(req.body.name).trim();
      if (!name) throw badRequest('Name cannot be empty.', 'NAME_REQUIRED');
      service.name = name;
    }
    if (req.body.basePrice != null) {
      const price = Number(req.body.basePrice);
      if (!Number.isFinite(price) || price < 0) throw badRequest('Price must be zero or more.', 'INVALID_PRICE');
      service.basePrice = Math.round(price * 100) / 100;
    }
    if (req.body.defaultDurationMins != null) {
      const mins = Number(req.body.defaultDurationMins);
      if (!Number.isFinite(mins) || mins <= 0) throw badRequest('Duration must be more than zero.', 'INVALID_DURATION');
      service.defaultDurationMins = Math.round(mins);
    }
    if (req.body.active != null) service.active = Boolean(req.body.active);
    if (req.body.description != null) service.description = String(req.body.description);
    if (req.body.durationLabel != null) service.durationLabel = String(req.body.durationLabel);
    if (req.body.category != null) service.category = String(req.body.category);
    if (req.body.icon != null) service.icon = String(req.body.icon);
    for (const field of ['nameHi', 'descriptionHi', 'durationLabelHi']) {
      if (req.body[field] != null) service[field] = String(req.body[field]).trim();
    }
    if (req.body.inclusionsHi != null) {
      const list = Array.isArray(req.body.inclusionsHi)
        ? req.body.inclusionsHi
        : String(req.body.inclusionsHi).split('\n');
      service.inclusionsHi = list.map((line) => String(line).trim()).filter(Boolean).slice(0, 12);
    }
    if (req.body.inclusions != null) {
      const list = Array.isArray(req.body.inclusions)
        ? req.body.inclusions
        : String(req.body.inclusions).split('\n');
      service.inclusions = list.map((line) => String(line).trim()).filter(Boolean).slice(0, 12);
    }
    if (req.body.sortOrder != null) service.sortOrder = Number(req.body.sortOrder) || 0;
    if (req.body.options != null) service.options = parseOptions(req.body.options);
    if (req.body.optionsEnabled != null) service.optionsEnabled = Boolean(req.body.optionsEnabled);

    /* Turning questions on with nothing to ask would show the customer an
       empty section, so say so rather than saving a broken state. */
    if (service.optionsEnabled && (service.options || []).length === 0) {
      throw badRequest('Add at least one question before switching them on.', 'NO_OPTIONS');
    }

    await service.save();

    await audit(req, {
      action: 'SERVICE_UPDATED',
      entity: 'Service',
      entityId: service.code,
      before,
      after: {
        name: service.name, basePrice: service.basePrice, active: service.active,
        durationLabel: service.durationLabel, defaultDurationMins: service.defaultDurationMins,
        description: service.description, category: service.category, icon: service.icon,
        sortOrder: service.sortOrder,
      },
      reason: req.body.reason || '',
    });
    res.json({ service });
  }),
);

/**
 * UC-C05 — the per-service questions are data. They are also the only thing in
 * the catalog that can change a bill, so they are validated here rather than
 * trusted: a bad key or a negative price would reach the quote engine.
 */
const OPTION_TYPES = ['number', 'text', 'select', 'boolean'];

/** "Extra Bathrooms!" -> "extra_bathrooms": no runs, no edges, no surprises. */
const slug = (raw) =>
  String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');

function parseOptions(raw) {
  if (!Array.isArray(raw)) throw badRequest('Options must be a list.', 'INVALID_OPTIONS');
  if (raw.length > 10) throw badRequest('Ten questions per service is plenty.', 'TOO_MANY_OPTIONS');

  const seen = new Set();
  return raw.map((o, i) => {
    const key = slug(o?.key);
    const label = String(o?.label || '').trim();
    const type = OPTION_TYPES.includes(o?.type) ? o.type : 'text';

    if (!key) throw badRequest(`Question ${i + 1} needs a key.`, 'OPTION_KEY_REQUIRED');
    if (!label) throw badRequest(`Question ${i + 1} needs a label.`, 'OPTION_LABEL_REQUIRED');
    if (seen.has(key)) throw badRequest(`Two questions share the key "${key}".`, 'DUPLICATE_OPTION_KEY');
    seen.add(key);

    const choices = type === 'select'
      ? (Array.isArray(o.choices) ? o.choices : String(o.choices || '').split(','))
          .map((c) => String(c).trim()).filter(Boolean)
      : [];
    if (type === 'select' && choices.length < 2) {
      throw badRequest(`"${label}" needs at least two choices.`, 'OPTION_CHOICES_REQUIRED');
    }

    const pricePerUnit = Number(o.pricePerUnit || 0);
    if (!Number.isFinite(pricePerUnit) || pricePerUnit < 0) {
      throw badRequest(`"${label}" has an invalid price.`, 'INVALID_OPTION_PRICE');
    }

    // The default has to be the shape the question asks for, or the quote
    // engine will do arithmetic on a string.
    let defaultValue = o.defaultValue;
    if (type === 'number') defaultValue = Number(defaultValue) || 0;
    else if (type === 'boolean') defaultValue = defaultValue === true || defaultValue === 'true';
    else if (type === 'select') defaultValue = choices.includes(defaultValue) ? defaultValue : choices[0];
    else defaultValue = defaultValue == null ? '' : String(defaultValue);

    return {
      key, label, type, choices,
      unit: String(o.unit || '').trim(),
      required: Boolean(o.required),
      defaultValue,
      pricePerUnit: Math.round(pricePerUnit * 100) / 100,
    };
  });
}

/** Add a service to the catalog. It appears in both apps immediately. */
router.post(
  '/services',
  wrap(async (req, res) => {
    const code = slug(req.body.code);
    const name = String(req.body.name || '').trim();
    const basePrice = Number(req.body.basePrice);

    if (!code) throw badRequest('Give the service a code.', 'CODE_REQUIRED');
    if (!name) throw badRequest('Give the service a name.', 'NAME_REQUIRED');
    if (!Number.isFinite(basePrice) || basePrice < 0) throw badRequest('Enter a valid price.', 'INVALID_PRICE');
    if (await Service.exists({ code })) throw conflict('A service with that code already exists.', 'DUPLICATE_CODE');

    const service = await Service.create({
      code, name, basePrice,
      category: req.body.category || 'Cleaning',
      description: req.body.description || '',
      icon: req.body.icon || '🧹',
      durationLabel: req.body.durationLabel || '1 - 2 hours',
      defaultDurationMins: Number(req.body.defaultDurationMins) || 90,
      sortOrder: Number(req.body.sortOrder) || 99,
      nameHi: String(req.body.nameHi || '').trim(),
      descriptionHi: String(req.body.descriptionHi || '').trim(),
      durationLabelHi: String(req.body.durationLabelHi || '').trim(),
      inclusionsHi: (Array.isArray(req.body.inclusionsHi) ? req.body.inclusionsHi : [])
        .map((line) => String(line).trim())
        .filter(Boolean)
        .slice(0, 12),
      inclusions: (Array.isArray(req.body.inclusions) ? req.body.inclusions : [])
        .map((line) => String(line).trim())
        .filter(Boolean)
        .slice(0, 12),
      active: true,
      options: [],
    });

    await audit(req, { action: 'SERVICE_CREATED', entity: 'Service', entityId: code, after: service.toObject() });
    res.status(201).json({ service });
  }),
);

/* ------------------------------------------------------------------ finance */

/**
 * GET /api/admin/finance — where the money is, from the ledger and the
 * bookings themselves rather than any running total.
 *
 * Two ways a job gets paid for, and they book very differently:
 *  - Online, in the app: the platform holds the money, so it owes the helper
 *    their payout — nothing is owed *by* the helper for that job.
 *  - Cash or UPI straight to the helper: the helper is holding the customer's
 *    entire bill, so they owe the platform everything beyond their own
 *    payout (the service fee plus their commission).
 */
router.get(
  '/finance',
  wrap(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (days - 1));

    const earned = { $in: [TASK_STATUS.COMPLETED, TASK_STATUS.SETTLED] };

    const [totals, byDay, ledgerByType, byMethod, owedByHelper, owedToHelper, recent, awaiting] = await Promise.all([
      Task.aggregate([
        { $match: { status: earned } },
        {
          $group: {
            _id: null,
            bookings: { $sum: 1 },
            gross: { $sum: '$pricing.total' },
            services: { $sum: '$pricing.servicesAmount' },
            platformFee: { $sum: '$pricing.platformFee' },
            commission: { $sum: '$pricing.helperCommission' },
            payout: { $sum: '$pricing.helperPayout' },
            referralCredit: { $sum: { $ifNull: ['$pricing.referralCredit', 0] } },
          },
        },
      ]),
      Task.aggregate([
        { $match: { status: earned, completedAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt', timezone: BUSINESS_TZ } },
            bookings: { $sum: 1 },
            gross: { $sum: '$pricing.total' },
            platformEarned: {
              $sum: {
                $subtract: [
                  { $add: ['$pricing.platformFee', '$pricing.helperCommission'] },
                  { $ifNull: ['$pricing.referralCredit', 0] },
                ],
              },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      LedgerEntry.aggregate([
        { $group: { _id: '$type', total: { $sum: '$amount' }, rows: { $sum: 1 } } },
      ]),
      Task.aggregate([
        { $match: { status: earned, paymentStatus: 'PAID' } },
        { $group: { _id: '$paymentMode', bookings: { $sum: 1 }, gross: { $sum: '$pricing.total' } } },
      ]),
      // Owed BY a helper: collected in cash, never passed on (unsettled).
      LedgerEntry.aggregate([
        { $match: DUES_MATCH },
        {
          $group: {
            _id: '$userId',
            total: { $sum: SIGNED_DUES },
            jobs: { $sum: { $cond: [{ $eq: ['$type', 'PLATFORM_COMMISSION'] }, 1, 0] } },
          },
        },
        { $match: { total: { $gt: 0.004 } } },
        { $sort: { total: -1 } },
        { $limit: 50 },
      ]),
      // Owed TO a helper: paid online, payout not yet sent out (unsettled).
      LedgerEntry.aggregate([
        { $match: PAYOUT_MATCH },
        ...PAYOUT_STAGES,
        { $group: { _id: '$userId', total: { $sum: '$amount' }, jobs: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 50 },
      ]),
      Task.find({ status: earned })
        .populate('customerId', 'name phone')
        .populate('helperId', 'name phone')
        .sort({ completedAt: -1 })
        .limit(40)
        .lean(),
      Task.countDocuments({ status: TASK_STATUS.COMPLETED, paymentStatus: { $ne: 'PAID' } }),
    ]);

    const helperIds = [...new Set([...owedByHelper, ...owedToHelper].map((o) => String(o._id)))];
    const [helperUsers, helperProfiles] = await Promise.all([
      User.find({ _id: { $in: helperIds } }).select('name phone').lean(),
      HelperProfile.find({ userId: { $in: helperIds } }).select('userId paymentDetails').lean(),
    ]);
    const nameById = new Map(helperUsers.map((u) => [String(u._id), u]));
    const payById = new Map(helperProfiles.map((p) => [String(p.userId), p.paymentDetails]));
    const toRow = (o) => ({
      helperId: String(o._id),
      name: nameById.get(String(o._id))?.name || 'Unknown',
      phone: nameById.get(String(o._id))?.phone || '',
      jobs: o.jobs,
      amount: round(o.total),
      paymentDetails: payById.get(String(o._id)) || null,
    });

    const t = totals[0] || {};
    const methodTotals = Object.fromEntries(byMethod.map((m) => [m._id || 'UNPAID', { bookings: m.bookings, gross: round(m.gross) }]));
    res.json({
      totals: {
        bookings: t.bookings || 0,
        gross: round(t.gross),
        services: round(t.services),
        platformFee: round(t.platformFee),
        commission: round(t.commission),
        helperPayout: round(t.payout),
        // Referral balance customers spent is paid for by the platform.
        referralCredit: round(t.referralCredit),
        platformEarned: round((t.platformFee || 0) + (t.commission || 0) - (t.referralCredit || 0)),
        awaitingPayment: awaiting,
        online: methodTotals.ONLINE || { bookings: 0, gross: 0 },
        cash: methodTotals.CASH || { bookings: 0, gross: 0 },
      },
      byDay: byDay.map((d) => ({
        date: d._id,
        bookings: d.bookings,
        gross: round(d.gross),
        platformEarned: round(d.platformEarned),
      })),
      ledger: Object.fromEntries(
        ledgerByType.map((l) => [l._id, { total: round(l.total), rows: l.rows }]),
      ),
      commissionOwed: owedByHelper.map(toRow),
      payoutsOwed: owedToHelper.map(toRow),
      bookings: recent.map((task) => ({
        id: String(task._id),
        code: task.code,
        completedAt: task.completedAt,
        settledAt: task.settledAt,
        paidAt: task.paidAt,
        paidByRole: task.paidByRole,
        paymentStatus: task.paymentStatus,
        paymentMode: task.paymentMode,
        customer: task.customerId?.name || '—',
        helper: task.helperId?.name || '—',
        services: (task.services || []).map((sv) => sv.name),
        pricing: task.pricing,
      })),
    });
  }),
);

const round = (n) => Math.round((n || 0) * 100) / 100;

/**
 * GET /api/admin/finance/transactions — every paid (or still-awaiting-payment)
 * booking, one row each, with enough on it to open straight into a detail
 * view without a second request.
 */
router.get(
  '/finance/transactions',
  wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const { status, method, q, helper } = req.query;

    const filter = {
      status: { $in: [TASK_STATUS.COMPLETED, TASK_STATUS.SETTLED] },
      ...dateRange(req.query, 'completedAt'),
    };
    if (helper) filter.helperId = helper;
    if (status === 'paid') filter.paymentStatus = 'PAID';
    else if (status === 'pending') filter.paymentStatus = { $ne: 'PAID' };
    if (method === 'online' || method === 'cash') filter.paymentMode = method.toUpperCase();
    if (method === 'referral') filter['pricing.referralCredit'] = { $gt: 0 };

    let taskIds;
    if (q) {
      const matches = await Promise.all([
        Task.find({ code: { $regex: escapeRegex(q), $options: 'i' } }).select('_id').lean(),
        User.find({ $or: [{ name: { $regex: escapeRegex(q), $options: 'i' } }, { phone: { $regex: escapeRegex(q), $options: 'i' } }] })
          .select('_id').lean(),
      ]);
      const userIds = matches[1].map((u) => u._id);
      taskIds = [...matches[0].map((t) => t._id)];
      if (userIds.length) {
        const byUser = await Task.find({ $or: [{ customerId: { $in: userIds } }, { helperId: { $in: userIds } }] })
          .select('_id').lean();
        taskIds.push(...byUser.map((t) => t._id));
      }
      filter._id = { $in: taskIds };
    }

    const [rows, total] = await Promise.all([
      Task.find(filter)
        .populate('customerId', 'name phone')
        .populate('helperId', 'name phone')
        .sort({ completedAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Task.countDocuments(filter),
    ]);

    const ids = rows.map((t) => t._id);
    const ledgerRows = await LedgerEntry.find({ taskId: { $in: ids }, type: { $in: ['JOB_EARNING', 'PLATFORM_COMMISSION'] } }).lean();
    const ledgerByTask = new Map();
    for (const l of ledgerRows) {
      const key = String(l.taskId);
      if (!ledgerByTask.has(key)) ledgerByTask.set(key, {});
      ledgerByTask.get(key)[l.type] = { amount: round(l.amount), settled: l.settled };
    }

    res.json({
      page, limit, total, pages: Math.max(1, Math.ceil(total / limit)),
      transactions: rows.map((task) => {
        const ledger = ledgerByTask.get(String(task._id)) || {};
        return {
          id: String(task._id),
          code: task.code,
          status: task.status,
          services: (task.services || []).map((sv) => ({ name: sv.name, nameHi: sv.nameHi, amount: sv.amount })),
          customer: task.customerId ? { id: String(task.customerId._id), name: task.customerId.name, phone: task.customerId.phone } : null,
          helper: task.helperId ? { id: String(task.helperId._id), name: task.helperId.name, phone: task.helperId.phone } : null,
          createdAt: task.createdAt,
          scheduledAt: task.scheduledAt,
          acceptedAt: task.acceptedAt,
          startedAt: task.startedAt,
          completedAt: task.completedAt,
          settledAt: task.settledAt,
          paymentStatus: task.paymentStatus,
          paymentMode: task.paymentMode,
          paidAt: task.paidAt,
          paidByRole: task.paidByRole,
          pricing: task.pricing,
          earning: ledger.JOB_EARNING ? { ...ledger.JOB_EARNING, direction: 'to helper' } : null,
          owedByHelper: ledger.PLATFORM_COMMISSION ? { ...ledger.PLATFORM_COMMISSION, direction: 'from helper' } : null,
        };
      }),
    });
  }),
);

/**
 * POST /api/admin/finance/settle/:helperId — the commission a helper owes has
 * been collected. Writes one ledger row per outstanding entry rather than
 * editing a balance, so the history stays readable.
 */
router.post(
  '/finance/settle/:helperId',
  wrap(async (req, res) => {
    const helper = await User.findOne({ _id: req.params.helperId, role: ROLES.HELPER }).lean();
    if (!helper) throw notFound('Helper not found.');

    // Anything already paid from their referral balance comes off what is collected.
    const open = await LedgerEntry.find({ userId: helper._id, ...DUES_MATCH }).lean();
    const total = round(open.reduce((sum, e) => sum + (e.type === 'DUES_PAYMENT' ? -e.amount : e.amount), 0));
    if (!open.length || total <= 0) throw conflict('Nothing is outstanding for this helper.', 'NOTHING_OWED');
    await LedgerEntry.updateMany(
      { _id: { $in: open.map((e) => e._id) } },
      { $set: { settled: true } },
    );

    await audit(req, {
      action: 'COMMISSION_SETTLED',
      entity: 'LedgerEntry',
      entityId: helper._id,
      after: { amount: total, entries: open.length },
      reason: req.body.reason || 'Commission collected',
    });

    await notify(helper._id, 'COMMISSION_SETTLED', 'Commission cleared',
      `₹${total} of platform commission has been marked as settled.`, { amount: total });

    res.json({ settled: open.length, amount: total });
  }),
);

/**
 * POST /api/admin/finance/settle-payout/:helperId — the other direction: the
 * platform collected these online payments and has now paid the helper their
 * share outside the app (bank transfer, etc.), so the payout is booked.
 */
router.post(
  '/finance/settle-payout/:helperId',
  wrap(async (req, res) => {
    const helper = await User.findOne({ _id: req.params.helperId, role: ROLES.HELPER }).lean();
    if (!helper) throw notFound('Helper not found.');

    const open = await openPayoutEntries(helper._id);
    if (!open.length) throw conflict('Nothing is due to this helper.', 'NOTHING_DUE');

    const total = round(open.reduce((sum, e) => sum + e.amount, 0));
    await LedgerEntry.updateMany(
      { _id: { $in: open.map((e) => e._id) } },
      { $set: { settled: true } },
    );

    await audit(req, {
      action: 'PAYOUT_SETTLED',
      entity: 'LedgerEntry',
      entityId: helper._id,
      after: { amount: total, entries: open.length },
      reason: req.body.reason || 'Payout sent',
    });

    await notify(helper._id, 'PAYOUT_SETTLED', 'Payout sent',
      `₹${total} for online-paid jobs has been sent to you.`, { amount: total });

    res.json({ settled: open.length, amount: total });
  }),
);

/* -------------------------------------------------------------------- track */

/**
 * GET /api/admin/track — every job request sent for recent bookings: who was
 * alerted, when, and whether they accepted, declined, or never answered.
 */
router.get(
  '/track',
  wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const { status, q, type, outcome } = req.query;

    const filter = { ...dateRange(req.query, 'createdAt') };
    if (status === 'active') filter.status = { $in: ['CREATED', 'SEARCHING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETION_PENDING'] };
    else if (status === 'nohelper') filter.status = 'NO_HELPER_AVAILABLE';
    else if (status === 'done') filter.status = { $in: ['COMPLETED', 'SETTLED'] };
    else if (status === 'cancelled') filter.status = { $in: ['CANCELLED', 'EXPIRED'] };
    else if (status && status !== 'all') filter.status = status;
    if (type === 'instant' || type === 'scheduled') filter.bookingType = type;
    if (q) {
      const people = await userIdsMatching(q);
      filter.$or = [
        { code: { $regex: escapeRegex(q), $options: 'i' } },
        ...(people.length ? [{ customerId: { $in: people } }, { helperId: { $in: people } }] : []),
      ];
      // A helper who was only alerted still counts as "on" the booking.
      if (people.length) {
        const alertedFor = await JobRequest.distinct('taskId', { helperId: { $in: people } });
        filter.$or.push({ _id: { $in: alertedFor } });
      }
    }

    /*
     * How the dispatch went, from the request rows:
     *  - accepted / declined / unanswered: at least one helper did that
     *  - no_takers: helpers were alerted but none accepted
     *  - not_alerted: nobody was ever asked
     */
    if (outcome) {
      const groups = await JobRequest.aggregate([
        {
          $group: {
            _id: '$taskId',
            accepted: { $sum: { $cond: [{ $eq: ['$status', 'ACCEPTED'] }, 1, 0] } },
            declined: { $sum: { $cond: [{ $eq: ['$status', 'DECLINED'] }, 1, 0] } },
            unanswered: { $sum: { $cond: [{ $eq: ['$status', 'EXPIRED'] }, 1, 0] } },
          },
        },
      ]);
      const pick = {
        accepted: (g) => g.accepted > 0,
        declined: (g) => g.declined > 0,
        unanswered: (g) => g.unanswered > 0,
        no_takers: (g) => g.accepted === 0,
      }[outcome];
      if (outcome === 'not_alerted') filter._id = { $nin: groups.map((g) => g._id) };
      else if (pick) filter._id = { $in: groups.filter(pick).map((g) => g._id) };
    }

    const [tasks, total] = await Promise.all([
      Task.find(filter)
        .populate('customerId', 'name phone')
        .populate('helperId', 'name phone')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Task.countDocuments(filter),
    ]);

    const taskIds = tasks.map((t) => t._id);
    const requests = await JobRequest.find({ taskId: { $in: taskIds } })
      .populate('helperId', 'name phone')
      .sort({ round: 1, sentAt: 1 })
      .lean();

    const byTask = new Map();
    for (const r of requests) {
      const key = String(r.taskId);
      if (!byTask.has(key)) byTask.set(key, []);
      byTask.get(key).push({
        helperId: r.helperId ? String(r.helperId._id) : null,
        helperName: r.helperId?.name || 'Deleted helper',
        helperPhone: r.helperId?.phone || '',
        round: r.round,
        status: r.status,
        distanceKm: r.distanceKm,
        sentAt: r.sentAt,
        expiresAt: r.expiresAt,
        respondedAt: r.respondedAt || null,
        waitedSeconds: Math.round(((r.respondedAt || (r.status === 'SENT' ? new Date() : r.expiresAt)) - r.sentAt) / 1000),
      });
    }

    res.json({
      page, limit, total, pages: Math.max(1, Math.ceil(total / limit)),
      tasks: tasks.map((task) => {
        const taskRequests = byTask.get(String(task._id)) || [];
        return {
          id: String(task._id),
          code: task.code,
          status: task.status,
          statusLabel: STATUS_LABELS[task.status] || task.status,
          bookingType: task.bookingType,
          searchMode: task.searchMode,
          services: (task.services || []).map((sv) => sv.name),
          customer: task.customerId ? { id: String(task.customerId._id), name: task.customerId.name, phone: task.customerId.phone } : null,
          helper: task.helperId ? { id: String(task.helperId._id), name: task.helperId.name, phone: task.helperId.phone } : null,
          createdAt: task.createdAt,
          scheduledAt: task.scheduledAt,
          searchStartedAt: task.searchStartedAt,
          searchExpiresAt: task.searchExpiresAt,
          acceptedAt: task.acceptedAt,
          requests: taskRequests,
          summary: {
            sent: taskRequests.length,
            accepted: taskRequests.filter((r) => r.status === 'ACCEPTED').length,
            declined: taskRequests.filter((r) => r.status === 'DECLINED').length,
            unanswered: taskRequests.filter((r) => r.status === 'EXPIRED').length,
            standDown: taskRequests.filter((r) => r.status === 'CANCELLED').length,
            pending: taskRequests.filter((r) => r.status === 'SENT').length,
          },
        };
      }),
    });
  }),
);

router.get('/settings', wrap(async (_req, res) => res.json({ settings: await getSettings() })));

/** Changing these affects new bookings only — past ones keep their snapshot. */
router.put(
  '/settings',
  wrap(async (req, res) => {
    const before = await getSettings();
    const patch = {};
    for (const [key, value] of Object.entries(req.body || {})) {
      if (!(key in before)) throw badRequest(`Unknown setting "${key}".`, 'UNKNOWN_SETTING');

      // Coerce to the shape the setting already has. A boolean arriving as the
      // string "false" would otherwise be stored as a string, and every
      // `if (setting)` in the codebase would read it as true.
      if (typeof before[key] === 'number') {
        const n = Number(value);
        if (!Number.isFinite(n)) throw badRequest(`"${key}" must be a number.`, 'INVALID_SETTING');
        patch[key] = n;
      } else if (typeof before[key] === 'boolean') {
        patch[key] = value === true || value === 'true' || value === 1 || value === '1';
      } else {
        patch[key] = String(value);
      }
    }
    const settings = await updateSettings(patch, req.user._id);
    await audit(req, { action: 'SETTINGS_UPDATED', entity: 'Setting', before, after: settings, reason: req.body.reason || '' });
    res.json({ settings });
  }),
);

router.get(
  '/audit',
  wrap(async (req, res) => {
    const { action, entity, q } = req.query;
    const filter = { ...dateRange(req.query, 'createdAt') };
    if (action) filter.action = action;
    if (entity) filter.entity = entity;
    if (q) {
      const admins = await User.find({ role: ROLES.ADMIN, ...search(q, ['name', 'email']) }).select('_id').lean();
      filter.$or = [
        { reason: { $regex: escapeRegex(q), $options: 'i' } },
        { action: { $regex: escapeRegex(q), $options: 'i' } },
        ...(admins.length ? [{ adminId: { $in: admins.map((a) => a._id) } }] : []),
      ];
    }
    const pg = pageOf(req.query, 25);
    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .populate('adminId', 'name email')
        .sort({ createdAt: -1 })
        .skip(pg.skip)
        .limit(pg.limit)
        .lean(),
      AuditLog.countDocuments(filter),
    ]);
    res.json({ logs, ...paged(total, pg) });
  }),
);

// ============================================================================
// CATEGORIES
// ============================================================================

router.get(
  '/categories',
  wrap(async (req, res) => {
    const categories = await Category.find().sort({ sortOrder: 1, name: 1 });
    res.json(categories);
  }),
);

router.post(
  '/categories',
  wrap(async (req, res) => {
    const { name, nameHi, icon, color, active, sortOrder, comingSoon } = req.body;
    if (!name) throw badRequest('Category name is required.');
    
    const existing = await Category.findOne({ name });
    if (existing) throw conflict('Category with this name already exists.');

    const category = await Category.create({ name, nameHi, icon, color, active, sortOrder, comingSoon });
    await audit(req, 'admin', 'Created category', { categoryId: category._id, name });
    res.json(category);
  }),
);

router.put(
  '/categories/:id',
  wrap(async (req, res) => {
    const category = await Category.findById(req.params.id);
    if (!category) throw notFound('Category not found');

    const { name, nameHi, icon, color, active, sortOrder, comingSoon } = req.body;
    if (name) category.name = name;
    if (nameHi !== undefined) category.nameHi = nameHi;
    if (icon !== undefined) category.icon = icon;
    if (color !== undefined) category.color = color;
    if (active !== undefined) category.active = active;
    if (sortOrder !== undefined) category.sortOrder = sortOrder;
    if (comingSoon !== undefined) category.comingSoon = comingSoon;

    await category.save();
    await audit(req, 'admin', 'Updated category', { categoryId: category._id, updates: req.body });
    res.json(category);
  }),
);

router.delete(
  '/categories/:id',
  wrap(async (req, res) => {
    const category = await Category.findById(req.params.id);
    if (!category) throw notFound('Category not found');
    
    await Category.deleteOne({ _id: req.params.id });
    await audit(req, 'admin', 'Deleted category', { categoryId: category._id, name: category.name });
    res.json({ ok: true });
  }),
);

export default router;
