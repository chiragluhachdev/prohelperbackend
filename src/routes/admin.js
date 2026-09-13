import { Router } from 'express';
import {
  Address, AuditLog, HelperDocument, HelperProfile, JobRequest,
  LedgerEntry, Rating, Service, Task, TaskEvent, User,
} from '../models/index.js';
import { ROLES, TASK_STATUS, HELPER_APPROVAL, BUSINESS_TZ, dayKey } from '../config.js';
import { authenticate, requireAdmin } from '../lib/auth.js';
import { wrap, badRequest, notFound, conflict } from '../lib/http.js';
import { serializeTask, STATUS_LABELS, jobsLabel, DEFAULT_JOBS_SHOWN } from '../lib/views.js';
import { getSettings, updateSettings } from '../lib/settings.js';
import { closeJobAlerts, notify } from '../lib/notify.js';
import { audit } from '../lib/audit.js';
import { mustTransition } from '../lib/taskflow.js';

const router = Router();
router.use(authenticate, requireAdmin);

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const search = (q, fields) =>
  q ? { $or: fields.map((f) => ({ [f]: { $regex: escapeRegex(q), $options: 'i' } })) } : {};

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
        { $match: { type: 'PLATFORM_COMMISSION', settled: false } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
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
    const { status, q } = req.query;
    const userFilter = { role: ROLES.HELPER, ...search(q, ['name', 'phone']) };
    const users = await User.find(userFilter).sort({ createdAt: -1 }).limit(200).lean();

    const profileFilter = { userId: { $in: users.map((u) => u._id) } };
    if (status) profileFilter.approvalStatus = status;
    const profiles = await HelperProfile.find(profileFilter).lean();
    const byUser = new Map(profiles.map((p) => [String(p.userId), p]));

    const helpers = users
      .filter((u) => byUser.has(String(u._id)))
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

    res.json({ helpers, counts: await helperCounts() });
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
    const users = await User.find({ role: ROLES.CUSTOMER, ...search(req.query.q, ['name', 'phone']) })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    const counts = await Task.aggregate([
      { $match: { customerId: { $in: users.map((u) => u._id) } } },
      { $group: { _id: '$customerId', n: { $sum: 1 }, spend: { $sum: '$pricing.total' } } },
    ]);
    const byUser = new Map(counts.map((c) => [String(c._id), c]));

    res.json({
      customers: users.map((u) => ({
        id: String(u._id),
        name: u.name || 'Unnamed',
        phone: u.phone,
        photoUrl: u.photoUrl,
        accountStatus: u.status,
        createdAt: u.createdAt,
        bookings: byUser.get(String(u._id))?.n || 0,
        spend: Math.round((byUser.get(String(u._id))?.spend || 0) * 100) / 100,
      })),
    });
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
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.q) filter.code = { $regex: escapeRegex(req.query.q), $options: 'i' };

    const [tasks, counts] = await Promise.all([
      Task.find(filter)
        .populate('customerId', 'name phone')
        .populate('helperId', 'name phone')
        .sort({ createdAt: -1 })
        .limit(Number(req.query.limit) || 100)
        .lean(),
      Task.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);

    res.json({
      bookings: tasks.map(adminTask),
      counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
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

    const [timeline, requests, ratings] = await Promise.all([
      TaskEvent.find({ taskId: task._id }).sort({ at: 1 }).lean(),
      JobRequest.find({ taskId: task._id }).populate('helperId', 'name phone').sort({ round: 1, sentAt: 1 }).lean(),
      Rating.find({ taskId: task._id }).lean(),
    ]);

    res.json({
      task: {
        ...serializeTask(task, { audience: 'customer' }),
        customer: task.customerId
          ? { id: String(task.customerId._id), name: task.customerId.name, phone: task.customerId.phone }
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
 * Payment is settled directly between customer and helper, so "revenue" here
 * is what the platform is owed: the service fee on the customer's bill plus
 * the commission deducted from the helper's gross.
 */
router.get(
  '/finance',
  wrap(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (days - 1));

    const earned = { $in: [TASK_STATUS.COMPLETED, TASK_STATUS.SETTLED] };

    const [totals, byDay, ledgerByType, outstanding, recent, unpaid] = await Promise.all([
      Task.aggregate([
        { $match: { status: earned } },
        {
          $group: {
            _id: null,
            bookings: { $sum: 1 },
            gross: { $sum: '$pricing.total' },
            services: { $sum: '$pricing.servicesAmount' },
            platformFee: { $sum: '$pricing.platformFee' },
            surcharge: { $sum: '$pricing.surcharge' },
            gst: { $sum: '$pricing.gst' },
            commission: { $sum: '$pricing.helperCommission' },
            payout: { $sum: '$pricing.helperPayout' },
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
            platformEarned: { $sum: { $add: ['$pricing.platformFee', '$pricing.helperCommission'] } },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      LedgerEntry.aggregate([
        { $group: { _id: '$type', total: { $sum: '$amount' }, rows: { $sum: 1 } } },
      ]),
      LedgerEntry.aggregate([
        { $match: { type: 'PLATFORM_COMMISSION', settled: false } },
        { $group: { _id: '$userId', total: { $sum: '$amount' }, jobs: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 25 },
      ]),
      Task.find({ status: earned })
        .populate('customerId', 'name phone')
        .populate('helperId', 'name phone')
        .sort({ completedAt: -1 })
        .limit(40)
        .lean(),
      Task.countDocuments({ status: earned, paymentStatus: { $ne: 'PAID' } }),
    ]);

    const owedIds = outstanding.map((o) => o._id);
    const owedHelpers = await User.find({ _id: { $in: owedIds } }).select('name phone').lean();
    const owedProfiles = await HelperProfile.find({ userId: { $in: owedIds } })
      .select('userId paymentDetails')
      .lean();
    const nameById = new Map(owedHelpers.map((u) => [String(u._id), u]));
    const payById = new Map(owedProfiles.map((p) => [String(p.userId), p.paymentDetails]));

    const t = totals[0] || {};
    res.json({
      totals: {
        bookings: t.bookings || 0,
        gross: round(t.gross),
        services: round(t.services),
        platformFee: round(t.platformFee),
        surcharge: round(t.surcharge),
        gst: round(t.gst),
        commission: round(t.commission),
        helperPayout: round(t.payout),
        platformEarned: round((t.platformFee || 0) + (t.commission || 0)),
        awaitingPayment: unpaid,
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
      commissionOwed: outstanding.map((o) => ({
        helperId: String(o._id),
        name: nameById.get(String(o._id))?.name || 'Unknown',
        phone: nameById.get(String(o._id))?.phone || '',
        jobs: o.jobs,
        amount: round(o.total),
        paymentDetails: payById.get(String(o._id)) || null,
      })),
      bookings: recent.map((task) => ({
        id: String(task._id),
        code: task.code,
        completedAt: task.completedAt,
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
 * POST /api/admin/finance/settle/:helperId — the commission a helper owes has
 * been collected. Writes one ledger row per outstanding entry rather than
 * editing a balance, so the history stays readable.
 */
router.post(
  '/finance/settle/:helperId',
  wrap(async (req, res) => {
    const helper = await User.findOne({ _id: req.params.helperId, role: ROLES.HELPER }).lean();
    if (!helper) throw notFound('Helper not found.');

    const open = await LedgerEntry.find({
      userId: helper._id, type: 'PLATFORM_COMMISSION', settled: false,
    }).lean();
    if (!open.length) throw conflict('Nothing is outstanding for this helper.', 'NOTHING_OWED');

    const total = round(open.reduce((sum, e) => sum + e.amount, 0));
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
    const logs = await AuditLog.find()
      .populate('adminId', 'name email')
      .sort({ createdAt: -1 })
      .limit(Number(req.query.limit) || 100)
      .lean();
    res.json({ logs });
  }),
);

export default router;
