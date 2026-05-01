// ── Annotations top-tab — Scenes + Annotations sub-panes ─────────────────────
// Shares the player + waveform with the Edit tab. Each sub-pane has its own
// noUiSlider, dropdown nav, and current-region highlight on the wave.
//
// Schema (project.context.scenes / .annotations):
//   [{ start: number, end: number, text: { en: string, ja: string } }, …]
//
// Slider drags / nudges send {start,end} only — no LLM round-trip.
// Save & translate sends {text_en} which the server runs through translate_to_japanese.

var _ann = { scenes: [], annotations: [], sceneIdx: 0, annIdx: 0 };
var _annRegion = { scenes: [], annotations: null };
var _annSaveTimer = { scene: null, annotation: null };

// ── helpers ─────────────────────────────────────────────────────────────────

function _annStatus(msg, warn){
  var el=$('ann-status');if(!el)return;
  el.textContent=msg||'';
  el.style.color=warn?'#ffcc00':'#888';
}
function _curSubTab(){
  var b=document.querySelector('.tbtn.on');
  return b ? b.getAttribute('data-tab') : '';
}
function _curTopTab(){
  var b=document.querySelector('.toptbtn.on');
  return b ? b.getAttribute('data-panel') : '';
}
// Selected item drives whether to show a scene tile or annotation marker on
// the wave when the merged Scenes sub-tab is active.
function _annSection(){
  if(_aeSel && _aeSel.type === 'annotation') return 'annotation';
  return 'scene';
}
function _annListKey(section){return section==='scene' ? 'scenes' : 'annotations';}
function _annIdxKey(section){return section==='scene' ? 'sceneIdx' : 'annIdx';}
function _annPrefix(section){return section==='scene' ? 'sc' : 'an';}
function _annLabel(item, i){
  var t = (item && item.text) || '(no text)';
  var s = toSRT(item.start || 0).split(',')[0];
  return (i+1) + '. ' + s + ' — ' + (t.length>40 ? t.substring(0,40)+'…' : t);
}

// ── sub-tab switching ───────────────────────────────────────────────────────

// Legacy stub — sub-tab switching is now handled by editor.js's .tbtn click
// handler, which dispatches to _aeRender / _recRender directly.

// ── load + render ───────────────────────────────────────────────────────────

function loadAnnotationsIntoPanel(){
  if(!window._activeFile){
    _annStatus('No project selected', true);
    _ann.scenes = []; _ann.annotations = []; _ann.characters = [];
    _annRenderScenes(); _annRenderNotes(); _recRender();
    return;
  }
  apiGet('/context').then(function(d){
    var ctx = (d && d.context) || {};
    _ann.scenes      = Array.isArray(ctx.scenes)      ? ctx.scenes      : [];
    _ann.annotations = Array.isArray(ctx.annotations) ? ctx.annotations : [];
    _ann.characters  = Array.isArray(ctx.characters)  ? ctx.characters  : [];
    if(_ann.sceneIdx >= _ann.scenes.length)      _ann.sceneIdx = Math.max(0, _ann.scenes.length-1);
    if(_ann.annIdx   >= _ann.annotations.length) _ann.annIdx   = Math.max(0, _ann.annotations.length-1);
    // Snap focus to wherever the audio cursor is right now — covers the
    // case where the user played to scene 3 in the Edit tab and only now
    // visited the Annotations tab.
    _annSyncSceneToTime();
    _annRenderScenes(); _annRenderNotes(); _recRender();
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

function _annRenderScenes(){_annRenderSection('scene'); _annUpdateRegions(); if(typeof _aeRender==='function')_aeRender();}
function _annRenderNotes(){_annRenderSection('annotation'); _annUpdateRegions(); if(typeof _aeRender==='function')_aeRender();}

// ── Merged Edit sub-tab — list of scenes + annotations with an inline editor.
var _aeMode = 'list';     // 'list' or 'edit'
var _aeSel  = null;        // {type:'scene'|'annotation', idx:number}

function _aeBuildItems(){
  var items = [];
  (_ann.scenes||[]).forEach(function(s, i){
    items.push({type:'scene', idx:i, start:(s.start||0), end:(s.end||0), text:(s.text||'')});
  });
  (_ann.annotations||[]).forEach(function(a, i){
    items.push({type:'annotation', idx:i, start:(a.start||0), text:(a.text||'')});
  });
  items.sort(function(a,b){return (a.start||0)-(b.start||0);});
  return items;
}

function _aeLabel(item){
  var prefix = item.type === 'scene' ? '🎬' : '📍';
  var t = toSRT(item.start || 0).split(',')[0];
  var raw = (item.text || '').replace(/\n/g,' ');
  var cap = raw.substring(0, 30);
  if(raw.length > 30) cap += '…';
  return prefix + ' ' + t + ' — ' + (cap || '(no text)');
}

function _aeCurrentItem(){
  if(!_aeSel) return null;
  if(_aeSel.type === 'scene')      return _ann.scenes[_aeSel.idx];
  if(_aeSel.type === 'annotation') return _ann.annotations[_aeSel.idx];
  return null;
}

function _aeRender(){
  if(_curSubTab() !== 'scenes') return;
  var listEl = $('ae-list'),  editEl = $('ae-edit-view'),  emptyEl = $('ae-empty');

  if(_aeMode === 'edit'){
    if(listEl)  listEl .style.display = 'none';
    if(editEl)  editEl .style.display = '';
    if(emptyEl) emptyEl.style.display = 'none';
    _aeRenderEditView();
    return;
  }

  // List view
  if(editEl) editEl.style.display = 'none';
  var items = _aeBuildItems();
  if(!items.length){
    if(listEl)  listEl .style.display = 'none';
    if(emptyEl) emptyEl.style.display = '';
    return;
  }
  if(listEl)  listEl .style.display = '';
  if(emptyEl) emptyEl.style.display = 'none';

  // If the current selection no longer exists, fall back to the first item.
  if(!_aeSel || !_aeCurrentItem()){
    _aeSel = {type: items[0].type, idx: items[0].idx};
  }

  var sel = $('ae-sel');
  if(sel){
    sel.innerHTML = '';
    items.forEach(function(it){
      var o = document.createElement('option');
      o.value = it.type + ':' + it.idx;
      o.textContent = _aeLabel(it);
      sel.appendChild(o);
    });
    sel.value = _aeSel.type + ':' + _aeSel.idx;
  }
}

function _aeRenderEditView(){
  var item = _aeCurrentItem();
  if(!item){ _aeMode='list'; _aeRender(); return; }

  var label = $('ae-edit-label');
  if(label){
    label.textContent = _aeSel.type === 'scene'
      ? 'SCENE ' + (_aeSel.idx + 1) + ' / ' + (_ann.scenes.length || 0)
      : 'ANNOTATION ' + (_aeSel.idx + 1) + ' / ' + (_ann.annotations.length || 0);
  }
  var time = $('ae-edit-time');
  if(time){
    if(_aeSel.type === 'scene'){
      time.textContent = toSRT(item.start || 0) + ' → ' + toSRT(item.end || 0);
    } else {
      time.textContent = '@ ' + toSRT(item.start || 0);
    }
  }
  var ta = $('ae-edit-text');
  if(ta && document.activeElement !== ta) ta.value = item.text || '';

  // Scene-specific UI: lock first scene's start, disable delete
  var isFirstScene = _aeSel.type === 'scene' && _aeSel.idx === 0;
  var hint = $('ae-first-hint');
  if(hint) hint.style.display = isFirstScene ? '' : 'none';
  document.querySelectorAll('[data-aenudge]').forEach(function(b){ b.disabled = isFirstScene; });
  var del = $('ae-edit-delete');
  if(del){
    if(_aeSel.type === 'scene'){
      del.disabled = isFirstScene || _ann.scenes.length <= 1;
    } else {
      del.disabled = false;
    }
  }
}

function _aeOnSelChange(){
  var sel = $('ae-sel'); if(!sel || !sel.value) return;
  var parts = sel.value.split(':');
  _aeSel = {type: parts[0], idx: parseInt(parts[1], 10)};
  _aeSyncIdx();
  _aeSeekToCurrent();
}
function _aeSyncIdx(){
  if(!_aeSel) return;
  if(_aeSel.type === 'scene')      _ann.sceneIdx = _aeSel.idx;
  else if(_aeSel.type === 'annotation') _ann.annIdx = _aeSel.idx;
}
function _aeSeekToCurrent(){
  var item = _aeCurrentItem();
  if(item && ws){ try{ ws.setTime(item.start || 0); }catch(e){} }
  _annUpdateRegions();
  _aeRender();
}
function _aePrev(){
  var items = _aeBuildItems(); if(!items.length) return;
  var i = items.findIndex(function(it){return _aeSel && it.type===_aeSel.type && it.idx===_aeSel.idx;});
  i = (i <= 0) ? items.length - 1 : i - 1;
  _aeSel = {type: items[i].type, idx: items[i].idx};
  _aeSyncIdx(); _aeSeekToCurrent();
}
function _aeNext(){
  var items = _aeBuildItems(); if(!items.length) return;
  var i = items.findIndex(function(it){return _aeSel && it.type===_aeSel.type && it.idx===_aeSel.idx;});
  i = (i < 0 || i >= items.length-1) ? 0 : i + 1;
  _aeSel = {type: items[i].type, idx: items[i].idx};
  _aeSyncIdx(); _aeSeekToCurrent();
}

function _aeOpenEdit(){
  if(!_aeCurrentItem()) return;
  _aeMode = 'edit';
  _aeRender();
}
function _aeBack(){ _aeMode = 'list'; _aeRender(); }

function _aeAddScene(){
  if(ws && ws.isPlaying()) ws.pause();
  var prevLen = _ann.scenes.length;
  _scSplit();
  if(_ann.scenes.length > prevLen){
    _aeSel = {type:'scene', idx: _ann.sceneIdx};
    _aeMode = 'edit';
    _aeRender();
  }
}
function _aeAddNote(){
  if(ws && ws.isPlaying()) ws.pause();
  var prevLen = _ann.annotations.length;
  _annAdd('annotation');
  if(_ann.annotations.length > prevLen){
    _aeSel = {type:'annotation', idx: _ann.annIdx};
    _aeMode = 'edit';
    _aeRender();
  }
}

function _aeNudge(delta){
  if(!_aeSel) return;
  _aeSyncIdx();
  _annNudge(_aeSel.type, 'start', parseFloat(delta));
  _aeRenderEditView();
}

function _aeOnTextInput(){
  var ta = $('ae-edit-text'); if(!ta || !_aeSel) return;
  var item = _aeCurrentItem(); if(!item) return;
  item.text = ta.value;
  _aeSyncIdx();
  // Reuse the existing per-section debounced text save
  if(typeof _annSaveTextDebounced === 'function') _annSaveTextDebounced(_aeSel.type);
}

function _aeDelete(){
  if(!_aeSel) return;
  _aeSyncIdx();
  _annDelete(_aeSel.type);
  // Whether the delete actually happened, fall back to list view; _aeRender
  // will re-pick a valid item.
  _aeMode = 'list';
  _aeSel = null;
  _aeRender();
}

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
  // Tiles only render while the merged "Scenes" sub-tab is active.
  if(_curTopTab() !== 'edit' || _curSubTab() !== 'scenes') return;
  var section=_annSection();

  if(section==='scene'){
    // Alternating tiles so scene boundaries are visible. The selected scene
    // gets a higher alpha so it pops without breaking the pattern. Avoiding
    // greens (the waveform is green).
    var even = 'rgba(255,170,60,';   // amber
    var odd  = 'rgba(180,110,240,';  // violet
    var sceneIdx = _ann.sceneIdx;
    _ann.scenes.forEach(function(s, i){
      var st = s.start || 0;
      var en = (s.end != null ? s.end : st);
      if(en <= st) return;
      var base  = (i % 2 === 0) ? even : odd;
      var alpha = (i === sceneIdx) ? '0.28)' : '0.08)';
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

// ── Records sub-tab — per-subtitle speaker + speaker note + record note ────
// Persisted on each subtitle entry:
//   speaker:        {en, ja} | absent
//   speaker_note:   string   | absent  ("talking to Simon", etc)
//   note:           string   | absent  (LLM hints, transcription confidence)
// Travels with the records via the existing /save endpoint.

var _recSaveTimer = null;
function _recStatus(msg, warn){
  var el=$('rec-save-status'); if(!el)return;
  el.textContent=msg||'';
  el.style.color=warn?'#ffcc00':'#888';
}
function _recSaveDebounced(){
  clearTimeout(_recSaveTimer);
  _recStatus('Saving…');
  _recSaveTimer = setTimeout(function(){
    apiSave(entries).then(function(d){
      if(d&&d.ok){_recStatus('✓ Saved');}
      else{_recStatus('⚠ '+(d&&d.error||'save failed'), true);}
    }).catch(function(e){_recStatus('⚠ '+e, true);});
  }, 500);
}

function _recRender(){
  // Subtitle picker — markers: 🎙 has speaker · 📝 has note
  var sel=$('rec-sel');
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
        var marker=(e.speaker?' 🎙':'')+(e.note?' 📝':'');
        var o=document.createElement('option');
        o.value=String(i);
        o.textContent=(i+1)+': '+raw.substring(0,40)+(raw.length>40?'…':'')+marker;
        sel.appendChild(o);
      });
      if(idx>=0 && idx<entries.length) sel.value=String(idx);
    }
  }

  // The shared #cur preview under the player handles the current subtitle —
  // we don't render anything here for that.
  var edit=$('rec-edit');
  if(edit) edit.style.display = entries[idx] ? '' : 'none';
  if(!entries[idx]) return;

  // Speaker section visibility — only show if characters exist
  var spkSec=$('rec-spk-section'), noChars=$('rec-no-chars');
  var chars=_ann.characters||[];
  if(spkSec)   spkSec.style.display   = chars.length ? '' : 'none';
  if(noChars)  noChars.style.display  = chars.length ? 'none' : '';

  // Pills
  var pills=$('rec-pills');
  if(pills && chars.length){
    pills.innerHTML='';
    var spk = entries[idx].speaker;
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
      pill.addEventListener('click', function(){_recTogglePill(i);});
      pills.appendChild(pill);
    });
  }

  // Speaker note + record note — fill from the entry
  var spnote=$('rec-spnote');
  if(spnote) spnote.value=(entries[idx].speaker_note) || '';
  var note=$('rec-note');
  if(note)   note.value=(entries[idx].note) || '';
}

function _recTogglePill(charIdx){
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
  _recRender();
  _recSaveDebounced();
}

function _recOnSpNoteInput(){
  if(!entries[idx])return;
  var v=($('rec-spnote')||{value:''}).value;
  if(v && v.trim()) entries[idx].speaker_note=v;
  else delete entries[idx].speaker_note;
  _recSaveDebounced();
}
function _recOnNoteInput(){
  if(!entries[idx])return;
  var v=($('rec-note')||{value:''}).value;
  if(v && v.trim()) entries[idx].note=v;
  else delete entries[idx].note;
  _recSaveDebounced();
}

// Hook used by player.js + editor.js so audio-follow / manual-nav refresh
// the Records sub-tab when its selection changes.
window._spOnIdxChanged = function(){
  if(_curSubTab() === 'speakers') _recRender();
};

// Find the scene that contains time t — falls through to the last scene if t
// is past the final boundary.
function _annSceneIdxAt(t){
  if(!_ann.scenes || !_ann.scenes.length) return -1;
  for(var i=0;i<_ann.scenes.length;i++){
    var s = _ann.scenes[i];
    var st = s.start || 0;
    var en = (s.end != null) ? s.end :
             (i+1 < _ann.scenes.length ? _ann.scenes[i+1].start : (audioDur||Infinity));
    if(t >= st && t < en) return i;
  }
  return _ann.scenes.length - 1;
}

// Snap sceneIdx to whatever scene the playback cursor is currently in.
// Returns true if it changed.
function _annSyncSceneToTime(){
  if(!ws || !_ann.scenes || !_ann.scenes.length) return false;
  var i = _annSceneIdxAt(ws.getCurrentTime());
  if(i < 0 || i === _ann.sceneIdx) return false;
  _ann.sceneIdx = i;
  return true;
}

// Auto-follow the playback cursor through scenes. Called from ws.timeupdate.
window._annOnTimeUpdate = function(){
  if(!ws || !audioDur) return;
  if(!_annSyncSceneToTime()) return;
  var onScenes = _curTopTab() === 'edit' && _curSubTab() === 'scenes';
  if(onScenes){
    if(_aeMode === 'list'){
      _aeSel = {type:'scene', idx: _ann.sceneIdx};
      _aeRender();
    } else {
      _annUpdateRegions();
    }
  } else {
    _annUpdateRegions();
  }
};

// ── wiring ──────────────────────────────────────────────────────────────────

(function _wireAnnotations(){
  // Merged Scenes sub-tab wiring
  var aeP=$('ae-prev');     if(aeP) aeP.addEventListener('click', _aePrev);
  var aeN=$('ae-next');     if(aeN) aeN.addEventListener('click', _aeNext);
  var aeS=$('ae-sel');      if(aeS) aeS.addEventListener('change', _aeOnSelChange);
  var aeAddSc=$('ae-scene-add'); if(aeAddSc) aeAddSc.addEventListener('click', _aeAddScene);
  var aeAddNt=$('ae-note-add');  if(aeAddNt) aeAddNt.addEventListener('click', _aeAddNote);
  var aeEd=$('ae-edit');    if(aeEd) aeEd.addEventListener('click', _aeOpenEdit);
  var aeBk=$('ae-edit-back'); if(aeBk) aeBk.addEventListener('click', _aeBack);
  var aeDel=$('ae-edit-delete'); if(aeDel) aeDel.addEventListener('click', _aeDelete);
  var aeTa=$('ae-edit-text');    if(aeTa) aeTa.addEventListener('input', _aeOnTextInput);
  document.querySelectorAll('[data-aenudge]').forEach(function(b){
    b.addEventListener('click', function(){_aeNudge(b.getAttribute('data-aenudge'));});
  });

  // Records nav (uses the global subtitle idx + go() from editor.js)
  var recPrev=$('rec-prev'); if(recPrev)recPrev.addEventListener('click', function(){
    if(typeof go==='function')go(idx-1); _recRender();
  });
  var recNext=$('rec-next'); if(recNext)recNext.addEventListener('click', function(){
    if(typeof go==='function')go(idx+1); _recRender();
  });
  var recSel=$('rec-sel'); if(recSel)recSel.addEventListener('change', function(){
    if(typeof go==='function')go(parseInt(this.value,10)); _recRender();
  });
  var recSpNote=$('rec-spnote'); if(recSpNote)recSpNote.addEventListener('input', _recOnSpNoteInput);
  var recNote=$('rec-note');     if(recNote)  recNote  .addEventListener('input', _recOnNoteInput);
})();
