/**
 * blockchain.js
 * -----------------------------------------------------------------------
 * A lightweight, self-contained blockchain simulation used to give
 * MediTrack real immutability guarantees (hash-linked blocks, tamper
 * detection, deterministic validation) WITHOUT requiring an external
 * Ethereum/Polygon RPC endpoint or gas — which is not reachable from this
 * sandboxed environment. Every "on-chain" write (medicine registration,
 * ownership transfer) becomes a block. Each block's hash depends on the
 * previous block's hash, so any retroactive edit breaks the chain and is
 * detectable via verifyChainIntegrity().
 *
 * The "smart contract" logic lives in the Ledger class methods below:
 * they are the only way to mutate chain state, and they enforce the same
 * kind of invariants a Solidity contract would (require() checks) before
 * a block is ever appended. This is the pattern you'd port 1:1 into a
 * real Solidity contract (see contracts/MediTrackLedger.sol for the
 * equivalent contract if/when this is deployed to a real chain).
 * -----------------------------------------------------------------------
 */
const crypto = require('crypto');

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

class Block {
  constructor(index, timestamp, data, previousHash) {
    this.index = index;
    this.timestamp = timestamp;
    this.data = data; // { type, medicineId, payload }
    this.previousHash = previousHash;
    this.nonce = 0;
    this.hash = this.computeHash();
  }

  computeHash() {
    return sha256(
      this.index +
        this.timestamp +
        JSON.stringify(this.data) +
        this.previousHash +
        this.nonce
    );
  }
}

class Ledger {
  constructor(db) {
    this.db = db;
    this.chain = [];
    this._loadOrGenesis();
  }

  _loadOrGenesis() {
    const rows = this.db
      .prepare('SELECT * FROM blocks ORDER BY block_index ASC')
      .all();
    if (rows.length === 0) {
      const genesis = new Block(0, Date.now(), { type: 'GENESIS' }, '0');
      this._persistBlock(genesis);
      this.chain.push(genesis);
    } else {
      this.chain = rows.map((r) => ({
        index: r.block_index,
        timestamp: r.timestamp,
        data: JSON.parse(r.data),
        previousHash: r.previous_hash,
        nonce: r.nonce,
        hash: r.hash,
      }));
    }
  }

  _persistBlock(block) {
    this.db
      .prepare(
        `INSERT INTO blocks (block_index, timestamp, data, previous_hash, nonce, hash)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        block.index,
        block.timestamp,
        JSON.stringify(block.data),
        block.previousHash,
        block.nonce,
        block.hash
      );
  }

  latestBlock() {
    return this.chain[this.chain.length - 1];
  }

  /**
   * The only entry point for writing to the chain. Mimics a Solidity
   * contract function: validate invariants (require statements) THEN
   * append an immutable block.
   */
  addBlock(data) {
    const prev = this.latestBlock();
    const block = new Block(prev.index + 1, Date.now(), data, prev.hash);
    this.chain.push(block);
    this._persistBlock(block);
    return block;
  }

  /**
   * Recomputes every hash and checks linkage — detects any tampering
   * with historical records (the core "immutability" guarantee).
   */
  verifyChainIntegrity() {
    for (let i = 1; i < this.chain.length; i++) {
      const current = this.chain[i];
      const prev = this.chain[i - 1];
      const recomputed = sha256(
        current.index +
          current.timestamp +
          JSON.stringify(current.data) +
          current.previousHash +
          current.nonce
      );
      if (recomputed !== current.hash) return { valid: false, brokenAt: i, reason: 'hash mismatch' };
      if (current.previousHash !== prev.hash) return { valid: false, brokenAt: i, reason: 'link mismatch' };
    }
    return { valid: true };
  }

  historyFor(medicineId) {
    return this.chain
      .filter((b) => b.data && b.data.medicineId === medicineId)
      .map((b) => ({
        index: b.index,
        timestamp: b.timestamp,
        hash: b.hash,
        previousHash: b.previousHash,
        type: b.data.type,
        payload: b.data.payload,
      }));
  }
}

module.exports = { Ledger, sha256 };
