/* Canonical roster eligibility used by school and platform dashboards.
   Inspection is read-only and returns IDs/counts, never names or contact data. */
(function(root){
  'use strict';
  function rows(value){
    return Array.isArray(value)?value:(value && typeof value==='object'?Object.values(value):[]);
  }
  function records(value,kind){
    return rows(value).filter(function(x){
      if(!x || typeof x!=='object' || Array.isArray(x) || !x.id) return false;
      if(kind==='staff') return String(x.name||'').trim()!=='';
      return String(x.surname||'').trim()!=='' || String(x.firstname||'').trim()!=='';
    });
  }
  function inspect(value,kind){
    var all=rows(value),objects=all.filter(function(x){return x&&typeof x==='object'&&!Array.isArray(x);});
    var valid=records(value,kind),ids=Object.create(null),duplicates=[],missingId=0,missingName=0;
    objects.forEach(function(x){
      if(!x.id){missingId++;return;}
      var id=String(x.id);
      if(kind==='staff'?String(x.name||'').trim()==='':String(x.surname||'').trim()===''&&String(x.firstname||'').trim()==='') missingName++;
      if(ids[id]){if(ids[id]===1)duplicates.push(id);ids[id]++;}else ids[id]=1;
    });
    var validIds=Object.create(null);
    valid.forEach(function(x){validIds[String(x.id)]=true;});
    return {rawEntries:all.length,objectEntries:objects.length,valid:valid.length,
      invalid:objects.length-valid.length,uniqueValidIds:Object.keys(validIds).length,
      missingId:missingId,missingName:missingName,duplicateIds:duplicates,ids:Object.keys(validIds)};
  }
  function diagnose(localValue,databaseValue,kind){
    kind=kind||'students';
    var local=inspect(localValue,kind),database=inspect(databaseValue,kind);
    var localSet=Object.create(null),remoteSet=Object.create(null);
    local.ids.forEach(function(id){localSet[id]=true;});database.ids.forEach(function(id){remoteSet[id]=true;});
    return {local:local,database:database,
      missingFromLocal:database.ids.filter(function(id){return !localSet[id];}),
      extraInLocal:local.ids.filter(function(id){return !remoteSet[id];})};
  }
  root.RSMSRoster={records:records,count:function(value,kind){return records(value,kind).length;},
    inspect:inspect,diagnose:diagnose};
})(typeof window!=='undefined'?window:globalThis);
