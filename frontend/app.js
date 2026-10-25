const API = 'http://localhost:4000/api';
const SESSION_KEY = 'meditrack.session';

// Demo convenience only: shows one-click demo logins on the sign-in screen.
// Set to false for any real deployment (and change DEMO_PASSWORD on the server).
const SHOW_DEMO_ACCOUNTS = true;
const DEMO_PASSWORD = 'Meditrack@123';
const DEMO_USERS = ['manufacturer', 'distributor', 'wholesaler', 'pharmacy', 'patient', 'regulator'];

const VIEWS = {
  manufacturer: { label: 'Manufacturer', sub: 'Register batches and issue serialized, QR-verifiable medicine units.' },
  supplychain: { label: 'Supply Chain', sub: 'Receive stock and transfer custody forward through the chain.' },
  regulator: { label: 'Regulator', sub: 'Monitor the network, review flagged activity, and audit the ledger.' },
  verify: { label: 'Scan & Verify', sub: 'Scan a QR code or enter a serial number to check authenticity.' },
};

// Which screens each account type sees. This only shapes the UI — the
// server enforces the same rules on every request.
const VIEWS_BY_ROLE = {
  manufacturer: ['manufacturer', 'verify'],
  distributor: ['supplychain', 'verify'],
  wholesaler: ['supplychain', 'verify'],
  pharmacy: ['supplychain', 'verify'],
  regulator: ['regulator', 'verify'],
  patient: ['verify'],
};

const state = {
  view: null,
  user: null,
  token: null,
};

// ------------------------------------------------------------------ utils
// Everything that came from the server (names, serials, notes...) is
// escaped before it goes into innerHTML. Patients can now self-register,
// so a name like "<img onerror=...>" must never be able to run as markup.
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(API + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // An expired/invalid session anywhere in the app sends you back to sign-in.
    if (res.status === 401 && state.token) logout('Your session has expired — please sign in again.');
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(message, isError) {
  const tpl = document.getElementById('tpl-toast');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.textContent = message;
  if (isError) node.classList.add('error');
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3600);
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString();
}

function scoreClass(classification) {
  if (classification === 'Authentic/Safe') return 'safe';
  if (classification === 'Suspicious') return 'suspicious';
  return 'counterfeit';
}

function badge(classification) {
  return `<span class="badge ${scoreClass(classification)}">${esc(classification)}</span>`;
}

// ------------------------------------------------------------------ session
function saveSession() {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: state.token }));
}

function clearSession() {
  state.token = null;
  state.user = null;
  state.view = null;
  sessionStorage.removeItem(SESSION_KEY);
}

function logout(message) {
  clearSession();
  showLogin(message);
}

function startSession({ token, user }) {
  state.token = token;
  state.user = user;
  saveSession();
  enterApp();
}

// ------------------------------------------------------------------ login screen
function showLogin(message) {
  document.getElementById('app').hidden = true;
  const screen = document.getElementById('login-screen');
  screen.hidden = false;

  const demo = SHOW_DEMO_ACCOUNTS
    ? `<div class="demo-accounts">
         <div class="demo-title">Demo accounts <span>(password: ${esc(DEMO_PASSWORD)})</span></div>
         <div class="demo-chips">${DEMO_USERS.map((u) => `<button type="button" class="chip" data-demo="${u}">${u}</button>`).join('')}</div>
       </div>`
    : '';

  screen.innerHTML = `
    <div class="login-card">
      <div class="login-brand"><span class="brand-mark">℞</span><div><div class="brand-name">MediTrack</div><div class="login-sub">Provenance Ledger</div></div></div>
      <div class="tabs" role="tablist">
        <button class="tab-btn active" data-tab="signin" role="tab">Sign in</button>
        <button class="tab-btn" data-tab="signup" role="tab">Patient sign-up</button>
      </div>
      <div class="error-text" id="login-error" role="alert" aria-live="polite">${esc(message || '')}</div>

      <form id="signin-form" autocomplete="on">
        <div class="field"><label for="si-user">Username</label><input id="si-user" name="username" autocomplete="username" required /></div>
        <div class="field"><label for="si-pass">Password</label><input id="si-pass" name="password" type="password" autocomplete="current-password" required /></div>
        <button class="btn" type="submit" style="width:100%;justify-content:center">Sign in</button>
      </form>

      <form id="signup-form" autocomplete="on" hidden>
        <p class="hint">Patient accounts can be created here. Manufacturers, distributors, wholesalers, pharmacies and regulators are onboarded by the regulator.</p>
        <div class="field"><label for="su-name">Full name</label><input id="su-name" name="name" maxlength="80" autocomplete="name" required /></div>
        <div class="field"><label for="su-loc">City (optional)</label><input id="su-loc" name="location" maxlength="80" autocomplete="address-level2" /></div>
        <div class="field"><label for="su-user">Username</label><input id="su-user" name="username" autocomplete="username" minlength="3" maxlength="32" pattern="[A-Za-z0-9._\\-]+" title="Letters, digits, . _ -" required /></div>
        <div class="field"><label for="su-pass">Password (min 8 characters)</label><input id="su-pass" name="password" type="password" autocomplete="new-password" minlength="8" required /></div>
        <button class="btn" type="submit" style="width:100%;justify-content:center">Create account</button>
      </form>
      ${demo}
    </div>
  `;

  const errorBox = screen.querySelector('#login-error');
  const signin = screen.querySelector('#signin-form');
  const signup = screen.querySelector('#signup-form');

  screen.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.onclick = () => {
      screen.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      signin.hidden = btn.dataset.tab !== 'signin';
      signup.hidden = btn.dataset.tab !== 'signup';
      errorBox.textContent = '';
    };
  });

  screen.querySelectorAll('[data-demo]').forEach((chip) => {
    chip.onclick = () => {
      signin.querySelector('[name=username]').value = chip.dataset.demo;
      signin.querySelector('[name=password]').value = DEMO_PASSWORD;
      signin.requestSubmit();
    };
  });

  async function submit(form, path, body) {
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    errorBox.textContent = '';
    try {
      startSession(await api(path, { method: 'POST', body: JSON.stringify(body) }));
    } catch (err) {
      errorBox.textContent = err.message;
      btn.disabled = false;
    }
  }

  signin.onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(signin);
    submit(signin, '/auth/login', { username: fd.get('username').trim(), password: fd.get('password') });
  };
  signup.onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(signup);
    submit(signup, '/auth/signup', {
      name: fd.get('name').trim(),
      location: fd.get('location').trim(),
      username: fd.get('username').trim(),
      password: fd.get('password'),
    });
  };
}

// ------------------------------------------------------------------ app shell
function allowedViews() {
  return VIEWS_BY_ROLE[state.user.role] || [];
}

function enterApp() {
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app').hidden = false;
  state.view = allowedViews()[0];
  renderNav();
  renderHeader();
  renderView();
}

function renderNav() {
  const nav = document.getElementById('role-nav');
  nav.innerHTML = '';
  allowedViews().forEach((key) => {
    const btn = document.createElement('button');
    btn.className = 'rail-btn' + (state.view === key ? ' active' : '');
    btn.innerHTML = `<span class="dot"></span>${esc(VIEWS[key].label)}`;
    btn.onclick = () => {
      state.view = key;
      renderNav();
      renderHeader();
      renderView();
    };
    nav.appendChild(btn);
  });
  refreshChainPill();
}

function renderHeader() {
  const v = VIEWS[state.view];
  document.getElementById('view-title').textContent = v.label;
  document.getElementById('view-sub').textContent = v.sub;

  const box = document.getElementById('actor-select');
  box.innerHTML = `
    <div class="whoami">
      <div><span class="whoami-label">Signed in as</span><strong>${esc(state.user.name)}</strong> <em>${esc(state.user.role)}</em></div>
      <button class="btn secondary" id="logout-btn" type="button">Sign out</button>
    </div>`;
  box.querySelector('#logout-btn').onclick = () => logout();
}

async function refreshChainPill() {
  try {
    const h = await api('/health');
    document.getElementById('chain-pill').textContent = `chain: ${h.chainLength} blocks`;
  } catch {
    document.getElementById('chain-pill').textContent = 'chain: offline';
  }
}

// ------------------------------------------------------------------ view dispatch
async function renderView() {
  const root = document.getElementById('view-root');
  root.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    if (state.view === 'manufacturer') await viewManufacturer(root);
    else if (state.view === 'supplychain') await viewSupplyChain(root);
    else if (state.view === 'regulator') await viewRegulator(root);
    else if (state.view === 'verify') await viewPatient(root);
  } catch (e) {
    if (!state.token) return; // we were just signed out
    root.innerHTML = `<div class="empty-state">Could not load this view. Is the backend running at ${esc(API)}?<br><span class="hash">${esc(e.message)}</span></div>`;
  }
  refreshChainPill();
}

// ------------------------------------------------------------------ Manufacturer
async function viewManufacturer(root) {
  const actorId = state.user.stakeholder_id;
  const [medicines, allStakeholders] = await Promise.all([
    api('/medicines'),
    api('/stakeholders'),
  ]);
  const downstream = allStakeholders.filter((s) => ['distributor', 'wholesaler', 'pharmacy'].includes(s.role));

  root.innerHTML = `
    <div class="grid-2">
      <div class="panel">
        <h2>Register a new batch</h2>
        <p class="hint">Each unit in the batch receives its own serial number, QR code, and genesis blockchain record.</p>
        <form id="batch-form">
          <div class="field"><label>Medicine name</label><input name="medicine_name" required placeholder="e.g. Amoxiclav 625" /></div>
          <div class="field-row">
            <div class="field"><label>Manufacturing date</label><input type="date" name="manufacturing_date" required /></div>
            <div class="field"><label>Expiry date</label><input type="date" name="expiry_date" required /></div>
          </div>
          <div class="field"><label>Quantity of units</label><input type="number" name="quantity" min="1" max="25" value="5" required /></div>
          <div class="checkbox-row"><input type="checkbox" id="cold" name="requires_cold_chain" /> <label for="cold">Requires cold-chain (temperature-sensitive)</label></div>
          <div class="field-row" id="cold-fields" style="display:none">
            <div class="field"><label>Min temp (°C)</label><input type="number" step="0.1" name="temp_min" value="2" /></div>
            <div class="field"><label>Max temp (°C)</label><input type="number" step="0.1" name="temp_max" value="8" /></div>
          </div>
          <button class="btn" type="submit">Register batch</button>
        </form>
      </div>
      <div class="panel">
        <h2>Units you manufactured</h2>
        <p class="hint">${medicines.length} unit(s) currently on record.</p>
        <div class="card-list" id="med-list">${renderMedList(medicines)}</div>
      </div>
    </div>

    <div class="panel" style="margin-top:22px">
      <h2>Ship a unit to the supply chain</h2>
      <p class="hint">Sends a manufactured unit onward to a distributor, wholesaler, or pharmacy — the first block in that unit's onward journey.</p>
      <form id="ship-form">
        <div class="field-row">
          <div class="field">
            <label>Medicine (serial number)</label>
            <select name="medicine_id">${medicines.filter((m) => m.status === 'registered').map((m) => `<option value="${m.id}">${esc(m.serial_number)} — ${esc(m.medicine_name)}</option>`).join('') || '<option disabled>No unshipped units</option>'}</select>
          </div>
          <div class="field">
            <label>Ship to</label>
            <select name="to_id">${downstream.map((s) => `<option value="${s.id}">${esc(s.name)} — ${esc(s.role)}${s.is_authorized ? '' : ' ⚠ UNAUTHORIZED'}</option>`).join('') || '<option disabled>No distributors registered</option>'}</select>
          </div>
        </div>
        <div class="field"><label>Note (optional)</label><input name="note" placeholder="e.g. bulk shipment to regional distributor" /></div>
        <button class="btn" type="submit" ${esc(medicines.some((m) => m.status === 'registered') ? '' : 'disabled')}>Ship unit</button>
      </form>
      <div id="ship-result"></div>
    </div>
  `;

  root.querySelector('#cold').onchange = (e) => {
    root.querySelector('#cold-fields').style.display = e.target.checked ? 'grid' : 'none';
  };

  root.querySelector('#batch-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      medicine_name: fd.get('medicine_name'),
      manufacturing_date: fd.get('manufacturing_date'),
      expiry_date: fd.get('expiry_date'),
      quantity: fd.get('quantity'),
      requires_cold_chain: fd.get('requires_cold_chain') === 'on',
      temp_min: fd.get('temp_min') ? Number(fd.get('temp_min')) : null,
      temp_max: fd.get('temp_max') ? Number(fd.get('temp_max')) : null,
    };
    try {
      const result = await api('/batches', { method: 'POST', body: JSON.stringify(body) });
      toast(`Batch registered: ${result.count} units minted to the ledger.`);
      renderView();
    } catch (err) {
      toast(err.message, true);
    }
  };

  const shipForm = root.querySelector('#ship-form');
  if (shipForm) {
    shipForm.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const result = await api('/transfer', {
          method: 'POST',
          body: JSON.stringify({
            medicine_id: fd.get('medicine_id'),
            to_id: fd.get('to_id'),
            actor_note: fd.get('note'),
          }),
        });
        const flagsHtml = result.flags.length
          ? result.flags.map((f) => `<div class="alert-box ${f.severity === 'medium' ? 'medium' : ''}"><span class="a-type">${esc(f.type)}</span>${esc(f.description)}</div>`).join('')
          : '<div class="hint">No anomalies detected on this shipment.</div>';
        document.getElementById('ship-result').innerHTML = `<div style="margin-top:14px">${flagsHtml}</div>`;
        toast('Unit shipped and committed to the ledger.');
        renderView();
      } catch (err) {
        document.getElementById('ship-result').innerHTML = `<div class="alert-box" style="margin-top:14px"><span class="a-type">SHIPMENT REJECTED</span>${esc(err.message)}</div>`;
        toast('Smart contract rejected this shipment.', true);
      }
    };
  }

  bindMedCardClicks(root);
}

function renderMedList(medicines) {
  if (!medicines.length) return `<div class="empty-state">No units yet — register a batch to get started.</div>`;
  return medicines
    .map(
      (m) => `
    <div class="med-card" data-id="${m.id}" style="cursor:pointer">
      <div>
        <div class="name">${esc(m.medicine_name)}</div>
        <div class="serial">${esc(m.serial_number)}</div>
        <div class="meta">Expires ${esc(m.expiry_date)} · status: ${esc(m.status)}</div>
      </div>
      ${badge(m.classification)}
    </div>`
    )
    .join('');
}

function bindMedCardClicks(root) {
  root.querySelectorAll('.med-card[data-id]').forEach((el) => {
    el.onclick = () => openMedicineDetail(el.dataset.id);
  });
}

async function openMedicineDetail(id) {
  const [med, qr, timeline] = await Promise.all([
    api(`/medicines/${id}`),
    api(`/medicines/${id}/qrcode`),
    api(`/medicines/${id}/timeline`),
  ]);
  const root = document.getElementById('view-root');
  const back = `<button class="btn secondary" id="back-btn">← Back</button>`;
  root.innerHTML = `
    ${back}
    <div class="grid-2" style="margin-top:18px">
      <div class="panel">
        <h2>${esc(med.medicine_name)}</h2>
        <p class="hint">${esc(med.serial_number)}</p>
        <div class="verify-result">
          <div class="qr-wrap"><img src="${qr.dataUrl}" width="180" height="180" /></div>
          ${badge(med.classification)}
          <div class="verify-score">trust score ${med.trust_score} / 100</div>
        </div>
        <div class="field" style="margin-top:14px">
          <label>Manufactured</label>
          <div>${esc(med.manufacturing_date)} → expires ${esc(med.expiry_date)}</div>
        </div>
      </div>
      <div class="panel">
        <h2>Supply-chain timeline</h2>
        <div class="timeline">
          ${timeline.transfers
            .map(
              (t) => `<div class="timeline-item ${t.flagged ? 'flagged' : ''}">
                <div class="t-role">${esc(t.from ? t.from.name : 'Manufacturer')} → ${esc(t.to.name)}</div>
                <div class="t-meta">block #${t.block_index} · ${fmtDate(t.timestamp)}</div>
                ${t.flagged ? '<div class="t-note">⚠ flagged by anomaly detection</div>' : ''}
              </div>`
            )
            .join('') || '<div class="muted">No transfers recorded yet.</div>'}
        </div>
      </div>
    </div>
  `;
  root.querySelector('#back-btn').onclick = renderView;
}

// ------------------------------------------------------------------ Supply chain
async function viewSupplyChain(root) {
  const actorId = state.user.stakeholder_id;
  const [held, stakeholders] = await Promise.all([
    api('/medicines'),
    api('/stakeholders'),
  ]);

  root.innerHTML = `
    <div class="grid-2">
      <div class="panel">
        <h2>Units in your custody</h2>
        <p class="hint">${held.length} unit(s) currently held. Select one to transfer it onward.</p>
        <div class="card-list" id="held-list">${renderMedList(held)}</div>
      </div>
      <div class="panel">
        <h2>Transfer custody</h2>
        <p class="hint">The smart-contract layer validates the recipient and current owner before committing the transfer to the chain.</p>
        <form id="transfer-form">
          <div class="field">
            <label>Medicine (serial number)</label>
            <select name="medicine_id">${held.map((m) => `<option value="${m.id}">${esc(m.serial_number)} — ${esc(m.medicine_name)}</option>`).join('') || '<option disabled>No units held</option>'}</select>
          </div>
          <div class="field">
            <label>Transfer to</label>
            <select name="to_id">${stakeholders
              .filter((s) => s.id !== actorId && s.role !== 'regulator')
              .map((s) => `<option value="${s.id}">${esc(s.name)} — ${esc(s.role)}${s.is_authorized ? '' : ' ⚠ UNAUTHORIZED'}</option>`)
              .join('')}</select>
          </div>
          <div class="field"><label>Note (optional)</label><input name="note" placeholder="e.g. cold-chain shipment to regional hub" /></div>
          <button class="btn" type="submit" ${held.length ? '' : 'disabled'}>Transfer</button>
        </form>
        <div id="transfer-result"></div>
      </div>
    </div>
    <div class="panel" style="margin-top:22px">
      <h2>Log a temperature reading</h2>
      <p class="hint">For cold-chain batches, out-of-range readings are automatically flagged and reduce the trust score.</p>
      <form id="temp-form">
        <div class="field-row">
          <div class="field">
            <label>Medicine</label>
            <select name="medicine_id">${held.map((m) => `<option value="${m.id}">${esc(m.serial_number)} — ${esc(m.medicine_name)}</option>`).join('') || '<option disabled>No units held</option>'}</select>
          </div>
          <div class="field"><label>Temperature (°C)</label><input type="number" step="0.1" name="temperature" value="5" /></div>
        </div>
        <button class="btn secondary" type="submit" ${held.length ? '' : 'disabled'}>Log reading</button>
      </form>
    </div>
  `;

  root.querySelector('#transfer-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const result = await api('/transfer', {
        method: 'POST',
        body: JSON.stringify({
          medicine_id: fd.get('medicine_id'),
          to_id: fd.get('to_id'),
          actor_note: fd.get('note'),
        }),
      });
      const flagsHtml = result.flags.length
        ? result.flags.map((f) => `<div class="alert-box ${f.severity === 'critical' || f.severity === 'high' ? '' : 'medium'}"><span class="a-type">${esc(f.type)}</span>${esc(f.description)}</div>`).join('')
        : '<div class="hint">No anomalies detected on this transfer.</div>';
      document.getElementById('transfer-result').innerHTML = `<div style="margin-top:14px">${flagsHtml}</div>`;
      toast('Transfer committed to the ledger.');
      renderView();
    } catch (err) {
      const flagsHtml = (err.data?.flags || []).map((f) => `<div class="alert-box"><span class="a-type">${esc(f.type)}</span>${esc(f.description)}</div>`).join('');
      document.getElementById('transfer-result').innerHTML = `<div class="alert-box" style="margin-top:14px"><span class="a-type">TRANSFER REJECTED</span>${esc(err.message)}</div>${flagsHtml}`;
      toast('Smart contract rejected this transfer.', true);
    }
  };

  const tempForm = root.querySelector('#temp-form');
  if (tempForm) {
    tempForm.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const result = await api('/temperature', {
          method: 'POST',
          body: JSON.stringify({ medicine_id: fd.get('medicine_id'), temperature: Number(fd.get('temperature')) }),
        });
        toast(result.violation ? 'Temperature violation logged and flagged.' : 'Temperature reading logged — within range.', result.violation);
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  bindMedCardClicks(root);
}

// ------------------------------------------------------------------ Regulator
async function viewRegulator(root) {
  const [overview, anomalies, stakeholders] = await Promise.all([
    api('/regulator/overview'),
    api('/regulator/anomalies'),
    api('/stakeholders'),
  ]);
  const partners = stakeholders.filter((s) => s.role !== 'patient');
  const patientCount = stakeholders.length - partners.length;

  const totalsByClass = Object.fromEntries(overview.byClass.map((c) => [c.classification, c.c]));

  root.innerHTML = `
    <div class="stat-row">
      <div class="stat-box"><div class="num">${overview.totals}</div><div class="label">total units tracked</div></div>
      <div class="stat-box"><div class="num" style="color:var(--teal)">${totalsByClass['Authentic/Safe'] || 0}</div><div class="label">authentic / safe</div></div>
      <div class="stat-box"><div class="num" style="color:var(--amber)">${totalsByClass['Suspicious'] || 0}</div><div class="label">suspicious</div></div>
      <div class="stat-box"><div class="num" style="color:var(--brick)">${totalsByClass['Potentially Counterfeit'] || 0}</div><div class="label">potentially counterfeit</div></div>
    </div>

    <div class="panel" style="margin-bottom:22px">
      <h2>Blockchain integrity</h2>
      <p class="hint">${overview.chainLength} blocks recorded. Every block's hash is re-verified against its neighbors on every request.</p>
      <span class="badge ${overview.chainIntegrity.valid ? 'safe' : 'counterfeit'}">${overview.chainIntegrity.valid ? 'Chain intact — no tampering detected' : 'Chain integrity FAILED at block ' + overview.chainIntegrity.brokenAt}</span>
    </div>

    <div class="panel">
      <h2>Anomaly &amp; alert log</h2>
      <p class="hint">Rule-based flags raised across the network, most recent first. Click a unit to investigate its full timeline.</p>
      <div class="card-list" id="anomaly-list">
        ${
          anomalies.length
            ? anomalies
                .slice(0, 40)
                .map(
                  (a) => `<div class="alert-box ${a.severity === 'medium' ? 'medium' : ''}" data-id="${a.medicine_id}" style="cursor:pointer">
                    <span class="a-type">${esc(a.type)} · ${esc(a.medicine_name)} · ${esc(a.serial_number)}</span>
                    ${esc(a.description)}
                    <div class="t-meta" style="margin-top:4px">${fmtDate(a.timestamp)}</div>
                  </div>`
                )
                .join('')
            : '<div class="empty-state">No anomalies recorded yet.</div>'
        }
      </div>
    </div>

    <div class="grid-2" style="margin-top:22px">
      <div class="panel">
        <h2>Network participants</h2>
        <p class="hint">Suspending a participant signs them out immediately, blocks their login, and makes any transfer to them fail the smart-contract authorization check. ${patientCount} registered patient(s) not listed.</p>
        <div class="card-list">
          ${partners
            .map(
              (s) => `<div class="med-card">
                <div>
                  <div class="name">${esc(s.name)}</div>
                  <div class="meta">${esc(s.role)}${s.location ? ' · ' + esc(s.location) : ''}</div>
                </div>
                <div style="display:flex;gap:10px;align-items:center">
                  <span class="badge ${s.is_authorized ? 'safe' : 'counterfeit'}">${s.is_authorized ? 'Authorized' : 'Suspended'}</span>
                  <button class="btn secondary" data-toggle="${s.id}" data-next="${s.is_authorized ? 'false' : 'true'}" ${s.id === state.user.stakeholder_id ? 'disabled title="You cannot change your own access"' : ''}>${s.is_authorized ? 'Suspend' : 'Reinstate'}</button>
                </div>
              </div>`
            )
            .join('')}
        </div>
      </div>
      <div class="panel">
        <h2>Onboard a participant</h2>
        <p class="hint">Creates the stakeholder on the network and issues their login. Share the temporary password through a secure channel.</p>
        <form id="onboard-form" autocomplete="off">
          <div class="field"><label>Organization name</label><input name="name" maxlength="80" required /></div>
          <div class="field-row">
            <div class="field"><label>Role</label>
              <select name="role">
                <option value="manufacturer">Manufacturer</option>
                <option value="distributor">Distributor</option>
                <option value="wholesaler">Wholesaler</option>
                <option value="pharmacy">Pharmacy</option>
                <option value="regulator">Regulator</option>
              </select>
            </div>
            <div class="field"><label>Location</label><input name="location" maxlength="80" /></div>
          </div>
          <div class="field-row">
            <div class="field"><label>Username</label><input name="username" minlength="3" maxlength="32" pattern="[A-Za-z0-9._\\-]+" title="Letters, digits, . _ -" required /></div>
            <div class="field"><label>Temporary password</label><input name="password" type="password" minlength="8" autocomplete="new-password" required /></div>
          </div>
          <button class="btn" type="submit">Create participant</button>
        </form>
      </div>
    </div>
  `;

  root.querySelectorAll('#anomaly-list [data-id]').forEach((el) => {
    el.onclick = () => openMedicineDetail(el.dataset.id);
  });

  root.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api(`/stakeholders/${btn.dataset.toggle}/authorize`, {
          method: 'PATCH',
          body: JSON.stringify({ is_authorized: btn.dataset.next === 'true' }),
        });
        toast(btn.dataset.next === 'true' ? 'Participant reinstated.' : 'Participant suspended.');
        renderView();
      } catch (err) {
        toast(err.message, true);
      }
    };
  });

  root.querySelector('#onboard-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/stakeholders', {
        method: 'POST',
        body: JSON.stringify({
          name: fd.get('name').trim(),
          role: fd.get('role'),
          location: fd.get('location').trim(),
          username: fd.get('username').trim(),
          password: fd.get('password'),
        }),
      });
      toast('Participant created — they can sign in now.');
      renderView();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// ------------------------------------------------------------------ Patient / Scan
async function viewPatient(root) {
  root.innerHTML = `
    <div class="grid-2">
      <div class="panel">
        <h2>Verify a medicine</h2>
        <p class="hint">Enter the serial number printed under the QR code (or scan it in a real deployment) to check its authenticity.</p>
        <form id="scan-form">
          <div class="field"><label>Serial number</label><input name="serial_number" placeholder="e.g. MED-XXXXXXX-XXXX" required /></div>
          <div class="field"><label>Your location (optional, for anomaly detection)</label><input name="scan_location" placeholder="e.g. Vellore, IN" /></div>
          <button class="btn" type="submit">Verify</button>
        </form>
        <p class="hint" style="margin-top:14px">Try the demo serials from <code>seed.js</code> console output — including the deliberately cloned and suspicious ones.</p>
      </div>
      <div class="panel" id="scan-result">
        <h2>Result</h2>
        <div class="empty-state">Scan or enter a serial number to see its authenticity report.</div>
      </div>
    </div>
  `;

  root.querySelector('#scan-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const result = await api('/scan', {
        method: 'POST',
        body: JSON.stringify({
          serial_number: fd.get('serial_number').trim(),
          scan_location: fd.get('scan_location') || undefined,
        }),
      });
      renderScanResult(result);
    } catch (err) {
      toast(err.message, true);
    }
  };
}

function renderScanResult(result) {
  const box = document.getElementById('scan-result');
  if (!result.found) {
    box.innerHTML = `<h2>Result</h2><div class="alert-box"><span class="a-type">NOT FOUND</span>${esc(result.message)}</div>`;
    return;
  }
  const med = result.medicine;
  const flagsHtml = result.newFlags.length
    ? result.newFlags.map((f) => `<div class="alert-box ${f.severity === 'medium' ? 'medium' : ''}"><span class="a-type">${esc(f.type)}</span>${esc(f.description)}</div>`).join('')
    : '';

  box.innerHTML = `
    <h2>Result</h2>
    <div class="verify-result">
      <div class="verify-headline">${esc(med.medicine_name)}</div>
      ${badge(med.classification)}
      <div class="verify-score">trust score ${med.trust_score} / 100</div>
      <div class="score-track" style="margin:10px auto"><div class="score-fill ${scoreClass(med.classification)}" style="width:${med.trust_score}%"></div></div>
    </div>
    <div class="field"><label>Manufacturer</label><div>${esc(result.manufacturer?.name || 'Unknown')}</div></div>
    <div class="field"><label>Current custody</label><div>${esc(result.currentOwner?.name || 'Unknown')} (${esc(result.currentOwner?.role || '—')})</div></div>
    <div class="field"><label>Expiry</label><div>${esc(med.expiry_date)}</div></div>
    ${flagsHtml}
    <div class="field">
      <label>Chain of custody</label>
      <div class="timeline">
        ${result.transfers
          .map(
            (t) => `<div class="timeline-item ${t.flagged ? 'flagged' : ''}">
              <div class="t-meta">block #${t.block_index} · ${fmtDate(t.timestamp)}</div>
            </div>`
          )
          .join('') || '<div class="muted">No transfers recorded.</div>'}
      </div>
    </div>
    <div class="field">
      <label>Blockchain integrity</label>
      <span class="badge ${result.chainIntegrity.valid ? 'safe' : 'counterfeit'}">${result.chainIntegrity.valid ? 'Verified — untampered' : 'Integrity check failed'}</span>
    </div>
  `;
}

// ------------------------------------------------------------------ boot
async function boot() {
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (saved) {
    try {
      state.token = JSON.parse(saved).token;
      state.user = (await api('/auth/me')).user;
      return enterApp();
    } catch {
      clearSession();
    }
  }
  showLogin();
}
boot();
setInterval(() => { if (state.token) refreshChainPill(); }, 15000);
