// ── Transcribblr Sliders — noUiSlider init, callbacks, nudge buttons ──────────

function getNeighbourBounds(){
  var prevEnd = idx > 0 ? entries[idx-1].end : 0;
  var nextStart = idx < entries.length-1 ? entries[idx+1].start : audioDur||9999;
  return {min: prevEnd, max: nextStart};
}

function timeSliderCb(vals){
  var nb=getNeighbourBounds();
  var s=Math.max(nb.min, parseFloat(vals[0]));
  var e=Math.min(nb.max, Math.max(s+0.01, parseFloat(vals[1])));
  $('es').value=s;
  $('ee').value=e;
  _userEditing=true;editPrev();
}

function addSliderCb(vals){
  $('as2').value=parseFloat(vals[0]);
  $('ae2').value=parseFloat(vals[1]);
  addPrev();
}

// Guard slider init — CDN failure must not break the rest of the app
try {
  if(typeof noUiSlider==='undefined') throw new Error('noUiSlider library not loaded');
  var tsEl=$('time-slider'), asEl=$('add-slider');
  if(!tsEl||!asEl) throw new Error('slider container missing');

  window.timeSlider=noUiSlider.create(tsEl,{
    start:[0,1],connect:true,step:0.01,
    range:{min:0,max:1},
    tooltips:[
      {to:function(v){return toSRT(v);}},
      {to:function(v){return toSRT(v);}}
    ]
  });
  window.timeSlider.on('slide',timeSliderCb);
  window.timeSlider.on('set',timeSliderCb);

  window.addSlider=noUiSlider.create(asEl,{
    start:[0,1],connect:true,step:0.01,
    range:{min:0,max:1},
    tooltips:[
      {to:function(v){return toSRT(v);}},
      {to:function(v){return toSRT(v);}}
    ]
  });
  window.addSlider.on('slide',addSliderCb);
  window.addSlider.on('set',addSliderCb);
} catch(e) {
  console.error('Slider init failed:', e);
}

// ── Nudge functions ───────────────────────────────────────────────────────────
function nudgeTimeSlider(handle, delta){
  _userEditing=true;
  var nb=getNeighbourBounds();
  var vals=window.timeSlider.get();
  var s=parseFloat(vals[0]), e=parseFloat(vals[1]);
  if(handle===0) s=Math.min(e-0.01, Math.max(nb.min, Math.round((s+delta)*100)/100));
  else            e=Math.max(s+0.01, Math.min(nb.max, Math.round((e+delta)*100)/100));
  window.timeSlider.set([s,e],false);
  $('es').value=s; $('ee').value=e;
  editPrev();
}

function nudgeAddSlider(handle, delta){
  var vals=window.addSlider.get();
  var s=parseFloat(vals[0]), e=parseFloat(vals[1]);
  if(handle===0) s=Math.max(0,Math.round((s+delta)*100)/100);
  else            e=Math.max(s+0.1,Math.round((e+delta)*100)/100);
  var mn=window.addSlider.options.range.min, mx=window.addSlider.options.range.max;
  if(s<mn||e>mx){
    window.addSlider.updateOptions({range:{min:Math.min(mn,s-1),max:Math.max(mx,e+1)}},false);
  }
  window.addSlider.set([s,e],false);
  $('as2').value=s; $('ae2').value=e;
  addPrev();
}

// ── Nudge button listeners ────────────────────────────────────────────────────
$('ts-s-dn').addEventListener('click',function(){nudgeTimeSlider(0,-0.5);});
$('ts-s-up').addEventListener('click',function(){nudgeTimeSlider(0,+0.5);});
$('ts-e-dn').addEventListener('click',function(){nudgeTimeSlider(1,-0.5);});
$('ts-e-up').addEventListener('click',function(){nudgeTimeSlider(1,+0.5);});
$('ts-s-now').addEventListener('click',function(){
  var t=Math.max(0,ws.getCurrentTime()-0.5);
  nudgeTimeSlider(0, t - parseFloat($('es').value));
});
$('ts-e-now').addEventListener('click',function(){
  var t=ws.getCurrentTime();
  nudgeTimeSlider(1, t - parseFloat($('ee').value));
});

$('as-s-dn').addEventListener('click',function(){nudgeAddSlider(0,-0.5);});
$('as-s-up').addEventListener('click',function(){nudgeAddSlider(0,+0.5);});
$('as-e-dn').addEventListener('click',function(){nudgeAddSlider(1,-0.5);});
$('as-e-up').addEventListener('click',function(){nudgeAddSlider(1,+0.5);});
$('as-s-now').addEventListener('click',function(){
  var t=Math.max(0,ws.getCurrentTime()-0.5);
  nudgeAddSlider(0, t - parseFloat($('as2').value));
});
$('as-e-now').addEventListener('click',function(){
  var t=ws.getCurrentTime();
  nudgeAddSlider(1, t - parseFloat($('ae2').value));
});
