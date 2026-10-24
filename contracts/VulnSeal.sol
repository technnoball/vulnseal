// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title VulnSeal — commitment anchoring and cross-program arbitration for bug bounty reports
/// @notice Research prototype. Only commitments, digests, pseudonymous addresses, program ids
///         and state transitions are stored. Report text, evidence, nonces and rationales stay
///         off-chain; free-text items are referenced by salted digests.
/// @dev Nothing is ever edited or deleted. Every state change appends an entry to a
///      hash-chained log (logHead / logEntries) and emits LogAppended.
contract VulnSeal {
    // ------------------------------------------------------------------ roles
    uint8 public constant ROLE_RESEARCHER = 1;
    uint8 public constant ROLE_PROGRAM_ADMIN = 2;
    uint8 public constant ROLE_REVIEWER = 4;
    uint8 public constant ROLE_ARBITRATOR = 8;
    uint8 public constant ROLE_AUDITOR = 16;
    uint8 internal constant STAFF = ROLE_PROGRAM_ADMIN | ROLE_REVIEWER;

    // ------------------------------------------------------- commitment status
    uint8 internal constant ST_ANCHORED = 1;
    uint8 internal constant ST_ACKNOWLEDGED = 2;
    uint8 internal constant ST_REVEAL_REQUESTED = 3;
    uint8 internal constant ST_REVEALED = 4;
    uint8 internal constant ST_PENDING_TRIAGE = 5;
    uint8 internal constant ST_NEEDS_INFO = 6;
    uint8 internal constant ST_VALID = 7;
    uint8 internal constant ST_INVALID = 8;
    uint8 internal constant ST_FINALIZED = 9;

    // ---------------------------------------------------------- reveal checks
    uint8 internal constant REVEAL_MATCH = 1;
    uint8 internal constant REVEAL_BAD_ENCODING = 4;

    // ----------------------------------------------------------- associations
    uint8 internal constant REL_SAME = 1;
    uint8 internal constant REL_DISTINCT = 3;
    uint8 internal constant AS_PROPOSED = 1;
    uint8 internal constant AS_CONFIRMED = 2;
    uint8 internal constant AS_REJECTED = 3;
    uint8 internal constant AS_DISPUTED = 4;
    uint8 internal constant AS_UPHELD = 5;
    uint8 internal constant AS_OVERTURNED = 6;

    // --------------------------------------------------------------- disputes
    uint8 internal constant K_RELATIONSHIP = 1;
    uint8 internal constant K_PRIORITY = 2;
    uint8 internal constant K_VALIDITY = 3;
    uint8 internal constant D_OPEN = 1;
    uint8 internal constant D_DECIDED = 2;
    uint8 internal constant D_APPEALED = 3;
    uint8 internal constant D_FINAL = 4;
    // decisions (see server/domain.ts DECISION)
    uint8 internal constant DEC_UPHOLD = 1;
    uint8 internal constant DEC_SAME = 2;
    uint8 internal constant DEC_RELATED = 3;
    uint8 internal constant DEC_DISTINCT = 4;
    uint8 internal constant DEC_FIRST = 5;
    uint8 internal constant DEC_SECOND = 6;
    uint8 internal constant DEC_SHARED = 7;
    uint8 internal constant DEC_VALID = 8;
    uint8 internal constant DEC_INVALID = 9;
    uint8 internal constant DEC_INCONCLUSIVE = 10;

    // ------------------------------------------------------------- log kinds
    uint8 internal constant L_PROGRAM = 1;
    uint8 internal constant L_POLICY = 2;
    uint8 internal constant L_PARTICIPANT = 3;
    uint8 internal constant L_ANCHOR = 4;
    uint8 internal constant L_REVISION = 5;
    uint8 internal constant L_ACK = 6;
    uint8 internal constant L_REVEAL_REQ = 7;
    uint8 internal constant L_REVEAL_CHECK = 8;
    uint8 internal constant L_TRIAGE = 9;
    uint8 internal constant L_DISCLOSURE = 10;
    uint8 internal constant L_ASSOC_PROPOSED = 11;
    uint8 internal constant L_ASSOC_REVIEWED = 12;
    uint8 internal constant L_DISPUTE_OPENED = 13;
    uint8 internal constant L_VOTE = 14;
    uint8 internal constant L_RECUSAL = 15;
    uint8 internal constant L_DECISION = 16;
    uint8 internal constant L_APPEAL = 17;
    uint8 internal constant L_DISPUTE_CLOSED = 18;
    uint8 internal constant L_DISPOSITION = 19;
    uint8 internal constant L_AUDIT = 20;

    bytes32 public constant COMMIT_DOMAIN = keccak256("VulnSeal.Commitment.v1");
    bytes32 public constant LOG_DOMAIN = keccak256("VulnSeal.Log.v1");
    bytes32 public constant FAMILY_DOMAIN = keccak256("VulnSeal.IssueFamily.v1");

    // ------------------------------------------------------------------ types
    struct Participant {
        uint8 roles;
        uint32 programId; // affiliation; 0 = none
        bool active;
    }

    struct Program {
        bytes32 nameTag;
        uint32 policyVersion; // latest
        bool active;
    }

    struct Commitment {
        bytes32 commitment;
        address researcher; // 20 ┐
        uint32 programId; //    4 │ one slot
        uint32 policyVersion; // 4 │
        uint8 status; //        1 │
        uint8 mismatches; //    1 ┘
        uint64 anchoredAt; //     ┐
        uint64 supersedes; //     │ one slot
        uint64 supersededBy; //   │
        uint64 logSeq; //         ┘
        bytes32 revealDigest;
        bytes32 family;
    }

    struct Association {
        uint64 cidA;
        uint64 cidB;
        uint8 relation; // as proposed
        uint8 status;
        uint8 reviewedStatus; // CONFIRMED or REJECTED, kept when a dispute is opened
        uint8 decidedRelation; // set by arbitration (0 = association rejected)
        uint8 familySet; // bit 1: cidA's family set by this association, bit 2: cidB's
        uint32 proposerProgram;
        address proposer;
        address reviewer;
    }

    struct Dispute {
        uint8 kind;
        uint8 status;
        uint8 round;
        uint8 decision; // latest decision
        uint16 reasonCode;
        uint8 firstDecision;
        uint16 firstReason;
        bool reversed;
        uint64 subject; // association id, or commitment id for validity disputes
        uint64 cidA;
        uint64 cidB;
        uint32 progA;
        uint32 progB;
        address opener;
        uint64 openedAt;
        uint64 decidedAt;
        uint64 priorityTo; // for priority disputes: the commitment given priority (0 = none / shared)
        bytes32 policyDigest; // policy in force for cidA when it was committed
    }

    // ------------------------------------------------------------------ state
    address public governor;
    uint64 public immutable appealWindow;
    uint8 public immutable threshold;

    mapping(address => Participant) public participants;
    mapping(uint32 => Program) public programs;
    mapping(uint32 => mapping(uint32 => bytes32)) public policyDigest;
    uint32 public programCount;

    mapping(uint64 => Commitment) internal _commitments;
    uint64 public commitmentCount;
    mapping(address => mapping(bytes32 => bool)) public usedCommitment;
    mapping(uint64 => mapping(uint32 => bool)) public disclosedTo;
    mapping(uint64 => uint32) public openDisputesFor;

    mapping(uint64 => Association) internal _associations;
    uint64 public associationCount;
    mapping(bytes32 => uint64) public activeAssociation; // pair key => aid

    mapping(uint64 => Dispute) internal _disputes;
    uint64 public disputeCount;
    mapping(uint8 => mapping(uint64 => uint64)) public liveDispute; // kind => subject => did
    mapping(uint64 => mapping(uint8 => mapping(address => bool))) public hasVoted; // did => round => arbitrator
    mapping(uint64 => mapping(uint8 => mapping(bytes32 => uint8))) internal _tally;
    mapping(uint64 => mapping(address => bool)) public recused;

    bytes32 public logHead;
    uint64 public logCount;
    mapping(uint64 => bytes32) public logEntries; // seq => entry hash

    // ----------------------------------------------------------------- events
    event LogAppended(
        uint64 indexed seq,
        uint8 indexed kind,
        uint64 indexed subject,
        address actor,
        uint64 timestamp,
        bytes32 dataHash,
        bytes32 prevHash,
        bytes32 entryHash
    );
    event CommitmentAnchored(uint64 indexed cid, address indexed researcher, uint32 indexed programId, bytes32 commitment, uint64 supersedes);
    event StatusChanged(uint64 indexed cid, uint8 fromStatus, uint8 toStatus, address actor);
    event RevealChecked(uint64 indexed cid, uint8 outcome, bytes32 revealDigest, address reviewer);
    event AssociationProposed(uint64 indexed aid, uint64 cidA, uint64 cidB, uint8 relation, address proposer);
    event AssociationReviewed(uint64 indexed aid, bool approved, bytes32 family, address reviewer);
    event DisputeOpened(uint64 indexed did, uint8 kind, uint64 subject, address opener);
    event VoteCast(uint64 indexed did, uint8 round, address arbitrator, uint8 decision, uint16 reasonCode);
    event DisputeDecided(uint64 indexed did, uint8 round, uint8 decision, uint16 reasonCode);
    event DisputeFinal(uint64 indexed did, uint8 decision, uint16 reasonCode, bool reversed);

    // ----------------------------------------------------------------- errors
    error NotGovernor();
    error NotAuthorized(address account, uint8 requiredRoles);
    error WrongProgram(uint32 required, uint32 actual);
    error SelfReview();
    error NotCommitmentOwner();
    error ProposerCannotReview();
    error ConflictedArbitrator(uint32 programId);
    error PartyCannotVote();
    error PriorPanelMember();
    error ArbitratorRecused();
    error NotAParty();
    error AlreadyVoted();
    error ReplayedCommitment();
    error AlreadySuperseded(uint64 cid, uint64 by);
    error CommitmentSuperseded(uint64 cid, uint64 by);
    error AssociationExists(uint64 aid);
    error AssociationNotPending();
    error DisputeExists(uint64 did);
    error DisputeOpen();
    error InvalidTransition(uint8 fromStatus, uint8 toStatus);
    error NotOpenForVoting();
    error NotDecided();
    error AppealWindowClosed();
    error AppealWindowOpen();
    error RevealRequired(uint64 cid);
    error SameProgram();
    error InvalidDecision();
    error InvalidSubject();
    error InvalidOutcome();
    error EmptyDigest();
    error UnknownCommitment(uint64 cid);
    error UnknownAssociation(uint64 aid);
    error UnknownDispute(uint64 did);
    error UnknownProgram(uint32 programId);
    error UnknownPolicy(uint32 programId, uint32 version);
    error StalePolicy(uint32 latest);
    error ProgramInactive();
    error FamilyConflict();

    constructor(uint64 appealWindowSeconds, uint8 votesRequired) {
        require(votesRequired >= 2, "threshold");
        governor = msg.sender;
        appealWindow = appealWindowSeconds;
        threshold = votesRequired;
    }

    // ============================================================ governance
    function registerProgram(bytes32 nameTag, bytes32 firstPolicyDigest) external returns (uint32 id) {
        if (msg.sender != governor) revert NotGovernor();
        if (nameTag == bytes32(0) || firstPolicyDigest == bytes32(0)) revert EmptyDigest();
        id = ++programCount;
        programs[id] = Program({nameTag: nameTag, policyVersion: 1, active: true});
        policyDigest[id][1] = firstPolicyDigest;
        _log(L_PROGRAM, id, nameTag);
        _log(L_POLICY, id, keccak256(abi.encode(uint32(1), firstPolicyDigest)));
    }

    function setProgramActive(uint32 programId, bool active) external {
        if (msg.sender != governor) revert NotGovernor();
        _program(programId).active = active;
        _log(L_PROGRAM, programId, keccak256(abi.encode(active)));
    }

    /// @notice Set the roles and program affiliation of an account (0 roles = deactivate).
    function registerParticipant(address account, uint8 roles, uint32 programId) external {
        if (msg.sender != governor) revert NotGovernor();
        if (programId != 0) _program(programId);
        participants[account] = Participant({roles: roles, programId: programId, active: roles != 0});
        _log(L_PARTICIPANT, 0, keccak256(abi.encode(account, roles, programId)));
    }

    /// @notice Pseudonymous self-registration as a researcher. The address is the identity.
    function registerResearcher() external {
        Participant storage p = participants[msg.sender];
        p.roles |= ROLE_RESEARCHER;
        p.active = true;
        _log(L_PARTICIPANT, 0, keccak256(abi.encode(msg.sender, p.roles, p.programId)));
    }

    function publishPolicy(uint32 programId, bytes32 digest) external returns (uint32 version) {
        Program storage prog = _program(programId);
        _requireStaff(programId, ROLE_PROGRAM_ADMIN);
        if (digest == bytes32(0)) revert EmptyDigest();
        version = ++prog.policyVersion;
        policyDigest[programId][version] = digest;
        _log(L_POLICY, programId, keccak256(abi.encode(version, digest)));
    }

    // =========================================================== commitments
    function anchorCommitment(bytes32 commitment, uint32 programId, uint32 policyVersion) external returns (uint64 cid) {
        _requireRole(ROLE_RESEARCHER);
        cid = _anchor(commitment, programId, policyVersion, 0);
    }

    /// @notice Anchor a revised report. The original stays on record and is marked superseded;
    ///         the revision has its own (later) anchoring time.
    function reviseCommitment(uint64 oldCid, bytes32 commitment, uint32 policyVersion) external returns (uint64 cid) {
        _requireRole(ROLE_RESEARCHER);
        Commitment storage old = _commitment(oldCid);
        if (old.researcher != msg.sender) revert NotCommitmentOwner();
        if (old.supersededBy != 0) revert AlreadySuperseded(oldCid, old.supersededBy);
        if (old.status == ST_FINALIZED) revert InvalidTransition(ST_FINALIZED, ST_ANCHORED);
        cid = _anchor(commitment, old.programId, policyVersion, oldCid);
        old.supersededBy = cid;
    }

    function _anchor(bytes32 commitment, uint32 programId, uint32 policyVersion, uint64 supersedes) internal returns (uint64 cid) {
        if (commitment == bytes32(0)) revert EmptyDigest();
        Program storage prog = _program(programId);
        if (!prog.active) revert ProgramInactive();
        if (policyDigest[programId][policyVersion] == bytes32(0)) revert UnknownPolicy(programId, policyVersion);
        if (policyVersion != prog.policyVersion) revert StalePolicy(prog.policyVersion);
        if (usedCommitment[msg.sender][commitment]) revert ReplayedCommitment();
        usedCommitment[msg.sender][commitment] = true;
        cid = ++commitmentCount;
        Commitment storage c = _commitments[cid];
        c.commitment = commitment;
        c.researcher = msg.sender;
        c.programId = programId;
        c.policyVersion = policyVersion;
        c.status = ST_ANCHORED;
        c.anchoredAt = uint64(block.timestamp);
        c.supersedes = supersedes;
        c.logSeq = _log(supersedes == 0 ? L_ANCHOR : L_REVISION, cid, keccak256(abi.encode(commitment, programId, policyVersion, supersedes)));
        emit CommitmentAnchored(cid, msg.sender, programId, commitment, supersedes);
    }

    function acknowledge(uint64 cid) external {
        Commitment storage c = _live(cid);
        _requireStaff(c.programId, STAFF);
        _move(cid, c, ST_ANCHORED, ST_ACKNOWLEDGED, L_ACK, bytes32(0));
    }

    function requestReveal(uint64 cid) external {
        Commitment storage c = _live(cid);
        _requireStaff(c.programId, STAFF);
        _move(cid, c, ST_ACKNOWLEDGED, ST_REVEAL_REQUESTED, L_REVEAL_REQ, bytes32(0));
    }

    /// @notice Record the outcome of checking a reveal off-chain. The nonce and the report are
    ///         never sent here; revealDigest = keccak256(abi.encode(tag, cid, fieldsDigest)).
    function recordReveal(uint64 cid, uint8 outcome, bytes32 revealDigest) external {
        Commitment storage c = _live(cid);
        _requireStaff(c.programId, STAFF);
        if (msg.sender == c.researcher) revert SelfReview();
        if (outcome < REVEAL_MATCH || outcome > REVEAL_BAD_ENCODING) revert InvalidOutcome();
        if (c.status != ST_REVEAL_REQUESTED) revert InvalidTransition(c.status, ST_REVEALED);
        if (outcome == REVEAL_MATCH) {
            if (revealDigest == bytes32(0)) revert EmptyDigest();
            c.revealDigest = revealDigest;
            c.status = ST_REVEALED;
            emit StatusChanged(cid, ST_REVEAL_REQUESTED, ST_REVEALED, msg.sender);
        } else if (c.mismatches < type(uint8).max) {
            c.mismatches++;
        }
        _log(L_REVEAL_CHECK, cid, keccak256(abi.encode(outcome, revealDigest)));
        emit RevealChecked(cid, outcome, revealDigest, msg.sender);
    }

    function setTriage(uint64 cid, uint8 target, bytes32 noteDigest) external {
        Commitment storage c = _live(cid);
        _requireStaff(c.programId, STAFF);
        if (openDisputesFor[cid] != 0) revert DisputeOpen();
        uint8 s = c.status;
        bool ok = (s == ST_REVEALED && target == ST_PENDING_TRIAGE) ||
            ((s == ST_PENDING_TRIAGE) && (target == ST_NEEDS_INFO || target == ST_VALID || target == ST_INVALID)) ||
            ((s == ST_NEEDS_INFO) && (target == ST_PENDING_TRIAGE || target == ST_VALID || target == ST_INVALID));
        if (!ok) revert InvalidTransition(s, target);
        _move(cid, c, s, target, L_TRIAGE, noteDigest);
    }

    /// @notice Let another program's staff read this report's revealed content (off-chain).
    function grantDisclosure(uint64 cid, uint32 toProgram) external {
        Commitment storage c = _live(cid);
        Participant storage p = participants[msg.sender];
        bool owner = msg.sender == c.researcher;
        bool admin = p.active && (p.roles & ROLE_PROGRAM_ADMIN) != 0 && p.programId == c.programId;
        if (!owner && !admin) revert NotAParty();
        _program(toProgram);
        if (toProgram == c.programId) revert SameProgram();
        if (c.status < ST_REVEALED) revert RevealRequired(cid);
        disclosedTo[cid][toProgram] = true;
        _log(L_DISCLOSURE, cid, keccak256(abi.encode(toProgram)));
    }

    /// @notice Final disposition after triage. Earlier states remain in the log.
    function finalizeReport(uint64 cid, bytes32 dispositionDigest) external {
        Commitment storage c = _live(cid);
        _requireStaff(c.programId, ROLE_PROGRAM_ADMIN);
        if (openDisputesFor[cid] != 0) revert DisputeOpen();
        if (c.status != ST_VALID && c.status != ST_INVALID) revert InvalidTransition(c.status, ST_FINALIZED);
        _move(cid, c, c.status, ST_FINALIZED, L_DISPOSITION, dispositionDigest);
    }

    // ========================================================== associations
    function proposeAssociation(uint64 cidA, uint64 cidB, uint8 relation, bytes32 digest) external returns (uint64 aid) {
        if (relation < REL_SAME || relation > REL_DISTINCT) revert InvalidOutcome();
        if (digest == bytes32(0)) revert EmptyDigest();
        Commitment storage a = _live(cidA);
        Commitment storage b = _live(cidB);
        if (a.programId == b.programId) revert SameProgram();
        Participant storage p = participants[msg.sender];
        if (!p.active || (p.roles & STAFF) == 0) revert NotAuthorized(msg.sender, STAFF);
        if (p.programId != a.programId && p.programId != b.programId) revert WrongProgram(a.programId, p.programId);
        if (a.status < ST_REVEALED) revert RevealRequired(cidA);
        if (b.status < ST_REVEALED) revert RevealRequired(cidB);
        bytes32 key = _pairKey(cidA, cidB);
        if (activeAssociation[key] != 0) revert AssociationExists(activeAssociation[key]);
        aid = ++associationCount;
        _associations[aid] = Association({
            cidA: cidA,
            cidB: cidB,
            relation: relation,
            status: AS_PROPOSED,
            reviewedStatus: 0,
            decidedRelation: 0,
            familySet: 0,
            proposerProgram: p.programId,
            proposer: msg.sender,
            reviewer: address(0)
        });
        activeAssociation[key] = aid;
        _log(L_ASSOC_PROPOSED, aid, keccak256(abi.encode(cidA, cidB, relation, digest)));
        emit AssociationProposed(aid, cidA, cidB, relation, msg.sender);
    }

    /// @notice Independent review by the *other* program's staff.
    function reviewAssociation(uint64 aid, bool approve, bytes32 digest) external {
        Association storage s = _association(aid);
        if (s.status != AS_PROPOSED) revert AssociationNotPending();
        if (msg.sender == s.proposer) revert ProposerCannotReview();
        if (digest == bytes32(0)) revert EmptyDigest();
        uint32 pa = _commitments[s.cidA].programId;
        uint32 other = s.proposerProgram == pa ? _commitments[s.cidB].programId : pa;
        _requireStaff(other, STAFF);
        s.reviewer = msg.sender;
        bytes32 fam;
        if (approve) {
            s.status = AS_CONFIRMED;
            if (s.relation == REL_SAME) fam = _joinFamily(aid, s);
        } else {
            s.status = AS_REJECTED;
            delete activeAssociation[_pairKey(s.cidA, s.cidB)];
        }
        s.reviewedStatus = s.status;
        _log(L_ASSOC_REVIEWED, aid, keccak256(abi.encode(approve, digest)));
        emit AssociationReviewed(aid, approve, fam, msg.sender);
    }

    // ============================================================== disputes
    function openDispute(uint8 kind, uint64 subject, bytes32 digest) external returns (uint64 did) {
        if (digest == bytes32(0)) revert EmptyDigest();
        uint64 existing = liveDispute[kind][subject];
        if (existing != 0) revert DisputeExists(existing);
        uint64 cidA;
        uint64 cidB;
        if (kind == K_RELATIONSHIP || kind == K_PRIORITY) {
            Association storage s = _association(subject);
            if (kind == K_RELATIONSHIP && s.status != AS_CONFIRMED && s.status != AS_REJECTED) revert InvalidSubject();
            if (kind == K_PRIORITY && _effectiveRelation(s) != REL_SAME) revert InvalidSubject();
            cidA = s.cidA;
            cidB = s.cidB;
        } else if (kind == K_VALIDITY) {
            Commitment storage c = _live(subject);
            if (c.status != ST_VALID && c.status != ST_INVALID) revert InvalidSubject();
            cidA = subject;
        } else {
            revert InvalidSubject();
        }
        if (!_isParty(msg.sender, cidA, cidB)) revert NotAParty();

        did = ++disputeCount;
        Dispute storage d = _disputes[did];
        d.kind = kind;
        d.status = D_OPEN;
        d.round = 1;
        d.subject = subject;
        d.cidA = cidA;
        d.cidB = cidB;
        d.progA = _commitments[cidA].programId;
        d.progB = cidB == 0 ? 0 : _commitments[cidB].programId;
        d.opener = msg.sender;
        d.openedAt = uint64(block.timestamp);
        d.policyDigest = policyDigest[d.progA][_commitments[cidA].policyVersion];
        liveDispute[kind][subject] = did;
        openDisputesFor[cidA]++;
        if (cidB != 0) openDisputesFor[cidB]++;
        if (kind == K_RELATIONSHIP) _associations[subject].status = AS_DISPUTED;
        _log(L_DISPUTE_OPENED, did, keccak256(abi.encode(kind, subject, digest)));
        emit DisputeOpened(did, kind, subject, msg.sender);
    }

    function recuse(uint64 did) external {
        _requireRole(ROLE_ARBITRATOR);
        Dispute storage d = _dispute(did);
        if (d.status != D_OPEN && d.status != D_APPEALED) revert NotOpenForVoting();
        recused[did][msg.sender] = true;
        _log(L_RECUSAL, did, bytes32(uint256(d.round)));
    }

    function vote(uint64 did, uint8 decision, uint16 reasonCode, bytes32 digest) external {
        _requireRole(ROLE_ARBITRATOR);
        Dispute storage d = _dispute(did);
        if (d.status != D_OPEN && d.status != D_APPEALED) revert NotOpenForVoting();
        uint32 aff = participants[msg.sender].programId;
        if (aff != 0 && (aff == d.progA || aff == d.progB)) revert ConflictedArbitrator(aff);
        if (msg.sender == _commitments[d.cidA].researcher || (d.cidB != 0 && msg.sender == _commitments[d.cidB].researcher)) revert PartyCannotVote();
        if (recused[did][msg.sender]) revert ArbitratorRecused();
        uint8 round = d.round;
        if (hasVoted[did][round][msg.sender]) revert AlreadyVoted();
        if (round == 2 && hasVoted[did][1][msg.sender]) revert PriorPanelMember();
        if (!_decisionAllowed(d.kind, decision)) revert InvalidDecision();
        if (reasonCode == 0 || digest == bytes32(0)) revert InvalidOutcome();
        hasVoted[did][round][msg.sender] = true;
        bytes32 key = keccak256(abi.encode(decision, reasonCode));
        uint8 n = ++_tally[did][round][key];
        _log(L_VOTE, did, keccak256(abi.encode(round, decision, reasonCode, digest)));
        emit VoteCast(did, round, msg.sender, decision, reasonCode);
        if (n >= threshold) {
            d.decision = decision;
            d.reasonCode = reasonCode;
            d.decidedAt = uint64(block.timestamp);
            _log(L_DECISION, did, keccak256(abi.encode(round, decision, reasonCode)));
            emit DisputeDecided(did, round, decision, reasonCode);
            if (round == 1) {
                d.status = D_DECIDED;
                d.firstDecision = decision;
                d.firstReason = reasonCode;
            } else {
                d.reversed = decision != d.firstDecision || reasonCode != d.firstReason;
                _finalize(did, d);
            }
        }
    }

    function appeal(uint64 did, bytes32 digest) external {
        Dispute storage d = _dispute(did);
        if (d.status != D_DECIDED) revert NotDecided();
        if (block.timestamp > d.decidedAt + appealWindow) revert AppealWindowClosed();
        if (!_isParty(msg.sender, d.cidA, d.cidB)) revert NotAParty();
        if (digest == bytes32(0)) revert EmptyDigest();
        d.status = D_APPEALED;
        d.round = 2;
        _log(L_APPEAL, did, digest);
    }

    /// @notice Close an unappealed decision once the appeal window has passed.
    function closeDispute(uint64 did) external {
        Dispute storage d = _dispute(did);
        if (d.status != D_DECIDED) revert NotDecided();
        if (block.timestamp <= d.decidedAt + appealWindow) revert AppealWindowOpen();
        _finalize(did, d);
    }

    function _finalize(uint64 did, Dispute storage d) internal {
        d.status = D_FINAL;
        delete liveDispute[d.kind][d.subject];
        openDisputesFor[d.cidA]--;
        if (d.cidB != 0) openDisputesFor[d.cidB]--;
        uint8 dec = d.decision;
        if (d.kind == K_RELATIONSHIP) {
            Association storage s = _associations[d.subject];
            uint8 rel = s.reviewedStatus == AS_CONFIRMED ? s.relation : 0;
            if (dec == DEC_SAME) rel = REL_SAME;
            else if (dec == DEC_RELATED) rel = 2;
            else if (dec == DEC_DISTINCT) rel = REL_DISTINCT;
            uint8 before = s.reviewedStatus == AS_CONFIRMED ? s.relation : 0;
            s.decidedRelation = rel;
            s.status = (dec == DEC_UPHOLD || dec == DEC_INCONCLUSIVE || rel == before) ? AS_UPHELD : AS_OVERTURNED;
            bytes32 key = _pairKey(s.cidA, s.cidB);
            if (rel == 0) delete activeAssociation[key];
            else activeAssociation[key] = d.subject;
            if (rel == REL_SAME) _joinFamily(d.subject, s);
            else _leaveFamily(s);
        } else if (d.kind == K_VALIDITY) {
            Commitment storage c = _commitments[d.cidA];
            if (dec == DEC_VALID && c.status != ST_VALID) _move(d.cidA, c, c.status, ST_VALID, L_TRIAGE, bytes32(uint256(did)));
            else if (dec == DEC_INVALID && c.status != ST_INVALID) _move(d.cidA, c, c.status, ST_INVALID, L_TRIAGE, bytes32(uint256(did)));
        } else {
            (uint64 first, uint64 second) = d.cidA < d.cidB ? (d.cidA, d.cidB) : (d.cidB, d.cidA);
            d.priorityTo = dec == DEC_FIRST ? first : dec == DEC_SECOND ? second : 0;
        }
        _log(L_DISPUTE_CLOSED, did, keccak256(abi.encode(dec, d.reasonCode, d.reversed)));
        emit DisputeFinal(did, dec, d.reasonCode, d.reversed);
    }

    // ================================================================= audit
    /// @notice An auditor records that it verified the log up to some point (digest of its report).
    function attest(bytes32 reportDigest) external {
        _requireRole(ROLE_AUDITOR);
        if (reportDigest == bytes32(0)) revert EmptyDigest();
        _log(L_AUDIT, logCount, reportDigest);
    }

    // ================================================================= views
    function computeCommitment(address researcher, uint32 programId, uint32 policyVersion, bytes32 fieldsDigest, bytes32 nonce)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(COMMIT_DOMAIN, block.chainid, address(this), researcher, programId, policyVersion, fieldsDigest, nonce));
    }

    /// @notice Check an opening without sending a transaction. Call via eth_call so the nonce
    ///         is only seen by the node you query; never pass it in a transaction.
    function verifyOpening(uint64 cid, bytes32 fieldsDigest, bytes32 nonce) external view returns (bool) {
        Commitment storage c = _commitment(cid);
        return computeCommitment(c.researcher, c.programId, c.policyVersion, fieldsDigest, nonce) == c.commitment;
    }

    function getCommitment(uint64 cid) external view returns (Commitment memory) {
        return _commitment(cid);
    }

    function getAssociation(uint64 aid) external view returns (Association memory) {
        return _association(aid);
    }

    function getDispute(uint64 did) external view returns (Dispute memory) {
        return _dispute(did);
    }

    function effectiveRelation(uint64 aid) external view returns (uint8) {
        return _effectiveRelation(_association(aid));
    }

    function computeLogEntryHash(uint64 seq, uint8 kind, uint64 subject, address actor, uint64 timestamp, bytes32 dataHash, bytes32 prevHash)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(LOG_DOMAIN, block.chainid, address(this), seq, kind, subject, actor, timestamp, dataHash, prevHash));
    }

    // ============================================================= internals
    function _log(uint8 kind, uint64 subject, bytes32 dataHash) internal returns (uint64 seq) {
        seq = ++logCount;
        bytes32 prev = logHead;
        bytes32 h = computeLogEntryHash(seq, kind, subject, msg.sender, uint64(block.timestamp), dataHash, prev);
        logEntries[seq] = h;
        logHead = h;
        emit LogAppended(seq, kind, subject, msg.sender, uint64(block.timestamp), dataHash, prev, h);
    }

    function _move(uint64 cid, Commitment storage c, uint8 fromStatus, uint8 toStatus, uint8 kind, bytes32 data) internal {
        if (c.status != fromStatus) revert InvalidTransition(c.status, toStatus);
        c.status = toStatus;
        _log(kind, cid, keccak256(abi.encode(fromStatus, toStatus, data)));
        emit StatusChanged(cid, fromStatus, toStatus, msg.sender);
    }

    function _requireRole(uint8 mask) internal view {
        Participant storage p = participants[msg.sender];
        if (!p.active || (p.roles & mask) == 0) revert NotAuthorized(msg.sender, mask);
    }

    function _requireStaff(uint32 programId, uint8 mask) internal view {
        _requireRole(mask);
        uint32 aff = participants[msg.sender].programId;
        if (aff != programId) revert WrongProgram(programId, aff);
    }

    function _isParty(address who, uint64 cidA, uint64 cidB) internal view returns (bool) {
        if (_commitments[cidA].researcher == who) return true;
        if (cidB != 0 && _commitments[cidB].researcher == who) return true;
        Participant storage p = participants[who];
        if (!p.active || (p.roles & STAFF) == 0 || p.programId == 0) return false;
        return p.programId == _commitments[cidA].programId || (cidB != 0 && p.programId == _commitments[cidB].programId);
    }

    function _decisionAllowed(uint8 kind, uint8 dec) internal pure returns (bool) {
        if (dec == DEC_INCONCLUSIVE) return true;
        if (kind == K_RELATIONSHIP) return dec == DEC_UPHOLD || dec == DEC_SAME || dec == DEC_RELATED || dec == DEC_DISTINCT;
        if (kind == K_PRIORITY) return dec == DEC_FIRST || dec == DEC_SECOND || dec == DEC_SHARED || dec == DEC_DISTINCT;
        return dec == DEC_UPHOLD || dec == DEC_VALID || dec == DEC_INVALID;
    }

    function _effectiveRelation(Association storage s) internal view returns (uint8) {
        if (s.status == AS_UPHELD || s.status == AS_OVERTURNED) return s.decidedRelation;
        if (s.status == AS_CONFIRMED || (s.status == AS_DISPUTED && s.reviewedStatus == AS_CONFIRMED)) return s.relation;
        return 0;
    }

    function _joinFamily(uint64 aid, Association storage s) internal returns (bytes32 fam) {
        bytes32 fa = _commitments[s.cidA].family;
        bytes32 fb = _commitments[s.cidB].family;
        if (fa != bytes32(0) && fb != bytes32(0)) {
            if (fa != fb) revert FamilyConflict();
            return fa;
        }
        fam = fa != bytes32(0) ? fa : fb != bytes32(0) ? fb : keccak256(abi.encode(FAMILY_DOMAIN, block.chainid, address(this), aid));
        if (fa == bytes32(0)) {
            _commitments[s.cidA].family = fam;
            s.familySet |= 1;
        }
        if (fb == bytes32(0)) {
            _commitments[s.cidB].family = fam;
            s.familySet |= 2;
        }
    }

    function _leaveFamily(Association storage s) internal {
        if (s.familySet & 1 != 0) delete _commitments[s.cidA].family;
        if (s.familySet & 2 != 0) delete _commitments[s.cidB].family;
        s.familySet = 0;
    }

    function _pairKey(uint64 a, uint64 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function _program(uint32 id) internal view returns (Program storage p) {
        p = programs[id];
        if (p.nameTag == bytes32(0)) revert UnknownProgram(id);
    }

    function _commitment(uint64 cid) internal view returns (Commitment storage c) {
        c = _commitments[cid];
        if (c.researcher == address(0)) revert UnknownCommitment(cid);
    }

    function _live(uint64 cid) internal view returns (Commitment storage c) {
        c = _commitment(cid);
        if (c.supersededBy != 0) revert CommitmentSuperseded(cid, c.supersededBy);
    }

    function _association(uint64 aid) internal view returns (Association storage s) {
        s = _associations[aid];
        if (s.cidA == 0) revert UnknownAssociation(aid);
    }

    function _dispute(uint64 did) internal view returns (Dispute storage d) {
        d = _disputes[did];
        if (d.kind == 0) revert UnknownDispute(did);
    }
}
