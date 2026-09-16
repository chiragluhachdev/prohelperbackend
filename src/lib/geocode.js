/**
 * Street addresses for map pins, and place search, from OpenStreetMap's
 * Nominatim service — free, no key.
 *
 * Its usage policy asks for an identifying User-Agent and at most one request
 * a second, so every lookup goes through here rather than from the phones:
 * results are cached (a pin nudged a few metres asks nothing new), and calls
 * are spaced out. At real volume this is the one file to point at a paid
 * geocoder instead.
 */
const BASE = process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org';
const USER_AGENT = process.env.GEOCODER_USER_AGENT || 'ProHelper/1.0 (support@prohelper.in)';

const cache = new Map();
const CACHE_MAX = 2000;
const CACHE_MS = 24 * 3600_000;
let lastCall = 0;

async function politeFetch(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  // One call a second at most, as the service asks.
  const wait = Math.max(0, lastCall + 1100 - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`geocoder ${res.status}`);
  const value = await res.json();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(url, { at: Date.now(), value });
  return value;
}

/** "Tower 3, RPS Savana, Sector 88, Faridabad" — the useful parts, without country and postcode noise. */
function shortAddress(a = {}, fallback = '') {
  const parts = [
    a.building || a.house_number && a.road ? [a.house_number, a.road].filter(Boolean).join(' ') : a.road,
    a.neighbourhood || a.residential || a.quarter,
    a.suburb,
    a.city || a.town || a.village || a.county,
  ].filter(Boolean);
  const unique = [...new Set(parts)];
  return unique.length ? unique.join(', ') : fallback;
}

/** The street address at a point, or '' when the lookup fails — a pin is still a valid address without it. */
export async function reverseGeocode(lat, lng) {
  const la = Number(lat).toFixed(5);
  const lo = Number(lng).toFixed(5);
  try {
    const data = await politeFetch(`${BASE}/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${la}&lon=${lo}`);
    return {
      formatted: shortAddress(data.address, data.display_name || ''),
      full: data.display_name || '',
      pincode: data.address?.postcode || '',
    };
  } catch (err) {
    console.warn('[geocode] reverse failed', err.message);
    return { formatted: '', full: '', pincode: '' };
  }
}

/** Places matching what a customer typed, in India, nearest to where they are looking first. */
export async function searchPlaces(q, near) {
  const query = String(q || '').trim().slice(0, 120);
  if (query.length < 3) return [];
  const bias = near && Number.isFinite(near.lat) && Number.isFinite(near.lng)
    ? `&viewbox=${near.lng - 0.25},${near.lat + 0.25},${near.lng + 0.25},${near.lat - 0.25}`
    : '';
  try {
    const rows = await politeFetch(
      `${BASE}/search?format=jsonv2&addressdetails=1&countrycodes=in&limit=6${bias}&q=${encodeURIComponent(query)}`,
    );
    return rows.map((r) => ({
      name: r.name || shortAddress(r.address, r.display_name).split(',')[0],
      formatted: shortAddress(r.address, r.display_name),
      lat: Number(r.lat),
      lng: Number(r.lon),
    }));
  } catch (err) {
    console.warn('[geocode] search failed', err.message);
    return [];
  }
}
