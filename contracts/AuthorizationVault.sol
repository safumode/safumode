// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Original educational prototype. No connected-wallet administrator exists:
///         authorization is by EIP-712 signatures that any relayer can submit.
contract AuthorizationVault {
    error Unauthorized();
    error InvalidAddress();
    error InvalidSignature();
    error Expired();
    error NonceUsed();
    error RecipientTrustMismatch();
    error RequestExists();
    error RequestMissing();
    error TooEarly();
    error TransferFailed();
    error ReentrantCall();
    error InvalidDelay();
    error InvalidTrustNonce();
    error TrustChangeMissing();

    struct PendingTrust {
        uint64 executableAt;
        uint256 nonce;
    }

    struct Request {
        address asset; // address(0) means native BNB
        address to;
        uint256 amount;
        uint64 executableAt;
        bool cancelled;
        bool executed;
    }

    string public constant NAME = "Authorization Vault Prototype";
    string public constant VERSION = "1";
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant WITHDRAW_TYPEHASH = keccak256(
        "Withdraw(address asset,address to,uint256 amount,uint256 nonce,uint256 deadline,bool immediate)"
    );
    bytes32 public constant TRUST_TYPEHASH = keccak256(
        "SetTrusted(address account,bool trusted,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant CANCEL_TYPEHASH = keccak256(
        "Cancel(bytes32 requestId,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant RECOVER_TYPEHASH = keccak256(
        "Recover(address asset,uint256 amount,uint256 nonce,uint256 deadline)"
    );
    uint256 private constant SECP256K1N_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public immutable authorizer;
    address public immutable recoveryAuthorizer;
    address public immutable recoveryRecipient;
    uint64 public immutable delay;
    mapping(address => bool) public trusted;
    mapping(address => uint256) public trustNonce;
    mapping(address => PendingTrust) public pendingTrust;
    mapping(uint256 => bool) public authorizerNonceUsed;
    mapping(uint256 => bool) public recoveryNonceUsed;
    mapping(bytes32 => Request) public requests;
    uint256 private locked = 1;

    event NativeDeposited(address indexed from, uint256 amount);
    event TokenDeposited(address indexed from, address indexed token, uint256 amount);
    event TrustScheduled(address indexed account, uint256 indexed nonce, uint64 executableAt);
    event TrustedSet(address indexed account, bool trusted, uint256 indexed nonce);
    event WithdrawalExecuted(bytes32 indexed requestId, address indexed asset, address indexed to, uint256 amount);
    event WithdrawalScheduled(bytes32 indexed requestId, address indexed asset, address indexed to, uint256 amount, uint64 executableAt);
    event WithdrawalCancelled(bytes32 indexed requestId);
    event RecoveryExecuted(address indexed asset, address indexed recoveryRecipient, uint256 amount);

    constructor(address authorizer_, address recoveryAuthorizer_, address recoveryRecipient_, uint64 delay_) {
        if (authorizer_ == address(0) || recoveryAuthorizer_ == address(0) || recoveryRecipient_ == address(0)) {
            revert InvalidAddress();
        }
        if (authorizer_ == recoveryAuthorizer_) revert InvalidAddress();
        if (delay_ == 0) revert InvalidDelay();
        authorizer = authorizer_;
        recoveryAuthorizer = recoveryAuthorizer_;
        recoveryRecipient = recoveryRecipient_;
        delay = delay_;
    }

    receive() external payable { emit NativeDeposited(msg.sender, msg.value); }

    function depositToken(address token, uint256 amount) external {
        if (token == address(0)) revert InvalidAddress();
        _safeTransferFrom(token, msg.sender, address(this), amount);
        emit TokenDeposited(msg.sender, token, amount);
    }

    /// @notice Additions require both authorities and activate only after the delay.
    function scheduleTrust(address account, uint256 nonce, uint256 deadline,
        bytes calldata authorizerSignature, bytes calldata recoverySignature) external {
        if (account == address(0)) revert InvalidAddress();
        if (nonce != trustNonce[account] + 1) revert InvalidTrustNonce();
        bytes32 structHash = keccak256(abi.encode(TRUST_TYPEHASH, account, true, nonce, deadline));
        _verify(authorizer, deadline, structHash, authorizerSignature);
        _verify(recoveryAuthorizer, deadline, structHash, recoverySignature);
        trustNonce[account] = nonce;
        uint64 executableAt = uint64(block.timestamp) + delay;
        pendingTrust[account] = PendingTrust(executableAt, nonce);
        emit TrustScheduled(account, nonce, executableAt);
    }

    function activateTrust(address account, uint256 nonce) external {
        PendingTrust memory pending = pendingTrust[account];
        if (pending.executableAt == 0 || pending.nonce != nonce || trustNonce[account] != nonce) revert TrustChangeMissing();
        if (block.timestamp < pending.executableAt) revert TooEarly();
        delete pendingTrust[account];
        trusted[account] = true;
        emit TrustedSet(account, true, nonce);
    }

    /// @notice Revocation is immediate and invalidates any pending addition.
    function revokeTrust(address account, uint256 nonce, uint256 deadline, bytes calldata signature) external {
        if (account == address(0)) revert InvalidAddress();
        if (nonce != trustNonce[account] + 1) revert InvalidTrustNonce();
        bytes32 structHash = keccak256(abi.encode(TRUST_TYPEHASH, account, false, nonce, deadline));
        _verify(authorizer, deadline, structHash, signature);
        trustNonce[account] = nonce;
        delete pendingTrust[account];
        trusted[account] = false;
        emit TrustedSet(account, false, nonce);
    }

    function withdrawTrusted(
        address asset, address to, uint256 amount, uint256 nonce, uint256 deadline, bytes calldata signature
    ) external nonReentrant {
        if (!trusted[to]) revert RecipientTrustMismatch();
        _authorize(authorizer, authorizerNonceUsed, nonce, deadline,
            keccak256(abi.encode(WITHDRAW_TYPEHASH, asset, to, amount, nonce, deadline, true)), signature);
        _transfer(asset, to, amount);
        emit WithdrawalExecuted(bytes32(0), asset, to, amount);
    }

    function scheduleWithdrawal(
        address asset, address to, uint256 amount, uint256 nonce, uint256 deadline, bytes calldata signature
    ) external returns (bytes32 requestId) {
        if (to == address(0)) revert InvalidAddress();
        if (trusted[to]) revert RecipientTrustMismatch();
        bytes32 structHash = keccak256(abi.encode(WITHDRAW_TYPEHASH, asset, to, amount, nonce, deadline, false));
        _authorize(authorizer, authorizerNonceUsed, nonce, deadline, structHash, signature);
        requestId = keccak256(abi.encode(_domainSeparator(), structHash));
        if (requests[requestId].executableAt != 0) revert RequestExists();
        uint64 executableAt = uint64(block.timestamp) + delay;
        requests[requestId] = Request(asset, to, amount, executableAt, false, false);
        emit WithdrawalScheduled(requestId, asset, to, amount, executableAt);
    }

    function executeWithdrawal(bytes32 requestId) external nonReentrant {
        Request storage request = requests[requestId];
        if (request.executableAt == 0 || request.cancelled || request.executed) revert RequestMissing();
        if (block.timestamp < request.executableAt) revert TooEarly();
        request.executed = true;
        _transfer(request.asset, request.to, request.amount);
        emit WithdrawalExecuted(requestId, request.asset, request.to, request.amount);
    }

    /// @notice Either offline authority can authorize cancellation; caller is merely a relayer.
    function cancelWithdrawal(
        bytes32 requestId, bool byRecovery, uint256 nonce, uint256 deadline, bytes calldata signature
    ) external {
        Request storage request = requests[requestId];
        if (request.executableAt == 0 || request.cancelled || request.executed) revert RequestMissing();
        bytes32 structHash = keccak256(abi.encode(CANCEL_TYPEHASH, requestId, nonce, deadline));
        if (byRecovery) {
            _authorize(recoveryAuthorizer, recoveryNonceUsed, nonce, deadline, structHash, signature);
        } else {
            _authorize(authorizer, authorizerNonceUsed, nonce, deadline, structHash, signature);
        }
        request.cancelled = true;
        emit WithdrawalCancelled(requestId);
    }

    /// @notice Break-glass path: recovery signer can only send to the immutable recovery recipient.
    function recover(address asset, uint256 amount, uint256 nonce, uint256 deadline, bytes calldata signature)
        external nonReentrant
    {
        _authorize(recoveryAuthorizer, recoveryNonceUsed, nonce, deadline,
            keccak256(abi.encode(RECOVER_TYPEHASH, asset, amount, nonce, deadline)), signature);
        _transfer(asset, recoveryRecipient, amount);
        emit RecoveryExecuted(asset, recoveryRecipient, amount);
    }

    function domainSeparator() external view returns (bytes32) { return _domainSeparator(); }

    modifier nonReentrant() {
        if (locked != 1) revert ReentrantCall();
        locked = 2;
        _;
        locked = 1;
    }

    function _authorize(
        address expected, mapping(uint256 => bool) storage used, uint256 nonce, uint256 deadline,
        bytes32 structHash, bytes calldata signature
    ) private {
        if (block.timestamp > deadline) revert Expired();
        if (used[nonce]) revert NonceUsed();
        if (_recover(_typedDataHash(structHash), signature) != expected) revert InvalidSignature();
        used[nonce] = true;
    }

    function _verify(address expected, uint256 deadline, bytes32 structHash, bytes calldata signature) private view {
        if (block.timestamp > deadline) revert Expired();
        if (_recover(_typedDataHash(structHash), signature) != expected) revert InvalidSignature();
    }

    function _domainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(bytes(NAME)), keccak256(bytes(VERSION)), block.chainid, address(this)));
    }

    function _typedDataHash(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := calldataload(signature.offset) s := calldataload(add(signature.offset, 32)) v := byte(0, calldataload(add(signature.offset, 64))) }
        if (uint256(s) > SECP256K1N_HALF || (v != 27 && v != 28)) revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }

    function _transfer(address asset, address to, uint256 amount) private {
        if (to == address(0)) revert InvalidAddress();
        if (asset == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _callOptionalReturn(asset, abi.encodeWithSelector(0xa9059cbb, to, amount));
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        _callOptionalReturn(token, abi.encodeWithSelector(0x23b872dd, from, to, amount));
    }

    function _callOptionalReturn(address token, bytes memory data) private {
        if (token.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory result) = token.call(data);
        // Avoid abi.decode(bool): non-canonical words otherwise panic instead of
        // producing this contract's stable token-call error.
        if (!ok) revert TransferFailed();
        if (result.length != 0) {
            if (result.length != 32) revert TransferFailed();
            uint256 returnValue;
            assembly { returnValue := mload(add(result, 32)) }
            if (returnValue != 1) revert TransferFailed();
        }
    }
}
