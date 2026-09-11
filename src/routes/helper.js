import crypto from 'node:crypto';
import { Router } from 'express';
import {
  HelperDocument, HelperProfile, JobRequest, LedgerEntry,
  Rating, Service, Task, TaskEvent,
} from '../models/index.js';
import { ROLES, TASK_STATUS, HELPER_APPROVAL } from '../config.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { wrap, badRequest, notFound, conflict, forbidden } from '../lib/http.js';
import { serializeTask, TASK_TABS } from '../lib/views.js';
import { mustTransition } from '../lib/taskflow.js';
import { acceptJob, declineJob } from '../matching.js';
import { notify } from '../lib/notify.js';
import { getSettings } from '../lib/settings.js';
import { postEntry, earningsSummary } from '../lib/ledger.js';
import { upload, uploadBuffer, destroyAsset } from '../lib/cloudinary.js';
import { issueOtp, verifyOtp } from '../lib/otp.js';
import { publicUser } from './auth.js';
import { SOCIETIES, societyByCode } from '../constants/societies.js';

const router = Router();
router.use(authenticate, requireRole(ROLES.HELPER));

const loadProfile = wrap(async (req, _res, next) => {
  req.profile = await HelperProfile.findOne({ userId: req.user._id });
  if (!req.profile) req.profile = await HelperProfile.create({ userId: req.user._id });
  next();
});
router.use(loadProfile);

/** Job endpoints are closed until the admin has approved the helper (UC-C24). */
const requireApproved = (req, _res, next) => {
  if (req.profile.approvalStatus !== HELPER_APPROVAL.APPROVED) {
    return next(forbidden('Your account is still being verified.'));
  }
  next();
};

/* --------------------------------------------------------------- onboarding */

/** GET /api/helper/status — drives the "Verification status" screen. */
router.get(
  '/status',
  wrap(async (req, res) => {
    const documents = await HelperDocument.find({ helperId: req.user._id }).sort({ createdAt: -1 }).lean();
    res.json({
      user: publicUser(req.user),
      profile: req.profile.toObject(),
      checklist: req.profile.checklist(documents.length),
      documents,
      canGoOnline: req.profile.approvalStatus === HELPER_APPROVAL.APPROVED,
    });
  }),
);

router.patch(
  '/profile',
  wrap(async (req, res) => {
    const { name, gender, dob, experienceYears, bio } = req.body;
    if (name !== undefined) {
      if (!String(name).trim()) throw badRequest('Name cannot be empty.', 'NAME_REQUIRED');
      req.user.name = String(name).trim();
      await req.user.save();
    }
    if (gender !== undefined) req.profile.gender = gender;
    if (dob !== undefined) req.profile.dob = dob ? new Date(dob) : undefined;
    if (experienceYears !== undefined) req.profile.experienceYears = Number(experienceYears) || 0;
    if (bio !== undefined) req.profile.bio = String(bio);
    if (req.body.paymentDetails !== undefined) {
      req.profile.paymentDetails = {
        ...req.profile.paymentDetails,
        ...req.body.paymentDetails,
      };
    }
    await req.profile.save();
    res.json({ user: publicUser(req.user), profile: req.profile.toObject() });
  }),
);

router.post(
  '/profile/photo',
  upload.single('file'),
  wrap(async (req, res) => {
    let buffer = req.file?.buffer;
    let mimetype = req.file?.mimetype || 'image/jpeg';
    if (!buffer && req.body?.file && typeof req.body.file === 'string' && req.body.file.startsWith('data:')) {
      const parts = req.body.file.split(',');
      const match = parts[0].match(/:(.*?);/);
      if (match) mimetype = match[1];
      buffer = Buffer.from(parts[1], 'base64');
    }
    if (!buffer) throw badRequest('Choose a photo to upload.', 'FILE_REQUIRED');
    const result = await uploadBuffer(buffer, {
      folder: 'prohelper/helpers',
      publicId: `helper_${req.user._id}`,
      resourceType: 'image',
      privateFile: false,
    });
    req.user.photoUrl = result.secure_url;
    req.user.photoPublicId = result.public_id;
    await req.user.save();
    res.json({ user: publicUser(req.user) });
  }),
);

/**
 * POST /api/helper/kyc/aadhaar/request — UC-C24 step 6.
 *
 * The Aadhaar number is used to send the OTP and then thrown away; only the
 * last four digits are ever stored.
 */
router.post(
  '/kyc/aadhaar/request',
  wrap(async (req, res) => {
    const aadhaar = String(req.body.aadhaar || '').replace(/\D/g, '');
    if (aadhaar.length !== 12) throw badRequest('Enter your 12-digit Aadhaar number.', 'INVALID_AADHAAR');

    const phone = String(req.body.phone || '').replace(/\D/g, '');
    if (phone.length < 10) throw badRequest('Enter the mobile number linked to your Aadhaar.', 'INVALID_PHONE');

    req.profile.aadhaarLast4 = aadhaar.slice(-4);
    await req.profile.save();

    const result = await issueOtp(phone, { role: ROLES.HELPER, purpose: 'aadhaar' });
    res.json({ ...result, aadhaarLast4: req.profile.aadhaarLast4 });
  }),
);

router.post(
  '/kyc/aadhaar/verify',
  wrap(async (req, res) => {
    const phone = String(req.body.phone || req.user.phone).replace(/\D/g, '');
    await verifyOtp(phone, req.body.code, 'aadhaar');

    req.profile.kycStatus = 'VERIFIED';
    req.profile.kycMethod = req.body.method || 'aadhaar-otp';
    req.profile.kycVerifiedAt = new Date();
    if (req.body.name) req.profile.aadhaarName = String(req.body.name).trim();
    await req.profile.save();

    await notify(req.user._id, 'KYC_VERIFIED', 'Identity verified',
      'Your Aadhaar identity check is complete.');

    res.json({ profile: req.profile.toObject() });
  }),
);

/* ---------------------------------------------------------------- documents */

router.get(
  '/documents',
  wrap(async (req, res) => {
    const documents = await HelperDocument.find({ helperId: req.user._id }).sort({ createdAt: -1 }).lean();
    res.json({ documents });
  }),
);

/** Uploaded to Cloudinary with secure delivery for instant preview and admin verification. */
router.post(
  '/documents',
  upload.single('file'),
  wrap(async (req, res) => {
    const type = req.body.type;
    const allowed = ['aadhaar_front', 'aadhaar_back', 'police_clearance', 'address_proof', 'photo', 'other'];
    if (!allowed.includes(type)) throw badRequest('Choose a document type.', 'INVALID_DOC_TYPE');

    let buffer = req.file?.buffer;
    let mimetype = req.file?.mimetype || 'image/jpeg';
    let originalname = req.file?.originalname || `${type}.jpg`;
    let sizeBytes = req.file?.size;

    if (!buffer && req.body?.file && typeof req.body.file === 'string' && req.body.file.startsWith('data:')) {
      const parts = req.body.file.split(',');
      const match = parts[0].match(/:(.*?);/);
      if (match) mimetype = match[1];
      buffer = Buffer.from(parts[1], 'base64');
      sizeBytes = buffer.length;
    }

    if (!buffer) throw badRequest('Choose a file to upload.', 'FILE_REQUIRED');

    const result = await uploadBuffer(buffer, {
      folder: `prohelper/kyc/${req.user._id}`,
      publicId: `${type}_${crypto.randomBytes(4).toString('hex')}`,
      resourceType: mimetype === 'application/pdf' ? 'raw' : 'image',
      privateFile: false,
    });

    // Re-uploading a document type replaces the previous submission.
    const previous = await HelperDocument.findOne({ helperId: req.user._id, type });
    if (previous) {
      await destroyAsset(previous.publicId, previous.mimeType === 'application/pdf' ? 'raw' : 'image');
      await previous.deleteOne();
    }

    const doc = await HelperDocument.create({
      helperId: req.user._id,
      type,
      url: result.secure_url,
      publicId: result.public_id,
      originalName: originalname,
      mimeType: mimetype,
      sizeBytes: sizeBytes || buffer.length,
      status: 'PENDING',
    });
    res.status(201).json({ document: doc });
  }),
);

router.delete(
  '/documents/:id',
  wrap(async (req, res) => {
    const doc = await HelperDocument.findOne({ _id: req.params.id, helperId: req.user._id });
    if (!doc) throw notFound('Document not found.');
    if (doc.status === 'APPROVED') throw conflict('An approved document cannot be removed.', 'DOC_APPROVED');
    await destroyAsset(doc.publicId, doc.mimeType === 'application/pdf' ? 'raw' : 'image');
    await doc.deleteOne();
    res.json({ ok: true });
  }),
);

/* --------------------------------------------------- services / area / hours */

router.put(
  '/services',
  wrap(async (req, res) => {
    const codes = Array.isArray(req.body.codes) ? req.body.codes : [];
    if (!codes.length) throw badRequest('Select at least one service.', 'NO_SERVICES');

    const valid = await Service.find({ code: { $in: codes }, active: true }).select('code').lean();
    if (valid.length !== codes.length) throw badRequest('One of those services is unavailable.', 'INVALID_SERVICE');

    req.profile.services = valid.map((s) => s.code);
    await req.profile.save();
    res.json({ profile: req.profile.toObject() });
  }),
);

/**
 * Where a helper will work, as one or more serviced societies.
 *
 * `serviceArea` is still written — set to the centre of the first society —
 * because the distance helper and the admin dashboard read it, but `societies`
 * is what matching actually uses.
 */
router.put(
  '/service-area',
  wrap(async (req, res) => {
    const codes = Array.isArray(req.body.societies) ? req.body.societies : [];
    const chosen = codes.map(societyByCode).filter(Boolean);

    if (chosen.length === 0) {
      throw badRequest('Choose at least one society you can work in.', 'NO_SOCIETY');
    }
    if (chosen.length !== codes.length) {
      throw badRequest('One of those societies is not served yet.', 'UNKNOWN_SOCIETY');
    }

    req.profile.societies = chosen.map((c) => c.code);
    req.profile.serviceArea = {
      label: chosen.map((c) => c.name).join(', '),
      lat: chosen[0].lat,
      lng: chosen[0].lng,
      // Society-level matching, so the radius only needs to cover the estate.
      radiusKm: 3,
    };
    await req.profile.save();
    res.json({ profile: req.profile.toObject() });
  }),
);

/** The societies a helper can pick from. */
router.get('/societies', wrap(async (_req, res) => res.json({ societies: SOCIETIES })));

/** UC-C14 — outside these hours the matcher will not alert this helper. */
router.put(
  '/availability',
  wrap(async (req, res) => {
    const { workDays, workStart, workEnd } = req.body;
    if (Array.isArray(workDays)) {
      const days = workDays.map(Number).filter((d) => d >= 0 && d <= 6);
      if (!days.length) throw badRequest('Choose at least one working day.', 'NO_WORK_DAYS');
      req.profile.workDays = [...new Set(days)];
    }
    if (workStart) req.profile.workStart = workStart;
    if (workEnd) req.profile.workEnd = workEnd;
    await req.profile.save();
    res.json({ profile: req.profile.toObject() });
  }),
);

/** POST /api/helper/submit — hands the profile to the admin queue. */
router.post(
  '/submit',
  wrap(async (req, res) => {
    const docCount = await HelperDocument.countDocuments({ helperId: req.user._id });
    const checklist = req.profile.checklist(docCount);

    const missing = Object.entries(checklist)
      .filter(([key, done]) => key !== 'documents' && !done)
      .map(([key]) => key);
    if (!req.user.name) missing.unshift('name');
    if (missing.length) {
      throw badRequest(`Still to do: ${missing.join(', ')}.`, 'ONBOARDING_INCOMPLETE', { missing });
    }
    if (req.profile.approvalStatus === HELPER_APPROVAL.APPROVED) {
      throw conflict('Your account is already approved.', 'ALREADY_APPROVED');
    }

    req.profile.approvalStatus = HELPER_APPROVAL.PENDING_VERIFICATION;
    req.profile.submittedAt = new Date();
    req.profile.rejectionReason = '';
    await req.profile.save();

    await notify(req.user._id, 'KYC_SUBMITTED', 'Profile submitted',
      'Our team is reviewing your details. You will be notified once approved.');

    res.json({ profile: req.profile.toObject() });
  }),
);

/* ------------------------------------------------------------- availability */

/** POST /api/helper/online — the Go Online / Go Offline switch. */
router.post(
  '/online',
  requireApproved,
  wrap(async (req, res) => {
    req.profile.isOnline = Boolean(req.body.isOnline);
    if (req.profile.isOnline) req.profile.dnd = false;
    await req.profile.save();
    res.json({ isOnline: req.profile.isOnline, dnd: req.profile.dnd });
  }),
);

router.post(
  '/dnd',
  requireApproved,
  wrap(async (req, res) => {
    req.profile.dnd = Boolean(req.body.dnd);
    if (req.profile.dnd) req.profile.isOnline = false;
    await req.profile.save();
    res.json({ isOnline: req.profile.isOnline, dnd: req.profile.dnd });
  }),
);

/* --------------------------------------------------------------------- home */

/** GET /api/helper/home — the dashboard header numbers plus what's next. */
router.get(
  '/home',
  wrap(async (req, res) => {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay); endOfDay.setDate(endOfDay.getDate() + 1);

    const [todayCount, earnings, upcoming] = await Promise.all([
      Task.countDocuments({
        helperId: req.user._id,
        scheduledAt: { $gte: startOfDay, $lt: endOfDay },
        status: { $in: [TASK_STATUS.ACCEPTED, TASK_STATUS.IN_PROGRESS, TASK_STATUS.COMPLETION_PENDING, TASK_STATUS.COMPLETED] },
      }),
      earningsSummary(req.user._id),
      Task.find({
        helperId: req.user._id,
        status: { $in: [TASK_STATUS.ACCEPTED, TASK_STATUS.IN_PROGRESS, TASK_STATUS.COMPLETION_PENDING] },
      })
        .populate('customerId', 'name phone photoUrl')
        .sort({ scheduledAt: 1 })
        .limit(5),
    ]);

    res.json({
      greetingName: req.user.name || 'there',
      isOnline: req.profile.isOnline,
      dnd: req.profile.dnd,
      approvalStatus: req.profile.approvalStatus,
      rating: req.profile.ratingAvg,
      ratingCount: req.profile.ratingCount,
      todayJobs: todayCount,
      earnings,
      upcoming: upcoming.map((t) => serializeTask(t, { audience: 'helper' })),
    });
  }),
);

/* ----------------------------------------------------------- job requests ⭐ */

/**
 * GET /api/helper/requests — the live alerts, with the seconds remaining
 * computed from the server's expiry, never from the phone's clock (UC-C52).
 */
router.get(
  '/requests',
  requireApproved,
  wrap(async (req, res) => {
    const now = new Date();
    const requests = await JobRequest.find({
      helperId: req.user._id,
      status: 'SENT',
      expiresAt: { $gt: now },
    })
      .sort({ sentAt: 1 })
      .lean();

    if (!requests.length) return res.json({ requests: [] });

    const tasks = await Task.find({
      _id: { $in: requests.map((r) => r.taskId) },
      status: TASK_STATUS.SEARCHING,
    })
      .populate('customerId', 'name photoUrl')
      .lean();
    const byId = new Map(tasks.map((t) => [String(t._id), t]));

    const payload = requests
      .filter((r) => byId.has(String(r.taskId)))
      .map((r) => ({
        requestId: String(r._id),
        secondsLeft: Math.max(0, Math.round((new Date(r.expiresAt) - now) / 1000)),
        expiresAt: r.expiresAt,
        distanceKm: r.distanceKm,
        matchedAllServices: r.matchedAllServices,
        task: serializeTask(byId.get(String(r.taskId)), { audience: 'helper' }),
      }));

    res.json({ requests: payload });
  }),
);

router.post(
  '/requests/:taskId/accept',
  requireApproved,
  wrap(async (req, res) => {
    const { task } = await acceptJob(req.params.taskId, req.user._id);
    const populated = await Task.findById(task._id).populate('customerId', 'name phone photoUrl');
    res.json({ task: serializeTask(populated, { audience: 'helper' }) });
  }),
);

router.post(
  '/requests/:taskId/decline',
  requireApproved,
  wrap(async (req, res) => {
    await declineJob(req.params.taskId, req.user._id);
    res.json({ ok: true });
  }),
);

/* --------------------------------------------------------------------- jobs */

router.get(
  '/jobs',
  wrap(async (req, res) => {
    const filter = { helperId: req.user._id };
    const tab = req.query.tab;
    if (tab) {
      if (!TASK_TABS[tab]) throw badRequest('Unknown tab.', 'INVALID_TAB');
      filter.status = { $in: TASK_TABS[tab] };
    }
    const tasks = await Task.find(filter)
      .populate('customerId', 'name phone photoUrl')
      .sort({ scheduledAt: -1 })
      .limit(Number(req.query.limit) || 50);
    res.json({ tasks: tasks.map((t) => serializeTask(t, { audience: 'helper' })) });
  }),
);

router.get(
  '/jobs/:id',
  wrap(async (req, res) => {
    const task = await Task.findOne({ _id: req.params.id, helperId: req.user._id })
      .populate('customerId', 'name phone photoUrl');
    if (!task) throw notFound('Job not found.');
    const timeline = await TaskEvent.find({ taskId: task._id }).sort({ at: 1 }).lean();
    res.json({ task: serializeTask(task, { audience: 'helper' }), timeline });
  }),
);

/** POST /api/helper/jobs/:id/start — UC-C16. */
router.post(
  '/jobs/:id/start',
  requireApproved,
  wrap(async (req, res) => {
    const task = await mustTransition(req.params.id, [TASK_STATUS.ACCEPTED], TASK_STATUS.IN_PROGRESS, {
      set: { startedAt: new Date() },
      extraFilter: { helperId: req.user._id },
      actorType: 'helper', actorId: req.user._id, reason: 'Helper started the job',
    });
    await notify(task.customerId, 'TASK_STARTED', 'Work started',
      `Your helper has started ${task.code}.`, { taskId: String(task._id) });
    res.json({ task: serializeTask(task, { audience: 'helper' }) });
  }),
);

/**
 * POST /api/helper/jobs/:id/completion-otp — UC-C17.
 *
 * The code is generated here, on the server, and delivered to the *customer*.
 * The helper has to be told it in person, which is what makes it a proof of
 * completion rather than a button the helper can press alone.
 */
router.post(
  '/jobs/:id/completion-otp',
  requireApproved,
  wrap(async (req, res) => {
    const settings = await getSettings();
    const code = String(crypto.randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + settings.completion_otp_ttl_seconds * 1000);

    const task = await mustTransition(
      req.params.id,
      [TASK_STATUS.IN_PROGRESS, TASK_STATUS.COMPLETION_PENDING],
      TASK_STATUS.COMPLETION_PENDING,
      {
        set: {
          completionRequestedAt: new Date(),
          'completionOtp.code': code,
          'completionOtp.expiresAt': expiresAt,
          'completionOtp.attempts': 0,
          'completionOtp.issuedAt': new Date(),
        },
        extraFilter: { helperId: req.user._id },
        actorType: 'helper', actorId: req.user._id, reason: 'Completion OTP requested',
      },
    );

    await notify(task.customerId, 'COMPLETION_OTP', 'Confirm job completion',
      `Share code ${code} with your helper to close ${task.code}.`,
      { taskId: String(task._id), code });

    console.log(`[completion] ${task.code} otp → ${code}`);
    res.json({ sent: true, expiresAt, expiresInSeconds: settings.completion_otp_ttl_seconds });
  }),
);

/** POST /api/helper/jobs/:id/complete — validates the OTP, then books the money. */
router.post(
  '/jobs/:id/complete',
  requireApproved,
  wrap(async (req, res) => {
    const settings = await getSettings();
    const entered = String(req.body.otp || '').trim();

    const task = await Task.findOne({ _id: req.params.id, helperId: req.user._id }).select('+completionOtp.code');
    if (!task) throw notFound('Job not found.');
    if (task.status !== TASK_STATUS.COMPLETION_PENDING) {
      throw conflict('Request the completion OTP first.', 'OTP_NOT_REQUESTED');
    }
    if (!task.completionOtp?.code) throw conflict('Request the completion OTP first.', 'OTP_NOT_REQUESTED');
    if (task.completionOtp.expiresAt < new Date()) throw badRequest('That OTP has expired. Request a new one.', 'OTP_EXPIRED');
    if (task.completionOtp.attempts >= settings.completion_otp_max_attempts) {
      throw badRequest('Too many incorrect attempts. Request a new OTP.', 'OTP_ATTEMPTS_EXCEEDED');
    }

    if (task.completionOtp.code !== entered) {
      task.completionOtp.attempts += 1;
      await task.save();
      const left = settings.completion_otp_max_attempts - task.completionOtp.attempts;
      throw badRequest(`Incorrect OTP. ${left} attempt${left === 1 ? '' : 's'} left.`, 'OTP_INVALID');
    }

    const completedAt = new Date();
    const completed = await mustTransition(task._id, [TASK_STATUS.COMPLETION_PENDING], TASK_STATUS.COMPLETED, {
      set: { completedAt, paymentStatus: 'PAID' },
      unset: { 'completionOtp.code': '' },
      extraFilter: { helperId: req.user._id },
      actorType: 'helper', actorId: req.user._id, reason: 'Completed with customer OTP',
    });

    // Money is written as ledger rows, keyed so a retry cannot pay twice.
    const { helperPayout = 0, helperCommission = 0, currency = 'INR' } = completed.pricing || {};
    await postEntry({
      userId: req.user._id, taskId: completed._id, type: 'JOB_EARNING', direction: 'CREDIT',
      amount: helperPayout, currency, note: `Earning for ${completed.code}`, ref: `earning:${completed._id}`,
    });
    if (helperCommission > 0) {
      await postEntry({
        userId: req.user._id, taskId: completed._id, type: 'PLATFORM_COMMISSION', direction: 'DEBIT',
        amount: helperCommission, currency, note: `Platform commission for ${completed.code}`,
        ref: `commission:${completed._id}`,
      });
    }

    await HelperProfile.updateOne({ userId: req.user._id }, { $inc: { completedJobs: 1 } });
    await notify(completed.customerId, 'TASK_COMPLETED', 'Job completed',
      `${completed.code} is complete. Rate your helper.`, { taskId: String(completed._id) });

    res.json({
      task: serializeTask(completed, { audience: 'helper' }),
      earning: helperPayout,
    });
  }),
);

/** UC-C21 — the helper rates the customer. */
router.post(
  '/jobs/:id/rate',
  wrap(async (req, res) => {
    const stars = Number(req.body.stars);
    if (!(stars >= 1 && stars <= 5)) throw badRequest('Choose between 1 and 5 stars.', 'INVALID_RATING');

    const task = await Task.findOne({ _id: req.params.id, helperId: req.user._id });
    if (!task) throw notFound('Job not found.');
    if (![TASK_STATUS.COMPLETED, TASK_STATUS.SETTLED].includes(task.status)) {
      throw conflict('You can only rate a completed job.', 'NOT_COMPLETED');
    }

    try {
      await Rating.create({
        taskId: task._id, direction: 'helper_to_customer',
        fromUserId: req.user._id, toUserId: task.customerId,
        stars, comment: req.body.comment || '',
      });
    } catch (err) {
      if (err?.code === 11000) throw conflict('You have already rated this job.', 'ALREADY_RATED');
      throw err;
    }

    task.ratedByHelper = true;
    await task.save();
    res.status(201).json({ ok: true, stars });
  }),
);

/* ----------------------------------------------------------------- earnings */

/** GET /api/helper/earnings — UC-C26, straight off the ledger. */
router.get(
  '/earnings',
  wrap(async (req, res) => {
    const [summary, entries, outstanding] = await Promise.all([
      earningsSummary(req.user._id),
      LedgerEntry.find({ userId: req.user._id })
        .populate('taskId', 'code services scheduledAt')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      LedgerEntry.aggregate([
        { $match: { userId: req.user._id, type: 'PLATFORM_COMMISSION', settled: false } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    res.json({
      summary: { ...summary, commissionOutstanding: Math.round((outstanding[0]?.total || 0) * 100) / 100 },
      entries: entries.map((e) => ({
        id: String(e._id),
        type: e.type,
        direction: e.direction,
        amount: e.amount,
        note: e.note,
        createdAt: e.createdAt,
        task: e.taskId ? { code: e.taskId.code, services: e.taskId.services?.map((s) => s.name) } : null,
      })),
    });
  }),
);

export default router;
