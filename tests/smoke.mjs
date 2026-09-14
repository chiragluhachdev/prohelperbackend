/**
 * End-to-end walk of the MVP flow against a running server, including the
 * concurrency cases the spec calls mandatory (§64 Tests 1, 2, 5, 8).
 *
 *   node tests/smoke.mjs
 */
import { planSearch, waveDueAt } from '../src/lib/searchPlan.js';

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

/** Starting a job needs the code from the customer's app, read out at the door. */
async function startJob(taskId, helperToken, customerTok) {
  const code = (await api(`/api/customer/tasks/${taskId}`, { token: customerTok })).task?.startOtp;
  return api(`/api/helper/jobs/${taskId}/start`, { method: 'POST', token: helperToken, body: { otp: code } });
}

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
console.log('\n7. Start with the customer code → complete with the customer OTP');
const assigned = await api(`/api/customer/tasks/${taskId}`, { token: customerToken });
const startCode = assigned.task?.startOtp;
ok('the customer gets a 4-digit start code as soon as a helper is assigned', /^\d{4}$/.test(String(startCode)), String(startCode));
const helperSees = await api(`/api/helper/jobs/${taskId}`, { token: winnerToken });
ok('the helper never sees the code, only that one is needed',
  helperSees.task?.startOtp === undefined && helperSees.startOtpRequired === true, JSON.stringify({ code: helperSees.task?.startOtp, req: helperSees.startOtpRequired }));
const assignedNote = (await api('/api/notifications', { token: customerToken })).notifications?.find((n) => n.type === 'BOOKING_ACCEPTED' && n.data?.taskId === taskId);
ok('and the customer is told the code in the "helper assigned" notification', assignedNote?.data?.startCode === startCode,
  JSON.stringify(assignedNote?.data));

const noCode = await api(`/api/helper/jobs/${taskId}/start`, { method: 'POST', token: winnerToken });
ok('a job cannot be started without the code', noCode.error?.code === 'START_OTP_REQUIRED', JSON.stringify(noCode.error));
const wrongStart = await api(`/api/helper/jobs/${taskId}/start`, {
  method: 'POST', token: winnerToken, body: { otp: startCode === '0000' ? '1111' : '0000' },
});
ok('or with the wrong one', wrongStart.error?.code === 'START_OTP_INVALID', JSON.stringify(wrongStart.error));

const refreshedCode = await api(`/api/customer/tasks/${taskId}/start-code`, { method: 'POST', token: customerToken });
const oldCodeNow = await api(`/api/helper/jobs/${taskId}/start`, { method: 'POST', token: winnerToken, body: { otp: startCode } });
ok('a new code from the customer replaces the old one',
  /^\d{4}$/.test(String(refreshedCode.startOtp)) &&
  (refreshedCode.startOtp === startCode || oldCodeNow.error?.code === 'START_OTP_INVALID'),
  JSON.stringify({ fresh: refreshedCode.startOtp, old: oldCodeNow.error }));

const started = await startJob(taskId, winnerToken, customerToken);
ok('helper starts the job with the right code', started.task?.status === 'IN_PROGRESS', JSON.stringify(started.error));
ok('and the code disappears from the customer app once work begins',
  (await api(`/api/customer/tasks/${taskId}`, { token: customerToken })).task?.startOtp === null);

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
ok('the job is done, but nobody has been paid yet', done.task?.paymentStatus === 'PENDING', String(done.task?.paymentStatus));
ok('the helper is credited', done.earning > 0, String(done.earning));

// The customer paid the helper cash in hand — the helper is the only one who
// can say so, and confirming it settles the booking.
const cashConfirm = await api(`/api/helper/jobs/${taskId}/confirm-payment`, { method: 'POST', token: winnerToken });
ok('helper confirms the cash/UPI payment', cashConfirm.task?.status === 'SETTLED' && cashConfirm.task?.paymentStatus === 'PAID',
  JSON.stringify(cashConfirm.error));
ok('paid in cash, the helper owes everything beyond their own payout',
  Math.abs(cashConfirm.owed - (cashConfirm.total - cashConfirm.earning)) < 0.01, JSON.stringify(cashConfirm));

const cashTwice = await api(`/api/helper/jobs/${taskId}/confirm-payment`, { method: 'POST', token: winnerToken });
ok('cannot confirm a payment twice', cashTwice.status === 409, JSON.stringify(cashTwice.error));

// ---------------------------------------------------------------- money + rating
console.log('\n8. Earnings and rating');
const earnings = await api('/api/helper/earnings', { token: winnerToken });
ok('earnings come off the ledger', earnings.summary?.totalEarnings > 0, JSON.stringify(earnings.summary));
ok('commission is tracked as owed', earnings.summary?.commissionOutstanding > 0);

const rate1 = await api(`/api/customer/tasks/${taskId}/rate`, { method: 'POST', token: customerToken, body: { stars: 5, comment: 'Spotless work.' } });
const rate2 = await api(`/api/customer/tasks/${taskId}/rate`, { method: 'POST', token: customerToken, body: { stars: 1 } });
ok('customer can rate once', rate1.status === 201);
ok('a second rating is refused', rate2.status === 409);

// ----------------------------------------------------------- online payment
console.log('\n8a. Paying online, instead of cash');

const financeBeforeOnline = await api('/api/admin/finance', { token: adminToken });
const owedBeforeOnline = financeBeforeOnline.commissionOwed?.find((h) => h.helperId === winnerId)?.amount || 0;

const onlineSlot = outOfHoursSlot();
const onlineBooking = await api('/api/customer/tasks', {
  method: 'POST', token: customerToken,
  body: {
    services: [{ code: 'kitchen', options: {} }], addressId, date: onlineSlot.date, time: onlineSlot.time,
    idempotencyKey: `smoke-online-${Date.now()}`,
  },
});
const onlineTaskId = onlineBooking.task?.id;
ok('a second booking is created for the online-payment case', Boolean(onlineTaskId));

let onlineAccepted = null;
for (let i = 0; i < 15 && !onlineAccepted; i += 1) {
  await sleep(400);
  const attempt = await api(`/api/helper/requests/${onlineTaskId}/accept`, { method: 'POST', token: winnerToken });
  if (attempt.status === 200) onlineAccepted = attempt;
}
ok('the same helper accepts the second job', onlineAccepted?.task?.status === 'ACCEPTED', JSON.stringify(onlineAccepted));

await startJob(onlineTaskId, winnerToken, customerToken);
await api(`/api/helper/jobs/${onlineTaskId}/completion-otp`, { method: 'POST', token: winnerToken });
const onlineWithOtp = await api(`/api/customer/tasks/${onlineTaskId}`, { token: customerToken });
const onlineDone = await api(`/api/helper/jobs/${onlineTaskId}/complete`, {
  method: 'POST', token: winnerToken, body: { otp: onlineWithOtp.task?.completionOtp },
});
ok('the second job completes too', onlineDone.task?.status === 'COMPLETED', JSON.stringify(onlineDone.error));

const paidOnline = await api(`/api/customer/tasks/${onlineTaskId}/pay`, { method: 'POST', token: customerToken });
ok('the customer pays online in the app', paidOnline.task?.status === 'SETTLED' && paidOnline.task?.paymentMode === 'ONLINE',
  JSON.stringify(paidOnline.error));
ok('a receipt comes back', paidOnline.receipt?.amount > 0 && paidOnline.receipt?.method === 'ONLINE', JSON.stringify(paidOnline.receipt));

const payOnlineTwice = await api(`/api/customer/tasks/${onlineTaskId}/pay`, { method: 'POST', token: customerToken });
ok('cannot pay for the same job twice', payOnlineTwice.status === 409, JSON.stringify(payOnlineTwice.error));

const helperCantCashAnOnlineJob = await api(`/api/helper/jobs/${onlineTaskId}/confirm-payment`, { method: 'POST', token: winnerToken });
ok('and the helper cannot also mark an already-paid job as cash',
  helperCantCashAnOnlineJob.status === 409, JSON.stringify(helperCantCashAnOnlineJob.error));

const financeAfterOnline = await api('/api/admin/finance', { token: adminToken });
const owedAfterOnline = financeAfterOnline.commissionOwed?.find((h) => h.helperId === winnerId)?.amount || 0;
ok('paid online, nothing new is added to what the helper owes',
  owedAfterOnline === owedBeforeOnline, JSON.stringify({ owedBeforeOnline, owedAfterOnline }));
const payoutDue = financeAfterOnline.payoutsOwed?.find((h) => h.helperId === winnerId);
ok('instead, the platform now owes them a payout', Boolean(payoutDue) && payoutDue.amount > 0, JSON.stringify(financeAfterOnline.payoutsOwed));

// ------------------------------------------------------------ wallet history
const wallet = await api('/api/helper/wallet', { token: winnerToken });
const sumLines = (g) => Math.round(g.lines.reduce((t, l) => t + l.amount, 0) * 100) / 100;
const cashGroup = wallet.groups?.find((g) => g.taskId === taskId);
const onlineGroup = wallet.groups?.find((g) => g.taskId === onlineTaskId);
ok('the wallet lists both paid bookings, newest first',
  wallet.groups?.[0]?.taskId === onlineTaskId && Boolean(cashGroup), JSON.stringify(wallet.groups?.map((g) => g.code)));
ok('a cash booking reads: bill received, commission out, service fee out',
  cashGroup?.method === 'CASH' &&
  cashGroup.lines.map((l) => l.kind).join() === 'PAID_CASH,COMMISSION,PLATFORM_FEE' &&
  cashGroup.lines[0].amount > 0 && cashGroup.lines.slice(1).every((l) => l.amount < 0),
  JSON.stringify(cashGroup?.lines));
ok('an online booking reads: job value in, commission out',
  onlineGroup?.method === 'ONLINE' && onlineGroup.lines.map((l) => l.kind).join() === 'PAID_ONLINE,COMMISSION',
  JSON.stringify(onlineGroup?.lines));
ok('each booking nets to exactly the helper payout',
  sumLines(cashGroup) === cashConfirm.earning && sumLines(onlineGroup) === onlineDone.earning,
  JSON.stringify({ cash: sumLines(cashGroup), cashPayout: cashConfirm.earning, online: sumLines(onlineGroup), onlinePayout: onlineDone.earning }));
ok('the one net-earning figure is every line added up',
  wallet.netEarning === Math.round(wallet.groups.reduce((t, g) => t + sumLines(g), 0) * 100) / 100 && !wallet.truncated,
  JSON.stringify({ net: wallet.netEarning }));
ok('the balance shows what they owe the platform against the payout due to them',
  wallet.owedToPlatform === cashConfirm.owed && wallet.payoutDue === onlineDone.earning &&
  wallet.balance === Math.round((wallet.payoutDue - wallet.owedToPlatform) * 100) / 100,
  JSON.stringify({ owed: wallet.owedToPlatform, due: wallet.payoutDue, balance: wallet.balance }));
const earningsNow = await api('/api/helper/earnings', { token: winnerToken });
ok('and the earnings screen shows the same amount owed',
  earningsNow.summary?.owedToPlatform === wallet.owedToPlatform && earningsNow.summary?.payoutDue === wallet.payoutDue,
  JSON.stringify(earningsNow.summary));

const payoutSettled = await api(`/api/admin/finance/settle-payout/${winnerId}`, {
  method: 'POST', token: adminToken, body: { reason: 'Bank transfer sent' },
});
ok('the admin sends the payout and marks it settled', payoutSettled.settled >= 1 && payoutSettled.amount > 0, JSON.stringify(payoutSettled.error));

const payoutTwice = await api(`/api/admin/finance/settle-payout/${winnerId}`, {
  method: 'POST', token: adminToken, body: { reason: 'Again' },
});
ok('and a payout cannot be settled twice', payoutTwice.status === 409, JSON.stringify(payoutTwice.error));
const walletAfterPayout = await api('/api/helper/wallet', { token: winnerToken });
ok('once paid out, nothing is due — but what they owe from cash still stands',
  walletAfterPayout.payoutDue === 0 && walletAfterPayout.owedToPlatform === cashConfirm.owed,
  JSON.stringify({ due: walletAfterPayout.payoutDue, owed: walletAfterPayout.owedToPlatform }));

// ---------------------------------------------------------------- referrals
console.log('\n8b. Referrals');
const r2 = (n) => Math.round(n * 100) / 100;

const custRef = await api('/api/referrals', { token: customerToken });
ok('every account has a 6-character referral code', /^[A-Z2-9]{6}$/.test(String(custRef.code)), String(custRef.code));
ok('and it never changes', (await api('/api/referrals', { token: customerToken })).code === custRef.code);

const helperRef = await api('/api/referrals', { token: winnerToken });
const duesBefore = helperRef.owedToPlatform;
ok('a helper sees the dues their referral balance could pay off', duesBefore === cashConfirm.owed,
  JSON.stringify({ dues: duesBefore, owed: cashConfirm.owed }));

// A small reward for this run, so it pays off only part of the helper's dues.
await api('/api/admin/settings', { method: 'PUT', token: adminToken, body: { referral_reward_amount: 20 } });

const friendPhone = `7${RUN}0011`.slice(0, 10);
const friendToken = await login(friendPhone, 'customer');
ok('a malformed code is refused',
  (await api('/api/referrals/check?code=AB1', { token: friendToken })).error?.code === 'REFERRAL_CODE_INVALID');
ok('nobody can use their own code',
  (await api(`/api/referrals/check?code=${custRef.code}`, { token: customerToken })).error?.code === 'REFERRAL_OWN_CODE');
const checked = await api(`/api/referrals/check?code=${helperRef.code.toLowerCase()}`, { token: friendToken });
ok('a real code checks out, whatever the case it is typed in', checked.valid === true && checked.welcome === 100,
  JSON.stringify(checked));

const applied = await api('/api/referrals/apply', { method: 'POST', token: friendToken, body: { code: helperRef.code } });
ok('joining with a code pays the newcomer ₹100', applied.status === 201 && applied.balance === 100, JSON.stringify(applied));
const appliedTwice = await api('/api/referrals/apply', { method: 'POST', token: friendToken, body: { code: custRef.code } });
ok('a code can only ever be used once per account', appliedTwice.error?.code === 'REFERRAL_ALREADY_APPLIED',
  JSON.stringify(appliedTwice.error));

const helperRewarded = await api('/api/referrals', { token: winnerToken });
ok('and rewards the person whose code it was',
  helperRewarded.balance === r2(helperRef.balance + 20) &&
  helperRewarded.totals.referrals === helperRef.totals.referrals + 1 &&
  helperRewarded.history[0]?.type === 'REFERRER_REWARD' && helperRewarded.history[0]?.amount === 20,
  JSON.stringify({ balance: helperRewarded.balance, totals: helperRewarded.totals, top: helperRewarded.history[0] }));

// Helper: pay dues from the referral balance — here only part of them.
const settledRef = await api('/api/referrals/settle', { method: 'POST', token: winnerToken });
ok('a helper pays what they can of their dues from referral balance',
  settledRef.settled === 20 && settledRef.referralBalance === r2(helperRewarded.balance - 20) &&
  settledRef.owedToPlatform === r2(duesBefore - 20),
  JSON.stringify(settledRef));
ok('with nothing left to spend, settling again is refused',
  (await api('/api/referrals/settle', { method: 'POST', token: winnerToken })).error?.code === 'NO_REFERRAL_BALANCE');
ok('customers cannot settle dues', (await api('/api/referrals/settle', { method: 'POST', token: friendToken })).status === 403);
const walletAfterSettle = await api('/api/helper/wallet', { token: winnerToken });
ok('the wallet shows the smaller amount still owed', walletAfterSettle.owedToPlatform === r2(duesBefore - 20),
  JSON.stringify({ owed: walletAfterSettle.owedToPlatform }));
const financeAfterSettle = await api('/api/admin/finance', { token: adminToken });
ok('and so does admin finance',
  financeAfterSettle.commissionOwed?.find((h) => h.helperId === winnerId)?.amount === r2(duesBefore - 20),
  JSON.stringify(financeAfterSettle.commissionOwed?.find((h) => h.helperId === winnerId)));

// Customer: spend referral balance on a booking.
await api('/api/customer/profile', { method: 'PATCH', token: friendToken, body: { name: 'Rahul Friend' } });
const friendAddr = await api('/api/customer/addresses', {
  method: 'POST', token: friendToken, body: { label: 'Home', line1: 'Tower A, Flat 101', society: 'rps_savana' },
});
const friendAddressId = friendAddr.address?._id || friendAddr.addresses?.[0]?._id;

const quoteOff = await api('/api/customer/quote', { method: 'POST', token: friendToken, body: { services: [{ code: 'full_home' }] } });
ok('the bill offers the referral balance without taking it',
  quoteOff.referral?.balance === 100 && quoteOff.referral?.usable === 100 && !quoteOff.pricing?.referralCredit,
  JSON.stringify(quoteOff.referral));
const quoteOn = await api('/api/customer/quote', {
  method: 'POST', token: friendToken, body: { services: [{ code: 'full_home' }], useReferral: true },
});
ok('switched on, it comes off what they pay',
  quoteOn.pricing?.referralCredit === 100 && quoteOn.pricing?.amountDue === r2(quoteOn.pricing.total - 100),
  JSON.stringify(quoteOn.pricing));
ok('but never more than half the booking',
  quoteOn.referral?.maxPercent === 50 && quoteOn.pricing.referralCredit <= r2(quoteOn.pricing.total / 2),
  JSON.stringify({ credit: quoteOn.pricing?.referralCredit, total: quoteOn.pricing?.total, ref: quoteOn.referral }));

// With a tighter cap, the cap rather than the balance decides what comes off.
await api('/api/admin/settings', { method: 'PUT', token: adminToken, body: { referral_max_booking_percent: 20 } });
const quoteCapped = await api('/api/customer/quote', {
  method: 'POST', token: friendToken, body: { services: [{ code: 'full_home' }], useReferral: true },
});
ok('the share is an admin setting, and the rest of the balance is kept for later',
  quoteCapped.pricing?.referralCredit === r2(quoteCapped.pricing.total * 0.2) &&
  quoteCapped.referral?.limited === true && quoteCapped.referral?.balance === 100,
  JSON.stringify({ credit: quoteCapped.pricing?.referralCredit, total: quoteCapped.pricing?.total, ref: quoteCapped.referral }));
const cappedBooking = await api('/api/customer/tasks', {
  method: 'POST', token: friendToken,
  body: { services: [{ code: 'full_home' }], addressId: friendAddressId, bookingType: 'instant', useReferral: true, idempotencyKey: `smoke-ref-cap-${Date.now()}` },
});
ok('and a booking is held to it too — not just the bill preview',
  cappedBooking.task?.referralCredit === r2(cappedBooking.task.total * 0.2) &&
  (await api('/api/referrals', { token: friendToken })).balance === r2(100 - cappedBooking.task.referralCredit),
  JSON.stringify({ credit: cappedBooking.task?.referralCredit, error: cappedBooking.error }));
await api(`/api/customer/tasks/${cappedBooking.task?.id}/cancel`, { method: 'POST', token: friendToken, body: { reason: 'Smoke test cap check' } });
await api('/api/admin/settings', { method: 'PUT', token: adminToken, body: { referral_max_booking_percent: 50 } });

const creditBooking = (key) => api('/api/customer/tasks', {
  method: 'POST', token: friendToken,
  body: { services: [{ code: 'full_home' }], addressId: friendAddressId, bookingType: 'instant', useReferral: true, idempotencyKey: key },
});
const booked1 = await creditBooking(`smoke-ref-a-${Date.now()}`);
ok('a booking made with it records the credit', booked1.task?.referralCredit === 100 && booked1.task?.amountDue === r2(booked1.task.total - 100),
  JSON.stringify({ credit: booked1.task?.referralCredit, due: booked1.task?.amountDue, error: booked1.error }));
ok('and the balance is spent', (await api('/api/referrals', { token: friendToken })).balance === 0);

await api(`/api/customer/tasks/${booked1.task?.id}/cancel`, { method: 'POST', token: friendToken, body: { reason: 'Smoke test refund' } });
const refunded = await api('/api/referrals', { token: friendToken });
ok('cancelling the booking gives it all back',
  refunded.balance === 100 && refunded.totals.used === 0 &&
  refunded.history.map((h) => h.type).slice(0, 2).join() === 'BOOKING_REFUND,BOOKING_REDEMPTION',
  JSON.stringify({ balance: refunded.balance, totals: refunded.totals, types: refunded.history.map((h) => h.type) }));

// A cash job paid partly with referral balance: the platform makes it up to the helper.
const booked2 = await creditBooking(`smoke-ref-b-${Date.now()}`);
let refAccepted = null;
for (let i = 0; i < 15 && !refAccepted; i += 1) {
  await sleep(400);
  const attempt = await api(`/api/helper/requests/${booked2.task?.id}/accept`, { method: 'POST', token: winnerToken });
  if (attempt.status === 200) refAccepted = attempt;
}
await startJob(booked2.task?.id, winnerToken, friendToken);
await api(`/api/helper/jobs/${booked2.task?.id}/completion-otp`, { method: 'POST', token: winnerToken });
const refOtp = (await api(`/api/customer/tasks/${booked2.task?.id}`, { token: friendToken })).task?.completionOtp;
await api(`/api/helper/jobs/${booked2.task?.id}/complete`, { method: 'POST', token: winnerToken, body: { otp: refOtp } });
const helperJob = await api(`/api/helper/jobs/${booked2.task?.id}`, { token: winnerToken });
ok('the helper is told to collect the bill less the credit',
  helperJob.task?.amountDue === r2(booked2.task.total - 100), JSON.stringify({ due: helperJob.task?.amountDue }));

const payoutBefore = (await api('/api/helper/wallet', { token: winnerToken })).payoutDue;
const refCash = await api(`/api/helper/jobs/${booked2.task?.id}/confirm-payment`, { method: 'POST', token: winnerToken });
const platformShare = r2(booked2.task.pricing.platformFee + booked2.task.pricing.helperCommission);
ok('with the credit bigger than the platform share, the helper owes nothing for it',
  refCash.owed === 0 && refCash.collected === r2(booked2.task.total - 100), JSON.stringify(refCash));
ok('and the platform owes them the difference',
  refCash.referralCovered === r2(100 - platformShare), JSON.stringify({ covered: refCash.referralCovered, platformShare }));

const refWallet = await api('/api/helper/wallet', { token: winnerToken });
const refGroup = refWallet.groups?.find((g) => g.taskId === booked2.task?.id);
ok('the wallet shows the credit as money in, and the job still nets to the payout',
  refGroup?.lines.map((l) => l.kind).join() === 'PAID_CASH,COMMISSION,PLATFORM_FEE,REFERRAL_CREDIT' &&
  r2(refGroup.lines.reduce((t, l) => t + l.amount, 0)) === refCash.earning,
  JSON.stringify(refGroup?.lines));
ok('as a payout due, with the dues left as they were',
  refWallet.payoutDue === r2(payoutBefore + refCash.referralCovered) && refWallet.owedToPlatform === r2(duesBefore - 20),
  JSON.stringify({ due: refWallet.payoutDue, owed: refWallet.owedToPlatform }));

const friendAdmin = await api(`/api/admin/customers/${(await api('/api/auth/me', { token: friendToken })).user.id}`, { token: adminToken });
ok('admin sees who referred a customer, and their balance (spent on the second booking)',
  friendAdmin.customer?.referral?.referredBy?.id === winnerId && friendAdmin.customer?.referral?.balance === 0,
  JSON.stringify(friendAdmin.customer?.referral));

await api('/api/admin/settings', { method: 'PUT', token: adminToken, body: { referral_reward_amount: 100 } });

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

// Instant: a booking for later has no quick close — it searches in waves.
const quiet = await api('/api/customer/tasks', {
  method: 'POST', token: customerToken,
  body: {
    services: [{ code: 'bathroom', options: {} }],
    addressId, bookingType: 'instant',
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

// ------------------------------------------ bookings for later: waves, no timer
console.log('\n9c. Bookings for later');

const planSettings = {
  search_duration_seconds: 300, renotify_interval_seconds: 90, accept_window_seconds: 60,
  scheduled_notify_waves: 5, scheduled_close_minutes_before: 30,
};
const t0 = Date.parse('2026-09-14T10:00:00');
const far = planSearch({ now: t0, bookingType: 'scheduled', scheduledAt: '2026-09-14T18:00:00', settings: planSettings });
ok('a booking hours away searches in waves, not on a timer', far.mode === 'scheduled' && far.waves === 5, JSON.stringify(far));
ok('its search closes 30 minutes before the slot',
  far.expiresAt.getTime() === Date.parse('2026-09-14T17:30:00'), far.expiresAt.toISOString());
const waveTimes = [0, 1, 2, 3, 4].map((i) => new Date(waveDueAt(t0, far.expiresAt, 5, i)).toTimeString().slice(0, 5));
ok('the waves are spread evenly across that time',
  waveTimes.join(' ') === '10:00 11:30 13:00 14:30 16:00', waveTimes.join(' '));

const soon = planSearch({ now: t0, bookingType: 'scheduled', scheduledAt: '2026-09-14T10:35:00', settings: planSettings });
ok('a "later" slot too close for waves is searched the instant way', soon.mode === 'instant', JSON.stringify(soon));
const now1 = planSearch({ now: t0, bookingType: 'instant', scheduledAt: '2026-09-14T10:00:00', settings: planSettings });
ok('an instant booking keeps its five-minute window',
  now1.mode === 'instant' && now1.expiresAt.getTime() - t0 === 300_000, JSON.stringify(now1));

// Live: a slot next Sunday. One wave now, and no reminders between waves even
// with the reminder interval turned right down.
await api('/api/admin/settings', {
  method: 'PUT', token: adminToken, body: { renotify_interval_seconds: 3, accept_window_seconds: 2 },
});
await api('/api/helper/online', { method: 'POST', token: helperB, body: { isOnline: true } });
const laterSlot = outOfHoursSlot();
const later = (await api('/api/customer/tasks', {
  method: 'POST', token: customerToken,
  body: {
    services: [{ code: 'sofa', options: {} }], addressId, date: laterSlot.date, time: laterSlot.time,
    idempotencyKey: `smoke-later-${Date.now()}`,
  },
})).task;
ok('a booking for later is marked as a wave search',
  later?.searchMode === 'scheduled' &&
  Date.parse(later.searchExpiresAt) === Date.parse(later.scheduledAt) - 30 * 60_000,
  JSON.stringify({ mode: later?.searchMode, closes: later?.searchExpiresAt, slot: later?.scheduledAt }));

let laterAlerts = [];
for (let i = 0; i < 20 && laterAlerts.length < 1; i += 1) { await sleep(300); laterAlerts = await alertsFor(later.id); }
ok('the first wave alerts available helpers straight away', laterAlerts.length === 1, String(laterAlerts.length));
await sleep(7000);
ok('and nobody is reminded between waves', (await alertsFor(later.id)).length === 1, String((await alertsFor(later.id)).length));
ok('the booking is still searching — no countdown closed it',
  (await api(`/api/customer/tasks/${later.id}`, { token: customerToken })).task?.status === 'SEARCHING');

await api(`/api/customer/tasks/${later.id}/cancel`, { method: 'POST', token: customerToken, body: { reason: 'Smoke test cleanup' } });
await api('/api/helper/online', { method: 'POST', token: helperB, body: { isOnline: false } });
await api('/api/admin/settings', {
  method: 'PUT', token: adminToken,
  body: {
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
const underWay = await startJob(liveId, helperA, customerToken);
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
  finance.totals.platformEarned ===
    Math.round((finance.totals.platformFee + finance.totals.commission - finance.totals.referralCredit) * 100) / 100,
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

// ------------------------------------------------------- transaction detail
console.log('\n12a. Every transaction, in detail');

const txns = await api(`/api/admin/finance/transactions?limit=100`, { token: adminToken });
const cashTxn = txns.transactions?.find((t) => t.id === taskId);
const onlineTxn = txns.transactions?.find((t) => t.id === onlineTaskId);
ok('the cash-paid booking is listed with who paid whom, how, and when',
  cashTxn?.paymentMode === 'CASH' && cashTxn?.paidByRole === 'helper' && Boolean(cashTxn?.paidAt) &&
  Boolean(cashTxn?.customer?.name) && ['Helper A', 'Helper B'].includes(cashTxn?.helper?.name),
  JSON.stringify(cashTxn));
ok('its owed-by-helper ledger row is settled, now that it has been collected',
  cashTxn?.owedByHelper?.settled === true && cashTxn?.owedByHelper?.amount > 0, JSON.stringify(cashTxn?.owedByHelper));
ok('the online-paid booking shows the customer paid, with no debt attached',
  onlineTxn?.paymentMode === 'ONLINE' && onlineTxn?.paidByRole === 'customer' && !onlineTxn?.owedByHelper,
  JSON.stringify(onlineTxn));
ok('its payout to the helper is booked but not yet settled',
  onlineTxn?.earning?.amount > 0, JSON.stringify(onlineTxn?.earning));

const txnByCode = await api(`/api/admin/finance/transactions?q=${cashTxn?.code}`, { token: adminToken });
ok('transactions can be found by booking code',
  txnByCode.transactions?.some((t) => t.id === taskId), JSON.stringify(txnByCode.transactions?.map((t) => t.code)));

const paidOnly = await api(`/api/admin/finance/transactions?status=paid&limit=100`, { token: adminToken });
ok('and filtered to only what has actually been paid',
  paidOnly.transactions?.every((t) => t.paymentStatus === 'PAID'), JSON.stringify(paidOnly.transactions?.map((t) => t.paymentStatus)));

// -------------------------------------------------------------------- track
console.log('\n12b. Tracking who was asked, and what they did');

const track = await api(`/api/admin/track?q=${cashTxn?.code}`, { token: adminToken });
const tracked = track.tasks?.find((t) => t.id === taskId);
ok('the booking is found with its full request history', Boolean(tracked), JSON.stringify(track.tasks?.map((t) => t.code)));
ok('the helper who took it shows as accepted',
  tracked?.requests?.some((r) => r.helperId === winnerId && r.status === 'ACCEPTED'), JSON.stringify(tracked?.requests));
ok('the summary counts add up to every helper that was alerted',
  tracked?.summary?.sent === tracked?.requests?.length &&
  tracked?.summary?.accepted + tracked?.summary?.declined + tracked?.summary?.unanswered + tracked?.summary?.standDown + tracked?.summary?.pending === tracked?.summary?.sent,
  JSON.stringify(tracked?.summary));
ok('each request carries when it was sent and how long it took to answer',
  tracked?.requests?.every((r) => r.sentAt && Number.isFinite(r.waitedSeconds)), JSON.stringify(tracked?.requests));

// ------------------------------------------------------------ admin filters
console.log('\n12c. Filtering admin lists');
const future = new Date(Date.now() + 365 * 86_400_000).toISOString();
const all = (rows, pred) => Array.isArray(rows) && rows.every(pred);

const options = await api('/api/admin/filter-options', { token: adminToken });
ok('filter dropdowns get the services and societies', options.services?.length === 4 && options.societies?.length === 3,
  JSON.stringify({ s: options.services?.length, so: options.societies?.length }));

const doneBookings = await api('/api/admin/bookings?status=COMPLETED,SETTLED&limit=100', { token: adminToken });
ok('bookings filter by a group of statuses', doneBookings.bookings?.length > 0 && all(doneBookings.bookings, (b) => ['COMPLETED', 'SETTLED'].includes(b.status)),
  JSON.stringify(doneBookings.bookings?.map((b) => b.status)));
ok('with tab counts that ignore the status filter', Object.keys(doneBookings.counts || {}).length > 2, JSON.stringify(doneBookings.counts));
const byPerson = await api(`/api/admin/bookings?q=${encodeURIComponent('Rahul Friend')}&limit=100`, { token: adminToken });
ok('bookings can be found by the customer on them', byPerson.bookings?.length >= 2 && all(byPerson.bookings, (b) => b.customer?.name === 'Rahul Friend'),
  JSON.stringify(byPerson.bookings?.map((b) => b.customer?.name)));
const instantOnly = await api('/api/admin/bookings?type=instant&limit=100', { token: adminToken });
ok('by booking type', instantOnly.bookings?.length > 0 && all(instantOnly.bookings, (b) => b.bookingType === 'instant'));
const kitchenOnly = await api('/api/admin/bookings?service=kitchen&limit=100', { token: adminToken });
ok('by service', kitchenOnly.bookings?.some((b) => b.id === onlineTaskId) && all(kitchenOnly.bookings, (b) => b.services.some((n) => /kitchen/i.test(n))),
  JSON.stringify(kitchenOnly.bookings?.map((b) => b.services)));
const onlinePaid = await api('/api/admin/bookings?payment=online&limit=100', { token: adminToken });
ok('by how they were paid', onlinePaid.bookings?.some((b) => b.id === onlineTaskId) && !onlinePaid.bookings?.some((b) => b.id === taskId));
ok('by date', (await api(`/api/admin/bookings?from=${future}`, { token: adminToken })).total === 0);
const oneHelper = await api(`/api/admin/bookings?helper=${winnerId}&status=COMPLETED,SETTLED&limit=100`, { token: adminToken });
ok('by one helper, with the tab counts narrowed to them too',
  oneHelper.bookings?.length >= 3 && all(oneHelper.bookings, (b) => ['Helper A', 'Helper B'].includes(b.helper?.name)) &&
  Object.values(oneHelper.counts || {}).reduce((a, b) => a + b, 0) < (doneBookings.total + 100),
  JSON.stringify({ n: oneHelper.bookings?.length, counts: oneHelper.counts }));
ok('a malformed person id matches nothing rather than failing',
  (await api('/api/admin/bookings?customer=not-an-id', { token: adminToken })).total === 0);
const pageOne = await api('/api/admin/bookings?limit=1', { token: adminToken });
ok('and page through the results', pageOne.bookings?.length === 1 && pageOne.pages === pageOne.total && pageOne.total > 1,
  JSON.stringify({ n: pageOne.bookings?.length, total: pageOne.total, pages: pageOne.pages }));

const onlineHelpers = await api('/api/admin/helpers?online=online', { token: adminToken });
ok('helpers filter by online', all(onlineHelpers.helpers, (h) => h.isOnline), JSON.stringify(onlineHelpers.helpers?.map((h) => h.isOnline)));
const sofaHelpers = await api('/api/admin/helpers?service=sofa&status=APPROVED', { token: adminToken });
ok('by service and verification together', sofaHelpers.helpers?.some((h) => h.id === helperAId) && all(sofaHelpers.helpers, (h) => h.approvalStatus === 'APPROVED' && h.services.includes('sofa')));
const byJobs = await api('/api/admin/helpers?sort=jobs', { token: adminToken });
ok('and sort by jobs done', all(byJobs.helpers?.slice(1), (h, i) => (byJobs.helpers[i].completedJobs ?? 0) >= (h.completedJobs ?? 0)),
  JSON.stringify(byJobs.helpers?.map((h) => h.completedJobs)));

const neverBooked = await api('/api/admin/customers?has=never', { token: adminToken });
ok('customers filter to those who never booked', all(neverBooked.customers, (c) => c.bookings === 0) && neverBooked.counts?.all >= 0);
const bySpend = await api('/api/admin/customers?sort=spend', { token: adminToken });
ok('and sort by spend', all(bySpend.customers?.slice(1), (c, i) => bySpend.customers[i].spend >= c.spend), JSON.stringify(bySpend.customers?.map((c) => c.spend)));

const acceptedTrack = await api('/api/admin/track?status=all&outcome=accepted&limit=100', { token: adminToken });
ok('track filters by dispatch outcome', acceptedTrack.tasks?.length > 0 && all(acceptedTrack.tasks, (t) => t.summary.accepted > 0));
const neverAlerted = await api('/api/admin/track?status=all&outcome=not_alerted&limit=100', { token: adminToken });
ok('including bookings nobody was alerted for', all(neverAlerted.tasks, (t) => t.summary.sent === 0));
const trackByHelper = await api(`/api/admin/track?status=all&q=${encodeURIComponent('Helper B')}&limit=100`, { token: adminToken });
ok('and finds bookings by a helper who was only alerted', trackByHelper.tasks?.length > 0 &&
  all(trackByHelper.tasks, (t) => t.requests.some((r) => r.helperName === 'Helper B') || t.helper?.name === 'Helper B'));

const helperTxns = await api(`/api/admin/finance/transactions?helper=${winnerId}&limit=100`, { token: adminToken });
ok('transactions filter by helper', helperTxns.transactions?.length >= 2 && all(helperTxns.transactions, (t) => t.helper?.id === winnerId));
ok('and by date', (await api(`/api/admin/finance/transactions?from=${future}`, { token: adminToken })).total === 0);

const settledLogs = await api('/api/admin/audit?action=COMMISSION_SETTLED', { token: adminToken });
ok('the audit log filters by action', settledLogs.logs?.length > 0 && all(settledLogs.logs, (l) => l.action === 'COMMISSION_SETTLED'),
  JSON.stringify(settledLogs.logs?.map((l) => l.action)));

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
