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
  'event RecoveryExecuted(address indexed asset,address indexed recoveryRecipient,uint256 amount)',
  'event PauseSet(bool paused,uint256 indexed nonce)',
  'event RotationScheduled(address indexed authorizer,address indexed recoveryAuthorizer,uint256 indexed nonce,uint64 executableAt)',
  'event AuthoritiesRotated(address indexed authorizer,address indexed recoveryAuthorizer,uint256 indexed nonce)',
  'event RotationCancelled(uint256 indexed nonce,address indexed vetoingAuthority)'
];
const EXPECTED_NAME = 'Authorization Vault Prototype';
const VERSION_PATTERN = /^1:\d+$/;
const EVENT_NAMES = ['NativeDeposited','TokenDeposited','TrustScheduled','TrustedSet','WithdrawalExecuted','WithdrawalScheduled','WithdrawalCancelled','RecoveryExecuted','PauseSet','RotationScheduled','AuthoritiesRotated','RotationCancelled'];
const $ = selector => document.querySelector(selector);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short = value => value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—';
const fmtTime = seconds => new Date(Number(seconds) * 1000).toLocaleString();
const latestBlockNumber = async provider => Number(BigInt(await provider.send('eth_blockNumber', [])));
let state = { provider:null, contract:null, address:null, chainId:null, source:null, data:null, identity:null, pin:null, tab:'status' };
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

function verifiedIdentity(pin, code) {
  const codeHash = ethers.keccak256(code);
  if (!/^0x[0-9a-fA-F]{64}$/.test(pin.runtimeCodeHash || '')) throw new Error('Pinned manifest has an invalid runtime bytecode hash.');
  if (codeHash.toLowerCase() !== pin.runtimeCodeHash.toLowerCase()) throw new Error(`Pinned deployment bytecode mismatch. Expected ${pin.runtimeCodeHash}, received ${codeHash}.`);
  return { pinned:true, verified:true, codeHash, label:pin.label || 'Pinned deployment' };
}

async function readSnapshot(provider, contract, address, blockTag) {
  // Pin related reads to one observed block rather than assembling state across blocks.
  const latestBlock = blockTag ?? await latestBlockNumber(provider);
  const at = { blockTag:latestBlock };
  const [code,name,version,authorizer,recoveryAuthorizer,recoveryRecipient,delay,balance,onchainDomain,authorityEpoch,paused] = await Promise.all([
    provider.getCode(address, latestBlock), contract.NAME(at), contract.VERSION(at), contract.authorizer(at),
    contract.recoveryAuthorizer(at), contract.recoveryRecipient(at), contract.delay(at), provider.getBalance(address, latestBlock),
    contract.domainSeparator(at), contract.authorityEpoch(at), contract.paused(at)
  ]);
  return { code, data:{name,version,authorizer,recoveryAuthorizer,recoveryRecipient,delay,balance,onchainDomain,authorityEpoch,paused,latestBlock,refreshedAt:new Date()} };
}

function errorText(error) { return error?.shortMessage || error?.reason || error?.message || String(error); }
function setError(message='') { $('#config-error').textContent = message; }
function savedConfig() {
  try {
    const value = JSON.parse(localStorage.getItem('safumode-config') || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    console.warn(`Ignoring invalid saved configuration: ${errorText(error)}`);
    return {};
  }
}
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
  const contract = new ethers.Contract(normalizedAddress, ABI, provider);
  const { code, data } = await readSnapshot(provider, contract, normalizedAddress);
  if (code === '0x') throw new Error('No contract bytecode exists at this address on the expected chain.');
  const { name, version, onchainDomain } = data;
  if (name !== EXPECTED_NAME || !VERSION_PATTERN.test(version)) throw new Error(`Interface response mismatch. Expected “${EXPECTED_NAME}” with version 1:<epoch>. This check does not verify code identity.`);
  const expectedDomain = ethers.TypedDataEncoder.hashDomain({name,version,chainId:network.chainId,verifyingContract:c.address});
  if (onchainDomain.toLowerCase() !== expectedDomain.toLowerCase()) throw new Error('Reported EIP-712 domain is internally inconsistent.');
  let identity = { pinned:false, verified:false, reason:'Chain and address are not present in the locally bundled allowlist.' };
  if (pin) {
    identity = verifiedIdentity(pin, code);
    assertPinnedState(pin, data);
  }
  state={provider,contract,address:normalizedAddress,chainId:network.chainId,source,data,identity,pin,tab:'status'};
  try { localStorage.setItem('safumode-config', JSON.stringify(c)); }
  catch (error) { console.warn(`Configuration could not be saved: ${errorText(error)}`); }
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
  <div class="tool-actions"><button class="primary small" id="refresh-status">Refresh and re-verify</button></div><div id="refresh-error" class="error" role="alert"></div>
  <dl class="state-list"><div><dt>Vault / chain</dt><dd title="${state.address}">${short(state.address)} · ${state.chainId}</dd></div><div><dt>Native balance</dt><dd>${ethers.formatEther(d.balance)} native</dd></div><div><dt>Paused</dt><dd>${d.paused?'YES — all outflows blocked':'NO'}</dd></div><div><dt>Authority epoch</dt><dd>${d.authorityEpoch}</dd></div><div><dt>Withdrawal authorizer</dt><dd title="${d.authorizer}">${short(d.authorizer)}</dd></div><div><dt>Recovery authorizer</dt><dd title="${d.recoveryAuthorizer}">${short(d.recoveryAuthorizer)}</dd></div><div><dt>Fixed recovery recipient</dt><dd title="${d.recoveryRecipient}">${short(d.recoveryRecipient)}</dd></div><div><dt>Exit delay</dt><dd>${d.delay} seconds</dd></div><div><dt>EIP-712 domain (unverified)</dt><dd title="${d.onchainDomain}">${short(d.onchainDomain)}</dd></div><div><dt>Status freshness</dt><dd>block ${d.latestBlock} · ${esc(d.refreshedAt.toLocaleString())}</dd></div></dl>
  <p class="fineprint"><strong>RPC trust limit:</strong> the selected wallet provider or RPC supplies the chain ID, bytecode, and state and can lie about all of them. A pin match means those responses match this app's static allowlist; it is not consensus proof. Corroborate with independently operated providers or a block explorer before relying on it. The recovery authority can pause, recover only to the fixed recipient, cancel pending withdrawals, co-approve trust/rotation, and veto a pending rotation. Either authority may pause; both must sign to resume and to schedule rotation.</p>`; }
function recipientView() { return `<span class="panel-label">DIRECT CONTRACT LOOKUP</span><h3>Check recipient policy</h3><label>Recipient address<input id="recipient-address" spellcheck="false" placeholder="0x…"></label><div class="tool-actions"><button id="check-recipient" class="primary small">Read state</button></div><div id="recipient-result"></div>`; }
function activityView() { return `<span class="panel-label">ON-CHAIN EVENT LOG</span><h3>Recent vault activity</h3><p class="fineprint">Queries up to the latest 50,000 blocks from the connected RPC. This is not continuous monitoring and RPC providers may limit history.</p><button class="primary small" id="load-events">Query events</button><div id="events-result"></div>`; }
function signView() { return `<span class="panel-label">SIGNING DISABLED</span><h3>Read-only by design</h3><div class="danger-note"><strong>Do not sign.</strong> Signing is disabled even when a pinned deployment identity matches. RPC responses are not consensus proof and this prototype provides no transaction or signature flow.</div><div class="tool-actions"><button class="primary small" disabled>Wallet signing unavailable</button></div>`; }
function render() { const live=$('#live-panel'); if (!state.contract) return; live.innerHTML=state.tab==='status'?statusView():state.tab==='recipients'?recipientView():state.tab==='activity'?activityView():signView(); bindPanel(); }
function bindPanel() {
  $('#check-recipient')?.addEventListener('click', checkRecipient);
  $('#load-events')?.addEventListener('click', loadEvents);
  $('#refresh-status')?.addEventListener('click', refreshStatusFromButton);

}
async function refreshStatus(blockTag) {
  let snapshot;
  try { snapshot = await readSnapshot(state.provider, state.contract, state.address, blockTag); }
  catch (error) {
    if (state.pin) {
      state.identity = { pinned:true, verified:false, reason:`Pinned identity refresh failed closed: ${errorText(error)}` };
      $('#connection-label').textContent=`PIN VERIFICATION FAILED · CHAIN ${state.chainId} · READ ONLY`;
    }
    throw error;
  }
  const { code, data } = snapshot;
  Object.assign(state.data, data);
  if (state.pin) {
    try {
      const identity = verifiedIdentity(state.pin, code);
      assertPinnedState(state.pin, data);
      state.identity = identity;
    } catch (error) {
      state.identity = { pinned:true, verified:false, reason:`Pinned identity refresh failed closed: ${errorText(error)}` };
      $('#connection-label').textContent=`PIN VERIFICATION FAILED · CHAIN ${state.chainId} · READ ONLY`;
      return;
    }
  }
  $('#connection-label').textContent=`${state.identity.verified?'PINNED IDENTITY MATCH':'UNVERIFIED CONTRACT'} · CHAIN ${state.chainId} · READ ONLY`;
}
async function refreshStatusFromButton() {
  const button=$('#refresh-status'); button.disabled=true;
  try {
    await refreshStatus(); render();
    if (state.pin && !state.identity.verified) $('#refresh-error').textContent='Refresh detected a pinned identity mismatch. Identity verification has been revoked.';
  } catch (error) { render(); const out=$('#refresh-error'); if(out) out.textContent=`Refresh failed: ${errorText(error)} Identity verification has been revoked.`; }
}
async function checkRecipient() {
  const out=$('#recipient-result');
  try {
    const a=$('#recipient-address').value.trim();
    if(!ethers.isAddress(a)) throw new Error('Enter a valid address.');
    out.innerHTML='<p class="loading">Reading…</p>';
    const blockTag=await latestBlockNumber(state.provider), at={blockTag};
    const [trusted,nonce,pending,pendingEpoch,currentEpoch]=await Promise.all([
      state.contract.trusted(a,at), state.contract.trustNonce(a,at), state.contract.pendingTrust(a,at),
      state.contract.pendingTrustEpoch(a,at), state.contract.authorityEpoch(at)
    ]);
    await refreshStatus(blockTag);
    const valid=pending.executableAt&&pendingEpoch===currentEpoch;
    const trustClaim=state.pin&&!state.identity.verified
      ? '<strong>Trust status withheld: pinned verification failed.</strong>'
      : `<strong>${trusted?'TRUSTED IN CURRENT EPOCH':'UNTRUSTED IN CURRENT EPOCH'}</strong>`;
    out.innerHTML=`<div class="result-card">${trustClaim}<span>Trust nonce: ${nonce}</span><span>${pending.executableAt?`${valid?'Valid':'STALE'} pending activation: ${fmtTime(pending.executableAt)} (nonce ${pending.nonce}, epoch ${pendingEpoch})`:'No pending trust addition'}</span><span>Status refreshed through block ${blockTag}. Unverified RPC preview; signing is disabled.</span></div>`;
  } catch(e){out.innerHTML=`<p class="error">${esc(errorText(e))}</p>`;}
}
async function loadEvents() { const out=$('#events-result'); out.innerHTML='<p class="loading">Querying unverified contract logs…</p>'; try { const latest=await latestBlockNumber(state.provider), from=Math.max(0,latest-50000); const groups=await Promise.all(EVENT_NAMES.map(name=>state.contract.queryFilter(state.contract.filters[name](),from,latest))); await refreshStatus(); const events=groups.flat().sort((a,b)=>b.blockNumber-a.blockNumber||b.index-a.index).slice(0,100); if(!events.length){out.innerHTML=`<p class="empty">No matching events found in the queried block range. Status refreshed through block ${state.data.latestBlock}.</p>`;return;} out.innerHTML=`<p class="fineprint">Status refreshed through block ${state.data.latestBlock}.</p><ol class="event-list">${events.map(e=>`<li><strong>${esc(e.fragment.name)}</strong><span>block ${e.blockNumber} · tx ${short(e.transactionHash)}</span><code>${esc(e.args.toArray().map(v=>typeof v==='bigint'?v.toString():v).join(' · '))}</code></li>`).join('')}</ol>`; } catch(e){out.innerHTML=`<p class="error">${esc(errorText(e))}</p>`;} }
document.querySelectorAll('[data-panel]').forEach(button=>button.addEventListener('click',()=>{ if(!state.contract){setError('Configure an unverified contract preview first.');return;} state.tab=button.dataset.panel;document.querySelectorAll('[data-panel]').forEach(b=>b.classList.toggle('selected',b===button));render(); }));
$('#load-rpc').onclick=()=>load('rpc').catch(e=>setError(errorText(e)));
$('#load-wallet').onclick=()=>load('wallet').catch(e=>setError(errorText(e)));
$('#clear-config').onclick=()=>{localStorage.removeItem('safumode-config');location.reload();};
const saved=savedConfig(); const params=new URLSearchParams(location.search); $('#vault-address').value=params.get('vault')||saved.address||'';$('#chain-id').value=params.get('chainId')||saved.chainId||'';$('#rpc-url').value=saved.rpc||'';
const dialog=$('#notice');document.querySelector('[data-open-dialog]').addEventListener('click',()=>dialog.showModal());document.querySelectorAll('[data-close-dialog],.dialog-close').forEach(b=>b.addEventListener('click',()=>dialog.close()));dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
