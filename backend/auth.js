/**
 * auth.js
 * -----------------------------------------------------------------------
 * Authentication & authorization for MediTrack.
 *
 *  - Passwords are hashed with scrypt (Node built-in) + a per-user salt.
 *  - Sessions are stateless JWTs sent as "Authorization: Bearer <token>".
 *  - Each user account is bound to exactly ONE stakeholder, so the role and
 *    the on-ledger identity of a request always come from the verified
 *    token / DB — never from fields the client puts in the request body.
 *  - authenticate() re-reads the user + stakeholder on every request, so
 *    suspending a stakeholder (is_authorized = 0) locks them out at once.
 * -----------------------------------------------------------------------
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const TOKEN_TTL = process.env.JWT_TTL || '8h';

// Safe default: a random per-process secret, so everyone is signed out when
// the server restarts. Set JWT_SECRET in backend/.env to keep sessions.
const SECRET_IS_EPHEMERAL = !process.env.JWT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');

// ---------------------------------------------------------------- passwords
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const attempt = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return attempt.length === expected.length && crypto.timingSafeEqual(attempt, expected);
}

// Used so a login for an unknown username costs the same as a real one
// (avoids leaking which usernames exist through response timing).
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

// ------------------------------------------------------------------- users
function createUser({ username, password, stakeholderId }) {
  const id = uuidv4();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, stakeholder_id, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, username, hashPassword(password), stakeholderId, Date.now());
  return id;
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    stakeholder_id: row.stakeholder_id,
    name: row.name,
    location: row.location,
  };
}

function loadUserById(id) {
  return db
    .prepare(
      `SELECT u.id, u.username, u.stakeholder_id, s.role, s.name, s.location, s.is_authorized
       FROM users u JOIN stakeholders s ON s.id = u.stakeholder_id WHERE u.id = ?`
    )
    .get(id);
}

function signToken(user) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// ------------------------------------------------------- login throttling
// Simple in-memory limiter: 5 failed attempts per (ip + username) per 15 min.
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map();

function throttleKey(req, username) {
  return `${req.ip}|${String(username || '').toLowerCase()}`;
}
function isThrottled(key) {
  const rec = failures.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    failures.delete(key);
    return false;
  }
  return rec.count >= MAX_FAILS;
}
function recordFailure(key) {
  const rec = failures.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
  else rec.count += 1;
}
function clearFailures(key) {
  failures.delete(key);
}

// -------------------------------------------------------------- middleware
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = loadUserById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });
    if (!user.is_authorized) return res.status(403).json({ error: 'This account has been suspended by the regulator' });
    req.user = publicUser(user);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired or invalid — please log in again' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Your role (${req.user ? req.user.role : 'none'}) is not permitted to do this` });
    }
    next();
  };
}

module.exports = {
  SECRET_IS_EPHEMERAL,
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
  createUser,
  publicUser,
  loadUserById,
  signToken,
  isThrottled,
  recordFailure,
  clearFailures,
  throttleKey,
  authenticate,
  requireRole,
};
