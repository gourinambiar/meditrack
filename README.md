# MediTrack — Blockchain-Based Medicine Authenticity & Supply-Chain Anomaly Detection

MediTrack tracks each medicine unit from **manufacturer → distributor → wholesaler → pharmacy → patient**
on a tamper-evident ledger, and layers **QR-based anti-counterfeit verification, rule-based
supply-chain anomaly detection, and an Authenticity/Trust Score** on top of it.

This is a runnable full-stack prototype: a Node/Express + SQLite backend with a hash-chained
ledger (the "blockchain" layer) and smart-contract-style transfer validation, plus a vanilla
JS/HTML frontend with four role-based dashboards.

---

## 1. Project structure

```
meditrack/
├── backend/
│   ├── server.js        # Express API — all routes (every route except /api/health needs a login)
│   ├── auth.js           # Password hashing, JWT sessions, role middleware, login throttling
│   ├── demoUsers.js      # Creates demo logins for existing stakeholders (npm run seed:users)
│   ├── db.js             # SQLite schema
│   ├── blockchain.js     # Hash-chained ledger simulation ("the blockchain")
│   ├── anomaly.js        # Rule-based anomaly detection + trust-score engine
│   ├── seed.js            # Demo data: authentic, cold-chain-violation, cloned-QR, suspicious-transfer
│   ├── tests/auth.test.js # Access-control test suite (npm test)
│   ├── .env.example       # JWT_SECRET etc. — copy to .env
│   └── package.json
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js             # SPA: login screen + role-based Manufacturer / Supply Chain / Regulator / Verify views
├── contracts/
│   └── MediTrackLedger.sol  # Reference Solidity contract for real-chain deployment
└── README.md
```

## 2. Why a simulated ledger instead of a live Ethereum/Polygon deployment?

Real blockchain deployment needs an RPC endpoint (Infura/Alchemy/a local Hardhat node) and gas —
not reachable from a sandboxed build environment with restricted egress. So the working prototype
implements the same guarantees a real chain gives you, directly:

- **Immutability / tamper-evidence** — `backend/blockchain.js` implements a `Ledger` of SHA-256
  hash-linked blocks. Every registration and ownership transfer becomes a block whose hash depends
  on the previous block's hash. `verifyChainIntegrity()` recomputes every hash and flags any break —
  this is exactly what a Merkle/hash-chain gives you on a real chain, minus the distributed consensus.
- **Smart-contract-style validation** — `backend/anomaly.js::evaluateTransfer` and the
  `/api/transfer` route enforce `require()`-style invariants (current-owner match, recipient
  authorization, expiry) **before** a block is appended, exactly mirroring the Solidity contract
  in `contracts/MediTrackLedger.sol`. That `.sol` file is a drop-in reference for deploying the same
  logic to a real EVM chain (e.g. Polygon, for low gas costs at pharma volumes) — porting means
  swapping the ledger implementation the API calls, not redesigning the rules.
- **Off-chain storage** — larger assets (medicine images, batch documents) are conceptually kept
  off the immutable ledger, referenced by hash, the same role IPFS would play in production; the
  prototype stores only the reference pattern since no files are required to demonstrate the flow.

## 3. Setup & running locally

**Requirements:** Node.js 18+.

```bash
# 1. Install backend dependencies
cd meditrack/backend
npm install

# 2. (Recommended) create your config — sets the key used to sign logins
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
#   then put a long random value after JWT_SECRET= (the file shows how to generate one).
#   Skipping this works too, but everyone is signed out whenever the server restarts.

# 3. Seed demo data (stakeholders, batches, medicines, demo logins, and 4 demo scenarios)
npm run seed
#   This prints the demo logins and the demo serial numbers — keep them handy.

# 4. Start the API server (http://localhost:4000)
npm start

# 5. In a second terminal, serve the frontend (any static server works)
cd ../frontend
npx serve -l 5500
#   or: python3 -m http.server 5500

# 6. Open http://localhost:5500 and sign in (see section 4)
```

The frontend talks to the API at `http://localhost:4000` (see `API` constant at the top of
`frontend/app.js` — change it if you deploy the backend elsewhere).

Re-running `npm run seed` wipes and repopulates `meditrack.db` with fresh demo data (including the
logins) — safe to do at any time to reset the demo.

**Upgrading an existing database** (one created before logins existed) **without losing data:** start
the server once (it adds the new `users` table automatically), then run `npm run seed:users`. That
creates a login for every authorized stakeholder that doesn't have one yet and never touches
medicines, transfers or ledger blocks. It is safe to run repeatedly.

**Run the tests:** `npm test` (from `backend/`) runs the access-control suite against a throwaway
database — it never touches your real `meditrack.db`.

## 4. Accounts, login and access control

Every account belongs to exactly one stakeholder on the network, and the **server** decides who you
are from your signed login token — the browser can no longer choose an identity or send someone
else's ID.

**Demo logins** (created by `npm run seed`; password for all: `Meditrack@123`, override with
`DEMO_PASSWORD`). The sign-in screen has one-click chips for these:

| Username | Role | What they can do |
|---|---|---|
| `manufacturer` | Manufacturer | Register batches, ship units onward, view own stock |
| `distributor`, `wholesaler`, `pharmacy` | Supply chain | See units they hold, transfer them onward, log cold-chain readings |
| `regulator` | Regulator | Network overview, anomaly log, ledger audit, onboard/suspend participants |
| `patient` | Patient | Scan & Verify only |

All roles can use **Scan & Verify**. Anyone can create a **patient** account from the sign-up tab;
every other role is onboarded by a regulator (Regulator tab → *Onboard a participant*). *Unverified
Reseller Co.* deliberately has no login — it is the unauthorized party in the suspicious-transfer demo.

What the server enforces:

- **Identity from the token.** `from_id` / `manufacturer_id` / `scanned_by` in request bodies are
  ignored; the sender is always the logged-in stakeholder.
- **Only the current holder can transfer or log temperatures** for a unit — mirroring
  `require(med.currentOwner == msg.sender)` in the Solidity contract. A non-holder attempt is
  rejected (403) without touching the unit's trust score, so nobody can lower a competitor's score
  by spamming attempts.
- **Role gates** on every route (e.g. only manufacturers register batches, only regulators read
  `/api/regulator/*` or onboard/suspend participants).
- **Scoped reads.** Non-regulators only list units they hold and can open a unit's detail/QR/timeline
  only if they manufactured, hold, or previously held it. Everyone else uses Scan & Verify.
- **Suspension takes effect immediately.** Accounts are re-checked on every request, so suspending a
  participant ends their open sessions and any transfer to them fails the authorization check.
  (The old `force` flag that bypassed that check has been removed.)
- **Passwords** are hashed with scrypt + a per-user salt; login errors are generic and equal-cost
  for unknown usernames; 5 failed attempts per username/IP triggers a 15-minute lockout.
- **Output escaping.** Because patients can self-register, every server-supplied string is
  HTML-escaped before it is rendered.

Known limits of this prototype (worth fixing before real use): the login lockout is in-memory (resets
on restart and isn't shared between servers); tokens live in `sessionStorage` (cleared when the tab
closes, but readable by any script on the page — an HttpOnly cookie plus CSRF protection would be
stronger); there is no password reset or change-password flow, no MFA, and no HTTPS (terminate TLS in
front of the API); and the demo password is public by design — turn off `SHOW_DEMO_ACCOUNTS` in
`frontend/app.js` and set a private `DEMO_PASSWORD` for anything beyond a demo.

## 5. Demo walkthrough

The seed script prints four serial numbers. Sign in as `patient` (or any account) and open **Scan & Verify** to try them:

| Scenario | What it demonstrates |
|---|---|
| `authentic` | Clean unit, full legitimate journey manufacturer → distributor → pharmacy → patient. Trust score 100, **Authentic/Safe**. |
| `coldChainViolation` | Cold-chain medicine with an out-of-range temperature reading logged in transit. Score reduced, still classified but flagged. |
| `clonedCounterfeit` | The deliberate **cloned QR scenario**: the same serial is "scanned" from two locations minutes apart. Scanning it again from a third location in the demo (or re-running the scan form) adds another `DUPLICATE_QR_SCAN` anomaly and drops the score into **Potentially Counterfeit**. |
| `suspiciousTransfer` | The deliberate **suspicious transfer scenario**: the manufacturer transfers directly to an unregistered/unauthorized reseller (skipping distributor/wholesaler), which is then immediately re-transferred — triggering `UNAUTHORIZED_PARTICIPANT`, `SUSPICIOUS_MOVEMENT_PATTERN`, and `RAPID_REPEATED_TRANSFER` flags. |

Other things to try:
- Sign in as **`manufacturer`** → register a new batch → click a resulting unit to see its generated
  QR code and timeline → *Ship a unit* to **MedLine Distributors**.
- Sign out, sign in as **`distributor`** → the shipped unit is now in your custody → transfer it onward
  to **CareWell Pharmacy**. Try transferring to **Unverified Reseller Co.** — the smart-contract layer
  rejects it outright (HTTP 403) and logs the attempt. Also try logging an out-of-range temperature
  reading on a cold-chain unit you hold.
- Sign in as **`regulator`** → network-wide totals, the live blockchain-integrity check, the anomaly
  log, and *Network participants* — suspend the distributor, then see their open session end.

## 6. Anomaly detection rules implemented

All in `backend/anomaly.js`, each deducting points from a starting score of 100:

- **Duplicate/cloned QR scan** — same serial scanned from ≥2 different locations within 5 minutes.
- **Unauthorized participant** — transfer recipient is not a registered/authorized stakeholder.
- **Unexpected ownership transfer** — the `from` party in a transfer doesn't match the medicine's
  actual current on-chain owner.
- **Repeated rapid transfers** — ownership changes again within 60 seconds of the previous transfer.
- **Expired medicine** — current date is past the recorded expiry date.
- **Broken chain of custody** — custody moves backward through the pipeline
  (manufacturer → distributor → wholesaler → pharmacy → patient).
- **Suspicious movement pattern** — custody skips expected pipeline stages.
- **Temperature violation** — a logged cold-chain reading falls outside the batch's safe range.

Score → classification: **≥75 Authentic/Safe · 40–74 Suspicious · <40 Potentially Counterfeit**.

## 7. What represents the research novelty

A conventional blockchain medicine-tracking system typically stops at: *put each transfer on an
immutable ledger, let anyone look up the history*. MediTrack's novelty is the layer built on top of
that ledger:

1. **Anomaly detection as a first-class layer, not just a data store.** The blockchain guarantees
   *what was recorded is tamper-proof* — it says nothing about whether the recorded activity is
   itself suspicious. MediTrack's rule engine (`anomaly.js`) interprets the immutable log in real
   time (transfer timing, participant authorization, pipeline ordering, scan geography) to catch
   patterns a plain ledger lookup would miss entirely — e.g. a technically-valid-looking transfer
   chain that is still a counterfeit-distribution pattern.
2. **A single interpretable Authenticity/Trust Score**, rather than forcing every stakeholder to
   read and interpret a raw transaction history themselves. The score is a transparent weighted
   sum (see table in §5) so a pharmacist or patient gets a clear signal without needing to
   understand blockchain internals.
3. **Cloned-QR detection via scan telemetry**, not just serial lookup. A counterfeiter who
   physically copies a legitimate QR code onto fake units produces serials that *do* resolve on the
   ledger — a naive verify-by-lookup system would call these authentic. MediTrack instead
   correlates scan location/timing across all scans of a serial to catch the clone signature.
4. **Smart-contract-enforced supply-chain topology**, not just permissioned writes. Transfers are
   validated against expected pipeline ordering and current-owner match before being committed,
   turning "chain of custody" from a passive record into an actively enforced invariant.
5. **Cold-chain integrity folded into the same trust score** as counterfeit detection, so a unit
   that is provably authentic but was mishandled in transit doesn't get a false "safe" signal.

## 8. Notes on the smart contract layer

`backend/server.js` + `backend/anomaly.js` implement the same invariants a Solidity contract would
enforce with `require()` statements — see `contracts/MediTrackLedger.sol` for the literal EVM
equivalent, intended as the deployment target if this prototype is moved onto a real chain
(Polygon is a reasonable choice for pharma-scale transaction volume and low gas costs).
