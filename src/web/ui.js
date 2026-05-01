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
// ── text lane helpers — entry.text is always {ja, ro, en} ─────────────────────
function _laneObj(t){
  // Coerce any incoming text shape to a {ja, ro, en} object.
  if(t && typeof t === 'object'){
    return {ja: t.ja||'', ro: t.ro||'', en: t.en||''};
  }
  if(typeof t === 'string' && t){
    var ls=t.trim().split('\n'), ja='', ro='', en=[];
    for(var i=0;i<ls.length;i++){var s=ls[i].trim();
      if(!s)continue;
      if(s[0]==='['&&s[s.length-1]===']')ja=s.slice(1,-1);
      else if(s[0]==='('&&s[s.length-1]===')')ro=s.slice(1,-1);
      else en.push(s);
    }
    return {ja:ja, ro:ro, en:en.join('\n')};
  }
  return {ja:'', ro:'', en:''};
}
function laneText(t){
  // Build the bracketed display string from a text lane object.
  var l = _laneObj(t);
  var parts = [];
  if(l.ja) parts.push('['+l.ja+']');
  if(l.ro) parts.push('('+l.ro+')');
  if(l.en) parts.push(l.en);
  return parts.join('\n');
}
function fmt(e,n){return n+"\n"+toSRT(e.start)+" --> "+toSRT(e.end)+"\n"+laneText(e.text);}
function extractJP(t){return _laneObj(t).ja;}
function mergeTexts(a,b){
  var la=_laneObj(a), lb=_laneObj(b);
  return {
    ja: (la.ja+lb.ja),
    ro: ((la.ro+' '+lb.ro).trim()),
    en: ((la.en+(la.en&&lb.en?' ':'')+lb.en).trim()),
  };
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

// Compatibility shim — older callers expect {jp, ro, tr}
function parseLanes(t){var l=_laneObj(t);return{jp:l.ja||null, ro:l.ro||null, tr:l.en||null};}

// ── Cur display mode — cycles ja → ro → en → all on click ─────────────────
var CUR_MODES = ['all','ja','ro','en'];
var CUR_MODE_LABELS = {all:'ALL', ja:'JA', ro:'RO', en:'EN'};
var CUR_MODE_NAMES  = {ja:'Japanese', ro:'Romaji', en:'English'};
var _curMode = 'all';
try{ var _saved = localStorage.getItem('curMode'); if(_saved && CUR_MODE_LABELS[_saved]) _curMode = _saved; }catch(e){}

function setCurMode(m){
  if(!CUR_MODE_LABELS[m]) m = 'all';
  _curMode = m;
  try{ localStorage.setItem('curMode', m); }catch(e){}
  var cr=$('cur'); if(cr) cr.setAttribute('data-mode', CUR_MODE_LABELS[m]);
  // Re-render whatever's currently shown
  if(typeof updateCur === 'function') updateCur();
}

function _curLanesView(lanes, mode){
  // Returns the body lines (after timestamp) for a given mode + lane set.
  if(mode === 'all'){
    var lines = [];
    if(lanes.ja) lines.push('['+lanes.ja+']');
    if(lanes.ro) lines.push('('+lanes.ro+')');
    if(lanes.en) lines.push(lanes.en);
    return lines;
  }
  var v = lanes[mode];
  if(v) return [v];
  return ['(no '+CUR_MODE_NAMES[mode]+')'];
}

// Format entry for display. Lazily generates + persists romaji if the entry
// has Japanese but no romaji yet ("on not found" case).
function fmtWithRomaji(e, n, el){
  var lanes=_laneObj(e.text);
  // Best-effort fill from cache if an earlier fetch resolved
  if(lanes.ja && !lanes.ro && _romajiCache[lanes.ja]){
    lanes.ro = _romajiCache[lanes.ja];
    if(typeof e.text === 'object' && e.text){e.text.ro = lanes.ro;}
  }
  var head = [n, toSRT(e.start)+' --> '+toSRT(e.end)];
  var lines = head.concat(_curLanesView(lanes, _curMode));
  var syncText=lines.join('\n');
  if(el)el.textContent=syncText;
  // Async fetch + persist if needed
  if(lanes.ja && !lanes.ro){
    getRomaji(lanes.ja, function(ro){
      if(!ro)return;
      if(typeof e.text === 'object' && e.text){e.text.ro = ro;}
      if(el && el.isConnected){
        lanes.ro = ro;
        el.textContent = head.concat(_curLanesView(lanes, _curMode)).join('\n');
      }
      // Persist the new romaji
      if(typeof triggerSave === 'function') triggerSave();
    });
  }
  return syncText;
}

function buildDD(){
  var sel=$('sel');if(!sel)return;
  sel.innerHTML='';
  entries.forEach(function(e,i){
    var l=_laneObj(e.text);
    var label = l.ja || l.en || l.ro || '(no text)';
    var o=document.createElement('option');
    o.value=i;
    o.textContent=(i+1)+": "+label.substring(0,40).replace(/\n/g,' ')+(label.length>40?'…':'');
    if(i===idx)o.selected=true;sel.appendChild(o);
  });
  var hc=$('hdr-c');if(hc)hc.textContent=entries.length+' records';
}

function render(){
  if(!entries.length)return;
  _userEditing=false;
  var e=entries[idx];
  // Ensure text is the structured form
  if(!e.text || typeof e.text !== 'object'){e.text = _laneObj(e.text);}
  var cr=$('cur');if(cr)fmtWithRomaji(e,idx+1,cr); // updateCur() will override if tab is active
  var lanes=e.text;
  var ja=$('et-ja'); if(ja) ja.value = lanes.ja || '';
  var ro=$('et-ro'); if(ro) ro.value = lanes.ro || '';
  var en=$('et-en'); if(en) en.value = lanes.en || '';
  if(typeof window._etResetHist === 'function') window._etResetHist();
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
  if(tab==='text'){
    var ent=entries[idx]||{start:0,end:0,text:{}};
    var stored=_laneObj(ent.text);
    var sEl=$('es'), eEl=$('ee');
    var s = sEl ? parseFloat(sEl.value) : ent.start;
    var e = eEl ? parseFloat(eEl.value) : ent.end;
    var jaEl=$('et-ja'), roEl=$('et-ro'), enEl=$('et-en');
    var lanes = {
      ja: jaEl ? jaEl.value : (stored.ja||''),
      ro: roEl ? roEl.value : (stored.ro||''),
      en: enEl ? enEl.value : (stored.en||''),
    };
    if(lanes.ja && !lanes.ro && _romajiCache[lanes.ja]) lanes.ro = _romajiCache[lanes.ja];
    var lines=[idx+1, toSRT(s)+' --> '+toSRT(e)].concat(_curLanesView(lanes, _curMode));
    cr.textContent=lines.join('\n');
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
  if(!entries[idx])return;
  // Time editing now lives on the Record tab (which mutates entries[idx]
  // directly). Only touch start/end if the legacy hidden inputs are present.
  var sEl=$('es'), eEl=$('ee');
  if(sEl) entries[idx].start = parseFloat(sEl.value);
  if(eEl) entries[idx].end   = parseFloat(eEl.value);
  var jaEl=$('et-ja'), roEl=$('et-ro'), enEl=$('et-en');
  if(!entries[idx].text || typeof entries[idx].text !== 'object'){
    entries[idx].text = {ja:'', ro:'', en:''};
  }
  // Only overwrite a lane if its input is actually present — otherwise we'd
  // wipe the stored value (e.g. romaji has no input now, it's auto-generated).
  if(jaEl) entries[idx].text.ja = jaEl.value;
  if(roEl) entries[idx].text.ro = roEl.value;
  if(enEl) entries[idx].text.en = enEl.value;
  markDirty(idx);
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
  var ap=$('ap');if(ap)ap.textContent=(idx+1)+"\n"+toSRT(s)+" --> "+toSRT(e)+"\n(empty record)";
  updateAddRegion();
}

// Extract romaji line from an existing preview box so we can preserve it during updates
function _extractRo(el){
  if(!el)return '';
  var lines=el.textContent.split('\n');
  for(var i=0;i<lines.length;i++){var l=lines[i].trim();if(l[0]==='('&&l[l.length-1]===')') return l;}
  return '';
}
// Wire #cur click → cycle display modes
(function _wireCurMode(){
  var cr=$('cur'); if(!cr) return;
  cr.setAttribute('data-mode', CUR_MODE_LABELS[_curMode]);
  cr.addEventListener('click', function(){
    var i = CUR_MODES.indexOf(_curMode);
    setCurMode(CUR_MODES[(i + 1) % CUR_MODES.length]);
  });
})();

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

