// ── Annotations top-tab — Scenes + Annotations sub-panes ─────────────────────
// Shares the player + waveform with the Edit tab. Each sub-pane has its own
// noUiSlider, dropdown nav, and current-region highlight on the wave.
//
// Schema (project.context.scenes / .annotations):
//   [{ start: number, end: number, text: { en: string, ja: string } }, …]
//
// Slider drags / nudges send {start,end} only — no LLM round-trip.
// Save & translate sends {text_en} which the server runs through translate_to_japanese.

var _ann = { scenes: [], annotations: [], sceneIdx: 0, annIdx: 0, sub: 'scenes' };
var _annRegion = { scenes: null, annotations: null };
var _annSaveTimer = { scene: null, annotation: null };

// ── helpers ─────────────────────────────────────────────────────────────────

function _annStatus(msg, warn){
  var el=$('ann-status');if(!el)return;
  el.textContent=msg||'';
  el.style.color=warn?'#ffcc00':'#888';
}
function _annSection(){return _ann.sub === 'scenes' ? 'scene' : 'annotation';}
function _annListKey(section){return section==='scene' ? 'scenes' : 'annotations';}
function _annIdxKey(section){return section==='scene' ? 'sceneIdx' : 'annIdx';}
function _annPrefix(section){return section==='scene' ? 'sc' : 'an';}
function _annLabel(item, i){
  var t = (item && item.text && (item.text.en || item.text.ja)) || '(no text)';
  var s = toSRT(item.start || 0).split(',')[0];
  return (i+1) + '. ' + s + ' — ' + (t.length>40 ? t.substring(0,40)+'…' : t);
}

// ── sub-tab switching ───────────────────────────────────────────────────────

function _annShowSub(name){
  _ann.sub = name;
  ['scenes','notes','speakers','recnotes'].forEach(function(s){
    var pane=document.getElementById('ann-pane-'+s);
    if(pane)pane.style.display=(s===name?'':'none');
  });
  document.querySelectorAll('.ann-stbtn').forEach(function(b){
    b.classList.toggle('on', b.getAttribute('data-asub')===name);
  });
  _annUpdateRegions();
  if(name==='speakers')_spRender();
  if(name==='recnotes')_rnRender();
}

// ── load + render ───────────────────────────────────────────────────────────

function loadAnnotationsIntoPanel(){
  if(!window._activeFile){
    _annStatus('No project selected', true);
    _ann.scenes = []; _ann.annotations = []; _ann.characters = [];
    _annRenderScenes(); _annRenderNotes(); _spRender();
    return;
  }
  apiGet('/context').then(function(d){
    var ctx = (d && d.context) || {};
    _ann.scenes      = Array.isArray(ctx.scenes)      ? ctx.scenes      : [];
    _ann.annotations = Array.isArray(ctx.annotations) ? ctx.annotations : [];
    _ann.characters  = Array.isArray(ctx.characters)  ? ctx.characters  : [];
    if(_ann.sceneIdx >= _ann.scenes.length)      _ann.sceneIdx = Math.max(0, _ann.scenes.length-1);
    if(_ann.annIdx   >= _ann.annotations.length) _ann.annIdx   = Math.max(0, _ann.annotations.length-1);
    _annRenderScenes(); _annRenderNotes(); _spRender();
    _annStatus('Loaded '+_ann.scenes.length+' scenes, '
              +_ann.annotations.length+' annotations, '
              +_ann.characters.length+' characters');
  }).catch(function(e){_annStatus('Failed to load: '+e, true);});
}

function _annRenderSection(section){
  var prefix  = _annPrefix(section);
  var listKey = _annListKey(section);
  var idxKey  = _annIdxKey(section);
  var list    = _ann[listKey];
  var sel   = $(prefix+'-sel');
  var edit  = $(prefix+'-edit');
  var empty = $(prefix+'-empty');
  var del   = $(prefix+'-del');
  if(!list.length){
    if(sel)sel.innerHTML='';
    if(edit)edit.style.display='none';
    if(empty)empty.style.display='';
    if(del)del.disabled=true;
    return;
  }
  if(empty)empty.style.display='none';
  if(edit)edit.style.display='';
  if(del)del.disabled=false;

  if(sel){
    sel.innerHTML='';
    list.forEach(function(item, i){
      var o=document.createElement('option');
      o.value=i; o.textContent=_annLabel(item, i);
      sel.appendChild(o);
    });
    sel.value=String(_ann[idxKey]);
  }

  var item = list[_ann[idxKey]] || {start:0,end:0,text:{en:'',ja:''}};
  var cur  = $(prefix+'-time-cur'), dur = $(prefix+'-time-dur');
  if(cur)cur.textContent = toSRT(item.start||0) + ' → ' + toSRT(item.end||0);
  if(dur)dur.textContent = ((item.end||0) - (item.start||0)).toFixed(2) + 's';

  var ta=$(prefix+'-text');
  if(ta)ta.value = (item.text && item.text.en) || '';
  var tja=$(prefix+'-text-ja');
  if(tja)tja.textContent = (item.text && item.text.ja) || '(none yet)';

  // Slider — created lazily on first render so the panel is in the DOM
  _annEnsureSlider(section);
  var slEl=document.getElementById(prefix+'-slider');
  if(slEl && slEl._slider){
    var maxT = audioDur || 9999;
    slEl._slider.updateOptions({range:{min:0, max:Math.max(1, maxT)}}, false);
    slEl._slider.set([item.start||0, item.end||0], false);
  }
}

function _annRenderScenes(){_annRenderSection('scene'); _annUpdateRegions();}
function _annRenderNotes(){_annRenderSection('annotation'); _annUpdateRegions();}

// ── slider init (per sub-pane) ──────────────────────────────────────────────

function _annEnsureSlider(section){
  if(typeof noUiSlider==='undefined')return;
  var prefix=_annPrefix(section);
  var el=document.getElementById(prefix+'-slider');
  if(!el || el._slider) return;
  try{
    var slider = noUiSlider.create(el, {
      start:[0,1], connect:true, step:0.01,
      range:{min:0, max:1},
      tooltips:[
        {to:function(v){return toSRT(v);}},
        {to:function(v){return toSRT(v);}}
      ]
    });
    function onMove(vals){
      var listKey=_annListKey(section), idxKey=_annIdxKey(section);
      var item = _ann[listKey][_ann[idxKey]];
      if(!item)return;
      var s=parseFloat(vals[0]), e=Math.max(s+0.01, parseFloat(vals[1]));
      item.start=s; item.end=e;
      var cur=$(prefix+'-time-cur'); if(cur)cur.textContent=toSRT(s)+' → '+toSRT(e);
      var dur=$(prefix+'-time-dur'); if(dur)dur.textContent=(e-s).toFixed(2)+'s';
      _annUpdateRegions();
      _annSaveTimeDebounced(section);
    }
    slider.on('slide', onMove);
    slider.on('set',   onMove);
    el._slider=slider;
  }catch(e){console.error('annotations slider init failed:',e);}
}

// ── waveform region for current item ────────────────────────────────────────

function _annUpdateRegions(){
  if(_annRegion.scenes){try{_annRegion.scenes.remove();}catch(e){} _annRegion.scenes=null;}
  if(_annRegion.annotations){try{_annRegion.annotations.remove();}catch(e){} _annRegion.annotations=null;}
  if(!wsRegions || !audioDur)return;
  var topTab=document.querySelector('.toptbtn.on');
  if(!topTab || topTab.getAttribute('data-panel')!=='annotations')return;
  var section=_annSection();
  var key = section==='scene' ? 'scenes' : 'annotations';
  var item = _ann[key][_ann[_annIdxKey(section)]];
  if(!item || isNaN(item.start) || isNaN(item.end) || item.end <= item.start)return;
  var color = section==='scene' ? 'rgba(0,255,150,0.18)' : 'rgba(255,100,200,0.18)';
  try{
    _annRegion[key] = wsRegions.addRegion({
      start:item.start, end:item.end, color:color, drag:false, resize:false
    });
  }catch(e){}
}

// ── network ─────────────────────────────────────────────────────────────────

function _annSend(section, payload){
  return fetch('/context-edit', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(Object.assign({section:section}, payload))
  }).then(function(r){return r.json();});
}
function _annAcceptCtx(ctx){
  if(!ctx)return;
  if(Array.isArray(ctx.scenes))      _ann.scenes      = ctx.scenes;
  if(Array.isArray(ctx.annotations)) _ann.annotations = ctx.annotations;
}

// ── actions ────────────────────────────────────────────────────────────────

function _annAdd(section){
  if(!window._activeFile){_annStatus('No project selected',true);return;}
  var t0 = ws ? ws.getCurrentTime() : 0;
  var t1 = Math.min((audioDur||t0+5), t0 + 5);
  var listKey=_annListKey(section), idxKey=_annIdxKey(section);

  // Optimistic local insert + immediate render — don't wait for the round-trip.
  var newItem = {start:t0, end:t1, text:{en:'',ja:''}};
  _ann[listKey].push(newItem);
  _ann[idxKey] = _ann[listKey].length - 1;
  console.log('[ann] add '+section, 'now', _ann[listKey].length, 'items, focus idx', _ann[idxKey]);
  if(section==='scene')_annRenderScenes(); else _annRenderNotes();
  _annStatus('Saving new '+section+'…');

  _annSend(section, {action:'add', item:{start:t0, end:t1, text_en:''}})
    .then(function(d){
      if(!d.ok){
        // Server rejected — roll back
        _ann[listKey].pop();
        _ann[idxKey] = Math.max(0, _ann[listKey].length-1);
        if(section==='scene')_annRenderScenes(); else _annRenderNotes();
        _annStatus('⚠ '+(d.error||'add failed'),true);
        return;
      }
      // Trust the server's canonical state for IDs, but keep our focus idx.
      _annAcceptCtx(d.context);
      _ann[idxKey] = _ann[listKey].length - 1;
      if(section==='scene')_annRenderScenes(); else _annRenderNotes();
      _annStatus('✓ Added at '+toSRT(t0));
    }).catch(function(e){
      _ann[listKey].pop();
      _ann[idxKey] = Math.max(0, _ann[listKey].length-1);
      if(section==='scene')_annRenderScenes(); else _annRenderNotes();
      _annStatus('⚠ '+e,true);
    });
}

function _annDelete(section){
  if(!confirm('Delete this '+section+'?'))return;
  var listKey=_annListKey(section), idxKey=_annIdxKey(section);
  var deletedIdx = _ann[idxKey];
  var snapshot = _ann[listKey].slice();
  // Optimistic remove
  _ann[listKey].splice(deletedIdx, 1);
  if(_ann[idxKey] >= _ann[listKey].length) _ann[idxKey] = Math.max(0, _ann[listKey].length-1);
  if(section==='scene')_annRenderScenes(); else _annRenderNotes();
  _annStatus('Deleting…');

  _annSend(section, {action:'delete', index:deletedIdx})
    .then(function(d){
      if(!d.ok){
        _ann[listKey] = snapshot;
        _ann[idxKey] = deletedIdx;
        if(section==='scene')_annRenderScenes(); else _annRenderNotes();
        _annStatus('⚠ '+(d.error||'delete failed'),true);
        return;
      }
      _annAcceptCtx(d.context);
      if(_ann[idxKey] >= _ann[listKey].length)
        _ann[idxKey] = Math.max(0, _ann[listKey].length-1);
      if(section==='scene')_annRenderScenes(); else _annRenderNotes();
      _annStatus('✓ Deleted');
    }).catch(function(e){
      _ann[listKey] = snapshot;
      _ann[idxKey] = deletedIdx;
      if(section==='scene')_annRenderScenes(); else _annRenderNotes();
      _annStatus('⚠ '+e,true);
    });
}

function _annSaveText(section){
  var prefix=_annPrefix(section), idxKey=_annIdxKey(section);
  var ta=$(prefix+'-text'); if(!ta)return;
  _annStatus('Translating + saving…');
  _annSend(section, {action:'update', index:_ann[idxKey], item:{text_en: ta.value}})
    .then(function(d){
      if(!d.ok){_annStatus('⚠ '+(d.error||'save failed'),true);return;}
      _annAcceptCtx(d.context);
      if(section==='scene')_annRenderScenes(); else _annRenderNotes();
      _annStatus('✓ Saved & translated');
    }).catch(function(e){_annStatus('⚠ '+e,true);});
}

// Debounced time-only save (slider drag, nudges)
function _annSaveTimeDebounced(section){
  clearTimeout(_annSaveTimer[section]);
  _annSaveTimer[section] = setTimeout(function(){
    var listKey=_annListKey(section), idxKey=_annIdxKey(section);
    var item = _ann[listKey][_ann[idxKey]];
    if(!item)return;
    _annSend(section, {
      action:'update', index:_ann[idxKey],
      item:{start:item.start, end:item.end}
    }).then(function(d){
      if(d.ok){_annAcceptCtx(d.context);_annStatus('✓ Saved time');}
    });
  }, 700);
}

function _annNavTo(section, newIdx){
  var listKey=_annListKey(section), idxKey=_annIdxKey(section);
  var list=_ann[listKey];
  if(!list.length)return;
  _ann[idxKey] = Math.max(0, Math.min(newIdx, list.length-1));
  if(section==='scene')_annRenderScenes(); else _annRenderNotes();
  var item = list[_ann[idxKey]];
  if(item && ws){try{ws.setTime(item.start || 0);}catch(e){}}
}

function _annNudge(section, side, delta){
  var listKey=_annListKey(section), idxKey=_annIdxKey(section), prefix=_annPrefix(section);
  var item = _ann[listKey][_ann[idxKey]]; if(!item)return;
  if(side==='start') item.start = Math.max(0, item.start + delta);
  else               item.end   = Math.max(item.start+0.01, item.end + delta);
  var slEl=document.getElementById(prefix+'-slider');
  if(slEl && slEl._slider) slEl._slider.set([item.start, item.end], false);
  var cur=$(prefix+'-time-cur'); if(cur)cur.textContent=toSRT(item.start)+' → '+toSRT(item.end);
  var dur=$(prefix+'-time-dur'); if(dur)dur.textContent=(item.end-item.start).toFixed(2)+'s';
  _annUpdateRegions();
  _annSaveTimeDebounced(section);
}
function _annNudgeNow(section, side){
  var t = ws ? ws.getCurrentTime() : 0;
  var listKey=_annListKey(section), idxKey=_annIdxKey(section), prefix=_annPrefix(section);
  var item = _ann[listKey][_ann[idxKey]]; if(!item)return;
  if(side==='start') item.start = t;
  else               item.end   = Math.max(item.start+0.01, t);
  var slEl=document.getElementById(prefix+'-slider');
  if(slEl && slEl._slider) slEl._slider.set([item.start, item.end], false);
  var cur=$(prefix+'-time-cur'); if(cur)cur.textContent=toSRT(item.start)+' → '+toSRT(item.end);
  var dur=$(prefix+'-time-dur'); if(dur)dur.textContent=(item.end-item.start).toFixed(2)+'s';
  _annUpdateRegions();
  _annSaveTimeDebounced(section);
}

// ── Speakers sub-tab ────────────────────────────────────────────────────────
// Per-subtitle assignment of a character as speaker (radio-pill UX) plus an
// optional free-text note. Persisted on the subtitle entry as
//   {speaker: {en, ja} | absent, speaker_note: string | absent}
// so it travels with the records via the existing /save endpoint.

var _spSaveTimer = null;
function _spStatus(msg, warn){
  var el=$('sp-save-status'); if(!el)return;
  el.textContent=msg||'';
  el.style.color=warn?'#ffcc00':'#888';
}

function _spSaveDebounced(){
  clearTimeout(_spSaveTimer);
  _spStatus('Saving…');
  _spSaveTimer = setTimeout(function(){
    apiSave(entries).then(function(d){
      if(d&&d.ok){_spStatus('✓ Saved');}
      else{_spStatus('⚠ '+(d&&d.error||'save failed'), true);}
    }).catch(function(e){_spStatus('⚠ '+e, true);});
  }, 500);
}

function _spRender(){
  // Subtitle picker
  var sel=$('sp-sel');
  if(sel){
    sel.innerHTML='';
    if(!entries.length){
      var o=document.createElement('option');o.textContent='(no subtitles loaded)';
      sel.appendChild(o); sel.disabled=true;
    } else {
      sel.disabled=false;
      entries.forEach(function(e,i){
        var o=document.createElement('option');
        o.value=String(i);
        o.textContent=(i+1)+': '+(e.text||'').substring(0,40).replace(/\n/g,' ')+(((e.text||'').length>40)?'…':'');
        sel.appendChild(o);
      });
      if(idx>=0 && idx<entries.length) sel.value=String(idx);
    }
  }

  // Current subtitle preview
  var cur=$('sp-cur');
  if(cur){
    if(entries[idx]){
      var e=entries[idx];
      cur.textContent=(idx+1)+'\n'+toSRT(e.start)+' --> '+toSRT(e.end)+'\n'+(e.text||'');
    } else {
      cur.textContent='No subtitle selected';
    }
  }

  // Edit area visibility
  var noChars=$('sp-no-chars'), edit=$('sp-edit');
  var chars=_ann.characters||[];
  if(!chars.length){
    if(noChars)noChars.style.display='';
    if(edit)edit.style.display='none';
    return;
  }
  if(noChars)noChars.style.display='none';
  if(edit)edit.style.display='';

  // Pills
  var pills=$('sp-pills'); if(pills){
    pills.innerHTML='';
    var spk=(entries[idx] && entries[idx].speaker) || null;
    chars.forEach(function(ch,i){
      var nameEn=(ch.name && ch.name.en) || '';
      var nameJa=(ch.name && ch.name.ja) || '';
      var pill=document.createElement('button');
      pill.type='button';
      pill.className='sp-pill';
      pill.setAttribute('data-i', String(i));
      var html='<span class="en">'+_ctxEsc(nameEn||'(unnamed)')+'</span>';
      if(nameJa) html+='<span class="ja">'+_ctxEsc(nameJa)+'</span>';
      pill.innerHTML=html;
      // Match by EN name (stable identifier across renames of unrelated chars)
      var isOn = !!(spk && nameEn && spk.en === nameEn);
      if(isOn) pill.classList.add('on');
      pill.addEventListener('click', function(){_spTogglePill(i);});
      pills.appendChild(pill);
    });
  }

  // Note input
  var note=$('sp-note');
  if(note) note.value=(entries[idx] && entries[idx].speaker_note) || '';

  // Disable everything if no current subtitle
  var disabled = !entries[idx];
  if(pills)pills.querySelectorAll('button').forEach(function(b){b.disabled=disabled;});
  if(note)note.disabled=disabled;
}

function _spTogglePill(charIdx){
  if(!entries[idx])return;
  var ch=_ann.characters[charIdx]; if(!ch)return;
  var nameEn=(ch.name && ch.name.en) || '';
  var nameJa=(ch.name && ch.name.ja) || '';
  var current=entries[idx].speaker;
  if(current && current.en === nameEn){
    // Same pill — clear
    delete entries[idx].speaker;
  } else {
    entries[idx].speaker={en: nameEn, ja: nameJa};
  }
  _spRender();
  _spSaveDebounced();
}

function _spOnNoteInput(){
  if(!entries[idx])return;
  var v=($('sp-note')||{value:''}).value;
  if(v && v.trim()) entries[idx].speaker_note=v;
  else delete entries[idx].speaker_note;
  _spSaveDebounced();
}

// Hook used by player.js + editor.js so audio-follow / manual-nav refresh
// whichever Annotations sub-tab is currently visible.
window._spOnIdxChanged = function(){
  if(_ann.sub==='speakers')_spRender();
  else if(_ann.sub==='recnotes')_rnRender();
};

// ── Record Notes sub-tab ────────────────────────────────────────────────────
// Per-subtitle free-text note (e.g. transcription confidence, LLM hints).
// Persisted on the subtitle entry as {note: string | absent}.

var _rnSaveTimer = null;
function _rnStatus(msg, warn){
  var el=$('rn-save-status'); if(!el)return;
  el.textContent=msg||'';
  el.style.color=warn?'#ffcc00':'#888';
}
function _rnSaveDebounced(){
  clearTimeout(_rnSaveTimer);
  _rnStatus('Saving…');
  _rnSaveTimer = setTimeout(function(){
    apiSave(entries).then(function(d){
      if(d&&d.ok){_rnStatus('✓ Saved');}
      else{_rnStatus('⚠ '+(d&&d.error||'save failed'), true);}
    }).catch(function(e){_rnStatus('⚠ '+e, true);});
  }, 600);
}

function _rnRender(){
  var sel=$('rn-sel');
  if(sel){
    sel.innerHTML='';
    if(!entries.length){
      var o=document.createElement('option');o.textContent='(no subtitles loaded)';
      sel.appendChild(o); sel.disabled=true;
    } else {
      sel.disabled=false;
      entries.forEach(function(e,i){
        var o=document.createElement('option');
        o.value=String(i);
        var txt=(e.text||'').substring(0,40).replace(/\n/g,' ');
        var marker=e.note?' 📝':'';
        o.textContent=(i+1)+': '+txt+(((e.text||'').length>40)?'…':'')+marker;
        sel.appendChild(o);
      });
      if(idx>=0 && idx<entries.length) sel.value=String(idx);
    }
  }
  var cur=$('rn-cur');
  if(cur){
    if(entries[idx]){
      var e=entries[idx];
      cur.textContent=(idx+1)+'\n'+toSRT(e.start)+' --> '+toSRT(e.end)+'\n'+(e.text||'');
    } else {
      cur.textContent='No subtitle selected';
    }
  }
  var ta=$('rn-note');
  if(ta){
    ta.value=(entries[idx] && entries[idx].note) || '';
    ta.disabled = !entries[idx];
  }
}

function _rnOnNoteInput(){
  if(!entries[idx])return;
  var v=($('rn-note')||{value:''}).value;
  if(v && v.trim()) entries[idx].note=v;
  else delete entries[idx].note;
  _rnSaveDebounced();
}

// ── wiring ──────────────────────────────────────────────────────────────────

(function _wireAnnotations(){
  document.querySelectorAll('.ann-stbtn').forEach(function(b){
    b.addEventListener('click', function(){_annShowSub(b.getAttribute('data-asub'));});
  });

  ['scene','annotation'].forEach(function(section){
    var prefix=_annPrefix(section);
    var prev=$(prefix+'-prev'); if(prev)prev.addEventListener('click', function(){_annNavTo(section, _ann[_annIdxKey(section)]-1);});
    var next=$(prefix+'-next'); if(next)next.addEventListener('click', function(){_annNavTo(section, _ann[_annIdxKey(section)]+1);});
    var sel =$(prefix+'-sel');  if(sel) sel .addEventListener('change', function(){_annNavTo(section, parseInt(this.value, 10));});
    var add =$(prefix+'-add');  if(add) add .addEventListener('click', function(){_annAdd(section);});
    var del =$(prefix+'-del');  if(del) del .addEventListener('click', function(){_annDelete(section);});
    var save=$(prefix+'-save'); if(save)save.addEventListener('click', function(){_annSaveText(section);});

    [['s-dn','start',-0.5],['s-up','start',0.5],['e-dn','end',-0.5],['e-up','end',0.5]].forEach(function(spec){
      var b=$(prefix+'-'+spec[0]); if(b)b.addEventListener('click', function(){_annNudge(section, spec[1], spec[2]);});
    });
    var sn=$(prefix+'-s-now'); if(sn)sn.addEventListener('click', function(){_annNudgeNow(section, 'start');});
    var en=$(prefix+'-e-now'); if(en)en.addEventListener('click', function(){_annNudgeNow(section, 'end');});
  });

  // Speakers nav (uses the global subtitle idx + go() from editor.js)
  var spPrev=$('sp-prev'); if(spPrev)spPrev.addEventListener('click', function(){
    if(typeof go==='function')go(idx-1); _spRender();
  });
  var spNext=$('sp-next'); if(spNext)spNext.addEventListener('click', function(){
    if(typeof go==='function')go(idx+1); _spRender();
  });
  var spSel=$('sp-sel'); if(spSel)spSel.addEventListener('change', function(){
    if(typeof go==='function')go(parseInt(this.value,10)); _spRender();
  });
  var spNote=$('sp-note'); if(spNote)spNote.addEventListener('input', _spOnNoteInput);

  // Record Notes nav (also uses global subtitle idx + go() from editor.js)
  var rnPrev=$('rn-prev'); if(rnPrev)rnPrev.addEventListener('click', function(){
    if(typeof go==='function')go(idx-1); _rnRender();
  });
  var rnNext=$('rn-next'); if(rnNext)rnNext.addEventListener('click', function(){
    if(typeof go==='function')go(idx+1); _rnRender();
  });
  var rnSel=$('rn-sel'); if(rnSel)rnSel.addEventListener('change', function(){
    if(typeof go==='function')go(parseInt(this.value,10)); _rnRender();
  });
  var rnNote=$('rn-note'); if(rnNote)rnNote.addEventListener('input', _rnOnNoteInput);
})();
