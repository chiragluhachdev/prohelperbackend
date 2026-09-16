import { Locality } from '../models/index.js';
import { SOCIETIES } from '../constants/societies.js';
import { distanceKm } from './geo.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Localities are read on almost every request — addresses, matching, every
 * bill — so they are cached for a few seconds, like settings. Any write
 * clears the cache, so an admin change applies to the very next request.
 */
let cache = null;
let cachedAt = 0;
const TTL_MS = 5000;

export function invalidateLocalities() {
  cache = null;
  cachedAt = 0;
}

/** Every locality, active or not, in the admin's order. */
export async function allLocalities() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  cache = await Locality.find().sort({ sortOrder: 1, name: 1 }).lean();
  cachedAt = Date.now();
  return cache;
}

/** The localities currently served — what the apps offer. */
export async function activeLocalities() {
  return (await allLocalities()).filter((l) => l.active);
}

/** One locality by its code, served or not; null if it does not exist. */
export async function localityByCode(code) {
  if (!code) return null;
  return (await allLocalities()).find((l) => l.code === String(code)) || null;
}

/** The fields an app needs to show and pick a locality — never its prices. */
export const publicLocality = (l) => ({
  code: l.code, name: l.name, area: l.area, city: l.city, pincode: l.pincode, lat: l.lat, lng: l.lng,
  radiusKm: l.radiusKm ?? 1.5,
});

/**
 * Which served locality a map pin falls in: the nearest one whose centre is
 * within its own radius. When none is, the nearest one is still returned
 * separately, so the app can say "we don't serve here yet — nearest is X".
 */
export async function detectLocality(lat, lng) {
  const point = { lat: Number(lat), lng: Number(lng) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return { locality: null, nearest: null };

  const ranked = (await activeLocalities())
    .filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lng) && (l.lat || l.lng))
    .map((l) => ({ l, km: distanceKm({ lat: l.lat, lng: l.lng }, point) }))
    .sort((a, b) => a.km - b.km);

  const inside = ranked.find((r) => r.km <= (Number(r.l.radiusKm) || 1.5));
  const round = (km) => Math.round(km * 10) / 10;
  return {
    locality: inside ? { ...publicLocality(inside.l), distanceKm: round(inside.km) } : null,
    nearest: ranked[0] ? { ...publicLocality(ranked[0].l), distanceKm: round(ranked[0].km) } : null,
  };
}

/**
 * The first run on a database that has no localities yet: the estates that
 * were written into the code become rows, so nothing that already refers to
 * them breaks. After that, localities are only ever managed from the admin.
 */
export async function ensureLocalities() {
  if (await Locality.estimatedDocumentCount()) return 0;
  await Locality.insertMany(
    SOCIETIES.map((s, i) => ({ ...s, active: true, sortOrder: i })),
    { ordered: false },
  ).catch((err) => {
    if (err?.code !== 11000) throw err;
  });
  invalidateLocalities();
  return SOCIETIES.length;
}

/**
 * What one service costs in a locality (UC-C43).
 *
 *  1. a fixed price set for that service in that locality, if there is one;
 *  2. otherwise the locality's fallback: the catalog price, or catalog ± % / ₹;
 *  3. with no locality at all, the catalog price.
 *
 * @returns {{ price: number, listPrice: number, source: 'catalog'|'fallback'|'fixed' }}
 */
export function localityPrice(locality, service) {
  const listPrice = round2(service.basePrice);
  if (!locality) return { price: listPrice, listPrice, source: 'catalog' };

  const fixed = (locality.pricing?.prices || []).find((p) => p.serviceCode === service.code);
  if (fixed) return { price: round2(Math.max(0, fixed.price)), listPrice, source: 'fixed' };

  const { fallback = 'catalog', fallbackValue = 0 } = locality.pricing || {};
  if (fallback === 'percent' && fallbackValue) {
    return { price: round2(Math.max(0, listPrice * (1 + fallbackValue / 100))), listPrice, source: 'fallback' };
  }
  if (fallback === 'flat' && fallbackValue) {
    return { price: round2(Math.max(0, listPrice + fallbackValue)), listPrice, source: 'fallback' };
  }
  return { price: listPrice, listPrice, source: 'catalog' };
}

/** How a locality's fallback reads: "Catalog prices", "Catalog +10%", "Catalog −₹20". */
export function fallbackText(locality) {
  const { fallback = 'catalog', fallbackValue = 0 } = locality?.pricing || {};
  if (fallback === 'percent' && fallbackValue) return `Catalog ${fallbackValue > 0 ? '+' : '−'}${Math.abs(fallbackValue)}%`;
  if (fallback === 'flat' && fallbackValue) return `Catalog ${fallbackValue > 0 ? '+' : '−'}₹${Math.abs(fallbackValue)}`;
  return 'Catalog prices';
}

/** The catalog as a locality sees it: every price already resolved. */
export async function pricedForLocality(services, code) {
  const locality = await localityByCode(code);
  return {
    locality,
    services: services.map((service) => {
      const { price, listPrice, source } = localityPrice(locality, service);
      return { ...service, basePrice: price, listPrice, priceSource: source };
    }),
  };
}
