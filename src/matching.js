import mongoose from 'mongoose';
import { HelperProfile, JobRequest, Task, User } from './models/index.js';
import { TASK_STATUS, HELPER_APPROVAL, ROLES } from './config.js';
import { getSettings } from './lib/settings.js';
import { distanceKm, boundingBox } from './lib/geo.js';
import { closeJobAlerts, notify, notifyMany } from './lib/notify.js';
import { transition } from './lib/taskflow.js';
import { conflict } from './lib/http.js';

/**
 * UC-C08 — who is allowed to be alerted for this task.
 *
 * Every one of these is a hard gate: approved, not blocked, online, not on DND,
 * covers the address, and offers at least one of the requested services.
 * Availability is the online switch alone — there are no working days or
 * hours. Helpers already alerted for this task are skipped so a later round
 * never spams the same person twice.
 */
export async function findEligibleHelpers(task, { radiusKm, excludeHelperIds = [], ignoreLocation = false }) {
  const point = { lat: task.address.lat, lng: task.address.lng };
  const box = boundingBox(point, radiusKm);
  const requestedCodes = task.services.map((s) => s.code);

  const query = {
    approvalStatus: HELPER_APPROVAL.APPROVED,
    isOnline: true,
    dnd: false,
    services: { $in: requestedCodes },
    userId: { $nin: excludeHelperIds },
  };
  /*
   * Location, when it is switched on, means "works in this society" rather
   * than "is within N km" — the MVP serves a handful of named estates, so an
   * overlap is both more accurate and easier to reason about than a radius.
   * Falls back to the bounding box for any helper who predates societies.
   */
  const society = task.address?.society;
  if (!ignoreLocation) {
    if (society) {
      query.societies = society;
    } else {
      query['serviceArea.lat'] = { $gte: box.minLat, $lte: box.maxLat };
      query['serviceArea.lng'] = { $gte: box.minLng, $lte: box.maxLng };
    }
  }

  const profiles = await HelperProfile.find(query)
    .populate('userId', 'name phone photoUrl status')
    .lean();

  // Helpers already committed to something at this hour are not offered more work.
  const busyIds = await busyHelperIds(task);

  const candidates = [];
  for (const profile of profiles) {
    const user = profile.userId;
    if (!user || user.status !== 'active') continue;
    if (busyIds.has(String(user._id))) continue;

    // Distance is still reported so the helper sees how far the job is; in
    // ignore-location mode it simply stops being a reason to exclude anyone.
    const km = distanceKm(profile.serviceArea, point);
    if (!ignoreLocation && !society) {
      const reach = Math.min(radiusKm, profile.serviceArea?.radiusKm ?? radiusKm);
      if (km > reach) continue;
    }

    const offered = new Set(profile.services || []);
    const matchedAll = requestedCodes.every((code) => offered.has(code));

    candidates.push({
      helperId: user._id,
      name: user.name,
      distanceKm: Number.isFinite(km) ? Math.round(km * 10) / 10 : 0,
      matchedAllServices: matchedAll,
      rating: profile.ratingAvg || 0,
      completedJobs: profile.completedJobs || 0,
    });
  }

  // Priority per spec: full-service matches first, then nearest, then best rated.
  candidates.sort(
    (a, b) =>
      Number(b.matchedAllServices) - Number(a.matchedAllServices) ||
      a.distanceKm - b.distanceKm ||
      b.rating - a.rating,
  );
  return candidates;
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
export async function startSearch(taskId, actorId) {
  const task = await transition(taskId, [TASK_STATUS.CREATED], TASK_STATUS.SEARCHING, {
    set: { searchStartedAt: new Date(), nextDispatchAt: new Date(), dispatchRound: 0 },
    actorType: 'customer',
    actorId,
    reason: 'Booking confirmed',
  });
  if (task) setImmediate(() => dispatchTask(task._id).catch((e) => console.error('[match]', e.message)));
  return task;
}

/**
 * Sends one wave of alerts for a task. Called by the ticker; also called
 * directly right after a booking is created so the first wave is instant.
 */
export async function dispatchTask(taskId) {
  const settings = await getSettings();
  const now = new Date();

  // Claim the task for this round so two ticks can never dispatch it at once.
  const task = await Task.findOneAndUpdate(
    { _id: taskId, status: TASK_STATUS.SEARCHING, nextDispatchAt: { $lte: now } },
    { $set: { nextDispatchAt: new Date(now.getTime() + 5 * 60_000) }, $inc: { dispatchRound: 1 } },
    { new: true },
  );
  if (!task) return null; // already assigned, cancelled, or another tick has it

  const round = task.dispatchRound;
  if (round > settings.max_dispatch_rounds) {
    return exhaust(task, 'Searched every nearby helper');
  }

  // Widen the net each round: the first wave goes to the closest helpers, later
  // waves reach further out (UC-C08).
  const ignoreLocation = settings.match_ignore_location !== false;
  const radiusKm = settings.search_radius_km + (round - 1) * settings.radius_step_km;
  const alreadyTried = await JobRequest.find({ taskId: task._id }).distinct('helperId');
  const candidates = await findEligibleHelpers(task, {
    radiusKm,
    excludeHelperIds: alreadyTried,
    ignoreLocation,
  });

  if (candidates.length === 0) {
    // Nothing new within this radius — widen next round, or give up.
    if (round >= settings.max_dispatch_rounds) return exhaust(task, 'No helper accepted the request');
    await Task.updateOne({ _id: task._id }, { $set: { nextDispatchAt: new Date() } });
    return null;
  }

  // Location off means there is no "nearest few" to pick — everyone eligible
  // gets the alert and the first to accept wins.
  const batch = ignoreLocation ? candidates : candidates.slice(0, settings.dispatch_batch_size);

  const expiresAt = new Date(now.getTime() + settings.accept_window_seconds * 1000);

  await JobRequest.insertMany(
    batch.map((c) => ({
      taskId: task._id,
      helperId: c.helperId,
      round,
      status: 'SENT',
      distanceKm: c.distanceKm,
      matchedAllServices: c.matchedAllServices,
      sentAt: now,
      expiresAt,
      notificationStatus: 'SENT',
    })),
    { ordered: false },
  );

  const serviceNames = task.services.map((s) => s.name).join(', ');
  await notifyMany(
    batch.map((c) => c.helperId),
    'JOB_REQUEST',
    'New job request',
    `${serviceNames} · ${task.address?.label || task.address?.city || 'Nearby'}`,
    {
      taskId: String(task._id),
      code: task.code,
      expiresAt,
      // What the ringing notification draws. The helper sees their payout,
      // never the customer's bill — the same rule as every helper screen.
      serviceName: serviceNames,
      location: task.address?.society
        ? `${task.address.label || 'Home'} · ${task.address.line2 || ''}`.trim()
        : task.address?.label || task.address?.city || 'Nearby',
      price: task.pricing?.helperPayout ?? '',
      bookingType: task.bookingType || 'scheduled',
    },
  );

  // Wake up just after this wave lapses to run the next one.
  await Task.updateOne(
    { _id: task._id },
    { $set: { nextDispatchAt: new Date(expiresAt.getTime() + 1000) } },
  );

  console.log(
    `[match] ${task.code} round ${round} → ${batch.length} helper(s)` +
      (ignoreLocation ? ' (all areas)' : ` within ${radiusKm}km`),
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
    await notify(
      task.customerId,
      'NO_HELPER_AVAILABLE',
      'No helper available',
      'We could not find a helper for this slot. Try another time or service.',
      { taskId: String(task._id), code: task.code },
    );
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

  const request = await JobRequest.findOneAndUpdate(
    { taskId, helperId, status: 'SENT', expiresAt: { $gt: now } },
    { $set: { status: 'ACCEPTED', respondedAt: now } },
    { new: true, sort: { round: -1 } },
  );
  if (!request) {
    const any = await JobRequest.findOne({ taskId, helperId }).sort({ round: -1 }).lean();
    if (any?.status === 'EXPIRED' || (any && any.expiresAt <= now)) {
      throw conflict('That request timed out.', 'REQUEST_EXPIRED');
    }
    throw conflict('This job is no longer available.', 'REQUEST_NOT_AVAILABLE');
  }

  const task = await transition(taskId, [TASK_STATUS.SEARCHING], TASK_STATUS.ACCEPTED, {
    set: { helperId, acceptedAt: now, nextDispatchAt: null },
    extraFilter: { helperId: null },
    actorType: 'helper',
    actorId: helperId,
    reason: 'Helper accepted',
  });

  if (!task) {
    // Someone else won the race in between. Undo our claim on the request.
    await JobRequest.updateOne({ _id: request._id }, { $set: { status: 'CANCELLED' } });
    throw conflict('This job has just been taken by another helper.', 'TASK_ALREADY_ASSIGNED');
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
  await notify(
    task.customerId,
    'BOOKING_ACCEPTED',
    'Helper assigned',
    `${helper?.name || 'A helper'} accepted your booking ${task.code}.`,
    { taskId: String(task._id), code: task.code },
  );

  console.log(`[match] ${task.code} accepted by ${helper?.name}`);
  return { task, helper };
}

/** UC-C11 — decline. Recorded, then the search moves on straight away. */
export async function declineJob(taskId, helperId) {
  const now = new Date();
  const request = await JobRequest.findOneAndUpdate(
    { taskId, helperId, status: 'SENT' },
    { $set: { status: 'DECLINED', respondedAt: now } },
    { new: true, sort: { round: -1 } },
  );
  if (!request) throw conflict('This request is no longer open.', 'REQUEST_NOT_AVAILABLE');

  // If that was the last live alert, don't wait out the timer — search again now.
  const stillWaiting = await JobRequest.countDocuments({
    taskId,
    status: 'SENT',
    expiresAt: { $gt: now },
  });
  if (stillWaiting === 0) {
    await Task.updateOne(
      { _id: taskId, status: TASK_STATUS.SEARCHING },
      { $set: { nextDispatchAt: now } },
    );
  }

  await recordRejection(helperId);
  return request;
}

/**
 * UC-C23 — a helper who keeps turning work down is blocked automatically.
 *
 * Counted per explicit decline over the lifetime of the account, not per
 * expired alert: ignoring a request while you are busy is not the same as
 * refusing it, and the spec is explicit that the threshold is a business
 * decision rather than something to hard-code. Admin unblock resets the count.
 */
async function recordRejection(helperId) {
  const settings = await getSettings();
  const threshold = Number(settings.rejection_block_threshold) || 0;
  if (threshold <= 0) return;

  const user = await User.findOneAndUpdate(
    { _id: helperId, status: 'active' },
    { $inc: { rejectionCount: 1 } },
    { new: true },
  );
  if (!user || user.rejectionCount < threshold) return;

  const reason = `Automatically blocked after ${user.rejectionCount} declined requests. Contact support to restore your account.`;
  user.status = 'blocked';
  user.blockReason = reason;
  user.blockedAt = new Date();
  await user.save();

  // Blocked means blocked immediately — offline, and no alert left standing.
  await HelperProfile.updateOne({ userId: user._id }, { $set: { isOnline: false, dnd: false } });
  await JobRequest.updateMany(
    { helperId: user._id, status: 'SENT' },
    { $set: { status: 'CANCELLED' } },
  );

  await notify(user._id, 'ACCOUNT_BLOCKED', 'Account blocked', reason);

  const admins = await User.find({ role: ROLES.ADMIN, status: 'active' }).select('_id').lean();
  await notifyMany(
    admins.map((a) => a._id),
    'HELPER_AUTO_BLOCKED',
    'Helper auto-blocked',
    `${user.name || user.phone} was blocked after ${user.rejectionCount} declines.`,
    { helperId: String(user._id) },
  );

  console.log(`[block] ${user.name || user.phone} auto-blocked after ${user.rejectionCount} declines`);
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

  await flagOverdueTasks(now);
}

/** UC-C18 — a job still open long after it should have finished. */
async function flagOverdueTasks(now) {
  const settings = await getSettings();
  const cutoff = settings.overdue_reminder_minutes * 60_000;

  const overdue = await Task.find({
    status: { $in: [TASK_STATUS.IN_PROGRESS, TASK_STATUS.COMPLETION_PENDING] },
    overdueNotifiedAt: null,
    startedAt: { $lte: new Date(now.getTime() - cutoff) },
  })
    .limit(20)
    .lean();

  for (const task of overdue) {
    await Task.updateOne({ _id: task._id }, { $set: { overdueNotifiedAt: now } });
    await notify(task.customerId, 'TASK_OVERDUE', 'Booking still open', `${task.code} has not been closed yet.`, {
      taskId: String(task._id),
    });
    await notify(task.helperId, 'TASK_OVERDUE', 'Please close this job', `${task.code} is still marked in progress.`, {
      taskId: String(task._id),
    });
  }
}

