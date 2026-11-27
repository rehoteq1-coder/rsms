/* RSMS password visibility toggle
   Adds a show/hide (eye) button to every <input type="password">,
   including ones created dynamically later. Self-contained, no deps. */
(function () {
  'use strict';
  var CSS_ID = 'rsms-pw-toggle-css';
  var CSS = ''
    + '.rsms-pw-wrap{position:relative;display:block;}'
    + '.rsms-pw-eye{position:absolute;right:8px;top:50%;transform:translateY(-50%);'
    + 'background:none;border:none;padding:2px 4px;margin:0;cursor:pointer;'
    + 'font-size:15px;line-height:1;opacity:.55;z-index:2;user-select:none;'
    + '-webkit-user-select:none;outline:none;}'
    + '.rsms-pw-eye:hover,.rsms-pw-eye:focus-visible{opacity:1;}';

  function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    var s = document.createElement('style');
    s.id = CSS_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function enhance(input) {
    if (!input || input.dataset.pwToggleApplied) return;
    if (input.type !== 'password') return;
    var parent = input.parentNode;
    if (!parent) return;

    var wrap = document.createElement('span');
    wrap.className = 'rsms-pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    // Keep text clear of the button on left-aligned fields; centred
    // fields (PIN pads) stay centred because PINs are short.
    var cs = window.getComputedStyle ? window.getComputedStyle(input) : null;
    if (!cs || cs.textAlign !== 'center') {
      input.style.paddingRight = '42px';
    }

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rsms-pw-eye';
    btn.setAttribute('aria-label', 'Show password');
    btn.setAttribute('aria-pressed', 'false');
    btn.tabIndex = 0;
    btn.textContent = '\u{1F441}'; // eye

    btn.addEventListener('click', function () {
      var showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? '\u{1F441}' : '\u{1F648}'; // eye / see-no-evil
      btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      btn.setAttribute('aria-pressed', showing ? 'false' : 'true');
      input.focus({ preventScroll: true });
      var v = input.value;
      try { input.setSelectionRange(v.length, v.length); } catch (e) {}
    });

    wrap.appendChild(btn);
    input.dataset.pwToggleApplied = '1';
  }

  function scan(root) {
    ensureCss();
    var list = (root || document).querySelectorAll('input[type="password"]');
    for (var i = 0; i < list.length; i++) enhance(list[i]);
  }

  function start() {
    scan(document);

    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (!n || n.nodeType !== 1) continue;
          if (n.tagName === 'INPUT') { enhance(n); continue; }
          if (n.querySelectorAll) {
            var inner = n.querySelectorAll('input[type="password"]');
            for (var k = 0; k < inner.length; k++) enhance(inner[k]);
          }
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
