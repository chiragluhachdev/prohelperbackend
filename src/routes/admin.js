import mongoose from 'mongoose';
import { Router } from 'express';
import {
  Address, AuditLog, Complaint, HelperDocument, HelperProfile, JobRequest,
  LedgerEntry, Payment, PromoCode, PromoRedemption, Rating, ReferralEntry, Rejection,
  PriceZone, Service, Task, TaskEvent, User, Category, RedemptionRequest
} from '../models/index.js';
import { ROLES, TASK_STATUS, HELPER_APPROVAL, BUSINESS_TZ, SETTING_CHOICES, dayKey } from '../config.js';
import { authenticate, requireAdmin } from '../lib/auth.js';
import { wrap, badRequest, notFound, conflict } from '../lib/http.js';
import { serializeTask, STATUS_LABELS, jobsLabel, DEFAULT_JOBS_SHOWN, expectedEndAt } from '../lib/views.js';
import { ADMIN_CANCELLABLE, cancelBooking } from '../lib/cancellation.js';
import { blockAccount, notifyAdmins } from '../lib/accounts.js';
import { OPEN_STATUSES, releaseHelperJob } from '../matching.js';
import { getSettings, updateSettings } from '../lib/settings.js';
import { notify } from '../lib/notify.js';
import { audit } from '../lib/audit.js';
import { newTxnId, postEntry, publicEntry } from '../lib/ledger.js';
import { normaliseOptions } from '../lib/serviceOptions.js';
import { documentUrl } from '../lib/cloudinary.js';
import { DUES_MATCH, PAYOUT_MATCH, PAYOUT_STAGES, SIGNED_DUES, helperEarnings, openPayoutEntries } from '../lib/wallet.js';
import { publicPayment } from '../lib/payments.js';
import { invalidateZones, zonePrice, zoneRuleText } from '../lib/zones.js';
import { ensureReferralCode, referralBalance } from '../lib/referral.js';
import { SOCIETIES, societyByCode } from '../constants/societies.js';

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
      trendAgg, overdueTasks, openComplaints,
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
      Task.countDocuments({ status: { $in: OPEN_STATUSES }, overdueNotifiedAt: { $ne: null } }),
      Complaint.countDocuments({ status: { $in: ['OPEN', 'IN_REVIEW'] } }),
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
        blockedAccounts, overdueTasks, openComplaints,
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
    helper: t.helperId?._id
      ? { id: String(t.helperId._id), name: t.helperId.name, phone: t.helperId.phone }
      : t.helperSnapshot?.name ? { id: t.helperId ? String(t.helperId) : '', name: t.helperSnapshot.name, phone: t.helperSnapshot.phone || '' } : null,
    area: t.address?.label || t.address?.city || '',
    overdue: Boolean(t.overdueNotifiedAt) && OPEN_STATUSES.includes(t.status),
    cancelledBy: t.status === TASK_STATUS.CANCELLED ? t.cancellation?.by || null : null,
  };
}

/** Complaints this person raised, and complaints about them (UC-C40/C41). */
async function accountComplaints(userId) {
  const [raised, about] = await Promise.all([
    Complaint.find({ byUserId: userId }).populate('taskId', 'code status').sort({ createdAt: -1 }).limit(25).lean(),
    Complaint.find({ againstUserId: userId }).populate('byUserId', 'name phone').populate('taskId', 'code status').sort({ createdAt: -1 }).limit(25).lean(),
  ]);
  return { raised: raised.map(adminComplaint), about: about.map(adminComplaint) };
}

/** UC-C23 — an account's rejections: the running count, the rule in force, and the latest ones. */
async function rejectionSummary(user) {
  const settings = await getSettings();
  const threshold = Number(user.role === ROLES.HELPER ? settings.rejection_block_threshold : settings.customer_rejection_block_threshold) || 0;
  const [recent, byKind] = await Promise.all([
    Rejection.find({ userId: user._id }).sort({ createdAt: -1 }).limit(30).lean(),
    Rejection.aggregate([{ $match: { userId: user._id } }, { $group: { _id: '$kind', n: { $sum: 1 } } }]),
  ]);
  return {
    count: user.rejectionCount || 0,
    threshold,
    lifetime: Object.fromEntries(byKind.map((k) => [k._id, k.n])),
    recent: recent.map((r) => ({
      id: String(r._id), kind: r.kind, taskId: r.taskId ? String(r.taskId) : null, taskCode: r.taskCode || '',
      reason: r.reason, count: r.count, threshold: r.threshold, blocked: r.blocked, at: r.createdAt,
    })),
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
      // KYC files are private: an admin gets a link that works for a few minutes (UC-C25).
      documents: documents.map((d) => ({ ...d, url: documentUrl(d, 900) })),
      tasks: tasks.map(adminTask),
      ratings,
      ratingsGiven: await Rating.find({ fromUserId: user._id }).populate('toUserId', 'name role').populate('taskId', 'code').sort({ createdAt: -1 }).limit(50).lean(),
      rejections: await rejectionSummary(user),
      complaints: await accountComplaints(user._id),
      earnings: Object.fromEntries(ledger.map((l) => [l._id, Math.round(l.total * 100) / 100])),
      // UC-C26 — the same figures the helper sees in their own app.
      money: await helperEarnings(user._id),
      ledger: (await LedgerEntry.find({ userId: user._id }).populate('taskId', 'code').sort({ createdAt: -1 }).limit(50).lean()).map(publicEntry),
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

/**
 * Approve, reject, or ask for a better copy of one document, with a remark the
 * helper can act on (UC-C25). Every review is written to the audit log.
 */
router.post(
  '/documents/:id/review',
  wrap(async (req, res) => {
    const { status, remark = '' } = req.body;
    if (!['APPROVED', 'REJECTED', 'CORRECTION_REQUESTED'].includes(status)) {
      throw badRequest('Status must be APPROVED, REJECTED or CORRECTION_REQUESTED.', 'INVALID_STATUS');
    }
    if (status !== 'APPROVED' && !String(remark).trim()) {
      throw badRequest('Say what needs fixing, so the helper can act on it.', 'REASON_REQUIRED');
    }

    const doc = await HelperDocument.findById(req.params.id);
    if (!doc) throw notFound('Document not found.');

    const before = { status: doc.status };
    doc.status = status;
    doc.remark = remark;
    doc.reviewedAt = new Date();
    doc.reviewedBy = req.user._id;
    await doc.save();

    const readable = doc.type.replace(/_/g, ' ');
    await notify(doc.helperId, 'DOCUMENT_REVIEWED',
      status === 'CORRECTION_REQUESTED' ? 'Please re-upload a document' : `Document ${status.toLowerCase()}`,
      remark || `Your ${readable} was ${status.toLowerCase().replace(/_/g, ' ')}.`,
      { status, docType: doc.type, remark: remark || '' });
    await audit(req, {
      action: 'DOCUMENT_REVIEWED', entity: 'HelperDocument', entityId: doc._id,
      before, after: { status }, reason: remark,
    });

    res.json({ document: doc });
  }),
);

/**
 * POST /api/admin/helpers/:id/request-correction — UC-C25. Sends the whole
 * application back for fixing rather than turning it down: the helper can edit
 * and submit again, and is told exactly what to change.
 */
router.post(
  '/helpers/:id/request-correction',
  wrap(async (req, res) => {
    const reason = String(req.body.reason || '').trim();
    if (!reason) throw badRequest('Say what the helper needs to fix.', 'REASON_REQUIRED');

    const profile = await HelperProfile.findOne({ userId: req.params.id });
    if (!profile) throw notFound('Helper not found.');
    if (profile.approvalStatus === HELPER_APPROVAL.APPROVED) {
      throw conflict('This helper is already approved. Reject the account instead if something is wrong.', 'ALREADY_APPROVED');
    }

    const before = { approvalStatus: profile.approvalStatus };
    profile.approvalStatus = HELPER_APPROVAL.DRAFT;
    profile.rejectionReason = reason;
    profile.reviewedAt = new Date();
    profile.reviewedBy = req.user._id;
    profile.isOnline = false;
    await profile.save();

    // Documents the admin flagged stay flagged; the rest wait for the new submission.
    await notify(profile.userId, 'CORRECTION_REQUESTED', 'Please fix your application', reason, { reason });
    await audit(req, {
      action: 'HELPER_CORRECTION_REQUESTED', entity: 'HelperProfile', entityId: profile.userId,
      before, after: { approvalStatus: profile.approvalStatus }, reason,
    });

    res.json({ profile: profile.toObject() });
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
      ratingsGiven: await Rating.find({ fromUserId: user._id }).populate('toUserId', 'name role').populate('taskId', 'code').sort({ createdAt: -1 }).limit(50).lean(),
      rejections: await rejectionSummary(user),
      complaints: await accountComplaints(user._id),
      // UC-C40 — what this customer has actually paid, and how.
      payments: (await Payment.find({ userId: user._id }).populate('taskId', 'code').sort({ createdAt: -1 }).limit(50).lean())
        .map((pay) => ({ ...publicPayment(pay), taskCode: pay.taskId?.code || '' })),
      referralLedger: (await ReferralEntry.find({ userId: user._id }).populate('taskId', 'code').sort({ createdAt: -1 }).limit(50).lean())
        .map((r) => ({
          id: String(r._id), txnId: r.txnId || String(r._id), type: r.type,
          amount: round(r.amount), note: r.note || '', taskCode: r.taskId?.code || '', at: r.createdAt,
        })),
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
    if (user.status === 'blocked') throw conflict('This account is already blocked.', 'ALREADY_BLOCKED');

    // Stops everything the account was doing, the same as an automatic block (UC-C23).
    await blockAccount(user._id, { by: 'admin', actorId: req.user._id, reason });
    await audit(req, { action: 'USER_BLOCKED', entity: 'User', entityId: user._id, before, after: { status: 'blocked' }, reason });

    res.json({ ok: true, status: 'blocked' });
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
        helperCancellations: (task.helperCancellations || []).map((c) => ({
          helperId: c.helperId ? String(c.helperId) : null, helperName: c.helperName, by: c.by,
          reason: c.reason, previousStatus: c.previousStatus, at: c.at,
        })),
        payment: publicPayment(await Payment.findOne({ taskId: task._id }).sort({ createdAt: -1 }).lean()),
        overdueSince: task.overdueNotifiedAt || null,
        overdueReminders: task.overdueReminders || 0,
        overdueLastRemindedAt: task.overdueLastRemindedAt || null,
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
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (!reason) throw badRequest('Give a reason for cancelling.', 'REASON_REQUIRED');

    const { task: updated, previousStatus } = await cancelBooking(req.params.id, {
      by: 'admin', actorId: req.user._id, reason, from: ADMIN_CANCELLABLE,
    });
    const cancelData = { taskId: String(updated._id), code: updated.code, reason, by: 'admin' };
    await notify(updated.customerId, 'BOOKING_CANCELLED', 'Booking cancelled', reason, cancelData);
    if (updated.helperId) await notify(updated.helperId, 'BOOKING_CANCELLED', 'Booking cancelled', reason, cancelData);
    await audit(req, {
      action: 'BOOKING_CANCELLED', entity: 'Task', entityId: updated._id,
      before: { status: previousStatus }, after: { status: 'CANCELLED', financialImpact: updated.cancellation?.financialImpact }, reason,
    });

    res.json({ task: serializeTask(updated) });
  }),
);

/**
 * GET /api/admin/open-tasks — UC-C18 monitoring: every booking a helper has
 * and nobody has closed, with when it should have finished and how late it
 * is. Overdue first, latest first.
 */
router.get(
  '/open-tasks',
  wrap(async (req, res) => {
    const settings = await getSettings();
    const graceMs = Math.max(0, Number(settings.overdue_reminder_minutes) || 0) * 60_000;
    const filter = { status: { $in: OPEN_STATUSES } };
    const only = statusList(req.query.status).filter((st) => OPEN_STATUSES.includes(st));
    if (only.length) filter.status = { $in: only };

    const tasks = await Task.find(filter)
      .populate('customerId', 'name phone')
      .populate('helperId', 'name phone')
      .sort({ scheduledAt: 1 })
      .limit(500)
      .lean();

    const now = Date.now();
    let rows = tasks.map((t) => {
      const end = expectedEndAt(t);
      const lateMinutes = Math.round((now - end.getTime()) / 60_000);
      return {
        ...adminTask(t),
        startedAt: t.startedAt || null,
        durationMins: t.durationMins,
        expectedEndAt: end,
        lateMinutes,
        // Overdue by the rule, whether or not the reminder has gone out yet (it runs once a minute).
        overdue: now >= end.getTime() + graceMs,
        overdueSince: t.overdueNotifiedAt || null,
        reminders: t.overdueReminders || 0,
        lastRemindedAt: t.overdueLastRemindedAt || null,
      };
    });
    if (req.query.overdue === '1') rows = rows.filter((r) => r.overdue);
    rows.sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.lateMinutes - a.lateMinutes);

    res.json({
      tasks: rows,
      counts: {
        open: tasks.length,
        overdue: rows.filter((r) => r.overdue).length,
        ACCEPTED: tasks.filter((t) => t.status === TASK_STATUS.ACCEPTED).length,
        IN_PROGRESS: tasks.filter((t) => t.status === TASK_STATUS.IN_PROGRESS).length,
        COMPLETION_PENDING: tasks.filter((t) => t.status === TASK_STATUS.COMPLETION_PENDING).length,
      },
      rule: {
        overdueAfterMinutes: settings.overdue_reminder_minutes,
        repeatMinutes: settings.overdue_repeat_minutes,
        maxReminders: settings.overdue_max_reminders,
      },
    });
  }),
);

/**
 * POST /api/admin/bookings/:id/reassign — take the job off the helper who has
 * it and look for another. The booking stays the customer's; the drop is kept
 * on it, and the helper who lost it is never offered it again (UC-C22/C46).
 */
router.post(
  '/bookings/:id/reassign',
  wrap(async (req, res) => {
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (!reason) throw badRequest('Give a reason for moving this booking.', 'REASON_REQUIRED');

    const task = await Task.findById(req.params.id).select('status helperId code').lean();
    if (!task) throw notFound('Booking not found.');

    const { task: updated, research } = await releaseHelperJob(task._id, {
      by: 'admin', actorId: req.user._id, reason,
      action: req.body.cancel ? 'cancel' : 'research',
      countRejection: false,
    });
    await audit(req, {
      action: 'BOOKING_REASSIGNED', entity: 'Task', entityId: task._id,
      before: { helperId: String(task.helperId), status: task.status },
      after: { status: updated.status, research }, reason,
    });
    res.json({ task: serializeTask(updated), research });
  }),
);

/** POST /api/admin/bookings/:id/remind — nudge both sides of an open booking now. */
router.post(
  '/bookings/:id/remind',
  wrap(async (req, res) => {
    const task = await Task.findById(req.params.id).lean();
    if (!task) throw notFound('Booking not found.');
    if (!OPEN_STATUSES.includes(task.status)) throw conflict('Only an open booking can be reminded about.', 'NOT_OPEN');

    const data = { taskId: String(task._id), code: task.code, status: task.status, byAdmin: '1' };
    await notify(task.customerId, 'TASK_OVERDUE', 'Booking still open', `${task.code} has not been closed yet.`, { ...data, role: 'customer' });
    await notify(task.helperId, 'TASK_OVERDUE', 'Please close this job', `${task.code} is still open. Close it with the customer's OTP.`, { ...data, role: 'helper' });
    await Task.updateOne({ _id: task._id }, { $set: { overdueLastRemindedAt: new Date() } });
    await TaskEvent.create({ taskId: task._id, kind: 'STATUS', from: task.status, to: task.status, actorType: 'admin', actorId: req.user._id, reason: 'Admin sent a reminder to close the job' });
    await audit(req, { action: 'BOOKING_REMINDED', entity: 'Task', entityId: task._id, reason: req.body.reason || '' });
    res.json({ ok: true });
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

/** "Extra Bathrooms!" -> "extra_bathrooms": no runs, no edges, no surprises. */
const slug = (raw) =>
  String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** The questions a service asks — validated by the same rules pricing reads them with. */
const parseOptions = (raw) => normaliseOptions(raw);

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
            discount: { $sum: { $ifNull: ['$pricing.discount', 0] } },
            surcharge: { $sum: { $ifNull: ['$pricing.surcharge', 0] } },
            gst: { $sum: { $ifNull: ['$pricing.gst', 0] } },
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
                  { $add: ['$pricing.platformFee', '$pricing.helperCommission', { $ifNull: ['$pricing.surcharge', 0] }] },
                  { $add: [{ $ifNull: ['$pricing.referralCredit', 0] }, { $ifNull: ['$pricing.discount', 0] }] },
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
        // Referral balance customers spent and discounts are paid for by the platform.
        referralCredit: round(t.referralCredit),
        discount: round(t.discount),
        surcharge: round(t.surcharge),
        // Tax collected on the platform's behalf — owed to the government, not revenue.
        gst: round(t.gst),
        platformEarned: round(
          (t.platformFee || 0) + (t.commission || 0) + (t.surcharge || 0) - (t.referralCredit || 0) - (t.discount || 0),
        ),
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
      { $set: { settled: true, status: 'SETTLED' } },
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
      { $set: { settled: true, status: 'SETTLED' } },
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
        if (SETTING_CHOICES[key] && !SETTING_CHOICES[key].includes(patch[key])) {
          throw badRequest(`"${key}" must be one of: ${SETTING_CHOICES[key].join(', ')}.`, 'INVALID_SETTING');
        }
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
    await audit(req, { action: 'CATEGORY_CREATED', entity: 'Category', entityId: category._id, after: category.toObject() });
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
    await audit(req, { action: 'CATEGORY_UPDATED', entity: 'Category', entityId: category._id, after: req.body });
    res.json(category);
  }),
);

router.delete(
  '/categories/:id',
  wrap(async (req, res) => {
    const category = await Category.findById(req.params.id);
    if (!category) throw notFound('Category not found');
    
    await Category.deleteOne({ _id: req.params.id });
    await audit(req, { action: 'CATEGORY_DELETED', entity: 'Category', entityId: category._id, before: category.toObject() });
    res.json({ ok: true });
  }),
);

/**
 * POST /api/admin/helpers/:id/adjustment — UC-C26. A correction to a helper's
 * money: a bonus, a deduction, a fix for something that went wrong. Written as
 * its own ledger row with a reason, never as an edit to a balance.
 */
router.post(
  '/helpers/:id/adjustment',
  wrap(async (req, res) => {
    const amount = round(Number(req.body.amount));
    const direction = req.body.direction === 'DEBIT' ? 'DEBIT' : 'CREDIT';
    const note = String(req.body.note || '').trim();
    if (!(amount > 0)) throw badRequest('Enter an amount above zero.', 'INVALID_AMOUNT');
    if (!note) throw badRequest('Say what this adjustment is for.', 'REASON_REQUIRED');

    const helper = await User.findOne({ _id: req.params.id, role: ROLES.HELPER }).lean();
    if (!helper) throw notFound('Helper not found.');

    const entry = await postEntry({
      userId: helper._id, type: 'ADJUSTMENT', direction, amount,
      note, source: 'ADMIN', ref: `adjustment:${helper._id}:${Date.now()}`,
    });

    await notify(helper._id, 'ADJUSTMENT_POSTED',
      direction === 'CREDIT' ? 'Money added to your account' : 'Deduction from your account',
      `₹${amount} — ${note}`, { amount: String(amount), direction, note });
    await audit(req, {
      action: 'HELPER_ADJUSTMENT', entity: 'LedgerEntry', entityId: entry?._id,
      after: { amount, direction, note }, reason: note,
    });

    res.status(201).json({ entry: entry ? publicEntry(entry) : null, earnings: await helperEarnings(helper._id) });
  }),
);

/* ----------------------------------------------------------------- price zones */

/** Every field of a zone, checked — including that a society is only priced once. */
async function zoneBody(body, existing = {}) {
  const code = String(body.code ?? existing.code ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!/^[a-z0-9_]{2,30}$/.test(code)) throw badRequest('A zone code is 2–30 letters, numbers or underscores.', 'INVALID_CODE');
  const name = String(body.name ?? existing.name ?? '').trim();
  if (!name) throw badRequest('Give the zone a name.', 'NAME_REQUIRED');

  const adjustType = ['percent', 'flat', 'none'].includes(body.adjustType) ? body.adjustType : existing.adjustType || 'percent';
  const adjustValue = round(Number(body.adjustValue ?? existing.adjustValue ?? 0));
  if (!Number.isFinite(adjustValue)) throw badRequest('The adjustment must be a number.', 'INVALID_VALUE');
  if (adjustType === 'percent' && (adjustValue <= -100 || adjustValue > 500)) {
    throw badRequest('A percentage adjustment must be above −100 and at most 500.', 'INVALID_VALUE');
  }

  const societies = [...new Set((body.societies ?? existing.societies ?? []).map((c) => String(c)))]
    .filter((c) => SOCIETIES.some((sc) => sc.code === c));

  // A society priced twice would make the bill depend on which zone was read first.
  if (societies.length) {
    const clash = await PriceZone.findOne({
      societies: { $in: societies },
      ...(existing._id ? { _id: { $ne: existing._id } } : {}),
    }).lean();
    if (clash) {
      const taken = societies.filter((c) => (clash.societies || []).includes(c)).map((c) => societyByCode(c)?.name || c);
      throw conflict(`${taken.join(', ')} already belongs to "${clash.name}".`, 'SOCIETY_TAKEN');
    }
  }

  const codes = (body.overrides ?? existing.overrides ?? [])
    .map((o) => ({ serviceCode: String(o.serviceCode || '').trim(), price: round(Number(o.price)) }))
    .filter((o) => o.serviceCode);
  for (const o of codes) {
    if (!Number.isFinite(o.price) || o.price < 0) throw badRequest(`"${o.serviceCode}" needs a price of zero or more.`, 'INVALID_VALUE');
  }
  const known = await Service.find({ code: { $in: codes.map((o) => o.serviceCode) } }).select('code').lean();
  const knownCodes = new Set(known.map((k) => k.code));
  const overrides = codes.filter((o) => knownCodes.has(o.serviceCode));

  return {
    code, name, adjustType, adjustValue, societies, overrides,
    description: String(body.description ?? existing.description ?? '').trim().slice(0, 200),
    active: body.active === undefined ? existing.active !== false : Boolean(body.active),
  };
}

/** GET /api/admin/zones — the zones, the societies each covers, and what they price. */
router.get(
  '/zones',
  wrap(async (_req, res) => {
    const [zones, services] = await Promise.all([
      PriceZone.find().sort({ name: 1 }).lean(),
      Service.find({ active: true }).select('code name basePrice').sort({ sortOrder: 1, name: 1 }).lean(),
    ]);
    const taken = new Set(zones.filter((z) => z.active).flatMap((z) => z.societies || []));
    res.json({
      zones: zones.map((z) => ({
        ...z,
        id: String(z._id),
        rule: zoneRuleText(z),
        // What this zone actually charges, so the page can show it without doing the sums.
        prices: services.map((sv) => {
          const { price, listPrice, source } = zonePrice(z, sv);
          return { code: sv.code, name: sv.name, listPrice, price, source };
        }),
      })),
      services: services.map((sv) => ({ code: sv.code, name: sv.name, basePrice: sv.basePrice })),
      // Every society we serve, and whether another zone already prices it.
      societies: SOCIETIES.map((sc) => ({
        code: sc.code, name: sc.name, area: sc.area, city: sc.city,
        zone: zones.find((z) => (z.societies || []).includes(sc.code))?.name || null,
        taken: taken.has(sc.code),
      })),
    });
  }),
);

router.post(
  '/zones',
  wrap(async (req, res) => {
    const body = await zoneBody(req.body);
    if (await PriceZone.exists({ code: body.code })) throw conflict('A zone with that code already exists.', 'CODE_TAKEN');
    const zone = await PriceZone.create({ ...body, createdBy: req.user._id });
    invalidateZones();
    await audit(req, { action: 'ZONE_CREATED', entity: 'PriceZone', entityId: zone._id, after: zone.toObject(), reason: req.body.reason || '' });
    res.status(201).json({ zone: zone.toObject() });
  }),
);

router.put(
  '/zones/:id',
  wrap(async (req, res) => {
    const zone = await PriceZone.findById(req.params.id);
    if (!zone) throw notFound('Zone not found.');
    const before = zone.toObject();
    const body = await zoneBody(req.body, before);
    if (body.code !== zone.code && (await PriceZone.exists({ code: body.code }))) {
      throw conflict('A zone with that code already exists.', 'CODE_TAKEN');
    }
    Object.assign(zone, body);
    await zone.save();
    invalidateZones();
    await audit(req, {
      action: 'ZONE_UPDATED', entity: 'PriceZone', entityId: zone._id,
      before, after: zone.toObject(), reason: req.body.reason || '',
    });
    res.json({ zone: zone.toObject() });
  }),
);

router.delete(
  '/zones/:id',
  wrap(async (req, res) => {
    const zone = await PriceZone.findById(req.params.id);
    if (!zone) throw notFound('Zone not found.');
    await zone.deleteOne();
    invalidateZones();
    // Bookings keep the prices they were made with, so removing a zone is safe.
    await audit(req, { action: 'ZONE_DELETED', entity: 'PriceZone', entityId: zone._id, before: zone.toObject(), reason: req.body.reason || '' });
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ complaints */

const adminComplaint = (c) => ({
  id: String(c._id),
  code: c.code,
  category: c.category,
  message: c.message,
  status: c.status,
  resolution: c.resolution || '',
  at: c.createdAt,
  handledAt: c.handledAt || null,
  escalated: Boolean(c.escalated),
  escalatedAt: c.escalatedAt || null,
  escalationReason: c.escalationReason || '',
  assignedTo: c.assignedTo?._id
    ? { id: String(c.assignedTo._id), name: c.assignedTo.name, email: c.assignedTo.email }
    : c.assignedTo ? { id: String(c.assignedTo), name: '', email: '' } : null,
  assignedAt: c.assignedAt || null,
  notes: (c.notes || []).map((n) => ({ kind: n.kind, text: n.text, byName: n.byName || '', at: n.at })),
  by: c.byUserId?._id
    ? { id: String(c.byUserId._id), name: c.byUserId.name, phone: c.byUserId.phone, email: c.byUserId.email || '', role: c.byRole }
    : null,
  against: c.againstUserId?._id
    ? { id: String(c.againstUserId._id), name: c.againstUserId.name, phone: c.againstUserId.phone }
    : null,
  task: c.taskId?._id ? { id: String(c.taskId._id), code: c.taskId.code, status: c.taskId.status } : null,
  taskCode: c.taskCode || c.taskId?.code || '',
});

/** Loads a complaint with everyone on it, the way every complaint route returns it. */
const loadComplaint = (id) =>
  Complaint.findById(id)
    .populate('byUserId', 'name phone email')
    .populate('againstUserId', 'name phone')
    .populate('assignedTo', 'name email')
    .populate('taskId', 'code status')
    .lean();

/** GET /api/admin/complaints — UC-C39/C40: the queue, newest first. */
router.get(
  '/complaints',
  wrap(async (req, res) => {
    const filter = { ...dateRange(req.query, 'createdAt') };
    if (['OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED'].includes(req.query.status)) filter.status = req.query.status;
    if (req.query.category) filter.category = String(req.query.category);
    if (req.query.role) filter.byRole = String(req.query.role);
    if (req.query.escalated === '1') filter.escalated = true;
    if (req.query.assigned === 'me') filter.assignedTo = req.user._id;
    if (req.query.assigned === 'none') filter.assignedTo = null;
    if (req.query.assigned && mongoose.isValidObjectId(req.query.assigned)) filter.assignedTo = req.query.assigned;
    if (req.query.user && mongoose.isValidObjectId(req.query.user)) {
      filter.$or = [{ byUserId: req.query.user }, { againstUserId: req.query.user }];
    }
    if (req.query.q) {
      const people = await userIdsMatching(req.query.q);
      const q = escapeRegex(String(req.query.q));
      filter.$and = [
        {
          $or: [
            { code: { $regex: q, $options: 'i' } },
            { taskCode: { $regex: q, $options: 'i' } },
            { message: { $regex: q, $options: 'i' } },
            ...(people.length ? [{ byUserId: { $in: people } }, { againstUserId: { $in: people } }] : []),
          ],
        },
      ];
    }

    const pg = pageOf(req.query, 50);
    const [complaints, total, counts] = await Promise.all([
      Complaint.find(filter)
        .populate('byUserId', 'name phone email')
        .populate('againstUserId', 'name phone')
        .populate('assignedTo', 'name email')
        .populate('taskId', 'code status')
        // Escalated first: they are the ones that cannot wait their turn.
        .sort({ escalated: -1, createdAt: -1 })
        .skip(pg.skip)
        .limit(pg.limit)
        .lean(),
      Complaint.countDocuments(filter),
      Complaint.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);

    const [escalated, mine, unassigned, admins] = await Promise.all([
      Complaint.countDocuments({ escalated: true, status: { $in: ['OPEN', 'IN_REVIEW'] } }),
      Complaint.countDocuments({ assignedTo: req.user._id, status: { $in: ['OPEN', 'IN_REVIEW'] } }),
      Complaint.countDocuments({ assignedTo: null, status: { $in: ['OPEN', 'IN_REVIEW'] } }),
      User.find({ role: ROLES.ADMIN, status: 'active' }).select('name email').sort({ name: 1 }).lean(),
    ]);

    res.json({
      complaints: complaints.map(adminComplaint),
      counts: { ...Object.fromEntries(counts.map((c) => [c._id, c.n])), escalated, mine, unassigned },
      admins: admins.map((a) => ({ id: String(a._id), name: a.name || a.email, email: a.email })),
      me: String(req.user._id),
      ...paged(total, pg),
    });
  }),
);

/** GET /api/admin/complaints/:id — the complaint, both sides, and the working notes. */
router.get(
  '/complaints/:id',
  wrap(async (req, res) => {
    const complaint = await loadComplaint(req.params.id);
    if (!complaint) throw notFound('Complaint not found.');
    res.json({ complaint: adminComplaint(complaint) });
  }),
);

/** POST /api/admin/complaints/:id/assign — give it to an admin, or take it yourself. */
router.post(
  '/complaints/:id/assign',
  wrap(async (req, res) => {
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) throw notFound('Complaint not found.');

    const raw = req.body.adminId;
    const target = raw === 'me' || raw === undefined ? req.user._id : raw === null || raw === '' ? null : raw;
    let admin = null;
    if (target) {
      admin = await User.findOne({ _id: target, role: ROLES.ADMIN }).select('name email').lean();
      if (!admin) throw badRequest('That is not an admin account.', 'INVALID_ADMIN');
    }

    const before = { assignedTo: complaint.assignedTo ? String(complaint.assignedTo) : null };
    complaint.assignedTo = admin?._id ?? undefined;
    complaint.assignedAt = admin ? new Date() : undefined;
    // Picking it up means it is being looked at.
    if (admin && complaint.status === 'OPEN') complaint.status = 'IN_REVIEW';
    complaint.notes.push({
      byId: req.user._id, byName: req.user.name || req.user.email, kind: 'ASSIGN',
      text: admin ? `Assigned to ${admin.name || admin.email}` : 'Unassigned',
      at: new Date(),
    });
    await complaint.save();

    await audit(req, {
      action: 'COMPLAINT_ASSIGNED', entity: 'Complaint', entityId: complaint._id,
      before, after: { assignedTo: admin ? String(admin._id) : null }, reason: req.body.reason || '',
    });
    res.json({ complaint: adminComplaint(await loadComplaint(complaint._id)) });
  }),
);

/**
 * POST /api/admin/complaints/:id/notes — the working record: what was tried,
 * who was spoken to, what they said. Internal; the reporter never sees it.
 */
router.post(
  '/complaints/:id/notes',
  wrap(async (req, res) => {
    const text = String(req.body.text || '').trim().slice(0, 1000);
    if (!text) throw badRequest('Write the note first.', 'NOTE_REQUIRED');
    const kind = ['NOTE', 'CONTACT'].includes(req.body.kind) ? req.body.kind : 'NOTE';

    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) throw notFound('Complaint not found.');
    complaint.notes.push({ byId: req.user._id, byName: req.user.name || req.user.email, kind, text, at: new Date() });
    await complaint.save();

    await audit(req, {
      action: kind === 'CONTACT' ? 'COMPLAINT_CONTACT_LOGGED' : 'COMPLAINT_NOTE_ADDED',
      entity: 'Complaint', entityId: complaint._id, after: { kind, text }, reason: text,
    });
    res.json({ complaint: adminComplaint(await loadComplaint(complaint._id)) });
  }),
);

/** POST /api/admin/complaints/:id/escalate — raise it above the queue, with a reason. */
router.post(
  '/complaints/:id/escalate',
  wrap(async (req, res) => {
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    const escalated = req.body.escalated === false ? false : true;
    if (escalated && !reason) throw badRequest('Say why this needs escalating.', 'REASON_REQUIRED');

    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) throw notFound('Complaint not found.');

    const before = { escalated: complaint.escalated };
    complaint.escalated = escalated;
    complaint.escalatedAt = escalated ? new Date() : undefined;
    complaint.escalationReason = escalated ? reason : '';
    if (escalated && complaint.status === 'OPEN') complaint.status = 'IN_REVIEW';
    complaint.notes.push({
      byId: req.user._id, byName: req.user.name || req.user.email, kind: 'ESCALATE',
      text: escalated ? `Escalated: ${reason}` : 'Escalation cleared', at: new Date(),
    });
    await complaint.save();

    if (escalated) {
      await notifyAdmins('COMPLAINT_ESCALATED', 'Complaint escalated',
        `${complaint.code} was escalated: ${reason}`,
        { complaintId: String(complaint._id), code: complaint.code });
    }
    await audit(req, {
      action: escalated ? 'COMPLAINT_ESCALATED' : 'COMPLAINT_DE_ESCALATED',
      entity: 'Complaint', entityId: complaint._id, before, after: { escalated }, reason,
    });
    res.json({ complaint: adminComplaint(await loadComplaint(complaint._id)) });
  }),
);

/**
 * POST /api/admin/complaints/:id/status — take it up, settle it, or set it
 * aside. Whoever raised it is told what was decided, and it stays on both
 * accounts' history either way.
 */
router.post(
  '/complaints/:id/status',
  wrap(async (req, res) => {
    const { status } = req.body;
    if (!['IN_REVIEW', 'RESOLVED', 'DISMISSED'].includes(status)) {
      throw badRequest('Status must be IN_REVIEW, RESOLVED or DISMISSED.', 'INVALID_STATUS');
    }
    const resolution = String(req.body.resolution || '').trim().slice(0, 1000);
    if (status !== 'IN_REVIEW' && !resolution) {
      throw badRequest('Say what was decided — the person who reported it is told this.', 'REASON_REQUIRED');
    }

    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) throw notFound('Complaint not found.');

    const before = { status: complaint.status };
    complaint.status = status;
    if (resolution) complaint.resolution = resolution;
    complaint.handledBy = req.user._id;
    complaint.handledAt = new Date();
    // Closing it clears the escalation: it is no longer waiting on anyone.
    if (['RESOLVED', 'DISMISSED'].includes(status)) complaint.escalated = false;
    complaint.notes.push({
      byId: req.user._id, byName: req.user.name || req.user.email, kind: 'STATUS',
      text: resolution ? `${status}: ${resolution}` : status, at: new Date(),
    });
    await complaint.save();

    await notify(complaint.byUserId, 'COMPLAINT_UPDATED',
      status === 'IN_REVIEW' ? 'We are looking into it' : status === 'RESOLVED' ? 'Your complaint is resolved' : 'About your complaint',
      resolution || `${complaint.code} is being looked at.`,
      { complaintId: String(complaint._id), code: complaint.code, status, taskId: complaint.taskId ? String(complaint.taskId) : '' });
    await audit(req, {
      action: 'COMPLAINT_UPDATED', entity: 'Complaint', entityId: complaint._id,
      before, after: { status }, reason: resolution,
    });

    res.json({ complaint: adminComplaint(await loadComplaint(complaint._id)) });
  }),
);

/* ------------------------------------------------------------------ promo codes */

const promoBody = (body, existing = {}) => {
  const code = String(body.code ?? existing.code ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,20}$/.test(code)) throw badRequest('A promo code is 3–20 letters or numbers.', 'INVALID_CODE');
  const type = body.type === 'PERCENT' ? 'PERCENT' : body.type === 'FLAT' ? 'FLAT' : existing.type || 'FLAT';
  const value = Number(body.value ?? existing.value);
  if (!Number.isFinite(value) || value <= 0) throw badRequest('Enter a discount above zero.', 'INVALID_VALUE');
  if (type === 'PERCENT' && value > 100) throw badRequest('A percentage discount cannot be above 100.', 'INVALID_VALUE');

  const numbers = (body.taskNumbers ?? existing.taskNumbers ?? [])
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 100);
  const eligibility = ['ALL', 'NEW', 'SELECTED'].includes(body.eligibility) ? body.eligibility : existing.eligibility || 'ALL';
  const customerIds = (body.customerIds ?? existing.customerIds ?? []).filter((id) => mongoose.isValidObjectId(id));
  if (eligibility === 'SELECTED' && customerIds.length === 0) {
    throw badRequest('Choose at least one customer for a code limited to selected customers.', 'NO_CUSTOMERS');
  }

  const dates = {};
  for (const key of ['startsAt', 'endsAt']) {
    const raw = body[key] ?? existing[key];
    if (raw === '' || raw === null) dates[key] = null;
    else if (raw !== undefined) {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) throw badRequest(`"${key}" is not a date.`, 'INVALID_DATE');
      dates[key] = d;
    }
  }
  if (dates.startsAt && dates.endsAt && dates.startsAt > dates.endsAt) {
    throw badRequest('The end date is before the start date.', 'INVALID_DATE');
  }

  return {
    code, type, value: round(value),
    description: String(body.description ?? existing.description ?? '').trim().slice(0, 120),
    maxDiscount: Math.max(0, round(Number(body.maxDiscount ?? existing.maxDiscount ?? 0))),
    minBill: Math.max(0, round(Number(body.minBill ?? existing.minBill ?? 0))),
    maxUses: Math.max(0, Math.round(Number(body.maxUses ?? existing.maxUses ?? 0))),
    maxUsesPerCustomer: Math.max(0, Math.round(Number(body.maxUsesPerCustomer ?? existing.maxUsesPerCustomer ?? 1))),
    eligibility,
    customerIds,
    taskNumbers: numbers,
    active: body.active === undefined ? existing.active !== false : Boolean(body.active),
    ...dates,
  };
};

/** GET /api/admin/promos — every code with how much it has been used (UC-C32). */
router.get(
  '/promos',
  wrap(async (req, res) => {
    const filter = {};
    if (req.query.status === 'active') filter.active = true;
    if (req.query.status === 'paused') filter.active = false;
    if (req.query.q) filter.code = { $regex: escapeRegex(String(req.query.q).toUpperCase()), $options: 'i' };

    const promos = await PromoCode.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    const usage = await PromoRedemption.aggregate([
      { $match: { promoId: { $in: promos.map((p) => p._id) } } },
      { $group: { _id: { promoId: '$promoId', status: '$status' }, n: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]);
    const byPromo = new Map();
    for (const row of usage) {
      const key = String(row._id.promoId);
      const entry = byPromo.get(key) || { used: 0, reversed: 0, discountGiven: 0 };
      if (row._id.status === 'APPLIED') {
        entry.used = row.n;
        entry.discountGiven = round(row.amount);
      } else entry.reversed = row.n;
      byPromo.set(key, entry);
    }

    res.json({
      promos: promos.map((p) => ({
        ...p,
        id: String(p._id),
        usage: byPromo.get(String(p._id)) || { used: 0, reversed: 0, discountGiven: 0 },
      })),
    });
  }),
);

/** GET /api/admin/promos/:id — the code, and every booking it was used on. */
router.get(
  '/promos/:id',
  wrap(async (req, res) => {
    const promo = await PromoCode.findById(req.params.id).populate('customerIds', 'name phone').lean();
    if (!promo) throw notFound('Promo code not found.');
    const redemptions = await PromoRedemption.find({ promoId: promo._id })
      .populate('userId', 'name phone')
      .populate('taskId', 'code status')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json({
      promo: { ...promo, id: String(promo._id) },
      redemptions: redemptions.map((r) => ({
        id: String(r._id), amount: round(r.amount), status: r.status, at: r.createdAt,
        customer: r.userId ? { id: String(r.userId._id), name: r.userId.name, phone: r.userId.phone } : null,
        task: r.taskId ? { id: String(r.taskId._id), code: r.taskId.code, status: r.taskId.status } : null,
      })),
    });
  }),
);

router.post(
  '/promos',
  wrap(async (req, res) => {
    const body = promoBody(req.body);
    if (await PromoCode.exists({ code: body.code })) throw conflict('That code already exists.', 'CODE_TAKEN');
    const promo = await PromoCode.create({ ...body, createdBy: req.user._id });
    await audit(req, { action: 'PROMO_CREATED', entity: 'PromoCode', entityId: promo._id, after: promo.toObject() });
    res.status(201).json({ promo: promo.toObject() });
  }),
);

router.put(
  '/promos/:id',
  wrap(async (req, res) => {
    const promo = await PromoCode.findById(req.params.id);
    if (!promo) throw notFound('Promo code not found.');
    const before = promo.toObject();
    const body = promoBody(req.body, before);
    if (body.code !== promo.code && (await PromoCode.exists({ code: body.code }))) {
      throw conflict('That code already exists.', 'CODE_TAKEN');
    }
    Object.assign(promo, body);
    await promo.save();
    await audit(req, { action: 'PROMO_UPDATED', entity: 'PromoCode', entityId: promo._id, before, after: promo.toObject(), reason: req.body.reason || '' });
    res.json({ promo: promo.toObject() });
  }),
);

router.delete(
  '/promos/:id',
  wrap(async (req, res) => {
    const promo = await PromoCode.findById(req.params.id);
    if (!promo) throw notFound('Promo code not found.');
    // Codes that have been used are switched off, never deleted — the history must stay.
    const used = await PromoRedemption.countDocuments({ promoId: promo._id });
    if (used > 0) {
      promo.active = false;
      await promo.save();
      await audit(req, { action: 'PROMO_PAUSED', entity: 'PromoCode', entityId: promo._id, after: { active: false }, reason: 'Used codes are paused, not deleted' });
      return res.json({ ok: true, paused: true });
    }
    await promo.deleteOne();
    await audit(req, { action: 'PROMO_DELETED', entity: 'PromoCode', entityId: promo._id, before: promo.toObject() });
    res.json({ ok: true, deleted: true });
  }),
);

/* -------------------------------------------------------------------- payments */

/** GET /api/admin/payments — UC-C28: every online payment, whatever became of it. */
router.get(
  '/payments',
  wrap(async (req, res) => {
    const filter = { ...dateRange(req.query, 'createdAt') };
    if (['CREATED', 'PAID', 'FAILED', 'REFUNDED'].includes(req.query.status)) filter.status = req.query.status;
    if (req.query.q) {
      const q = escapeRegex(String(req.query.q));
      filter.$or = [
        { orderId: { $regex: q, $options: 'i' } },
        { gatewayPaymentId: { $regex: q, $options: 'i' } },
        { gatewayOrderId: { $regex: q, $options: 'i' } },
      ];
    }
    const pg = pageOf(req.query, 50);
    const [payments, total, counts] = await Promise.all([
      Payment.find(filter)
        .populate('taskId', 'code status')
        .populate('userId', 'name phone')
        .sort({ createdAt: -1 })
        .skip(pg.skip)
        .limit(pg.limit)
        .lean(),
      Payment.countDocuments(filter),
      Payment.aggregate([{ $group: { _id: '$status', n: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
    ]);

    res.json({
      payments: payments.map((p) => ({
        ...publicPayment(p),
        task: p.taskId ? { id: String(p.taskId._id), code: p.taskId.code, status: p.taskId.status } : null,
        customer: p.userId ? { id: String(p.userId._id), name: p.userId.name, phone: p.userId.phone } : null,
      })),
      counts: Object.fromEntries(counts.map((c) => [c._id, { count: c.n, amount: round(c.amount) }])),
      ...paged(total, pg),
    });
  }),
);

/* ------------------------------------------------------------ referral partners & redemptions */

router.get(
  '/partners',
  wrap(async (req, res) => {
    const filter = { role: ROLES.PARTNER };
    if (req.query.q) filter.$or = search(req.query.q, ['name', 'phone']).$or;
    if (req.query.status) filter.status = req.query.status;
    
    const pg = pageOf(req.query, 25);
    const [partners, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(),
      User.countDocuments(filter),
    ]);

    res.json({ partners, total, ...pg });
  }),
);

router.post(
  '/partners',
  wrap(async (req, res) => {
    const { name, phone } = req.body;
    const cleanPhone = String(phone || '').replace(/[^\d]/g, '').slice(-10);
    if (!cleanPhone || cleanPhone.length !== 10) throw badRequest('Enter a valid 10-digit mobile number.');
    if (!name) throw badRequest('Name is required.');

    const taken = await User.exists({ phone: cleanPhone, role: ROLES.PARTNER });
    if (taken) throw conflict('A partner with this phone number already exists.');

    const partner = await User.create({ phone: cleanPhone, name, role: ROLES.PARTNER });
    await audit(req, { action: 'PARTNER_CREATED', entity: 'User', entityId: partner._id, after: partner.toObject() });
    res.status(201).json(partner);
  }),
);

router.get(
  '/redemptions',
  wrap(async (req, res) => {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    
    const pg = pageOf(req.query, 25);
    const [requests, total] = await Promise.all([
      RedemptionRequest.find(filter)
        .populate('userId', 'name phone')
        .populate('processedBy', 'name')
        .sort({ createdAt: -1 })
        .skip(pg.skip)
        .limit(pg.limit)
        .lean(),
      RedemptionRequest.countDocuments(filter),
    ]);

    res.json({ requests, total, ...pg });
  }),
);

router.put(
  '/redemptions/:id',
  wrap(async (req, res) => {
    const request = await RedemptionRequest.findById(req.params.id);
    if (!request) throw notFound('Request not found');
    if (request.status !== 'PROCESSING') throw badRequest(`Request is already ${request.status}`);

    const { status, rejectionReason } = req.body;
    if (!['PAID', 'REJECTED'].includes(status)) throw badRequest('Invalid status');

    const before = request.toObject();
    request.status = status;
    request.processedBy = req.user._id;
    request.processedAt = new Date();
    
    if (status === 'REJECTED') {
      request.rejectionReason = rejectionReason || '';
      // Refund the partner's referral balance
      await ReferralEntry.create({
        userId: request.userId,
        txnId: newTxnId(),
        type: 'PARTNER_REDEMPTION', // Reuse type, but positive amount
        amount: request.amount,
        ref: `refund_req:${request._id}`,
        note: `Redemption rejected: ${rejectionReason || 'No reason provided'}`,
      });
    }

    await request.save();
    await audit(req, { action: 'REDEMPTION_UPDATED', entity: 'RedemptionRequest', entityId: request._id, before, after: request.toObject() });
    res.json(request);
  }),
);

export default router;
