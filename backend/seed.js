/**
 * seed.js — populates MediTrack with demo stakeholders, batches, and
 * simulated supply-chain activity, including:
 *   1. A clean, fully-authentic medicine that moves normally through the
 *      pipeline (manufacturer -> distributor -> pharmacy -> patient).
 *   2. A deliberate CLONED QR SCENARIO: the same serial number gets
 *      "scanned" from two different locations within minutes, simulating
 *      a counterfeiter who copied a legitimate QR code.
 *   3. A SUSPICIOUS TRANSFER scenario: an unauthorized/unregistered
 *      party receives a medicine directly from the manufacturer, skipping
 *      the expected distributor/wholesaler stages, and another medicine
 *      is transferred twice within seconds (rapid repeated transfer).
 *
 * Run with: npm run seed  (after the server has created the DB schema,
 * or just run this directly — it uses the same db.js so the schema is
 * created automatically on first run).
 */
const db = require('./db');
const { Ledger } = require('./blockchain');
const anomaly = require('./anomaly');
const { v4: uuidv4 } = require('uuid');

// Seeding must be idempotent: wipe any existing data first so re-running
// `npm run seed` always produces exactly one clean copy of the demo
// dataset, instead of piling duplicate stakeholders/medicines on top of
// whatever was there before (which breaks the "Acting as" dropdowns and
// makes previously-shipped units seem to vanish).
db.exec(`
  DELETE FROM anomalies;
  DELETE FROM temperature_logs;
  DELETE FROM scans;
  DELETE FROM transfers;
  DELETE FROM medicines;
  DELETE FROM batches;
  DELETE FROM stakeholders;
  DELETE FROM blocks;
`);

const ledger = new Ledger(db);

function addStakeholder(name, role, location, authorized = 1) {
  const id = uuidv4();
  db.prepare(
    `INSERT INTO stakeholders (id, name, role, location, registered_at, is_authorized) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, name, role, location, Date.now(), authorized);
  return id;
}

function registerMedicine(name, manufacturerId, mfgDate, expDate, batchId) {
  const id = uuidv4();
  const serial = `MED-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  db.prepare(
    `INSERT INTO medicines (id, serial_number, batch_id, medicine_name, manufacturer_id, manufacturing_date, expiry_date, current_owner_id, status, trust_score, classification, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'registered', 100, 'Authentic/Safe', ?)`
  ).run(id, serial, batchId, name, manufacturerId, mfgDate, expDate, manufacturerId, Date.now());
  ledger.addBlock({
    type: 'REGISTER',
    medicineId: id,
    payload: { serial, batchId, name, manufacturerId, mfgDate, expDate },
  });
  return { id, serial };
}

function transfer(medicineId, fromId, toId, note = '') {
  const block = ledger.addBlock({ type: 'TRANSFER', medicineId, payload: { from: fromId, to: toId, note } });
  db.prepare(
    `INSERT INTO transfers (id, medicine_id, from_id, to_id, timestamp, block_index, flagged) VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).run(uuidv4(), medicineId, fromId, toId, Date.now(), block.index);
  db.prepare('UPDATE medicines SET current_owner_id = ? WHERE id = ?').run(toId, medicineId);
}

console.log('Seeding MediTrack demo data...');

// --- Stakeholders ---
const manufacturer = addStakeholder('PharmaGen Labs', 'manufacturer', 'Hyderabad, IN');
const distributor = addStakeholder('MedLine Distributors', 'distributor', 'Chennai, IN');
const wholesaler = addStakeholder('Apex Wholesale Pharma', 'wholesaler', 'Bengaluru, IN');
const pharmacy = addStakeholder('CareWell Pharmacy', 'pharmacy', 'Vellore, IN');
const patient = addStakeholder('Demo Patient', 'patient', 'Vellore, IN');
const regulator = addStakeholder('Central Drug Regulator', 'regulator', 'New Delhi, IN');
const rogueParty = addStakeholder('Unverified Reseller Co.', 'pharmacy', 'Unknown', 0); // unauthorized

// --- Batch 1: normal, room-temperature medicine ---
const batch1 = uuidv4();
db.prepare(
  `INSERT INTO batches (id, medicine_name, manufacturer_id, manufacturing_date, expiry_date, requires_cold_chain, temp_min, temp_max, created_at)
   VALUES (?, 'Amoxiclav 625', ?, '2026-01-10', '2028-01-10', 0, NULL, NULL, ?)`
).run(batch1, manufacturer, Date.now());

// --- Batch 2: cold-chain medicine (e.g. insulin) ---
const batch2 = uuidv4();
db.prepare(
  `INSERT INTO batches (id, medicine_name, manufacturer_id, manufacturing_date, expiry_date, requires_cold_chain, temp_min, temp_max, created_at)
   VALUES (?, 'Insulin Glargine', ?, '2026-03-01', '2027-09-01', 1, 2, 8, ?)`
).run(batch2, manufacturer, Date.now());

// === Scenario 1: clean medicine, full legitimate journey ===
const good = registerMedicine('Amoxiclav 625', manufacturer, '2026-01-10', '2028-01-10', batch1);
transfer(good.id, manufacturer, distributor, 'Bulk shipment to regional distributor');
transfer(good.id, distributor, pharmacy, 'Delivered to retail pharmacy');
transfer(good.id, pharmacy, patient, 'Dispensed to patient');
anomaly.recalculateScore(db, good.id);
console.log(`Scenario 1 (authentic): serial ${good.serial}`);

// === Scenario 2: cold-chain medicine with a temperature violation ===
const cold = registerMedicine('Insulin Glargine', manufacturer, '2026-03-01', '2027-09-01', batch2);
transfer(cold.id, manufacturer, distributor, 'Cold-chain shipment');
transfer(cold.id, distributor, wholesaler, 'Cold-chain transfer to wholesaler');
[4.5, 5.0, 12.3, 4.8].forEach((temp) => {
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batch2);
  const violation = temp < batch.temp_min || temp > batch.temp_max;
  if (violation) {
    anomaly.recordAnomaly(db, cold.id, 'TEMPERATURE_VIOLATION', 'high', `Recorded temperature ${temp}°C outside safe range [${batch.temp_min}°C, ${batch.temp_max}°C]`);
  }
  db.prepare(`INSERT INTO temperature_logs (id, medicine_id, temperature, timestamp, violation) VALUES (?, ?, ?, ?, ?)`)
    .run(uuidv4(), cold.id, temp, Date.now(), violation ? 1 : 0);
});
anomaly.recalculateScore(db, cold.id);
console.log(`Scenario 2 (cold-chain violation): serial ${cold.serial}`);

// === Scenario 3: deliberate CLONED QR / duplicate-scan counterfeit demo ===
const cloned = registerMedicine('Paracetamol 500', manufacturer, '2026-02-01', '2028-02-01', batch1);
transfer(cloned.id, manufacturer, distributor, 'Shipped to distributor');
transfer(cloned.id, distributor, pharmacy, 'Delivered to pharmacy');
// Two scans of the SAME serial from two different locations within minutes,
// simulating a counterfeiter who copied the legitimate QR code onto fake units.
db.prepare(`INSERT INTO scans (id, medicine_id, scanned_by, scan_location, timestamp, result) VALUES (?, ?, ?, ?, ?, ?)`)
  .run(uuidv4(), cloned.id, 'pharmacist@carewell', 'Vellore, IN', Date.now(), 'pending');
anomaly.recordAnomaly(
  db,
  cloned.id,
  'DUPLICATE_QR_SCAN',
  'critical',
  'Same serial number scanned from 2 different locations (Vellore, IN and Lagos, NG) within 5 minutes — possible cloned QR code'
);
db.prepare(`INSERT INTO scans (id, medicine_id, scanned_by, scan_location, timestamp, result) VALUES (?, ?, ?, ?, ?, ?)`)
  .run(uuidv4(), cloned.id, 'unknown_scanner', 'Lagos, NG', Date.now() + 1000, 'flagged');
anomaly.recalculateScore(db, cloned.id);
console.log(`Scenario 3 (cloned QR / counterfeit): serial ${cloned.serial}`);

// === Scenario 4: SUSPICIOUS TRANSFER — unauthorized party + rapid + skipped stage ===
const suspicious = registerMedicine('Azithromycin 250', manufacturer, '2026-04-01', '2027-04-01', batch1);
// Skips distributor/wholesaler entirely and goes straight to an unauthorized reseller
const block = ledger.addBlock({ type: 'TRANSFER', medicineId: suspicious.id, payload: { from: manufacturer, to: rogueParty, note: 'Direct sale bypassing distribution chain' } });
db.prepare(
  `INSERT INTO transfers (id, medicine_id, from_id, to_id, timestamp, block_index, flagged) VALUES (?, ?, ?, ?, ?, ?, 1)`
).run(uuidv4(), suspicious.id, manufacturer, rogueParty, Date.now(), block.index);
db.prepare('UPDATE medicines SET current_owner_id = ? WHERE id = ?').run(rogueParty, suspicious.id);
anomaly.recordAnomaly(db, suspicious.id, 'UNAUTHORIZED_PARTICIPANT', 'high', 'Transfer involves an unauthorized/unregistered stakeholder (Unverified Reseller Co.)');
anomaly.recordAnomaly(db, suspicious.id, 'SUSPICIOUS_MOVEMENT_PATTERN', 'medium', 'Custody skipped expected supply-chain stages (manufacturer -> pharmacy-tier reseller)');
// Then immediately re-transferred to another party (rapid repeated transfer)
const block2 = ledger.addBlock({ type: 'TRANSFER', medicineId: suspicious.id, payload: { from: rogueParty, to: patient, note: 'Immediate resale' } });
db.prepare(
  `INSERT INTO transfers (id, medicine_id, from_id, to_id, timestamp, block_index, flagged) VALUES (?, ?, ?, ?, ?, ?, 1)`
).run(uuidv4(), suspicious.id, rogueParty, patient, Date.now() + 500, block2.index);
db.prepare('UPDATE medicines SET current_owner_id = ?, status = ? WHERE id = ?').run(patient, 'delivered', suspicious.id);
anomaly.recordAnomaly(db, suspicious.id, 'RAPID_REPEATED_TRANSFER', 'medium', 'Ownership transferred again within under a second of the previous transfer');
anomaly.recalculateScore(db, suspicious.id);
console.log(`Scenario 4 (suspicious/unauthorized transfer): serial ${suspicious.serial}`);

console.log('\n=== Demo stakeholder IDs (for logging in to role dashboards) ===');
console.log({ manufacturer, distributor, wholesaler, pharmacy, patient, regulator, rogueParty });
console.log('\n=== Demo serial numbers to try in the Patient QR-scan tab ===');
console.log({
  authentic: good.serial,
  coldChainViolation: cold.serial,
  clonedCounterfeit: cloned.serial,
  suspiciousTransfer: suspicious.serial,
});
console.log('\nSeeding complete.');
