// ── Transcribblr UI — shared state + render functions ────────────────────────

// Global state — read by all modules
var entries = [], idx = 0, audioDur = 0, saveTimer = null;
var _userEditing = false;

function $(id){return document.getElementById(id);}
function toSRT(t){
  t=Math.max(0,t);
  var h=Math.floor(t/3600),m=Math.floor((t%3600)/60),s=Math.floor(t%60),ms=Math.round((t%1)*1000);
  return[h,m,s].map(function(n){return String(n).padStart(2,'0');}).join(':')+','+String(ms).padStart(3,'0');
}
function fmt(e,n){return n+"\n"+toSRT(e.start)+" --> "+toSRT(e.end)+"\n"+e.text;}
function extractJP(t){
  var ls=t.trim().split("\n");
  for(var i=0;i<ls.length;i++){var s=ls[i].trim();if(s[0]==='['&&s[s.length-1]===']')return s.slice(1,-1);}
  return t.trim();
}
function mergeTexts(a,b){
  var pa=parseLanes(a),pb=parseLanes(b);
  if(pa.jp!==null||pa.ro!==null||pb.jp!==null||pb.ro!==null){
    var parts=["["+((pa.jp||"")+(pb.jp||""))+"]"];
    var mro=((pa.ro||"").trim()+" "+(pb.ro||"").trim()).trim();
    if(mro)parts.push("("+mro+")");
    var mtr=((pa.tr||"").trim()+" "+(pb.tr||"").trim()).trim();
    if(mtr)parts.push(mtr);
    return parts.join("\n");
  }
  var ta=a.trim(),tb=b.trim();
  if(ta==='????' && tb==='????') return '????';
  return (ta==='????' ? '' : ta) + (ta && ta!=='????' && tb && tb!=='????' ? ' ' : '') + (tb==='????' ? '' : tb) || '????';
}
function setStatus(msg,warn){var el=$('s-msg');if(!el)return;el.textContent=msg;el.style.color=warn?'#ffcc00':'#00ff88';}
// ── Romaji via cutlet ─────────────────────────────────────────────────────────
var _romajiCache={};

function getRomaji(jp, cb){
  if(_romajiCache[jp]!==undefined){cb(_romajiCache[jp]);return;}
  apiRomaji(jp)
    .then(function(d){
      var ro=d.ok?d.romaji:'';
      _romajiCache[jp]=ro;
      cb(ro);
    })
    .catch(function(){_romajiCache[jp]='';cb('');});
}

// Parse multilane text into {jp, ro, tr}
function parseLanes(t){
  var ls=t.trim().split('\n'),jp=null,ro=null,tr=null;
  for(var i=0;i<ls.length;i++){var s=ls[i].trim();
    if(s[0]==='['&&s[s.length-1]===']')jp=s.slice(1,-1);
    else if(s[0]==='('&&s[s.length-1]===')') ro=s.slice(1,-1);
    else if(s)tr=s;}
  return{jp:jp,ro:ro,tr:tr};
}

// Format entry for display, fetching romaji if needed
function fmtWithRomaji(e, n, el){
  var lanes=parseLanes(e.text);
  var jpText=extractJP(e.text);
  // Build sync text immediately
  var lines=[n, toSRT(e.start)+' --> '+toSRT(e.end), e.text.trim()];
  // Only append cached romaji if entry doesn't already have a romaji lane
  if(!lanes.ro && _romajiCache[jpText])lines.push('('+_romajiCache[jpText]+')');
  var syncText=lines.join('\n');
  if(el)el.textContent=syncText;
  // Fetch romaji async only if no romaji lane and not cached yet
  if(!lanes.ro && !_romajiCache[jpText]){
    getRomaji(jpText, function(ro){
      if(!ro||!el)return;
      el.textContent=[n, toSRT(e.start)+' --> '+toSRT(e.end), e.text.trim(), '('+ro+')'].join('\n');
    });
  }
  return syncText;
}

function buildDD(){
  var sel=$('sel');if(!sel)return;
  sel.innerHTML='';
  entries.forEach(function(e,i){
    var o=document.createElement('option');
    o.value=i;o.textContent=(i+1)+": "+e.text.substring(0,40).replace(/\n/g,' ')+"…";
    if(i===idx)o.selected=true;sel.appendChild(o);
  });
  var hc=$('hdr-c');if(hc)hc.textContent=entries.length+' records';
}

function render(){
  if(!entries.length)return;
  _userEditing=false;
  var e=entries[idx];
  var cr=$('cur');if(cr)fmtWithRomaji(e,idx+1,cr); // updateCur() will override if tab is active
  var et=$('et');if(et)et.value=e.text;
  // Set hidden inputs
  var es=$('es');if(es)es.value=e.start;
  var ee=$('ee');if(ee)ee.value=e.end;
  // Update noUiSlider
  if(window.timeSlider){
    // Clamp to neighbours so records can't overlap
    var tsMin=idx>0 ? entries[idx-1].end : 0;
    var tsMax=idx<entries.length-1 ? entries[idx+1].start : audioDur||9999;
    // Add small padding so slider has room to move
    var pad=Math.max(5, (tsMax-tsMin)*0.1);
    window.timeSlider.updateOptions({range:{min:Math.max(0,tsMin-pad),max:tsMax+pad}},false);
    window.timeSlider.set([e.start,e.end],false);
  }
  editPrev();
  addInfo();
  var jp=extractJP(e.text);
  var sc=$('sc');if(sc){sc.max=Math.max(1,jp.length);sc.value=0;}
  var st=$('st');if(st){st.min=e.start;st.max=e.end;st.value=(e.start+e.end)/2;}
  splitPrev();
  var m1=$('mp1'),m2=$('mp2');
  if(m1)fmtWithRomaji(e,idx+1,m1);
  if(m2){
    if(idx+1<entries.length)fmtWithRomaji(entries[idx+1],idx+2,m2);
    else m2.textContent='--- END ---';
  }
  var dp=$('dp');if(dp)fmtWithRomaji(e,idx+1,dp);
  // audio seek handled by go()
}

function updateCur(){
  var activeTab=document.querySelector('.tbtn.on');
  var tab=activeTab?activeTab.getAttribute('data-tab'):'';
  var cr=$('cur');if(!cr||!entries.length)return;
  if(tab==='time'||tab==='text'){
    var s=parseFloat(($('es')||{value:0}).value),e=parseFloat(($('ee')||{value:0}).value);
    var t=($('et')||{value:''}).value;
    var lanes=parseLanes(t);
    var ro=!lanes.ro?_romajiCache[extractJP(t)]:null;
    cr.textContent=(idx+1)+"\n"+toSRT(s)+" --> "+toSRT(e)+"\n"+t+(ro?"\n("+ro+")":"");
  } else if(tab==='split'){
    var sp1=$('sp1');if(sp1&&sp1.textContent)cr.textContent=sp1.textContent;
  } else if(tab==='merge'){
    if(idx+1<entries.length){
      var _en=entries[idx+1],_e=entries[idx];
      fmtWithRomaji({start:_e.start,end:_en.end,text:mergeTexts(_e.text,_en.text)},idx+1,cr);
    } else fmtWithRomaji(entries[idx],idx+1,cr);
  } else {
    fmtWithRomaji(entries[idx],idx+1,cr);
  }
}

function editPrev(){
  var s=parseFloat(($('es')||{value:0}).value),e=parseFloat(($('ee')||{value:0}).value),t=($('et')||{value:''}).value;
  if(!entries[idx])return;
  // Mutate in place — must not replace the object, that would wipe fields
  // owned by other tabs (speaker, speaker_note, note, …).
  entries[idx].start=s;
  entries[idx].end=e;
  entries[idx].text=t;
  markDirty(idx);
  var jp=extractJP(t);
  if(jp && !_romajiCache[jp]){
    getRomaji(jp,function(){updateCur();});
  }
  updateCur();
  updateCurRegion();
}
function addInfo(){
  if(!entries.length)return;
  var pos=document.querySelector('input[name="apos"]:checked'),p=pos?pos.value:'Before';
  var e=entries[idx],gs,ge;
  if(p==='Before'){gs=idx>0?entries[idx-1].end:0;ge=e.start;}
  else{gs=e.end;ge=idx+1<entries.length?entries[idx+1].start:audioDur;}
  gs=Math.max(0,gs);ge=Math.max(gs,ge);
  // Update noUiSlider for add tab
  if(window.addSlider){
    var aMax=Math.max(ge||gs+1, gs+0.1);
    window.addSlider.updateOptions({range:{min:gs,max:aMax}},true);
    window.addSlider.set([gs,ge||gs+0.5]);
  }
  var as=$('as2'),ae=$('ae2');
  if(as)as.value=gs;
  if(ae)ae.value=ge||gs+0.5;
  addPrev();
}
function addPrev(){
  var s=parseFloat(($('as2')||{value:0}).value),e=parseFloat(($('ae2')||{value:0}).value);
  var ap=$('ap');if(ap)ap.textContent=(idx+1)+"\n"+toSRT(s)+" --> "+toSRT(e)+"\n????";
  updateAddRegion();
}

// Extract romaji line from an existing preview box so we can preserve it during updates
function _extractRo(el){
  if(!el)return '';
  var lines=el.textContent.split('\n');
  for(var i=0;i<lines.length;i++){var l=lines[i].trim();if(l[0]==='('&&l[l.length-1]===')') return l;}
  return '';
}
function splitPrev(){
  if(!entries.length)return;
  var e=entries[idx],c=parseInt(($('sc')||{value:0}).value),t=parseFloat(($('st')||{value:e.start}).value);
  var jp=extractJP(e.text);
  var jp1=jp.substring(0,c).trim(), jp2=jp.substring(c).trim();
  var sp1=$('sp1'),sp2=$('sp2');
  function spWrite(el,n,s,e2,jpx){
    // Use cached romaji, or preserve whatever romaji is currently showing
    var ro=_romajiCache[jpx]||'';
    var prevRo=ro?'':_extractRo(el);
    el.textContent=(n)+"\n"+toSRT(s)+" --> "+toSRT(e2)+"\n"+jpx+((ro||prevRo)?"\n("+(ro||prevRo.slice(1,-1))+")":"");
    // Fetch async only if nothing to show yet
    if(!ro&&jpx)getRomaji(jpx,function(r){
      if(r)el.textContent=(n)+"\n"+toSRT(s)+" --> "+toSRT(e2)+"\n"+jpx+"\n("+r+")";
    });
  }
  if(sp1)spWrite(sp1,idx+1,e.start,t,jp1);
  if(sp2)spWrite(sp2,idx+2,t,e.end,jp2);
  updateCur();
  updateSplitRegions();
}

