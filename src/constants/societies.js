/**
 * The societies Pro Helper currently serves.
 *
 * The MVP works at society granularity rather than free-form addresses or live
 * location: a customer picks the one they live in, a helper picks the ones they
 * will work in, and a match is an overlap between the two. Coordinates are the
 * approximate society centre, kept because the schema and the distance helper
 * still speak lat/lng — they are not used for precise positioning.
 */
export const SOCIETIES = [
  // Positions from OpenStreetMap (RPS Savana Road, Sector 88). Admins fine-tune them on the map.
  { code: 'rps_savana', name: 'RPS Savana', area: 'Sector 88', city: 'Faridabad', pincode: '121002', lat: 28.4148, lng: 77.3543, radiusKm: 1 },
  { code: 'rps_auria',  name: 'RPS Auria',  area: 'Sector 88', city: 'Faridabad', pincode: '121002', lat: 28.4209, lng: 77.3542, radiusKm: 1 },
  { code: 'rps_palms',  name: 'RPS Palms',  area: 'Sector 88', city: 'Faridabad', pincode: '121002', lat: 28.4157, lng: 77.3543, radiusKm: 1 },
];

export const SOCIETY_CODES = SOCIETIES.map((s) => s.code);

export const societyByCode = (code) => SOCIETIES.find((s) => s.code === code) || null;
