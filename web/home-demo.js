// Illustrative decision table. No wallet, RPC, simulation of funds, or signing.
(() => {
  const demo = document.querySelector('[data-home-demo]');
  if (!demo) return;
  const cases = {
    daily: { result: 'blocked', actor: 'Daily wallet', authority: 'No withdrawal authority', check: 'WRONG KEY', destination: 'Any address', destinationNote: 'No valid withdrawal signature', verdict: 'BLOCKED', explanation: 'Putting money in does not give your daily wallet permission to take it out. A thief with only that wallet hits the same wall.' },
    trusted: { result: 'released', actor: 'Separate authorizer', authority: 'Signs this exact withdrawal', check: 'VALID + TRUSTED', destination: 'Already trusted address', destinationNote: 'Approved by both authorities earlier', verdict: 'CAN LEAVE NOW', explanation: 'With a valid authorizer signature, a recipient already trusted in the current authority epoch can receive the signed amount immediately.' },
    new: { result: 'waiting', actor: 'Separate authorizer', authority: 'Signs this exact withdrawal', check: 'VALID + NEW', destination: 'New address', destinationNote: 'Not on the trusted list', verdict: 'MUST WAIT', explanation: 'A valid request is queued for the vault’s configured delay. Either authority can cancel it before execution. Nothing moves automatically when the timer ends.' },
    recovery: { result: 'recovery', actor: 'Recovery authority', authority: 'Signs a recovery request', check: 'FIXED EXIT', destination: 'Fixed recovery address', destinationNote: 'Chosen when the vault was created', verdict: 'FIXED DESTINATION', explanation: 'The recovery key can send compatible assets immediately, but only to the recovery address fixed at deployment. It cannot choose a new recipient.' }
  };
  const buttons = [...demo.querySelectorAll('[data-demo-option]')];
  for (const button of buttons) button.addEventListener('click', () => {
    const entry = cases[button.dataset.demoOption];
    demo.dataset.result = entry.result;
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'result') continue;
      demo.querySelector(`[data-demo-${key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())}]`).textContent = value;
    }
    for (const other of buttons) other.setAttribute('aria-pressed', String(button === other));
  });
})();
