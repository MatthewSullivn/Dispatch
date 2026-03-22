/**
 * Setup script: registers 3 agent wallets via Locus beta API
 * and saves their credentials to .env
 *
 * Run once: node src/setup.js
 */

const { registerAgentWallet, checkWalletStatus } = require('./locus');
const fs = require('fs');
const path = require('path');

const AGENTS = [
  { name: 'DispatchOrchestrator', description: 'Orchestrator agent that coordinates tasks and manages budget' },
  { name: 'DispatchResearcher', description: 'Research agent that gathers data via web scraping and search' },
  { name: 'DispatchWriter', description: 'Writer agent that synthesizes research into reports' },
];

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForWallet(apiKey, name, maxRetries = 30) {
  for (let i = 0; i < maxRetries; i++) {
    const status = await checkWalletStatus(apiKey);
    console.log(`  [${name}] Wallet status: ${status.walletStatus || status.status || 'unknown'}`);
    if (status.walletStatus === 'deployed' || status.status === 'deployed') {
      return status;
    }
    await sleep(2000);
  }
  console.warn(`  [${name}] Wallet deployment timed out — may still be deploying`);
  return null;
}

async function main() {
  console.log('=== Locus Dispatch — Wallet Setup ===\n');

  const credentials = {};
  const envLines = [];

  // Load existing .env
  const envPath = path.join(__dirname, '..', '.env');
  let existingEnv = '';
  if (fs.existsSync(envPath)) {
    existingEnv = fs.readFileSync(envPath, 'utf-8');
  }

  for (const agent of AGENTS) {
    console.log(`Registering ${agent.name}...`);
    try {
      const raw = await registerAgentWallet(agent.name);
      const result = raw.data || raw;
      console.log(`  API Key: ${result.apiKey?.slice(0, 20)}...`);
      console.log(`  Wallet: ${result.ownerAddress}`);
      console.log(`  Status: ${result.walletStatus}`);
      if (result.claimUrl) console.log(`  Claim URL: ${result.claimUrl}`);

      const prefix = agent.name.toUpperCase().replace('MESH', '');
      credentials[agent.name] = result;

      envLines.push(`${prefix}_LOCUS_API_KEY=${result.apiKey}`);
      envLines.push(`${prefix}_WALLET_ADDRESS=${result.ownerAddress}`);
      envLines.push(`${prefix}_PRIVATE_KEY=${result.ownerPrivateKey}`);

      // Wait for wallet deployment
      console.log(`  Waiting for wallet deployment...`);
      await waitForWallet(result.apiKey, agent.name);
      console.log(`  ✓ ${agent.name} ready\n`);
    } catch (err) {
      console.error(`  ✗ Failed to register ${agent.name}: ${err.message}\n`);
    }

    // Rate limit: wait between registrations
    await sleep(3000);
  }

  // Append to .env
  const newEnv = existingEnv.trimEnd() + '\n\n# Locus Agent Wallets\n' + envLines.join('\n') + '\n';
  fs.writeFileSync(envPath, newEnv);
  console.log('Credentials appended to .env');

  // Save full credentials for reference
  const credsPath = path.join(__dirname, '..', 'credentials.json');
  fs.writeFileSync(credsPath, JSON.stringify(credentials, null, 2));
  console.log('Full credentials saved to credentials.json');
  console.log('\n=== Setup Complete ===');
}

main().catch(console.error);
