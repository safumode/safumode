#!/usr/bin/env node
'use strict';

// Local-only end-to-end check. It creates throwaway authorities in memory, starts
// an ephemeral Hardhat JSON-RPC process, deploys/funds/configures the vault, and
// drives the real browser UI. No environment key or public RPC is read.
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { JsonRpcProvider, ContractFactory, Wallet, parseEther } = require('ethers');
const puppeteer = require('puppeteer-core');
const artifact = require('../artifacts/contracts/AuthorizationVault.sol/AuthorizationVault.json');

const ROOT = path.resolve(__dirname, '..');
const LOCAL_HOST = '127.0.0.1';
const CHAIN_ID = 31337n;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, LOCAL_HOST, () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.output = () => output;
  return child;
}

async function waitFor(check, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2_000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ].filter(Boolean);
  const fs = require('node:fs');
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('Chrome/Chromium not found. Set CHROME_PATH to run the browser integration test.');
  return found;
}

async function main() {
  const [rpcPort, webPort] = await Promise.all([freePort(), freePort()]);
  const rpcUrl = `http://${LOCAL_HOST}:${rpcPort}`;
  const webUrl = `http://${LOCAL_HOST}:${webPort}`;
  let node;
  let web;
  let browser;
  try {
    node = start(process.execPath, [path.join(ROOT, 'node_modules/hardhat/internal/cli/cli.js'), 'node', '--hostname', LOCAL_HOST, '--port', String(rpcPort)]);
    const provider = new JsonRpcProvider(rpcUrl);
    await waitFor(async () => (await provider.getNetwork()).chainId === CHAIN_ID, 'ephemeral Hardhat node');

    // These authorities are generated for this run only and never written to disk.
    const authorizer = Wallet.createRandom();
    const recoveryAuthorizer = Wallet.createRandom();
    const recoveryRecipient = Wallet.createRandom();
    const trustedRecipient = Wallet.createRandom();
    const deployer = await provider.getSigner(0); // Hardhat's documented local test account.
    const delay = 60n;
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, deployer);
    const vault = await factory.deploy(authorizer.address, recoveryAuthorizer.address, recoveryRecipient.address, delay);
    await vault.waitForDeployment();
    const vaultAddress = await vault.getAddress();
    await (await deployer.sendTransaction({ to: vaultAddress, value: parseEther('1.25') })).wait();

    const network = await provider.getNetwork();
    const domain = { name: 'Authorization Vault Prototype', version: '1:0', chainId: network.chainId, verifyingContract: vaultAddress };
    const trustTypes = { SetTrusted: [
      { name: 'account', type: 'address' }, { name: 'trusted', type: 'bool' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }
    ] };
    const latest = await provider.getBlock('latest');
    const deadline = BigInt(latest.timestamp + 3600);
    const trustValue = { account: trustedRecipient.address, trusted: true, nonce: 1n, deadline };
    const [authorizerSignature, recoverySignature] = await Promise.all([
      authorizer.signTypedData(domain, trustTypes, trustValue),
      recoveryAuthorizer.signTypedData(domain, trustTypes, trustValue)
    ]);
    await (await vault.scheduleTrust(trustedRecipient.address, 1n, deadline, authorizerSignature, recoverySignature)).wait();
    await provider.send('evm_increaseTime', [Number(delay)]);
    await provider.send('evm_mine', []);
    await (await vault.activateTrust(trustedRecipient.address, 1n)).wait();

    const pauseTypes = { SetPaused: [
      { name: 'paused', type: 'bool' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }
    ] };
    const pauseSignature = await authorizer.signTypedData(domain, pauseTypes, { paused: true, nonce: 1n, deadline });
    await (await vault.setPaused(true, false, 1n, deadline, pauseSignature, '0x')).wait();

    const expected = {
      address: vaultAddress, authorizer: authorizer.address,
      recoveryAuthorizer: recoveryAuthorizer.address, recoveryRecipient: recoveryRecipient.address,
      balance: await provider.getBalance(vaultAddress), paused: await vault.paused(),
      epoch: await vault.authorityEpoch(), trusted: await vault.trusted(trustedRecipient.address)
    };
    assert.equal(expected.trusted, true);
    assert.equal(expected.paused, true);

    web = start(process.execPath, [path.join(ROOT, 'web/dev.js')], { env: { ...process.env, PORT: String(webPort) } });
    await waitFor(async () => (await fetch(webUrl)).ok, 'local web server');

    browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
    await page.goto(webUrl, { waitUntil: 'networkidle0' });
    await page.$eval('#vault-address', (el, value) => { el.value = value; }, vaultAddress);
    await page.$eval('#chain-id', (el, value) => { el.value = value; }, CHAIN_ID.toString());
    await page.$eval('#rpc-url', (el, value) => { el.value = value; }, rpcUrl);
    await page.click('#load-rpc');
    await page.waitForSelector('#live-panel:not([hidden]) .state-list');

    const displayed = await page.$$eval('.state-list > div', rows => Object.fromEntries(rows.map(row => [row.querySelector('dt').textContent.trim(), {
      text: row.querySelector('dd').textContent.trim(), title: row.querySelector('dd').getAttribute('title')
    }])));
    assert.equal(displayed['Vault / chain'].title, expected.address);
    assert.match(displayed['Vault / chain'].text, /31337$/);
    assert.equal(displayed['Native balance'].text, '1.25 native');
    assert.equal(displayed.Paused.text, 'YES — all outflows blocked');
    assert.equal(displayed['Authority epoch'].text, expected.epoch.toString());
    assert.equal(displayed['Withdrawal authorizer'].title, expected.authorizer);
    assert.equal(displayed['Recovery authorizer'].title, expected.recoveryAuthorizer);
    assert.equal(displayed['Fixed recovery recipient'].title, expected.recoveryRecipient);

    await page.click('[data-panel="recipients"]');
    await page.$eval('#recipient-address', (el, value) => { el.value = value; }, trustedRecipient.address);
    await page.click('#check-recipient');
    await page.waitForFunction(() => document.querySelector('#recipient-result')?.textContent.includes('TRUSTED IN CURRENT EPOCH'));
    const recipientResult = await page.$eval('#recipient-result', el => el.textContent.replace(/\s+/g, ' ').trim());
    assert.match(recipientResult, /TRUSTED IN CURRENT EPOCH/);
    assert.match(recipientResult, /Trust nonce: 1/);
    assert.match(recipientResult, /No pending trust addition/);
    assert.deepEqual(browserErrors, [], `Browser errors: ${browserErrors.join('; ')}`);

    console.log('PASS local UI end-to-end integration');
    console.log(`  chain: ${network.chainId} (ephemeral Hardhat)`);
    console.log(`  vault: ${vaultAddress}`);
    console.log('  asserted: authorities, 1.25 native balance, paused=true, epoch=0, trusted recipient=true');
  } catch (error) {
    if (node?.output()) console.error(`\nHardhat output:\n${node.output()}`);
    if (web?.output()) console.error(`\nWeb output:\n${web.output()}`);
    throw error;
  } finally {
    if (browser) await browser.close();
    await Promise.all([stop(web), stop(node)]);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
