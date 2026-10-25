/**
 * Auth & access-control tests. Runs against a throwaway database and its
 * own server instance, so it never touches your real meditrack.db.
 *   npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PORT = 4100;
const BASE = `http://localhost:${PORT}/api`;
const PW = 'Meditrack@123';
const DB = path.join(os.tmpdir(), `meditrack-test-${process.pid}.db`);
const env = { ...process.env, DB_PATH: DB, PORT: String(PORT), JWT_SECRET: 'test-secret-do-not-use' };
let server;

async function call(method, route, { token, body } = {}) {
  const res = await fetch(BASE + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function login(username, password = PW) {
  const r = await call('POST', '/auth/login', { body: { username, password } });
  assert.equal(r.status, 200, `login ${username}: ${JSON.stringify(r.body)}`);
  return r.body;
}

before(async () => {
  execFileSync('node', ['seed.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  server = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/health')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('test server did not start');
});

after(() => {
  server && server.kill();
  for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
});

test('public health works; protected routes reject anonymous callers', async () => {
  assert.equal((await call('GET', '/health')).status, 200);
  for (const route of ['/medicines', '/stakeholders', '/regulator/overview', '/batches']) {
    assert.equal((await call('GET', route)).status, 401, route);
  }
  assert.equal((await call('POST', '/transfer', { body: {} })).status, 401);
});

test('login: wrong password and unknown user get the same generic error', async () => {
  const a = await call('POST', '/auth/login', { body: { username: 'manufacturer', password: 'wrong-password' } });
  const b = await call('POST', '/auth/login', { body: { username: 'no-such-user', password: 'wrong-password' } });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.body.error, b.body.error);
});

test('each demo account logs in with the right role; /auth/me agrees', async () => {
  for (const role of ['manufacturer', 'distributor', 'wholesaler', 'pharmacy', 'patient', 'regulator']) {
    const { token, user } = await login(role);
    assert.equal(user.role, role);
    const me = await call('GET', '/auth/me', { token });
    assert.equal(me.body.user.role, role);
  }
});

test('forged, tampered and garbage tokens are rejected', async () => {
  const { token } = await login('manufacturer');
  assert.equal((await call('GET', '/auth/me', { token: token.slice(0, -3) + 'abc' })).status, 401);
  assert.equal((await call('GET', '/auth/me', { token: 'not.a.jwt' })).status, 401);
  const jwt = require('jsonwebtoken');
  const forged = jwt.sign({ sub: 'anything' }, 'some-other-secret');
  assert.equal((await call('GET', '/auth/me', { token: forged })).status, 401);
});

test('role gates: only the right roles can reach each action', async () => {
  const dist = await login('distributor');
  const patient = await login('patient');
  const mfr = await login('manufacturer');
  const batch = { medicine_name: 'X', manufacturing_date: '2026-01-01', expiry_date: '2028-01-01', quantity: 1 };
  assert.equal((await call('POST', '/batches', { token: dist.token, body: batch })).status, 403);
  assert.equal((await call('POST', '/transfer', { token: patient.token, body: {} })).status, 403);
  assert.equal((await call('GET', '/regulator/overview', { token: mfr.token })).status, 403);
  assert.equal((await call('POST', '/stakeholders', { token: mfr.token, body: { name: 'x', role: 'regulator' } })).status, 403);
});

test('batch registration ignores a spoofed manufacturer_id', async () => {
  const mfr = await login('manufacturer');
  const dist = await login('distributor');
  const r = await call('POST', '/batches', {
    token: mfr.token,
    body: { medicine_name: 'Spoof Test', manufacturer_id: dist.user.stakeholder_id,
            manufacturing_date: '2026-01-01', expiry_date: '2028-01-01', quantity: 1 },
  });
  assert.equal(r.status, 200);
  const unit = (await call('GET', `/medicines/${r.body.medicines[0].id}`, { token: mfr.token })).body;
  assert.equal(unit.manufacturer_id, mfr.user.stakeholder_id);
  assert.equal(unit.current_owner_id, mfr.user.stakeholder_id);
});

test('impersonation is impossible: sender is the token, not the request body', async () => {
  const mfr = await login('manufacturer');
  const pharm = await login('pharmacy');
  const b = await call('POST', '/batches', {
    token: mfr.token,
    body: { medicine_name: 'Held By Mfr', manufacturing_date: '2026-01-01', expiry_date: '2028-01-01', quantity: 1 },
  });
  const unitId = b.body.medicines[0].id;
  // Pharmacy tries to move a unit it doesn't hold, claiming to be the manufacturer.
  const r = await call('POST', '/transfer', {
    token: pharm.token,
    body: { medicine_id: unitId, from_id: mfr.user.stakeholder_id, to_id: pharm.user.stakeholder_id },
  });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /not the current holder/);
});

test('legitimate chain: ship, then holder changes and listings are scoped to the logged-in party', async () => {
  const mfr = await login('manufacturer');
  const dist = await login('distributor');
  const b = await call('POST', '/batches', {
    token: mfr.token,
    body: { medicine_name: 'Chain Test', manufacturing_date: '2026-01-01', expiry_date: '2028-01-01', quantity: 1 },
  });
  const unitId = b.body.medicines[0].id;
  const t = await call('POST', '/transfer', { token: mfr.token, body: { medicine_id: unitId, to_id: dist.user.stakeholder_id } });
  assert.equal(t.status, 200);
  const distList = (await call('GET', '/medicines', { token: dist.token })).body.map((m) => m.id);
  const mfrList = (await call('GET', '/medicines', { token: mfr.token })).body.map((m) => m.id);
  assert.ok(distList.includes(unitId));
  assert.ok(!mfrList.includes(unitId));
  // The old holder cannot move it again.
  const again = await call('POST', '/transfer', { token: mfr.token, body: { medicine_id: unitId, to_id: dist.user.stakeholder_id } });
  assert.equal(again.status, 403);
});

test('list scoping: owner_id query cannot be used to read another party\'s stock', async () => {
  const pharm = await login('pharmacy');
  const mfr = await login('manufacturer');
  const r = await call('GET', `/medicines?owner_id=${mfr.user.stakeholder_id}`, { token: pharm.token });
  assert.equal(r.status, 200);
  assert.ok(r.body.every((m) => m.current_owner_id === pharm.user.stakeholder_id));
  const reg = await login('regulator');
  const all = await call('GET', '/medicines', { token: reg.token });
  assert.ok(all.body.length > r.body.length);
});

test('object-level access: strangers get 404 on a unit, regulator and holders get it', async () => {
  const mfr = await login('manufacturer');
  const patient = await login('patient');
  const reg = await login('regulator');
  const unit = (await call('GET', '/medicines', { token: mfr.token })).body[0];
  assert.equal((await call('GET', `/medicines/${unit.id}`, { token: patient.token })).status, 404);
  assert.equal((await call('GET', `/medicines/${unit.id}/qrcode`, { token: patient.token })).status, 404);
  assert.equal((await call('GET', `/medicines/${unit.id}/timeline`, { token: patient.token })).status, 404);
  assert.equal((await call('GET', `/medicines/${unit.id}`, { token: reg.token })).status, 200);
  assert.equal((await call('GET', `/medicines/${unit.id}`, { token: mfr.token })).status, 200);
});

test('transfer to an unauthorized party is blocked by the "contract" and logged', async () => {
  const mfr = await login('manufacturer');
  const reg = await login('regulator');
  const rogue = (await call('GET', '/stakeholders', { token: reg.token })).body.find((s) => !s.is_authorized);
  assert.ok(rogue, 'seed should include an unauthorized stakeholder');
  const b = await call('POST', '/batches', {
    token: mfr.token,
    body: { medicine_name: 'Rogue Test', manufacturing_date: '2026-01-01', expiry_date: '2028-01-01', quantity: 1 },
  });
  const unitId = b.body.medicines[0].id;
  const r = await call('POST', '/transfer', { token: mfr.token, body: { medicine_id: unitId, to_id: rogue.id, force: true } });
  assert.equal(r.status, 403, '"force" must no longer bypass the check');
  const anomalies = (await call('GET', '/regulator/anomalies', { token: reg.token })).body;
  assert.ok(anomalies.some((a) => a.medicine_id === unitId && a.type === 'UNAUTHORIZED_PARTICIPANT'));
});

test('patient sign-up: role is forced to patient; duplicates and weak passwords rejected', async () => {
  const ok = await call('POST', '/auth/signup', {
    body: { name: 'New Patient', username: 'new.patient', password: 'longenough1', role: 'regulator' },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.role, 'patient');
  const me = await call('GET', '/auth/me', { token: ok.body.token });
  assert.equal(me.body.user.role, 'patient');
  assert.equal((await call('GET', '/regulator/overview', { token: ok.body.token })).status, 403);
  assert.equal((await call('POST', '/auth/signup', { body: { name: 'Dup', username: 'NEW.PATIENT', password: 'longenough1' } })).status, 409);
  assert.equal((await call('POST', '/auth/signup', { body: { name: 'Weak', username: 'weak.user', password: 'short' } })).status, 400);
});

test('regulator can onboard a partner with a login; that partner can sign in', async () => {
  const reg = await login('regulator');
  const r = await call('POST', '/stakeholders', {
    token: reg.token,
    body: { name: 'Fresh Pharmacy', role: 'pharmacy', location: 'Chennai', username: 'fresh.pharmacy', password: 'a-strong-pass' },
  });
  assert.equal(r.status, 201);
  const { user } = await login('fresh.pharmacy', 'a-strong-pass');
  assert.equal(user.role, 'pharmacy');
});

test('suspending a stakeholder locks out their EXISTING session immediately', async () => {
  const reg = await login('regulator');
  const wh = await login('wholesaler');
  assert.equal((await call('GET', '/auth/me', { token: wh.token })).status, 200);
  const p = await call('PATCH', `/stakeholders/${wh.user.stakeholder_id}/authorize`, { token: reg.token, body: { is_authorized: false } });
  assert.equal(p.status, 200);
  assert.equal((await call('GET', '/auth/me', { token: wh.token })).status, 403);
  assert.equal((await call('POST', '/auth/login', { body: { username: 'wholesaler', password: PW } })).status, 403);
});

test('brute force: repeated bad passwords are throttled, even for the right password afterwards', async () => {
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('POST', '/auth/login', { body: { username: 'patient', password: `bad-${i}` } })).status, 401);
  }
  const locked = await call('POST', '/auth/login', { body: { username: 'patient', password: PW } });
  assert.equal(locked.status, 429);
});

test('a regulator cannot suspend their own account; oversized names are rejected', async () => {
  const reg = await login('regulator');
  const self = await call('PATCH', `/stakeholders/${reg.user.stakeholder_id}/authorize`, { token: reg.token, body: { is_authorized: false } });
  assert.equal(self.status, 400);
  assert.equal((await call('GET', '/auth/me', { token: reg.token })).status, 200);
  const long = await call('POST', '/auth/signup', { body: { name: 'x'.repeat(81), username: 'long.name', password: 'longenough1' } });
  assert.equal(long.status, 400);
});
