'use strict';
/* DOM workflow harness. Executes the real local portal scripts in jsdom while
   replacing only external SDKs/network with an in-memory Firebase double. */
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom');
const ROOT=path.join(__dirname,'..');
function clone(v){return v===undefined?null:JSON.parse(JSON.stringify(v));}
function getPath(obj,p){return p.split('/').filter(Boolean).reduce((o,k)=>o==null?undefined:o[k],obj);}
function setPath(obj,p,value){
  const parts=p.split('/').filter(Boolean);let o=obj;
  parts.slice(0,-1).forEach(k=>{if(!o[k]||typeof o[k]!=='object')o[k]={};o=o[k];});
  const last=parts[parts.length-1];
  if(value===null)delete o[last];else o[last]=clone(value);
}
function fakeFirebase(initial={},options={}){
  const state=clone(initial),writes=[],listeners=[];
  const api={apps:[],initializeApp(){api.apps.push({});},auth(){return {
    currentUser:null,onAuthStateChanged(){},setPersistence:()=>Promise.resolve(),
    signInWithEmailAndPassword:()=>Promise.reject(new Error('not used in workflow test')),
    signOut:()=>Promise.resolve()
  };},functions(){return {httpsCallable(){return ()=>Promise.reject(new Error('external call disabled in test'));}};},
  database(){return db;}};
  api.auth.Auth={Persistence:{LOCAL:'local'}};
  function makeRef(p){
    const ref={path:p,
      once(){return Promise.resolve({val:()=>p==='.info/connected'?true:clone(getPath(state,p)),exists:()=>getPath(state,p)!=null});},
      set(v){if(options.failPath===p)return Promise.reject(new Error('simulated write failure'));writes.push({path:p,op:'set',data:clone(v)});setPath(state,p,v);return Promise.resolve();},
      update(v){writes.push({path:p,op:'update',data:clone(v)});const cur=getPath(state,p)||{};setPath(state,p,Object.assign({},cur,v));return Promise.resolve();},
      remove(){writes.push({path:p,op:'remove'});setPath(state,p,null);return Promise.resolve();},
      on(event,cb){listeners.push({path:p,event,cb});return cb;},off(){},
      push(v){const key='push'+writes.length;const child=makeRef(p+'/'+key);if(v!==undefined)child.set(v);return child;},
      transaction(fn){const next=fn(clone(getPath(state,p)));writes.push({path:p,op:'transaction',data:clone(next)});setPath(state,p,next);return Promise.resolve({committed:true,snapshot:{val:()=>clone(getPath(state,p))}});}
    };
    ['limitToLast','limitToFirst','orderByChild','orderByKey','equalTo','startAt','endAt'].forEach(m=>ref[m]=()=>ref);
    return ref;
  }
  const db={ref:makeRef,goOffline(){},goOnline(){}};
  api.database.ServerValue={TIMESTAMP:{'.sv':'timestamp'}};
  return {api,state,writes,listeners};
}
function storageEntries(storage){const out={};for(let i=0;i<storage.length;i++){const k=storage.key(i);out[k]=storage.getItem(k);}return out;}
function loadPortal(file,options={}){
  const html=fs.readFileSync(path.join(ROOT,file),'utf8');
  const errors=[];
  const virtualConsole=new VirtualConsole();
  virtualConsole.on('jsdomError',e=>errors.push(e));
  virtualConsole.on('error',(...args)=>errors.push(args.join(' ')));
  const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://rsms.test/'+file,pretendToBeVisual:true,virtualConsole});
  const w=dom.window;
  const seed=Object.assign({},options.localStorage||{});
  let sid='';try{sid=(typeof seed.rsms_school==='string'?JSON.parse(seed.rsms_school):seed.rsms_school||{}).schoolId||'';}catch(e){}
  if(sid){
    // The legacy cache helper returns its raw fallback string when a key is
    // absent; seed ordinary empty collections so unrelated dashboard widgets
    // do not obscure the assessment workflow under test.
    ['students','staff','fees','broadcasts','assignments','fee_schedule'].forEach(k=>{const key='rsms_'+sid+'_'+k;if(seed[key]===undefined)seed[key]=[];});
    ['ct_remarks','published_results','result_pipeline'].forEach(k=>{const key='rsms_'+sid+'_'+k;if(seed[key]===undefined)seed[key]={};});
  }
  Object.entries(seed).forEach(([k,v])=>w.localStorage.setItem(k,typeof v==='string'?v:JSON.stringify(v)));
  Object.entries(options.sessionStorage||{}).forEach(([k,v])=>w.sessionStorage.setItem(k,typeof v==='string'?v:JSON.stringify(v)));
  const fb=options.firebase||fakeFirebase();
  w.firebase=fb.api;
  w.Chart=function(){this.destroy=()=>{};};w.Chart.defaults={font:{},color:''};
  w.QRCode=function(){};w.FlutterwaveCheckout=()=>{};
  w.alert=()=>{};w.confirm=()=>true;w.prompt=()=>'';w.scrollTo=()=>{};w.print=()=>{};
  w.Element.prototype.scrollTo=()=>{};w.Element.prototype.scrollIntoView=()=>{};
  w.HTMLCanvasElement.prototype.getContext=()=>({clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},getImageData:()=>({data:new Uint8ClampedArray(4)}),drawImage(){},fillRect(){},scale(){}});
  w.HTMLCanvasElement.prototype.toDataURL=()=>'data:image/png;base64,';
  w.HTMLAnchorElement.prototype.click=function(){}; // blob downloads are captured through createObjectURL
  const downloads=[];
  w.URL.createObjectURL=blob=>{downloads.push(blob);return 'blob:rsms-test/'+downloads.length;};
  w.URL.revokeObjectURL=()=>{};
  w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  w.addEventListener('error',e=>errors.push(e.error||e.message));
  // Run local scripts in document order. External SDKs are represented by the
  // doubles above; no request reaches the network and no load event is fired.
  for(const script of w.document.querySelectorAll('script')){
    const src=script.getAttribute('src');
    let code=script.textContent;
    if(src){
      if(/^https?:\/\//.test(src))continue;
      const local=path.join(ROOT,src.split('?')[0]);
      if(!fs.existsSync(local))continue;
      code=fs.readFileSync(local,'utf8');
    }
    if(!code.trim())continue;
    try{w.eval(code);}catch(e){errors.push(e);}
  }
  return {window:w,document:w.document,firebase:fb,downloads,errors,
    storage:()=>storageEntries(w.localStorage),close:()=>w.close()};
}
function inlineHandler(w,el,type){const code=el.getAttribute('on'+type);if(!code)return;const event=new w.Event(type,{bubbles:true});const fn=w.eval('(function(event){'+code+'\n})');fn.call(el,event);}
function setInput(w,id,value){const el=w.document.getElementById(id);if(!el)throw new Error('Missing input #'+id);el.value=String(value);el.dispatchEvent(new w.Event('input',{bubbles:true}));inlineHandler(w,el,'input');return el;}
function setSelect(w,id,value){const el=w.document.getElementById(id);if(!el)throw new Error('Missing select #'+id);el.value=String(value);el.dispatchEvent(new w.Event('change',{bubbles:true}));inlineHandler(w,el,'change');return el;}
function flush(ms=30){return new Promise(r=>setTimeout(r,ms));}
module.exports={loadPortal,fakeFirebase,storageEntries,setInput,setSelect,flush,clone};
function blobText(blob,window){return new Promise((resolve,reject)=>{const r=new window.FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsText(blob);});}
module.exports.blobText=blobText;
