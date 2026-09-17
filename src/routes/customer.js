import { Router } from 'express';
import { Address, HelperProfile, Payment, Rating, Service, Task, TaskEvent } from '../models/index.js';
import { ROLES, TASK_STATUS } from '../config.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { wrap, badRequest, notFound, conflict } from '../lib/http.js';
import { quote } from '../lib/pricing.js';
import { CUSTOMER_TABS, ratingInput, serializeTask } from '../lib/views.js';
import { cancelBooking, customerCancellable } from '../lib/cancellation.js';
import { recordRejection } from '../lib/accounts.js';
import { newTaskCode, mustTransition, transition } from '../lib/taskflow.js';
import { logSearchStarted, searchFields, startSearch } from '../matching.js';
import { notify } from '../lib/notify.js';
import { postEntry } from '../lib/ledger.js';
import { checkPromo, recordPromoUse } from '../lib/promo.js';
import { amountDue, createPaymentOrder, handlePaymentCallback, publicPayment } from '../lib/payments.js';
import { newEventId, newGatewayPaymentId, signPayload } from '../lib/gateway.js';
import { redeemForBooking, usableForBooking } from '../lib/referral.js';
import { ensureStartCode, startCodeFields } from '../lib/startCode.js';
import { getSettings } from '../lib/settings.js';
import { upload, uploadBuffer } from '../lib/cloudinary.js';
import { publicUser } from './auth.js';
import { activeLocalities, localityByCode, publicLocality } from '../lib/localities.js';

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

/** Enough for home, work, parents' place and a few more — not an address book. */
const MAX_ADDRESSES = 10;

/** Trimmed, length-checked address text; throws the field's own error code. */
function addressText(body, { partial = false } = {}) {
  const out = {};
  const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  if (!partial || body.label !== undefined) out.label = clean(body.label, 24) || 'Home';
  if (!partial || body.line1 !== undefined) {
    out.line1 = clean(body.line1, 120);
    if (out.line1.length < 2) throw badRequest('Enter your flat or house number.', 'LINE1_REQUIRED');
  }
  if (!partial || body.landmark !== undefined) out.landmark = clean(body.landmark, 120);
  return out;
}

/**
 * The exact spot of an address. A map pin is used as given; without one the
 * locality's centre stands in, so every address still has a position.
 */
function addressPoint(body, locality) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const valid = body.lat !== undefined && body.lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  if (valid) return { lat, lng, pinned: true, formatted: String(body.formatted || '').replace(/\s+/g, ' ').trim().slice(0, 240) };
  return { lat: locality.lat, lng: locality.lng, pinned: false, formatted: '' };
}

/** A customer's default address, or their oldest one if somehow none is marked. */
async function defaultAddress(userId) {
  return (
    (await Address.findOne({ userId, active: true, isDefault: true }).lean()) ||
    (await Address.findOne({ userId, active: true }).sort({ createdAt: 1 }).lean())
  );
}

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
router.get('/societies', wrap(async (_req, res) => res.json({ societies: (await activeLocalities()).map(publicLocality) })));

router.post(
  '/addresses',
  wrap(async (req, res) => {
    const { label, line1, landmark } = addressText(req.body);
    const line2 = String(req.body.line2 || '').trim().slice(0, 120);

    /*
     * Where the address is: the customer's map pin when they dropped one, and
     * the served locality it belongs to — detected from the pin in the app,
     * and changeable by the customer, but it has to be one that is served.
     */
    const society = await localityByCode(req.body.society);
    if (!society || !society.active) throw badRequest('Choose your society.', 'SOCIETY_REQUIRED');
    const city = society.city;
    const pincode = society.pincode;
    const { lat, lng, pinned, formatted } = addressPoint(req.body, society);

    const count = await Address.countDocuments({ userId: req.user._id, active: true });
    if (count >= MAX_ADDRESSES) {
      throw badRequest(`You can save up to ${MAX_ADDRESSES} addresses. Remove one to add another.`, 'ADDRESS_LIMIT');
    }
    // The first address is the default; after that, only when asked.
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
      pinned,
      formatted,
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

    Object.assign(address, addressText(req.body, { partial: true }));
    if (req.body.line2 !== undefined) address.line2 = String(req.body.line2 || '').trim().slice(0, 120);

    /*
     * Changing society has to carry its city, pincode and coordinates with it,
     * exactly as creating one does — otherwise an edited address keeps the old
     * estate's location and matching sends the helper to the wrong gate.
     */
    if (req.body.society !== undefined || req.body.lat !== undefined) {
      const society = await localityByCode(req.body.society ?? address.society);
      if (!society || !society.active) throw badRequest('Choose your society.', 'SOCIETY_REQUIRED');
      address.society = society.code;
      address.line2 = req.body.line2 || `${society.name}, ${society.area}`;
      address.city = society.city;
      address.pincode = society.pincode;
      // A new pin moves it; a new locality without a pin keeps the pin it had.
      const point = req.body.lat !== undefined
        ? addressPoint(req.body, society)
        : address.pinned ? { lat: address.lat, lng: address.lng, pinned: true, formatted: address.formatted } : addressPoint({}, society);
      Object.assign(address, point);
    }
    if (req.body.isDefault) {
      await Address.updateMany({ userId: req.user._id }, { $set: { isDefault: false } });
      address.isDefault = true;
    }
    await address.save();
    res.json({ address });
  }),
);

/**
 * Soft delete — past bookings keep their own snapshot, so nothing is lost.
 *
 * The last address cannot be removed: a customer with none cannot book, and
 * would be sent back through onboarding. Replace it by adding the new one first.
 */
router.delete(
  '/addresses/:id',
  wrap(async (req, res) => {
    const target = await Address.findOne({ _id: req.params.id, userId: req.user._id, active: true }).lean();
    if (!target) throw notFound('Address not found.');
    const count = await Address.countDocuments({ userId: req.user._id, active: true });
    if (count <= 1) {
      throw conflict('This is your only address. Add another one before removing it.', 'ADDRESS_LAST');
    }

    await Address.updateOne({ _id: target._id }, { $set: { active: false, isDefault: false } });

    // Never leave the customer without a default.
    const remaining = await Address.findOne({ userId: req.user._id, active: true }).sort({ createdAt: 1 });
    if (remaining && !(await Address.exists({ userId: req.user._id, active: true, isDefault: true }))) {
      remaining.isDefault = true;
      await remaining.save();
    }
    const addresses = await Address.find({ userId: req.user._id, active: true }).sort({ isDefault: -1, createdAt: -1 }).lean();
    res.json({ ok: true, addresses });
  }),
);

/**
 * Which locality a bill should be priced for: the address the customer picked,
 * or their default one. No address yet means catalog prices.
 */
async function societyForQuote(userId, addressId) {
  const address = addressId
    ? await Address.findOne({ _id: addressId, userId, active: true }).select('society').lean()
    : await Address.findOne({ userId, active: true }).sort({ isDefault: -1, createdAt: -1 }).select('society').lean();
  return address?.society || '';
}

/* -------------------------------------------------------------------- quote */

/**
 * POST /api/customer/quote — the bill preview, computed server-side (UC-C07).
 *
 * A promo code is checked here too, but never spent: a preview must not use up
 * someone's one chance with a code. If it cannot be used, the bill still comes
 * back — with the reason alongside it, so the app can say so without losing
 * the price (UC-C32).
 */
router.post(
  '/quote',
  wrap(async (req, res) => {
    // Prices can differ by locality, so the bill is worked out for the address
    // this booking is actually for (their default one, unless they chose another).
    const society = await societyForQuote(req.user._id, req.body.addressId);
    let promo = null;
    let promoError = null;
    if (req.body.promoCode) {
      // Priced once to know the services amount, since a code's rules can depend on it.
      const base = await quote(req.body.services, { bookingType: req.body.bookingType, society });
      try {
        promo = (await checkPromo(req.user, req.body.promoCode, { servicesAmount: base.pricing.servicesAmount })).promo;
      } catch (err) {
        if (!err.status || err.status >= 500) throw err;
        promoError = { reason: err.code || 'PROMO_INVALID', message: err.message };
      }
    }

    const { pricing, lines, durationMins } = await quote(req.body.services, { bookingType: req.body.bookingType, promo, society });
    // Referral balance is offered on every bill and only taken off when asked for.
    const { balance, usable, cap, percent } = await usableForBooking(req.user, pricing.total);
    if (req.body.useReferral && usable > 0) pricing.referralCredit = usable;
    res.json({
      lines,
      durationMins,
      pricing: { ...pricing, amountDue: Math.round((pricing.total - (pricing.referralCredit || 0)) * 100) / 100 },
      // `limited`: they have more than this booking allows — the cap, not the balance, set `usable`.
      referral: { balance, usable, maxPercent: percent, limited: balance > cap },
      promo: promoError
        ? { applied: false, code: String(req.body.promoCode || '').toUpperCase(), ...promoError }
        : promo
          ? { applied: true, code: promo.code, description: promo.description || '', discount: pricing.promoDiscount }
          : null,
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
      instructions = '', idempotencyKey, useReferral, promoCode,
    } = req.body;
    const instant = bookingType === 'instant';

    if (!req.user.name) throw badRequest('Complete your profile before booking.', 'PROFILE_INCOMPLETE');
    if (!idempotencyKey) throw badRequest('Missing idempotency key.', 'IDEMPOTENCY_KEY_REQUIRED');

    const existing = await Task.findOne({ idempotencyKey, customerId: req.user._id });
    if (existing) return res.status(200).json({ task: serializeTask(existing), duplicate: true });

    // The customer's chosen address — or, when none was sent, their default (UC-C03).
    const address = addressId
      ? await Address.findOne({ _id: addressId, userId: req.user._id, active: true }).lean()
      : await defaultAddress(req.user._id);
    if (!address) throw badRequest('Choose a valid address.', 'ADDRESS_REQUIRED');
    // A locality the admin has switched off takes no new bookings.
    if (address.society) {
      const locality = await localityByCode(address.society);
      if (locality && !locality.active) {
        throw badRequest(`We are not taking bookings in ${locality.name} right now.`, 'LOCALITY_NOT_SERVED');
      }
    }

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

    // Priced, validated and timed on the server from the admin's configuration — never the app's (UC-C07).
    // A promo code is checked again here, against the booking that is actually being made (UC-C32).
    let promo = null;
    if (promoCode) {
      const base = await quote(services, { bookingType: instant ? 'instant' : 'scheduled', society: address.society });
      promo = (await checkPromo(req.user, promoCode, { servicesAmount: base.pricing.servicesAmount })).promo;
    }
    const { lines, pricing, durationMins: quotedMinutes } = await quote(services, {
      bookingType: instant ? 'instant' : 'scheduled',
      promo,
      // The address decides the prices, and the booking keeps them (UC-C19).
      society: address.society,
    });
    if (useReferral) {
      const { usable } = await usableForBooking(req.user, pricing.total);
      if (usable > 0) pricing.referralCredit = usable;
    }


    let task;
    try {
      task = await Task.create({
        code: newTaskCode(),
        customerId: req.user._id,
        services: lines,
        // A copy, not a reference: editing, re-defaulting or removing the saved
        // address later must never move where this booking happens (UC-C03).
        address: {
          addressId: address._id,
          society: address.society,
          label: address.label, line1: address.line1, line2: address.line2,
          landmark: address.landmark, city: address.city, pincode: address.pincode,
          lat: address.lat, lng: address.lng,
          pinned: Boolean(address.pinned), formatted: address.formatted || '',
        },
        bookingType: instant ? 'instant' : 'scheduled',
        scheduledAt,
        scheduledDate,
        scheduledTime,
        durationMins: quotedMinutes,
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

    // The promo use is written against this booking, so it counts once and only once.
    if (promo && pricing.promoDiscount > 0) await recordPromoUse(promo, req.user, task, pricing.promoDiscount);

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

/** GET /api/customer/tasks?tab=upcoming|active|completed|cancelled|rejected|no_helper — UC-C19. */
router.get(
  '/tasks',
  wrap(async (req, res) => {
    let filter = { customerId: req.user._id };
    const tab = req.query.tab;
    if (tab) {
      if (!CUSTOMER_TABS[tab]) throw badRequest('Unknown tab.', 'INVALID_TAB');
      filter = { ...filter, ...CUSTOMER_TABS[tab] };
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
    const timeline = await TaskEvent.find({ taskId: task._id, kind: { $ne: 'MATCHING' } }).sort({ at: 1 }).lean();

    const view = serializeTask(task, { audience: 'customer', helperProfile });
    if (!startCodeOn) view.startOtp = null;
    const rating = task.ratedByCustomer
      ? await Rating.findOne({ taskId: task._id, direction: 'customer_to_helper' }).select('stars comment tags createdAt').lean()
      : null;
    res.json({
      task: view,
      timeline,
      // Whether the Cancel button should be offered, from the admin's rules (UC-C22).
      canCancel: customerCancellable(await getSettings()).includes(task.status),
      myRating: rating ? { stars: rating.stars, comment: rating.comment, tags: rating.tags || [], at: rating.createdAt } : null,
    });
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
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (reason.length < 3) {
      throw badRequest('Please tell us why you are cancelling.', 'REASON_REQUIRED');
    }

    // How late a customer may cancel is the admin's rule (`customer_cancel_until`).
    const { task: updated, previousStatus } = await cancelBooking(req.params.id, {
      by: 'customer', actorId: req.user._id, reason,
      from: customerCancellable(await getSettings()),
      filter: { customerId: req.user._id },
    });
    const wasUnderWay = previousStatus === TASK_STATUS.IN_PROGRESS;

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

    // A helper was already on it: that is a rejection of the helper (UC-C23).
    if ([TASK_STATUS.ACCEPTED, TASK_STATUS.IN_PROGRESS].includes(previousStatus)) {
      await recordRejection(req.user._id, { kind: 'CUSTOMER_CANCELLED', task: updated, reason });
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
    await logSearchStarted(updated, await getSettings(), 'Search restarted by the customer');

    res.json({ task: serializeTask(updated) });
  }),
);

/* ----------------------------------------------------------------- payment */

/**
 * POST /api/customer/tasks/:id/payment-order — UC-C28 step 2.
 *
 * The app never decides what is owed: the amount comes off the booking's own
 * bill. The order is what the payment sheet opens with.
 */
router.post(
  '/tasks/:id/payment-order',
  wrap(async (req, res) => {
    const task = await Task.findOne({ _id: req.params.id, customerId: req.user._id });
    if (!task) throw notFound('Booking not found.');
    const payment = await createPaymentOrder(task, req.user);
    res.status(201).json({ payment: publicPayment(payment), amount: payment.amount, currency: payment.currency });
  }),
);

/** GET /api/customer/tasks/:id/payment — where this booking's payment has got to. */
router.get(
  '/tasks/:id/payment',
  wrap(async (req, res) => {
    const task = await Task.findOne({ _id: req.params.id, customerId: req.user._id }).select('_id paymentStatus').lean();
    if (!task) throw notFound('Booking not found.');
    const payment = await Payment.findOne({ taskId: task._id }).sort({ createdAt: -1 }).lean();
    res.json({ payment: publicPayment(payment), paymentStatus: task.paymentStatus });
  }),
);

/**
 * POST /api/customer/tasks/:id/pay — the in-app UPI payment.
 *
 * There is no real gateway yet, so this stands in for one: it makes the order,
 * then signs and delivers the callback that a gateway would have sent. The
 * money is recorded, verified and settled by exactly the same code that will
 * handle the real thing, so nothing about the booking flow changes on the day
 * a gateway is connected.
 */
router.post(
  '/tasks/:id/pay',
  wrap(async (req, res) => {
    const task = await Task.findOne({ _id: req.params.id, customerId: req.user._id });
    if (!task) throw notFound('Booking not found.');
    if (!task.helperId) throw conflict('This booking had no helper.', 'NO_HELPER');

    const order = await createPaymentOrder(task, req.user);
    const gatewayPaymentId = newGatewayPaymentId();
    const method = String(req.body.method || 'UPI').toUpperCase().slice(0, 20);

    const result = await handlePaymentCallback(
      { eventId: newEventId(), orderId: order.orderId, gatewayPaymentId, status: 'PAID', method },
      signPayload([order.orderId, gatewayPaymentId, 'PAID']),
    );

    const settled = await Task.findById(task._id).populate('helperId', 'name phone photoUrl');
    const payment = await Payment.findOne({ orderId: order.orderId }).lean();
    res.json({
      task: serializeTask(settled),
      payment: publicPayment(payment),
      receipt: {
        amount: payment?.amount ?? amountDue(task),
        paidAt: payment?.paidAt,
        method: payment?.method || method,
        orderId: order.orderId,
        transactionId: payment?.gatewayPaymentId || gatewayPaymentId,
      },
      duplicate: Boolean(result.duplicate),
    });
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
    const { stars, comment, tags } = ratingInput(req.body);

    const task = await Task.findOne({ _id: req.params.id, customerId: req.user._id });
    if (!task) throw notFound('Booking not found.');
    // Only a genuine completion — closed with the customer's own OTP — can be rated.
    if (![TASK_STATUS.COMPLETED, TASK_STATUS.SETTLED].includes(task.status) || !task.completedAt) {
      throw conflict('You can only rate a completed booking.', 'NOT_COMPLETED');
    }
    if (!task.helperId) throw conflict('This booking had no helper.', 'NO_HELPER');

    try {
      await Rating.create({
        taskId: task._id, direction: 'customer_to_helper',
        fromUserId: req.user._id, toUserId: task.helperId,
        stars, comment, tags,
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

/**
 * GET /api/customer/ratings — "rate later" (UC-C20): completed bookings still
 * waiting for a rating, and every rating given, newest first.
 */
router.get(
  '/ratings',
  wrap(async (req, res) => {
    const [pending, given] = await Promise.all([
      Task.find({
        customerId: req.user._id,
        status: { $in: [TASK_STATUS.COMPLETED, TASK_STATUS.SETTLED] },
        completedAt: { $ne: null },
        helperId: { $ne: null },
        ratedByCustomer: { $ne: true },
      })
        .populate('helperId', 'name phone photoUrl')
        .sort({ completedAt: -1 })
        .limit(20),
      Rating.find({ fromUserId: req.user._id, direction: 'customer_to_helper' })
        .populate('taskId', 'code services completedAt helperSnapshot')
        .populate('toUserId', 'name')
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ]);
    res.json({
      pending: pending.map((t) => serializeTask(t)),
      given: given.map((r) => ({
        id: String(r._id), stars: r.stars, comment: r.comment, tags: r.tags || [], at: r.createdAt,
        helperName: r.toUserId?.name || r.taskId?.helperSnapshot?.name || '',
        task: r.taskId
          ? { id: String(r.taskId._id), code: r.taskId.code, services: (r.taskId.services || []).map((sv) => ({ code: sv.code, name: sv.name })) }
          : null,
      })),
    });
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
