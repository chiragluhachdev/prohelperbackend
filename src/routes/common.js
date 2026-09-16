import { Router } from 'express';
import crypto from 'node:crypto';
import { Complaint, Notification, Service, Category, Task } from '../models/index.js';
import { authenticate } from '../lib/auth.js';
import { wrap, badRequest, notFound } from '../lib/http.js';
import { getSettings } from '../lib/settings.js';
import { handlePaymentCallback } from '../lib/payments.js';
import { activeLocalities, detectLocality, pricedForLocality, publicLocality } from '../lib/localities.js';
import { reverseGeocode, searchPlaces } from '../lib/geocode.js';
import { notifyAdmins } from '../lib/accounts.js';

const router = Router();

/**
 * GET /api/localities — the places currently served, for the apps' pickers.
 * Managed in the admin panel; never the prices, only what is needed to choose.
 */
router.get(
  '/localities',
  wrap(async (_req, res) => {
    res.json({ localities: (await activeLocalities()).map(publicLocality) });
  }),
);

/**
 * GET /api/localities/detect?lat=&lng= — which served locality a map pin is
 * in, for the address picker. `locality` is null outside all of them, with the
 * nearest one alongside so the app can say how far off the pin is.
 */
router.get(
  '/localities/detect',
  wrap(async (req, res) => {
    res.json(await detectLocality(req.query.lat, req.query.lng));
  }),
);

/**
 * GET /api/geo/place?lat=&lng= — everything the map picker shows for a pin in
 * one call: the street address there, and which served locality it is in.
 */
router.get(
  '/geo/place',
  wrap(async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw badRequest('Give a latitude and longitude.', 'INVALID_LOCATION');
    const [place, detected] = await Promise.all([reverseGeocode(lat, lng), detectLocality(lat, lng)]);
    res.json({ lat, lng, ...place, ...detected });
  }),
);

/** GET /api/geo/search?q=&lat=&lng= — places to jump the map to, biased towards where the customer is looking. */
router.get(
  '/geo/search',
  wrap(async (req, res) => {
    const near = { lat: Number(req.query.lat), lng: Number(req.query.lng) };
    res.json({ results: await searchPlaces(req.query.q, near) });
  }),
);

/** GET /api/categories — the dynamic categories for the home screen. */
router.get(
  '/categories',
  wrap(async (_req, res) => {
    const categories = await Category.find({ active: true }).sort({ sortOrder: 1, name: 1 }).lean();
    res.json(categories);
  })
);

/**
 * GET /api/services — the catalog both apps render. Configurable, not hard-coded.
 *
 * `?society=` prices it for that locality (UC-C43): its fixed prices where it
 * has them, its fallback rule where it does not. The apps never work a price
 * out for themselves, here or anywhere else.
 */
router.get(
  '/services',
  wrap(async (req, res) => {
    const services = await Service.find({ active: true }).sort({ sortOrder: 1, name: 1 }).lean();
    const { locality, services: priced } = await pricedForLocality(services, req.query.society);
    res.json({
      locality: locality ? { code: locality.code, name: locality.name } : null,
      services: priced.map((s) => ({
        code: s.code,
        name: s.name,
        category: s.category,
        description: s.description,
        icon: s.icon,
        basePrice: s.basePrice,
        // What the catalog asks, when this locality pays something else.
        listPrice: s.listPrice !== s.basePrice ? s.listPrice : undefined,
        durationLabel: s.durationLabel,
        defaultDurationMins: s.defaultDurationMins,
        inclusions: s.inclusions || [],
        nameHi: s.nameHi || '',
        descriptionHi: s.descriptionHi || '',
        durationLabelHi: s.durationLabelHi || '',
        inclusionsHi: s.inclusionsHi || [],
        optionsEnabled: Boolean(s.optionsEnabled),
        options: s.optionsEnabled ? s.options || [] : [],
      })),
    });
  }),
);

/** The handful of settings the apps are allowed to see (never commission rates). */
router.get(
  '/app-config',
  wrap(async (_req, res) => {
    const s = await getSettings();
    res.json({
      currency: s.currency,
      acceptWindowSeconds: s.accept_window_seconds,
      searchDurationSeconds: s.search_duration_seconds,
      renotifyIntervalSeconds: s.renotify_interval_seconds,
      completionOtpTtlSeconds: s.completion_otp_ttl_seconds,
    });
  }),
);

router.get(
  '/notifications',
  authenticate,
  wrap(async (req, res) => {
    const [notifications, unread] = await Promise.all([
      Notification.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(50).lean(),
      Notification.countDocuments({ userId: req.user._id, readAt: null }),
    ]);
    res.json({ notifications, unread });
  }),
);

router.post(
  '/notifications/read-all',
  authenticate,
  wrap(async (req, res) => {
    await Notification.updateMany({ userId: req.user._id, readAt: null }, { $set: { readAt: new Date() } });
    res.json({ ok: true });
  }),
);

router.post(
  '/notifications/:id/read',
  authenticate,
  wrap(async (req, res) => {
    const n = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { readAt: new Date() } },
      { new: true },
    );
    if (!n) throw notFound('Notification not found.');
    res.json({ notification: n });
  }),
);

/* ------------------------------------------------------------- complaints */

const COMPLAINT_CATEGORIES = ['SERVICE_QUALITY', 'BEHAVIOUR', 'PAYMENT', 'DAMAGE', 'SAFETY', 'APP', 'OTHER'];

const publicComplaint = (c) => ({
  id: String(c._id),
  code: c.code,
  category: c.category,
  message: c.message,
  status: c.status,
  resolution: c.resolution || '',
  taskId: c.taskId ? String(c.taskId._id || c.taskId) : null,
  taskCode: c.taskCode || c.taskId?.code || '',
  at: c.createdAt,
  handledAt: c.handledAt || null,
});

/**
 * POST /api/complaints — UC-C40. Anyone signed in can report a problem, about
 * a booking or about the app itself. It goes straight to the admins' queue.
 */
router.post(
  '/complaints',
  authenticate,
  wrap(async (req, res) => {
    const message = String(req.body.message || '').trim().slice(0, 1000);
    if (message.length < 5) throw badRequest('Tell us what went wrong.', 'MESSAGE_REQUIRED');
    const category = COMPLAINT_CATEGORIES.includes(req.body.category) ? req.body.category : 'OTHER';

    // A complaint about a booking has to be about one of their own.
    let task = null;
    if (req.body.taskId) {
      task = await Task.findOne({
        _id: req.body.taskId,
        $or: [{ customerId: req.user._id }, { helperId: req.user._id }],
      }).select('code customerId helperId').lean();
      if (!task) throw notFound('Booking not found.');
    }
    const against = task
      ? String(task.customerId) === String(req.user._id)
        ? task.helperId
        : task.customerId
      : null;

    const complaint = await Complaint.create({
      code: `CMP-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      byUserId: req.user._id,
      byRole: req.user.role,
      againstUserId: against || undefined,
      taskId: task?._id,
      taskCode: task?.code || '',
      category,
      message,
    });

    await notifyAdmins('COMPLAINT_RAISED', 'New complaint',
      `${req.user.name || req.user.phone} reported a problem${task ? ` with ${task.code}` : ''}.`,
      { complaintId: String(complaint._id), code: complaint.code, taskId: task ? String(task._id) : '' });

    res.status(201).json({ complaint: publicComplaint(complaint) });
  }),
);

/** GET /api/complaints — what this person has reported, and what came of it. */
router.get(
  '/complaints',
  authenticate,
  wrap(async (req, res) => {
    const complaints = await Complaint.find({ byUserId: req.user._id })
      .populate('taskId', 'code')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ complaints: complaints.map(publicComplaint), categories: COMPLAINT_CATEGORIES });
  }),
);

/**
 * POST /api/payments/webhook — UC-C28 steps 4–6.
 *
 * Open to the internet on purpose: this is where a gateway calls back. It is
 * safe because nothing is trusted — the signature is checked against our own
 * secret, and the event id makes a repeated delivery a no-op, so the same
 * payment can never be recorded twice.
 */
router.post(
  '/payments/webhook',
  wrap(async (req, res) => {
    const signature = req.get('x-ph-signature') || req.body?.signature;
    const result = await handlePaymentCallback(req.body, signature);
    res.json({ received: true, handled: result.handled, duplicate: Boolean(result.duplicate) });
  }),
);

export default router;
