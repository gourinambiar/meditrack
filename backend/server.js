require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { Ledger } = require('./blockchain');
const anomaly = require('./anomaly');
const auth = require('./auth');
const { authenticate, requireRole } = auth;

const SUPPLY_ROLES = ['manufacturer', 'distributor', 'wholesaler', 'pharmacy'];

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true }));
app.use(express.json());

const ledger = new Ledger(db);

const PORT = process.env.PORT || 4000;

// ---------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

function loginResponse(userId) {
  const user = auth.loadUserById(userId);
  return { token: auth.signToken(user), user: auth.publicUser(user) };
}

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  const key = auth.throttleKey(req, username);
  if (auth.isThrottled(key)) {
    return res.status(429).json({ error: 'Too many failed attempts — try again in 15 minutes' });
  }

  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = auth.verifyPassword(password, row ? row.password_hash : auth.DUMMY_HASH) && !!row;
  if (!ok) {
    auth.recordFailure(key);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const user = auth.loadUserById(row.id);
  if (!user.is_authorized) {
    return res.status(403).json({ error: 'This account has been suspended by the regulator' });
  }
  auth.clearFailures(key);
  res.json(loginResponse(row.id));
});

// Self-service sign-up is for PATIENTS only. Manufacturers, distributors,
// wholesalers, pharmacies and regulators are onboarded by a regulator
// (POST /api/stakeholders), so nobody can self-declare a trusted role.
app.post('/api/auth/signup', (req, res) => {
  const { name, location, username, password } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.length > 80) {
    return res.status(400).json({ error: 'name is required (max 80 characters)' });
  }
  if (location !== undefined && (typeof location !== 'string' || location.length > 80)) {
    return res.status(400).json({ error: 'location must be at most 80 characters' });
  }
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'username must be 3–32 characters: letters, digits, . _ -' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'that username is already taken' });
  }

  const stakeholderId = uuidv4();
  const userId = db.transaction(() => {
    db.prepare(
      `INSERT INTO stakeholders (id, name, role, location, registered_at, is_authorized)
       VALUES (?, ?, 'patient', ?, ?, 1)`
    ).run(stakeholderId, name.trim(), typeof location === 'string' ? location.trim() : '', Date.now());
    return auth.createUser({ username, password, stakeholderId });
  })();
  res.status(201).json(loginResponse(userId));
});

app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: req.user }));

// Object-level access control: who may look at a given unit's detail?
// The regulator, the manufacturer, the current holder, and anyone who has
// held it before. Everyone else uses /api/scan, the public verification path.
function canViewMedicine(user, med) {
  if (user.role === 'regulator') return true;
  if (med.manufacturer_id === user.stakeholder_id || med.current_owner_id === user.stakeholder_id) return true;
  return !!db
    .prepare('SELECT 1 FROM transfers WHERE medicine_id = ? AND (from_id = ? OR to_id = ?) LIMIT 1')
    .get(med.id, user.stakeholder_id, user.stakeholder_id);
}

// ---------------------------------------------------------------------
// Stakeholders
// ---------------------------------------------------------------------
// Regulator onboards a new participant and (optionally) issues its login.
app.post('/api/stakeholders', authenticate, requireRole('regulator'), (req, res) => {
  const { name, role, location, username, password } = req.body || {};
  if (!name || !role) return res.status(400).json({ error: 'name and role are required' });
  if (typeof name !== 'string' || name.length > 80 || (location && String(location).length > 80)) {
    return res.status(400).json({ error: 'name and location must be at most 80 characters' });
  }
  if (!['manufacturer', 'distributor', 'wholesaler', 'pharmacy', 'regulator', 'patient'].includes(role)) {
    return res.status(400).json({ error: 'invalid role' });
  }
  const withLogin = !!(username || password);
  if (withLogin) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'username must be 3–32 characters: letters, digits, . _ -' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: 'that username is already taken' });
    }
  }
  const id = uuidv4();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO stakeholders (id, name, role, location, registered_at, is_authorized)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(id, name, role, location || '', Date.now());
    if (withLogin) auth.createUser({ username, password, stakeholderId: id });
  })();
  res.status(201).json({ id, name, role, location, has_login: withLogin });
});

app.get('/api/stakeholders', authenticate, (req, res) => {
  const { role } = req.query;
  const rows = role
    ? db.prepare('SELECT * FROM stakeholders WHERE role = ?').all(role)
    : db.prepare('SELECT * FROM stakeholders ORDER BY registered_at DESC').all();
  res.json(rows);
});

app.patch('/api/stakeholders/:id/authorize', authenticate, requireRole('regulator'), (req, res) => {
  const { is_authorized } = req.body;
  if (typeof is_authorized !== 'boolean') return res.status(400).json({ error: 'is_authorized must be true or false' });
  if (req.params.id === req.user.stakeholder_id) {
    return res.status(400).json({ error: 'You cannot change your own authorization' });
  }
  if (!db.prepare('SELECT 1 FROM stakeholders WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'stakeholder not found' });
  }
  db.prepare('UPDATE stakeholders SET is_authorized = ? WHERE id = ?').run(
    is_authorized ? 1 : 0,
    req.params.id
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Batches & Medicine registration (Manufacturer)
// ---------------------------------------------------------------------
app.post('/api/batches', authenticate, requireRole('manufacturer'), (req, res) => {
  // Identity comes from the login token — the client cannot register
  // batches on behalf of another manufacturer.
  const manufacturer_id = req.user.stakeholder_id;
  const {
    medicine_name,
    manufacturing_date,
    expiry_date,
    quantity,
    requires_cold_chain,
    temp_min,
    temp_max,
  } = req.body;

  if (!medicine_name || !manufacturer_id || !manufacturing_date || !expiry_date || !quantity) {
    return res.status(400).json({ error: 'missing required batch fields' });
  }

  const manufacturer = db.prepare('SELECT * FROM stakeholders WHERE id = ?').get(manufacturer_id);
  if (!manufacturer || manufacturer.role !== 'manufacturer') {
    return res.status(400).json({ error: 'invalid manufacturer' });
  }

  const batchId = uuidv4();
  db.prepare(
    `INSERT INTO batches (id, medicine_name, manufacturer_id, manufacturing_date, expiry_date, requires_cold_chain, temp_min, temp_max, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    batchId,
    medicine_name,
    manufacturer_id,
    manufacturing_date,
    expiry_date,
    requires_cold_chain ? 1 : 0,
    temp_min ?? null,
    temp_max ?? null,
    Date.now()
  );

  const medicines = [];
  for (let i = 0; i < Number(quantity); i++) {
    const medId = uuidv4();
    const serial = `MED-${Date.now().toString(36).toUpperCase()}-${i}-${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`;

    db.prepare(
      `INSERT INTO medicines (id, serial_number, batch_id, medicine_name, manufacturer_id, manufacturing_date, expiry_date, current_owner_id, status, trust_score, classification, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'registered', 100, 'Authentic/Safe', ?)`
    ).run(medId, serial, batchId, medicine_name, manufacturer_id, manufacturing_date, expiry_date, manufacturer_id, Date.now());

    ledger.addBlock({
      type: 'REGISTER',
      medicineId: medId,
      payload: { serial, batchId, medicine_name, manufacturer_id, manufacturing_date, expiry_date },
    });

    medicines.push({ id: medId, serial });
  }

  res.json({ batchId, count: medicines.length, medicines });
});

app.get('/api/batches', authenticate, requireRole('regulator', 'manufacturer'), (req, res) => {
  const rows =
    req.user.role === 'regulator'
      ? db.prepare('SELECT * FROM batches ORDER BY created_at DESC').all()
      : db.prepare('SELECT * FROM batches WHERE manufacturer_id = ? ORDER BY created_at DESC').all(req.user.stakeholder_id);
  res.json(rows);
});

// ---------------------------------------------------------------------
// Medicines
// ---------------------------------------------------------------------
app.get('/api/medicines', authenticate, (req, res) => {
  // Everyone except the regulator only ever sees the units they hold.
  const owner_id = req.user.role === 'regulator' ? req.query.owner_id : req.user.stakeholder_id;
  const rows = owner_id
    ? db.prepare('SELECT * FROM medicines WHERE current_owner_id = ? ORDER BY created_at DESC').all(owner_id)
    : db.prepare('SELECT * FROM medicines ORDER BY created_at DESC').all();
  res.json(rows);
});

app.get('/api/medicines/:id', authenticate, (req, res) => {
  const med = db.prepare('SELECT * FROM medicines WHERE id = ?').get(req.params.id);
  if (!med || !canViewMedicine(req.user, med)) return res.status(404).json({ error: 'not found' });
  res.json(med);
});

// QR code generation for a medicine unit
app.get('/api/medicines/:id/qrcode', authenticate, async (req, res) => {
  const med = db.prepare('SELECT * FROM medicines WHERE id = ?').get(req.params.id);
  if (!med || !canViewMedicine(req.user, med)) return res.status(404).json({ error: 'not found' });
  const payload = JSON.stringify({ serial: med.serial_number, id: med.id });
  try {
    const dataUrl = await QRCode.toDataURL(payload, { width: 260, margin: 1 });
    db.prepare('UPDATE medicines SET qr_payload = ? WHERE id = ?').run(payload, med.id);
    res.json({ dataUrl, payload });
  } catch (e) {
    res.status(500).json({ error: 'qr generation failed' });
  }
});

// ---------------------------------------------------------------------
// Transfers (Distributor / Wholesaler / Pharmacy / smart-contract logic)
// ---------------------------------------------------------------------
app.post('/api/transfer', authenticate, requireRole(...SUPPLY_ROLES), (req, res) => {
  const { medicine_id, to_id, actor_note } = req.body;
  // The sender is ALWAYS the logged-in stakeholder (never a client-supplied id).
  const from_id = req.user.stakeholder_id;
  const medicine = db.prepare('SELECT * FROM medicines WHERE id = ?').get(medicine_id);
  if (!medicine) return res.status(404).json({ error: 'medicine not found' });

  // Smart-contract rule: only the current owner may transfer a unit
  // (mirrors require(med.currentOwner == msg.sender) in the Solidity contract).
  if (medicine.current_owner_id !== from_id) {
    return res.status(403).json({ error: 'Transfer rejected: you are not the current holder of this unit' });
  }
  if (to_id === from_id) return res.status(400).json({ error: 'cannot transfer a unit to yourself' });

  const toStakeholder = db.prepare('SELECT * FROM stakeholders WHERE id = ?').get(to_id);
  if (!toStakeholder) return res.status(400).json({ error: 'recipient stakeholder not found' });

  const flags = anomaly.evaluateTransfer(db, {
    medicine,
    fromId: from_id,
    toId: to_id,
    actorStakeholder: toStakeholder,
  });

  // Smart-contract style hard rule: block the transfer outright if the
  // recipient is not an authorized stakeholder, and log the attempt.
  const hardBlock = flags.some((f) => f.type === 'UNAUTHORIZED_PARTICIPANT');
  if (hardBlock) {
    flags.forEach((f) => anomaly.recordAnomaly(db, medicine_id, f.type, f.severity, f.description));
    anomaly.recalculateScore(db, medicine_id);
    return res.status(403).json({
      error: 'Transfer rejected by smart contract: unauthorized participant',
      flags,
    });
  }

  const transferId = uuidv4();
  const block = ledger.addBlock({
    type: 'TRANSFER',
    medicineId: medicine_id,
    payload: { from: from_id || null, to: to_id, note: actor_note || '' },
  });

  db.prepare(
    `INSERT INTO transfers (id, medicine_id, from_id, to_id, timestamp, block_index, flagged)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(transferId, medicine_id, from_id || null, to_id, Date.now(), block.index, flags.length > 0 ? 1 : 0);

  db.prepare('UPDATE medicines SET current_owner_id = ?, status = ? WHERE id = ?').run(
    to_id,
    toStakeholder.role === 'patient' ? 'delivered' : 'in_transit',
    medicine_id
  );

  flags.forEach((f) => anomaly.recordAnomaly(db, medicine_id, f.type, f.severity, f.description));
  const scoreResult = anomaly.recalculateScore(db, medicine_id);

  res.json({ transferId, block: { index: block.index, hash: block.hash }, flags, score: scoreResult });
});

// ---------------------------------------------------------------------
// Scan / verify (Patient-facing + anti-counterfeit check)
// ---------------------------------------------------------------------
app.post('/api/scan', authenticate, (req, res) => {
  const { serial_number, scan_location } = req.body;
  const scanned_by = `${req.user.username} (${req.user.role})`;
  const medicine = db.prepare('SELECT * FROM medicines WHERE serial_number = ?').get(serial_number);

  if (!medicine) {
    return res.json({
      found: false,
      result: 'NOT_FOUND',
      message: 'No blockchain record for this serial number. This medicine cannot be verified and may be counterfeit.',
    });
  }

  const flags = anomaly.evaluateScan(db, medicine, scan_location);
  flags.forEach((f) => anomaly.recordAnomaly(db, medicine.id, f.type, f.severity, f.description));
  const scoreResult = anomaly.recalculateScore(db, medicine.id);

  db.prepare(
    `INSERT INTO scans (id, medicine_id, scanned_by, scan_location, timestamp, result)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(uuidv4(), medicine.id, scanned_by || 'anonymous', scan_location || 'unknown', Date.now(), scoreResult.classification);

  const history = ledger.historyFor(medicine.id);
  const transfers = db
    .prepare('SELECT * FROM transfers WHERE medicine_id = ? ORDER BY timestamp ASC')
    .all(medicine.id);
  const manufacturer = db.prepare('SELECT * FROM stakeholders WHERE id = ?').get(medicine.manufacturer_id);
  const currentOwner = db.prepare('SELECT * FROM stakeholders WHERE id = ?').get(medicine.current_owner_id);

  res.json({
    found: true,
    medicine: { ...medicine, trust_score: scoreResult.score, classification: scoreResult.classification },
    manufacturer,
    currentOwner,
    history,
    transfers,
    newFlags: flags,
    chainIntegrity: ledger.verifyChainIntegrity(),
  });
});

// ---------------------------------------------------------------------
// Supply chain timeline for a medicine
// ---------------------------------------------------------------------
app.get('/api/medicines/:id/timeline', authenticate, (req, res) => {
  const medicine = db.prepare('SELECT * FROM medicines WHERE id = ?').get(req.params.id);
  if (!medicine || !canViewMedicine(req.user, medicine)) return res.status(404).json({ error: 'not found' });
  const transfers = db
    .prepare('SELECT * FROM transfers WHERE medicine_id = ? ORDER BY timestamp ASC')
    .all(req.params.id);
  const enriched = transfers.map((t) => ({
    ...t,
    from: t.from_id ? db.prepare('SELECT name, role FROM stakeholders WHERE id = ?').get(t.from_id) : null,
    to: db.prepare('SELECT name, role FROM stakeholders WHERE id = ?').get(t.to_id),
  }));
  res.json({ medicine, transfers: enriched, blockchainHistory: ledger.historyFor(req.params.id) });
});

// ---------------------------------------------------------------------
// Cold-chain / temperature monitoring
// ---------------------------------------------------------------------
app.post('/api/temperature', authenticate, requireRole(...SUPPLY_ROLES), (req, res) => {
  const { medicine_id, temperature } = req.body;
  if (typeof temperature !== 'number' || !Number.isFinite(temperature)) {
    return res.status(400).json({ error: 'temperature must be a number' });
  }
  const medicine = db.prepare('SELECT * FROM medicines WHERE id = ?').get(medicine_id);
  if (!medicine) return res.status(404).json({ error: 'medicine not found' });
  // Only the party currently holding the unit can log its cold-chain readings.
  if (medicine.current_owner_id !== req.user.stakeholder_id) {
    return res.status(403).json({ error: 'You can only log readings for units you currently hold' });
  }
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(medicine.batch_id);

  let violation = 0;
  if (batch && batch.requires_cold_chain) {
    if (temperature < batch.temp_min || temperature > batch.temp_max) {
      violation = 1;
      anomaly.recordAnomaly(
        db,
        medicine_id,
        'TEMPERATURE_VIOLATION',
        'high',
        `Recorded temperature ${temperature}°C outside safe range [${batch.temp_min}°C, ${batch.temp_max}°C]`
      );
      anomaly.recalculateScore(db, medicine_id);
    }
  }

  db.prepare(
    `INSERT INTO temperature_logs (id, medicine_id, temperature, timestamp, violation)
     VALUES (?, ?, ?, ?, ?)`
  ).run(uuidv4(), medicine_id, temperature, Date.now(), violation);

  res.json({ violation: !!violation });
});

app.get('/api/medicines/:id/temperature', authenticate, (req, res) => {
  const med = db.prepare('SELECT * FROM medicines WHERE id = ?').get(req.params.id);
  if (!med || !canViewMedicine(req.user, med)) return res.status(404).json({ error: 'not found' });
  res.json(
    db
      .prepare('SELECT * FROM temperature_logs WHERE medicine_id = ? ORDER BY timestamp ASC')
      .all(req.params.id)
  );
});

// ---------------------------------------------------------------------
// Regulator dashboard
// ---------------------------------------------------------------------
app.get('/api/regulator/overview', authenticate, requireRole('regulator'), (req, res) => {
  const totals = db.prepare('SELECT COUNT(*) AS c FROM medicines').get().c;
  const byClass = db
    .prepare('SELECT classification, COUNT(*) AS c FROM medicines GROUP BY classification')
    .all();
  const anomalies = db
    .prepare('SELECT * FROM anomalies ORDER BY timestamp DESC LIMIT 100')
    .all();
  const flaggedTransfers = db
    .prepare('SELECT * FROM transfers WHERE flagged = 1 ORDER BY timestamp DESC LIMIT 100')
    .all();
  const chainIntegrity = ledger.verifyChainIntegrity();

  res.json({ totals, byClass, anomalies, flaggedTransfers, chainIntegrity, chainLength: ledger.chain.length });
});

app.get('/api/regulator/anomalies', authenticate, requireRole('regulator'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT anomalies.*, medicines.serial_number, medicines.medicine_name
       FROM anomalies JOIN medicines ON anomalies.medicine_id = medicines.id
       ORDER BY anomalies.timestamp DESC`
    )
    .all();
  res.json(rows);
});

app.get('/api/regulator/chain', authenticate, requireRole('regulator'), (req, res) => {
  res.json({ chain: ledger.chain, integrity: ledger.verifyChainIntegrity() });
});

// ---------------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true, chainLength: ledger.chain.length }));

app.listen(PORT, () => {
  console.log(`MediTrack backend running on http://localhost:${PORT}`);
  if (auth.SECRET_IS_EPHEMERAL) {
    console.warn('[auth] JWT_SECRET not set — using a random secret, so sessions reset on restart. Copy .env.example to .env to keep them.');
  }
});
