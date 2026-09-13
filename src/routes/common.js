import { Router } from 'express';
import { Notification, Service } from '../models/index.js';
import { authenticate } from '../lib/auth.js';
import { wrap, notFound } from '../lib/http.js';
import { getSettings } from '../lib/settings.js';

const router = Router();

/** GET /api/services — the catalog both apps render. Configurable, not hard-coded. */
router.get(
  '/services',
  wrap(async (_req, res) => {
    const services = await Service.find({ active: true }).sort({ sortOrder: 1, name: 1 }).lean();
    res.json({
      services: services.map((s) => ({
        code: s.code,
        name: s.name,
        category: s.category,
        description: s.description,
        icon: s.icon,
        basePrice: s.basePrice,
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

export default router;
