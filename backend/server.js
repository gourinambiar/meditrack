const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { Ledger } = require('./blockchain');
const anomaly = require('./anomaly');

const app = express();
app.use(cors());
app.use(express.json());

const ledger = new Ledger(db);

const PORT = process.env.PORT || 4000;

// ---------------------------------------------------------------------
// Stakeholders
// ---------------------------------------------------------------------
app.post('/api/stakeholders', (req, res) => {
  const { name, role, location } = req.body;
  if (!name || !role) return res.status(400).json({ error: 'name and role are required' });
  const id = uuidv4();
  db.prepare(
    `INSERT INTO stakeholders (id, name, role, location, registered_at, is_authorized)
     VALUES (?, ?, ?, ?, ?, 1)`
  ).run(id, name, role, location || '', Date.now());
  res.json({ id, name, role, location });
});

app.get('/api/stakeholders', (req, res) => {
  const { role } = req.query;
  const rows = role
    ? db.prepare('SELECT * FROM stakeholders WHERE role = ?').all(role)
    : db.prepare('SELECT * FROM stakeholders ORDER BY registered_at DESC').all();
  res.json(rows);
});

app.patch('/api/stakeholders/:id/authorize', (req, res) => {
  const { is_authorized } = req.body;
  db.prepare('UPDATE stakeholders SET is_authorized = ? WHERE id = ?').run(
    is_authorized ? 1 : 0,
    req.params.id
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Batches & Medicine registration (Manufacturer)
// ---------------------------------------------------------------------
app.post('/api/batches', (req, res) => {
  const {
    medicine_name,
    manufacturer_id,
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

app.get('/api/batches', (req, res) => {
  res.json(db.prepare('SELECT * FROM batches ORDER BY created_at DESC').all());
});

// ---------------------------------------------------------------------
// Medicines
// ---------------------------------------------------------------------
app.get('/api/medicines', (req, res) => {
  const { owner_id } = req.query;
  const rows = owner_id
    ? db.prepare('SELECT * FROM medicines WHERE current_owner_id = ? ORDER BY created_at DESC').all(owner_id)
    : db.prepare('SELECT * FROM medicines ORDER BY created_at DESC').all();
  res.json(rows);
});

app.get('/api/medicines/:id', (req, res) => {
  const med = db.prepare('SELECT * FROM medicines WHERE id = ?').get(req.params.id);
  if (!med) return res.status(404).json({ error: 'not found' });
  res.json(med);
});

// QR code generation for a medicine unit
app.get('/api/medicines/:id/qrcode', async (req, res) => {
  const med = db.prepare('SELECT * FROM medicines WHERE id = ?').get(req.params.id);
  if (!med) return res.status(404).json({ error: 'not found' });
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
app.post('/api/transfer', (req, res) => {
  const { medicine_id, from_id, to_id, actor_note, force } = req.body;
  const medicine = db.prepare('SELECT * FROM medicines WHERE id = ?').get(medicine_id);
  if (!medicine) return res.status(404).json({ error: 'medicine not found' });

  const toStakeholder = db.prepare('SELECT * FROM stakeholders WHERE id = ?').get(to_id);
  if (!toStakeholder) return res.status(400).json({ error: 'recipient stakeholder not found' });

  const flags = anomaly.evaluateTransfer(db, {
    medicine,
    fromId: from_id,
    toId: to_id,
    actorStakeholder: toStakeholder,
  });

  // Smart-contract style hard rule: block transfer outright if recipient
  // is not authorized, unless explicitly forced (for demo purposes so
  // regulators can see what a blocked/flagged transfer looks like).
  const hardBlock = flags.some((f) => f.type === 'UNAUTHORIZED_PARTICIPANT') && !force;
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
app.post('/api/scan', (req, res) => {
  const { serial_number, scanned_by, scan_location } = req.body;
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
app.get('/api/medicines/:id/timeline', (req, res) => {
  const medicine = db.prepare('SELECT * FROM medicines WHERE id = ?').get(req.params.id);
  if (!medicine) return res.status(404).json({ error: 'not found' });
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
app.post('/api/temperature', (req, res) => {
  const { medicine_id, temperature } = req.body;
  const medicine = db.prepare('SELECT * FROM medicines WHERE id = ?').get(medicine_id);
  if (!medicine) return res.status(404).json({ error: 'medicine not found' });
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

app.get('/api/medicines/:id/temperature', (req, res) => {
  res.json(
    db
      .prepare('SELECT * FROM temperature_logs WHERE medicine_id = ? ORDER BY timestamp ASC')
      .all(req.params.id)
  );
});

// ---------------------------------------------------------------------
// Regulator dashboard
// ---------------------------------------------------------------------
app.get('/api/regulator/overview', (req, res) => {
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

app.get('/api/regulator/anomalies', (req, res) => {
  const rows = db
    .prepare(
      `SELECT anomalies.*, medicines.serial_number, medicines.medicine_name
       FROM anomalies JOIN medicines ON anomalies.medicine_id = medicines.id
       ORDER BY anomalies.timestamp DESC`
    )
    .all();
  res.json(rows);
});

app.get('/api/regulator/chain', (req, res) => {
  res.json({ chain: ledger.chain, integrity: ledger.verifyChainIntegrity() });
});

// ---------------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true, chainLength: ledger.chain.length }));

app.listen(PORT, () => {
  console.log(`MediTrack backend running on http://localhost:${PORT}`);
});
