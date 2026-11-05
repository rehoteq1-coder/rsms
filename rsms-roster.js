/* Canonical roster eligibility used by school and platform dashboards. */
(function(root){
  'use strict';
  function records(value,kind){
    var items=Array.isArray(value)?value:(value && typeof value==='object'?Object.values(value):[]);
    return items.filter(function(x){
      if(!x || typeof x!=='object' || Array.isArray(x) || !x.id) return false;
      if(kind==='staff') return String(x.name||'').trim()!=='';
      return String(x.surname||'').trim()!=='' || String(x.firstname||'').trim()!=='';
    });
  }
  root.RSMSRoster={records:records,count:function(value,kind){return records(value,kind).length;}};
})(typeof window!=='undefined'?window:globalThis);
