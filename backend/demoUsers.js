/**
 * demoUsers.js — creates one demo login per authorized stakeholder that
 * doesn't have one yet. Username = role (manufacturer, distributor, ...),
 * with a numeric suffix if a role has more than one stakeholder.
 * Shared by seed.js and `npm run seed:users` (which does NOT wipe data).
 */
const db = require('./db');
const { createUser } = require('./auth');

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Meditrack@123';

function createDemoUsers() {
  const stakeholders = db
    .prepare('SELECT * FROM stakeholders WHERE is_authorized = 1 ORDER BY registered_at ASC, rowid ASC')
    .all();
  const hasUser = db.prepare('SELECT 1 FROM users WHERE stakeholder_id = ?');
  const nameTaken = db.prepare('SELECT 1 FROM users WHERE username = ?');
  const created = [];

  for (const s of stakeholders) {
    if (hasUser.get(s.id)) continue;
    let username = s.role;
    let n = 1;
    while (nameTaken.get(username)) username = `${s.role}${++n}`;
    createUser({ username, password: DEMO_PASSWORD, stakeholderId: s.id });
    created.push({ username, role: s.role, name: s.name });
  }
  return created;
}

module.exports = { createDemoUsers, DEMO_PASSWORD };

if (require.main === module) {
  const created = createDemoUsers();
  if (!created.length) console.log('No new demo users needed — every authorized stakeholder already has a login.');
  else {
    console.log('Created demo logins (password for all: ' + DEMO_PASSWORD + '):');
    created.forEach((u) => console.log(`  ${u.username.padEnd(14)} ${u.role.padEnd(12)} ${u.name}`));
  }
}
