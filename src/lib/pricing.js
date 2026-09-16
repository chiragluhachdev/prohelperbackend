import { getSettings } from './settings.js';
import { Service } from '../models/index.js';
import { badRequest } from './http.js';
import { evaluateAnswers } from './serviceOptions.js';
import { promoDiscountFor } from './promo.js';
import { zoneForSociety, zonePrice, zoneRuleText } from './zones.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const on = (v) => v === true || v === 'true' || v === 1 || v === '1';
const pct = (v) => Math.min(100, Math.max(0, Number(v) || 0));

/** The most services one booking can carry. */
export const MAX_SERVICES_PER_BOOKING = 6;

/**
 * The charges on top of the services, as the admin has configured them. Each
 * one can be switched off; a switched-off charge is zero and says so.
 */
export function chargeRules(settings) {
  return {
    discount: {
      enabled: on(settings.discount_enabled),
      percent: pct(settings.discount_percent),
      max: Math.max(0, Number(settings.discount_max) || 0),
      minOrder: Math.max(0, Number(settings.discount_min_order) || 0),
      label: String(settings.discount_label || 'Discount'),
    },
    platformFee: {
      enabled: settings.platform_fee_enabled === undefined ? true : on(settings.platform_fee_enabled),
      // A share of the booking, or a flat amount per booking — the admin's choice (UC-C29).
      kind: settings.platform_fee_type === 'flat' ? 'flat' : 'percent',
      percent: pct(settings.platform_fee_percent),
      flat: Math.max(0, Number(settings.platform_fee_flat) || 0),
      label: String(settings.platform_fee_label || 'Platform fee'),
    },
    helperCommission: {
      enabled: settings.helper_commission_enabled === undefined ? true : on(settings.helper_commission_enabled),
      kind: settings.helper_commission_type === 'flat' ? 'flat' : 'percent',
      percent: pct(settings.helper_commission_percent),
      flat: Math.max(0, Number(settings.helper_commission_flat) || 0),
    },
    surcharge: {
      enabled: on(settings.surcharge_enabled),
      amount: Math.max(0, Number(settings.surcharge_flat) || 0),
      appliesTo: ['instant', 'scheduled'].includes(settings.surcharge_applies_to) ? settings.surcharge_applies_to : 'all',
      label: String(settings.surcharge_label || 'Special surcharge'),
    },
    gst: {
      enabled: on(settings.gst_enabled),
      percent: pct(settings.gst_percent),
      // 'all': on the whole bill; 'fees': only on what the platform charges (fee + surcharge).
      base: settings.gst_base === 'fees' ? 'fees' : 'all',
      label: String(settings.gst_label || 'GST'),
    },
  };
}

/**
 * UC-C04/C05/C07 — the bill is computed here and nowhere else. The apps render
 * what this returns, so services, questions and every charge can change from
 * the admin panel without an app release.
 *
 *   services     Σ each service's base price + what its answers add
 *   − discount   % of services (capped, above a minimum order) — if switched on
 *   − promo      the code the customer entered, funded by the platform
 *   + fee        % of, or a flat amount on, services after discounts — if switched on
 *   + surcharge  flat, for all / instant / scheduled bookings  — if switched on
 *   + GST        % of the whole bill, or of fee + surcharge     — if switched on
 *   = total      what the customer pays (before any referral balance)
 *
 * The helper's commission is a share of the services amount: discounts, promo
 * codes and platform charges are the platform's, never taken out of the
 * helper's pay — a discounted booking still pays the helper in full.
 *
 * Prices themselves can differ by locality: a society may sit in a price zone
 * with its own rule or its own exact prices, and `ctx.society` is what decides
 * which. Whether the extra goes to the helper or stays with the platform is an
 * admin setting (`zone_uplift_to`).
 *
 * @param {Array<{code: string, options?: object}>} selections
 * @param {{ bookingType?: 'instant' | 'scheduled', promo?: object, society?: string }} ctx
 */
export async function quote(selections, ctx = {}) {
  if (!Array.isArray(selections) || selections.length === 0) {
    throw badRequest('Select at least one service.', 'NO_SERVICE');
  }
  if (selections.length > MAX_SERVICES_PER_BOOKING) {
    throw badRequest(`A booking can include up to ${MAX_SERVICES_PER_BOOKING} services.`, 'TOO_MANY_SERVICES');
  }
  const codes = selections.map((s) => String(s?.code || ''));
  if (new Set(codes).size !== codes.length) {
    throw badRequest('Each service can be added to a booking once.', 'DUPLICATE_SERVICE');
  }

  const settings = await getSettings();
  const services = await Service.find({ code: { $in: codes }, active: true }).lean();
  const byCode = new Map(services.map((s) => [s.code, s]));

  // What this locality pays, if it is priced differently from the catalog.
  const zone = await zoneForSociety(ctx.society);

  const lines = selections.map((selection) => {
    const service = byCode.get(String(selection?.code || ''));
    if (!service) throw badRequest(`"${selection?.code}" is not available right now.`, 'SERVICE_UNAVAILABLE');

    // Questions switched off are not asked, so they cannot be charged for either.
    const evaluated = evaluateAnswers(service, selection.options || selection.answers || {});
    const { price, listPrice } = zonePrice(zone, service);
    return {
      code: service.code,
      name: service.name,
      nameHi: service.nameHi || '',
      icon: service.icon,
      basePrice: price,
      /** The catalog price, before the locality's rule — what "was ₹177" reads from. */
      listPrice,
      options: evaluated.values,
      answers: evaluated.answers,
      optionsAmount: evaluated.amount,
      amount: round2(price + evaluated.amount),
      minutes: Math.max(15, Math.round((service.defaultDurationMins || 60) + evaluated.minutes)),
    };
  });

  const rules = chargeRules(settings);
  const servicesAmount = round2(lines.reduce((sum, l) => sum + l.amount, 0));
  // The same booking at catalog prices — what the locality's rule moved.
  const listServicesAmount = round2(lines.reduce((sum, l) => sum + l.listPrice + l.optionsAmount, 0));
  const zoneUplift = round2(servicesAmount - listServicesAmount);

  let discount = 0;
  if (rules.discount.enabled && servicesAmount >= rules.discount.minOrder) {
    discount = round2((servicesAmount * rules.discount.percent) / 100);
    if (rules.discount.max > 0) discount = Math.min(discount, rules.discount.max);
  }
  // UC-C32 — the code the customer entered, already checked against its rules.
  const promoDiscount = ctx.promo ? promoDiscountFor(ctx.promo, round2(servicesAmount - discount)) : 0;
  const afterDiscount = round2(Math.max(0, servicesAmount - discount - promoDiscount));

  const platformFee = !rules.platformFee.enabled
    ? 0
    : rules.platformFee.kind === 'flat'
      ? round2(rules.platformFee.flat)
      : round2((afterDiscount * rules.platformFee.percent) / 100);

  const type = ctx.bookingType === 'instant' ? 'instant' : 'scheduled';
  const surcharge =
    rules.surcharge.enabled && (rules.surcharge.appliesTo === 'all' || rules.surcharge.appliesTo === type)
      ? round2(rules.surcharge.amount)
      : 0;

  const taxable = rules.gst.base === 'fees' ? round2(platformFee + surcharge) : round2(afterDiscount + platformFee + surcharge);
  const gst = rules.gst.enabled ? round2((taxable * rules.gst.percent) / 100) : 0;

  const total = round2(Math.max(0, afterDiscount + platformFee + surcharge + gst));

  /*
   * Whose the locality uplift is, decided by the admin: with 'helper' the
   * helper is paid on the price the customer actually paid; with 'platform'
   * they are paid as if it were the catalog price and the difference stays
   * with the platform. Commission is worked out on whichever of the two the
   * helper is being paid on.
   */
  const payOn = settings.zone_uplift_to === 'platform' ? Math.min(listServicesAmount, servicesAmount) : servicesAmount;
  const helperCommission = !rules.helperCommission.enabled
    ? 0
    : rules.helperCommission.kind === 'flat'
      ? round2(Math.min(rules.helperCommission.flat, payOn))
      : round2((payOn * rules.helperCommission.percent) / 100);
  const helperPayout = round2(payOn - helperCommission);
  const durationMins = lines.reduce((sum, l) => sum + l.minutes, 0);

  return {
    lines,
    durationMins,
    pricing: {
      servicesAmount,
      // Locality pricing, kept with the booking so the bill can always be read back.
      listServicesAmount,
      zoneUplift,
      zoneCode: zone?.code || '',
      zoneName: zone?.name || '',
      zoneRule: zoneRuleText(zone),
      discount,
      discountPercent: rules.discount.enabled ? rules.discount.percent : 0,
      discountLabel: rules.discount.label,
      promoCode: ctx.promo?.code || '',
      promoDiscount,
      promoLabel: ctx.promo ? ctx.promo.description || `Promo ${ctx.promo.code}` : '',
      platformFee,
      platformFeePercent: rules.platformFee.enabled && rules.platformFee.kind === 'percent' ? rules.platformFee.percent : 0,
      platformFeeLabel: rules.platformFee.label,
      surcharge,
      surchargeLabel: rules.surcharge.label,
      gst,
      gstPercent: rules.gst.enabled ? rules.gst.percent : 0,
      gstBase: rules.gst.base,
      gstLabel: rules.gst.label,
      taxableAmount: rules.gst.enabled ? taxable : 0,
      total,
      helperCommissionPercent: rules.helperCommission.enabled && rules.helperCommission.kind === 'percent' ? rules.helperCommission.percent : 0,
      helperCommission,
      helperPayout,
      currency: settings.currency || 'INR',
    },
  };
}
