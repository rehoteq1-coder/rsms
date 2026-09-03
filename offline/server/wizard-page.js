'use strict';

/* First-run network wizard page (Phase C). Served at /wizard.html. */
module.exports =
  '<!doctype html><meta charset="utf-8"><title>RSMS — First-run setup</title>' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e8eaf2;margin:0;padding:24px;max-width:860px}' +
  'h1{font-size:1.2rem}h2{font-size:.95rem;margin:26px 0 8px;color:#8b93a7}' +
  'ol.steps{color:#8b93a7;font-size:.8rem;list-style:none;padding:0;margin:10px 0}' +
  'ol.steps li{margin:2px 0}ol.steps li.done::before{content:"✓ ";color:#86efac}' +
  'ol.steps li.active::before{content:"▸ ";color:#f59e0b}' +
  'ol.steps li:not(.done):not(.active)::before{content:"· "}' +
  'label{display:block;font-size:.8rem;color:#8b93a7;margin:10px 0 4px}' +
  'input,select{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #2a2f42;background:#12141d;color:#e8eaf2;font-size:.9rem}' +
  'button{margin-top:14px;padding:10px 18px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer}' +
  '.ok{color:#86efac}.err{color:#fca5a5}.dim{color:#8b93a7;font-size:.8rem}' +
  'table{border-collapse:collapse;font-size:.85rem}td,th{border:1px solid #262a3a;padding:6px 10px;text-align:left}' +
  '#qr{margin:10px 0;display:inline-block;background:#fff;padding:8px;border-radius:8px}' +
  'code{background:#12141d;padding:2px 6px;border-radius:4px;font-size:.8rem}</style>' +
  '<h1>🏫 RSMS first-run setup</h1>' +
  '<ol class="steps" id="steps">' +
  '<li id="s1" class="active">1 · Bind the school</li>' +
  '<li id="s2">2 · LAN address &amp; staff QR</li>' +
  '<li id="s3">3 · Backups</li>' +
  '<li id="s4">4 · Done</li></ol>' +
  '<div id="step"></div>' +
  '<input type="hidden" id="cur">' +
  '<p class="dim"><a href="/health" style="color:#8b93a7">health</a> · <a href="/staff-login.html" style="color:#8b93a7">staff login</a></p>' +
  '<script src="/vendor/qrcode.min.js"></script>' +
  '<script>' +
  'var info = null;' +
  'function esc(s){return String(s===null||s===undefined?"":s).replace(/[&<>]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}' +
  'function load(){' +
  '  fetch("/api/wizard/info").then(function(r){return r.json();}).then(function(d){' +
  '    info=d; render();' +
  '  }).catch(function(e){document.getElementById("step").innerHTML="<p class=err>Cannot reach the local API: "+esc(e)+"</p>";});' +
  '}' +
  'function render(){' +
  '  if(!info) return;' +
  '  var c=document.getElementById("cur");' +
  '  var cur=c?c.value:"";' +
  '  if(!info.binding||!info.binding.schoolCode) return renderBind();' +
  '  if(cur==="backup") return renderBackup();' +
  '  if(cur==="done") return renderDone();' +
  '  return renderLan();' +
  '}' +
  'function goto(stepName, refresh){var c=document.getElementById("cur");if(c)c.value=stepName;' +
  '  var n=stepName==="backup"?3:(stepName==="done"?4:2);' +
  '  for(var i=1;i<=4;i++){var el=document.getElementById("s"+i);el.className=i<n?"done":(i===n?"active":"");}' +
  '  if(refresh){ load(); } else { render(); }' +
  '}' +
  'function renderBind(){' +
  '  var c=document.getElementById("cur");if(c)c.value="bind";' +
  '  document.getElementById("step").innerHTML=' +
  '    "<h2>Bind this appliance to the school</h2>"+' +
  '    "<p class=dim>One install, one school. If the platform superadmin registered this school offline (runbook Stage 7b), enter the server token and cloud base URL and sync activates immediately. Otherwise enter the school code alone — sync stays paused until a token is provided.</p>"+' +
  '    "<label>School code *</label><input id=\\"sc\\" placeholder=\\"e.g. GREENVAL\\">"+' +
  '    "<label>School name</label><input id=\\"sn\\" placeholder=\\"e.g. Green Valley Secondary\\">"+' +
  '    "<label>Server token (optional, offline schools)</label><input id=\\"tok\\" placeholder=\\"rsms-offline-…\\">"+' +
  '    "<label>Cloud base URL (optional, offline schools)</label><input id=\\"cb\\" placeholder=\\"https://…cloudfunctions.net\\">"+' +
  '    "<p id=\\"bmsg\\"></p><button onclick=\\"doBind()\\">Bind</button>";' +
  '}' +
  'function doBind(){' +
  '  var body={schoolCode:document.getElementById("sc").value.trim()};' +
  '  var sn=document.getElementById("sn").value.trim(); if(sn) body.schoolName=sn;' +
  '  var tok=document.getElementById("tok").value.trim();' +
  '  var cb=document.getElementById("cb").value.trim();' +
  '  if(tok&&cb){body.serverToken=tok;body.cloudBaseUrl=cb;}' +
  '  document.getElementById("bmsg").innerHTML="<span class=dim>Binding…</span>";' +
  '  fetch("/api/setup/bind",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})' +
  '  .then(function(r){return r.json().then(function(j){return {s:r.status,j:j};});})' +
  '  .then(function(x){' +
  '    if(x.s===200){' +
  '      document.getElementById("bmsg").innerHTML="<span class=ok>Bound."+(x.j.cloudValidated?" Cloud sync active.":" Local-only (cloud validation pending).")+"</span>";' +
  '      goto("lan", true);' +
  '    } else document.getElementById("bmsg").innerHTML="<span class=err>"+esc(x.j.error||x.j.detail||"bind failed")+"</span>";' +
  '  }).catch(function(e){document.getElementById("bmsg").innerHTML="<span class=err>"+esc(e)+"</span>";});' +
  '}' +
  'function renderLan(){' +
  '  var rows=(info.lan||[]).map(function(l){' +
  '    return "<tr><td>"+esc(l.ip)+"</td><td>"+esc(l.mac||"—")+"</td><td>"+esc(l.portalUrl)+"</td></tr>";' +
  '  }).join("");' +
  '  var first=info.lan&&info.lan[0]?info.lan[0].portalUrl:"http://<LAN-IP>:"+info.port+"/";' +
  '  document.getElementById("step").innerHTML=' +
  '    "<h2>Staff access</h2>"+' +
  '    "<table><tr><th>LAN IP</th><th>MAC</th><th>Staff portal</th></tr>"+rows+"</table>"+' +
  '    "<p class=dim>Print this QR for the staff room. Phones/tablets on the school Wi-Fi can scan it to open the portal.</p>"+' +
  '    "<div id=\\"qr\\"></div>"+' +
  '    "<p class=dim><b>Important:</b> create a <b>DHCP reservation</b> for this PC (MAC above) at the school router so its IP never changes — otherwise every staff device loses the portal after the next reboot. Ask the ICT teacher to reserve the IP in the table.</p>"+' +
  '    "<p><button onclick=\\"goto(\'backup\')\\">Next: backups</button></p>";' +
  '  if(window.QRCode){new QRCode(document.getElementById("qr"),{text:first,width:180,height:180});}' +
  '}' +
  'function renderBackup(){' +
  '  var b=info.backup||{};' +
  '  document.getElementById("step").innerHTML=' +
  '    "<h2>Backups</h2>"+' +
  '    "<p class=dim>Verified nightly snapshots (keep the last <b>7 days</b> by default). Point the destination at a separate disk, USB stick or NAS share where possible.</p>"+' +
  '    "<label>Backup destination</label><input id=\\"bdir\\" value=\\""+esc(b.dir||"")+"\\">"+' +
  '    "<label>Keep last N days</label><input id=\\"bretain\\" type=\\"number\\" min=\\"2\\" max=\\"30\\" value=\\""+esc(b.retain||7)+"\\">"+' +
  '    "<p id=\\"bsg\\"></p>"+' +
  '    "<button onclick=\\"cfgBackup()\\">Save</button> "+' +
  '    "<button style=\\\"background:#059669\\\" onclick=\\\"firstBackup()\\\">Run first backup now</button> " +' +
  '    "<button onclick=\\\"goto(\'done\')\\\">Next: done</button>";' +
  '}' +
  'function cfgBackup(){' +
  '  fetch("/api/admin/backups/config",{method:"POST",headers:{"Content-Type":"application/json"},' +
  '    body:JSON.stringify({dir:document.getElementById("bdir").value,retain:document.getElementById("bretain").value})})' +
  '  .then(function(r){return r.json();}).then(function(j){' +
  '    document.getElementById("bsg").innerHTML=j.ok?"<span class=ok>Saved.</span>":"<span class=err>"+esc(j.error||"")+"</span>";' +
  '  }).catch(function(e){document.getElementById("bsg").innerHTML="<span class=err>"+esc(e)+"</span>";});' +
  '}' +
  'function firstBackup(){' +
  '  document.getElementById("bsg").innerHTML="<span class=dim>Creating verified backup…</span>";' +
  '  fetch("/api/admin/backup",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})' +
  '  .then(function(r){return r.json();}).then(function(j){' +
  '    document.getElementById("bsg").innerHTML=j.ok' +
  '      ?"<span class=ok>Backup "+esc(j.backup.name)+" verified ("+(j.backup.rows||0)+" rows, "+j.backup.createdAt+").</span>"' +
  '      :"<span class=err>"+esc(j.error||"")+"</span>";' +
  '  }).catch(function(e){document.getElementById("bsg").innerHTML="<span class=err>"+esc(e)+"</span>";});' +
  '}' +
  'function renderDone(){' +
  '  document.getElementById("step").innerHTML=' +
  '    "<h2>All set</h2>"+' +
  '    "<p class=ok>The server is ready for staff.</p>"+' +
  '    "<p class=dim>Daily operation: staff open the portal from the QR. The bursar watches <a href=\\"/health\\" style=\\"color:#8b93a7\\">/health</a> for sync state and <a href=\\"/conflicts.html\\" style=\\"color:#8b93a7\\">/conflicts.html</a> for money conflicts. For support, download the diagnostic bundle from <code>/api/admin/diag.download</code> (contains no secrets).</p>";' +
  '}' +
  'load();' +
  '</script></body>';
