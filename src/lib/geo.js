const R_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function distanceKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return Number.POSITIVE_INFINITY;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}

/**
 * A degrees box around a point, used to narrow the candidate set in Mongo
 * before the exact haversine pass runs in memory.
 */
export function boundingBox({ lat, lng }, radiusKm) {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.max(Math.cos(toRad(lat)), 0.01));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}
