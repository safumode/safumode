/* global ethers */
'use strict';

const ABI = [
  'function NAME() view returns (string)', 'function VERSION() view returns (string)',
  'function authorizer() view returns (address)', 'function recoveryAuthorizer() view returns (address)',
  'function recoveryRecipient() view returns (address)', 'function delay() view returns (uint64)',
  'function trusted(address) view returns (bool)', 'function trustNonce(address) view returns (uint256)',
  'function pendingTrust(address) view returns (uint64 executableAt,uint256 nonce)',
  'function pendingTrustEpoch(address) view returns (uint256)', 'function authorityEpoch() view returns (uint256)',
  'function paused() view returns (bool)',
  'function authorizerNonceUsed(uint256) view returns (bool)', 'function domainSeparator() view returns (bytes32)',
  'event NativeDeposited(address indexed from,uint256 amount)',
  'event TokenDeposited(address indexed from,address indexed token,uint256 amount)',
  'event TrustScheduled(address indexed account,uint256 indexed nonce,uint64 executableAt)',
  'event TrustedSet(address indexed account,bool trusted,uint256 indexed nonce)',
  'event WithdrawalExecuted(bytes32 indexed requestId,address indexed asset,address indexed to,uint256 amount)',
  'event WithdrawalScheduled(bytes32 indexed requestId,address indexed asset,address indexed to,uint256 amount,uint64 executableAt)',
  'event WithdrawalCancelled(bytes32 indexed requestId)',
  'event RecoveryExecuted(address indexed asset,address indexed recoveryRecipient,uint256 amount)'
];
const EXPECTED_NAME = 'Authorization Vault Prototype';
const VERSION_PATTERN = /^1:\d+$/;
const EVENT_NAMES = ['NativeDeposited','TokenDeposited','TrustScheduled','TrustedSet','WithdrawalExecuted','WithdrawalScheduled','WithdrawalCancelled','RecoveryExecuted'];
const $ = selector => document.querySelector(selector);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short = value => value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—';
const fmtTime = seconds => new Date(Number(seconds) * 1000).toLocaleString();
let state = { provider:null, contract:null, address:null, chainId:null, source:null, data:null, identity:null, tab:'status' };
let allowlistPromise;

async function deploymentAllowlist() {
  if (!allowlistPromise) allowlistPromise = fetch('deployment-allowlist.json', { cache:'no-store' })
    .then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = await response.json();
      if (manifest.schema !== 'safumode-browser-allowlist-v1' || !Array.isArray(manifest.deployments)) throw new Error('invalid schema');
      return manifest.deployments;
    })
    .catch(error => { console.warn(`Pinned deployment allowlist unavailable: ${errorText(error)}`); return []; });
  return allowlistPromise;
}

function matchingPin(entries, chainId, address) {
  return entries.find(entry => String(entry.chainId) === chainId.toString() &&
    typeof entry.address === 'string' && entry.address.toLowerCase() === address.toLowerCase());
}

function assertPinnedState(pin, actual) {
  const expected = pin.state;
  if (!expected || typeof expected !== 'object') throw new Error('Pinned manifest has no expected self-reported state.');
  const checks = [
    ['name', actual.name, expected.name], ['version', actual.version, expected.version],
    ['authorizer', actual.authorizer, expected.authorizer],
    ['recoveryAuthorizer', actual.recoveryAuthorizer, expected.recoveryAuthorizer],
    ['recoveryRecipient', actual.recoveryRecipient, expected.recoveryRecipient],
    ['delay', actual.delay.toString(), String(expected.delay)]
  ];
  const mismatch = checks.find(([key, value, wanted]) => key.endsWith('Authorizer') || key === 'authorizer' || key === 'recoveryRecipient'
    ? String(value).toLowerCase() !== String(wanted).toLowerCase() : String(value) !== String(wanted));
  if (mismatch) throw new Error(`Pinned deployment state mismatch: ${mismatch[0]}.`);
}

function errorText(error) { return error?.shortMessage || error?.reason || error?.message || String(error); }
function setError(message='') { $('#config-error').textContent = message; }
function config() { return { address:$('#vault-address').value.trim(), chainId:$('#chain-id').value.trim(), rpc:$('#rpc-url').value.trim() }; }
function validateConfig(c) {
  if (!ethers.isAddress(c.address)) throw new Error('Enter a valid EVM vault address.');
  if (!/^\d+$/.test(c.chainId) || BigInt(c.chainId) < 1n) throw new Error('Expected chain ID must be a positive integer.');
}
async function load(source) {
  setError(); const c=config(); validateConfig(c);
  if (source === 'rpc' && !c.rpc) throw new Error('Enter an RPC URL, or choose the injected wallet network.');
  if (source === 'wallet' && !window.ethereum) throw new Error('No injected EVM wallet was detected.');
  const provider = source === 'rpc' ? new ethers.JsonRpcProvider(c.rpc) : new ethers.BrowserProvider(window.ethereum);
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(c.chainId)) throw new Error(`Unsupported network: provider is chain ${network.chainId}; expected ${c.chainId}. No signing is available.`);
  const normalizedAddress = ethers.getAddress(c.address);
  const pin = matchingPin(await deploymentAllowlist(), network.chainId, normalizedAddress);
  const code = await provider.getCode(normalizedAddress);
  if (code === '0x') throw new Error('No contract bytecode exists at this address on the expected chain.');
  const contract = new ethers.Contract(normalizedAddress, ABI, provider);
  const [name, version, authorizer, recoveryAuthorizer, recoveryRecipient, delay, balance, onchainDomain, authorityEpoch, paused] = await Promise.all([
    contract.NAME(), contract.VERSION(), contract.authorizer(), contract.recoveryAuthorizer(), contract.recoveryRecipient(), contract.delay(), provider.getBalance(c.address), contract.domainSeparator(), contract.authorityEpoch(), contract.paused()
  ]);
  if (name !== EXPECTED_NAME || !VERSION_PATTERN.test(version)) throw new Error(`Interface response mismatch. Expected “${EXPECTED_NAME}” with version 1:<epoch>. This check does not verify code identity.`);
  const expectedDomain = ethers.TypedDataEncoder.hashDomain({name,version,chainId:network.chainId,verifyingContract:c.address});
  if (onchainDomain.toLowerCase() !== expectedDomain.toLowerCase()) throw new Error('Reported EIP-712 domain is internally inconsistent.');
  const data={name,version,authorizer,recoveryAuthorizer,recoveryRecipient,delay,balance,onchainDomain,authorityEpoch,paused};
  let identity = { pinned:false, verified:false, reason:'Chain and address are not present in the locally bundled allowlist.' };
  if (pin) {
    const codeHash = ethers.keccak256(code);
    if (!/^0x[0-9a-fA-F]{64}$/.test(pin.runtimeCodeHash || '')) throw new Error('Pinned manifest has an invalid runtime bytecode hash.');
    if (codeHash.toLowerCase() !== pin.runtimeCodeHash.toLowerCase()) throw new Error(`Pinned deployment bytecode mismatch. Expected ${pin.runtimeCodeHash}, received ${codeHash}.`);
    assertPinnedState(pin, data);
    identity = { pinned:true, verified:true, codeHash, label:pin.label || 'Pinned deployment' };
  }
  state={provider,contract,address:normalizedAddress,chainId:network.chainId,source,data,identity,tab:'status'};
  localStorage.setItem('safumode-config', JSON.stringify(c));
  $('#configuration').hidden=true; $('#live-panel').hidden=false;
  $('#connection-label').textContent=`${identity.verified?'PINNED IDENTITY MATCH':'UNVERIFIED CONTRACT'} · CHAIN ${network.chainId} · READ ONLY`;
  document.querySelectorAll('[data-panel]').forEach(b=>b.classList.toggle('selected',b.dataset.panel==='status'));
  render();
}
function identityNotice() { const i=state.identity; return i.verified
  ? `<div class="verify-banner"><strong>PINNED DEPLOYMENT IDENTITY MATCH.</strong> Chain ${state.chainId}, address ${esc(state.address)}, runtime bytecode hash <code>${esc(i.codeHash)}</code>, and pinned self-reported state all match the static local allowlist (${esc(i.label)}). Signing remains disabled.</div>`
  : `<div class="danger-note"><strong>Contract identity is not verified.</strong> ${esc(i.reason)} Interface responses are only an untrusted preview and every signing flow is disabled.</div>`; }
function statusView() { const d=state.data; return `<span class="panel-label">${state.identity.verified?'PINNED IDENTITY · READ ONLY':'UNVERIFIED ON-CHAIN PREVIEW'}</span><h3>${esc(d.name)}</h3>
  ${identityNotice()}
  <dl class="state-list"><div><dt>Vault / chain</dt><dd title="${state.address}">${short(state.address)} · ${state.chainId}</dd></div><div><dt>Native balance</dt><dd>${ethers.formatEther(d.balance)} native</dd></div><div><dt>Paused</dt><dd>${d.paused?'YES — all outflows blocked':'NO'}</dd></div><div><dt>Authority epoch</dt><dd>${d.authorityEpoch}</dd></div><div><dt>Withdrawal authorizer</dt><dd title="${d.authorizer}">${short(d.authorizer)}</dd></div><div><dt>Recovery authorizer</dt><dd title="${d.recoveryAuthorizer}">${short(d.recoveryAuthorizer)}</dd></div><div><dt>Fixed recovery recipient</dt><dd title="${d.recoveryRecipient}">${short(d.recoveryRecipient)}</dd></div><div><dt>Exit delay</dt><dd>${d.delay} seconds</dd></div><div><dt>EIP-712 domain (unverified)</dt><dd title="${d.onchainDomain}">${short(d.onchainDomain)}</dd></div></dl>
  <p class="fineprint"><strong>RPC trust limit:</strong> the selected wallet provider or RPC supplies the chain ID, bytecode, and state and can lie about all of them. A pin match means those responses match this app's static allowlist; it is not consensus proof. Corroborate with independently operated providers or a block explorer before relying on it. The recovery authority can pause, recover only to the fixed recipient, cancel pending withdrawals, co-approve trust/rotation, and veto a pending rotation. Either authority may pause; both must sign to resume and to schedule rotation.</p>`; }
function recipientView() { return `<span class="panel-label">DIRECT CONTRACT LOOKUP</span><h3>Check recipient policy</h3><label>Recipient address<input id="recipient-address" spellcheck="false" placeholder="0x…"></label><div class="tool-actions"><button id="check-recipient" class="primary small">Read state</button></div><div id="recipient-result"></div>`; }
function activityView() { return `<span class="panel-label">ON-CHAIN EVENT LOG</span><h3>Recent vault activity</h3><p class="fineprint">Queries up to the latest 50,000 blocks from the connected RPC. This is not continuous monitoring and RPC providers may limit history.</p><button class="primary small" id="load-events">Query events</button><div id="events-result"></div>`; }
function signView() { return `<span class="panel-label">SIGNING DISABLED</span><h3>Read-only by design</h3><div class="danger-note"><strong>Do not sign.</strong> Signing is disabled even when a pinned deployment identity matches. RPC responses are not consensus proof and this prototype provides no transaction or signature flow.</div><div class="tool-actions"><button class="primary small" disabled>Wallet signing unavailable</button></div>`; }
function render() { const live=$('#live-panel'); if (!state.contract) return; live.innerHTML=state.tab==='status'?statusView():state.tab==='recipients'?recipientView():state.tab==='activity'?activityView():signView(); bindPanel(); }
function bindPanel() {
  $('#check-recipient')?.addEventListener('click', checkRecipient);
  $('#load-events')?.addEventListener('click', loadEvents);

}
async function checkRecipient() { const out=$('#recipient-result'); try { const a=$('#recipient-address').value.trim(); if(!ethers.isAddress(a)) throw new Error('Enter a valid address.'); out.innerHTML='<p class="loading">Reading…</p>'; const [trusted,nonce,pending,pendingEpoch,currentEpoch]=await Promise.all([state.contract.trusted(a),state.contract.trustNonce(a),state.contract.pendingTrust(a),state.contract.pendingTrustEpoch(a),state.contract.authorityEpoch()]); const valid=pending.executableAt&&pendingEpoch===currentEpoch; out.innerHTML=`<div class="result-card"><strong>${trusted?'TRUSTED IN CURRENT EPOCH':'UNTRUSTED IN CURRENT EPOCH'}</strong><span>Trust nonce: ${nonce}</span><span>${pending.executableAt?`${valid?'Valid':'STALE'} pending activation: ${fmtTime(pending.executableAt)} (nonce ${pending.nonce}, epoch ${pendingEpoch})`:'No pending trust addition'}</span><span>Unverified RPC preview; signing is disabled.</span></div>`; } catch(e){out.innerHTML=`<p class="error">${esc(errorText(e))}</p>`;} }
async function loadEvents() { const out=$('#events-result'); out.innerHTML='<p class="loading">Querying unverified contract logs…</p>'; try { const latest=await state.provider.getBlockNumber(), from=Math.max(0,latest-50000); const groups=await Promise.all(EVENT_NAMES.map(name=>state.contract.queryFilter(state.contract.filters[name](),from,latest))); const events=groups.flat().sort((a,b)=>b.blockNumber-a.blockNumber||b.index-a.index).slice(0,100); if(!events.length){out.innerHTML='<p class="empty">No matching events found in the queried block range.</p>';return;} out.innerHTML=`<ol class="event-list">${events.map(e=>`<li><strong>${esc(e.fragment.name)}</strong><span>block ${e.blockNumber} · tx ${short(e.transactionHash)}</span><code>${esc(e.args.toArray().map(v=>typeof v==='bigint'?v.toString():v).join(' · '))}</code></li>`).join('')}</ol>`; } catch(e){out.innerHTML=`<p class="error">${esc(errorText(e))}</p>`;} }
document.querySelectorAll('[data-panel]').forEach(button=>button.addEventListener('click',()=>{ if(!state.contract){setError('Configure an unverified contract preview first.');return;} state.tab=button.dataset.panel;document.querySelectorAll('[data-panel]').forEach(b=>b.classList.toggle('selected',b===button));render(); }));
$('#load-rpc').onclick=()=>load('rpc').catch(e=>setError(errorText(e)));
$('#load-wallet').onclick=()=>load('wallet').catch(e=>setError(errorText(e)));
$('#clear-config').onclick=()=>{localStorage.removeItem('safumode-config');location.reload();};
const saved=JSON.parse(localStorage.getItem('safumode-config')||'{}'); const params=new URLSearchParams(location.search); $('#vault-address').value=params.get('vault')||saved.address||'';$('#chain-id').value=params.get('chainId')||saved.chainId||'';$('#rpc-url').value=saved.rpc||'';
const dialog=$('#notice');document.querySelector('[data-open-dialog]').addEventListener('click',()=>dialog.showModal());document.querySelectorAll('[data-close-dialog],.dialog-close').forEach(b=>b.addEventListener('click',()=>dialog.close()));dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
