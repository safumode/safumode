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
let state = { provider:null, contract:null, address:null, chainId:null, source:null, data:null, tab:'status' };

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
  const code = await provider.getCode(c.address);
  if (code === '0x') throw new Error('No contract bytecode exists at this address on the expected chain.');
  const contract = new ethers.Contract(c.address, ABI, provider);
  const [name, version, authorizer, recoveryAuthorizer, recoveryRecipient, delay, balance, onchainDomain, authorityEpoch, paused] = await Promise.all([
    contract.NAME(), contract.VERSION(), contract.authorizer(), contract.recoveryAuthorizer(), contract.recoveryRecipient(), contract.delay(), provider.getBalance(c.address), contract.domainSeparator(), contract.authorityEpoch(), contract.paused()
  ]);
  if (name !== EXPECTED_NAME || !VERSION_PATTERN.test(version)) throw new Error(`Interface response mismatch. Expected “${EXPECTED_NAME}” with version 1:<epoch>. This check does not verify code identity.`);
  const expectedDomain = ethers.TypedDataEncoder.hashDomain({name,version,chainId:network.chainId,verifyingContract:c.address});
  if (onchainDomain.toLowerCase() !== expectedDomain.toLowerCase()) throw new Error('Reported EIP-712 domain is internally inconsistent.');
  state={provider,contract,address:ethers.getAddress(c.address),chainId:network.chainId,source,data:{name,version,authorizer,recoveryAuthorizer,recoveryRecipient,delay,balance,onchainDomain,authorityEpoch,paused},tab:'status'};
  localStorage.setItem('safumode-config', JSON.stringify(c));
  $('#configuration').hidden=true; $('#live-panel').hidden=false;
  $('#connection-label').textContent=`UNVERIFIED CONTRACT · CHAIN ${network.chainId} · READ ONLY`;
  document.querySelectorAll('[data-panel]').forEach(b=>b.classList.toggle('selected',b.dataset.panel==='status'));
  render();
}
function statusView() { const d=state.data; return `<span class="panel-label">UNVERIFIED ON-CHAIN PREVIEW</span><h3>${esc(d.name)}</h3>
  <div class="danger-note"><strong>Contract identity is not verified.</strong> A user-supplied RPC and matching interface responses cannot prove deployed code identity. No independently pinned deployment manifest or bytecode hash exists, so every signing flow is disabled.</div>
  <dl class="state-list"><div><dt>Vault / chain</dt><dd title="${state.address}">${short(state.address)} · ${state.chainId}</dd></div><div><dt>Native balance</dt><dd>${ethers.formatEther(d.balance)} native</dd></div><div><dt>Paused</dt><dd>${d.paused?'YES — all outflows blocked':'NO'}</dd></div><div><dt>Authority epoch</dt><dd>${d.authorityEpoch}</dd></div><div><dt>Withdrawal authorizer</dt><dd title="${d.authorizer}">${short(d.authorizer)}</dd></div><div><dt>Recovery authorizer</dt><dd title="${d.recoveryAuthorizer}">${short(d.recoveryAuthorizer)}</dd></div><div><dt>Fixed recovery recipient</dt><dd title="${d.recoveryRecipient}">${short(d.recoveryRecipient)}</dd></div><div><dt>Exit delay</dt><dd>${d.delay} seconds</dd></div><div><dt>EIP-712 domain (unverified)</dt><dd title="${d.onchainDomain}">${short(d.onchainDomain)}</dd></div></dl>
  <p class="fineprint">Values above are untrusted direct RPC responses, not proof of code identity. The recovery authority can pause, recover only to the fixed recipient, cancel pending withdrawals, co-approve trust/rotation, and veto a pending rotation. Either authority may pause; both must sign to resume and to schedule rotation.</p>`; }
function recipientView() { return `<span class="panel-label">DIRECT CONTRACT LOOKUP</span><h3>Check recipient policy</h3><label>Recipient address<input id="recipient-address" spellcheck="false" placeholder="0x…"></label><div class="tool-actions"><button id="check-recipient" class="primary small">Read state</button></div><div id="recipient-result"></div>`; }
function activityView() { return `<span class="panel-label">ON-CHAIN EVENT LOG</span><h3>Recent vault activity</h3><p class="fineprint">Queries up to the latest 50,000 blocks from the connected RPC. This is not continuous monitoring and RPC providers may limit history.</p><button class="primary small" id="load-events">Query events</button><div id="events-result"></div>`; }
function signView() { return `<span class="panel-label">SIGNING DISABLED</span><h3>No trusted deployment manifest</h3><div class="danger-note"><strong>Do not sign.</strong> Signing remains disabled until this application independently pins a deployment chain, address, and bytecode hash in a reviewed manifest. RPC responses cannot establish contract identity.</div><div class="tool-actions"><button class="primary small" disabled>Wallet signing unavailable</button></div>`; }
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
