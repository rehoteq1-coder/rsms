/* Shared assessment model. Every score carries a marking-scheme snapshot.
   School settings choose the scheme for NEW records only; existing records
   (including pre-snapshot 20/20/60 records) are never migrated on read. */
(function(root){
  'use strict';
  var LEGACY = Object.freeze({tests:2,ca1:20,ca2:20,ca3:0,exam:60});
  var LABELS = Object.freeze({ca1:'T1 (CA 1)',ca2:'T2 (CA 2)',ca3:'T3 (CA 3)',exam:'Exam'});
  function copy(config){
    return {tests:config.tests,ca1:config.ca1,ca2:config.ca2,ca3:config.ca3,exam:config.exam};
  }
  function integer(value,min,max){
    if(typeof value==='number') return Number.isInteger(value) && value>=min && value<=max;
    return typeof value==='string' && /^\d+$/.test(value.trim()) && Number(value)>=min && Number(value)<=max;
  }
  function validate(config){
    var errors=[];
    if(!config || (config.tests!==2 && config.tests!==3)) return ['Choose two or three tests.'];
    ['ca1','ca2','exam'].concat(config.tests===3?['ca3']:[]).forEach(function(field){
      if(!integer(config[field],1,1000))
        errors.push(LABELS[field]+' maximum must be a whole number between 1 and 1000.');
    });
    if(config.tests===2 && config.ca3!==0) errors.push('The third test maximum must be zero when only two tests are used.');
    return errors;
  }
  /* Parse settings/CSV values without parseFloat's silent truncation. */
  function fromForm(values){
    var config={tests:values && values.tests!==undefined ? Number(values.tests) : NaN};
    ['ca1','ca2','exam'].forEach(function(f){
      var v=values && values[f]; config[f]=integer(v,0,100000)?Number(v):NaN;
    });
    var third=values && values.ca3;
    config.ca3=config.tests===2 && (third===undefined || third===null || String(third).trim()==='') ? 0 :
      (integer(third,0,100000)?Number(third):NaN);
    return config;
  }
  function forSchool(school){
    if(!school || school.assessment===undefined || school.assessment===null) return copy(LEGACY);
    var errors=validate(school.assessment);
    if(errors.length) throw new Error('Invalid school assessment scheme: '+errors.join(' '));
    return copy(school.assessment);
  }
  function fields(config){return config.tests===3?['ca1','ca2','ca3','exam']:['ca1','ca2','exam'];}
  function labels(config){return fields(config).map(function(f){return LABELS[f];});}
  function unionFields(configs){
    var three=(configs||[]).some(function(c){return c && c.tests===3;});
    return three?['ca1','ca2','ca3','exam']:['ca1','ca2','exam'];
  }
  function totalMax(config){
    var errors=validate(config); if(errors.length) throw new Error(errors.join(' '));
    return fields(config).reduce(function(sum,f){return sum+Number(config[f]);},0);
  }
  function missing(value){return value==='' || value===null || value===undefined;}
  function hasScores(scores,config){return fields(config).some(function(f){return scores && !missing(scores[f]);});}
  function validateScores(scores,config,requireComplete){
    var errors=validate(config); if(errors.length) return errors;
    fields(config).forEach(function(field){
      var value=scores && scores[field];
      if(missing(value)){if(requireComplete) errors.push(LABELS[field]+' is required.');return;}
      if(!integer(value,0,Number(config[field])))
        errors.push(LABELS[field]+' must be a whole number from 0 to '+config[field]+'.');
    });
    return errors;
  }
  function total(scores,config){
    var errors=validateScores(scores,config,false);
    if(errors.length) throw new Error(errors.join(' '));
    return fields(config).reduce(function(sum,f){return sum+Number(scores[f]||0);},0);
  }
  function forRecord(record){
    if(!record || record.assessment===undefined || record.assessment===null) return copy(LEGACY);
    var errors=validate(record.assessment);
    if(errors.length) throw new Error('Invalid saved assessment scheme: '+errors.join(' '));
    return copy(record.assessment);
  }
  /* New entry: caller supplies the scheme captured when the form/CSV loaded. */
  function createRecord(base,scores,scheme){
    var errors=validateScores(scores,scheme,true);
    if(errors.length) throw new Error(errors.join(' '));
    var record=Object.assign({},base);
    fields(scheme).forEach(function(f){record[f]=Number(scores[f]);});
    if(scheme.tests===2) record.ca3=0;
    record.assessment=copy(scheme);
    record.total=total(scores,scheme);
    return record;
  }
  /* An override keeps the record's original snapshot, never today's settings. */
  function updateRecord(record,scores){
    return createRecord(record,scores,forRecord(record));
  }
  /* Read-only projection for reports. Invalid historical data is surfaced,
     not silently converted to a zero or reinterpreted with current settings. */
  function viewRecord(record){
    var view={record:record,scheme:null,fields:[],values:{},total:null,totalMax:null,
      percent:null,complete:false,legacyTotal:false,error:''};
    try{
      view.scheme=forRecord(record); view.fields=fields(view.scheme);
      view.totalMax=totalMax(view.scheme);
      view.fields.forEach(function(f){view.values[f]=record && !missing(record[f])?Number(record[f]):null;});
      var errors=validateScores(record,view.scheme,false);
      if(errors.length){view.error=errors.join(' ');return view;}
      view.complete=!validateScores(record,view.scheme,true).length;
      if(view.complete){view.total=total(record,view.scheme);}
      else if(!hasScores(record,view.scheme) && integer(record && record.total,0,view.totalMax)){
        // Some old portals flattened a subject to a single total.
        view.total=Number(record.total); view.legacyTotal=true;
      }else if(hasScores(record,view.scheme)){view.total=total(record,view.scheme);}
      if(view.complete || view.legacyTotal) view.percent=view.total/view.totalMax*100;
    }catch(e){view.error=e.message;}
    return view;
  }
  function percentage(record){return viewRecord(record).percent;}
  /* Raw marks and their possible marks both use each record's own snapshot.
     The aggregate percentage is weighted by possible marks, not an average of
     incompatible raw totals. Missing subjects do not invent zero marks. */
  function summarize(records){
    var sum=0,max=0,count=0,percentSum=0,percentCount=0,invalid=0,incomplete=0;
    (records||[]).forEach(function(record){
      var v=viewRecord(record);
      if(v.error){invalid++;return;}
      if(v.total===null){incomplete++;return;}
      sum+=v.total;max+=v.totalMax;count++;
      if(v.percent!==null){percentSum+=v.percent;percentCount++;}else incomplete++;
    });
    return {total:sum,totalMax:max,count:count,percent:max?sum/max*100:null,
      subjectPercent:percentCount?percentSum/percentCount:null,invalid:invalid,incomplete:incomplete};
  }
  function describe(config){
    return fields(config).map(function(f){return LABELS[f]+' / '+config[f];}).join(' · ')+' (total / '+totalMax(config)+')';
  }
  function formatPercent(value){return value===null || value===undefined?'—':(Math.round(value*10)/10)+'%';}
  root.RSMSAssessment={legacy:function(){return copy(LEGACY);},copy:copy,validate:validate,
    fromForm:fromForm,forSchool:forSchool,fields:fields,labels:labels,unionFields:unionFields,totalMax:totalMax,
    hasScores:hasScores,validateScores:validateScores,total:total,forRecord:forRecord,
    createRecord:createRecord,updateRecord:updateRecord,viewRecord:viewRecord,
    percentage:percentage,summarize:summarize,describe:describe,formatPercent:formatPercent};
})(typeof window!=='undefined'?window:globalThis);
