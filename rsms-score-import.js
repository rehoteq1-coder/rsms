/* CSV helpers for teacher score import. The active school scheme determines
   the columns; legacy two-test CA 1 / CA 2 / Exam templates remain valid. */
(function(root){
  'use strict';
  var A=root.RSMSAssessment;
  var metadata=['Class','Term','Session','Student ID','Admission Number','Student Name','Subject'];
  var legacyHeaders=metadata.concat(['CA 1','CA 2','Exam']);
  function headers(config){
    config=config||A.legacy();
    return metadata.concat(config.tests===3?['CA 1','CA 2','CA 3','Exam']:['CA 1','CA 2','Exam']);
  }
  function csvCell(value){
    var v=String(value==null?'':value);
    // Protect spreadsheet users from formula injection in school-provided text.
    if(/^[\s\t]*[=+@-]/.test(v)) v="'"+v;
    return '"'+v.replace(/"/g,'""')+'"';
  }
  function parseCSV(text){
    text=String(text).replace(/^\uFEFF/,'');
    var rows=[], row=[], field='', quoted=false, closed=false;
    for(var i=0;i<text.length;i++){
      var c=text[i];
      if(quoted){
        if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}
        else field+=c;
      }else if(c==='"'){
        if(field || closed) throw new Error('Invalid quote in CSV');
        quoted=true;
      }else if(c===',' || c==='\n' || c==='\r'){
        row.push(field); field=''; closed=false;
        if(c!==','){rows.push(row);row=[];if(c==='\r' && text[i+1]==='\n')i++;}
      }else{
        if(closed) throw new Error('Unexpected text after quoted field');
        field+=c;
      }
    }
    if(quoted) throw new Error('Unclosed quoted field');
    if(field || row.length || closed){row.push(field);rows.push(row);}
    return rows.filter(function(r){return r.some(function(v){return v!=='';});});
  }
  function template(ctx,students,subjects,config){
    config=A.copy(config||A.legacy());
    var errors=A.validate(config); if(errors.length) throw new Error(errors.join(' '));
    var cols=headers(config), rows=[cols];
    students.forEach(function(s){subjects.forEach(function(subject){
      var row=[ctx.cls,ctx.term,ctx.sess,'id:'+s.id,s.reg||'',((s.surname||'')+' '+(s.firstname||'')).trim(),subject];
      A.fields(config).forEach(function(){row.push('');});
      rows.push(row);
    });});
    return '\uFEFF'+rows.map(function(r){return r.map(csvCell).join(',');}).join('\r\n');
  }
  function validate(text,ctx,students,subjects,config){
    config=A.copy(config||A.legacy());
    var schemeErrors=A.validate(config);
    if(schemeErrors.length) return {errors:schemeErrors,items:[],blank:0,missing:students.length};
    var cols=headers(config), scoreFields=A.fields(config);
    var rows=parseCSV(text), errors=[], items=[], blank=0,
      seen=Object.create(null), ids=Object.create(null), used=Object.create(null);
    if(!rows.length || rows[0].length!==cols.length || cols.some(function(h,i){return rows[0][i].trim()!==h;}))
      return {errors:['Use the unmodified header from the current RSMS CSV template ('+config.tests+' tests). Download a new template if the school scheme changed.'],items:[],blank:0,missing:students.length};
    students.forEach(function(s){
      var id=String(s.id||'');
      if(!Object.prototype.hasOwnProperty.call(ids,id)) ids[id]=s;
      else ids[id]=null; // ambiguous duplicate IDs must never import into one arbitrary row
    });
    rows.slice(1).forEach(function(r,index){
      var line=index+2;
      if(r.length!==cols.length){errors.push('Row '+line+': expected '+cols.length+' columns.');return;}
      var vals=r.slice(metadata.length).map(function(v){return v.trim();});
      if(vals.every(function(v){return v==='';})){blank++;return;}
      if(r[0]!==ctx.cls || r[1]!==ctx.term || r[2]!==ctx.sess){errors.push('Row '+line+': class, term or session does not match the selection.');return;}
      var id=r[3].indexOf('id:')===0?r[3].slice(3):'';
      var student=Object.prototype.hasOwnProperty.call(ids,id)?ids[id]:null;
      if(!id || !student){errors.push('Row '+line+': unknown or duplicate student ID for this class.');return;}
      if(subjects.indexOf(r[6])<0){errors.push('Row '+line+': subject is not available for this class/teacher.');return;}
      var pair=JSON.stringify([id,r[6]]);
      if(seen[pair]){errors.push('Row '+line+': duplicate student and subject.');return;}
      seen[pair]=true;
      var scores={}; scoreFields.forEach(function(f,i){scores[f]=vals[i];});
      var scoreErrors=A.validateScores(scores,config,true);
      if(scoreErrors.length){errors.push('Row '+line+': '+scoreErrors.join(' '));return;}
      used[id]=true;
      items.push({student:student,subject:r[6],ca1:Number(vals[0]),ca2:Number(vals[1]),
        ca3:config.tests===3?Number(vals[2]):0,exam:Number(vals[config.tests===3?3:2]),
        total:A.total(scores,config),assessment:A.copy(config)});
    });
    return {errors:errors,items:items,blank:blank,missing:students.length-Object.keys(used).length,assessment:A.copy(config)};
  }
  root.RSMSScoreImport={headers:legacyHeaders,headersFor:headers,parseCSV:parseCSV,template:template,validate:validate};
})(typeof window!=='undefined'?window:globalThis);
