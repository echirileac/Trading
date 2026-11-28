// Edison Growth as a home-screen app (iPhone, iPad, Android): offline worker + a one-time "Add to Home Screen" hint on iOS Safari.
(function () {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => { /* the site works without it */ }); });
  }

  const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  document.documentElement.classList.toggle('is-app', standalone);

  // iOS has no install prompt, so say how once. Only in Safari on iPhone/iPad (other iOS browsers say "CriOS", "FxiOS"…).
  const ua = navigator.userAgent;
  const ios = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);
  let seen = false; try { seen = localStorage.getItem('app-hint') === 'done'; } catch (e) { /* private mode */ }
  if (standalone || !ios || !safari || seen) return;

  const bar = document.querySelector('.eg-bar');
  if (!bar) return;
  const hint = document.createElement('div');
  hint.className = 'app-hint';
  hint.setAttribute('role', 'note');
  hint.innerHTML =
    '<img src="apple-touch-icon.png" alt="" width="40" height="40">' +
    '<p><b>Install Edison as an app</b><span>Tap <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-label="Share"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/></svg> Share, then <b>Add to Home Screen</b>. It opens full screen with its own icon.</span></p>' +
    '<button type="button" class="btn icon" aria-label="Hide this tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>';
  hint.querySelector('button').addEventListener('click', () => {
    hint.remove();
    try { localStorage.setItem('app-hint', 'done'); } catch (e) { /* this visit only */ }
  });
  bar.after(hint);
})();
