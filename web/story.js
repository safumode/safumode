// Illustrated contract rules only. No wallet, RPC, or signing on these pages.
(() => {
  const flow = document.querySelector('[data-story="flow"]');
  if (flow) {
    const steps = [
      { title: 'Deposit', body: 'Anyone can put funds in. Paying for a deposit never gives that wallet permission to withdraw them.', status: 'FUNDS ENTER' },
      { title: 'The wrong key', body: 'The daily wallet tries to take funds out. The vault rejects it: this wallet is not the separate withdrawal signer.', status: 'EXIT BLOCKED' },
      { title: 'The separate key signs', body: 'The authorizer signs the exact asset, amount, and recipient. A Ledger could hold this key; this website does not connect to one.', status: 'SIGNATURE CHECKED' },
      { title: 'Release, or wait', body: 'An already trusted recipient can receive funds immediately. A new recipient must wait the configured delay; either authority can cancel the queued exit before it executes.', status: 'RULES DECIDE' }
    ];
    const buttons = [...flow.querySelectorAll('[data-step-button]')];
    let step = 0;
    let timer;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const setStep = (index) => {
      step = index;
      flow.dataset.step = String(index);
      flow.querySelector('[data-step-number]').textContent = String(index + 1).padStart(2, '0');
      flow.querySelector('[data-step-title]').textContent = steps[index].title;
      flow.querySelector('[data-step-body]').textContent = steps[index].body;
      flow.querySelector('[data-step-status]').textContent = steps[index].status;
      flow.querySelector('.walk-count').textContent = `${String(index + 1).padStart(2, '0')} / 04`;
      buttons.forEach((button, position) => button.setAttribute('aria-pressed', String(position === index)));
    };
    buttons.forEach((button, index) => button.addEventListener('click', () => { clearInterval(timer); setStep(index); }));
    if (!reduced.matches && 'IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && !timer) timer = setInterval(() => setStep((step + 1) % steps.length), 4200);
        else if (!entries[0].isIntersecting) { clearInterval(timer); timer = undefined; }
      }, { threshold: 0.3 });
      observer.observe(flow);
      // A manual choice stops autoplay until the walkthrough leaves and re-enters view.
      buttons.forEach(button => button.addEventListener('click', () => { observer.disconnect(); timer = undefined; }));
    }
  }
  const threat = document.querySelector('[data-story="threat"]');
  if (threat) {
    const scenarios = {
      daily: { input: 'Daily wallet stolen', result: 'Vault withdrawal blocked', badge: 'BOUNDARY HOLDS', body: 'The attacker can take funds still in the everyday wallet. But that wallet is not a withdrawal signer for the vault, even if it paid for the deposit.', caveat: 'This assumes the separate authority keys were not also exposed.' },
      authorizer: { input: 'Withdrawal key stolen', result: 'A valid exit can be signed', badge: 'ACT BEFORE THE WAIT ENDS', body: 'The attacker can withdraw immediately to an already trusted address, or schedule a withdrawal to a new address. The delay gives time to cancel only if someone detects the request and acts.', caveat: 'A trusted destination can be immediate. The delay is not an automatic rescue.' },
      recovery: { input: 'Recovery key stolen', result: 'Fixed recipient only', badge: 'DESTINATION CANNOT CHANGE', body: 'The attacker can move compatible assets immediately, but only to the recovery recipient fixed at deployment. The key alone cannot pick a different address.', caveat: 'If the fixed recipient is also compromised, recovered funds may reach the attacker.' },
      lost: { input: 'Authority key lost', result: 'Access can be lost', badge: 'NO ADMIN RESET', body: 'One surviving key has limited options while the vault is unpaused. If the vault is paused and either authority key is permanently lost, it cannot resume, rotate, or withdraw.', caveat: 'Losing the fixed recovery recipient can also make recovery funds inaccessible.' }
    };
    threat.querySelectorAll('[data-threat-button]').forEach(button => button.addEventListener('click', () => {
      const id = button.dataset.threatButton;
      const item = scenarios[id];
      threat.dataset.threat = id;
      for (const [field, value] of Object.entries(item)) threat.querySelector(`[data-threat-${field}]`).textContent = value;
      threat.querySelectorAll('[data-threat-button]').forEach(other => other.setAttribute('aria-pressed', String(button === other)));
    }));
  }
})();
