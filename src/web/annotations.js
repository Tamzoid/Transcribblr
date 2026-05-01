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
var _annRegion = { scenes: [], annotations: null };
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
  var t = (item && item.text) || '(no text)';
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

// Scenes have stored {start, end}; annotations have {start} only (point-in-time).
function _annHasEnd(section){return section === 'scene';}

function _annRenderSection(section){
  var prefix  = _annPrefix(section);
  var listKey = _annListKey(section);
  var idxKey  = _annIdxKey(section);
  var list    = _ann[listKey];
  var sel   = $(prefix+'-sel');
  var edit  = $(prefix+'-edit');
  var empty = $(prefix+'-empty');
  var del   = $(prefix+'-del');
  var isScene = section === 'scene';

  if(!list.length){
    if(sel)sel.innerHTML='';
    if(edit)edit.style.display='none';
    if(empty)empty.style.display='';
    if(del)del.disabled=true;
    return;
  }
  if(empty)empty.style.display='none';
  if(edit)edit.style.display='';

  if(sel){
    sel.innerHTML='';
    list.forEach(function(item, i){
      var o=document.createElement('option');
      o.value=i; o.textContent=_annLabel(item, i);
      sel.appendChild(o);
    });
    sel.value=String(_ann[idxKey]);
  }

  var curIdx = _ann[idxKey];
  var item = list[curIdx] || {start:0, end:0, text:''};
  var cur  = $(prefix+'-time-cur'), dur = $(prefix+'-time-dur');
  if(isScene){
    var endT = item.end || 0;
    if(cur)cur.textContent = toSRT(item.start||0) + ' → ' + toSRT(endT);
    if(dur)dur.textContent = (endT - (item.start||0)).toFixed(2) + 's';
  } else {
    if(cur)cur.textContent = '@ ' + toSRT(item.start||0);
    if(dur)dur.textContent = '';
  }

  var ta=$(prefix+'-text');
  if(ta)ta.value = item.text || '';

  // Scenes — first scene's start is locked at 0 and can't be deleted.
  if(isScene){
    var isFirst = curIdx === 0;
    var only    = list.length <= 1;
    if(del) del.disabled = only || isFirst;
    var hint = $('sc-first-hint');
    if(hint) hint.style.display = isFirst ? '' : 'none';
    var nudges = $('sc-nudges');
    if(nudges){
      nudges.style.opacity = isFirst ? '0.4' : '1';
      nudges.querySelectorAll('button').forEach(function(b){b.disabled = isFirst;});
    }
  } else {
    if(del) del.disabled = false;
  }
}

function _annRenderScenes(){_annRenderSection('scene'); _annUpdateRegions();}
function _annRenderNotes(){_annRenderSection('annotation'); _annUpdateRegions();}

// ── slider init (per sub-pane) ──────────────────────────────────────────────

function _annEnsureSlider(section){
  // Annotations are point-in-time and have no slider — skip.
  if(!_annHasEnd(section))return;
  if(typeof noUiSlider==='undefined')return;
  var prefix=_annPrefix(section);
  var el=document.getElementById(prefix+'-slider');
  if(!el || el._slider) return;
  try{
    var hasEnd=_annHasEnd(section);
    var slider = noUiSlider.create(el, hasEnd ? {
      start:[0,1], connect:true, step:0.01,
      range:{min:0, max:1},
      tooltips:[
        {to:function(v){return toSRT(v);}},
        {to:function(v){return toSRT(v);}}
      ]
    } : {
      start:[0], step:0.01,
      range:{min:0, max:1},
      tooltips:[{to:function(v){return toSRT(v);}}]
    });
    function onMove(vals){
      var listKey=_annListKey(section), idxKey=_annIdxKey(section);
      var item = _ann[listKey][_ann[idxKey]];
      if(!item)return;
      if(hasEnd){
        var s=parseFloat(vals[0]), e=Math.max(s+0.01, parseFloat(vals[1]));
        item.start=s; item.end=e;
        var cur=$(prefix+'-time-cur'); if(cur)cur.textContent=toSRT(s)+' → '+toSRT(e);
        var dur=$(prefix+'-time-dur'); if(dur)dur.textContent=(e-s).toFixed(2)+'s';
      } else {
        var t=parseFloat(vals[0]);
        item.start=t;
        delete item.end;
        var cur=$(prefix+'-time-cur'); if(cur)cur.textContent='@ '+toSRT(t);
      }
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
  // Tear down any previous regions
  if(Array.isArray(_annRegion.scenes)){
    _annRegion.scenes.forEach(function(r){try{r.remove();}catch(e){}});
  }
  _annRegion.scenes = [];
  if(_annRegion.annotations){try{_annRegion.annotations.remove();}catch(e){} _annRegion.annotations=null;}
  if(!wsRegions || !audioDur)return;
  var topTab=document.querySelector('.toptbtn.on');
  if(!topTab || topTab.getAttribute('data-panel')!=='annotations')return;
  var section=_annSection();

  if(section==='scene'){
    // Render every scene as an alternating-colour tile so boundaries are
    // visible at a glance. The selected scene is drawn at higher alpha.
    var even = 'rgba(0,255,150,';   // green-ish
    var odd  = 'rgba(0,200,255,';   // cyan-ish
    var sceneIdx = _ann.sceneIdx;
    _ann.scenes.forEach(function(s, i){
      var st = s.start || 0;
      var en = (s.end != null ? s.end : st);
      if(en <= st) return;
      var base  = (i % 2 === 0) ? even : odd;
      var alpha = (i === sceneIdx) ? '0.45)' : '0.15)';
      try{
        _annRegion.scenes.push(wsRegions.addRegion({
          start: st, end: en, color: base + alpha,
          drag: false, resize: false
        }));
      }catch(e){}
    });
  } else {
    // Point-in-time annotation marker — thin fixed-width (independent of zoom).
    var item = _ann.annotations[_ann.annIdx];
    if(!item || isNaN(item.start)) return;
    var s = item.start;
    var w = 0.1;
    try{
      _annRegion.annotations = wsRegions.addRegion({
        start:Math.max(0, s - w/2), end:s + w/2,
        color:'rgba(255,100,200,0.85)', drag:false, resize:false
      });
    }catch(e){}
  }
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

// Annotations only — scene "add" is the dedicated _scSplit below.
function _annAdd(section){
  if(section === 'scene'){return _scSplit();}
  if(!window._activeFile){_annStatus('No project selected',true);return;}
  var t0 = ws ? ws.getCurrentTime() : 0;
  var listKey=_annListKey(section), idxKey=_annIdxKey(section);
  var newItem    = {start:t0, text:''};
  var requestItem= {start:t0, text:''};

  _ann[listKey].push(newItem);
  _ann[idxKey] = _ann[listKey].length - 1;
  _annRenderNotes();
  _annStatus('Saving new annotation…');

  _annSend(section, {action:'add', item:requestItem})
    .then(function(d){
      if(!d.ok){
        _ann[listKey].pop();
        _ann[idxKey] = Math.max(0, _ann[listKey].length-1);
        _annRenderNotes();
        _annStatus('⚠ '+(d.error||'add failed'),true);
        return;
      }
      _annAcceptCtx(d.context);
      _ann[idxKey] = _ann[listKey].length - 1;
      _annRenderNotes();
      _annStatus('✓ Added at '+toSRT(t0));
    }).catch(function(e){
      _ann[listKey].pop();
      _ann[idxKey] = Math.max(0, _ann[listKey].length-1);
      _annRenderNotes();
      _annStatus('⚠ '+e,true);
    });
}

// Scene split — bisects the host scene at the current playback time.
function _scSplit(){
  if(!window._activeFile){_annStatus('No project selected',true);return;}
  var t = ws ? ws.getCurrentTime() : 0;
  if(t <= 0.05){_annStatus('Cannot split at 0:00', true);return;}
  var host = -1;
  for(var i=0; i<_ann.scenes.length; i++){
    var s = _ann.scenes[i];
    if(t > (s.start||0) + 0.05 && t < (s.end||0) - 0.05){host=i;break;}
  }
  if(host < 0){
    _annStatus('Cannot split here — too close to a scene boundary', true);
    return;
  }

  // Optimistic bisect
  var snap = JSON.parse(JSON.stringify(_ann.scenes));
  var hostEnd = _ann.scenes[host].end;
  _ann.scenes[host].end = t;
  _ann.scenes.splice(host+1, 0, {start:t, end:hostEnd, text:''});
  _ann.sceneIdx = host + 1;
  _annRenderScenes();
  _annStatus('Splitting at '+toSRT(t)+'…');

  _annSend('scene', {action:'add', item:{start:t, text:''}})
    .then(function(d){
      if(!d.ok){
        _ann.scenes = snap;
        _ann.sceneIdx = Math.min(_ann.sceneIdx, _ann.scenes.length-1);
        _annRenderScenes();
        _annStatus('⚠ '+(d.error||'split failed'), true);
        return;
      }
      _annAcceptCtx(d.context);
      if(typeof d.new_idx === 'number') _ann.sceneIdx = d.new_idx;
      _annRenderScenes();
      _annStatus('✓ Split');
    })
    .catch(function(e){
      _ann.scenes = snap;
      _annRenderScenes();
      _annStatus('⚠ '+e, true);
    });
}

function _annDelete(section){
  var listKey=_annListKey(section), idxKey=_annIdxKey(section);
  var deletedIdx = _ann[idxKey];

  if(section === 'scene'){
    if(deletedIdx === 0){_annStatus("Can't delete the first scene", true); return;}
    if(_ann.scenes.length <= 1){_annStatus("Can't delete the last scene", true); return;}
    if(!confirm('Merge this scene into the previous one?'))return;
    var snap = JSON.parse(JSON.stringify(_ann.scenes));
    var prev = _ann.scenes[deletedIdx-1];
    var here = _ann.scenes[deletedIdx];
    prev.end = here.end;
    _ann.scenes.splice(deletedIdx, 1);
    _ann.sceneIdx = deletedIdx - 1;
    _annRenderScenes();
    _annStatus('Merging…');
    _annSend('scene', {action:'delete', index:deletedIdx})
      .then(function(d){
        if(!d.ok){
          _ann.scenes = snap;
          _ann.sceneIdx = deletedIdx;
          _annRenderScenes();
          _annStatus('⚠ '+(d.error||'merge failed'), true);
          return;
        }
        _annAcceptCtx(d.context);
        if(typeof d.new_idx === 'number') _ann.sceneIdx = d.new_idx;
        _annRenderScenes();
        _annStatus('✓ Merged');
      })
      .catch(function(e){
        _ann.scenes = snap;
        _ann.sceneIdx = deletedIdx;
        _annRenderScenes();
        _annStatus('⚠ '+e, true);
      });
    return;
  }

  // Annotation delete — simple remove.
  if(!confirm('Delete this annotation?'))return;
  var snapshot = _ann[listKey].slice();
  _ann[listKey].splice(deletedIdx, 1);
  if(_ann[idxKey] >= _ann[listKey].length) _ann[idxKey] = Math.max(0, _ann[listKey].length-1);
  _annRenderNotes();
  _annStatus('Deleting…');

  _annSend(section, {action:'delete', index:deletedIdx})
    .then(function(d){
      if(!d.ok){
        _ann[listKey] = snapshot;
        _ann[idxKey] = deletedIdx;
        _annRenderNotes();
        _annStatus('⚠ '+(d.error||'delete failed'),true);
        return;
      }
      _annAcceptCtx(d.context);
      if(_ann[idxKey] >= _ann[listKey].length)
        _ann[idxKey] = Math.max(0, _ann[listKey].length-1);
      _annRenderNotes();
      _annStatus('✓ Deleted');
    }).catch(function(e){
      _ann[listKey] = snapshot;
      _ann[idxKey] = deletedIdx;
      _annRenderNotes();
      _annStatus('⚠ '+e,true);
    });
}

// Update only the dropdown option labels — used after auto-save so the option
// text reflects the new content without clobbering the textarea the user is
// currently typing into.
function _annRefreshDropdown(section){
  var prefix=_annPrefix(section), idxKey=_annIdxKey(section);
  var sel=$(prefix+'-sel'); if(!sel)return;
  var list=_ann[_annListKey(section)];
  list.forEach(function(item, i){
    var opt=sel.options[i];
    if(opt)opt.textContent=_annLabel(item, i);
  });
  sel.value=String(_ann[idxKey]);
}

var _annTextSaveTimer = {scene: null, annotation: null};
function _annSaveTextDebounced(section){
  clearTimeout(_annTextSaveTimer[section]);
  _annTextSaveTimer[section] = setTimeout(function(){
    var prefix=_annPrefix(section), idxKey=_annIdxKey(section);
    var ta=$(prefix+'-text'); if(!ta)return;
    var val=ta.value;
    var item=_ann[_annListKey(section)][_ann[idxKey]];
    if(item)item.text=val;
    _annStatus('Saving…');
    _annSend(section, {action:'update', index:_ann[idxKey], item:{text: val}})
      .then(function(d){
        if(!d.ok){_annStatus('⚠ '+(d.error||'save failed'),true);return;}
        _annAcceptCtx(d.context);
        // Don't re-render the textarea (user may still be typing). Just
        // refresh the dropdown labels so they reflect the new text.
        _annRefreshDropdown(section);
        _annStatus('✓ Saved');
      }).catch(function(e){_annStatus('⚠ '+e,true);});
  }, 600);
}

// Debounced time-only save (slider drag, nudges)
function _annSaveTimeDebounced(section){
  clearTimeout(_annSaveTimer[section]);
  _annSaveTimer[section] = setTimeout(function(){
    var listKey=_annListKey(section), idxKey=_annIdxKey(section);
    var item = _ann[listKey][_ann[idxKey]];
    if(!item)return;
    var payload = {action:'update', index:_ann[idxKey], item:{start:item.start}};
    if(_annHasEnd(section)) payload.item.end = item.end;
    _annSend(section, payload).then(function(d){
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

function _annAfterTimeChange(section){
  var listKey=_annListKey(section), idxKey=_annIdxKey(section), prefix=_annPrefix(section);
  var item = _ann[listKey][_ann[idxKey]]; if(!item)return;
  var slEl=document.getElementById(prefix+'-slider');
  if(slEl && slEl._slider){
    if(_annHasEnd(section)) slEl._slider.set([item.start, item.end], false);
    else                    slEl._slider.set([item.start], false);
  }
  var cur=$(prefix+'-time-cur');
  if(cur){
    if(_annHasEnd(section)) cur.textContent=toSRT(item.start)+' → '+toSRT(item.end);
    else                    cur.textContent='@ '+toSRT(item.start);
  }
  var dur=$(prefix+'-time-dur');
  if(dur)dur.textContent=_annHasEnd(section)?(item.end-item.start).toFixed(2)+'s':'';
  _annUpdateRegions();
  _annSaveTimeDebounced(section);
}
function _annNudge(section, side, delta){
  var idxKey=_annIdxKey(section);
  var i = _ann[idxKey];
  if(section === 'scene'){
    // First scene's start is locked. For others, moving start also moves the
    // previous scene's end (contiguous tiling).
    if(i === 0) return;
    var cur = _ann.scenes[i], prev = _ann.scenes[i-1];
    if(!cur || !prev) return;
    var lower = (prev.start || 0) + 0.05;
    var upper = (cur.end   || 0) - 0.05;
    var newStart = Math.max(lower, Math.min(upper, (cur.start || 0) + delta));
    cur.start = newStart;
    prev.end  = newStart;
  } else {
    var item = _ann.annotations[i]; if(!item)return;
    if(side==='start') item.start = Math.max(0, (item.start||0) + delta);
  }
  _annAfterTimeChange(section);
}
function _annNudgeNow(section, side){
  var t = ws ? ws.getCurrentTime() : 0;
  var idxKey=_annIdxKey(section);
  var i = _ann[idxKey];
  if(section === 'scene'){
    if(i === 0) return;
    var cur = _ann.scenes[i], prev = _ann.scenes[i-1];
    if(!cur || !prev) return;
    var lower = (prev.start || 0) + 0.05;
    var upper = (cur.end   || 0) - 0.05;
    var newStart = Math.max(lower, Math.min(upper, t));
    cur.start = newStart;
    prev.end  = newStart;
  } else {
    var item = _ann.annotations[i]; if(!item)return;
    if(side==='start') item.start = t;
  }
  _annAfterTimeChange(section);
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
        var l=_laneObj(e.text);
        var raw=(l.ja||l.en||l.ro||'').replace(/\n/g,' ');
        var o=document.createElement('option');
        o.value=String(i);
        o.textContent=(i+1)+': '+raw.substring(0,40)+(raw.length>40?'…':'');
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
      cur.textContent=(idx+1)+'\n'+toSRT(e.start)+' --> '+toSRT(e.end)+'\n'+laneText(e.text);
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

  // Pills — characters are bilingual {name:{en,ja}} after restoring translation.
  // Stay tolerant of legacy plain-string names.
  var pills=$('sp-pills'); if(pills){
    pills.innerHTML='';
    var spk = entries[idx] && entries[idx].speaker;
    var spkEn = (spk && typeof spk === 'object') ? (spk.en || '')
              : (typeof spk === 'string' ? spk : '');
    chars.forEach(function(ch,i){
      var n = (ch && ch.name) || '';
      var nameEn = (n && typeof n === 'object') ? (n.en || '')
                 : (typeof n === 'string' ? n : '');
      var nameJa = (n && typeof n === 'object') ? (n.ja || '') : '';
      var pill=document.createElement('button');
      pill.type='button';
      pill.className='sp-pill';
      pill.setAttribute('data-i', String(i));
      var html='<span class="en">'+_ctxEsc(nameEn||'(unnamed)')+'</span>';
      if(nameJa) html+='<span class="ja">'+_ctxEsc(nameJa)+'</span>';
      pill.innerHTML=html;
      if(spkEn && nameEn && spkEn === nameEn) pill.classList.add('on');
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
  var n = ch.name || '';
  var nameEn = (n && typeof n === 'object') ? (n.en || '')
             : (typeof n === 'string' ? n : '');
  var nameJa = (n && typeof n === 'object') ? (n.ja || '') : '';
  var cur = entries[idx].speaker;
  var curEn = (cur && typeof cur === 'object') ? (cur.en || '')
            : (typeof cur === 'string' ? cur : '');
  if(curEn && nameEn && curEn === nameEn){
    delete entries[idx].speaker;
  } else {
    entries[idx].speaker = {en: nameEn, ja: nameJa};
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

// Auto-follow the playback cursor through scenes — also clears stale regions
// when the user has switched to a different top-tab. Called from player.js
// every timeupdate.
window._annOnTimeUpdate = function(){
  // Always re-evaluate region visibility — _annUpdateRegions itself short
  // circuits + tears down when the top tab isn't annotations any more.
  if(!ws || !audioDur) return;
  var topTab = document.querySelector('.toptbtn.on');
  var onAnn  = topTab && topTab.getAttribute('data-panel') === 'annotations';

  // Drive scene selection from playback time
  if(_ann.scenes && _ann.scenes.length){
    var t = ws.getCurrentTime();
    var newIdx = -1;
    for(var i=0;i<_ann.scenes.length;i++){
      var s = _ann.scenes[i];
      var st = s.start || 0;
      var en = (s.end != null) ? s.end :
               (i+1 < _ann.scenes.length ? _ann.scenes[i+1].start : (audioDur||Infinity));
      if(t >= st && t < en){ newIdx = i; break; }
    }
    if(newIdx === -1 && _ann.scenes.length){ newIdx = _ann.scenes.length - 1; }
    if(newIdx !== -1 && newIdx !== _ann.sceneIdx){
      _ann.sceneIdx = newIdx;
      if(onAnn && _ann.sub === 'scenes') _annRenderScenes();
      else _annUpdateRegions();  // keep regions in sync even if sub-tab is hidden
    }
  }
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
        var l=_laneObj(e.text);
        var raw=(l.ja||l.en||l.ro||'').replace(/\n/g,' ');
        var marker=e.note?' 📝':'';
        var o=document.createElement('option');
        o.value=String(i);
        o.textContent=(i+1)+': '+raw.substring(0,40)+(raw.length>40?'…':'')+marker;
        sel.appendChild(o);
      });
      if(idx>=0 && idx<entries.length) sel.value=String(idx);
    }
  }
  var cur=$('rn-cur');
  if(cur){
    if(entries[idx]){
      var e=entries[idx];
      cur.textContent=(idx+1)+'\n'+toSRT(e.start)+' --> '+toSRT(e.end)+'\n'+laneText(e.text);
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
    var add =$(prefix+'-add');   if(add) add  .addEventListener('click', function(){_annAdd(section);});
    var spl =$(prefix+'-split'); if(spl) spl  .addEventListener('click', function(){_scSplit();});
    var del =$(prefix+'-del');  if(del) del .addEventListener('click', function(){_annDelete(section);});
    var ta=$(prefix+'-text'); if(ta)ta.addEventListener('input', function(){_annSaveTextDebounced(section);});

    // Both scenes and annotations now use the same 4-button start-only nudges.
    // For scenes, _annNudge cascades the change to the previous scene's end.
    [['s-dd','start',-1.0],['s-d','start',-0.5],
     ['s-u','start',0.5], ['s-uu','start',1.0]].forEach(function(spec){
      var b=$(prefix+'-'+spec[0]);
      if(b)b.addEventListener('click', function(){_annNudge(section, spec[1], spec[2]);});
    });
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
