/**
 * How a booking's search is timed. Pure functions — no database — so the
 * rules can be tested directly and read in one place.
 *
 * Two shapes of search:
 *
 *  instant    The customer wants someone now. The search is a short window
 *             (5 min): helpers are alerted as soon as they can take it, and an
 *             unanswered helper is reminded every re-notify interval.
 *
 *  scheduled  The slot is hours or days away. No countdown: the time until
 *             shortly before the slot is split into a few evenly spaced waves,
 *             and every available helper is alerted at each one.
 *
 * A "later" booking whose slot is too close for spread-out waves is searched
 * the instant way — at that point it is urgent in all but name.
 */

/** The instant search's cadence, clamped so the numbers make sense together. */
export function searchTimings(settings) {
  const duration = Math.max(10, Number(settings.search_duration_seconds) || 300);
  const interval = Math.max(2, Number(settings.renotify_interval_seconds) || 90);
  const ring = Math.min(Math.max(2, Number(settings.accept_window_seconds) || 60), interval);
  const scan = Math.min(10, Math.max(2, Math.floor(ring / 3)));
  return { duration, interval, ring, scan };
}

export const MAX_WAVES = 12;

/** The scheduled search's shape, from settings. */
export function scheduledTimings(settings) {
  const waves = Math.min(MAX_WAVES, Math.max(1, Math.round(Number(settings.scheduled_notify_waves) || 5)));
  const closeBeforeMs = Math.max(0, Number(settings.scheduled_close_minutes_before ?? 30)) * 60_000;
  return { waves, closeBeforeMs };
}

/**
 * Decide how a search that starts `now` should run.
 *
 * @returns {{ mode: 'instant'|'scheduled', expiresAt: Date, waves: number, waveGapMs: number }}
 */
export function planSearch({ now = Date.now(), bookingType, scheduledAt, settings }) {
  const { duration, interval } = searchTimings(settings);
  const { waves, closeBeforeMs } = scheduledTimings(settings);
  const nowMs = now instanceof Date ? now.getTime() : now;

  const slot = scheduledAt ? new Date(scheduledAt).getTime() : NaN;
  const closesAt = slot - closeBeforeMs;
  const window = closesAt - nowMs;

  // Waves need room: at least an instant search's length, and at least one
  // re-notify interval between waves, or they would crowd into spam.
  const minWindow = Math.max(duration * 1000, waves * interval * 1000);

  if (bookingType !== 'instant' && Number.isFinite(slot) && window >= minWindow) {
    return { mode: 'scheduled', expiresAt: new Date(closesAt), waves, waveGapMs: window / waves };
  }
  return { mode: 'instant', expiresAt: new Date(nowMs + duration * 1000), waves: 0, waveGapMs: 0 };
}

/** When wave `index` (0-based) of a scheduled search is due. */
export const waveDueAt = (startedAt, expiresAt, waves, index) =>
  new Date(new Date(startedAt).getTime() + ((new Date(expiresAt) - new Date(startedAt)) / waves) * index);

/** How soon to look again after a wave found nobody available. */
export const EMPTY_WAVE_RECHECK_MS = 5 * 60_000;
