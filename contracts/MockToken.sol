// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockToken {
    string public constant name = "Mock";
    string public constant symbol = "MOCK";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { _move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }
    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount; balanceOf[to] += amount;
    }
}

contract FalseToken {
    function transfer(address, uint256) external pure returns (bool) { return false; }
    function transferFrom(address, address, uint256) external pure returns (bool) { return false; }
}

/// @dev Adversarial fixtures. None of these are intended as production tokens.
contract MalformedReturnToken {
    function transfer(address, uint256) external pure returns (bytes32) { return bytes32(uint256(2)); }
    function transferFrom(address, address, uint256) external pure returns (bytes32) { return bytes32(uint256(2)); }
}

contract ShortReturnToken {
    fallback() external { assembly { mstore(0, 1) return(31, 1) } }
}

contract FeeToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { _move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender]; require(a >= amount, "allowance");
        allowance[from][msg.sender] = a - amount; _move(from, to, amount); return true;
    }
    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance"); balanceOf[from] -= amount;
        balanceOf[to] += amount - amount / 10;
    }
}

contract ReentrantToken {
    mapping(address => uint256) public balanceOf;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackAttempted;
    bool public callbackSucceeded;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function configureCallback(address target, bytes calldata data) external { callbackTarget = target; callbackData = data; }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount;
        callbackAttempted = true; (callbackSucceeded,) = callbackTarget.call(callbackData);
        return true;
    }
}
