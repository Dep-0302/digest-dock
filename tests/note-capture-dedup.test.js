const test = require('node:test');
const assert = require('node:assert/strict');
const {harness,note,settle,bytes,noteWrites,clone} = require('./helpers/thought-layer-harness');

async function expire(h) { await h.time.advance(11000); assert.equal(h.toast(),null); }
async function editThought(h,text) {
  await h.press('n');const input=h.toast().querySelector('textarea');assert.ok(input);
  input.value=text;await h.press('Enter');
  // A browser returns focus to the page after removing the focused editor.
  h.contentDoc.body.focus();
}
async function replaceTranscript(h,transcript) {
  const data=h.local.snapshot();
  for(const [key,value] of Object.entries(data)) if(key.startsWith('digest_')&&Array.isArray(value.transcript)) {
    await h.local.set({[key]:{...value,transcript}});
  }
}

for(const platform of ['youtube','bilibili']) {
  test(`${platform}: Shift+Enter leaves the thought editor open for a new paragraph without saving`,async()=>{
    const h=await harness([],{platform});await h.press('n');await editThought(h,'原来的想法');
    await h.press('n');const toast=h.toast(),input=toast.querySelector('textarea');assert.ok(input);
    assert.equal(input.value,'原来的想法');const before=bytes(h.local);h.resetEvidence();
    const event={type:'keydown',key:'Enter',shiftKey:true};input.dispatchEvent(event);await settle();
    assert.notEqual(event.defaultPrevented,true,'native textarea newline must remain enabled');
    assert.equal(h.toast(),toast);assert.ok(input.isConnected);assert.ok(bytes(h.local).equals(before));
    assert.equal(h.messages.some(m=>m.action==='updateNoteThought'),false);
    input.value+='\n补充的一段';await h.press('Enter');
    assert.equal((await h.allNotes())[0].thought,'原来的想法\n补充的一段');assert.equal((await h.allNotes()).length,1);
  });

  test(`${platform}: repeated capture reuses the note before cleanup and writes nothing`,async()=>{
    const h=await harness([],{platform,configured:true});await h.press('n');
    assert.equal((await h.allNotes()).length,1);assert.ok(h.providerCalls.length>0,'first capture proves provider probe is live');
    const original=clone((await h.allNotes())[0]);await expire(h);const before=bytes(h.local);h.resetEvidence();
    await h.press('n');assert.deepEqual(await h.allNotes(),[original]);
    assert.ok(h.toast().querySelector('textarea'),'a duplicate opens the thought editor on this N');
    assert.doesNotMatch(h.toast().textContent,/笔记已保存/);
    assert.equal(h.video.paused,true);assert.equal(h.video.pauseCalls,1);
    assert.equal(h.providerCalls.length,0);assert.deepEqual(noteWrites(h.local),[]);assert.ok(bytes(h.local).equals(before));
  });

  test(`${platform}: a duplicate N immediately edits the existing thought and preserves all other saved fields`,async()=>{
    const h=await harness([],{platform});await h.press('n');await editThought(h,'原想法 <b>保留</b>');
    const original=clone((await h.allNotes())[0]);h.video.paused=false;h.video.pauseCalls=0;h.resetEvidence();
    await h.press('n');assert.equal((await h.allNotes()).length,1);
    assert.equal(h.toast().querySelector('b'),null);
    assert.equal(h.video.paused,true);assert.equal(h.video.pauseCalls,1);
    const input=h.toast().querySelector('textarea');assert.ok(input);
    assert.equal(input.value,original.thought);assert.equal(h.video.paused,true);
    input.value+='\n接着写的新想法';await h.press('Enter');
    const saved=await h.allNotes();assert.equal(saved.length,1);assert.equal(saved[0].id,original.id);
    assert.equal(saved[0].thought,original.thought+'\n接着写的新想法');
    const omit=n=>Object.fromEntries(Object.entries(n).filter(([k])=>!['thought','thoughtAt'].includes(k)));
    assert.deepEqual(omit(saved[0]),omit(original));assert.equal(h.providerCalls.length,0);
  });

  test(`${platform}: reopened thought editor never expires and Escape preserves the old thought`,async()=>{
    const h=await harness([],{platform});await h.press('n');await editThought(h,'旧想法不应丢失');
    const before=bytes(h.local);h.resetEvidence();await h.press('n');
    const input=h.toast().querySelector('textarea');assert.ok(input);assert.equal(input.value,'旧想法不应丢失');
    input.value='未保存草稿';await h.press('Escape');h.contentDoc.body.focus();assert.ok(bytes(h.local).equals(before));
    await h.press('n');const reopened=h.toast();await h.time.advance(20000);assert.equal(h.toast(),reopened);
    assert.ok(bytes(h.local).equals(before));assert.deepEqual(noteWrites(h.local),[]);
    await h.press('Escape');assert.equal(h.toast(),null);
  });

  test(`${platform}: same words at another cue and different words at the same cue remain distinct`,async()=>{
    const h=await harness([],{platform});await replaceTranscript(h,[
      {start:30,duration:10,text:'Source quote',language:'en'},
      {start:60,duration:10,text:'Source quote',language:'en'},
    ]);
    await h.press('n');const first=clone((await h.allNotes())[0]);await expire(h);
    h.video.currentTime=66;await h.press('n');assert.equal((await h.allNotes()).length,2);
    await expire(h);await replaceTranscript(h,[{start:60,duration:10,text:'A different cue text',language:'en'}]);
    await h.press('n');const saved=await h.allNotes();assert.equal(saved.length,3);
    assert.deepEqual(saved.find(n=>n.id===first.id),first);
  });

  test(`${platform}: conflicting historical thoughts are reported without choosing, merging or requesting AI`,async()=>{
    const h=await harness([],{platform,configured:true});await h.press('n');await editThought(h,'第一条不同想法');
    const first=clone((await h.allNotes())[0]);
    const historical={...first,id:'note_old_second_thought',thought:'另一条不同想法'};
    assert.equal(await h.runWorker(`saveNoteToStorage(${JSON.stringify(historical)})`),true);
    const before=bytes(h.local);h.resetEvidence();await h.press('n');
    assert.match(h.toast().textContent,/多条想法/);assert.equal(h.toast().querySelector('textarea'),null);
    assert.ok(bytes(h.local).equals(before));assert.deepEqual(noteWrites(h.local),[]);assert.equal(h.providerCalls.length,0);
  });
}

test('an existing thought is reused ahead of a blank historical copy without changing either record',async()=>{
  const h=await harness([]);await h.press('n');await editThought(h,'保留我的想法');
  const first=clone((await h.allNotes())[0]);
  const historical={...first,id:'note_old_blank_copy',thought:'',thoughtAt:null,createdAt:first.createdAt-1000};
  assert.equal(await h.runWorker(`saveNoteToStorage(${JSON.stringify(historical)})`),true);
  const before=bytes(h.local);h.resetEvidence();await h.press('n');
  const input=h.toast().querySelector('textarea');assert.ok(input);assert.equal(input.value,'保留我的想法');
  assert.ok(bytes(h.local).equals(before));assert.deepEqual(noteWrites(h.local),[]);
});

test('concurrent saves of one cue return one durable ID and one index entry',async()=>{
  const h=await harness([]);const request={action:'saveNote',videoId:'video_00001',timestamp:33,skipAiCleanup:true};
  const results=await Promise.all([h.send(request),h.send(request)]);
  assert.ok(results.every(result=>result.success));assert.equal(new Set(results.map(r=>r.note.id)).size,1);
  assert.equal((await h.allNotes()).length,1);assert.equal((await h.api.readNoteIndex()).length,1);
  assert.equal(results.filter(r=>r.duplicate===true).length,1);
});

test('concurrent captures share one cleanup provider request as well as one stored note',async()=>{
  const h=await harness([],{configured:true});let release;
  h.providerGate=new Promise(resolve=>{release=resolve;});
  const request={action:'saveNote',videoId:'video_00001',timestamp:33};
  const pending=Promise.all([h.send(request),h.send(request)]);await settle();
  const calls=h.providerCalls.length;release();const results=await pending;
  assert.equal(calls,1);assert.equal(new Set(results.map(r=>r.note.id)).size,1);
  assert.equal((await h.allNotes()).length,1);assert.equal(results.filter(r=>r.duplicate).length,1);
});

test('a repeat arriving after cleanup but before the storage write still shares that cleanup',async()=>{
  const h=await harness([],{configured:true});let release,held=false;
  const gate=new Promise(resolve=>{release=resolve;});const set=h.local.set;
  h.local.set=async values=>{if(!held&&Object.keys(values).some(k=>k.startsWith('ytd_notes_'))){held=true;await gate;}return set(values);};
  const request={action:'saveNote',videoId:'video_00001',timestamp:33};
  const first=h.send(request);await settle();assert.equal(held,true);assert.equal(h.providerCalls.length,1);
  const second=h.send(request);await settle();const calls=h.providerCalls.length;
  release();const results=await Promise.all([first,second]);
  assert.equal(calls,1);assert.equal(results[0].note.id,results[1].note.id);assert.equal((await h.allNotes()).length,1);
});

for(const identical of [false,true]) test(`long raw cues ${identical?'reuse a full frozen match':'do not merge different suffixes beyond 3000 characters'}`,async()=>{
  const h=await harness([]);const prefix='a'.repeat(3000);
  await replaceTranscript(h,[{start:30.25,duration:10,text:prefix+'X',language:'en'}]);
  await h.press('n');const first=clone((await h.allNotes())[0]);await expire(h);
  await replaceTranscript(h,[{start:30.25,duration:10,text:prefix+(identical?'X':'Y'),language:'en'}]);
  await h.press('n');const notes=await h.allNotes();assert.equal(notes.length,identical?1:2);
  assert.deepEqual(notes.find(n=>n.id===first.id),first);
});

test('a possibly truncated legacy raw cue without full frozen evidence is not guessed to match',async()=>{
  const raw='a'.repeat(3000);const old=note('legacy-long',{rawText:raw,triggerWindow:[]});
  const h=await harness([old]);await replaceTranscript(h,[{start:30,duration:10,text:raw,language:'en'}]);
  await h.press('n');assert.equal((await h.allNotes()).length,2);
});

test('the same cue in another video is a separate note',async()=>{
  const h=await harness([]);await h.press('n');const first=clone((await h.allNotes())[0]);await expire(h);
  await h.local.set({digest_video_00002:clone(h.local.snapshot().digest_video_00001)});
  h.url.searchParams.set('v','video_00002');await h.press('n');
  const notes=await h.allNotes();assert.equal(notes.length,2);
  assert.deepEqual(notes.find(n=>n.id===first.id),first);assert.ok(notes.some(n=>n.mediaKey==='video_00002'));
});

test('legacy notes without a raw cue are preserved rather than guessed to be identical',async()=>{
  const old=note('legacy',{rawText:''});const h=await harness([old]);await h.press('n');
  const notes=await h.allNotes();assert.equal(notes.length,2);assert.deepEqual(notes.find(n=>n.id===old.id),old);
});

test('a same-cue note saved while cleanup is pending is reused without overwriting its thought',async()=>{
  const h=await harness([],{configured:true});let release;
  h.providerGate=new Promise(resolve=>{release=resolve;});
  const pending=h.send({action:'saveNote',videoId:'video_00001',timestamp:33});await settle();
  assert.equal(h.providerCalls.length,1);
  const other=await h.send({action:'saveNote',videoId:'video_00001',timestamp:33,skipAiCleanup:true});assert.equal(other.success,true);
  await h.send({action:'updateNoteThought',noteId:other.note.id,thought:'并发保存的想法',dataGeneration:0,runtimeInstanceId:h.runWorker('runtimeInstanceId')});
  release();const reused=await pending;
  assert.equal(reused.success,true);assert.equal(reused.duplicate,true);assert.equal(reused.note.id,other.note.id);
  assert.equal(reused.note.thought,'并发保存的想法');assert.equal((await h.allNotes()).length,1);
});
