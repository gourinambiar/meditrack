const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'meditrack.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS blocks (
  block_index INTEGER PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  data TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stakeholders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manufacturer','distributor','wholesaler','pharmacy','regulator','patient')),
  location TEXT,
  registered_at INTEGER NOT NULL,
  is_authorized INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  stakeholder_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  medicine_name TEXT NOT NULL,
  manufacturer_id TEXT NOT NULL,
  manufacturing_date TEXT NOT NULL,
  expiry_date TEXT NOT NULL,
  requires_cold_chain INTEGER NOT NULL DEFAULT 0,
  temp_min REAL,
  temp_max REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS medicines (
  id TEXT PRIMARY KEY,
  serial_number TEXT UNIQUE NOT NULL,
  batch_id TEXT NOT NULL,
  medicine_name TEXT NOT NULL,
  manufacturer_id TEXT NOT NULL,
  manufacturing_date TEXT NOT NULL,
  expiry_date TEXT NOT NULL,
  current_owner_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_transit',
  trust_score INTEGER NOT NULL DEFAULT 100,
  classification TEXT NOT NULL DEFAULT 'Authentic/Safe',
  qr_payload TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  medicine_id TEXT NOT NULL,
  from_id TEXT,
  to_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  block_index INTEGER NOT NULL,
  flagged INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  medicine_id TEXT NOT NULL,
  scanned_by TEXT,
  scan_location TEXT,
  timestamp INTEGER NOT NULL,
  result TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS temperature_logs (
  id TEXT PRIMARY KEY,
  medicine_id TEXT NOT NULL,
  temperature REAL NOT NULL,
  timestamp INTEGER NOT NULL,
  violation INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS anomalies (
  id TEXT PRIMARY KEY,
  medicine_id TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  description TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);
`);

module.exports = db;
