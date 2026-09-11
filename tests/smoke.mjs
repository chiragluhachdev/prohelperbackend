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
 * A random Mon-Sat slot inside both demo helpers' working hours (07:00-20:00).
 * Randomised so a re-run never lands on a slot a previous run already booked —
 * the matcher deliberately skips helpers who are busy at that hour.
 */
function nextWorkingSlot() {
  const d = new Date();
  d.setDate(d.getDate() + 1 + Math.floor(Math.random() * 5));
  while (d.getDay() === 0) d.setDate(d.getDate() + 1);
  const hour = 9 + Math.floor(Math.random() * 8);
  const minute = Math.floor(Math.random() * 60);
  return { date: ymd(d), time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

const { date, time } = nextWorkingSlot();
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
ok('helper A was alerted', reqA.requests?.length > 0);
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
// Working hours no longer create this condition — the demo helpers work around
// the clock and location filtering is off — so make it real: take everyone
// offline and confirm the search exhausts rather than hanging.
await api('/api/helper/online', { method: 'POST', token: helperA, body: { isOnline: false } });
await api('/api/helper/online', { method: 'POST', token: helperB, body: { isOnline: false } });

const quietSlot = nextWorkingSlot();
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
await api(`/api/customer/tasks/${quiet.task.id}/cancel`, { method: 'POST', token: customerToken, body: { reason: 'Smoke test cleanup' } });

// ---------------------------------------------------------------- admin
console.log('\n10. Admin dashboard');
ok('admin signs in with email + password', Boolean(adminToken));

const dash = await api('/api/admin/dashboard', { token: adminToken });
ok('dashboard reports counts', dash.stats?.customers >= 1 && dash.stats?.helpers >= 3, JSON.stringify(dash.stats));

// Reject then approve the same helper, so the test is the same on every run.
const pendingToken = await login(PHONE.helperC, 'helper');
await api('/api/helper/profile', { method: 'PATCH', token: pendingToken, body: { name: 'Helper C', gender: 'female', bio: 'Pending.' } });
await api('/api/helper/kyc/aadhaar/request', { method: 'POST', token: pendingToken, body: { aadhaar: '123456789012' } });
await api('/api/helper/kyc/aadhaar/verify', { method: 'POST', token: pendingToken, body: { code: '123456', name: 'Helper C' } });
await api('/api/helper/services', { method: 'PUT', token: pendingToken, body: { codes: ['kitchen'] } });
await api('/api/helper/service-area', { method: 'PUT', token: pendingToken, body: { societies: ['rps_auria'] } });
await api('/api/helper/submit', { method: 'POST', token: pendingToken });

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
ok('admin actions are audited', audit.logs?.length >= 3, String(audit.logs?.length));

// ---------------------------------------------------------------- teardown
await api('/api/helper/online', { method: 'POST', token: helperA, body: { isOnline: false } });
await api('/api/helper/online', { method: 'POST', token: helperB, body: { isOnline: false } });

console.log(`\n${'─'.repeat(50)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(50)}\n`);
process.exit(fail ? 1 : 0);
