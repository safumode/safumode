// Illustrative states only. No wallet, RPC, or deployed vault is connected.
const views = {
  overview: `<span class="panel-label">LOCAL INTERFACE STUDY · SAMPLE DATA</span><h3>Vault policy concept</h3><div class="metrics"><div class="metric"><small>FUNDING WALLET</small><b>Deposit only</b></div><div class="metric"><small>AUTHORIZER</small><b>Signs exits</b></div><div class="metric"><small>RECOVERY SIGNER</small><b>Can cancel pending exits</b></div></div><div class="notice-row"><span>NO LIVE VAULT CONNECTED</span><span>DEMO</span></div>`,
  keys: `<span class="panel-label">AUTHORITY MAP · SAMPLE DATA</span><h3>Key roles</h3><div class="metrics"><div class="metric"><small>FUND</small><b>Everyday wallet</b></div><div class="metric"><small>WITHDRAW</small><b>Separate authorizer</b></div><div class="metric"><small>CANCEL / RECOVER</small><b>Recovery signer</b></div></div><div class="notice-row"><span>AUTHORITIES ARE IMMUTABLE IN THE CURRENT PROTOTYPE</span><span>LIMITATION</span></div>`,
  recipients: `<span class="panel-label">DESTINATION POLICY · SAMPLE DATA</span><h3>Trusted recipients</h3><div class="metrics"><div class="metric"><small>TRUST ADD</small><b>Two signatures</b></div><div class="metric"><small>ACTIVATION</small><b>Delayed</b></div><div class="metric"><small>REVOCATION</small><b>Immediate</b></div></div><div class="notice-row"><span>NO ACTUAL RECIPIENT ADDRESSES OR DELAY ARE CONFIGURED HERE</span><span>DEMO</span></div>`,
  activity: `<span class="panel-label">SECURITY LOG · SAMPLE DATA</span><h3>Recent activity</h3><div class="metrics"><div class="metric"><small>ON-CHAIN VAULT</small><b>None connected</b></div><div class="metric"><small>TRANSACTIONS</small><b>None shown</b></div><div class="metric"><small>MONITORING</small><b>Not implemented</b></div></div><div class="notice-row"><span>THIS PREVIEW CONTAINS NO LIVE ACTIVITY</span><span>DEMO</span></div>`
};
const panel = document.querySelector('#panel');
const buttons = document.querySelectorAll('[data-panel]');
function show(name) {
  panel.innerHTML = views[name];
  buttons.forEach(button => button.classList.toggle('selected', button.dataset.panel === name));
}
buttons.forEach(button => button.addEventListener('click', () => show(button.dataset.panel)));
show('overview');
const dialog = document.querySelector('#notice');
document.querySelector('[data-open-dialog]').addEventListener('click', () => dialog.showModal());
document.querySelectorAll('[data-close-dialog], .dialog-close').forEach(button => button.addEventListener('click', () => dialog.close()));
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
