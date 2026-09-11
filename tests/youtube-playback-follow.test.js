const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const listeners = [];
  const classes = new Set();
  const video = {currentTime:1800.5,paused:false,readyState:4,seeking:false,duration:7200};
  const player = {classList:{contains:name=>classes.has(name)}};
  let present = true;
  const document = {
    readyState:'loading', addEventListener(){},
    getElementById:id=>id==='movie_player'?player:null,
    querySelector:selector=>selector==='video.html5-main-video'?(present?video:null):null,
  };
  const context = vm.createContext({
    document, window:{location:{search:'?v=video-follow'},addEventListener(){}},
    URLSearchParams, console, setTimeout(){}, clearTimeout(){},
    chrome:{runtime:{id:'test',onMessage:{addListener:fn=>listeners.push(fn)}}},
  });
  vm.runInContext(fs.readFileSync(require.resolve('../content.js'),'utf8'), context);
  return { video, classes, navigate(id){context.window.location.search="?v="+id}, absent(){present=false}, read(action='getCurrentTime'){
    let result;
    for(const fn of listeners) fn({action},{},x=>{result=x});
    return JSON.parse(JSON.stringify(result));
  }};
}

test('real YouTube content script reports ad state without leaking ad time into body captions', () => {
  const h=harness();
  const normal=h.read();
  assert.equal(normal.currentTime,1800);
  for(const adClass of ['ad-showing','ad-interrupting']) {
    h.classes.add(adClass); h.video.currentTime=0;
    const ad=h.read();
    assert.equal(ad.isAd,true);
    assert.equal(ad.ready,false);
    assert.equal(ad.currentTime,null);
    assert.equal(h.read('getNotePlaybackState').ready,false, 'ad cannot count as successful note jump');
    h.classes.delete(adClass);
  }
  h.video.currentTime=1801.5;
  assert.equal(h.read().currentTime,1801);
  assert.equal(h.read().isAd,false);
  assert.equal(h.read('getNotePlaybackState').currentTime,1801.5);
});

test('buffering, seeking, and absent player are unavailable rather than timestamp zero', () => {
  const h=harness();
  for(const state of [{readyState:0,seeking:false},{readyState:4,seeking:true}]) {
    Object.assign(h.video,state);
    assert.equal(h.read().ready,false);
    assert.equal(h.read().currentTime,null);
  }
  h.absent();
  assert.equal(h.read().currentTime,null);
  assert.equal(h.read('getNotePlaybackState').available,false);
});

test('legitimate user seek back to the beginning remains a valid body position', () => {
  const h=harness();h.video.currentTime=0;
  assert.equal(h.read().ready,true);
  assert.equal(h.read().isAd,false);
  assert.equal(h.read().currentTime,0);
});


test('ad marker ending before body media restoration does not expose the remaining ad clock', () => {
  const h=harness();h.read();
  h.classes.add('ad-showing');h.video.duration=30;h.video.currentTime=3;
  h.read();h.classes.clear();
  assert.equal(h.read().ready,false, 'ad source still loaded despite the CSS marker disappearing');
  assert.equal(h.read().currentTime,null);
  h.video.duration=7200;h.video.currentTime=1802;
  assert.equal(h.read().ready,true);
  assert.equal(h.read().currentTime,1802);
});

test('a new video resets the ad restoration guard rather than inheriting the old duration', () => {
  const h=harness();h.read();h.classes.add('ad-showing');h.read();
  h.classes.clear();h.navigate('next-video');h.video.duration=600;h.video.currentTime=0;
  assert.equal(h.read().ready,true);
  assert.equal(h.read().currentTime,0);
});
