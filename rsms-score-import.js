/* CSV helpers for the teacher score import. CSV opens in Excel and LibreOffice. */
(function(root){
  'use strict';
  var headers=['Class','Term','Session','Student ID','Admission Number','Student Name','Subject','CA 1','CA 2','Exam'];
  function csvCell(value){
    var v=String(value==null?'':value);
    // Protect spreadsheet users from formula injection in school-provided text.
    if (/^[\s\t]*[=+@-]/.test(v)) v="'"+v;
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
  function template(ctx,students,subjects){
    var rows=[headers];
    students.forEach(function(s){subjects.forEach(function(subject){
      rows.push([ctx.cls,ctx.term,ctx.sess,'id:'+s.id,s.reg||'',((s.surname||'')+' '+(s.firstname||'')).trim(),subject,'','','']);
    });});
    return '\uFEFF'+rows.map(function(r){return r.map(csvCell).join(',');}).join('\r\n');
  }
  function validate(text,ctx,students,subjects){
    var rows=parseCSV(text), errors=[], items=[], blank=0, seen=Object.create(null), ids=Object.create(null), used=Object.create(null);
    if(!rows.length || rows[0].length!==headers.length || headers.some(function(h,i){return rows[0][i].trim()!==h;}))
      return {errors:['Use the unmodified header from the RSMS CSV template.'],items:[]};
    students.forEach(function(s){var id=String(s.id||'');if(ids[id]) ids[id]=null;else if(!Object.prototype.hasOwnProperty.call(ids,id)) ids[id]=s;});
    rows.slice(1).forEach(function(r,index){
      var line=index+2;
      if(r.length!==headers.length){errors.push('Row '+line+': expected '+headers.length+' columns.');return;}
      var vals=r.slice(7).map(function(v){return v.trim();});
      if(vals.every(function(v){return v==='';})){blank++;return;}
      if(r[0]!==ctx.cls || r[1]!==ctx.term || r[2]!==ctx.sess){errors.push('Row '+line+': class, term or session does not match the selection.');return;}
      var id=r[3].indexOf('id:')===0?r[3].slice(3):'';
      var student=ids[id];
      if(!id || !student){errors.push('Row '+line+': unknown or duplicate student ID for this class.');return;}
      if(subjects.indexOf(r[6])<0){errors.push('Row '+line+': subject is not available for this class/teacher.');return;}
      var pair=JSON.stringify([id,r[6]]);
      if(seen[pair]){errors.push('Row '+line+': duplicate student and subject.');return;}
      seen[pair]=true;
      if(vals.some(function(v,i){return !/^\d+$/.test(v) || Number(v)>(i===2?60:20);})){errors.push('Row '+line+': enter all three whole-number scores (CA 1/2: 0–20, Exam: 0–60).');return;}
      used[id]=true;
      items.push({student:student,subject:r[6],ca1:vals[0],ca2:vals[1],exam:vals[2],total:vals.reduce(function(n,v){return n+Number(v);},0)});
    });
    return {errors:errors,items:items,blank:blank,missing:students.length-Object.keys(used).length};
  }
  root.RSMSScoreImport={headers:headers,parseCSV:parseCSV,template:template,validate:validate};
})(typeof window!=='undefined'?window:globalThis);
