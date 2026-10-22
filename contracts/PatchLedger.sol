// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PatchLedger — append-only, evidence-linked repair passports
/// @notice Research prototype. Stores only integrity/provenance commitments:
///         an opaque device key, record hashes, the previous record hash, a
///         digest of the off-chain canonical payload, actor, timestamp and
///         sequence. No names, serial numbers or document contents on-chain.
/// @dev There is intentionally no function that edits or deletes a record.
///      Corrections, corroborations, challenges and resolutions are new
///      records that reference an earlier sequence number.
contract PatchLedger {
    // ---------------------------------------------------------------------
    // Roles (bitmask so a demo identity can hold more than one if granted)
    // ---------------------------------------------------------------------
    uint8 public constant ROLE_REGISTRAR = 1;
    uint8 public constant ROLE_REPAIRER = 2;
    uint8 public constant ROLE_INSPECTOR = 4; // refurbisher / inspection provider
    uint8 public constant ROLE_VERIFIER = 8; // buyer / public verifier
    uint8 public constant ROLE_AUDITOR = 16; // independent dispute resolver

    // ---------------------------------------------------------------------
    // Record types
    // ---------------------------------------------------------------------
    uint8 public constant T_REGISTRATION = 0;
    uint8 public constant T_DIAGNOSTIC = 1;
    uint8 public constant T_REPAIR = 2;
    uint8 public constant T_COMPONENT_REPLACEMENT = 3;
    uint8 public constant T_INSPECTION = 4;
    uint8 public constant T_CUSTODY_TRANSFER = 5;
    uint8 public constant T_EVIDENCE_ATTACHMENT = 6;
    uint8 public constant T_CORROBORATION = 7;
    uint8 public constant T_CHALLENGE = 8;
    uint8 public constant T_RESOLUTION = 9;
    uint8 public constant T_CORRECTION = 10;
    uint8 internal constant T_MAX = 10;

    // Resolution outcomes (only meaningful for T_RESOLUTION)
    uint8 public constant OUTCOME_NONE = 0;
    uint8 public constant OUTCOME_CLAIM_UPHELD = 1; // challenge rejected, claim stands
    uint8 public constant OUTCOME_CLAIM_REJECTED = 2; // challenge upheld, claim judged inaccurate
    uint8 public constant OUTCOME_INCONCLUSIVE = 3;

    uint32 public constant NO_REF = type(uint32).max;

    bytes32 public constant RECORD_DOMAIN = keccak256("PatchLedger.Record.v1");

    struct Record {
        bytes32 recordHash;
        bytes32 prevHash;
        bytes32 payloadDigest;
        address actor; // 20 bytes ┐
        uint40 timestamp; // 5     │ packed into one slot (31 bytes)
        uint8 recordType; // 1     │
        uint8 outcome; // 1        │
        uint32 refSeq; // 4        ┘
    }

    address public admin;
    mapping(address => uint8) public roles;

    mapping(bytes32 => Record[]) internal _records;
    /// target seq => (challenge seq + 1); 0 means no open challenge
    mapping(bytes32 => mapping(uint32 => uint32)) internal _openChallenge;
    /// challenge seq => resolved?
    mapping(bytes32 => mapping(uint32 => bool)) internal _challengeResolved;
    /// target seq => (correction seq + 1); 0 means not superseded
    mapping(bytes32 => mapping(uint32 => uint32)) internal _supersededBy;
    mapping(bytes32 => uint32) public openDisputeCount;

    uint256 public deviceCount;
    uint256 public totalRecords;
    uint256 public totalOpenDisputes;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event RoleGranted(address indexed account, uint8 role, address indexed by);
    event RoleRevoked(address indexed account, uint8 role, address indexed by);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event RecordAppended(
        bytes32 indexed deviceKey,
        uint32 indexed seq,
        uint8 recordType,
        bytes32 recordHash,
        bytes32 prevHash,
        bytes32 payloadDigest,
        address indexed actor,
        uint32 refSeq,
        uint8 outcome
    );
    event DisputeOpened(bytes32 indexed deviceKey, uint32 targetSeq, uint32 challengeSeq, address challenger);
    event DisputeResolved(bytes32 indexed deviceKey, uint32 challengeSeq, uint32 resolutionSeq, uint8 outcome, address auditor);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error NotAdmin(address account);
    error NotAuthorized(address account, uint8 requiredRoles);
    error InvalidAddress();
    error InvalidRole(uint8 role);
    error InvalidDeviceKey();
    error DeviceAlreadyRegistered(bytes32 deviceKey);
    error UnknownDevice(bytes32 deviceKey);
    error EmptyPayloadDigest();
    error StalePrevHash(bytes32 expected, bytes32 actual);
    error InvalidRecordType(uint8 recordType);
    error ReferenceRequired();
    error ReferenceNotAllowed();
    error InvalidReference(uint32 refSeq);
    error NotOriginalActor(address account, address originalActor);
    error SelfCorroboration();
    error SelfChallenge();
    error SelfResolution();
    error ConflictOfInterest();
    error DisputeAlreadyOpen(uint32 targetSeq, uint32 challengeSeq);
    error DisputeNotOpen(uint32 challengeSeq);
    error InvalidOutcome(uint8 outcome);
    error AlreadySuperseded(uint32 targetSeq, uint32 correctionSeq);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin(msg.sender);
        _;
    }

    constructor() {
        admin = msg.sender;
        roles[msg.sender] = ROLE_REGISTRAR;
        emit AdminTransferred(address(0), msg.sender);
        emit RoleGranted(msg.sender, ROLE_REGISTRAR, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------
    function grantRole(address account, uint8 role) external onlyAdmin {
        if (account == address(0)) revert InvalidAddress();
        if (!_isSingleRole(role)) revert InvalidRole(role);
        roles[account] |= role;
        emit RoleGranted(account, role, msg.sender);
    }

    function revokeRole(address account, uint8 role) external onlyAdmin {
        if (!_isSingleRole(role)) revert InvalidRole(role);
        roles[account] &= ~role;
        emit RoleRevoked(account, role, msg.sender);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    function hasAnyRole(address account, uint8 mask) public view returns (bool) {
        return roles[account] & mask != 0;
    }

    // ---------------------------------------------------------------------
    // Writes
    // ---------------------------------------------------------------------

    /// @notice Register a device under an opaque key (e.g. keccak256 of a random public ID).
    function registerDevice(bytes32 deviceKey, bytes32 payloadDigest) external returns (uint32 seq) {
        _requireRole(ROLE_REGISTRAR);
        if (deviceKey == bytes32(0)) revert InvalidDeviceKey();
        if (_records[deviceKey].length != 0) revert DeviceAlreadyRegistered(deviceKey);
        if (payloadDigest == bytes32(0)) revert EmptyPayloadDigest();
        deviceCount += 1;
        seq = _push(deviceKey, T_REGISTRATION, bytes32(0), payloadDigest, NO_REF, OUTCOME_NONE);
    }

    /// @notice Append a record to a device's history.
    /// @param expectedPrevHash the head hash the caller built on; rejects stale or forged predecessors.
    /// @param refSeq the referenced record for evidence/corroboration/challenge/resolution/correction, else NO_REF.
    /// @param outcome only for T_RESOLUTION; must be OUTCOME_NONE otherwise.
    function appendRecord(
        bytes32 deviceKey,
        uint8 recordType,
        bytes32 expectedPrevHash,
        bytes32 payloadDigest,
        uint32 refSeq,
        uint8 outcome
    ) external returns (uint32 seq) {
        Record[] storage recs = _records[deviceKey];
        uint256 n = recs.length;
        if (n == 0) revert UnknownDevice(deviceKey);
        if (payloadDigest == bytes32(0)) revert EmptyPayloadDigest();
        bytes32 head = recs[n - 1].recordHash;
        if (expectedPrevHash != head) revert StalePrevHash(expectedPrevHash, head);
        if (recordType == T_REGISTRATION || recordType > T_MAX) revert InvalidRecordType(recordType);
        if (recordType != T_RESOLUTION && outcome != OUTCOME_NONE) revert InvalidOutcome(outcome);

        uint32 nextSeq = uint32(n);

        if (
            recordType == T_DIAGNOSTIC || recordType == T_REPAIR || recordType == T_COMPONENT_REPLACEMENT
        ) {
            _requireRole(ROLE_REPAIRER | ROLE_INSPECTOR);
            if (refSeq != NO_REF) revert ReferenceNotAllowed();
        } else if (recordType == T_INSPECTION) {
            _requireRole(ROLE_INSPECTOR);
            if (refSeq != NO_REF) revert ReferenceNotAllowed();
        } else if (recordType == T_CUSTODY_TRANSFER) {
            _requireRole(ROLE_REGISTRAR | ROLE_INSPECTOR);
            if (refSeq != NO_REF) revert ReferenceNotAllowed();
        } else if (recordType == T_EVIDENCE_ATTACHMENT) {
            Record storage target = _claim(recs, refSeq);
            if (!hasAnyRole(msg.sender, ROLE_AUDITOR)) {
                _requireRole(ROLE_REGISTRAR | ROLE_REPAIRER | ROLE_INSPECTOR);
                if (target.actor != msg.sender) revert NotOriginalActor(msg.sender, target.actor);
            }
        } else if (recordType == T_CORROBORATION) {
            _requireRole(ROLE_INSPECTOR | ROLE_AUDITOR);
            Record storage target = _claim(recs, refSeq);
            if (target.actor == msg.sender) revert SelfCorroboration();
        } else if (recordType == T_CHALLENGE) {
            _requireRole(ROLE_VERIFIER | ROLE_INSPECTOR | ROLE_REPAIRER);
            Record storage target = _claim(recs, refSeq);
            if (target.actor == msg.sender) revert SelfChallenge();
            uint32 open = _openChallenge[deviceKey][refSeq];
            if (open != 0) revert DisputeAlreadyOpen(refSeq, open - 1);
            _openChallenge[deviceKey][refSeq] = nextSeq + 1;
            openDisputeCount[deviceKey] += 1;
            totalOpenDisputes += 1;
            emit DisputeOpened(deviceKey, refSeq, nextSeq, msg.sender);
        } else if (recordType == T_RESOLUTION) {
            _requireRole(ROLE_AUDITOR);
            if (refSeq == NO_REF) revert ReferenceRequired();
            if (refSeq >= n) revert InvalidReference(refSeq);
            Record storage challenge = recs[refSeq];
            if (challenge.recordType != T_CHALLENGE) revert InvalidReference(refSeq);
            if (_challengeResolved[deviceKey][refSeq]) revert DisputeNotOpen(refSeq);
            if (outcome == OUTCOME_NONE || outcome > OUTCOME_INCONCLUSIVE) revert InvalidOutcome(outcome);
            uint32 targetSeq = challenge.refSeq;
            if (recs[targetSeq].actor == msg.sender) revert SelfResolution();
            if (challenge.actor == msg.sender) revert ConflictOfInterest();
            _challengeResolved[deviceKey][refSeq] = true;
            _openChallenge[deviceKey][targetSeq] = 0;
            openDisputeCount[deviceKey] -= 1;
            totalOpenDisputes -= 1;
            emit DisputeResolved(deviceKey, refSeq, nextSeq, outcome, msg.sender);
        } else {
            // T_CORRECTION
            Record storage target = _claim(recs, refSeq);
            if (!hasAnyRole(msg.sender, ROLE_AUDITOR)) {
                _requireRole(ROLE_REGISTRAR | ROLE_REPAIRER | ROLE_INSPECTOR);
                if (target.actor != msg.sender) revert NotOriginalActor(msg.sender, target.actor);
            }
            uint32 sup = _supersededBy[deviceKey][refSeq];
            if (sup != 0) revert AlreadySuperseded(refSeq, sup - 1);
            _supersededBy[deviceKey][refSeq] = nextSeq + 1;
        }

        seq = _push(deviceKey, recordType, head, payloadDigest, refSeq, outcome);
    }

    // ---------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------
    function recordCount(bytes32 deviceKey) external view returns (uint256) {
        return _records[deviceKey].length;
    }

    function isRegistered(bytes32 deviceKey) external view returns (bool) {
        return _records[deviceKey].length != 0;
    }

    function headHash(bytes32 deviceKey) external view returns (bytes32) {
        Record[] storage recs = _records[deviceKey];
        if (recs.length == 0) return bytes32(0);
        return recs[recs.length - 1].recordHash;
    }

    function getRecord(bytes32 deviceKey, uint32 seq) external view returns (Record memory) {
        Record[] storage recs = _records[deviceKey];
        if (seq >= recs.length) revert InvalidReference(seq);
        return recs[seq];
    }

    function getRecords(bytes32 deviceKey) external view returns (Record[] memory) {
        return _records[deviceKey];
    }

    /// @return openChallengeSeq the open challenge against `seq`, or NO_REF
    /// @return supersededBySeq the correction that supersedes `seq`, or NO_REF
    /// @return challengeResolved for a challenge record: whether it has been resolved
    function recordState(bytes32 deviceKey, uint32 seq)
        external
        view
        returns (uint32 openChallengeSeq, uint32 supersededBySeq, bool challengeResolved)
    {
        uint32 oc = _openChallenge[deviceKey][seq];
        uint32 sb = _supersededBy[deviceKey][seq];
        openChallengeSeq = oc == 0 ? NO_REF : oc - 1;
        supersededBySeq = sb == 0 ? NO_REF : sb - 1;
        challengeResolved = _challengeResolved[deviceKey][seq];
    }

    function computeRecordHash(
        bytes32 deviceKey,
        uint32 seq,
        uint8 recordType,
        bytes32 prevHash,
        bytes32 payloadDigest,
        address actor,
        uint40 timestamp,
        uint32 refSeq,
        uint8 outcome
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                RECORD_DOMAIN,
                block.chainid,
                address(this),
                deviceKey,
                seq,
                recordType,
                prevHash,
                payloadDigest,
                actor,
                timestamp,
                refSeq,
                outcome
            )
        );
    }

    /// @notice Recompute every record hash and check predecessor links and chronology.
    /// @return ok true when the whole chain is consistent
    /// @return firstBadSeq first inconsistent sequence number, or NO_REF
    function verifyChain(bytes32 deviceKey) external view returns (bool ok, uint32 firstBadSeq) {
        Record[] storage recs = _records[deviceKey];
        if (recs.length == 0) return (false, 0);
        bytes32 prev = bytes32(0);
        uint40 lastTs = 0;
        for (uint32 i = 0; i < recs.length; i++) {
            Record storage r = recs[i];
            bytes32 h = computeRecordHash(
                deviceKey, i, r.recordType, r.prevHash, r.payloadDigest, r.actor, r.timestamp, r.refSeq, r.outcome
            );
            if (r.prevHash != prev || h != r.recordHash || r.timestamp < lastTs) return (false, i);
            prev = r.recordHash;
            lastTs = r.timestamp;
        }
        return (true, NO_REF);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------
    function _requireRole(uint8 mask) internal view {
        if (roles[msg.sender] & mask == 0) revert NotAuthorized(msg.sender, mask);
    }

    function _isSingleRole(uint8 role) internal pure returns (bool) {
        return role == ROLE_REGISTRAR || role == ROLE_REPAIRER || role == ROLE_INSPECTOR || role == ROLE_VERIFIER
            || role == ROLE_AUDITOR;
    }

    /// @dev A "claim" is any record other than a challenge or resolution.
    function _claim(Record[] storage recs, uint32 refSeq) internal view returns (Record storage) {
        if (refSeq == NO_REF) revert ReferenceRequired();
        if (refSeq >= recs.length) revert InvalidReference(refSeq);
        Record storage target = recs[refSeq];
        if (target.recordType == T_CHALLENGE || target.recordType == T_RESOLUTION) revert InvalidReference(refSeq);
        return target;
    }

    function _push(
        bytes32 deviceKey,
        uint8 recordType,
        bytes32 prevHash,
        bytes32 payloadDigest,
        uint32 refSeq,
        uint8 outcome
    ) internal returns (uint32 seq) {
        Record[] storage recs = _records[deviceKey];
        seq = uint32(recs.length);
        uint40 ts = uint40(block.timestamp);
        bytes32 h = computeRecordHash(deviceKey, seq, recordType, prevHash, payloadDigest, msg.sender, ts, refSeq, outcome);
        recs.push(
            Record({
                recordHash: h,
                prevHash: prevHash,
                payloadDigest: payloadDigest,
                actor: msg.sender,
                timestamp: ts,
                recordType: recordType,
                outcome: outcome,
                refSeq: refSeq
            })
        );
        totalRecords += 1;
        emit RecordAppended(deviceKey, seq, recordType, h, prevHash, payloadDigest, msg.sender, refSeq, outcome);
    }
}
