/**
 * anomaly.js
 * -----------------------------------------------------------------------
 * Rule-based anomaly detection + Authenticity/Trust Score calculation.
 * This is the layer that goes beyond "conventional" blockchain medicine
 * tracking: the blockchain guarantees WHAT was recorded is tamper-proof,
 * but it can't by itself tell you whether the recorded activity LOOKS
 * suspicious. That judgment happens here, on top of the immutable log.
 * -----------------------------------------------------------------------
 */
const { v4: uuidv4 } = require('uuid');

const RAPID_TRANSFER_WINDOW_MS = 60 * 1000; // transfers under 60s apart = suspicious
const DUPLICATE_SCAN_WINDOW_MS = 5 * 60 * 1000; // repeat scans of same unit within 5 min from different locations
const SCORE_WEIGHTS = {
  DUPLICATE_QR_SCAN: 45,
  UNAUTHORIZED_PARTICIPANT: 40,
  UNEXPECTED_OWNER_TRANSFER: 30,
  RAPID_REPEATED_TRANSFER: 20,
  EXPIRED_MEDICINE: 35,
  BROKEN_CHAIN_OF_CUSTODY: 30,
  TEMPERATURE_VIOLATION: 25,
  SUSPICIOUS_MOVEMENT_PATTERN: 20,
};

function classify(score) {
  if (score >= 75) return 'Authentic/Safe';
  if (score >= 40) return 'Suspicious';
  return 'Potentially Counterfeit';
}

function recordAnomaly(db, medicineId, type, severity, description) {
  db.prepare(
    `INSERT INTO anomalies (id, medicine_id, type, severity, description, timestamp, resolved)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).run(uuidv4(), medicineId, type, severity, description, Date.now());
}

/** Recompute the trust score for a medicine from scratch based on all
 * signals recorded so far (transfers, scans, temperature logs, expiry). */
function recalculateScore(db, medicineId) {
  const medicine = db
    .prepare('SELECT * FROM medicines WHERE id = ?')
    .get(medicineId);
  if (!medicine) return null;

  let score = 100;
  const reasons = [];

  const anomalies = db
    .prepare('SELECT * FROM anomalies WHERE medicine_id = ?')
    .all(medicineId);

  for (const a of anomalies) {
    const weight = SCORE_WEIGHTS[a.type] || 15;
    score -= weight;
    reasons.push(`${a.type} (-${weight}): ${a.description}`);
  }

  // Expiry check (recomputed live, not just at anomaly-creation time)
  const now = new Date();
  const expiry = new Date(medicine.expiry_date);
  if (expiry < now) {
    // avoid double counting if already logged
    const already = anomalies.some((a) => a.type === 'EXPIRED_MEDICINE');
    if (!already) {
      score -= SCORE_WEIGHTS.EXPIRED_MEDICINE;
      reasons.push('EXPIRED_MEDICINE: medicine past expiry date');
      recordAnomaly(db, medicineId, 'EXPIRED_MEDICINE', 'high', 'Medicine is past its expiry date');
    }
  }

  score = Math.max(0, Math.min(100, score));
  const classification = classify(score);

  db.prepare(
    'UPDATE medicines SET trust_score = ?, classification = ? WHERE id = ?'
  ).run(score, classification, medicineId);

  return { score, classification, reasons };
}

/** Called every time a transfer is attempted. Enforces "smart-contract"
 * style invariants and flags anomalies BEFORE the transfer is committed
 * to the ledger where relevant, and AFTER for pattern-based checks. */
function evaluateTransfer(db, { medicine, fromId, toId, actorStakeholder }) {
  const flags = [];

  // 1. Unauthorized participant
  if (!actorStakeholder || !actorStakeholder.is_authorized) {
    flags.push({
      type: 'UNAUTHORIZED_PARTICIPANT',
      severity: 'high',
      description: `Transfer involves an unauthorized or unregistered stakeholder (${toId})`,
    });
  }

  // 2. Unexpected ownership transfer (from does not match current owner)
  if (fromId && medicine.current_owner_id !== fromId) {
    flags.push({
      type: 'UNEXPECTED_OWNER_TRANSFER',
      severity: 'high',
      description: `Transfer initiated by ${fromId}, but current on-chain owner is ${medicine.current_owner_id}`,
    });
  }

  // 3. Rapid repeated transfers
  const lastTransfer = db
    .prepare(
      'SELECT * FROM transfers WHERE medicine_id = ? ORDER BY timestamp DESC LIMIT 1'
    )
    .get(medicine.id);
  if (lastTransfer && Date.now() - lastTransfer.timestamp < RAPID_TRANSFER_WINDOW_MS) {
    flags.push({
      type: 'RAPID_REPEATED_TRANSFER',
      severity: 'medium',
      description: `Ownership transferred again only ${Math.round(
        (Date.now() - lastTransfer.timestamp) / 1000
      )}s after the previous transfer`,
    });
  }

  // 4. Broken chain of custody: expected pipeline order
  const PIPELINE = ['manufacturer', 'distributor', 'wholesaler', 'pharmacy', 'patient'];
  const fromRole = fromId ? getRole(db, fromId) : null;
  const toRole = getRole(db, toId);
  if (fromRole && toRole) {
    const fromIdx = PIPELINE.indexOf(fromRole);
    const toIdx = PIPELINE.indexOf(toRole);
    if (fromIdx !== -1 && toIdx !== -1 && toIdx < fromIdx) {
      flags.push({
        type: 'BROKEN_CHAIN_OF_CUSTODY',
        severity: 'high',
        description: `Custody moved backward in the supply chain (${fromRole} -> ${toRole})`,
      });
    } else if (fromIdx !== -1 && toIdx !== -1 && toIdx - fromIdx > 1) {
      flags.push({
        type: 'SUSPICIOUS_MOVEMENT_PATTERN',
        severity: 'medium',
        description: `Custody skipped expected supply-chain stages (${fromRole} -> ${toRole})`,
      });
    }
  }

  return flags;
}

function getRole(db, stakeholderId) {
  const s = db.prepare('SELECT role FROM stakeholders WHERE id = ?').get(stakeholderId);
  return s ? s.role : null;
}

/** Called on every QR scan to detect cloned/duplicate QR usage. */
function evaluateScan(db, medicine, scanLocation) {
  const flags = [];
  const recentScans = db
    .prepare(
      `SELECT * FROM scans WHERE medicine_id = ? AND timestamp > ? ORDER BY timestamp DESC`
    )
    .all(medicine.id, Date.now() - DUPLICATE_SCAN_WINDOW_MS);

  const differentLocations = new Set(
    recentScans.map((s) => s.scan_location).filter(Boolean)
  );
  if (scanLocation) differentLocations.add(scanLocation);

  if (recentScans.length >= 1 && differentLocations.size > 1) {
    flags.push({
      type: 'DUPLICATE_QR_SCAN',
      severity: 'critical',
      description: `Same serial number scanned from ${differentLocations.size} different locations within ${DUPLICATE_SCAN_WINDOW_MS / 60000} minutes — possible cloned QR code`,
    });
  }

  return flags;
}

module.exports = {
  recordAnomaly,
  recalculateScore,
  evaluateTransfer,
  evaluateScan,
  classify,
  SCORE_WEIGHTS,
};
