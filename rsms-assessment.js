/* Shared assessment model. A score carries a snapshot of its marking scheme so
   changing a school's future scheme cannot reinterpret historical results. */
(function(root){
  'use strict';
  var LEGACY = Object.freeze({tests:2,ca1:20,ca2:20,ca3:0,exam:60});
  function copy(config){return {tests:config.tests,ca1:config.ca1,ca2:config.ca2,ca3:config.ca3,exam:config.exam};}
  function validate(config){
    var errors=[];
    if(!config || (config.tests!==2 && config.tests!==3)) return ['Choose two or three tests.'];
    ['ca1','ca2','exam'].concat(config.tests===3?['ca3']:[]).forEach(function(field){
      if(!Number.isInteger(config[field]) || config[field]<1 || config[field]>1000)
        errors.push(field+' maximum must be a whole number between 1 and 1000.');
    });
    if(config.tests===2 && config.ca3!==0) errors.push('The third test maximum must be zero when only two tests are used.');
    return errors;
  }
  function fields(config){return config.tests===3?['ca1','ca2','ca3','exam']:['ca1','ca2','exam'];}
  function totalMax(config){return fields(config).reduce(function(sum,f){return sum+config[f];},0);}
  function validateScores(scores, config, requireComplete){
    var errors=validate(config);
    if(errors.length) return errors;
    fields(config).forEach(function(field){
      var value=scores && scores[field];
      if(value==='' || value===null || value===undefined){
        if(requireComplete) errors.push(field+' is required.');
        return;
      }
      var text=String(value);
      if(!/^\d+$/.test(text) || Number(text)>config[field]) errors.push(field+' must be a whole number from 0 to '+config[field]+'.');
    });
    return errors;
  }
  function total(scores,config){
    var errors=validateScores(scores,config,false);
    if(errors.length) throw new Error(errors.join(' '));
    return fields(config).reduce(function(sum,f){return sum+Number(scores[f]||0);},0);
  }
  function forRecord(record){
    // Records written before this model was introduced use RSMS's old scheme.
    if(!record || record.assessment===undefined || record.assessment===null) return copy(LEGACY);
    var errors=validate(record.assessment);
    if(errors.length) throw new Error('Invalid saved assessment scheme: '+errors.join(' '));
    return copy(record.assessment);
  }
  root.RSMSAssessment={legacy:function(){return copy(LEGACY);},copy:copy,validate:validate,fields:fields,
    totalMax:totalMax,validateScores:validateScores,total:total,forRecord:forRecord};
})(typeof window!=='undefined'?window:globalThis);
