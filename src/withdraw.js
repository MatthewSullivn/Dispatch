/**
 * Withdraw ETH and ERC-20 tokens from the Locus smart wallet
 * using the owner EOA's private key.
 *
 * Locus smart wallets use an `execute(address dest, uint256 value, bytes calldata func)` pattern.
 */

const { ethers } = require('ethers');
require('dotenv').config();

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.ORCHESTRATOR_PRIVATE_KEY;
const SMART_WALLET = '0x148624ec93458da3069e1d4c12d18971cf483ce0';
const DEST_ADDRESS = process.argv[2] || '0x1fdbD2dbDBFcb1740c136d7A34dBb8518970389f';

// Common ERC-4337 smart account execute signatures
const EXECUTE_SIGS = [
  'function execute(address dest, uint256 value, bytes calldata func)',
  'function execute(address target, uint256 value, bytes calldata data)',
];

// ERC-20 transfer
const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

// Token addresses on Base
const TOKENS = {
  SOL: '0xb5c22ce84a4467b638e6e584f2925b2f4f7fa13c', // wrapped SOL on Base (approximate)
};

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log('EOA address:', wallet.address);
  console.log('Smart wallet:', SMART_WALLET);
  console.log('Destination:', DEST_ADDRESS);

  // First, let's check what methods the smart wallet supports
  // Try to get the bytecode and probe for execute function
  const code = await provider.getCode(SMART_WALLET);
  console.log('\nContract bytecode length:', code.length);

  // Try calling execute to send ETH
  for (const sig of EXECUTE_SIGS) {
    try {
      const iface = new ethers.Interface([sig]);
      const smartWallet = new ethers.Contract(SMART_WALLET, [sig], wallet);

      // Try sending a small amount of ETH first as a test
      console.log(`\nTrying: ${sig}`);

      // Send 0.004 ETH (leave some for gas if needed)
      const ethAmount = ethers.parseEther('0.004');
      const tx = await smartWallet.execute(DEST_ADDRESS, ethAmount, '0x');
      console.log('TX hash:', tx.hash);
      const receipt = await tx.wait();
      console.log('Success! Gas used:', receipt.gasUsed.toString());

      console.log('\nETH withdrawal successful. Now trying SOL token...');

      // Transfer SOL token
      const solInterface = new ethers.Interface(ERC20_ABI);
      // We need to find the actual SOL token address on Base
      // Check the token transfers on the wallet to find it

      return;
    } catch (err) {
      console.log('Failed:', err.message?.slice(0, 200));
    }
  }

  console.log('\nCould not find working execute function. The wallet may use a different interface.');
  console.log('Try claiming via dashboard: https://beta.paywithlocus.com/register/claim/f4XXu5kzR3YP9bCcAooq3DHnWqMGFSeTUy_BO-dZG9Q');
}

main().catch(console.error);
