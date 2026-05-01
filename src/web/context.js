// ── Context tab — sub-tabs: Overview / Generate / Edit / Characters ─────────
// Schema is BILINGUAL for fields the LLM owns:
//   synopsis/description/tone:   {en, ja}
//   vocabulary:                  {en: [], ja: []}
//   characters: [{name:{en,ja}, aliases:{en,ja}, description:{en,ja}}]
// Plain English (no JA mirror) for:
//   scenes / annotations / record-notes (handled in annotations.js)

var _ctxCurrent = null;

// Bilingual readers — accept new {en,ja} or fall back to a plain string.
function _ctxBi(v){
  if(v == null) return {en:'', ja:''};
  if(typeof v === 'string') return {en:v, ja:''};
  return {en: v.en || '', ja: v.ja || ''};
}
function _ctxBiList(v){
  if(Array.isArray(v)) return {en:v, ja:[]};
  if(v && typeof v === 'object') return {en: v.en || [], ja: v.ja || []};
  return {en:[], ja:[]};
}

function _ctxStatus(msg, warn){
  var el=$('ctx-status');if(!el)return;
  el.textContent=msg||'';
  el.style.color=warn?'#ffcc00':'#888';
}
function _ctxLogLine(line){
  var box=$('ctx-progress'),pre=$('ctx-progress-log');
  if(!box||!pre)return;
  box.style.display='';
  pre.textContent+=(pre.textContent?'\n':'')+line;
  pre.scrollTop=pre.scrollHeight;
}
function _ctxClearLog(){
  var pre=$('ctx-progress-log');if(pre)pre.textContent='';
  var box=$('ctx-progress');if(box)box.style.display='none';
}
function _ctxEsc(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Sub-tab switching ────────────────────────────────────────────────────────

function _ctxShowSub(name){
  var panes={overview:'ctx-pane-overview',generate:'ctx-pane-generate',
             edit:'ctx-pane-edit',chars:'ctx-pane-chars'};
  document.querySelectorAll('.ctx-stbtn').forEach(function(b){
    b.classList.toggle('on', b.getAttribute('data-csub')===name);
  });
  Object.keys(panes).forEach(function(k){
    var el=document.getElementById(panes[k]);if(el)el.style.display=(k===name?'':'none');
  });
  if(name==='overview')_ctxRenderOverview();
  if(name==='edit')   _ctxRenderEdit();
  if(name==='chars')  _ctxRenderChars();
}

// ── Load context from server ─────────────────────────────────────────────────

function loadContextIntoPanel(){
  if(!window._activeFile){
    _ctxStatus('No project selected — pick one to start',true);
    _ctxCurrent=null;
    _ctxRenderOverview();_ctxRenderEdit();_ctxRenderChars();
    return;
  }
  console.log('[ctx] loadContextIntoPanel for', window._activeFile);
  _ctxStatus('Loading existing context…');
  apiGet('/context').then(function(d){
    _ctxCurrent = (d&&d.context) || null;
    console.log('[ctx] /context →', _ctxCurrent ? Object.keys(_ctxCurrent) : 'null');
    if(_ctxCurrent){
      _ctxStatus('Loaded context for '+window._activeFile);
    } else {
      _ctxStatus('No context yet for '+window._activeFile+' — generate one in Generate');
    }
    _ctxRenderOverview();_ctxRenderEdit();_ctxRenderChars();
  }).catch(function(e){
    console.error('[ctx] /context failed:', e);
    _ctxStatus('Failed to load: '+e,true);
  });
}

// ── Overview rendering ───────────────────────────────────────────────────────

function _ctxRenderOverview(){
  var ctx=_ctxCurrent;
  var empty=$('ov-empty');
  ['ov-sec-synopsis','ov-sec-description','ov-sec-tone','ov-sec-vocab','ov-sec-chars'].forEach(function(id){
    var el=document.getElementById(id);if(el)el.style.display=ctx?'':'none';
  });
  if(!ctx){if(empty)empty.style.display='';return;}
  if(empty)empty.style.display='none';

  function setBi(idEn, idJa, val){
    var b=_ctxBi(val);
    var en=document.getElementById(idEn), ja=document.getElementById(idJa);
    if(en)en.textContent=b.en||'(none)';
    if(ja)ja.textContent=b.ja||'(なし)';
  }
  setBi('ov-syn-en',  'ov-syn-ja',  ctx.synopsis);
  setBi('ov-desc-en', 'ov-desc-ja', ctx.description);
  setBi('ov-tone-en', 'ov-tone-ja', ctx.tone);

  var vocabEl=$('ov-vocab');
  if(vocabEl){
    var v = _ctxBiList(ctx.vocabulary);
    var en=v.en||[], ja=v.ja||[];
    vocabEl.innerHTML='';
    if(!en.length){vocabEl.innerHTML='<span class="muted">(empty)</span>';}
    else en.forEach(function(term, i){
      var chip=document.createElement('span');
      chip.className='ctx-chip';
      chip.innerHTML=_ctxEsc(term)+(ja[i]?'<span class="ja">'+_ctxEsc(ja[i])+'</span>':'');
      vocabEl.appendChild(chip);
    });
  }

  var charsEl=$('ov-chars'),countEl=$('ov-char-count');
  var chars=Array.isArray(ctx.characters)?ctx.characters:[];
  if(countEl)countEl.textContent='('+chars.length+')';
  if(charsEl){
    charsEl.innerHTML='';
    if(!chars.length){charsEl.innerHTML='<span class="muted">(none)</span>';}
    else chars.forEach(function(ch){
      var card=document.createElement('div');card.className='ctx-char-card';
      var n=_ctxBi(ch.name), a=_ctxBiList(ch.aliases), d=_ctxBi(ch.description);
      var html='<div class="ch-name">'+_ctxEsc(n.en||'(unnamed)')
              +(n.ja?'<span class="ja">'+_ctxEsc(n.ja)+'</span>':'')+'</div>';
      if((a.en||[]).length){
        html+='<div class="ch-aliases">aka: '+_ctxEsc((a.en||[]).join(', '))
             +(a.ja&&a.ja.length?' / '+_ctxEsc(a.ja.join(', ')):'')+'</div>';
      }
      if(d.en||d.ja){
        html+='<div class="ch-desc">'+_ctxEsc(d.en||d.ja)+'</div>';
      }
      card.innerHTML=html;
      charsEl.appendChild(card);
    });
  }
}

// ── Edit rendering ───────────────────────────────────────────────────────────

function _ctxRenderEdit(){
  var ctx=_ctxCurrent||{};
  function setField(id, jaId, val){
    var b=_ctxBi(val);
    var el=document.getElementById(id), ja=document.getElementById(jaId);
    if(el)el.value=b.en||'';
    if(ja)ja.textContent=b.ja||'(none yet)';
  }
  setField('ed-synopsis',    'ed-synopsis-ja',    ctx.synopsis);
  setField('ed-description', 'ed-description-ja', ctx.description);
  setField('ed-tone',        'ed-tone-ja',        ctx.tone);

  var v=_ctxBiList(ctx.vocabulary);
  var ta=$('ed-vocab');if(ta)ta.value=(v.en||[]).join('\n');
  var jaSpan=$('ed-vocab-ja');
  if(jaSpan)jaSpan.textContent=(v.ja||[]).join(', ')||'(none yet)';
}

function _ctxSaveText(field){
  if(!_ctxRequireProject())return;
  var el=document.getElementById('ed-'+field);if(!el)return;
  _ctxStatus('Translating + saving '+field+'…');
  fetch('/context-edit',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({section:'text',field:field,value:el.value})
  }).then(function(r){return r.json();}).then(function(d){
    if(!d.ok){_ctxStatus('⚠ '+(d.error||'save failed'),true);return;}
    _ctxCurrent=d.context;
    _ctxStatus('✓ Saved '+field);
    _ctxRenderEdit();_ctxRenderOverview();
  }).catch(function(e){_ctxStatus('⚠ '+e,true);});
}

function _ctxSaveVocab(){
  if(!_ctxRequireProject())return;
  var ta=$('ed-vocab');if(!ta)return;
  var lines=ta.value.split('\n').map(function(s){return s.trim();}).filter(Boolean);
  _ctxStatus('Translating + saving '+lines.length+' vocab terms…');
  fetch('/context-edit',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({section:'vocabulary',vocabulary:lines})
  }).then(function(r){return r.json();}).then(function(d){
    if(!d.ok){_ctxStatus('⚠ '+(d.error||'save failed'),true);return;}
    _ctxCurrent=d.context;
    _ctxStatus('✓ Saved vocabulary ('+lines.length+' terms)');
    _ctxRenderEdit();_ctxRenderOverview();
  }).catch(function(e){_ctxStatus('⚠ '+e,true);});
}

// ── Characters rendering ─────────────────────────────────────────────────────

function _ctxRenderChars(){
  var listEl=$('ctx-chars-list');if(!listEl)return;
  listEl.innerHTML='';
  var chars=(_ctxCurrent&&Array.isArray(_ctxCurrent.characters))?_ctxCurrent.characters:[];
  if(!chars.length){
    listEl.innerHTML='<span class="muted">No characters yet — tap "Add Character".</span>';
  }
  chars.forEach(function(ch,i){
    var card=document.createElement('div');card.className='ctx-char-card';
    var n=_ctxBi(ch.name), a=_ctxBiList(ch.aliases), d=_ctxBi(ch.description);
    var html='<div class="ch-name">'+_ctxEsc(n.en||'(unnamed)')
            +(n.ja?'<span class="ja">'+_ctxEsc(n.ja)+'</span>':'')+'</div>';
    if((a.en||[]).length){
      html+='<div class="ch-aliases">aka: '+_ctxEsc((a.en||[]).join(', '))
           +(a.ja&&a.ja.length?' / '+_ctxEsc(a.ja.join(', ')):'')+'</div>';
    }
    if(d.en){html+='<div class="ch-desc">'+_ctxEsc(d.en)+'</div>';}
    html+='<div class="ch-actions">'
         +'<button class="btn ch-edit" data-i="'+i+'">✎ Edit</button>'
         +'<button class="btn ch-del"  data-i="'+i+'">🗑 Delete</button>'
         +'</div>';
    card.innerHTML=html;
    listEl.appendChild(card);
  });
  listEl.querySelectorAll('.ch-edit').forEach(function(b){
    b.addEventListener('click',function(){_ctxOpenCharForm(parseInt(b.getAttribute('data-i'),10));});
  });
  listEl.querySelectorAll('.ch-del').forEach(function(b){
    b.addEventListener('click',function(){_ctxDeleteChar(parseInt(b.getAttribute('data-i'),10));});
  });
}

function _ctxOpenCharForm(idx){
  var form=$('ctx-char-form');if(!form)return;
  form.style.display='';
  var title=$('ctx-char-form-title');
  if(idx==null||idx<0){
    if(title)title.textContent='Add Character';
    $('cf-name').value='';
    $('cf-aliases').value='';
    $('cf-description').value='';
    $('cf-index').value='-1';
  } else {
    var chars=(_ctxCurrent&&_ctxCurrent.characters)||[];
    var ch=chars[idx]||{};
    var n=_ctxBi(ch.name), a=_ctxBiList(ch.aliases), d=_ctxBi(ch.description);
    if(title)title.textContent='Edit Character #'+(idx+1);
    $('cf-name').value=n.en||'';
    $('cf-aliases').value=(a.en||[]).join(', ');
    $('cf-description').value=d.en||'';
    $('cf-index').value=String(idx);
  }
  $('cf-name').focus();
}
function _ctxCloseCharForm(){var f=$('ctx-char-form');if(f)f.style.display='none';}

function _ctxSaveChar(){
  if(!_ctxRequireProject())return;
  var idx=parseInt($('cf-index').value||'-1',10);
  var name=($('cf-name').value||'').trim();
  if(!name){_ctxStatus('Name is required',true);return;}
  var aliases=($('cf-aliases').value||'').split(',').map(function(s){return s.trim();}).filter(Boolean);
  var desc=($('cf-description').value||'').trim();
  _ctxStatus('Translating + saving character…');
  fetch('/context-edit',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      section:'character',
      action: idx<0?'add':'update',
      index:  idx,
      character:{name_en:name, aliases_en:aliases, description_en:desc}
    })
  }).then(function(r){return r.json();}).then(function(d){
    if(!d.ok){_ctxStatus('⚠ '+(d.error||'save failed'),true);return;}
    _ctxCurrent=d.context;
    _ctxStatus(idx<0?'✓ Added character':'✓ Updated character');
    _ctxCloseCharForm();_ctxRenderChars();_ctxRenderOverview();
  }).catch(function(e){_ctxStatus('⚠ '+e,true);});
}

function _ctxDeleteChar(idx){
  if(!_ctxRequireProject())return;
  if(!confirm('Delete this character?'))return;
  _ctxStatus('Deleting…');
  fetch('/context-edit',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({section:'character',action:'delete',index:idx})
  }).then(function(r){return r.json();}).then(function(d){
    if(!d.ok){_ctxStatus('⚠ '+(d.error||'delete failed'),true);return;}
    _ctxCurrent=d.context;
    _ctxStatus('✓ Deleted');
    _ctxRenderChars();_ctxRenderOverview();
  }).catch(function(e){_ctxStatus('⚠ '+e,true);});
}

function _ctxRequireProject(){
  if(!window._activeFile){_ctxStatus('No project selected',true);return false;}
  return true;
}

// ── Generate (Generate sub-tab) ──────────────────────────────────────────────

function _ctxStartGenerate(){
  if(!_ctxRequireProject())return;
  var desc=($('ctx-desc')||{value:''}).value.trim();
  if(!desc){_ctxStatus('Paste a description first',true);return;}
  _ctxClearLog();
  var btn=$('ctx-generate');if(btn)btn.disabled=true;
  _ctxStatus('Submitting…');
  fetch('/generate-context',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({description:desc})
  }).then(function(r){return r.json();}).then(function(d){
    if(!d.job_id){throw new Error(d.error||'no job_id returned');}
    _ctxStatus('Generating — first run loads model (~30–60s)…');
    _pollContextJob(d.job_id);
  }).catch(function(e){
    _ctxStatus('⚠ '+e,true);
    if(btn)btn.disabled=false;
  });
}

function _pollContextJob(jobId){
  var since=0,btn=$('ctx-generate');
  function tick(){
    fetch('/process-status?job='+jobId+'&since='+since)
      .then(function(r){return r.json();})
      .then(function(s){
        (s.events||[]).forEach(function(ev){
          if(ev.type==='step'){_ctxLogLine(ev.msg);}
          else if(ev.type==='result'){
            _ctxCurrent=ev.context;
            _ctxStatus('✓ Context generated and saved');
            _ctxRenderOverview();_ctxRenderEdit();_ctxRenderChars();
            _ctxShowSub('overview');
          }
          else if(ev.type==='error'){_ctxStatus('⚠ '+ev.error,true);}
        });
        since=s.next||since;
        if(s.done){if(btn)btn.disabled=false;}
        else setTimeout(tick,1000);
      })
      .catch(function(e){_ctxStatus('Poll failed: '+e,true);if(btn)btn.disabled=false;});
  }
  tick();
}

// ── Wiring ───────────────────────────────────────────────────────────────────

(function _wireContext(){
  document.querySelectorAll('.ctx-stbtn').forEach(function(b){
    b.addEventListener('click',function(){_ctxShowSub(b.getAttribute('data-csub'));});
  });

  var desc=$('ctx-desc');
  if(desc)desc.addEventListener('input',function(){
    var btn=$('ctx-generate');if(btn)btn.disabled=!desc.value.trim();
  });
  var gen=$('ctx-generate');if(gen)gen.addEventListener('click',_ctxStartGenerate);

  document.querySelectorAll('.ctx-save-text').forEach(function(b){
    b.addEventListener('click',function(){_ctxSaveText(b.getAttribute('data-edit-field'));});
  });
  var sv=$('ctx-save-vocab');if(sv)sv.addEventListener('click',_ctxSaveVocab);

  var addBtn=$('ctx-char-add');if(addBtn)addBtn.addEventListener('click',function(){_ctxOpenCharForm(-1);});
  var saveBtn=$('cf-save');if(saveBtn)saveBtn.addEventListener('click',_ctxSaveChar);
  var cancelBtn=$('cf-cancel');if(cancelBtn)cancelBtn.addEventListener('click',_ctxCloseCharForm);

  _ctxShowSub('overview');
})();
