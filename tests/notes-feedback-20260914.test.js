const test = require('node:test');
const assert = require('node:assert/strict');
const {harness,note,bytes,read,settle} = require('./helpers/thought-layer-harness');

const findCard=(h,id)=>h.cards().find(card=>card.dataset.noteId===id);
const context=Array.from({length:14},(_,i)=>({t:20+i,text:`附近原话第${i}句`}));

for(const [word,fields] of [
  ['龙珠',{text:'你像《龙珠》《圣斗士星矢》，都是这种故事框架。',sourceLanguage:'zh',textLanguage:'zh'}],
  ['老鼠',{text:'A mouse plans before acting.',translatedText:'老鼠会先规划再行动。',translatedValidated:true,translatedValidationVersion:2}],
  ['湿疹',{text:'Eczema can affect sleep.',translatedText:'湿疹可能影响睡眠。',translatedValidated:true,translatedValidationVersion:2}],
]) test(`search finds displayed quote text ${word} beyond the short raw cue without provider calls or writes`,async()=>{
  const n=note('remote',{videoId:'video_00002',rawText:'a short trigger',...fields});
  const h=await harness([n]);const before=bytes(h.local);await h.load();
  await h.input(word);
  assert.deepEqual(h.cards().map(card=>card.dataset.noteId),[n.id]);
  assert.equal(h.providerCalls.length,0);assert.ok(bytes(h.local).equals(before));
});

test('delete thought first asks confirmation; cancel writes nothing; confirm clears only thought and thoughtAt',async()=>{
  const n=note('delete-thought',{thought:'保留金句，只删除这条想法',thoughtAt:123});
  const h=await harness([n]);await h.load();const before=bytes(h.local);h.resetEvidence();
  let card=findCard(h,n.id);const trigger=card.querySelector('.note-delete-thought');assert.ok(trigger);
  trigger.click();await settle();assert.ok(bytes(h.local).equals(before));
  let dialog=card.querySelector('.note-thought-delete-confirm');assert.ok(dialog);
  assert.match(dialog.textContent,/金句.*保留/);dialog.querySelector('.note-cancel-delete-thought').click();
  assert.ok(bytes(h.local).equals(before));assert.equal(h.local.writes.length,0);
  trigger.click();await settle();dialog=card.querySelector('.note-thought-delete-confirm');
  dialog.querySelector('.note-confirm-delete-thought').click();await settle();
  const updated=(await h.allNotes())[0];assert.deepEqual(updated,{...n,thought:'',thoughtAt:null});
  card=findCard(h,n.id);assert.equal(card.querySelector('.note-kind').textContent,'金句');
  assert.equal(card.querySelector('.note-delete-thought'),null);
  assert.equal(h.messages.some(message=>message.action==='deleteNote'),false);
});

test('failed thought deletion keeps the text and offers retry instead of reporting success',async()=>{
  const n=note('retry',{thought:'不能悄悄丢掉',thoughtAt:123});const h=await harness([n]);await h.load();
  const before=bytes(h.local);const card=findCard(h,n.id);const trigger=card.querySelector('.note-delete-thought');assert.ok(trigger);
  trigger.click();const set=h.local.set;
  h.local.set=async values=>{if(Object.keys(values).some(key=>key.startsWith('ytd_notes_')))throw new Error('write failed');return set(values);};
  const dialog=card.querySelector('.note-thought-delete-confirm');assert.ok(dialog);
  const confirm=dialog.querySelector('.note-confirm-delete-thought');confirm.click();await settle();
  assert.match(dialog.textContent,/失败|重试/);assert.equal(confirm.disabled,false);
  assert.ok(bytes(h.local).equals(before));assert.match(card.querySelector('.note-thought').textContent,/不能悄悄丢掉/);
});

for(const nextThought of ['另一处刚改过的新想法','原来的想法']) test(`a queued edit cannot be erased by an older deletion confirmation (${nextThought})`,async()=>{
  const n=note('racing',{thought:'原来的想法',thoughtAt:123});const h=await harness([n]);await h.load();
  findCard(h,n.id).querySelector('.note-delete-thought').click();
  let release;const gate=new Promise(resolve=>{release=resolve;});let held=false;
  const set=h.local.set;h.local.set=async values=>{
    if(!held&&Object.keys(values).some(key=>key.startsWith('ytd_notes_'))){held=true;await gate;}
    return set(values);
  };
  const editing=h.send({action:'updateNoteThought',noteId:n.id,thought:nextThought,
    runtimeInstanceId:h.runWorker('runtimeInstanceId'),dataGeneration:0});
  await settle();assert.equal(held,true);
  findCard(h,n.id).querySelector('.note-confirm-delete-thought').click();await settle();
  release();assert.equal((await editing).success,true);await settle();
  const stored=(await h.allNotes())[0];assert.equal(stored.thought,nextThought);assert.ok(stored.thoughtAt>123);
  assert.equal(stored.createdAt,n.createdAt);assert.equal(stored.text,n.text);
  assert.equal(h.doc.querySelector('.note-thought-delete-confirm'),null);
  assert.match(h.doc.getElementById('notesSearchStatus').textContent,/已.*更新.*重新/);
});

test('quote toggles a hidden eight-line context with no timecodes and no storage writes',async()=>{
  const n=note('context',{rawText:context[7].text,timestampSeconds:27,triggerWindow:context});
  const h=await harness([n]);await h.load(true);const before=bytes(h.local);h.resetEvidence();
  const card=findCard(h,n.id);const quote=card.querySelector('.note-quote');const panel=card.querySelector('.note-trigger-window');
  assert.ok(panel);assert.equal(panel.hidden,true);assert.equal(quote.getAttribute('aria-expanded'),'false');
  quote.click();assert.equal(panel.hidden,false);assert.equal(quote.getAttribute('aria-expanded'),'true');
  assert.equal(panel.textContent.trim().split('\n').length,8);assert.match(panel.textContent,/附近原话第7句/);
  assert.doesNotMatch(panel.textContent,/\d+:\d{2}/);
  quote.click();assert.equal(panel.hidden,true);assert.equal(quote.getAttribute('aria-expanded'),'false');
  assert.ok(bytes(h.local).equals(before));assert.equal(h.local.writes.length,0);
  assert.match(read('sidepanel.css'),/\.note-trigger-window\s*\{[^}]*-webkit-line-clamp:\s*8/s);
});

test('notes toolbar keeps search and segmented arrangement buttons together',async()=>{
  const h=await harness([note('one')]);await h.load(true);
  const toolbar=h.doc.getElementById('notesToolbar');assert.ok(toolbar);
  assert.ok(toolbar.contains(h.doc.getElementById('notesSearch')));
  assert.ok(toolbar.contains(h.doc.getElementById('notesGroupingRow')));
  assert.match(h.doc.getElementById('notesGroupingRow').textContent,/排列方式/);
  const date=h.doc.getElementById('notesGroupDate');const video=h.doc.getElementById('notesGroupVideo');
  assert.ok(date);assert.ok(video);assert.ok(date.closest('.notes-filter'));assert.ok(video.closest('.notes-filter'));
  video.click();await settle();assert.equal(video.getAttribute('aria-pressed'),'true');assert.equal(date.getAttribute('aria-pressed'),'false');
  assert.equal(h.local.snapshot().digestdock_notes_grouping,'video');
  assert.match(read('sidepanel.css'),/\.notes-toolbar\s*\{[^}]*position:\s*sticky/s);
});

test('only video groups taller than the available viewport get sticky headers, including after expansion',async()=>{
  const h=await harness([note('one')]);await h.load(true);
  assert.equal(h.run('typeof syncNoteStickyHeaders'),'function');
  h.doc.getElementById('contentArea').getBoundingClientRect=()=>({height:600});
  const toolbar=h.doc.getElementById('notesToolbar');assert.ok(toolbar);toolbar.getBoundingClientRect=()=>({height:150});
  const group=h.doc.querySelector('.note-source-group');const header=group.querySelector('.note-source-header');
  group.getBoundingClientRect=()=>({height:400});h.run('syncNoteStickyHeaders()');assert.equal(header.classList.contains('is-sticky'),false);
  group.getBoundingClientRect=()=>({height:700});h.run('syncNoteStickyHeaders()');assert.equal(header.classList.contains('is-sticky'),true);
  group.getBoundingClientRect=()=>({height:400});h.run('syncNoteStickyHeaders()');assert.equal(header.classList.contains('is-sticky'),false);
});

test('hidden migration band cannot paint an empty blue bar and export says it exports notes',async()=>{
  const h=await harness([note('one')]);await h.load(true);
  assert.equal(h.doc.getElementById('notesCapacity').hidden,true);
  assert.match(read('sidepanel.css'),/\.notes-capacity\[hidden\]\s*\{\s*display:\s*none/s);
  const button=h.doc.querySelector('.note-source-header .note-source-export');assert.ok(button);
  assert.equal(button.textContent,'导出本视频笔记');assert.equal(button.disabled,false);
});

test('toolbar uses the content inset at both normal and narrow panel widths',()=>{
  const css=read('sidepanel.css');
  assert.match(css,/\.notes-toolbar\s*\{[^}]*margin:[^;]*var\(--notes-panel-inset\)/s);
  assert.match(css,/@media\s*\(max-width:\s*380px\)[\s\S]*?\.content\s*\{[^}]*--notes-panel-inset:\s*12px/s);
});
