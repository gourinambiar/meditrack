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
│   ├── server.js        # Express API — all routes
│   ├── db.js             # SQLite schema
│   ├── blockchain.js     # Hash-chained ledger simulation ("the blockchain")
│   ├── anomaly.js        # Rule-based anomaly detection + trust-score engine
│   ├── seed.js            # Demo data: authentic, cold-chain-violation, cloned-QR, suspicious-transfer
│   └── package.json
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js             # SPA: Manufacturer / Supply Chain / Regulator / Patient dashboards
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

# 2. Seed demo data (stakeholders, batches, medicines, and 4 demo scenarios)
npm run seed
#   This prints demo stakeholder IDs and serial numbers to the console — keep them handy.

# 3. Start the API server (http://localhost:4000)
npm start

# 4. In a second terminal, serve the frontend (any static server works)
cd ../frontend
npx serve -l 5500
#   or: python3 -m http.server 5500

# 5. Open http://localhost:5500 in your browser
```

The frontend talks to the API at `http://localhost:4000` (see `API` constant at the top of
`frontend/app.js` — change it if you deploy the backend elsewhere).

Re-running `npm run seed` wipes and repopulates `meditrack.db` with fresh demo data — safe to do at
any time to reset the demo.

## 4. Demo walkthrough

The seed script prints four serial numbers. Use the **Patient — Scan & Verify** tab to try them:

| Scenario | What it demonstrates |
|---|---|
| `authentic` | Clean unit, full legitimate journey manufacturer → distributor → pharmacy → patient. Trust score 100, **Authentic/Safe**. |
| `coldChainViolation` | Cold-chain medicine with an out-of-range temperature reading logged in transit. Score reduced, still classified but flagged. |
| `clonedCounterfeit` | The deliberate **cloned QR scenario**: the same serial is "scanned" from two locations minutes apart. Scanning it again from a third location in the demo (or re-running the scan form) adds another `DUPLICATE_QR_SCAN` anomaly and drops the score into **Potentially Counterfeit**. |
| `suspiciousTransfer` | The deliberate **suspicious transfer scenario**: the manufacturer transfers directly to an unregistered/unauthorized reseller (skipping distributor/wholesaler), which is then immediately re-transferred — triggering `UNAUTHORIZED_PARTICIPANT`, `SUSPICIOUS_MOVEMENT_PATTERN`, and `RAPID_REPEATED_TRANSFER` flags. |

Other things to try:
- **Manufacturer tab** → register a new batch → click a resulting unit to see its generated QR
  code and empty timeline.
- **Supply Chain tab** → switch the "Acting as" dropdown between distributor/wholesaler/pharmacy,
  hold a unit, and transfer it onward. Try transferring to the seeded **Unverified Reseller Co.** —
  the smart-contract layer rejects it outright (HTTP 403) rather than silently recording it.
  Also try logging an out-of-range temperature reading on a cold-chain batch.
- **Regulator tab** → see network-wide totals by classification, the live blockchain-integrity
  check, and the full anomaly log across all units.

## 5. Anomaly detection rules implemented

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

## 6. What represents the research novelty

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

## 7. Notes on the smart contract layer

`backend/server.js` + `backend/anomaly.js` implement the same invariants a Solidity contract would
enforce with `require()` statements — see `contracts/MediTrackLedger.sol` for the literal EVM
equivalent, intended as the deployment target if this prototype is moved onto a real chain
(Polygon is a reasonable choice for pharma-scale transaction volume and low gas costs).
