const test = require('node:test');
const assert = require('node:assert/strict');
const {harness,note,settle,bytes,read,clone} = require('./helpers/thought-layer-harness');

const day = (d,h=12) => new Date(2026,8,d,h).getTime();
const rich = (id, overrides={}) => note(id, {
  rawText:'也就是《宝可梦》',
  text:'你像《龙珠》《圣斗士星矢》《宝可梦》，都是以热血故事为框架的。',
  sourceLanguage:'zh',textLanguage:'zh',thought:'都是回忆',thoughtAt:1,
  ...overrides,
});
const card = (h,id) => {
  const found=h.cards().find(n=>n.dataset.noteId===id);
  assert.ok(found,`missing note ${id}`);return found;
};
const ids = root => root.querySelectorAll('.note-item').map(n=>n.dataset.noteId);
async function grouping(h,value) {
  const button=h.doc.querySelector(`[data-notes-grouping="${value}"]`);
  assert.ok(button,'all notes must expose grouping selection');
  button.click();await settle();
}
function body(h,id) {
  const item=card(h,id);
  const thought=item.querySelector('.note-thought');
  const quote=item.querySelector('.note-quote');
  assert.ok(thought);assert.ok(quote);
  return {thought:thought.textContent,quote:quote.textContent};
}

for (const mode of ['original','zh','bilingual']) test(`same note has identical thought and quote in current, all and search (${mode})`,async()=>{
  const n=rich('memory');const h=await harness([n]);
  h.run(`currentNotesMode=${JSON.stringify(mode)}`);
  const before=bytes(h.local);h.resetEvidence();
  await h.load();const current=body(h,n.id);
  assert.equal(current.thought,n.thought);
  const expected=h.run('renderNoteLanguageContent(currentNotes[0])');
  assert.equal(card(h,n.id).querySelector('.note-quote').innerHTML,expected);
  await h.load(true);assert.deepEqual(body(h,n.id),current);
  await h.input('都是回忆');assert.deepEqual(body(h,n.id),current);
  assert.ok(bytes(h.local).equals(before));assert.equal(h.providerCalls.length,0);
});

test('current-video thoughts can be edited and immediately found globally without extra fields',async()=>{
  const n=rich('edit');const h=await harness([n]);await h.load();
  const item=card(h,n.id);const edit=item.querySelector('.note-edit-thought');assert.ok(edit);
  edit.click();await settle();item.querySelector('textarea').value='更正后的回忆';
  item.querySelector('.note-save-thought').click();await settle();
  const updated=(await h.allNotes())[0];assert.equal(updated.thought,'更正后的回忆');
  assert.deepEqual(Object.keys(updated).sort(),Object.keys(n).sort());
  const omit=x=>Object.fromEntries(Object.entries(x).filter(([key])=>!['thought','thoughtAt'].includes(key)));
  assert.deepEqual(omit(updated),omit(n));
  await h.input('更正后的回忆');assert.deepEqual(ids(h.doc),[n.id]);
});

test('thoughts and quotes have distinct visual classes and text labels without a stored type field',async()=>{
  const h=await harness([rich('thought'),rich('quote',{thought:'',thoughtAt:null})]);await h.load();
  assert.ok(card(h,'thought').classList.contains('note-item--thought'));
  assert.ok(card(h,'quote').classList.contains('note-item--quote'));
  assert.equal(card(h,'thought').querySelector('.note-kind').textContent,'想法');
  assert.equal(card(h,'quote').querySelector('.note-kind').textContent,'金句');
  assert.ok((await h.allNotes()).every(n=>!Object.hasOwn(n,'type')));
});

// The user's 2026-09-14 revision replaces the always-visible four-line preview
// with a collapsed eight-line context. Stored context must still stay intact.
test('context preview keeps at most eight nearby cues including the trigger; full storage is preserved',async()=>{
  const window=Array.from({length:12},(_,i)=>({t:i*10,text:`上下文 ${i}`}));
  const n=rich('context',{timestampSeconds:70,rawText:'上下文 7',triggerWindow:window});
  const h=await harness([n]);const before=bytes(h.local);await h.load(true);
  const preview=card(h,n.id).querySelector('.note-trigger-window');assert.ok(preview);
  assert.equal(preview.hidden,true);
  const rows=preview.textContent.trim().split('\n');assert.equal(rows.length,8);
  assert.ok(rows.some(r=>r.includes('上下文 7')));assert.ok(!rows.some(r=>r.includes('上下文 0')));
  assert.ok(bytes(h.local).equals(before));assert.deepEqual((await h.allNotes())[0].triggerWindow,window);
  const css=read('sidepanel.css');assert.match(css,/\.note-trigger-window\s*\{[^}]*-webkit-line-clamp:\s*8/s);
});

function groupedNotes() {
  return [
    rich('a-old',{createdAt:day(10),timestampSeconds:10,videoTitle:'相同标题'}),
    rich('a-new-late',{createdAt:day(13,10),timestampSeconds:90,videoTitle:'相同标题'}),
    rich('b-new',{videoId:'video_00002',createdAt:day(13,13),timestampSeconds:50,videoTitle:'相同标题'}),
    rich('a-new-early',{createdAt:day(13,11),timestampSeconds:5,videoTitle:'相同标题'}),
  ];
}

test('date grouping defaults to local day, then distinct stable video sources, then timecodes',async()=>{
  const h=await harness(groupedNotes());await h.load(true);
  const button=h.doc.getElementById('notesGroupDate');assert.ok(button);assert.equal(button.getAttribute('aria-pressed'),'true');
  const days=h.doc.querySelectorAll('.note-day-group');assert.deepEqual(days.map(n=>n.dataset.date),['2026-09-13','2026-09-10']);
  const sources=days[0].querySelectorAll('.note-source-group');
  assert.deepEqual(sources.map(g=>g.dataset.mediaKey),['video_00002','video_00001']);
  assert.deepEqual(ids(sources[1]),['a-new-early','a-new-late']);
  assert.match(sources[1].querySelector('.note-source-meta').textContent,/Test channel.*YouTube.*2 条笔记/);
  assert.equal(days[1].querySelectorAll('.note-source-group').length,1);
});

test('video grouping merges dates under one stable video title and orders each day by timecode',async()=>{
  const h=await harness(groupedNotes());await h.load(true);const before=bytes(h.local);
  await grouping(h,'video');const sources=h.doc.querySelectorAll('.note-source-group');
  assert.deepEqual(sources.map(g=>g.dataset.mediaKey),['video_00002','video_00001']);
  assert.equal(sources[1].querySelectorAll('.note-source-header').length,1);
  assert.deepEqual(sources[1].querySelectorAll('.note-source-day').map(d=>d.dataset.date),['2026-09-13','2026-09-10']);
  assert.deepEqual(ids(sources[1]),['a-new-early','a-new-late','a-old']);
  assert.match(sources[1].querySelector('.note-source-meta').textContent,/3 条笔记/);
  assert.ok(bytes(h.local).equals(before));assert.equal(h.providerCalls.length,0);
});

test('grouping selection survives search, scope changes, and reopening; never writes note shards',async()=>{
  const h=await harness(groupedNotes());await h.load(true);const before=bytes(h.local);
  await grouping(h,'video');assert.equal(h.local.snapshot().digestdock_notes_grouping,'video');
  await h.input('都是回忆');assert.equal(h.doc.getElementById('notesGroupingRow').hidden,true);
  await h.input('');assert.equal(h.doc.getElementById('notesGroupVideo').getAttribute('aria-pressed'),'true');
  await h.load();assert.equal(h.doc.getElementById('notesGroupingRow').hidden,true);
  await h.load(true);assert.equal(h.doc.getElementById('notesGroupingRow').hidden,false);
  h.run('notesGroupingMode="date"');await h.run('restoreNotesGroupingPreference()');
  assert.equal(h.run('notesGroupingMode'),'video');assert.ok(bytes(h.local).equals(before));
  assert.ok(h.local.writes.every(w=>w.keys.every(k=>k==='digestdock_notes_grouping')));
});

test('both grouping modes keep global multi-result search flat, thought-first and saved-date descending, with export entries',async()=>{
  const notes=[
    rich('quote-new',{rawText:'检索对照',thought:'',thoughtAt:null,createdAt:day(14),timestampSeconds:1}),
    rich('thought-old',{thought:'检索对照',thoughtAt:9999,createdAt:day(10),timestampSeconds:2}),
    rich('quote-old',{videoId:'video_00002',rawText:'检索对照',thought:'',thoughtAt:null,createdAt:day(9),timestampSeconds:3}),
    rich('thought-new',{videoId:'video_00002',thought:'检索对照',thoughtAt:1,createdAt:day(13),timestampSeconds:90}),
  ];
  const h=await harness(notes);const before=bytes(h.local);
  for(const mode of ['date','video']) {
    await h.load(true);await grouping(h,mode);
    const groups=h.doc.querySelectorAll('.note-source-group');assert.ok(groups.length);
    assert.ok(groups.every(g=>g.querySelector('.note-source-header .note-source-export')));
    await h.load();await h.input('检索对照');
    assert.deepEqual(ids(h.doc),['thought-new','thought-old','quote-new','quote-old']);
    assert.equal(h.doc.querySelectorAll('.note-source-group').length,0);
    assert.equal(h.doc.querySelectorAll('.note-day-group').length,0);
    assert.ok(h.cards().every(item=>item.querySelector('.note-source-export')));
    assert.equal(h.doc.getElementById('notesGroupingRow').hidden,true);
    await h.input('');
  }
  assert.ok(bytes(h.local).equals(before));assert.equal(h.providerCalls.length,0);
});

test('source header sticks within its video group and context has no nested scroll pane',()=>{
  const css=read('sidepanel.css');
  assert.match(css,/\.note-source-header\.is-sticky\s*\{[^}]*position:\s*sticky/s);
  assert.match(css,/\.note-source-header\.is-sticky\s*\{[^}]*border-radius:\s*0/s);
  assert.doesNotMatch(css.match(/\.note-source-group\s*\{[^}]*\}/s)?.[0]||'',/overflow:\s*(hidden|auto)/);
  assert.doesNotMatch(css.match(/\.note-trigger-window\s*\{[^}]*\}/s)?.[0]||'',/overflow-y:\s*auto/);
});
