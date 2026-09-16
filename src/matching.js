import mongoose from 'mongoose';
import { HelperProfile, JobRequest, Task, User } from './models/index.js';
import { TASK_STATUS, HELPER_APPROVAL, ROLES } from './config.js';
import { getSettings } from './lib/settings.js';
import { distanceKm } from './lib/geo.js';
import { allLocalities } from './lib/localities.js';
import { closeJobAlerts, notify, notifyMany } from './lib/notify.js';
import { mustTransition, transition } from './lib/taskflow.js';
import { conflict } from './lib/http.js';
import { EMPTY_WAVE_RECHECK_MS, planSearch, searchTimings, waveDueAt } from './lib/searchPlan.js';
import { startCodeFields } from './lib/startCode.js';
import { helperNames, logMatching } from './lib/matchLog.js';
import { notifyAdmins, recordRejection } from './lib/accounts.js';
import { cancelBooking } from './lib/cancellation.js';
import { expectedEndAt } from './lib/views.js';

export { searchTimings, planSearch };

/**
 * UC-C08 — who is allowed to be alerted for this task.
 *
 * Every one of these is a hard gate: approved, not blocked, online, not on DND,
 * not busy at that hour, and offers at least one of the requested services.
 * Where they work is the admin's call (`match_mode`):
 *
 *  anywhere  every available helper, whatever localities they chose
 *  society   only helpers who chose the booking's locality
 *
 * The distance shown to the helper is from the nearest locality they work in
 * to the booking's address — a rough "how far", not a tracked position.
 */
export async function findEligibleHelpers(task, { excludeHelperIds = [], mode = 'anywhere' }) {
  const point = { lat: task.address.lat, lng: task.address.lng };
  const requestedCodes = task.services.map((s) => s.code);

  const query = {
    approvalStatus: HELPER_APPROVAL.APPROVED,
    isOnline: true,
    dnd: false,
    services: { $in: requestedCodes },
    userId: { $nin: excludeHelperIds },
  };
  const society = task.address?.society;
  if (mode === 'society' && society) query.societies = society;

  const [profiles, busyIds, localities] = await Promise.all([
    HelperProfile.find(query).populate('userId', 'name phone photoUrl status').lean(),
    // Helpers already committed to something at this hour are not offered more work.
    busyHelperIds(task),
    allLocalities(),
  ]);

  const candidates = [];
  for (const profile of profiles) {
    const user = profile.userId;
    if (!user || user.status !== 'active') continue;
    if (busyIds.has(String(user._id))) continue;

    const km = workAreaDistance(profile, point, localities);
    const offered = new Set(profile.services || []);
    const matchedAll = requestedCodes.every((code) => offered.has(code));

    candidates.push({
      helperId: user._id,
      name: user.name,
      // Unknown stays unknown, not "0 km".
      distanceKm: Number.isFinite(km) ? Math.round(km * 10) / 10 : null,
      matchedAllServices: matchedAll,
      rating: profile.ratingAvg || 0,
      completedJobs: profile.completedJobs || 0,
    });
  }

  // Priority per spec: full-service matches first, then nearest, then best rated.
  candidates.sort(
    (a, b) =>
      Number(b.matchedAllServices) - Number(a.matchedAllServices) ||
      (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) ||
      b.rating - a.rating,
  );
  return candidates;
}

/** From the nearest locality a helper works in to a point; Infinity when none has a position. */
export function workAreaDistance(profile, point, localities = []) {
  if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) return Number.POSITIVE_INFINITY;
  const distances = (profile.societies || [])
    .map((code) => localities.find((l) => l.code === code))
    .filter((l) => l && Number.isFinite(l.lat) && Number.isFinite(l.lng) && (l.lat || l.lng))
    .map((l) => distanceKm({ lat: l.lat, lng: l.lng }, point));
  return distances.length ? Math.min(...distances) : Number.POSITIVE_INFINITY;
}

/** Helpers whose accepted/in-progress job overlaps this task's time window. */
async function busyHelperIds(task) {
  const start = new Date(task.scheduledAt);
  const end = new Date(start.getTime() + (task.durationMins || 60) * 60_000);
  const window = 30 * 60_000; // treat jobs within half an hour as a clash

  const rows = await Task.find({
    _id: { $ne: task._id },
    helperId: { $ne: null },
    status: { $in: [TASK_STATUS.ACCEPTED, TASK_STATUS.IN_PROGRESS, TASK_STATUS.COMPLETION_PENDING] },
    scheduledAt: { $gte: new Date(start.getTime() - window - 4 * 3600_000), $lte: new Date(end.getTime() + window) },
  })
    .select('helperId scheduledAt durationMins')
    .lean();

  const busy = new Set();
  for (const row of rows) {
    const rStart = new Date(row.scheduledAt).getTime();
    const rEnd = rStart + (row.durationMins || 60) * 60_000;
    if (rStart < end.getTime() + window && rEnd + window > start.getTime()) {
      busy.add(String(row.helperId));
    }
  }
  return busy;
}

/** Moves a freshly created task into SEARCHING and asks for an immediate first wave. */
/** The fields that start (or restart) a search, planned for this booking. */
export function searchFields(booking, settings, now = new Date()) {
  const plan = planSearch({ now, bookingType: booking.bookingType, scheduledAt: booking.scheduledAt, settings });
  return {
    searchStartedAt: now,
    searchExpiresAt: plan.expiresAt,
    searchMode: plan.mode,
    searchWaves: plan.waves,
    wavesSent: 0,
    nextDispatchAt: now,
    dispatchRound: 0,
  };
}

export async function startSearch(taskId, actorId) {
  const settings = await getSettings();
  const booking = await Task.findById(taskId).select('bookingType scheduledAt').lean();
  if (!booking) return null;
  const task = await transition(taskId, [TASK_STATUS.CREATED], TASK_STATUS.SEARCHING, {
    set: searchFields(booking, settings),
    actorType: 'customer',
    actorId,
    reason: 'Booking confirmed',
  });
  if (task) {
    await logSearchStarted(task, settings, 'Search started');
    setImmediate(() => dispatchTask(task._id).catch((e) => console.error('[match]', e.message)));
  }
  return task;
}

/** The admin's matching mode: every available helper, or only those who work in the locality. */
export const matchMode = (settings) => (settings.match_mode === 'society' ? 'society' : 'anywhere');

/** How the search area reads in the matching history. */
function matchAreaText(settings) {
  return matchMode(settings) === 'society' ? 'Helpers in this locality' : 'All available helpers';
}

/** The first line of a booking's matching history: how this search is going to run. */
export async function logSearchStarted(task, settings, reason = 'Search started') {
  const scheduled = task.searchMode === 'scheduled';
  return logMatching(task._id, reason, {
    step: 'SEARCH_STARTED',
    mode: task.searchMode || 'instant',
    startedAt: task.searchStartedAt,
    closesAt: task.searchExpiresAt,
    waves: scheduled ? task.searchWaves : undefined,
    remindEverySeconds: scheduled ? undefined : Number(settings.renotify_interval_seconds) || undefined,
    area: matchAreaText(settings),
  });
}

/**
 * Sends one wave of alerts for a task. Called by the ticker; also called
 * directly right after a booking is created so the first wave is instant.
 */
export async function dispatchTask(taskId) {
  const settings = await getSettings();
  const { duration, interval, ring, scan } = searchTimings(settings);
  const now = new Date();

  // Claim the task for this pass so two ticks can never work on it at once.
  const task = await Task.findOneAndUpdate(
    { _id: taskId, status: TASK_STATUS.SEARCHING, nextDispatchAt: { $lte: now } },
    { $set: { nextDispatchAt: new Date(now.getTime() + 60_000) }, $inc: { dispatchRound: 1 } },
    { new: true },
  );
  if (!task) return null; // already assigned, cancelled, or another tick has it

  /*
   * One search is a window of time. Inside it, every pass does two things:
   * alerts helpers who have just become available, and re-alerts any helper
   * who was alerted but has neither accepted nor declined, once their own
   * re-notify interval has passed. When the window closes, the search ends.
   */
  const startedAt = task.searchStartedAt || task.createdAt;
  const deadline = task.searchExpiresAt || new Date(startedAt.getTime() + duration * 1000);
  if (now >= deadline) return exhaust(task, 'Nobody accepted within the search window');

  const scheduled = task.searchMode === 'scheduled';
  const mode = matchMode(settings);
  const ignoreLocation = mode === 'anywhere';

  // Every alert this task has ever sent, newest first per helper.
  const history = await JobRequest.find({ taskId: task._id }).sort({ round: -1 }).lean();
  const latest = new Map();
  for (const r of history) if (!latest.has(String(r.helperId))) latest.set(String(r.helperId), r);

  // A helper who declined during THIS search is never asked again in it, and
  // one who took this booking and dropped it is never asked again at all.
  const declined = [
    ...[...latest.values()].filter((r) => r.status === 'DECLINED' && r.sentAt >= startedAt).map((r) => r.helperId),
    ...(task.helperCancellations || []).map((c) => c.helperId),
  ];

  const candidates = await findEligibleHelpers(task, { excludeHelperIds: declined, mode });

  const fresh = [];
  const renotify = [];
  for (const c of candidates) {
    const last = latest.get(String(c.helperId));
    if (!last || last.sentAt < startedAt) {
      fresh.push(c); // not yet alerted in this search
    } else if (last.status === 'SENT' && last.expiresAt > now) {
      // still ringing — leave it alone
    } else if (scheduled || now - last.sentAt >= interval * 1000) {
      // Unanswered: reminded when their interval passes — or, for a booking
      // for later, at every wave.
      renotify.push(c);
    }
  }

  /*
   * A scheduled search only alerts on its waves. Between them it does
   * nothing but wake at the next one; the close still ends it on time.
   */
  const wavesPlanned = task.searchWaves || 1;
  const wavesSent = task.wavesSent || 0;
  const waveAt = scheduled ? waveDueAt(startedAt, deadline, wavesPlanned, wavesSent) : null;
  const alertingNow = !scheduled || (wavesSent < wavesPlanned && now >= waveAt);

  const newcomers = ignoreLocation ? fresh : fresh.slice(0, settings.dispatch_batch_size);
  const batch = alertingNow ? [...renotify, ...newcomers] : [];
  const remainingMs = deadline - now;
  let sent = false;

  // An alert with only a few seconds left to answer helps nobody.
  if (batch.length && remainingMs >= Math.min(15_000, ring * 1000)) {
    sent = true;
    const expiresAt = new Date(Math.min(now.getTime() + ring * 1000, deadline.getTime()));
    const ids = batch.map((c) => c.helperId);

    // A helper only ever has one live alert per job.
    await JobRequest.updateMany({ taskId: task._id, helperId: { $in: ids }, status: 'SENT' }, { $set: { status: 'EXPIRED' } });

    await JobRequest.insertMany(
      batch.map((c) => ({
        taskId: task._id,
        helperId: c.helperId,
        // Counts every alert this helper has had for this job, across searches.
        round: (latest.get(String(c.helperId))?.round || 0) + 1,
        status: 'SENT',
        distanceKm: c.distanceKm,
        matchedAllServices: c.matchedAllServices,
        sentAt: now,
        expiresAt,
        notificationStatus: 'SENT',
      })),
      { ordered: false },
    );

    const serviceNames = task.services.map((sv) => sv.name).join(', ');
    const pushData = {
      taskId: String(task._id),
      code: task.code,
      expiresAt,
      // What the ringing notification draws. The helper sees their payout,
      // never the customer's bill — the same rule as every helper screen.
      serviceName: serviceNames,
      serviceNameHi: task.services.map((sv) => sv.nameHi || sv.name).join(', '),
      location: task.address?.society
        ? `${task.address.label || 'Home'} · ${task.address.line2 || ''}`.trim()
        : task.address?.label || task.address?.city || 'Nearby',
      price: task.pricing?.helperPayout ?? '',
      bookingType: task.bookingType || 'scheduled',
    };
    const title = 'New job request';
    const body = `${serviceNames} · ${task.address?.label || task.address?.city || 'Nearby'}`;

    // First alert: an entry in their notifications list, and the phone rings.
    if (newcomers.length) {
      await notifyMany(newcomers.map((c) => c.helperId), 'JOB_REQUEST', title, body, pushData);
    }
    // Reminders ring the phone again but do not pile duplicates into the list.
    if (renotify.length) {
      await notifyMany(renotify.map((c) => c.helperId), 'JOB_REQUEST', title, body, pushData, { store: false });
    }

    const [alertedNames, remindedNames] = await Promise.all([
      helperNames(newcomers.map((c) => c.helperId)),
      helperNames(renotify.map((c) => c.helperId)),
    ]);
    const parts = [];
    if (newcomers.length) parts.push(`alerted ${newcomers.length} helper${newcomers.length === 1 ? '' : 's'}`);
    if (renotify.length) parts.push(`reminded ${renotify.length}`);
    await logMatching(task._id, `${scheduled ? `Wave ${wavesSent + 1} of ${wavesPlanned}: ` : ''}${parts.join(', ')}`.replace(/^./, (c) => c.toUpperCase()), {
      step: 'ALERTS_SENT',
      round: task.dispatchRound,
      wave: scheduled ? wavesSent + 1 : undefined,
      alerted: alertedNames,
      reminded: remindedNames,
      ringsUntil: expiresAt,
      area: matchAreaText(settings),
    });

    console.log(
      `[match] ${task.code} → ${newcomers.length} new, ${renotify.length} re-notified` +
        (scheduled ? ` (wave ${wavesSent + 1}/${wavesPlanned})` : '') +
        (mode === 'society' ? ' (same locality)' : ' (all areas)') +
        ` · ${Math.round(remainingMs / 1000)}s left`,
    );
  }

  let nextAt;
  const update = {};
  if (!scheduled) {
    // Look again shortly — a helper may come online.
    nextAt = now.getTime() + scan * 1000;
  } else if (!alertingNow) {
    // Between waves: sleep until the next one, or the close.
    nextAt = wavesSent < wavesPlanned ? waveAt.getTime() : deadline.getTime();
  } else if (sent) {
    // A wave went out: the next is on the plan's timetable.
    update.wavesSent = wavesSent + 1;
    nextAt = wavesSent + 1 < wavesPlanned
      ? waveDueAt(startedAt, deadline, wavesPlanned, wavesSent + 1).getTime()
      : deadline.getTime();
  } else if (remainingMs < Math.min(15_000, ring * 1000)) {
    nextAt = deadline.getTime();
  } else {
    // Nobody available for this wave. Do not spend it: look again soon, so a
    // helper who comes online now is not left waiting hours for the next one.
    nextAt = now.getTime() + EMPTY_WAVE_RECHECK_MS;
  }

  await Task.updateOne(
    { _id: task._id, status: TASK_STATUS.SEARCHING },
    { $set: { ...update, nextDispatchAt: new Date(Math.min(nextAt, deadline.getTime())) } },
  );
  return batch;
}

/** UC-C13 — nobody left to ask. */
async function exhaust(task, reason) {
  const updated = await transition(task._id, [TASK_STATUS.SEARCHING], TASK_STATUS.NO_HELPER_AVAILABLE, {
    set: { nextDispatchAt: null },
    actorType: 'system',
    reason,
  });
  if (updated) {
    await JobRequest.updateMany({ taskId: task._id, status: 'SENT' }, { $set: { status: 'CANCELLED' } });
    await closeJobAlerts(task._id);
    await notify(
      task.customerId,
      'NO_HELPER_AVAILABLE',
      'No helper available',
      'We could not find a helper this time. Tap to search again.',
      {
        taskId: String(task._id),
        code: task.code,
        serviceName: task.services.map((sv) => sv.name).join(', '),
        serviceNameHi: task.services.map((sv) => sv.nameHi || sv.name).join(', '),
      },
    );
    const asked = await JobRequest.distinct('helperId', { taskId: task._id });
    await logMatching(task._id, `Search closed — nobody accepted${asked.length ? ` (${asked.length} alerted)` : ', nobody was available'}`, {
      step: 'SEARCH_CLOSED', why: reason, alertedCount: asked.length,
    });
    console.log(`[match] ${task.code} → NO_HELPER_AVAILABLE (${reason})`);
  }
  return null;
}

/**
 * UC-C10 / UC-C51 / UC-C52 — the helper presses Accept.
 *
 * Two guarded writes, in this order:
 *   1. claim the job request (proves the helper was invited and is inside the 60s)
 *   2. claim the task itself (proves nobody else got there first)
 * If step 2 fails, step 1 is rolled back and the loser is told plainly.
 */
export async function acceptJob(taskId, helperId) {
  const now = new Date();

  /*
   * A helper can take the job at any point while it is still being searched
   * for, as long as they were alerted and have not declined. A reminder that
   * has stopped ringing is not a "no" — only Decline is.
   */
  const settings = await getSettings();
  const afterRingAllowed = settings.accept_after_ring_enabled !== false;
  const latest = await JobRequest.findOne({ taskId, helperId }).sort({ round: -1 }).lean();
  const openStatuses = afterRingAllowed ? ['SENT', 'EXPIRED'] : ['SENT'];
  if (!latest || !openStatuses.includes(latest.status)) {
    throw conflict('This job is no longer available.', 'REQUEST_NOT_AVAILABLE');
  }
  /*
   * UC-C52 — the phone's countdown decides nothing. An alert that is still
   * ringing has to still be ringing *here*, by this server's clock; whether a
   * lapsed alert can still be taken while the search itself is open is the
   * admin's rule, and either way the task claim below is the real gate.
   */
  if (latest.status === 'SENT' && new Date(latest.expiresAt) <= now && !afterRingAllowed) {
    throw conflict('This job is no longer available.', 'REQUEST_NOT_AVAILABLE');
  }
  const request = await JobRequest.findOneAndUpdate(
    { _id: latest._id, status: latest.status },
    { $set: { status: 'ACCEPTED', respondedAt: now } },
    { new: true },
  );
  if (!request) throw conflict('This job is no longer available.', 'REQUEST_NOT_AVAILABLE');

  const task = await transition(taskId, [TASK_STATUS.SEARCHING], TASK_STATUS.ACCEPTED, {
    // The customer's start code is issued the moment someone takes the job.
    set: { helperId, acceptedAt: now, nextDispatchAt: null, ...startCodeFields() },
    extraFilter: { helperId: null },
    actorType: 'helper',
    actorId: helperId,
    reason: 'Helper accepted',
  });

  if (!task) {
    // Undo our claim on the request, then say what actually happened.
    await JobRequest.updateOne({ _id: request._id }, { $set: { status: 'CANCELLED' } });
    const current = await Task.findById(taskId).select('status helperId').lean();
    if (current?.helperId) {
      throw conflict('This job has just been taken by another helper.', 'TASK_ALREADY_ASSIGNED');
    }
    throw conflict('This job is no longer available.', 'REQUEST_NOT_AVAILABLE');
  }

  // Stand every other outstanding alert down.
  const losers = await JobRequest.find({
    taskId,
    status: 'SENT',
    _id: { $ne: request._id },
  }).distinct('helperId');
  await JobRequest.updateMany(
    { taskId, status: 'SENT', _id: { $ne: request._id } },
    { $set: { status: 'CANCELLED', respondedAt: now } },
  );
  if (losers.length) {
    await notifyMany(losers, 'JOB_TAKEN', 'Job no longer available', 'Another helper accepted this job.', {
      taskId: String(taskId),
    });
  }
  // Every other phone this job is ringing on stops now, not when its timer runs out.
  await closeJobAlerts(taskId, { except: helperId });

  const helper = await User.findById(helperId).select('name phone photoUrl').lean();
  // Who did the job stays on the booking as they were then (UC-C19).
  await Task.updateOne({ _id: task._id }, { $set: { helperSnapshot: { name: helper?.name || '', phone: helper?.phone || '' } } });
  const { start_otp_enabled: startCodeOn } = await getSettings();
  const startCode = startCodeOn ? (await Task.findById(task._id).select('+startOtp.code').lean())?.startOtp?.code : null;
  await notify(
    task.customerId,
    'BOOKING_ACCEPTED',
    'Helper assigned',
    `${helper?.name || 'A helper'} accepted your booking ${task.code}.` +
      (startCode ? ` Share start code ${startCode} when they arrive.` : ''),
    {
      taskId: String(task._id),
      code: task.code,
      startCode: startCode || '',
      helperName: helper?.name || '',
      serviceName: task.services.map((sv) => sv.name).join(', '),
      serviceNameHi: task.services.map((sv) => sv.nameHi || sv.name).join(', '),
    },
  );

  const waited = task.searchStartedAt ? Math.round((now - new Date(task.searchStartedAt)) / 1000) : undefined;
  await logMatching(task._id, `Accepted by ${helper?.name || 'a helper'}`, {
    step: 'ACCEPTED', helper: { id: String(helperId), name: helper?.name || '' }, secondsAfterStart: waited,
  });
  console.log(`[match] ${task.code} accepted by ${helper?.name}`);
  return { task, helper };
}

/** UC-C11 — decline. Recorded, then the search moves on straight away. */
export async function declineJob(taskId, helperId) {
  const now = new Date();
  /*
   * Declining is final for this search: the helper is not reminded again. It
   * no longer brings the next pass forward either — the search is a window of
   * time, and helpers still ringing, or about to come online, keep their turn.
   */
  const latest = await JobRequest.findOne({ taskId, helperId }).sort({ round: -1 }).lean();
  if (!latest || !['SENT', 'EXPIRED'].includes(latest.status)) {
    throw conflict('This request is no longer open.', 'REQUEST_NOT_AVAILABLE');
  }
  const request = await JobRequest.findOneAndUpdate(
    { _id: latest._id, status: latest.status },
    { $set: { status: 'DECLINED', respondedAt: now } },
    { new: true },
  );
  if (!request) throw conflict('This request is no longer open.', 'REQUEST_NOT_AVAILABLE');

  const [who] = await helperNames([helperId]);
  await logMatching(taskId, `${who?.name || 'A helper'} declined`, { step: 'DECLINED', helper: who, round: request.round });
  const task = await Task.findById(taskId).select('code').lean();
  await recordRejection(helperId, { kind: 'JOB_DECLINED', task });
  return request;
}

/**
 * A helper stops being this booking's helper before starting it (UC-C22) —
 * because they dropped it, or their account was blocked.
 *
 * `research` (the default, from `helper_cancel_action`): the booking goes back
 * to searching and the customer keeps it, with this helper never asked again.
 * `cancel`: the booking ends. A booking for later whose slot has already
 * passed is always cancelled — there is nothing left to search for.
 *
 * The drop is kept on the booking either way, and counts as a rejection for
 * the helper when they chose it.
 */
export async function releaseHelperJob(taskId, { by, actorId, reason, action, countRejection = by === 'helper' }) {
  const settings = await getSettings();
  const now = new Date();
  const task = await Task.findById(taskId);
  if (!task) throw conflict('This booking is no longer available.', 'INVALID_STATE');
  if (task.status !== TASK_STATUS.ACCEPTED || !task.helperId) {
    throw conflict('Only a job that has not started can be dropped.', 'NOT_CANCELLABLE');
  }

  const helperId = task.helperId;
  const helper = await User.findById(helperId).select('name phone').lean();
  const drop = { helperId, helperName: helper?.name || '', by, reason, previousStatus: task.status, at: now };
  const slotPassed = task.bookingType !== 'instant' && task.scheduledAt && new Date(task.scheduledAt) <= now;
  const research = (action || settings.helper_cancel_action) !== 'cancel' && !slotPassed;
  const who = by === 'helper' ? helper?.name || 'The helper' : by === 'admin' ? 'An admin' : 'Pro Helper';
  const meta = { step: 'HELPER_CANCELLED', helperId: String(helperId), helperName: helper?.name || '', by };

  let updated;
  if (research) {
    updated = await transition(task._id, [TASK_STATUS.ACCEPTED], TASK_STATUS.SEARCHING, {
      set: { ...searchFields(task, settings, now), acceptedAt: null },
      unset: { helperId: '', 'startOtp.code': '' },
      extraFilter: { helperId },
      actorType: by, actorId,
      reason: `${who} dropped the job: ${reason}`,
      meta,
    });
    if (!updated) throw conflict('This job has already moved on.', 'INVALID_STATE');
    await Task.updateOne({ _id: task._id }, { $push: { helperCancellations: drop } });
    await JobRequest.updateMany({ taskId: task._id, helperId, status: 'ACCEPTED' }, { $set: { status: 'CANCELLED' } });
    await logSearchStarted(updated, settings, `Search restarted — ${helper?.name || 'the helper'} dropped the job`);
    setImmediate(() => dispatchTask(updated._id).catch((e) => console.error('[match]', e.message)));

    await notify(task.customerId, 'HELPER_CANCELLED', 'Finding you another helper',
      `${helper?.name || 'Your helper'} can no longer make it to ${task.code}. We are finding someone else.`,
      { taskId: String(task._id), code: task.code, helperName: helper?.name || '', research: '1' });
  } else {
    updated = await mustTransition(task._id, [TASK_STATUS.ACCEPTED], TASK_STATUS.CANCELLED, {
      set: {
        nextDispatchAt: null,
        cancellation: { by, byUserId: actorId, reason, previousStatus: task.status, at: now },
      },
      extraFilter: { helperId },
      actorType: by, actorId, reason,
      meta,
    });
    await Task.updateOne({ _id: task._id }, { $push: { helperCancellations: drop } });
    await notify(task.customerId, 'HELPER_CANCELLED', 'Booking cancelled',
      `${helper?.name || 'Your helper'} cancelled ${task.code}.`,
      { taskId: String(task._id), code: task.code, helperName: helper?.name || '', research: '' });
  }

  if (countRejection) await recordRejection(helperId, { kind: 'HELPER_CANCELLED', task, reason });
  return { task: updated, research };
}



/**
 * UC-C54 — picking up where the server left off.
 *
 * Nothing about a booking lives in this process: the search window, the next
 * alert, the state of every job are all rows in the database. So a restart
 * (a deploy, a crash, a machine moving) only has to notice the work that was
 * in flight and carry on with it:
 *
 *  - a booking created but never searched for (the server died in between)
 *    starts its search now;
 *  - a search whose next round is missing or long overdue is nudged, rather
 *    than sitting still until someone touches it;
 *  - anything whose window closed while the server was down is closed on the
 *    next tick by the ordinary dispatch path.
 *
 * Every step is safe to run twice: each one claims its row before acting.
 */
export async function recoverOnBoot() {
  if (mongoose.connection.readyState !== 1) return { started: 0, nudged: 0 };
  const now = new Date();
  let started = 0;

  // Bookings that never got their search going.
  const orphans = await Task.find({ status: TASK_STATUS.CREATED, createdAt: { $lte: new Date(now.getTime() - 5_000) } })
    .select('_id customerId')
    .limit(50)
    .lean();
  for (const t of orphans) {
    const task = await startSearch(t._id, t.customerId).catch((err) => {
      console.error('[recover] could not start search', String(t._id), err.message);
      return null;
    });
    if (task) started += 1;
  }

  // Searches with no next round booked, or one long past due.
  const stalled = await Task.updateMany(
    {
      status: TASK_STATUS.SEARCHING,
      $or: [{ nextDispatchAt: null }, { nextDispatchAt: { $lte: new Date(now.getTime() - 60_000) } }],
    },
    { $set: { nextDispatchAt: now } },
  );

  if (started || stalled.modifiedCount) {
    console.log(`[recover] ${started} search(es) started, ${stalled.modifiedCount} nudged after restart`);
  }
  return { started, nudged: stalled.modifiedCount };
}

/**
 * The ticker. Everything time-based is enforced here, on the server — the
 * countdown on the helper's phone is decoration (UC-C12, UC-C52).
 */
let timer = null;

export function startDispatcher({ intervalMs = 2000 } = {}) {
  if (timer) return timer;
  timer = setInterval(() => {
    tick().catch((err) => console.error('[dispatcher]', err.message));
  }, intervalMs);
  timer.unref?.();
  console.log(`[dispatcher] running every ${intervalMs}ms`);
  return timer;
}

export function stopDispatcher() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function tick() {
  if (mongoose.connection.readyState !== 1) return;
  const now = new Date();

  // 1. Lapse the alerts nobody answered.
  const expired = await JobRequest.updateMany(
    { status: 'SENT', expiresAt: { $lte: now } },
    { $set: { status: 'EXPIRED' } },
  );
  if (expired.modifiedCount) console.log(`[dispatcher] ${expired.modifiedCount} request(s) expired`);

  // 2. Push the next wave for anything still searching.
  const due = await Task.find({ status: TASK_STATUS.SEARCHING, nextDispatchAt: { $lte: now } })
    .select('_id')
    .limit(25)
    .lean();
  for (const t of due) {
    await dispatchTask(t._id).catch((err) => console.error('[dispatcher] dispatch', err.message));
  }

  // Once a minute is plenty for work measured in hours.
  if (now - lastUpkeep >= UPKEEP_EVERY_MS) {
    lastUpkeep = now;
    const settings = await getSettings();
    await flagOverdueTasks(now, settings).catch((err) => console.error('[dispatcher] overdue', err.message));
    await autoCancelStale(now, settings).catch((err) => console.error('[dispatcher] auto-cancel', err.message));
  }
}

const UPKEEP_EVERY_MS = 60_000;
let lastUpkeep = 0;


/** Open means a helper has it and it isn't closed yet (UC-C18). */
export const OPEN_STATUSES = [TASK_STATUS.ACCEPTED, TASK_STATUS.IN_PROGRESS, TASK_STATUS.COMPLETION_PENDING];

/**
 * UC-C18 — a job still open well past when it should have finished.
 *
 * Overdue once `overdue_reminder_minutes` have passed since its expected
 * finish. Both sides are reminded then, and again every
 * `overdue_repeat_minutes` up to `overdue_max_reminders`; admins are told the
 * first time, and the job shows in their open-task monitoring throughout.
 */
export async function flagOverdueTasks(now = new Date(), settings) {
  settings ||= await getSettings();
  const graceMs = Math.max(0, Number(settings.overdue_reminder_minutes) || 0) * 60_000;
  const repeatMs = Math.max(0, Number(settings.overdue_repeat_minutes) || 0) * 60_000;
  const maxReminders = Math.max(1, Number(settings.overdue_max_reminders) || 1);
  const earliest = new Date(now.getTime() - graceMs);

  const candidates = await Task.find({
    status: { $in: OPEN_STATUSES },
    overdueReminders: { $not: { $gte: maxReminders } },
    $or: [{ startedAt: { $lte: earliest } }, { startedAt: null, scheduledAt: { $lte: earliest } }],
  })
    .select('code status customerId helperId startedAt scheduledAt createdAt durationMins overdueNotifiedAt overdueReminders overdueLastRemindedAt')
    .limit(100)
    .lean();

  let reminded = 0;
  for (const task of candidates) {
    const overdueAt = expectedEndAt(task).getTime() + graceMs;
    if (now.getTime() < overdueAt) continue;
    if (task.overdueLastRemindedAt && (!repeatMs || now - new Date(task.overdueLastRemindedAt) < repeatMs)) continue;

    // Claimed atomically, so two servers never send the same reminder twice.
    const claim = await Task.updateOne(
      { _id: task._id, status: { $in: OPEN_STATUSES }, overdueLastRemindedAt: task.overdueLastRemindedAt ?? null },
      { $set: { overdueLastRemindedAt: now, overdueNotifiedAt: task.overdueNotifiedAt || now }, $inc: { overdueReminders: 1 } },
    );
    if (!claim.modifiedCount) continue;
    reminded += 1;

    const minutesLate = Math.round((now - expectedEndAt(task)) / 60_000);
    const data = { taskId: String(task._id), code: task.code, status: task.status, minutesLate: String(minutesLate) };
    const notStarted = task.status === TASK_STATUS.ACCEPTED;
    await notify(task.customerId, 'TASK_OVERDUE', 'Booking still open',
      notStarted ? `${task.code} was due to be done by now but has not started.` : `${task.code} has not been closed yet.`,
      { ...data, role: 'customer', notStarted: notStarted ? '1' : '' });
    await notify(task.helperId, 'TASK_OVERDUE', 'Please close this job',
      notStarted ? `${task.code} was booked for earlier and has not been started.` : `${task.code} is still open. Close it with the customer's OTP.`,
      { ...data, role: 'helper', notStarted: notStarted ? '1' : '' });
    if (!task.overdueNotifiedAt) {
      await notifyAdmins('TASK_OVERDUE_ADMIN', 'Job overdue', `${task.code} is ${minutesLate} min past its expected finish.`, data);
    }
  }
  return reminded;
}

/**
 * UC-C22 — system cancellation of bookings nobody is going to finish:
 * accepted but never started long after the slot, and searches that found
 * nobody and were never tried again. Both thresholds are admin settings; 0
 * switches either off.
 */
export async function autoCancelStale(now = new Date(), settings) {
  settings ||= await getSettings();
  let cancelled = 0;

  const unstartedHours = Math.max(0, Number(settings.auto_cancel_unstarted_hours) || 0);
  if (unstartedHours > 0) {
    const stale = await Task.find({
      status: TASK_STATUS.ACCEPTED,
      scheduledAt: { $lte: new Date(now.getTime() - unstartedHours * 3_600_000) },
    }).select('_id').limit(20).lean();
    for (const t of stale) {
      const reason = `Not started within ${unstartedHours} hour${unstartedHours === 1 ? '' : 's'} of the booked time`;
      try {
        const { task } = await cancelBooking(t._id, { by: 'system', reason, from: [TASK_STATUS.ACCEPTED] });
        const data = { taskId: String(task._id), code: task.code, reason, by: 'system' };
        await notify(task.customerId, 'BOOKING_CANCELLED', 'Booking cancelled', `${task.code} was cancelled: ${reason}.`, data);
        await notify(task.helperId, 'BOOKING_CANCELLED', 'Booking cancelled', `${task.code} was cancelled: ${reason}.`, data);
        cancelled += 1;
      } catch (err) {
        if (err.status !== 409) console.error('[auto-cancel]', err.message);
      }
    }
  }

  const noHelperHours = Math.max(0, Number(settings.auto_cancel_no_helper_hours) || 0);
  if (noHelperHours > 0) {
    const cutoff = new Date(now.getTime() - noHelperHours * 3_600_000);
    const stale = await Task.find({
      status: TASK_STATUS.NO_HELPER_AVAILABLE,
      $or: [{ searchExpiresAt: { $lte: cutoff } }, { searchExpiresAt: null, updatedAt: { $lte: cutoff } }],
    }).select('_id').limit(20).lean();
    for (const t of stale) {
      const reason = 'No helper was found and the search was not tried again';
      try {
        const { task } = await cancelBooking(t._id, { by: 'system', reason, from: [TASK_STATUS.NO_HELPER_AVAILABLE] });
        await notify(task.customerId, 'BOOKING_CANCELLED', 'Booking closed', `${task.code} was closed: ${reason}.`,
          { taskId: String(task._id), code: task.code, reason, by: 'system' });
        cancelled += 1;
      } catch (err) {
        if (err.status !== 409) console.error('[auto-cancel]', err.message);
      }
    }
  }
  return cancelled;
}
