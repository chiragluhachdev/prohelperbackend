import { Router } from 'express';
import {
  Address, AuditLog, HelperDocument, HelperProfile, JobRequest,
  LedgerEntry, Rating, Service, Task, TaskEvent, User,
} from '../models/index.js';
import { ROLES, TASK_STATUS, HELPER_APPROVAL } from '../config.js';
import { authenticate, requireAdmin } from '../lib/auth.js';
import { wrap, badRequest, notFound, conflict } from '../lib/http.js';
import { serializeTask, STATUS_LABELS } from '../lib/views.js';
import { getSettings, updateSettings } from '../lib/settings.js';
import { notify } from '../lib/notify.js';
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

    const [
      customers, helpers, pendingApprovals, activeHelpers, onlineHelpers,
      todayBookings, activeTasks, completedTasks, cancelledTasks, noHelperTasks,
      blockedAccounts, revenueAgg, commissionAgg, recentTasks, pendingHelpers,
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
    ]);

    res.json({
      stats: {
        customers, helpers, pendingApprovals, activeHelpers, onlineHelpers,
        todayBookings, activeTasks, completedTasks, cancelledTasks, noHelperTasks,
        blockedAccounts,
        revenue: Math.round((revenueAgg[0]?.total || 0) * 100) / 100,
        outstandingCommission: Math.round((commissionAgg[0]?.total || 0) * 100) / 100,
      },
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
      Rating.find({ toUserId: user._id }).sort({ createdAt: -1 }).limit(10).lean(),
      LedgerEntry.aggregate([
        { $match: { userId: user._id } },
        { $group: { _id: '$type', total: { $sum: '$amount' } } },
      ]),
    ]);

    res.json({
      helper: {
        id: String(user._id),
        name: user.name, phone: user.phone, email: user.email,
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

    await notify(profile.userId, 'ACCOUNT_REJECTED', 'Verification needs attention', reason);
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
      remark || `Your ${doc.type.replace(/_/g, ' ')} was ${status.toLowerCase()}.`);
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
      Rating.find({ toUserId: user._id }).sort({ createdAt: -1 }).limit(10).lean(),
    ]);

    res.json({
      customer: {
        id: String(user._id), name: user.name, phone: user.phone, email: user.email,
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

    await notify(user._id, 'ACCOUNT_BLOCKED', 'Account blocked', reason);
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
    await notify(updated.customerId, 'BOOKING_CANCELLED', 'Booking cancelled', reason, { taskId: String(updated._id) });
    if (updated.helperId) await notify(updated.helperId, 'BOOKING_CANCELLED', 'Booking cancelled', reason, { taskId: String(updated._id) });
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

router.patch(
  '/services/:code',
  wrap(async (req, res) => {
    const service = await Service.findOne({ code: req.params.code });
    if (!service) throw notFound('Service not found.');

    const before = { basePrice: service.basePrice, active: service.active };
    if (req.body.basePrice != null) service.basePrice = Number(req.body.basePrice);
    if (req.body.active != null) service.active = Boolean(req.body.active);
    if (req.body.description != null) service.description = req.body.description;
    await service.save();

    await audit(req, {
      action: 'SERVICE_UPDATED', entity: 'Service', entityId: service.code,
      before, after: { basePrice: service.basePrice, active: service.active },
    });
    res.json({ service });
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
      patch[key] = typeof before[key] === 'number' ? Number(value) : value;
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
