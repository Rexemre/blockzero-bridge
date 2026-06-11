// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {WBLOZ} from "./WBLOZ.sol";

/// @title BLOZ Bridge (BSC side)
/// @notice Users burn wBLOZ here to request native BLOZ on Block Zero mainnet.
///         Minting happens off-chain after native deposits are confirmed (relayer).
contract BlozBridgeOld is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    WBLOZ public immutable wBLOZ;

    /// @dev Monotonic id for unwrap requests (relayer watches these events).
    uint256 public nextUnwrapId;

    event UnwrapRequested(
        uint256 indexed unwrapId,
        address indexed user,
        uint256 amount,
        string bz1Address
    );

    constructor(address wBLOZToken, address admin) {
        wBLOZ = WBLOZ(wBLOZToken);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    /// @notice Burn wBLOZ and request native BLOZ sent to `bz1Address`.
    /// @param amount Amount in wBLOZ base units (8 decimals).
    /// @param bz1Address Valid Block Zero bech32 address (bz1…).
    function unwrap(uint256 amount, string calldata bz1Address) external nonReentrant whenNotPaused {
        require(amount > 0, "amount=0");
        require(bytes(bz1Address).length >= 14, "invalid bz1");
        require(
            keccak256(bytes(bz1Address)) == keccak256(bytes("bz1")) ||
                _startsWithBz1(bz1Address),
            "must start with bz1"
        );

        wBLOZ.transferFrom(msg.sender, address(this), amount);
        wBLOZ.burn(amount);

        uint256 id = nextUnwrapId++;
        emit UnwrapRequested(id, msg.sender, amount, bz1Address);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _startsWithBz1(string calldata s) private pure returns (bool) {
        bytes memory b = bytes(s);
        return b.length >= 3 && b[0] == "b" && b[1] == "z" && b[2] == "1";
    }
}

