/*  ═══════════════════════════════════════════════════════
    RSMS PWA Initialization  —  rsms-pwa.js
    Include in every portal page to enable PWA features.
    ═══════════════════════════════════════════════════════ */

(function() {
  'use strict';

  var deferredPrompt = null;
  var banner = null;

  /* ── 1. Inject manifest link if missing ───────────── */

  if (!document.querySelector('link[rel="manifest"]')) {
    var link = document.createElement('link');
    link.rel = 'manifest';
    link.href = 'manifest.json';
    document.head.appendChild(link);
  }

  /* ── 2. Inject meta tags if missing ───────────────── */

  function ensureMeta(name, content) {
    if (!document.querySelector('meta[name="' + name + '"]')) {
      var meta = document.createElement('meta');
      meta.name = name;
      meta.content = content;
      document.head.appendChild(meta);
    }
  }

  ensureMeta('theme-color', '#030305');
  ensureMeta('apple-mobile-web-app-capable', 'yes');
  ensureMeta('apple-mobile-web-app-title', 'RSMS');

  /* ── 3. Register service worker ───────────────────── */

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
      navigator.serviceWorker.register('sw.js', { scope: './' })
        .then(function(reg) {
          console.log('[RSMS-PWA] Service worker registered, scope:', reg.scope);
          // Check for updates every hour
          setInterval(function() { reg.update(); }, 3600000);
        })
        .catch(function(err) {
          console.warn('[RSMS-PWA] Service worker registration failed:', err);
        });
    });
  }

  /* ── 4. Initialize the optional offline foundation safely ─ */

  function initializeOfflineFoundation() {
    // The foundation is opt-in: it is initialized only when rsms-sync.js was
    // explicitly included by a page. It does not start, schedule, or send sync.
    if (!window.RSMS_SYNC || typeof window.RSMS_SYNC.initialize !== 'function') return;
    window.RSMS_SYNC.initialize().catch(function(err) {
      console.warn('[RSMS-PWA] Offline foundation unavailable:', err && err.message ? err.message : err);
    });
  }

  if (document.readyState === 'complete') {
    initializeOfflineFoundation();
  } else {
    window.addEventListener('load', initializeOfflineFoundation);
  }

  /* ── 5. Capture beforeinstallprompt ────────────────── */

  window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    deferredPrompt = e;
    showInstallBanner();
  });

  /* ── 6. Install banner ────────────────────────────── */

  function createBannerStyles() {
    if (document.getElementById('rsms-pwa-banner-styles')) return;
    var style = document.createElement('style');
    style.id = 'rsms-pwa-banner-styles';
    style.textContent = [
      '#rsms-install-banner{',
      '  position:fixed;bottom:0;left:0;right:0;z-index:99999;',
      '  background:#0d0f1a;border-top:1px solid rgba(212,168,67,.25);',
      '  box-shadow:0 -4px 24px rgba(0,0,0,.5);',
      '  padding:14px 20px;display:flex;align-items:center;',
      '  justify-content:space-between;gap:12px;',
      '  font-family:Outfit,system-ui,sans-serif;',
      '  transform:translateY(100%);',
      '  transition:transform .4s cubic-bezier(.22,1,.36,1);',
      '}',
      '#rsms-install-banner.rsms-banner-visible{',
      '  transform:translateY(0);',
      '}',
      '#rsms-install-banner .rsms-banner-text{',
      '  flex:1;color:rgba(240,242,255,.85);font-size:.92rem;font-weight:500;',
      '}',
      '#rsms-install-banner .rsms-banner-install{',
      '  background:#d4a843;color:#030305;border:none;padding:9px 22px;',
      '  border-radius:8px;font-family:Outfit,sans-serif;font-size:.88rem;',
      '  font-weight:600;cursor:pointer;white-space:nowrap;',
      '  transition:background .2s;',
      '}',
      '#rsms-install-banner .rsms-banner-install:hover{',
      '  background:#e2b94f;',
      '}',
      '#rsms-install-banner .rsms-banner-close{',
      '  background:none;border:none;color:rgba(240,242,255,.4);',
      '  font-size:1.2rem;cursor:pointer;padding:4px 8px;line-height:1;',
      '  transition:color .2s;',
      '}',
      '#rsms-install-banner .rsms-banner-close:hover{',
      '  color:rgba(240,242,255,.8);',
      '}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function showInstallBanner() {
    // Don't show if already installed or dismissed this session
    if (isStandalone()) return;
    if (sessionStorage.getItem('rsms-banner-dismissed')) return;
    if (banner) return;

    createBannerStyles();

    banner = document.createElement('div');
    banner.id = 'rsms-install-banner';
    banner.setAttribute('role', 'alert');

    var text = document.createElement('span');
    text.className = 'rsms-banner-text';
    text.textContent = '\uD83D\uDCF2 Install RSMS';

    var installBtn = document.createElement('button');
    installBtn.className = 'rsms-banner-install';
    installBtn.textContent = 'Install';
    installBtn.addEventListener('click', function() {
      triggerInstall();
    });

    var closeBtn = document.createElement('button');
    closeBtn.className = 'rsms-banner-close';
    closeBtn.textContent = '\u2715';
    closeBtn.setAttribute('aria-label', 'Dismiss install banner');
    closeBtn.addEventListener('click', function() {
      dismissBanner();
    });

    banner.appendChild(text);
    banner.appendChild(installBtn);
    banner.appendChild(closeBtn);
    document.body.appendChild(banner);

    // Trigger slide-up animation after append
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        banner.classList.add('rsms-banner-visible');
      });
    });
  }

  function dismissBanner() {
    if (banner) {
      banner.classList.remove('rsms-banner-visible');
      setTimeout(function() {
        if (banner && banner.parentNode) {
          banner.parentNode.removeChild(banner);
        }
        banner = null;
      }, 400);
    }
    sessionStorage.setItem('rsms-banner-dismissed', '1');
  }

  function triggerInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function(choice) {
      if (choice.outcome === 'accepted') {
        console.log('[RSMS-PWA] App installed');
      }
      deferredPrompt = null;
      dismissBanner();
    });
  }

  /* ── 7. Expose window.RSMS_PWA ────────────────────── */

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.navigator.standalone === true;
  }

  window.RSMS_PWA = {
    canInstall: function() {
      return !!deferredPrompt;
    },
    install: function() {
      triggerInstall();
    },
    isInstalled: function() {
      return isStandalone();
    }
  };

  /* ── 8. Listen for appinstalled ───────────────────── */

  window.addEventListener('appinstalled', function() {
    console.log('[RSMS-PWA] App was installed');
    deferredPrompt = null;
    dismissBanner();
  });

})();
