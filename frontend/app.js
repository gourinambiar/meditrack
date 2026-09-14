const API = 'http://localhost:4000/api';

const ROLES = [
  { key: 'manufacturer', label: 'Manufacturer', sub: 'Register batches and issue serialized, QR-verifiable medicine units.' },
  { key: 'supplychain', label: 'Distributor / Wholesaler / Pharmacy', sub: 'Receive stock and transfer custody forward through the chain.' },
  { key: 'regulator', label: 'Regulator', sub: 'Monitor the network, review flagged activity, and audit the ledger.' },
  { key: 'patient', label: 'Patient — Scan & Verify', sub: 'Scan a QR code or enter a serial number to check authenticity.' },
];

const state = {
  role: 'manufacturer',
  actorsByRole: {},
  actorId: {},
};

// ------------------------------------------------------------------ utils
async function api(path, opts) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
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
  return `<span class="badge ${scoreClass(classification)}">${classification}</span>`;
}

// ------------------------------------------------------------------ nav
function renderNav() {
  const nav = document.getElementById('role-nav');
  nav.innerHTML = '';
  ROLES.forEach((r) => {
    const btn = document.createElement('button');
    btn.className = 'rail-btn' + (state.role === r.key ? ' active' : '');
    btn.innerHTML = `<span class="dot"></span>${r.label}`;
    btn.onclick = async () => {
      state.role = r.key;
      renderNav();
      await renderHeader();
      renderView();
    };
    nav.appendChild(btn);
  });
  refreshChainPill();
}

async function renderHeader() {
  const r = ROLES.find((x) => x.key === state.role);
  document.getElementById('view-title').textContent = r.label;
  document.getElementById('view-sub').textContent = r.sub;
  await renderActorSelect();
}

async function refreshChainPill() {
  try {
    const h = await api('/health');
    document.getElementById('chain-pill').textContent = `chain: ${h.chainLength} blocks`;
  } catch {
    document.getElementById('chain-pill').textContent = 'chain: offline';
  }
}

// ------------------------------------------------------------------ actor selector
async function loadActors(roleFilter) {
  if (state.actorsByRole[roleFilter]) return state.actorsByRole[roleFilter];
  const list = await api(`/stakeholders?role=${roleFilter}`);
  state.actorsByRole[roleFilter] = list;
  return list;
}

async function renderActorSelect() {
  const box = document.getElementById('actor-select');
  box.innerHTML = '';
  if (state.role === 'manufacturer') {
    const list = await loadActors('manufacturer');
    box.innerHTML = actorPicker('manufacturer', list, 'Acting as manufacturer');
  } else if (state.role === 'supplychain') {
    const [d, w, p] = await Promise.all([
      loadActors('distributor'),
      loadActors('wholesaler'),
      loadActors('pharmacy'),
    ]);
    const all = [...d, ...w, ...p];
    box.innerHTML = actorPicker('supplychain', all, 'Acting as');
  } else if (state.role === 'patient') {
    const list = await loadActors('patient');
    box.innerHTML = actorPicker('patient', list, 'Scanning as');
  } else {
    return;
  }
  const sel = box.querySelector('select');
  if (sel) {
    state.actorId[state.role] = sel.value;
    sel.onchange = () => {
      state.actorId[state.role] = sel.value;
      renderView();
    };
  }
}

function actorPicker(key, list, labelText) {
  if (!list.length) return `<div class="muted">No stakeholders of this type registered yet.</div>`;
  const current = state.actorId[key] || list[0].id;
  state.actorId[key] = current;
  return `<label>${labelText}</label>
    <select>${list.map((s) => `<option value="${s.id}" ${s.id === current ? 'selected' : ''}>${s.name} — ${s.role}${s.is_authorized ? '' : ' (UNAUTHORIZED)'}</option>`).join('')}</select>`;
}

// ------------------------------------------------------------------ view dispatch
async function renderView() {
  const root = document.getElementById('view-root');
  root.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    if (state.role === 'manufacturer') await viewManufacturer(root);
    else if (state.role === 'supplychain') await viewSupplyChain(root);
    else if (state.role === 'regulator') await viewRegulator(root);
    else if (state.role === 'patient') await viewPatient(root);
  } catch (e) {
    root.innerHTML = `<div class="empty-state">Could not load this view. Is the backend running at ${API}?<br><span class="hash">${e.message}</span></div>`;
  }
  refreshChainPill();
}

// ------------------------------------------------------------------ Manufacturer
async function viewManufacturer(root) {
  const actorId = state.actorId.manufacturer;
  const [medicines, allStakeholders] = await Promise.all([
    actorId ? api(`/medicines?owner_id=${actorId}`) : [],
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
            <select name="medicine_id">${medicines.filter((m) => m.status === 'registered').map((m) => `<option value="${m.id}">${m.serial_number} — ${m.medicine_name}</option>`).join('') || '<option disabled>No unshipped units</option>'}</select>
          </div>
          <div class="field">
            <label>Ship to</label>
            <select name="to_id">${downstream.map((s) => `<option value="${s.id}">${s.name} — ${s.role}${s.is_authorized ? '' : ' ⚠ UNAUTHORIZED'}</option>`).join('') || '<option disabled>No distributors registered</option>'}</select>
          </div>
        </div>
        <div class="field"><label>Note (optional)</label><input name="note" placeholder="e.g. bulk shipment to regional distributor" /></div>
        <button class="btn" type="submit" ${medicines.some((m) => m.status === 'registered') ? '' : 'disabled'}>Ship unit</button>
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
      manufacturer_id: actorId,
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
            from_id: actorId,
            to_id: fd.get('to_id'),
            actor_note: fd.get('note'),
          }),
        });
        const flagsHtml = result.flags.length
          ? result.flags.map((f) => `<div class="alert-box ${f.severity === 'medium' ? 'medium' : ''}"><span class="a-type">${f.type}</span>${f.description}</div>`).join('')
          : '<div class="hint">No anomalies detected on this shipment.</div>';
        document.getElementById('ship-result').innerHTML = `<div style="margin-top:14px">${flagsHtml}</div>`;
        toast('Unit shipped and committed to the ledger.');
        renderView();
      } catch (err) {
        document.getElementById('ship-result').innerHTML = `<div class="alert-box" style="margin-top:14px"><span class="a-type">SHIPMENT REJECTED</span>${err.message}</div>`;
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
        <div class="name">${m.medicine_name}</div>
        <div class="serial">${m.serial_number}</div>
        <div class="meta">Expires ${m.expiry_date} · status: ${m.status}</div>
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
        <h2>${med.medicine_name}</h2>
        <p class="hint">${med.serial_number}</p>
        <div class="verify-result">
          <div class="qr-wrap"><img src="${qr.dataUrl}" width="180" height="180" /></div>
          ${badge(med.classification)}
          <div class="verify-score">trust score ${med.trust_score} / 100</div>
        </div>
        <div class="field" style="margin-top:14px">
          <label>Manufactured</label>
          <div>${med.manufacturing_date} → expires ${med.expiry_date}</div>
        </div>
      </div>
      <div class="panel">
        <h2>Supply-chain timeline</h2>
        <div class="timeline">
          ${timeline.transfers
            .map(
              (t) => `<div class="timeline-item ${t.flagged ? 'flagged' : ''}">
                <div class="t-role">${t.from ? t.from.name : 'Manufacturer'} → ${t.to.name}</div>
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
  const actorId = state.actorId.supplychain;
  const [held, stakeholders] = await Promise.all([
    actorId ? api(`/medicines?owner_id=${actorId}`) : [],
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
            <select name="medicine_id">${held.map((m) => `<option value="${m.id}">${m.serial_number} — ${m.medicine_name}</option>`).join('') || '<option disabled>No units held</option>'}</select>
          </div>
          <div class="field">
            <label>Transfer to</label>
            <select name="to_id">${stakeholders
              .filter((s) => s.id !== actorId)
              .map((s) => `<option value="${s.id}">${s.name} — ${s.role}${s.is_authorized ? '' : ' ⚠ UNAUTHORIZED'}</option>`)
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
            <select name="medicine_id">${held.map((m) => `<option value="${m.id}">${m.serial_number} — ${m.medicine_name}</option>`).join('') || '<option disabled>No units held</option>'}</select>
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
          from_id: actorId,
          to_id: fd.get('to_id'),
          actor_note: fd.get('note'),
        }),
      });
      const flagsHtml = result.flags.length
        ? result.flags.map((f) => `<div class="alert-box ${f.severity === 'critical' || f.severity === 'high' ? '' : 'medium'}"><span class="a-type">${f.type}</span>${f.description}</div>`).join('')
        : '<div class="hint">No anomalies detected on this transfer.</div>';
      document.getElementById('transfer-result').innerHTML = `<div style="margin-top:14px">${flagsHtml}</div>`;
      toast('Transfer committed to the ledger.');
      renderView();
    } catch (err) {
      const flagsHtml = (err.data?.flags || []).map((f) => `<div class="alert-box"><span class="a-type">${f.type}</span>${f.description}</div>`).join('');
      document.getElementById('transfer-result').innerHTML = `<div class="alert-box" style="margin-top:14px"><span class="a-type">TRANSFER REJECTED</span>${err.message}</div>${flagsHtml}`;
      toast('Smart contract rejected this transfer.', true);
    }
  };

  const tempForm = root.querySelector('#temp-form');
  if (tempForm) {
    tempForm.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const result = await api('/temperature', {
        method: 'POST',
        body: JSON.stringify({ medicine_id: fd.get('medicine_id'), temperature: Number(fd.get('temperature')) }),
      });
      toast(result.violation ? 'Temperature violation logged and flagged.' : 'Temperature reading logged — within range.', result.violation);
    };
  }

  bindMedCardClicks(root);
}

// ------------------------------------------------------------------ Regulator
async function viewRegulator(root) {
  const overview = await api('/regulator/overview');
  const anomalies = await api('/regulator/anomalies');

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
                    <span class="a-type">${a.type} · ${a.medicine_name} · ${a.serial_number}</span>
                    ${a.description}
                    <div class="t-meta" style="margin-top:4px">${fmtDate(a.timestamp)}</div>
                  </div>`
                )
                .join('')
            : '<div class="empty-state">No anomalies recorded yet.</div>'
        }
      </div>
    </div>
  `;

  root.querySelectorAll('#anomaly-list [data-id]').forEach((el) => {
    el.onclick = () => openMedicineDetail(el.dataset.id);
  });
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
    const actorId = state.actorId.patient;
    const result = await api('/scan', {
      method: 'POST',
      body: JSON.stringify({
        serial_number: fd.get('serial_number').trim(),
        scanned_by: actorId,
        scan_location: fd.get('scan_location') || undefined,
      }),
    });
    renderScanResult(result);
  };
}

function renderScanResult(result) {
  const box = document.getElementById('scan-result');
  if (!result.found) {
    box.innerHTML = `<h2>Result</h2><div class="alert-box"><span class="a-type">NOT FOUND</span>${result.message}</div>`;
    return;
  }
  const med = result.medicine;
  const flagsHtml = result.newFlags.length
    ? result.newFlags.map((f) => `<div class="alert-box ${f.severity === 'medium' ? 'medium' : ''}"><span class="a-type">${f.type}</span>${f.description}</div>`).join('')
    : '';

  box.innerHTML = `
    <h2>Result</h2>
    <div class="verify-result">
      <div class="verify-headline">${med.medicine_name}</div>
      ${badge(med.classification)}
      <div class="verify-score">trust score ${med.trust_score} / 100</div>
      <div class="score-track" style="margin:10px auto"><div class="score-fill ${scoreClass(med.classification)}" style="width:${med.trust_score}%"></div></div>
    </div>
    <div class="field"><label>Manufacturer</label><div>${result.manufacturer?.name || 'Unknown'}</div></div>
    <div class="field"><label>Current custody</label><div>${result.currentOwner?.name || 'Unknown'} (${result.currentOwner?.role || '—'})</div></div>
    <div class="field"><label>Expiry</label><div>${med.expiry_date}</div></div>
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
  renderNav();
  await renderHeader();
  renderView();
}
boot();
setInterval(refreshChainPill, 15000);
