// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {WBLOZ} from "./WBLOZ.sol";

/// @title BLOZ wrap claim (BSC)
/// @notice Users claim wBLOZ with a relayer signature after native BLOZ deposits confirm.
///         The user pays BNB gas; the relayer only signs off-chain.
contract BlozWrapClaim is EIP712, ReentrancyGuard {
    bytes32 private constant CLAIM_TYPEHASH =
        keccak256("Claim(address to,uint256 amount,bytes32 wrapId,uint256 deadline)");

    WBLOZ public immutable wBLOZ;
    address public immutable claimSigner;

    mapping(bytes32 => bool) public claimed;

    event WrapClaimed(bytes32 indexed wrapId, address indexed to, uint256 amount);

    constructor(address wBLOZToken, address signer) EIP712("BlozWrapClaim", "1") {
        wBLOZ = WBLOZ(wBLOZToken);
        claimSigner = signer;
    }

    /// @notice Mint wBLOZ to `to` after verifying relayer signature.
    /// @param to Recipient (must equal msg.sender).
    /// @param amount wBLOZ base units (8 decimals).
    /// @param wrapId Bridge wrap request id encoded as bytes32.
    /// @param deadline Unix timestamp after which the signature expires.
    /// @param signature EIP-712 signature from claimSigner.
    function claim(
        address to,
        uint256 amount,
        bytes32 wrapId,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        require(block.timestamp <= deadline, "expired");
        require(!claimed[wrapId], "claimed");
        require(to == msg.sender, "wrong caller");
        require(amount > 0, "amount=0");

        bytes32 structHash = keccak256(abi.encode(CLAIM_TYPEHASH, to, amount, wrapId, deadline));
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, signature);
        require(recovered == claimSigner, "bad sig");

        claimed[wrapId] = true;
        wBLOZ.mint(to, amount);
        emit WrapClaimed(wrapId, to, amount);
    }
}
