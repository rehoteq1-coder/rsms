'use strict';

/* ═══════════════════════════════════════════════════════════════
   RSMS EMAIL — result delivery via server-side provider
   One mail_queue entry = one school-scoped email to one parent.
   Provider today: Resend (https://resend.com) via its HTTP API;
   SendGrid is supported with the same shape for future switch-over.
   Secrets: per-school Secret Manager secret `rsms-email-<school>` or
   platform env RESEND_API_KEY / SENDGRID_API_KEY / EMAIL_API_KEY.
   No secret ever touches the database or logs.
   Pure helpers here; RTDB I/O lives in index.js.
═══════════════════════════════════════════════════════════════════ */

var crypto = require('crypto');

var clientOverride = null;

function makeClient(){
  var SecretManagerService = require('@google-cloud/secret-manager').SecretManagerServiceClient;
  // v5 exposes SecretManagerServiceClient; older name SecretManagerService also works
  try { return new SecretManagerService(); } catch(e) {
    var SM = require('@google-cloud/secret-manager').SecretManagerService;
    return new SM();
  }
}
function getClient(){ return clientOverride || makeClient(); }
function setClientForTesting(c){ clientOverride = c; }

function projectId(){
  var id = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';
  if(!id) throw new Error('Cloud project id is not available.');
  return id;
}

function sanitiseSchoolId(schoolId){
  return String(schoolId || '').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}
function emailSecretName(schoolId){
  var id = sanitiseSchoolId(schoolId);
  if(!id) throw new Error('Invalid school id.');
  return 'rsms-email-' + id;
}
function fullEmailSecretName(schoolId){
  return 'projects/' + projectId() + '/secrets/' + emailSecretName(schoolId);
}
function isMissing(error){
  var code = error && (error.code || error.status);
  if(String(code) === '5') return true;
  return /not.?found|does not exist|secret not found/i.test(String((error && error.message) || ''));
}
function isValidEmail(email){
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || '').trim());
}
function cleanText(value, max){
  return String(value === undefined || value === null ? '' : value).replace(/^\s+|\s+$/g,'').slice(0, max || 400);
}
function escapeHtml(s){
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function isValidFromAddress(value){
  // Very permissive — Resend validates domain ownership on send
  var v = String(value||'').trim();
  if(!v) return false;
  // allow "Name <email@domain>" or "email@domain"
  var m = v.match(/<([^>]+)>/);
  var email = m ? m[1] : v;
  return isValidEmail(email);
}
function defaultFrom(schoolInfo, emailConfig){
  if(emailConfig && emailConfig.from && isValidFromAddress(emailConfig.from)) return emailConfig.from.trim();
  var name = cleanText((schoolInfo && (schoolInfo.name || schoolInfo.schoolName)) || 'RSMS', 60) || 'RSMS';
  // Use platform-verified domain; per-school domains can be set via email_config.from
  var domain = 'rehoteq.com';
  var local = sanitiseSchoolId((schoolInfo && schoolInfo.schoolId) || 'rsms') || 'noreply';
  // Resend requires a verified domain — noreply@rehoteq.com is the safe default
  return name + ' <noreply@' + domain + '>';
}

// ── HTML builder — branded, mobile-friendly, single-column ───────
function buildResultHtml(opts){
  opts = opts || {};
  var studentName = escapeHtml(opts.studentName || 'Student');
  var className = escapeHtml(opts.className || '');
  var reg = escapeHtml(opts.reg || '');
  var term = escapeHtml(opts.term || 'Term');
  var session = escapeHtml(opts.session || '');
  var schoolName = escapeHtml(opts.schoolName || 'Your School');
  var schoolAddress = escapeHtml(opts.schoolAddress || '');
  var schoolPhone = escapeHtml(opts.schoolPhone || '');
  var schoolEmail = escapeHtml(opts.schoolEmail || '');
  var portalLink = opts.portalLink || '#';
  var resultsLink = opts.resultsLink || portalLink;
  var logoUrl = opts.logoUrl || '';
  var year = new Date().getFullYear();

  var logoHtml = logoUrl ? '<img src="'+escapeHtml(logoUrl)+'" alt="'+schoolName+'" width="72" height="72" style="width:72px;height:72px;object-fit:contain;border-radius:10px;display:block;margin:0 auto 10px;" />' : '<div style="width:72px;height:72px;border-radius:10px;background:#f1f5ff;display:flex;align-items:center;justify-content:center;margin:0 auto 10px;font-size:28px;">&#127979;</div>';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>body{margin:0;padding:0;background:#f8fafc;font-family:Outfit,Arial,sans-serif;color:#0f172a;}'
    + 'a{color:#0ea5e9;text-decoration:none;} .btn{display:inline-block;background:#d4a843;color:#000;padding:12px 22px;border-radius:10px;font-weight:700;text-decoration:none;}'
    + '</style></head><body style="margin:0;padding:0;background:#f8fafc;">'
    + '<div style="max-width:560px;margin:0 auto;padding:24px 16px;">'
    + '<div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">'
    + '<div style="background:linear-gradient(135deg,#0f1535,#1a2347);padding:22px 20px;text-align:center;">'
    + logoHtml
    + '<div style="color:#fff;font-family:Fraunces,serif;font-size:18px;font-weight:800;margin-top:6px;">'+schoolName+'</div>'
    + (schoolAddress?'<div style="color:rgba(255,255,255,.6);font-size:12px;margin-top:4px;">'+schoolAddress+'</div>':'')
    + '<div style="display:inline-block;margin-top:12px;background:rgba(255,255,255,.14);color:#d4a843;border:1px solid rgba(212,168,67,.25);border-radius:20px;padding:5px 12px;font-size:12px;font-weight:700;">'+term+' &middot; '+session+'</div>'
    + '</div>'
    + '<div style="padding:22px 20px;">'
    + '<h1 style="margin:0 0 6px;font-size:18px;color:#0f1535;">Result is ready for '+studentName+'</h1>'
    + '<p style="margin:0 0 14px;color:#475569;font-size:14px;line-height:1.6;">Class: <strong>'+className+'</strong> &middot; Reg: <strong>'+reg+'</strong><br>'+term+' ('+session+') has been published.</p>'
    + '<div style="text-align:center;margin:18px 0;">'
    + '<a class="btn" href="'+escapeHtml(resultsLink)+'" target="_blank" rel="noopener">View Report Card</a>'
    + '</div>'
    + '<div style="background:#f1f5ff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin:14px 0;">'
    + '<div style="font-size:12px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">Parent Portal (all terms, fees &amp; assignments)</div>'
    + '<a href="'+escapeHtml(portalLink)+'" style="word-break:break-all;font-size:13px;">'+escapeHtml(portalLink)+'</a>'
    + '</div>'
    + '<p style="color:#64748b;font-size:12px;line-height:1.6;margin:14px 0 0;">You can also log in to the Parent Portal with your phone number to view all terms.<br>If the button does not open, copy and paste either link into your browser.</p>'
    + '</div>'
    + '<div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:14px 20px;text-align:center;">'
    + '<div style="font-size:12px;color:#64748b;">'+schoolName+' via RSMS &mdash; Rehoteq School Management System</div>'
    + (schoolPhone?'<div style="font-size:12px;color:#94a3b8;margin-top:4px;">Tel: '+schoolPhone+'</div>':'')
    + (schoolEmail?'<div style="font-size:12px;color:#94a3b8;">Email: '+schoolEmail+'</div>':'')
    + '<div style="font-size:11px;color:#cbd5e1;margin-top:10px;">&copy; '+year+' Rehoteq Technologies</div>'
    + '</div>'
    + '</div>'
    + '<div style="text-align:center;color:#94a3b8;font-size:11px;margin-top:14px;padding:0 10px;">You received this because your email is on file for '+studentName+'. If this was sent in error, please contact the school.</div>'
    + '</div></body></html>';
}
function buildResultText(opts){
  opts = opts || {};
  var lines = [
    'Dear Parent/Guardian of '+(opts.studentName||'Student')+',',
    '',
    (opts.schoolName||'Your school')+' has published the '+(opts.term||'Term')+' ('+(opts.session||'')+') result for '+(opts.studentName||'Student')+' — Class: '+(opts.className||'')+' — Reg: '+(opts.reg||'')+'.',
    '',
    'View the report card:',
    opts.resultsLink || opts.portalLink || '',
    '',
    'Parent portal (fees, assignments & all results):',
    opts.portalLink || '',
    '',
    'You can also log in to the Parent Portal with your phone number to view all terms.',
    '',
    '-- '+(opts.schoolName||'School')+' via RSMS (Rehoteq School Management System)',
    opts.schoolPhone ? 'Tel: '+opts.schoolPhone : '',
    opts.schoolEmail ? 'Email: '+opts.schoolEmail : ''
  ].filter(Boolean);
  return lines.join('\n');
}

function resolveProvider(emailConfig){
  var p = String((emailConfig && emailConfig.provider) || 'resend').toLowerCase().trim();
  if(p === 'sendgrid' || p === 'sg') return 'sendgrid';
  return 'resend';
}

function apiKeyEnvName(provider){
  if(provider === 'sendgrid') return 'SENDGRID_API_KEY';
  return 'RESEND_API_KEY';
}

// Latest key value or '' when not configured
async function getPerSchoolApiKey(schoolId){
  var full = fullEmailSecretName(schoolId) + '/versions/latest';
  try {
    var client = getClient();
    var result = await client.accessSecretVersion({name: full});
    var version = result && result[0];
    var payload = version && version.payload;
    var data = payload && payload.data;
    if(!data) return '';
    var text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    // Secret Manager client sometimes returns base64 already decoded; ensure string
    return text.trim();
  } catch(e){
    if(isMissing(e)) return '';
    throw e;
  }
}
async function resolveApiKey(schoolId, provider){
  provider = provider === 'sendgrid' ? 'sendgrid' : 'resend';
  var perSchool = '';
  try { perSchool = await getPerSchoolApiKey(schoolId); } catch(e){ throw e; }
  if(perSchool) return perSchool;
  var envName = apiKeyEnvName(provider);
  var envVal = String(process.env[envName] || process.env.EMAIL_API_KEY || process.env.RESEND_API_KEY || process.env.SENDGRID_API_KEY || '').trim();
  return envVal;
}

async function createEmailSecret(schoolId, apiKey){
  var client = getClient();
  var parent = 'projects/' + projectId();
  var secretId = emailSecretName(schoolId);
  var full = 'projects/' + projectId() + '/secrets/' + secretId;
  // create secret if missing
  var exists = false;
  try {
    var check = await client.getSecret({name: full});
    if(check && check[0]) exists = true;
  } catch(e){ if(!isMissing(e)) throw e; }
  if(!exists){
    await client.createSecret({parent: parent, secretId: secretId, secret: {replication:{automatic:{}}}});
  }
  await client.addSecretVersion({parent: full, payload:{data: Buffer.from(String(apiKey),'utf8')}});
  return full;
}
async function hasEmailSecret(schoolId){
  var key = await getPerSchoolApiKey(schoolId);
  return !!key;
}
async function revokeEmailSecret(schoolId){
  var client = getClient();
  var full = fullEmailSecretName(schoolId);
  try {
    await client.deleteSecret({name: full});
    return true;
  } catch(e){
    if(isMissing(e)) return false;
    // fallback: disable if delete not allowed
    try {
      await client.disableSecret ? await client.disableSecret({name: full}) : null;
      return true;
    } catch(e2){ if(isMissing(e2)) return false; throw e2; }
  }
}

// ── Provider send ──────────────────────────────────────────
async function sendViaResend(args){
  var to = cleanText(args.to, 320);
  var subject = cleanText(args.subject, 500);
  var from = String(args.from||'').trim();
  var replyTo = args.replyTo ? String(args.replyTo).trim() : '';
  var html = String(args.html||'');
  var text = String(args.text||'');
  var apiKey = String(args.apiKey||'').trim();
  if(!isValidEmail(to)) throw new Error('Invalid recipient email');
  if(!subject) throw new Error('Subject is required');
  if(!apiKey) throw new Error('Email provider key is not configured');
  if(!from) from = 'RSMS <noreply@rehoteq.com>';
  var body = {from: from, to: [to], subject: subject};
  if(html) body.html = html;
  if(text) body.text = text;
  if(!html && !text) body.text = subject;
  if(replyTo && isValidEmail(replyTo)) body.reply_to = replyTo;
  // Resend idempotency not needed per mail_queue pushId
  var res = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{'Authorization':'Bearer '+apiKey, 'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  var json = await res.json().catch(function(){ return {}; });
  if(!res.ok){
    var msg = (json && (json.message || json.error || JSON.stringify(json))) || ('HTTP '+res.status);
    throw new Error('Resend failed: '+msg);
  }
  return {id: json.id || '', provider:'resend', raw: json};
}
async function sendViaSendGrid(args){
  var to = cleanText(args.to, 320);
  var subject = cleanText(args.subject, 500);
  var from = String(args.from||'').trim();
  var replyTo = args.replyTo ? String(args.replyTo).trim() : '';
  var html = String(args.html||'');
  var text = String(args.text||'');
  var apiKey = String(args.apiKey||'').trim();
  if(!isValidEmail(to)) throw new Error('Invalid recipient email');
  if(!subject) throw new Error('Subject is required');
  if(!apiKey) throw new Error('SendGrid key is not configured');
  if(!from) from = 'RSMS <noreply@rehoteq.com>';
  // parse from "Name <email>"
  var fromEmail = from, fromName = '';
  var m = from.match(/^(.*)<([^>]+)>\s*$/);
  if(m){ fromName = m[1].trim().replace(/^"|"$/g,''); fromEmail = m[2].trim(); }
  var payload = {
    personalizations:[{to:[{email:to}]}],
    from:{email:fromEmail, name:fromName || undefined},
    subject: subject,
    content:[]
  };
  if(text) payload.content.push({type:'text/plain', value:text});
  if(html) payload.content.push({type:'text/html', value:html});
  if(!payload.content.length) payload.content.push({type:'text/plain', value:subject});
  if(replyTo && isValidEmail(replyTo)) payload.reply_to = {email: replyTo};
  var res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method:'POST',
    headers:{'Authorization':'Bearer '+apiKey, 'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  if(!res.ok){
    var txt = await res.text().catch(function(){return '';});
    throw new Error('SendGrid failed: HTTP '+res.status+' '+txt.slice(0,500));
  }
  return {id: res.headers.get('x-message-id') || '', provider:'sendgrid'};
}
async function sendEmail(args){
  var provider = String(args.provider||'resend').toLowerCase() === 'sendgrid' ? 'sendgrid' : 'resend';
  if(provider === 'sendgrid') return sendViaSendGrid(args);
  return sendViaResend(args);
}

module.exports = {
  isValidEmail:isValidEmail,
  isValidFromAddress:isValidFromAddress,
  sanitiseSchoolId:sanitiseSchoolId,
  emailSecretName:emailSecretName,
  fullEmailSecretName:fullEmailSecretName,
  buildResultHtml:buildResultHtml,
  buildResultText:buildResultText,
  defaultFrom:defaultFrom,
  resolveProvider:resolveProvider,
  apiKeyEnvName:apiKeyEnvName,
  getPerSchoolApiKey:getPerSchoolApiKey,
  resolveApiKey:resolveApiKey,
  createEmailSecret:createEmailSecret,
  hasEmailSecret:hasEmailSecret,
  revokeEmailSecret:revokeEmailSecret,
  sendViaResend:sendViaResend,
  sendViaSendGrid:sendViaSendGrid,
  sendEmail:sendEmail,
  setClientForTesting:setClientForTesting
};
