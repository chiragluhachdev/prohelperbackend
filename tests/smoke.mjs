/**
 * End-to-end walk of the MVP flow against a running server, including the
 * concurrency cases the spec calls mandatory (§64 Tests 1, 2, 5, 8).
 *
 *   node tests/smoke.mjs
 */
const BASE = process.env.API || 'http://localhost:4100';
let pass = 0, fail = 0;

const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label} ${extra}`); }
};

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

async function login(phone, role) {
  await api('/api/auth/otp/request', { method: 'POST', body: { phone } });
  const v = await api('/api/auth/otp/verify', { method: 'POST', body: { phone, code: '123456' } });
  const s = await api('/api/auth/session', { method: 'POST', body: { verificationToken: v.verificationToken, role } });
  return s.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * The seed ships only the catalog and the admin, so this suite registers the
 * people it needs. Phone numbers are unique per run, which keeps repeat runs
 * from colliding on an account that is mid-booking.
 */
const RUN = String(Date.now()).slice(-5);
const PHONE = {
  customer: `7${RUN}0001`.slice(0, 10),
  helperA: `7${RUN}0002`.slice(0, 10),
  helperB: `7${RUN}0003`.slice(0, 10),
  helperC: `7${RUN}0004`.slice(0, 10),
};

/** Registers a helper and walks them all the way to approved. */
async function makeApprovedHelper(phone, name, adminToken) {
  const token = await login(phone, 'helper');
  await api('/api/helper/profile', { method: 'PATCH', token, body: { name, gender: 'female', bio: 'Test helper.' } });
  await api('/api/helper/kyc/aadhaar/request', { method: 'POST', token, body: { aadhaar: '123456789012' } });
  await api('/api/helper/kyc/aadhaar/verify', { method: 'POST', token, body: { code: '123456', name } });
  await api('/api/helper/services', { method: 'PUT', token, body: { codes: ['full_home', 'kitchen', 'bathroom', 'sofa'] } });
  await api('/api/helper/service-area', { method: 'PUT', token, body: { societies: ['rps_savana', 'rps_auria', 'rps_palms'] } });
  await api('/api/helper/submit', { method: 'POST', token });
  const me = await api('/api/auth/me', { token });
  await api(`/api/admin/helpers/${me.user.id}/approve`, { method: 'POST', token: adminToken });
  return { token, id: me.user.id };
}

console.log('\nPro Helper — end-to-end smoke test\n');

// ---------------------------------------------------------------- health
const health = await api('/api/health');
ok('API is up and connected to Mongo', health.ok && health.db === 'connected', JSON.stringify(health));

// ---------------------------------------------------------------- auth
console.log('\n1. Authentication');
const adminBootstrap = await api('/api/auth/admin/login', { method: 'POST', body: { email: 'admin@prohelper.in', password: 'admin@123' } });
const adminToken = adminBootstrap.token;

const customerToken = await login(PHONE.customer, 'customer');
await api('/api/customer/profile', { method: 'PATCH', token: customerToken, body: { name: 'Test Customer' } });
await api('/api/customer/addresses', {
  method: 'POST', token: customerToken,
  body: { label: 'Home', line1: 'Tower C, Flat 1204', society: 'rps_savana' },
});
ok('customer signs in with a 6-digit OTP', Boolean(customerToken));

const badOtp = await api('/api/auth/otp/verify', { method: 'POST', body: { phone: PHONE.customer, code: '12' } });
ok('a short code is rejected', badOtp.status === 400, JSON.stringify(badOtp.error));

const me = await api('/api/auth/me', { token: customerToken });
ok('customer profile loads with an address', me.user?.role === 'customer' && me.addresses?.length > 0);

const a = await makeApprovedHelper(PHONE.helperA, 'Helper A', adminToken);
const b = await makeApprovedHelper(PHONE.helperB, 'Helper B', adminToken);
const helperA = a.token;
const helperAId = a.id;
const helperBId = b.id;
const helperB = b.token;
ok('both helpers sign in', Boolean(helperA && helperB));

// ---------------------------------------------------------------- catalog + quote
console.log('\n2. Services and pricing');
const catalog = await api('/api/services', { token: customerToken });
ok(`catalog returns ${catalog.services?.length} services`, catalog.services?.length === 4);

const q = await api('/api/customer/quote', {
  method: 'POST', token: customerToken,
  body: { services: [{ code: 'full_home', options: {} }] },
});
// Full Home Cleaning is 249; + 5% platform fee, + 20 surcharge, + 18% GST.
ok('bill is computed server-side', q.pricing?.servicesAmount === 249 && q.pricing.total > 249, JSON.stringify(q.pricing));
ok('helper payout excludes commission', q.pricing?.helperPayout === 249 - q.pricing.helperCommission);

// ---------------------------------------------------------------- go online
console.log('\n3. Helpers go online');
const onA = await api('/api/helper/online', { method: 'POST', token: helperA, body: { isOnline: true } });
const onB = await api('/api/helper/online', { method: 'POST', token: helperB, body: { isOnline: true } });
ok('both helpers are online', onA.isOnline === true && onB.isOnline === true);

// ---------------------------------------------------------------- booking (Test 5: duplicate)
console.log('\n4. Create booking (duplicate-press protection)');
const addressId = me.addresses[0]._id;

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Deliberately the worst slot there is: 4am on the coming Sunday. Availability
 * is the online switch and nothing else — there are no working days or hours —
 * so this has to reach an online helper exactly like a Tuesday morning would.
 * The minute is randomised so a re-run never lands on a slot a previous run
 * already booked: the matcher still skips helpers who are busy at that hour.
 */
function outOfHoursSlot() {
  const d = new Date();
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7)); // the next Sunday
  return { date: ymd(d), time: `04:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}` };
}

const { date, time } = outOfHoursSlot();
const idem = `smoke-${Date.now()}`;

const bookingBody = {
  services: [{ code: 'full_home', options: {} }],
  addressId, date, time, instructions: 'Second floor, ring the bell twice.', idempotencyKey: idem,
};

const [b1, b2] = await Promise.all([
  api('/api/customer/tasks', { method: 'POST', token: customerToken, body: bookingBody }),
  api('/api/customer/tasks', { method: 'POST', token: customerToken, body: bookingBody }),
]);
const taskId = b1.task?.id || b2.task?.id;
ok('booking created', Boolean(taskId));
ok('the double-press produced ONE booking', b1.task?.id === b2.task?.id, `${b1.task?.id} vs ${b2.task?.id}`);
await sleep(300);
const afterCreate = await api(`/api/customer/tasks/${taskId}`, { token: customerToken });
ok('booking moves to SEARCHING', afterCreate.task?.status === 'SEARCHING', String(afterCreate.task?.status));

// ---------------------------------------------------------------- matching
console.log('\n5. Automatic matching');
let reqA = { requests: [] }, reqB = { requests: [] };
for (let i = 0; i < 12 && !reqA.requests.length; i += 1) {
  await sleep(400);
  reqA = await api('/api/helper/requests', { token: helperA });
  reqB = await api('/api/helper/requests', { token: helperB });
}
ok('helper A was alerted (4am Sunday — hours no longer gate)', reqA.requests?.length > 0);
ok('helper B was alerted', reqB.requests?.length > 0);
const alert = reqA.requests[0];
ok('alert carries distance and a live countdown',
  alert?.distanceKm >= 0 && alert?.secondsLeft > 0 && alert?.secondsLeft <= 60,
  JSON.stringify({ d: alert?.distanceKm, s: alert?.secondsLeft }));
ok('helper sees their payout, not the customer bill', alert?.task?.earning > 0 && alert?.task?.total === undefined);

// ---------------------------------------------------------- Test 2: race
console.log('\n6. Two helpers accept simultaneously');
const [accA, accB] = await Promise.all([
  api(`/api/helper/requests/${taskId}/accept`, { method: 'POST', token: helperA }),
  api(`/api/helper/requests/${taskId}/accept`, { method: 'POST', token: helperB }),
]);
const winners = [accA, accB].filter((r) => r.status === 200);
const losers = [accA, accB].filter((r) => r.status !== 200);
ok('exactly ONE helper wins', winners.length === 1, `winners=${winners.length}`);
ok('the loser is told the job is gone', losers.length === 1 && losers[0].status === 409, JSON.stringify(losers[0]?.error));

const winnerToken = accA.status === 200 ? helperA : helperB;
// Which helper wins the race is random, so everything downstream that is
// about *the* helper who did the job has to follow the winner, not assume A.
const winnerId = accA.status === 200 ? helperAId : helperBId;
const loserToken = accA.status === 200 ? helperB : helperA;

const loserJobs = await api('/api/helper/jobs?tab=upcoming', { token: loserToken });
ok('the loser has no assignment', !loserJobs.tasks?.some((t) => t.id === taskId));

const custView = await api(`/api/customer/tasks/${taskId}`, { token: customerToken });
ok('customer sees the assigned helper', custView.task?.status === 'ACCEPTED' && Boolean(custView.task?.helper?.name),
  JSON.stringify(custView.task?.status));

// ---------------------------------------------------------------- lifecycle
console.log('\n7. Start → complete with the customer OTP');
const started = await api(`/api/helper/jobs/${taskId}/start`, { method: 'POST', token: winnerToken });
ok('helper starts the job', started.task?.status === 'IN_PROGRESS', JSON.stringify(started.error));

const earlyComplete = await api(`/api/helper/jobs/${taskId}/complete`, { method: 'POST', token: winnerToken, body: { otp: '000000' } });
ok('cannot complete before requesting the OTP', earlyComplete.status === 409);

const otpSent = await api(`/api/helper/jobs/${taskId}/completion-otp`, { method: 'POST', token: winnerToken });
ok('completion OTP issued to the customer', otpSent.sent === true);

const withOtp = await api(`/api/customer/tasks/${taskId}`, { token: customerToken });
const completionOtp = withOtp.task?.completionOtp;
ok('customer can read the code in their app', /^\d{6}$/.test(String(completionOtp)), String(completionOtp));

const wrongOtp = await api(`/api/helper/jobs/${taskId}/complete`, { method: 'POST', token: winnerToken, body: { otp: '000000' } });
ok('wrong OTP is refused', wrongOtp.status === 400, JSON.stringify(wrongOtp.error));

const done = await api(`/api/helper/jobs/${taskId}/complete`, { method: 'POST', token: winnerToken, body: { otp: completionOtp } });
ok('correct OTP completes the job', done.task?.status === 'COMPLETED', JSON.stringify(done.error));
ok('the helper is credited', done.earning > 0, String(done.earning));

// ---------------------------------------------------------------- money + rating
console.log('\n8. Earnings and rating');
const earnings = await api('/api/helper/earnings', { token: winnerToken });
ok('earnings come off the ledger', earnings.summary?.totalEarnings > 0, JSON.stringify(earnings.summary));
ok('commission is tracked as owed', earnings.summary?.commissionOutstanding > 0);

const rate1 = await api(`/api/customer/tasks/${taskId}/rate`, { method: 'POST', token: customerToken, body: { stars: 5, comment: 'Spotless work.' } });
const rate2 = await api(`/api/customer/tasks/${taskId}/rate`, { method: 'POST', token: customerToken, body: { stars: 1 } });
ok('customer can rate once', rate1.status === 201);
ok('a second rating is refused', rate2.status === 409);

// -------------------------------------------------- Test 4: no helper
console.log('\n9. Nobody available');
// The real window is five minutes. Shrink it for the test, restore it after.
const liveMatching = (await api('/api/admin/settings', { token: adminToken })).settings;
await api('/api/admin/settings', {
  method: 'PUT', token: adminToken,
  body: { search_duration_seconds: 8, renotify_interval_seconds: 4, accept_window_seconds: 3 },
});
// Working hours no longer create this condition — the demo helpers work around
// the clock and location filtering is off — so make it real: take everyone
// offline and confirm the search exhausts rather than hanging.
await api('/api/helper/online', { method: 'POST', token: helperA, body: { isOnline: false } });
await api('/api/helper/online', { method: 'POST', token: helperB, body: { isOnline: false } });

const quietSlot = outOfHoursSlot();
const quiet = await api('/api/customer/tasks', {
  method: 'POST', token: customerToken,
  body: {
    services: [{ code: 'bathroom', options: {} }],
    addressId, date: quietSlot.date, time: quietSlot.time,
    idempotencyKey: `smoke-quiet-${Date.now()}`,
  },
});
let quietStatus = quiet.task?.status;
for (let i = 0; i < 25 && quietStatus !== 'NO_HELPER_AVAILABLE'; i += 1) {
  await sleep(700);
  quietStatus = (await api(`/api/customer/tasks/${quiet.task.id}`, { token: customerToken })).task?.status;
}
ok('with nobody online the search ends as NO_HELPER_AVAILABLE',
  quietStatus === 'NO_HELPER_AVAILABLE', String(quietStatus));

const retried = await api(`/api/customer/tasks/${quiet.task.id}/retry`, { method: 'POST', token: customerToken });
ok('customer can retry the search', retried.task?.status === 'SEARCHING', JSON.stringify(retried.error));
// ----------------------------------------- the search window and reminders
console.log('\n9a. Reminders inside the search window');
await api('/api/admin/settings', {
  method: 'PUT', token: adminToken,
  body: { search_duration_seconds: 16, renotify_interval_seconds: 5, accept_window_seconds: 3 },
});
await api('/api/helper/online', { method: 'POST', token: helperB, body: { isOnline: true } });

const windowTask = (await api('/api/customer/tasks', {
  method: 'POST', token: customerToken,
  body: { services: [{ code: 'kitchen', options: {} }], addressId, bookingType: 'instant', idempotencyKey: `smoke-window-${Date.now()}` },
})).task;
ok('a booking records when its search will close',
  windowTask?.searchExpiresAt && new Date(windowTask.searchExpiresAt) > new Date(), JSON.stringify(windowTask?.searchExpiresAt));

const alertsFor = async (id) =>
  ((await api(`/api/admin/bookings/${id}`, { token: adminToken })).requests ?? []).filter((r) => r.helper?.id === helperBId);

let bAlerts = [];
for (let i = 0; i < 20 && bAlerts.length < 1; i += 1) { await sleep(300); bAlerts = await alertsFor(windowTask.id); }
ok('an available helper is alerted straight away', bAlerts.length === 1, String(bAlerts.length));

// Helper B neither accepts nor declines: after the interval they are reminded.
for (let i = 0; i < 30 && bAlerts.length < 2; i += 1) { await sleep(400); bAlerts = await alertsFor(windowTask.id); }
ok('an unanswered helper is reminded after the interval', bAlerts.length >= 2, String(bAlerts.length));

const bNotes = (await api('/api/notifications', { token: helperB })).notifications ?? [];
ok('a reminder rings again without a duplicate in their list',
  bNotes.filter((n) => n.type === 'JOB_REQUEST' && n.data?.taskId === windowTask.id).length === 1,
  String(bNotes.filter((n) => n.data?.taskId === windowTask.id).length));

// Declining ends the reminders for them.
const declineWindow = await api(`/api/helper/requests/${windowTask.id}/decline`, { method: 'POST', token: helperB });
ok('an unanswered alert can still be declined', declineWindow.ok === true, JSON.stringify(declineWindow.error));
const afterDecline = (await alertsFor(windowTask.id)).length;
await sleep(6500);
ok('a helper who declined is not reminded again', (await alertsFor(windowTask.id)).length === afterDecline,
  `${afterDecline} → ${(await alertsFor(windowTask.id)).length}`);

// Nobody took it: it closes when the window does, not before.
let windowStatus = '';
for (let i = 0; i < 30 && windowStatus !== 'NO_HELPER_AVAILABLE'; i += 1) {
  await sleep(500);
  windowStatus = (await api(`/api/customer/tasks/${windowTask.id}`, { token: customerToken })).task?.status;
}
ok('the search closes when the window ends', windowStatus === 'NO_HELPER_AVAILABLE', String(windowStatus));

// A reminder that stopped ringing is not a "no": the helper can still take the job.
const lateTask = (await api('/api/customer/tasks', {
  method: 'POST', token: customerToken,
  body: { services: [{ code: 'kitchen', options: {} }], addressId, bookingType: 'instant', idempotencyKey: `smoke-late-${Date.now()}` },
})).task;
let lateAlerts = [];
for (let i = 0; i < 20 && lateAlerts.length < 1; i += 1) { await sleep(300); lateAlerts = await alertsFor(lateTask.id); }
await sleep(3500); // the 3-second ring has lapsed; the next reminder is not due yet
const lateAccept = await api(`/api/helper/requests/${lateTask.id}/accept`, { method: 'POST', token: helperB });
ok('a helper can accept after the ringing stops, inside the window',
  lateAccept.task?.status === 'ACCEPTED', JSON.stringify(lateAccept.error ?? lateAccept.task?.status));
const customerNotes = (await api('/api/notifications', { token: customerToken })).notifications ?? [];
ok('the customer is told a helper was assigned',
  customerNotes.some((n) => n.type === 'BOOKING_ACCEPTED' && n.data?.taskId === lateTask.id && n.data?.helperName),
  JSON.stringify(customerNotes.find((n) => n.data?.taskId === lateTask.id)?.data));
await api(`/api/customer/tasks/${lateTask.id}/cancel`, { method: 'POST', token: customerToken, body: { reason: 'Smoke test cleanup' } });

await api('/api/helper/online', { method: 'POST', token: helperB, body: { isOnline: false } });
await api('/api/admin/settings', {
  method: 'PUT', token: adminToken,
  body: {
    search_duration_seconds: liveMatching.search_duration_seconds,
    renotify_interval_seconds: liveMatching.renotify_interval_seconds,
    accept_window_seconds: liveMatching.accept_window_seconds,
  },
});

// ------------------------------------------------- instant booking (now)
console.log('\n9b. Instant booking');
await api('/api/helper/online', { method: 'POST', token: helperB, body: { isOnline: true } });

/* A device token that FCM will refuse. Every push below therefore travels all
   the way to Google and back, which proves the payload itself is valid — FCM
   checks the payload before it ever looks at the token. */
const fakeToken = `smoke-fake-token-${RUN}`;
const tokenSaved = await api('/api/auth/fcm-token', { method: 'PUT', token: helperB, body: { token: fakeToken } });
ok('a helper device can register for push', tokenSaved.success === true, JSON.stringify(tokenSaved.error));

const inst = await api('/api/customer/tasks', {
  method: 'POST', token: customerToken,
  body: {
    services: [{ code: 'kitchen', options: {} }],
    addressId,
    bookingType: 'instant',
    // Deliberately wrong, and deliberately in the past: the server must time
    // an instant booking off its own clock, not the phone's.
    date: '2020-01-01', time: '00:00',
    idempotencyKey: `smoke-instant-${Date.now()}`,
  },
});
ok('an instant booking is accepted without a slot', inst.task?.id !== undefined, JSON.stringify(inst.error));
ok('it is marked instant', inst.task?.bookingType === 'instant', String(inst.task?.bookingType));
ok('the server times it, not the client',
  Math.abs(new Date(inst.task?.scheduledAt).getTime() - Date.now()) < 60_000,
  String(inst.task?.scheduledAt));

let instAlert = { requests: [] };
for (let i = 0; i < 12 && !instAlert.requests.length; i += 1) {
  await sleep(400);
  instAlert = await api('/api/helper/requests', { token: helperB });
}
ok('an instant booking reaches an online helper',
  instAlert.requests?.some((r) => r.task?.id === inst.task?.id), String(instAlert.requests?.length));
ok('the helper sees it as instant',
  instAlert.requests?.find((r) => r.task?.id === inst.task?.id)?.task?.bookingType === 'instant');

await api(`/api/customer/tasks/${inst.task.id}/cancel`, {
  method: 'POST', token: customerToken, body: { reason: 'Smoke test cleanup' },
});

// A cancelled search stops counting as a live offer on anyone's phone.
const cancelledRecord = await api(`/api/admin/bookings/${inst.task.id}`, { token: adminToken });
ok('cancelling withdraws every open job alert',
  (cancelledRecord.requests ?? []).length > 0 &&
  !(cancelledRecord.requests ?? []).some((r) => r.status === 'SENT'),
  JSON.stringify((cancelledRecord.requests ?? []).map((r) => r.status)));

await api('/api/auth/fcm-token', { method: 'PUT', token: helperB, body: { token: `retired-${RUN}` } });
await api('/api/helper/online', { method: 'POST', token: helperB, body: { isOnline: false } });

// -------------------------------------------------- cancellation (UC-C22)
console.log('\n10. Cancelling, including mid-job');

const reasonless = await api(`/api/customer/tasks/${quiet.task.id}/cancel`, {
  method: 'POST', token: customerToken, body: {},
});
ok('a cancellation without a reason is refused', reasonless.status === 400, JSON.stringify(reasonless.error));

const quietCancel = await api(`/api/customer/tasks/${quiet.task.id}/cancel`, {
  method: 'POST', token: customerToken, body: { reason: 'Nobody was available' },
});
ok('a search with no helper can be cancelled', quietCancel.task?.status === 'CANCELLED', JSON.stringify(quietCancel.error));

const lateCancel = await api(`/api/customer/tasks/${taskId}/cancel`, {
  method: 'POST', token: customerToken, body: { reason: 'Changed my mind' },
});
ok('a finished job can no longer be cancelled', lateCancel.status === 409, JSON.stringify(lateCancel.error));

// Now the real case: work under way, customer calls it off.
await api('/api/helper/online', { method: 'POST', token: helperA, body: { isOnline: true } });
const liveSlot = outOfHoursSlot();
const live = await api('/api/customer/tasks', {
  method: 'POST', token: customerToken,
  body: {
    services: [{ code: 'sofa', options: {} }],
    addressId, date: liveSlot.date, time: liveSlot.time,
    idempotencyKey: `smoke-live-${Date.now()}`,
  },
});
const liveId = live.task?.id;

let liveAlert = { requests: [] };
for (let i = 0; i < 12 && !liveAlert.requests.length; i += 1) {
  await sleep(400);
  liveAlert = await api('/api/helper/requests', { token: helperA });
}
await api(`/api/helper/requests/${liveId}/accept`, { method: 'POST', token: helperA });
const underWay = await api(`/api/helper/jobs/${liveId}/start`, { method: 'POST', token: helperA });
ok('the job is under way', underWay.task?.status === 'IN_PROGRESS', JSON.stringify(underWay.error));

const midCancel = await api(`/api/customer/tasks/${liveId}/cancel`, {
  method: 'POST', token: customerToken, body: { reason: 'Had to leave the house' },
});
ok('a job in progress can be cancelled with a reason',
  midCancel.task?.status === 'CANCELLED', JSON.stringify(midCancel.error));

const cancelled = await api(`/api/customer/tasks/${liveId}`, { token: customerToken });
ok('the cancellation records who, why and from what state',
  cancelled.task?.cancellation?.by === 'customer' &&
  cancelled.task?.cancellation?.reason === 'Had to leave the house' &&
  cancelled.task?.cancellation?.previousStatus === 'IN_PROGRESS',
  JSON.stringify(cancelled.task?.cancellation));

const helperNotes = await api('/api/notifications', { token: helperA });
ok('the helper is told to stop, with the reason',
  helperNotes.notifications?.some((n) => n.type === 'BOOKING_CANCELLED' && n.body?.includes('Had to leave the house')),
  JSON.stringify(helperNotes.notifications?.[0]));

await api('/api/helper/online', { method: 'POST', token: helperA, body: { isOnline: false } });

// ---------------------------------------------------------------- admin
console.log('\n11. Admin dashboard');
ok('admin signs in with email + password', Boolean(adminToken));

// Reject then approve the same helper, so the test is the same on every run.
const pendingToken = await login(PHONE.helperC, 'helper');
await api('/api/helper/profile', { method: 'PATCH', token: pendingToken, body: { name: 'Helper C', gender: 'female', bio: 'Pending.' } });
await api('/api/helper/kyc/aadhaar/request', { method: 'POST', token: pendingToken, body: { aadhaar: '123456789012' } });
await api('/api/helper/kyc/aadhaar/verify', { method: 'POST', token: pendingToken, body: { code: '123456', name: 'Helper C' } });
await api('/api/helper/services', { method: 'PUT', token: pendingToken, body: { codes: ['kitchen'] } });
await api('/api/helper/service-area', { method: 'PUT', token: pendingToken, body: { societies: ['rps_auria'] } });
await api('/api/helper/submit', { method: 'POST', token: pendingToken });

// Counted after the third helper submits, so the pending queue has something
// in it — the dashboard is only interesting when it has to reflect a change.
const dash = await api('/api/admin/dashboard', { token: adminToken });
ok(
  'the dashboard carries a 7-day trend',
  Array.isArray(dash.trend) && dash.trend.length === 7 &&
  dash.trend.every((d) => typeof d.bookings === 'number' && typeof d.revenue === 'number') &&
  dash.trend[6].bookings >= 1,
  JSON.stringify(dash.trend),
);
ok(
  'dashboard reports counts',
  dash.stats?.customers >= 1 && dash.stats?.helpers >= 3 && dash.stats?.pendingApprovals >= 1,
  JSON.stringify(dash.stats),
);

const found = await api(`/api/admin/helpers?q=${PHONE.helperC}`, { token: adminToken });
const sunita = found.helpers?.[0];
ok('admin can look a helper up', Boolean(sunita), JSON.stringify(found.helpers?.length));

const noReason = await api(`/api/admin/helpers/${sunita?.id}/reject`, { method: 'POST', token: adminToken, body: {} });
ok('rejection requires a reason', noReason.status === 400);

const rejected = await api(`/api/admin/helpers/${sunita?.id}/reject`, {
  method: 'POST', token: adminToken, body: { reason: 'Address proof is unreadable.' },
});
ok('admin rejects with a reason the helper can act on',
  rejected.profile?.approvalStatus === 'REJECTED' && rejected.profile?.rejectionReason?.length > 0,
  JSON.stringify(rejected.error));

// The rejected helper fixes things and re-submits — back into the queue.
const sunitaToken = pendingToken;
const offlineAttempt = await api('/api/helper/online', { method: 'POST', token: sunitaToken, body: { isOnline: true } });
ok('an unapproved helper cannot go online', offlineAttempt.status === 403, JSON.stringify(offlineAttempt.error));

const resubmit = await api('/api/helper/submit', { method: 'POST', token: sunitaToken });
ok('helper re-submits for verification', resubmit.profile?.approvalStatus === 'PENDING_VERIFICATION', JSON.stringify(resubmit.error));

/*
 * Submitting now drops the helper straight into their dashboard rather than a
 * waiting-room screen, so everything that screen loads has to work while they
 * are still PENDING_VERIFICATION — only taking work stays closed.
 */
const [pendHome, pendJobs, pendEarn] = await Promise.all([
  api('/api/helper/home', { token: sunitaToken }),
  api('/api/helper/jobs', { token: sunitaToken }),
  api('/api/helper/earnings', { token: sunitaToken }),
]);
ok(
  'a pending helper can still open their dashboard',
  pendHome.approvalStatus === 'PENDING_VERIFICATION' && Array.isArray(pendJobs.tasks) && Boolean(pendEarn.summary),
  JSON.stringify({ home: pendHome.error, jobs: pendJobs.error, earnings: pendEarn.error }),
);
ok('a pending helper is shown as offline', pendHome.isOnline === false && pendHome.dnd === false);

const dash2 = await api('/api/admin/dashboard', { token: adminToken });
ok('the re-submission shows in the pending queue', dash2.stats?.pendingApprovals >= 1, String(dash2.stats?.pendingApprovals));

const approved = await api(`/api/admin/helpers/${sunita?.id}/approve`, { method: 'POST', token: adminToken });
ok('admin approves the helper', approved.profile?.approvalStatus === 'APPROVED', JSON.stringify(approved.error));
ok('approval clears the rejection reason', approved.profile?.rejectionReason === '');

const nowOnline = await api('/api/helper/online', { method: 'POST', token: sunitaToken, body: { isOnline: true } });
ok('an approved helper can go online', nowOnline.isOnline === true);
await api('/api/helper/online', { method: 'POST', token: sunitaToken, body: { isOnline: false } });

const booking = await api(`/api/admin/bookings/${taskId}`, { token: adminToken });
const accepted = booking.requests?.filter((r) => r.status === 'ACCEPTED') || [];
ok('admin sees every helper who was alerted', booking.requests?.length >= 1 && booking.timeline?.length >= 4,
  `requests=${booking.requests?.length} timeline=${booking.timeline?.length}`);
ok('exactly one alert is recorded as ACCEPTED', accepted.length === 1, `accepted=${accepted.length}`);
ok('the other alerts were stood down',
  booking.requests.filter((r) => r.status === 'SENT').length === 0);

const blocked = await api(`/api/admin/users/${sunita?.id}/block`, { method: 'POST', token: adminToken, body: { reason: 'Smoke test' } });
ok('admin can block an account', blocked.status === 'blocked');
await api(`/api/admin/users/${sunita?.id}/unblock`, { method: 'POST', token: adminToken });

const audit = await api('/api/admin/audit', { token: adminToken });
/*
 * Settings are typed. A boolean arriving from a form as the string "false"
 * used to be stored as a string, and every `if (setting)` in the codebase
 * would have read it as true — the location filter would have stayed off.
 */
const boolOff = await api('/api/admin/settings', {
  method: 'PUT', token: adminToken, body: { match_ignore_location: 'false' },
});
ok('a boolean setting stays a boolean', boolOff.settings?.match_ignore_location === false,
  JSON.stringify(boolOff.settings?.match_ignore_location));

const numBad = await api('/api/admin/settings', {
  method: 'PUT', token: adminToken, body: { accept_window_seconds: 'soon' },
});
ok('a number setting refuses nonsense', numBad.status === 400, JSON.stringify(numBad.error));

await api('/api/admin/settings', { method: 'PUT', token: adminToken, body: { match_ignore_location: true } });
const restored = await api('/api/admin/settings', { token: adminToken });
ok('settings can be put back', restored.settings?.match_ignore_location === true);

// Editing an address has to carry the new society's city and coordinates.
const addr = me.addresses[0];
const moved = await api(`/api/customer/addresses/${addr._id}`, {
  method: 'PATCH', token: customerToken, body: { society: 'rps_palms', line1: 'A-1201' },
});
ok('an edited address moves society, city and coordinates',
  moved.address?.society === 'rps_palms' && moved.address?.line1 === 'A-1201' &&
  typeof moved.address?.lat === 'number' && String(moved.address?.line2 || '').includes('Palms'),
  JSON.stringify(moved.address ?? moved.error));
await api(`/api/customer/addresses/${addr._id}`, {
  method: 'PATCH', token: customerToken, body: { society: addr.society, line1: addr.line1 },
});

/*
 * The service copy a customer reads is the admin's, not the app's: change the
 * checklist here and the catalog the phone fetches has to change with it.
 */
const editedService = await api('/api/admin/services/sofa', {
  method: 'PATCH', token: adminToken,
  body: { inclusions: ['Vacuum every cushion', '  ', 'Treat stains by hand'], basePrice: 219 },
});
ok('an admin can rewrite what a service includes',
  editedService.service?.inclusions?.length === 2 &&
  editedService.service.inclusions[0] === 'Vacuum every cushion',
  JSON.stringify(editedService.service?.inclusions ?? editedService.error));

const appCatalog = await api('/api/services', { token: customerToken });
const sofa = appCatalog.services?.find((sv) => sv.code === 'sofa');
ok('the customer app sees the edit immediately',
  sofa?.inclusions?.length === 2 && sofa?.basePrice === 219,
  JSON.stringify({ inclusions: sofa?.inclusions, price: sofa?.basePrice }));

const editedQuote = await api('/api/customer/quote', {
  method: 'POST', token: customerToken, body: { services: [{ code: 'sofa', options: {} }] },
});
ok('and the new price is what the bill uses',
  editedQuote.pricing?.servicesAmount === 219, JSON.stringify(editedQuote.pricing));

/*
 * Per-service questions (UC-C05). They ship switched off: a question nobody
 * has reviewed should not interrogate customers, and a priced one left on by
 * accident would quietly change the bill.
 */
const freshCatalog = await api('/api/services', { token: customerToken });
const bathroom = freshCatalog.services?.find((sv) => sv.code === 'bathroom');
ok('questions are off until an admin turns them on',
  bathroom?.optionsEnabled === false && (bathroom?.options ?? []).length === 0,
  JSON.stringify({ on: bathroom?.optionsEnabled, count: bathroom?.options?.length }));

const emptyOn = await api('/api/admin/services/bathroom', {
  method: 'PATCH', token: adminToken, body: { optionsEnabled: true },
});
ok('they cannot be switched on with nothing to ask', emptyOn.status === 400, JSON.stringify(emptyOn.error));

const badChoices = await api('/api/admin/services/bathroom', {
  method: 'PATCH', token: adminToken,
  body: { options: [{ key: 'size', label: 'Size', type: 'select', choices: ['Only one'] }] },
});
ok('a choice question needs real choices', badChoices.status === 400, JSON.stringify(badChoices.error));

const dupes = await api('/api/admin/services/bathroom', {
  method: 'PATCH', token: adminToken,
  body: [
    { key: 'extra', label: 'One', type: 'number' },
    { key: 'extra', label: 'Two', type: 'number' },
  ].reduce((acc, o, idx) => ({ options: [...(acc.options || []), o] }), {}),
});
ok('two questions cannot share a key', dupes.status === 400, JSON.stringify(dupes.error));

const configured = await api('/api/admin/services/bathroom', {
  method: 'PATCH', token: adminToken,
  body: {
    optionsEnabled: true,
    options: [
      { key: 'Extra Bathrooms!', label: 'Extra bathrooms', type: 'number', unit: 'bathrooms', pricePerUnit: 80, defaultValue: 0 },
      { key: 'deep', label: 'Deep scrub', type: 'boolean', pricePerUnit: 50, defaultValue: false },
    ],
  },
});
ok('an admin can define questions, keys slugified',
  configured.service?.optionsEnabled === true &&
  configured.service.options?.[0]?.key === 'extra_bathrooms' &&
  configured.service.options[0].pricePerUnit === 80,
  JSON.stringify(configured.service?.options ?? configured.error));

const withOptions = await api('/api/services', { token: customerToken });
const bath2 = withOptions.services?.find((sv) => sv.code === 'bathroom');
ok('the app is now asked to show them',
  bath2?.optionsEnabled === true && bath2?.options?.length === 2,
  JSON.stringify(bath2?.options?.length));

const plain = await api('/api/customer/quote', {
  method: 'POST', token: customerToken, body: { services: [{ code: 'bathroom', options: {} }] },
});
ok('the defaults add nothing', plain.pricing?.servicesAmount === 149, JSON.stringify(plain.pricing));

const answered = await api('/api/customer/quote', {
  method: 'POST', token: customerToken,
  body: { services: [{ code: 'bathroom', options: { extra_bathrooms: 2, deep: true } }] },
});
ok('answering a priced question changes the bill',
  answered.pricing?.servicesAmount === 149 + 160 + 50, JSON.stringify(answered.pricing));

// Switched off, the same answers must not be charged for.
await api('/api/admin/services/bathroom', {
  method: 'PATCH', token: adminToken, body: { optionsEnabled: false },
});
const ignored = await api('/api/customer/quote', {
  method: 'POST', token: customerToken,
  body: { services: [{ code: 'bathroom', options: { extra_bathrooms: 2, deep: true } }] },
});
ok('a disabled question is never charged for',
  ignored.pricing?.servicesAmount === 149, JSON.stringify(ignored.pricing));

const hidden = await api('/api/services', { token: customerToken });
ok('and the app stops being sent them',
  (hidden.services?.find((sv) => sv.code === 'bathroom')?.options ?? []).length === 0);

/* ------------------------------------------------------------ money side */
console.log('\n12. Payout details and finance');

const badUpi = await api('/api/helper/profile', {
  method: 'PATCH', token: winnerToken, body: { paymentDetails: { method: 'UPI', upiId: 'not-a-upi' } },
});
ok('a malformed UPI ID is refused', badUpi.status === 400, JSON.stringify(badUpi.error));

const badIfsc = await api('/api/helper/profile', {
  method: 'PATCH', token: winnerToken,
  body: { paymentDetails: { method: 'BANK', accountNo: '123456789012', ifsc: 'NOPE1' } },
});
ok('a malformed IFSC is refused', badIfsc.status === 400, JSON.stringify(badIfsc.error));

const halfBank = await api('/api/helper/profile', {
  method: 'PATCH', token: winnerToken, body: { paymentDetails: { method: 'BANK', accountNo: '123456789012' } },
});
ok('half a bank account is refused', halfBank.status === 400, JSON.stringify(halfBank.error));

const goodUpi = await api('/api/helper/profile', {
  method: 'PATCH', token: winnerToken, body: { paymentDetails: { method: 'UPI', upiId: 'sunita.devi@okaxis' } },
});
ok('a valid UPI ID is stored',
  goodUpi.profile?.paymentDetails?.upiId === 'sunita.devi@okaxis' &&
  goodUpi.profile?.paymentDetails?.method === 'UPI',
  JSON.stringify(goodUpi.profile?.paymentDetails ?? goodUpi.error));

const goodBank = await api('/api/helper/profile', {
  method: 'PATCH', token: winnerToken,
  body: { paymentDetails: { method: 'BANK', accountNo: '123456789012', ifsc: 'hdfc0001234' } },
});
ok('an IFSC is stored upper-case', goodBank.profile?.paymentDetails?.ifsc === 'HDFC0001234',
  JSON.stringify(goodBank.profile?.paymentDetails));

// Payout details are optional: nothing above should have blocked anything.
const stillFine = await api('/api/helper/home', { token: winnerToken });
ok('payout details stay optional', stillFine.approvalStatus === 'APPROVED', JSON.stringify(stillFine.error));

const finance = await api('/api/admin/finance', { token: adminToken });
ok('finance totals come off completed bookings',
  finance.totals?.bookings >= 1 && finance.totals.gross > 0 &&
  finance.totals.platformEarned === Math.round((finance.totals.platformFee + finance.totals.commission) * 100) / 100,
  JSON.stringify(finance.totals));
ok('the per-booking bill is listed',
  Array.isArray(finance.bookings) && finance.bookings[0]?.pricing?.total > 0,
  JSON.stringify(finance.bookings?.[0]?.code));
ok('the daily series is there', Array.isArray(finance.byDay));

const owed = finance.commissionOwed?.find((h) => h.helperId === winnerId);
ok('commission owed is attributed to the helper who owes it',
  Boolean(owed) && owed.amount > 0, JSON.stringify(finance.commissionOwed));
ok('with the payout details the admin would pay it to',
  owed?.paymentDetails?.ifsc === 'HDFC0001234', JSON.stringify(owed?.paymentDetails));

const settled = await api(`/api/admin/finance/settle/${winnerId}`, {
  method: 'POST', token: adminToken, body: { reason: 'Collected in cash' },
});
ok('settling clears what is owed', settled.settled >= 1 && settled.amount > 0, JSON.stringify(settled.error));

const twice = await api(`/api/admin/finance/settle/${winnerId}`, {
  method: 'POST', token: adminToken, body: { reason: 'Again' },
});
ok('and cannot be done twice', twice.status === 409, JSON.stringify(twice.error));

const after = await api('/api/admin/finance', { token: adminToken });
ok('the outstanding list drops them',
  !after.commissionOwed?.some((h) => h.helperId === winnerId),
  JSON.stringify(after.commissionOwed?.map((h) => h.name)));

const helperView = await api(`/api/admin/helpers/${winnerId}`, { token: adminToken });
ok('and the admin sees the payout details on the helper',
  helperView.profile?.paymentDetails?.accountNo === '123456789012',
  JSON.stringify(helperView.profile?.paymentDetails));

/* --------------------------------------------------------------- Hindi */
console.log('\n13. Hindi');

// A fresh catalog ships Hindi copy for every service.
const hiCatalog = await api('/api/services');
const hiKitchen = hiCatalog.services?.find((sv) => sv.code === 'kitchen');
ok('the catalog carries Hindi names, durations and checklists',
  hiKitchen?.nameHi === 'किचन की सफ़ाई' && hiKitchen?.durationLabelHi && hiKitchen?.inclusionsHi?.length === 5,
  JSON.stringify({ nameHi: hiKitchen?.nameHi, dur: hiKitchen?.durationLabelHi, n: hiKitchen?.inclusionsHi?.length }));

const hiEdit = await api('/api/admin/services/bathroom', {
  method: 'PATCH', token: adminToken,
  body: { nameHi: 'बाथरूम की गहरी सफ़ाई', inclusionsHi: ['कमोड की सफ़ाई', '', 'टाइल्स'] },
});
ok('an admin can edit the Hindi copy', hiEdit.service?.nameHi === 'बाथरूम की गहरी सफ़ाई' && hiEdit.service?.inclusionsHi?.length === 2,
  JSON.stringify(hiEdit.error ?? hiEdit.service?.inclusionsHi));

// A booking keeps the Hindi name it was made with.
const hiBooking = await api(`/api/customer/tasks/${taskId}`, { token: customerToken });
ok('a booking snapshot carries the Hindi service name',
  typeof hiBooking.task?.services?.[0]?.nameHi === 'string' && hiBooking.task.services[0].nameHi.length > 0,
  JSON.stringify(hiBooking.task?.services?.[0]));

// Notifications are stored with the values the app rebuilds sentences from.
const custNotes = await api('/api/notifications', { token: customerToken });
const acceptedNote = custNotes.notifications?.find((n) => n.type === 'BOOKING_ACCEPTED');
ok('a notification stores the values its sentence needs',
  Boolean(acceptedNote?.data?.code && acceptedNote?.data?.helperName), JSON.stringify(acceptedNote?.data));

const winnerNotes = await api('/api/notifications', { token: winnerToken });
const jobReq = winnerNotes.notifications?.find((n) => n.type === 'JOB_REQUEST');
ok('a job request stores the service name in Hindi too',
  Boolean(jobReq?.data?.serviceNameHi), JSON.stringify(jobReq?.data));

const hiEarnings = await api('/api/helper/earnings', { token: winnerToken });
const earnRow = hiEarnings.entries?.find((e) => e.type === 'JOB_EARNING');
ok('earnings rows carry service objects with the Hindi name',
  earnRow?.task?.services?.[0]?.code && 'nameHi' in earnRow.task.services[0],
  JSON.stringify(earnRow?.task));

// An error the app shows in Hindi is keyed by a stable code.
const noLine = await api('/api/customer/addresses', { method: 'POST', token: customerToken, body: { society: 'rps_savana' } });
ok('errors carry a code the app can translate', noLine.status === 400 && noLine.error?.code === 'LINE1_REQUIRED',
  JSON.stringify(noLine.error));

/* ------------------------------------------------------- change number */
console.log('\n14. Changing a phone number');

const newCustomerPhone = `8${RUN}1001`.slice(0, 10);

const sameNumber = await api('/api/auth/phone/request', {
  method: 'POST', token: customerToken, body: { phone: me.user.phone },
});
ok('asking for your current number is refused', sameNumber.status === 400 && sameNumber.error?.code === 'SAME_PHONE',
  JSON.stringify(sameNumber.error));

const badNumber = await api('/api/auth/phone/request', {
  method: 'POST', token: customerToken, body: { phone: '12345' },
});
ok('a malformed number is refused', badNumber.status === 400 && badNumber.error?.code === 'INVALID_PHONE',
  JSON.stringify(badNumber.error));

// Another helper's number, for a helper: taken. For a customer: allowed.
const helperTaken = await api('/api/auth/phone/request', {
  method: 'POST', token: helperA, body: { phone: PHONE.helperB },
});
ok('a helper cannot take another helper\'s number', helperTaken.status === 409 && helperTaken.error?.code === 'PHONE_TAKEN',
  JSON.stringify(helperTaken.error));

const crossRole = await api('/api/auth/phone/request', {
  method: 'POST', token: customerToken, body: { phone: PHONE.helperB },
});
ok('a customer may use a number that belongs to a helper account', crossRole.sent === true, JSON.stringify(crossRole.error));

const sent = await api('/api/auth/phone/request', {
  method: 'POST', token: customerToken, body: { phone: newCustomerPhone },
});
ok('a code is sent to the new number', sent.sent === true && sent.length === 6, JSON.stringify(sent.error ?? sent));

// A code issued for the customer's change cannot complete the helper's.
const stolen = await api('/api/auth/phone/verify', {
  method: 'POST', token: helperA, body: { phone: newCustomerPhone, code: sent.devCode || '123456' },
});
ok('the code only works for the account that asked', stolen.status >= 400, JSON.stringify(stolen.status));

const changed = await api('/api/auth/phone/verify', {
  method: 'POST', token: customerToken, body: { phone: newCustomerPhone, code: sent.devCode || '123456' },
});
ok('the verified number replaces the old one', changed.user?.phone === newCustomerPhone, JSON.stringify(changed.error ?? changed.user));

const meAfter = await api('/api/auth/me', { token: customerToken });
ok('the same session keeps working after the change', meAfter.user?.phone === newCustomerPhone, JSON.stringify(meAfter.error));

// And the new number is the one that signs in from now on.
const signIn = await api('/api/auth/otp/request', { method: 'POST', body: { phone: newCustomerPhone } });
const signInVerify = await api('/api/auth/otp/verify', { method: 'POST', body: { phone: newCustomerPhone, code: '123456' } });
ok('the new number signs in to the same account',
  signInVerify.accounts?.some((a) => a.role === 'customer'), JSON.stringify(signInVerify.accounts ?? signInVerify.error));

const phoneNote = (await api('/api/notifications', { token: customerToken })).notifications?.find((n) => n.type === 'PHONE_CHANGED');
ok('the customer is told their number changed', Boolean(phoneNote?.data?.phone), JSON.stringify(phoneNote?.data));

const adminCustomer = await api(`/api/admin/customers/${meAfter.user.id}`, { token: adminToken });
ok('the admin sees the new number and the one it replaced',
  adminCustomer.customer?.phone === newCustomerPhone &&
  adminCustomer.customer?.previousPhones?.some((p) => p.phone === PHONE.customer),
  JSON.stringify({ phone: adminCustomer.customer?.phone, previous: adminCustomer.customer?.previousPhones }));

/* --------------------------------------------- customer-facing helper stats */
console.log('\n15. Helper experience and job count');

// The completed booking from section 7 belongs to the race winner.
const shownBefore = await api(`/api/customer/tasks/${taskId}`, { token: customerToken });
ok('a helper shows 50+ jobs by default',
  shownBefore.task?.helper?.jobsLabel === '50+', JSON.stringify(shownBefore.task?.helper));

const badYears = await api(`/api/admin/helpers/${winnerId}/profile`, {
  method: 'PATCH', token: adminToken, body: { experienceYears: 99 },
});
ok('an impossible experience is refused', badYears.status === 400, JSON.stringify(badYears.error));

const badJobs = await api(`/api/admin/helpers/${winnerId}/profile`, {
  method: 'PATCH', token: adminToken, body: { jobsShown: -5 },
});
ok('a negative job count is refused', badJobs.status === 400, JSON.stringify(badJobs.error));

const edited = await api(`/api/admin/helpers/${winnerId}/profile`, {
  method: 'PATCH', token: adminToken, body: { experienceYears: 4, jobsShown: 120 },
});
ok('an admin can set experience and jobs shown',
  edited.profile?.experienceYears === 4 && edited.profile?.jobsShown === 120 && edited.profile?.jobsLabel === '120+',
  JSON.stringify(edited.error ?? edited.profile));

const shownAfter = await api(`/api/customer/tasks/${taskId}`, { token: customerToken });
ok('the customer sees the new figures',
  shownAfter.task?.helper?.jobsLabel === '120+' && shownAfter.task?.helper?.experienceYears === 4,
  JSON.stringify(shownAfter.task?.helper));

// Zero means "show only what really happened".
await api(`/api/admin/helpers/${winnerId}/profile`, { method: 'PATCH', token: adminToken, body: { jobsShown: 0 } });
const honest = await api(`/api/customer/tasks/${taskId}`, { token: customerToken });
const realCount = (await api(`/api/admin/helpers/${winnerId}`, { token: adminToken })).profile?.completedJobs;
ok('set to 0, the real completed count shows through',
  honest.task?.helper?.jobsLabel === String(realCount), JSON.stringify({ label: honest.task?.helper?.jobsLabel, realCount }));
ok('and the real counter was never touched by the edits', realCount >= 1, String(realCount));

ok('admin actions are audited', audit.logs?.length >= 3, String(audit.logs?.length));

// ---------------------------------------------------------------- teardown
await api('/api/helper/online', { method: 'POST', token: helperA, body: { isOnline: false } });
await api('/api/helper/online', { method: 'POST', token: helperB, body: { isOnline: false } });

console.log(`\n${'─'.repeat(50)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(50)}\n`);
process.exit(fail ? 1 : 0);
