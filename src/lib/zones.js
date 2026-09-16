import { PriceZone } from '../models/index.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Zones are read on every bill, so they are cached for a few seconds like the
 * settings are. Any write clears the cache, so an admin change lands on the
 * very next quote.
 */
let cache = null;
let cachedAt = 0;
const TTL_MS = 5000;

export function invalidateZones() {
  cache = null;
  cachedAt = 0;
}

async function activeZones() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  cache = await PriceZone.find({ active: true }).lean();
  cachedAt = Date.now();
  return cache;
}

/** The zone a society is priced by, or null when it pays catalog prices. */
export async function zoneForSociety(society) {
  if (!society) return null;
  const zones = await activeZones();
  return zones.find((z) => (z.societies || []).includes(String(society))) || null;
}

/**
 * What one service costs in a zone.
 *
 * An exact price for that service wins; otherwise the zone's own rule applies
 * to the catalog price. Prices never go below zero, and a zone that says
 * nothing about a service leaves it exactly as the catalog has it.
 *
 * @returns {{ price: number, listPrice: number, source: 'base'|'zone'|'override' }}
 */
export function zonePrice(zone, service) {
  const listPrice = round2(service.basePrice);
  if (!zone) return { price: listPrice, listPrice, source: 'base' };

  const override = (zone.overrides || []).find((o) => o.serviceCode === service.code);
  if (override) return { price: round2(Math.max(0, override.price)), listPrice, source: 'override' };

  if (zone.adjustType === 'percent' && zone.adjustValue) {
    return { price: round2(Math.max(0, listPrice * (1 + zone.adjustValue / 100))), listPrice, source: 'zone' };
  }
  if (zone.adjustType === 'flat' && zone.adjustValue) {
    return { price: round2(Math.max(0, listPrice + zone.adjustValue)), listPrice, source: 'zone' };
  }
  return { price: listPrice, listPrice, source: 'base' };
}

/** How a zone's rule reads on a screen: "+10%", "−₹20", "Set prices". */
export function zoneRuleText(zone) {
  if (!zone) return '';
  if (zone.adjustType === 'percent' && zone.adjustValue) {
    return `${zone.adjustValue > 0 ? '+' : '−'}${Math.abs(zone.adjustValue)}%`;
  }
  if (zone.adjustType === 'flat' && zone.adjustValue) {
    return `${zone.adjustValue > 0 ? '+' : '−'}₹${Math.abs(zone.adjustValue)}`;
  }
  return 'Set prices';
}

/** The catalog as a locality sees it: every price already resolved for that zone. */
export async function pricedForSociety(services, society) {
  const zone = await zoneForSociety(society);
  return {
    zone,
    services: services.map((service) => {
      const { price, listPrice, source } = zonePrice(zone, service);
      return { ...service, basePrice: price, listPrice, priceSource: source };
    }),
  };
}
