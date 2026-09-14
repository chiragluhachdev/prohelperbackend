import { Router } from 'express';
import { Address, HelperProfile, JobRequest, Rating, Service, Task, TaskEvent } from '../models/index.js';
import { ROLES, TASK_STATUS } from '../config.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { wrap, badRequest, notFound, conflict } from '../lib/http.js';
import { quote } from '../lib/pricing.js';
import { serializeTask, TASK_TABS } from '../lib/views.js';
import { newTaskCode, mustTransition, transition } from '../lib/taskflow.js';
import { searchFields, startSearch } from '../matching.js';
import { closeJobAlerts, notify } from '../lib/notify.js';
import { postEntry } from '../lib/ledger.js';
import { redeemForBooking, usableForBooking } from '../lib/referral.js';
import { ensureStartCode, startCodeFields } from '../lib/startCode.js';
import { getSettings } from '../lib/settings.js';
import { upload, uploadBuffer } from '../lib/cloudinary.js';
import { publicUser } from './auth.js';
import { SOCIETIES, societyByCode } from '../constants/societies.js';

const router = Router();
router.use(authenticate, requireRole(ROLES.CUSTOMER));

/* ------------------------------------------------------------------ profile */

/** PATCH /api/customer/profile — UC-C02. */
router.patch(
  '/profile',
  wrap(async (req, res) => {
    const { name, email } = req.body;
    if (name !== undefined) {
      if (!String(name).trim()) throw badRequest('Name cannot be empty.', 'NAME_REQUIRED');
      req.user.name = String(name).trim();
    }
    if (email !== undefined) req.user.email = String(email).trim().toLowerCase() || undefined;
    await req.user.save();
    res.json({ user: publicUser(req.user) });
  }),
);

router.post(
  '/profile/photo',
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw badRequest('Choose a photo to upload.', 'FILE_REQUIRED');
    const result = await uploadBuffer(req.file.buffer, {
      folder: 'prohelper/customers',
      publicId: `customer_${req.user._id}`,
      resourceType: 'image',
    });
    req.user.photoUrl = result.secure_url;
    req.user.photoPublicId = result.public_id;
    await req.user.save();
    res.json({ user: publicUser(req.user) });
  }),
);

/* ---------------------------------------------------------------- addresses */

router.get(
  '/addresses',
  wrap(async (req, res) => {
    const addresses = await Address.find({ userId: req.user._id, active: true })
      .sort({ isDefault: -1, createdAt: -1 })
      .lean();
    res.json({ addresses });
  }),
);

/** POST /api/customer/addresses — UC-C03. The first one saved becomes default. */
/** The societies a customer can book in. */
router.get('/societies', wrap(async (_req, res) => res.json({ societies: SOCIETIES })));

router.post(
  '/addresses',
  wrap(async (req, res) => {
    const { label = 'Home', line1, line2 = '', landmark = '' } = req.body;
    if (!String(line1 || '').trim()) throw badRequest('Enter your flat or house number.', 'LINE1_REQUIRED');

    // The society supplies city, pincode and coordinates — the customer only
    // picks which one they live in.
    const society = societyByCode(req.body.society);
    if (!society) throw badRequest('Choose your society.', 'SOCIETY_REQUIRED');
    const city = society.city;
    const pincode = society.pincode;
    const lat = society.lat;
    const lng = society.lng;

    const count = await Address.countDocuments({ userId: req.user._id, active: true });
    const isDefault = count === 0 || Boolean(req.body.isDefault);
    if (isDefault) await Address.updateMany({ userId: req.user._id }, { $set: { isDefault: false } });

    const address = await Address.create({
      userId: req.user._id,
      label,
      line1,
      line2: line2 || `${society.name}, ${society.area}`,
      landmark,
      city,
      pincode,
      society: society.code,
      lat,
      lng,
      isDefault,
    });
    res.status(201).json({ address });
  }),
);

router.patch(
  '/addresses/:id',
  wrap(async (req, res) => {
    const address = await Address.findOne({ _id: req.params.id, userId: req.user._id, active: true });
    if (!address) throw notFound('Address not found.');

    for (const field of ['label', 'line1', 'line2', 'landmark']) {
      if (req.body[field] !== undefined) address[field] = req.body[field];
    }

    /*
     * Changing society has to carry its city, pincode and coordinates with it,
     * exactly as creating one does — otherwise an edited address keeps the old
     * estate's location and matching sends the helper to the wrong gate.
     */
    if (req.body.society !== undefined) {
      const society = societyByCode(req.body.society);
      if (!society) throw badRequest('Choose your society.', 'SOCIETY_REQUIRED');
      address.society = society.code;
      address.line2 = req.body.line2 || `${society.name}, ${society.area}`;
      address.city = society.city;
      address.pincode = society.pincode;
      address.lat = society.lat;
      address.lng = society.lng;
    }
    if (req.body.isDefault) {
      await Address.updateMany({ userId: req.user._id }, { $set: { isDefault: false } });
      address.isDefault = true;
    }
    await address.save();
    res.json({ address });
  }),
);

/** Soft delete — past bookings keep their own snapshot, so nothing is lost. */
router.delete(
  '/addresses/:id',
  wrap(async (req, res) => {
    const address = await Address.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { active: false, isDefault: false } },
      { new: true },
    );
    if (!address) throw notFound('Address not found.');

    // Never leave the customer without a default.
    const remaining = await Address.findOne({ userId: req.user._id, active: true }).sort({ createdAt: 1 });
    if (remaining && !(await Address.exists({ userId: req.user._id, active: true, isDefault: true }))) {
      remaining.isDefault = true;
      await remaining.save();
    }
    res.json({ ok: true });
  }),
);

/* -------------------------------------------------------------------- quote */

/** POST /api/customer/quote — the bill preview, computed server-side (UC-C07). */
router.post(
  '/quote',
  wrap(async (req, res) => {
    const { pricing, lines } = await quote(req.body.services, { durationMins: req.body.durationMins });
    // Referral balance is offered on every bill and only taken off when asked for.
    const { balance, usable, cap, percent } = await usableForBooking(req.user, pricing.total);
    if (req.body.useReferral && usable > 0) pricing.referralCredit = usable;
    res.json({
      lines,
      pricing: { ...pricing, amountDue: Math.round((pricing.total - (pricing.referralCredit || 0)) * 100) / 100 },
      // `limited`: they have more than this booking allows — the cap, not the balance, set `usable`.
      referral: { balance, usable, maxPercent: percent, limited: balance > cap },
    });
  }),
);

/* -------------------------------------------------------------------- tasks */

/**
 * POST /api/customer/tasks — UC-C06.
 *
 * `idempotencyKey` makes a double-tap harmless: the second call finds the task
 * the first one created and returns it instead of booking twice (UC-C49/C50).
 */
router.post(
  '/tasks',
  wrap(async (req, res) => {
    const {
      services, addressId, date, time, bookingType,
      durationMins, instructions = '', idempotencyKey, useReferral,
    } = req.body;
    const instant = bookingType === 'instant';

    if (!req.user.name) throw badRequest('Complete your profile before booking.', 'PROFILE_INCOMPLETE');
    if (!idempotencyKey) throw badRequest('Missing idempotency key.', 'IDEMPOTENCY_KEY_REQUIRED');

    const existing = await Task.findOne({ idempotencyKey, customerId: req.user._id });
    if (existing) return res.status(200).json({ task: serializeTask(existing), duplicate: true });

    const address = await Address.findOne({ _id: addressId, userId: req.user._id, active: true }).lean();
    if (!address) throw badRequest('Choose a valid address.', 'ADDRESS_REQUIRED');

    /*
     * An instant booking is timed by the server, not the phone. Trusting a
     * client clock here would put "now" a few minutes in the past on a device
     * that is running slow, and the past-time guard below would reject it.
     */
    let scheduledAt;
    let scheduledDate;
    let scheduledTime;

    if (instant) {
      scheduledAt = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      scheduledDate = `${scheduledAt.getFullYear()}-${pad(scheduledAt.getMonth() + 1)}-${pad(scheduledAt.getDate())}`;
      scheduledTime = `${pad(scheduledAt.getHours())}:${pad(scheduledAt.getMinutes())}`;
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw badRequest('Choose a date.', 'DATE_REQUIRED');
      if (!/^\d{2}:\d{2}$/.test(String(time || ''))) throw badRequest('Choose a time.', 'TIME_REQUIRED');

      scheduledAt = new Date(`${date}T${time}:00`);
      if (Number.isNaN(scheduledAt.getTime())) throw badRequest('That date and time is not valid.', 'INVALID_SCHEDULE');
      if (scheduledAt.getTime() < Date.now() - 5 * 60_000) {
        throw badRequest('Pick a time in the future.', 'SCHEDULE_IN_PAST');
      }
      scheduledDate = date;
      scheduledTime = time;
    }

    const { lines, pricing } = await quote(services, { durationMins });
    if (useReferral) {
      const { usable } = await usableForBooking(req.user, pricing.total);
      if (usable > 0) pricing.referralCredit = usable;
    }

    const catalog = await Service.find({ code: { $in: lines.map((l) => l.code) } }).select('code defaultDurationMins').lean();
    const fallbackDuration = catalog.reduce((sum, s) => sum + (s.defaultDurationMins || 60), 0) || 60;

    let task;
    try {
      task = await Task.create({
        code: newTaskCode(),
        customerId: req.user._id,
        services: lines,
        address: {
          addressId: address._id,
          society: address.society,
          label: address.label, line1: address.line1, line2: address.line2,
          landmark: address.landmark, city: address.city, pincode: address.pincode,
          lat: address.lat, lng: address.lng,
        },
        bookingType: instant ? 'instant' : 'scheduled',
        scheduledAt,
        scheduledDate,
        scheduledTime,
        durationMins: Number(durationMins) || fallbackDuration,
        instructions,
        pricing,
        idempotencyKey,
        status: TASK_STATUS.CREATED,
      });
    } catch (err) {
      if (err?.code === 11000) {
        const dupe = await Task.findOne({ idempotencyKey, customerId: req.user._id });
        if (dupe) return res.status(200).json({ task: serializeTask(dupe), duplicate: true });
      }
      throw err;
    }

    await TaskEvent.create({
      taskId: task._id, from: null, to: TASK_STATUS.CREATED,
      actorType: 'customer', actorId: req.user._id, reason: 'Request created',
    });

    // Spend the referral balance the bill was priced with. If another booking
    // spent it in the same instant, this one simply goes ahead at full price.
    if (pricing.referralCredit > 0 && !(await redeemForBooking(req.user._id, task, pricing.referralCredit))) {
      await Task.updateOne({ _id: task._id }, { $set: { 'pricing.referralCredit': 0 } });
      task.pricing.referralCredit = 0;
    }

    const searching = await startSearch(task._id, req.user._id);
    await notify(req.user._id, 'BOOKING_CREATED', 'Request created',
      instant
        ? `We are finding a helper for ${task.code} right now.`
        : `We are finding a helper for ${task.code}.`,
      { taskId: String(task._id), code: task.code, bookingType: task.bookingType });

    res.status(201).json({ task: serializeTask(searching || task) });
  }),
);

/** GET /api/customer/tasks?tab=upcoming|active|completed|cancelled */
router.get(
  '/tasks',
  wrap(async (req, res) => {
    const filter = { customerId: req.user._id };
    const tab = req.query.tab;
    if (tab) {
      if (!TASK_TABS[tab]) throw badRequest('Unknown tab.', 'INVALID_TAB');
      filter.status = { $in: TASK_TABS[tab] };
    }

    const [tasks, settings] = await Promise.all([
      Task.find(filter)
        .populate('helperId', 'name phone photoUrl')
        .select('+startOtp.code')
        .sort({ scheduledAt: -1 })
        .limit(Number(req.query.limit) || 50),
      getSettings(),
    ]);

    res.json({
      tasks: tasks.map((t) => {
        const view = serializeTask(t);
        if (settings.start_otp_enabled === false) view.startOtp = null;
        return view;
      }),
    });
  }),
);

router.get(
  '/tasks/:id',
  wrap(async (req, res) => {
    const task = await Task.findOne({ _id: req.params.id, customerId: req.user._id })
      .populate('helperId', 'name phone photoUrl')
      .select('+completionOtp.code +startOtp.code');
    if (!task) throw notFound('Booking not found.');

    // Bookings accepted before start codes existed get one the first time they are opened.
    const startCodeOn = (await getSettings()).start_otp_enabled !== false;
    if (startCodeOn && task.status === TASK_STATUS.ACCEPTED && !task.startOtp?.code) {
      task.set('startOtp.code', await ensureStartCode(task._id));
    }

    const helperProfile = task.helperId
      ? await HelperProfile.findOne({ userId: task.helperId._id }).select('ratingAvg completedJobs jobsShown experienceYears').lean()
      : null;
    const timeline = await TaskEvent.find({ taskId: task._id }).sort({ at: 1 }).lean();

    const view = serializeTask(task, { audience: 'customer', helperProfile });
    if (!startCodeOn) view.startOtp = null;
    res.json({ task: view, timeline });
  }),
);

/**
 * POST /api/customer/tasks/:id/cancel — UC-C22.
 *
 * A job already under way can still be called off: the customer is in the
 * house and things change. Once the completion OTP has been issued the work is
 * finished and only payment is left, so that is where the door closes.
 *
 * The reason is mandatory. It is the only record of why a helper lost a job,
 * so the admin can tell an unlucky helper from a repeatedly cancelled one.
 */
router.post(
  '/tasks/:id/cancel',
  wrap(async (req, res) => {
    const task = await Task.findOne({ _id: req.params.id, customerId: req.user._id });
    if (!task) throw notFound('Booking not found.');

    const reason = String(req.body.reason || '').trim();
    if (reason.length < 3) {
      throw badRequest('Please tell us why you are cancelling.', 'REASON_REQUIRED');
    }

    const cancellable = [
      TASK_STATUS.CREATED,
      TASK_STATUS.SEARCHING,
      TASK_STATUS.NO_HELPER_AVAILABLE,
      TASK_STATUS.ACCEPTED,
      TASK_STATUS.IN_PROGRESS,
    ];
    if (!cancellable.includes(task.status)) {
      throw conflict('This booking can no longer be cancelled.', 'NOT_CANCELLABLE');
    }
    const wasUnderWay = task.status === TASK_STATUS.IN_PROGRESS;

    const updated = await mustTransition(task._id, cancellable, TASK_STATUS.CANCELLED, {
      set: {
        nextDispatchAt: null,
        cancellation: {
          by: 'customer', byUserId: req.user._id,
          reason,
          previousStatus: task.status, at: new Date(),
        },
      },
      actorType: 'customer', actorId: req.user._id, reason,
    });

    /* A cancelled search must stop ringing on every helper it reached, and
       its open alerts must stop counting as live offers. */
    await JobRequest.updateMany({ taskId: task._id, status: 'SENT' }, { $set: { status: 'CANCELLED' } });
    await closeJobAlerts(task._id);

    if (updated.helperId) {
      await notify(
        updated.helperId,
        'BOOKING_CANCELLED',
        wasUnderWay ? 'Job stopped' : 'Booking cancelled',
        wasUnderWay
          ? `The customer has stopped ${updated.code}: ${reason}`
          : `${updated.code} was cancelled by the customer. Reason: ${reason}`,
        { taskId: String(updated._id), code: updated.code, reason, by: 'customer', stopped: wasUnderWay ? '1' : '' },
      );
    }
    res.json({ task: serializeTask(updated) });
  }),
);

/** POST /api/customer/tasks/:id/retry — UC-C13 "Try again". */
router.post(
  '/tasks/:id/retry',
  wrap(async (req, res) => {
    const task = await Task.findOne({ _id: req.params.id, customerId: req.user._id });
    if (!task) throw notFound('Booking not found.');

    // A fresh search, planned for how far away the slot now is: helpers who
    // declined last time may say yes now.
    const updated = await transition(task._id, [TASK_STATUS.NO_HELPER_AVAILABLE], TASK_STATUS.SEARCHING, {
      set: searchFields(task, await getSettings()),
      actorType: 'customer', actorId: req.user._id, reason: 'Customer retried the search',
    });
    if (!updated) throw conflict('This booking is not waiting for a helper.', 'INVALID_STATE');

    res.json({ task: serializeTask(updated) });
  }),
);

/**
 * POST /api/customer/tasks/:id/pay — a dummy in-app UPI payment. There is no
 * real gateway behind this yet, so it always succeeds once called: it stands
 * in for the moment a real one would confirm the charge.
 *
 * Because the money lands with the platform, not the helper, the helper does
 * not owe anything back for this job — only their payout is booked.
 */
router.post(
  '/tasks/:id/pay',
  wrap(async (req, res) => {
    const task = await Task.findOne({ _id: req.params.id, customerId: req.user._id }).lean();
    if (!task) throw notFound('Booking not found.');
    if (task.status !== TASK_STATUS.COMPLETED) {
      throw conflict('This booking is not awaiting payment.', 'NOT_AWAITING_PAYMENT');
    }
    if (task.paymentStatus === 'PAID') throw conflict('This booking has already been paid for.', 'ALREADY_PAID');
    if (!task.helperId) throw conflict('This booking had no helper.', 'NO_HELPER');

    const paidAt = new Date();
    const settled = await mustTransition(task._id, [TASK_STATUS.COMPLETED], TASK_STATUS.SETTLED, {
      set: { settledAt: paidAt, paymentStatus: 'PAID', paymentMode: 'ONLINE', paidAt, paidBy: req.user._id, paidByRole: 'customer' },
      extraFilter: { customerId: req.user._id },
      actorType: 'customer', actorId: req.user._id, reason: 'Paid online in the app',
    });

    const { helperPayout = 0, currency = 'INR' } = settled.pricing || {};
    if (settled.helperId) {
      // Collected by the platform, so this is booked as owed *to* the helper —
      // a payout still pending, not something they owe back (see finance).
      await postEntry({
        userId: settled.helperId, taskId: settled._id, type: 'JOB_EARNING', direction: 'CREDIT',
        amount: helperPayout, currency, note: `Earning for ${settled.code} (paid online)`,
        ref: `earning:${settled._id}`,
      });
      await notify(settled.helperId, 'PAYMENT_RECEIVED', 'Paid online',
        `The customer paid online for ${settled.code}.`, { taskId: String(settled._id), code: settled.code, amount: String(helperPayout) });
    }

    const due = Math.round(((settled.pricing?.total || 0) - (settled.pricing?.referralCredit || 0)) * 100) / 100;
    res.json({ task: serializeTask(settled), receipt: { amount: due, paidAt, method: 'ONLINE' } });
  }),
);

/**
 * POST /api/customer/tasks/:id/start-code — a new start code. For when the
 * helper has used up their tries, or the customer thinks the code was seen by
 * someone else; the old code stops working immediately.
 */
router.post(
  '/tasks/:id/start-code',
  wrap(async (req, res) => {
    const updated = await Task.findOneAndUpdate(
      { _id: req.params.id, customerId: req.user._id, status: TASK_STATUS.ACCEPTED },
      { $set: startCodeFields() },
      { new: true },
    ).select('+startOtp.code');
    if (!updated) {
      const exists = await Task.exists({ _id: req.params.id, customerId: req.user._id });
      if (!exists) throw notFound('Booking not found.');
      throw conflict('A start code is only needed before the job starts.', 'INVALID_STATE');
    }
    res.json({ startOtp: updated.startOtp.code });
  }),
);

/** POST /api/customer/tasks/:id/rate — UC-C20. One rating per task. */
router.post(
  '/tasks/:id/rate',
  wrap(async (req, res) => {
    const stars = Number(req.body.stars);
    if (!(stars >= 1 && stars <= 5)) throw badRequest('Choose between 1 and 5 stars.', 'INVALID_RATING');

    const task = await Task.findOne({ _id: req.params.id, customerId: req.user._id });
    if (!task) throw notFound('Booking not found.');
    if (![TASK_STATUS.COMPLETED, TASK_STATUS.SETTLED].includes(task.status)) {
      throw conflict('You can only rate a completed booking.', 'NOT_COMPLETED');
    }
    if (!task.helperId) throw conflict('This booking had no helper.', 'NO_HELPER');

    try {
      await Rating.create({
        taskId: task._id, direction: 'customer_to_helper',
        fromUserId: req.user._id, toUserId: task.helperId,
        stars, comment: req.body.comment || '', tags: req.body.tags || [],
      });
    } catch (err) {
      if (err?.code === 11000) throw conflict('You have already rated this booking.', 'ALREADY_RATED');
      throw err;
    }

    task.ratedByCustomer = true;
    await task.save();
    await recomputeHelperRating(task.helperId);

    await notify(task.helperId, 'RATING_RECEIVED', 'You received a rating',
      `${stars}★ for ${task.code}.`, { taskId: String(task._id), code: task.code, stars });

    res.status(201).json({ ok: true, stars });
  }),
);

/** Recomputes the helper's average from the rating rows — never incremented in place. */
export async function recomputeHelperRating(helperId) {
  const [agg] = await Rating.aggregate([
    { $match: { toUserId: helperId, direction: 'customer_to_helper' } },
    { $group: { _id: null, avg: { $avg: '$stars' }, count: { $sum: 1 } } },
  ]);
  await HelperProfile.updateOne(
    { userId: helperId },
    { $set: { ratingAvg: Math.round((agg?.avg || 0) * 10) / 10, ratingCount: agg?.count || 0 } },
  );
}

export default router;
