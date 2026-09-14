// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * MediTrackLedger
 * -----------------------------------------------------------------------
 * Reference implementation showing how the ownership-transfer logic that
 * this prototype runs as a simulated hash-chained ledger (see
 * backend/blockchain.js) would be expressed as a real Solidity smart
 * contract for deployment on an EVM chain (e.g. Polygon for low gas
 * costs, suited to pharma-supply-chain volumes).
 *
 * This sandbox has no outbound access to a JSON-RPC endpoint, so the
 * working prototype uses a lightweight, tamper-evident hash-chained
 * ledger stored in SQLite instead of a live testnet deployment. The
 * on-chain invariants enforced here are IDENTICAL to the ones enforced
 * in backend/anomaly.js::evaluateTransfer + server.js /api/transfer,
 * so porting the prototype to a real chain is a matter of swapping the
 * ledger implementation, not redesigning the logic.
 * -----------------------------------------------------------------------
 */
contract MediTrackLedger {
    enum Role { None, Manufacturer, Distributor, Wholesaler, Pharmacy, Regulator, Patient }

    struct Stakeholder {
        Role role;
        bool authorized;
        string name;
    }

    struct Medicine {
        bytes32 serialHash;      // keccak256 of the serial number printed on the QR code
        address manufacturer;
        address currentOwner;
        uint64 manufacturingDate;
        uint64 expiryDate;
        bool exists;
    }

    struct TransferRecord {
        address from;
        address to;
        uint64 timestamp;
    }

    address public regulator;
    mapping(address => Stakeholder) public stakeholders;
    mapping(bytes32 => Medicine) public medicines; // key: serialHash
    mapping(bytes32 => TransferRecord[]) public transferHistory;

    event MedicineRegistered(bytes32 indexed serialHash, address indexed manufacturer);
    event OwnershipTransferred(bytes32 indexed serialHash, address indexed from, address indexed to);
    event TransferRejected(bytes32 indexed serialHash, address indexed to, string reason);

    modifier onlyRegulator() {
        require(msg.sender == regulator, "only regulator");
        _;
    }

    constructor() {
        regulator = msg.sender;
        stakeholders[msg.sender] = Stakeholder(Role.Regulator, true, "Regulator");
    }

    function registerStakeholder(address addr, Role role, string calldata name) external onlyRegulator {
        stakeholders[addr] = Stakeholder(role, true, name);
    }

    function setAuthorized(address addr, bool authorized) external onlyRegulator {
        stakeholders[addr].authorized = authorized;
    }

    /// @notice Manufacturer mints a new medicine unit onto the ledger.
    function registerMedicine(bytes32 serialHash, uint64 manufacturingDate, uint64 expiryDate) external {
        require(stakeholders[msg.sender].role == Role.Manufacturer, "caller is not a registered manufacturer");
        require(stakeholders[msg.sender].authorized, "manufacturer not authorized");
        require(!medicines[serialHash].exists, "serial already registered"); // prevents duplicate/cloned registration

        medicines[serialHash] = Medicine({
            serialHash: serialHash,
            manufacturer: msg.sender,
            currentOwner: msg.sender,
            manufacturingDate: manufacturingDate,
            expiryDate: expiryDate,
            exists: true
        });

        emit MedicineRegistered(serialHash, msg.sender);
    }

    /// @notice Smart-contract-enforced ownership transfer. Mirrors the
    /// invariants checked in anomaly.js::evaluateTransfer before a
    /// transfer is committed in the JS/SQLite prototype.
    function transferOwnership(bytes32 serialHash, address to) external {
        Medicine storage med = medicines[serialHash];
        require(med.exists, "unknown medicine");
        require(med.currentOwner == msg.sender, "caller is not the current owner"); // unexpected-owner-transfer guard

        Stakeholder memory recipient = stakeholders[to];
        if (!recipient.authorized) {
            emit TransferRejected(serialHash, to, "unauthorized participant");
            revert("recipient is not an authorized stakeholder");
        }
        if (block.timestamp > med.expiryDate) {
            emit TransferRejected(serialHash, to, "expired medicine");
            revert("medicine is past its expiry date");
        }

        med.currentOwner = to;
        transferHistory[serialHash].push(TransferRecord(msg.sender, to, uint64(block.timestamp)));

        emit OwnershipTransferred(serialHash, msg.sender, to);
    }

    function getTransferHistory(bytes32 serialHash) external view returns (TransferRecord[] memory) {
        return transferHistory[serialHash];
    }

    function verify(bytes32 serialHash) external view returns (bool exists, address currentOwner, uint64 expiryDate, uint256 transferCount) {
        Medicine memory med = medicines[serialHash];
        return (med.exists, med.currentOwner, med.expiryDate, transferHistory[serialHash].length);
    }
}
