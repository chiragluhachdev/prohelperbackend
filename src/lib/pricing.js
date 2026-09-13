import { getSettings } from './settings.js';
import { Service } from '../models/index.js';
import { badRequest } from './http.js';

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * UC-C07 — the bill is computed here and nowhere else. The mobile app only
 * renders what this returns, so pricing can change without an app release.
 *
 * @param {Array<{code: string, options?: object}>} selections
 * @param {{durationMins?: number}} ctx
 */
export async function quote(selections, ctx = {}) {
  if (!Array.isArray(selections) || selections.length === 0) {
    throw badRequest('Select at least one service.', 'NO_SERVICE');
  }

  const settings = await getSettings();
  const codes = selections.map((s) => s.code);
  const services = await Service.find({ code: { $in: codes }, active: true }).lean();
  const byCode = new Map(services.map((s) => [s.code, s]));

  const lines = [];
  for (const selection of selections) {
    const service = byCode.get(selection.code);
    if (!service) {
      throw badRequest(`"${selection.code}" is not available right now.`, 'SERVICE_UNAVAILABLE');
    }

    /*
     * Base price plus whatever the configured per-unit options add — but only
     * while the service's options are switched on. A disabled question is not
     * asked, so it must not be charged for either, whatever default it carries.
     */
    let amount = service.basePrice;
    const answers = service.optionsEnabled ? selection.options || {} : {};
    if (service.optionsEnabled) {
      for (const option of service.options || []) {
        if (!option.pricePerUnit) continue;
        const value = Number(answers[option.key] ?? option.defaultValue ?? 0);
        if (Number.isFinite(value) && value > 0) amount += option.pricePerUnit * value;
      }
    }

    lines.push({
      code: service.code,
      name: service.name,
      nameHi: service.nameHi || '',
      icon: service.icon,
      basePrice: service.basePrice,
      options: answers,
      amount: round2(amount),
    });
  }

  const servicesAmount = round2(lines.reduce((sum, l) => sum + l.amount, 0));
  const platformFee = round2((servicesAmount * settings.platform_fee_percent) / 100);
  const discount = 0; // promo codes are a post-MVP hook (UC-C32)

  const taxable = Math.max(servicesAmount + platformFee - discount, 0);
  const total = round2(taxable);

  // What the platform keeps out of the helper's gross (UC-C26).
  const helperCommission = round2((servicesAmount * settings.helper_commission_percent) / 100);
  const helperPayout = round2(servicesAmount - helperCommission);

  return {
    lines,
    pricing: {
      servicesAmount,
      platformFeePercent: settings.platform_fee_percent,
      platformFee,
      discount,
      promoCode: '',
      total,
      helperCommissionPercent: settings.helper_commission_percent,
      helperCommission,
      helperPayout,
      currency: settings.currency || 'INR',
    },
  };
}
