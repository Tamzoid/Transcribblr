// ── Transcribblr Player — WaveSurfer, regions, loop, audio source ─────────────

var ws = null;
var wsRegions = null;

// ── Region highlight helpers ──────────────────────────────────────────────────
var _curRegion=null, _addRegion=null, _split1Region=null, _split2Region=null;

// Move an existing region's bounds in-place via its DOM element (no flicker)
function moveRegion(region, s, e){
  if(!audioDur||audioDur<=0)return;
  var el=region&&region.element;
  if(!el)return;
  el.style.left=(s/audioDur*100)+'%';
  el.style.width=((e-s)/audioDur*100)+'%';
  // Keep internal props in sync
  region.start=s; region.end=e;
}

function updateAddRegion(){
  if(!wsRegions)return;
  var activeTab=document.querySelector('.tbtn.on');
  var onAdd=activeTab&&activeTab.getAttribute('data-tab')==='add';
  if(!onAdd){
    if(_addRegion){try{_addRegion.remove();}catch(x){} _addRegion=null;}
    return;
  }
  var s=parseFloat(($('as2')||{value:0}).value),e=parseFloat(($('ae2')||{value:0}).value);
  if(isNaN(s)||isNaN(e)||e<=s){
    if(_addRegion){try{_addRegion.remove();}catch(x){} _addRegion=null;}
    return;
  }
  if(_addRegion){moveRegion(_addRegion,s,e);}
  else{try{_addRegion=wsRegions.addRegion({start:s,end:e,color:'rgba(160,80,255,0.22)',drag:false,resize:false});}catch(x){}}
}

function updateSplitRegions(){
  if(!wsRegions)return;
  var activeTab=document.querySelector('.tbtn.on');
  var onSplit=activeTab&&activeTab.getAttribute('data-tab')==='split';
  if(!onSplit){
    if(_split1Region){try{_split1Region.remove();}catch(x){} _split1Region=null;}
    if(_split2Region){try{_split2Region.remove();}catch(x){} _split2Region=null;}
    return;
  }
  var e=entries[idx];if(!e)return;
  var t=parseFloat(($('st')||{value:e.start}).value);
  if(isNaN(t)||t<=e.start||t>=e.end){
    if(_split1Region){try{_split1Region.remove();}catch(x){} _split1Region=null;}
    if(_split2Region){try{_split2Region.remove();}catch(x){} _split2Region=null;}
    return;
  }
  // Part 1: cyan
  if(_split1Region){moveRegion(_split1Region,e.start,t);}
  else{try{_split1Region=wsRegions.addRegion({start:e.start,end:t,color:'rgba(0,217,255,0.18)',drag:false,resize:false});}catch(x){}}
  // Part 2: orange
  if(_split2Region){moveRegion(_split2Region,t,e.end);}
  else{try{_split2Region=wsRegions.addRegion({start:t,end:e.end,color:'rgba(255,140,0,0.18)',drag:false,resize:false});}catch(x){}}
}

function updateCurRegion(){
  if(!wsRegions||!audioDur)return;
  // Read directly from sliders — always the ground truth for current record
  var esEl=$('es'), eeEl=$('ee');
  var startT=esEl?parseFloat(esEl.value):NaN;
  var endT=eeEl?parseFloat(eeEl.value):NaN;
  // Fall back to saved entry if sliders not available
  if(isNaN(startT)||isNaN(endT)){
    var w=entries[idx]; if(!w)return;
    startT=w.start; endT=w.end;
  }
  if(isNaN(startT)||isNaN(endT)||endT<=startT){
    if(_curRegion){try{_curRegion.remove();}catch(x){} _curRegion=null;}
    return;
  }
  if(_curRegion){moveRegion(_curRegion,startT,endT);}
  else{try{_curRegion=wsRegions.addRegion({start:startT,end:endT,color:'rgba(255,210,0,0.18)',drag:false,resize:false});}catch(x){}}
}

// ── Audio source switcher ─────────────────────────────────────────────────────
var _audioSrc='vocals';
var _switchSeekTo=null;

// ── Video sync — keeps <video> in lockstep with WaveSurfer playback ───────────
var _videoEnabled=false, _videoLoaded=false, _videoSeekDebounce=null;
function _videoEl(){return document.getElementById('video-el');}
function _videoWrap(){return document.getElementById('video-wrap');}
function _videoToggleEl(){return document.getElementById('video-toggle');}

// HTMLMediaElement.play() returns a Promise that rejects with AbortError if
// pause() (or another play()) interrupts it. Without an explicit .catch it
// surfaces as an unhandled rejection. Always call play() through this helper.
function _safePlay(el){
  if(!el)return;
  var p; try{ p=el.play(); }catch(e){ console.warn('[video] play threw',e); return; }
  if(p&&p.catch)p.catch(function(e){
    if(e&&e.name==='AbortError')return;  // pause raced play — expected, ignore
    console.warn('[video] play rejected',e&&e.name,e&&e.message);
  });
}

function loadVideoSrc(){
  var v=_videoEl();if(!v||!window._activeFile)return;
  v.muted=true; // audio comes from wavesurfer
  v.playsInline=true;
  v.preload='auto';
  // Verbose lifecycle logging — paste these into /logs to debug black video
  ['loadstart','loadedmetadata','loadeddata','canplay','canplaythrough',
   'playing','waiting','stalled','suspend','abort','emptied','error'].forEach(function(ev){
    v['on'+ev]=function(){
      var e=v.error;
      console.log('[video]',ev,
        'rs='+v.readyState,'ns='+v.networkState,
        'dur='+(isNaN(v.duration)?'?':v.duration.toFixed(2)),
        'vw='+v.videoWidth+'x'+v.videoHeight,
        e?'err='+e.code+'/'+e.message:'');
      if(ev==='loadedmetadata'){
        _syncVideoToWs(true);
        if(ws&&ws.isPlaying())_safePlay(v);
      }
      if(ev==='error'){setStatus('Video failed — see logs',true);}
    };
  });
  var url='/audio?src=video&file='+encodeURIComponent(window._activeFile);
  console.log('[video] loading',url);
  v.src=url;
  v.load();
  _videoLoaded=true;
}
function unloadVideo(){
  var v=_videoEl();if(!v)return;
  try{v.pause();}catch(e){}
  v.removeAttribute('src');
  try{v.load();}catch(e){}
  _videoLoaded=false;
}
function setVideoVisible(on){
  _videoEnabled=on;
  var w=_videoWrap();if(w)w.style.display=on?'':'none';
  if(on){
    if(!_videoLoaded)loadVideoSrc();
    _syncVideoToWs(true);
    if(ws&&ws.isPlaying())_safePlay(_videoEl());
  } else {
    var v=_videoEl();if(v)try{v.pause();}catch(e){}
  }
}
// Push wavesurfer state into the video element
function _syncVideoToWs(force){
  if(!_videoEnabled)return;
  var v=_videoEl();if(!v||!ws)return;
  try{
    var t=ws.getCurrentTime();
    var drift=Math.abs(v.currentTime-t);
    if(force||drift>0.15){v.currentTime=t;}
    if(v.playbackRate!==ws.getPlaybackRate())v.playbackRate=ws.getPlaybackRate();
  }catch(e){}
}
// Reload video when the active file changes (call from filepicker)
function refreshVideoForActiveFile(hasVideo){
  var wrap=document.getElementById('video-toggle-wrap');
  if(wrap)wrap.style.display=hasVideo?'':'none';
  unloadVideo();
  if(_videoEnabled && hasVideo){
    loadVideoSrc();
  } else if(!hasVideo){
    setVideoVisible(false);
    var t=_videoToggleEl();if(t)t.checked=false;
  }
}

// ── Loop state — declared here so filepicker.js can read looping ──────────────
var looping=false, loopTimer=null, _loopSeeking=false;

function getLoopBounds(){
  var e=entries[idx];
  if(!e||isNaN(e.start)||isNaN(e.end)||e.end<=e.start+0.1)return null;
  return {s:e.start,e:e.end};
}

function stopLoop(){
  looping=false;
  clearInterval(loopTimer);loopTimer=null;
  var lb=$('wloop');if(lb)lb.classList.remove('loop-on');
  clearTimeout(followPauseTimer);
  followPauseTimer=setTimeout(function(){
    audioFollow=true;
    console.log('[follow] on (stopLoop)');
  },500);
}

function startLoopInterval(){
  if(loopTimer){clearInterval(loopTimer);loopTimer=null;}
  loopTimer=setInterval(function(){
    if(!looping||!ws)return;
    var b=getLoopBounds();if(!b)return;
    try{
      var t=ws.getCurrentTime();
      if(t>=b.e-0.05||t<b.s){
        _loopSeeking=true;
        ws.setTime(b.s);
        setTimeout(function(){_loopSeeking=false;},100);
        if(!ws.isPlaying()){
          setTimeout(function(){
            if(looping&&!ws.isPlaying()){
              var p=ws.play();if(p&&p.catch)p.catch(function(){});
            }
          },30);
        }
      }
    }catch(x){}
  },80);
}

function startLoop(){
  var b=getLoopBounds();if(!b)return;
  looping=true;
  var lb=$('wloop');if(lb)lb.classList.add('loop-on');
  _loopSeeking=true;
  ws.setTime(b.s);
  setTimeout(function(){
    _loopSeeking=false;
    if(!looping)return;
    try{var p=ws.play();if(p&&p.catch)p.catch(function(){});}catch(x){}
    startLoopInterval();
  },80);
}

// ── WaveSurfer init — guarded so CDN failure doesn't crash the app ────────────
try {
  wsRegions=(WaveSurfer.Regions||window.WaveSurferRegions).create();
  ws=WaveSurfer.create({
    container:'#wf',waveColor:'#1e4d3a',progressColor:'#00ff88',
    cursorColor:'#00ff88',cursorWidth:2,height:64,
    barWidth:2,barGap:1,barRadius:2,normalize:true,
    minPxPerSec:30,autoScroll:true,autoCenter:true,
    plugins:[wsRegions]
  });

  $('audio-src').addEventListener('change',function(){
    var newSrc=this.value;
    if(newSrc===_audioSrc)return;
    _audioSrc=newSrc;
    _switchSeekTo=ws.getCurrentTime();
    var wasPlaying=ws.isPlaying();
    if(looping)stopLoop();
    $('wsl').style.display='block';
    $('wf').style.display='none';
    $('wsl').innerHTML='<span class="spin"></span>SWITCHING AUDIO…';
    ws.load('/audio?src='+newSrc+'&file='+encodeURIComponent(window._activeFile||''));
    ws.once('ready',function(){
      if(wasPlaying)ws.play();
    });
  });

  ws.on('error',function(e){$('wsl').textContent='⚠ Audio error: '+e;});
  ws.on('ready',function(){
    audioDur=ws.getDuration();
    $('wsl').style.display='none';
    $('wf').style.display='block';
    $('wd').textContent=toSRT(audioDur);
    setTimeout(function(){
      var pxPerSec=Math.max(10,Math.round($('wf').clientWidth/90));
      ws.zoom(pxPerSec);
      // On source switch restore saved position, otherwise go to record start
      if(_switchSeekTo!==null){
        try{ws.setTime(_switchSeekTo);}catch(x){}
        _switchSeekTo=null;
      } else {
        if(entries.length)try{ws.setTime(entries[idx].start);}catch(x){}
      }
      updateCurRegion();
      if(typeof _annUpdateRegions==='function')_annUpdateRegions();
      _syncVideoToWs(true);
      setStatus('Loaded '+entries.length+' records');
    },50);
  });
  ws.on('seeking',function(){_syncVideoToWs(true);});
  var _tuLogTick=0;
  ws.on('timeupdate',function(t){
    $('wc').textContent=toSRT(t);
    _syncVideoToWs(false);
    if(typeof window._newOnTimeUpdate === 'function') window._newOnTimeUpdate();

    // Find active record (within window) or upcoming (next after t)
    var active=-1, upcoming=-1;
    for(var i=0;i<entries.length;i++){
      if(t>=entries[i].start&&t<=entries[i].end){active=i;break;}
      if(entries[i].start>t&&(upcoming===-1||entries[i].start<entries[upcoming].start))upcoming=i;
    }

    // Periodic diagnostic — once per ~2s while playing
    var nowSec=Math.floor(t/2);
    if(nowSec!==_tuLogTick){
      _tuLogTick=nowSec;
      console.log('[ws] tick t='+t.toFixed(2)+' idx='+idx+' active='+active+' upcoming='+upcoming
                  +' audioFollow='+audioFollow+' looping='+looping+' entries='+entries.length);
    }

    // Drive record selection when audio is in control
    if(audioFollow){
      var target=active>=0?active:upcoming>=0?upcoming:-1;
      if(target>=0&&target!==idx){
        console.log('[ws] advance idx',idx,'→',target,'(t='+t.toFixed(2)+')');
        idx=target;
        $('sel').value=idx;
        render();
        updateCurRegion();
        if(typeof window._spOnIdxChanged==='function')window._spOnIdxChanged();
      }
    }

    // Highlight — re-check active against current idx (which may just have changed)
    var cur=$('cur');
    if(cur){
      var isActive=(active>=0&&active===idx);
      if(isActive) cur.classList.add('cur-active');
      else cur.classList.remove('cur-active');
    }
  });
  ws.on('play', function(){
    console.log('[ws] play t='+ws.getCurrentTime().toFixed(2));
    $('wpi').textContent='⏸';$('wpl').textContent='PAUSE';
    if(_videoEnabled)_safePlay(_videoEl());
  });
  ws.on('pause',function(){
    console.log('[ws] pause t='+ws.getCurrentTime().toFixed(2));
    $('wpi').textContent='▶';$('wpl').textContent='PLAY';
    if(_videoEnabled){var v=_videoEl();if(v)try{v.pause();}catch(e){}}
    // Only stop loop if it wasn't us who caused the pause via setTime
    if(looping&&!_loopSeeking)stopLoop();
  });

  $('wplay').addEventListener('click',function(){ws.playPause();});

  // Speed controls — slowest · slower · 1× · faster · fastest. Range [0.5, 2.0].
  var SPEED_MIN = 0.5, SPEED_MAX = 2.0, SPEED_STEP = 0.25;
  function _setSpeed(v){
    v = Math.max(SPEED_MIN, Math.min(SPEED_MAX, Math.round(v * 100) / 100));
    try{ ws.setPlaybackRate(v); }catch(e){}
    var vid=_videoEl(); if(vid) vid.playbackRate = v;
    var ind=$('wcs');
    if(ind){
      ind.textContent = v.toFixed(2) + '×';
      ind.classList.toggle('adj', Math.abs(v - 1.0) > 0.001);
    }
  }
  function _curSpeed(){return ws.getPlaybackRate ? ws.getPlaybackRate() : 1;}
  var _wmin=$('ws-min');   if(_wmin) _wmin.addEventListener('click', function(){_setSpeed(SPEED_MIN);});
  var _wsd =$('ws-down');  if(_wsd)  _wsd .addEventListener('click', function(){_setSpeed(_curSpeed() - SPEED_STEP);});
  var _wsr =$('ws-reset'); if(_wsr)  _wsr .addEventListener('click', function(){_setSpeed(1.0);});
  var _wsu =$('ws-up');    if(_wsu)  _wsu .addEventListener('click', function(){_setSpeed(_curSpeed() + SPEED_STEP);});
  var _wmax=$('ws-max');   if(_wmax) _wmax.addEventListener('click', function(){_setSpeed(SPEED_MAX);});

  var _vt=_videoToggleEl();
  if(_vt)_vt.addEventListener('change',function(){setVideoVisible(_vt.checked);});
} catch(e) {
  console.error('WaveSurfer init failed:', e);
}
