(() => {
  function hideLegacySMTP() {
    const headings = [...document.querySelectorAll('h1,h2')];
    const inAlerts = headings.some((h) => /alertas/i.test(h.textContent || ''));
    if (!inAlerts) return;
    [...document.querySelectorAll('button')].forEach((btn) => {
      if ((btn.textContent || '').trim().toLowerCase() === 'smtp') {
        btn.style.display = 'none';
      }
    });
  }
  new MutationObserver(hideLegacySMTP).observe(document.documentElement, { childList:true, subtree:true });
  setInterval(hideLegacySMTP, 1500);
  hideLegacySMTP();
})();
