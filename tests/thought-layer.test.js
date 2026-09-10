const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const {harness,note,settle,bytes,noteWrites,clone,read,documentFor} = require("./helpers/thought-layer-harness");

// Phase 2, specification revised twice on 2026-09-10. UI selectors below are
// proposed implementation hooks, not new product requirements. No handler for
// thought editing/search/AI candidates is implemented inside the test harness.
const THOUGHT = "语音原文：这个想法值得保留。\n不要替我改写。";
function inputInToast(h) {
  const input = h.toast()?.querySelector("textarea, input");
  assert.ok(input,"T2: 第二次 N 尚未把原 toast 转成想法输入框");
  return input;
}
async function beginThought(h) { await h.press("n"); const toast=h.toast(); assert.ok(toast); await h.press("n"); return {toast,input:inputInToast(h)}; }
function ids(h) { return h.cards().map(card => card.dataset.noteId); }
function item(h,id) { const card=h.cards().find(x=>x.dataset.noteId===id); assert.ok(card,`应渲染现有笔记 ${id}`); return card; }
function unchangedExceptThought(before,after) {
  assert.deepEqual(Object.keys(after).sort(), [...new Set([...Object.keys(before),"thought","thoughtAt"])].sort(),"不得新增类型、确认或其他状态字段");
  const omit = n => Object.fromEntries(Object.entries(n).filter(([k])=>!['thought','thoughtAt'].includes(k)));
  assert.deepEqual(omit(after),omit(before),"想法编辑不得修改其他笔记字段");
}
async function edit(h,id,value) {
  const card=item(h,id), button=card.querySelector(".note-edit-thought");
  assert.ok(button,"T9: 最近中的笔记缺少就地编辑想法入口"); button.click(); await settle();
  const input=card.querySelector("textarea, input"); assert.ok(input); input.value=value;
  const save=card.querySelector(".note-save-thought"); assert.ok(save,"编辑器缺少保存入口"); save.click(); await settle();
}
function assertReadOnly(h,before) {
  assert.ok(bytes(h.local).equals(before),"T7: 笔记分片、索引、schema 必须逐字节不变");
  assert.deepEqual(noteWrites(h.local),[],"T7: 不允许先写后还原");
}

test("[harness] real current-view rendering and provider spy are live (not a vacuous zero)",async()=>{
  const h=await harness([note("control")],{configured:true});
  await h.load(false,true);
  assert.equal(h.cards().length,1);
  assert.ok(h.messages.some(m=>m.action==="translateNotes"),"控制组应触发既有自动翻译路径");
  assert.ok(h.providerCalls.length>0,"应捕获真实共享 provider 调用层");
  assert.equal(h.requests.length,h.providerCalls.length,"每次 provider 调用实际到达离线 HTTP 桩");
  assert.ok(h.requests.every(r=>r.url.includes("/chat/completions")));
});

test("[T1] first N saves exactly one empty thought and does not pause playback",async()=>{
  const h=await harness(); await h.press("n");
  const saved=await h.allNotes(); assert.equal(saved.length,1); assert.ok(h.toast());
  assert.match(h.toast().textContent,/笔记已保存/);
  assert.equal(saved[0].thought,""); assert.equal(saved[0].thoughtAt,null);
  assert.equal(h.video.paused,false); assert.equal(h.video.pauseCalls,0);
  assert.equal(h.messages.find(m=>m.action==="saveNote").timestamp,33,"保留现有 -3 秒捕获位置");
  assert.equal(saved[0].timestampSeconds,30,"保留原有字幕锚点，不把反应位置写成锚点");
});
test("[T1] quote toast survives five seconds and expires after ten seconds",async()=>{
  const h=await harness(); await h.press("n"); const toast=h.toast();
  await h.time.advance(5500); assert.ok(h.toast()===toast,"toast 不能仍按旧的 5 秒消失");
  await h.time.advance(4900); assert.equal(h.toast(),null);
  assert.equal((await h.allNotes()).length,1);
});
test("[T1–T3] N after toast expiry saves a new quote; only its own toast can edit it",async()=>{
  const h=await harness(); await h.press("n");
  const first=clone((await h.allNotes())[0]);
  await h.time.advance(11000); assert.equal(h.toast(),null);
  await h.press("n"); const notes=await h.allNotes();
  assert.equal(notes.length,2,"toast 过期后 N 必须新建笔记，不能编辑上一条");
  const second=notes.find(n=>n.id!==first.id); assert.ok(second);
  assert.equal(second.thought,""); assert.equal(second.thoughtAt,null);
  assert.deepEqual(notes.find(n=>n.id===first.id),first,"第一条所有字段必须原样保留");
  assert.ok(h.toast()); await h.press("n");
  inputInToast(h).value=THOUGHT; await h.press("Enter");
  const after=await h.allNotes(); assert.equal(after.length,2);
  assert.deepEqual(after.find(n=>n.id===first.id),first);
  const edited=after.find(n=>n.id===second.id);
  assert.equal(edited.thought,THOUGHT); assert.ok(Number.isSafeInteger(edited.thoughtAt));
  unchangedExceptThought(second,edited);
});
test("[T2] second N edits the same toast, focuses, pauses and cancels dismissal",async()=>{
  const h=await harness(); const {toast,input}=await beginThought(h);
  assert.equal(h.toast(),toast); assert.equal(h.contentDoc.activeElement,input);
  assert.equal((await h.allNotes()).length,1); assert.equal(h.video.paused,true);
  await h.time.advance(20000); assert.equal(h.toast(),toast); assert.equal(input.isConnected,true);
});
test("[T3] Enter saves verbatim thought/time in the real worker and never resumes",async()=>{
  const h=await harness(); const {input}=await beginThought(h);
  const before=(await h.allNotes())[0]; input.value=THOUGHT; const started=Date.now();
  await h.press("Enter"); const after=(await h.allNotes())[0];
  assert.equal(after.thought,THOUGHT); assert.ok(after.thoughtAt>=started && after.thoughtAt<=Date.now());
  unchangedExceptThought(before,after); assert.equal(h.toast(),null);
  assert.equal(h.video.paused,true); assert.equal(h.video.playCalls,0);
  const idx=(await h.api.readNoteIndex())[0]; assert.equal(idx.hasThought,true); assert.ok(idx.searchText.includes("不要替我改写"));
});
test("[T3] IME composition Enter confirms a candidate without saving the thought",async()=>{
  const h=await harness(); const {input}=await beginThought(h); input.value=THOUGHT;
  input.dispatchEvent({type:"compositionstart"}); await h.press("Enter",{isComposing:true,keyCode:229});
  assert.ok(h.toast()); assert.equal((await h.allNotes())[0].thought,"");
  input.dispatchEvent({type:"compositionend"}); await h.press("Enter");
  assert.equal((await h.allNotes())[0].thought,THOUGHT);
});
test("[T3] failed persistence retains input, reports failure and does not claim success",async()=>{
  const h=await harness(); const {input}=await beginThought(h); input.value=THOUGHT;
  const before=bytes(h.local); h.local.set=async()=>{throw new Error("fixture write failure");};
  await h.press("Enter"); assert.ok(h.toast()); assert.equal(input.value,THOUGHT);
  assert.ok(bytes(h.local).equals(before)); assert.match(h.toast().textContent,/失败|重试/);
});
test("[T3] a worker restart while the input stays open refreshes the fence once and saves",async()=>{
  const h=await harness(); const {input}=await beginThought(h); input.value=THOUGHT;
  const original=clone((await h.allNotes())[0]);
  const restarted=await harness(); await restarted.local.set(h.local.snapshot());
  assert.notEqual(restarted.runWorker("runtimeInstanceId"),h.runWorker("runtimeInstanceId"));
  h.content.chrome.runtime.sendMessage=restarted.send;
  await h.press("Enter"); const saved=(await restarted.allNotes())[0];
  assert.equal(saved.thought,THOUGHT); unchangedExceptThought(original,saved);
  assert.equal(h.toast(),null); assert.equal(h.video.paused,true); assert.equal(h.video.playCalls,0);
  assert.equal(restarted.messages.filter(m=>m.action==="updateNoteThought").length,2,"复用现有一次后台刷新重试语义");
});
test("[T4] Escape discards draft only, retaining the saved quote",async()=>{
  const h=await harness(); const {input}=await beginThought(h); input.value=THOUGHT;
  const before=bytes(h.local); h.resetEvidence(); await h.press("Escape");
  assert.equal(h.toast(),null); assert.equal((await h.allNotes()).length,1);
  assert.equal((await h.allNotes())[0].thought,""); assertReadOnly(h,before);
});

for(const showAll of [false,true]) test(`[T5/T8] search is global from ${showAll?"all":"current"}; clearing restores that side`,async()=>{
  const h=await harness([note("local"),note("remote",{videoId:"video_00002",thought:THOUGHT,thoughtAt:100})]);
  await h.load(showAll); await h.input("值得保留");
  assert.deepEqual(ids(h),["remote"]);
  const card=item(h,"remote"); const thought=card.querySelector(".note-thought");
  const trigger=card.querySelector(".note-trigger"); assert.ok(thought); assert.ok(trigger);
  assert.ok(card.innerHTML.indexOf("note-thought")<card.innerHTML.indexOf("note-trigger"));
  assert.match(trigger.textContent,/Source quote/); assert.match(trigger.textContent,/Frozen context before/);
  await h.input("");
  assert.equal(h.doc.getElementById("notesFilterThis").getAttribute("aria-pressed"),String(!showAll));
  assert.equal(h.doc.getElementById("notesFilterAll").getAttribute("aria-pressed"),String(showAll));
  assert.equal(h.cards().length,showAll?2:1);
  if(!showAll) assert.equal(h.doc.querySelectorAll(".note-day-group").length,0);
});
test("[T5] thought-first search order, then savedAt descending in each group",async()=>{
  const h=await harness([
    note("quote-old",{rawText:"needle",createdAt:100}),
    note("thought-old",{thought:"needle",thoughtAt:9999,createdAt:200}),
    note("quote-new",{rawText:"needle",createdAt:500}),
    note("thought-new",{thought:"needle",thoughtAt:1,createdAt:300}),
  ]); await h.load(); await h.input("needle");
  assert.deepEqual(ids(h),["thought-new","thought-old","quote-new","quote-old"]);
});
for(const field of ["videoTitle","channelName"]) test(`[T5] global exact match includes ${field}`,async()=>{
  const h=await harness([note("remote",{videoId:"video_00002",[field]:"字段独有词"})]);
  await h.load(); await h.input("字段独有词"); assert.deepEqual(ids(h),["remote"]);
});
test("[T5] stale global load cannot overwrite a later query or the restored current side",async()=>{
  const h=await harness([note("first",{thought:"甲关键词",thoughtAt:1}),note("second",{videoId:"video_00002",thought:"乙关键词",thoughtAt:1})]);
  await h.load(); assert.ok(h.doc.querySelector('input[type="search"]'),"T5: 尚缺搜索输入入口");
  const original=h.local.get; let release;
  const gate=new Promise(r=>{release=r;}); let held=false;
  h.local.get=async keys=>{if(!held){held=true;await gate;}return original(keys);};
  const a=h.input("甲关键词"); await settle(); await h.input("乙关键词"); release(); await a; await settle();
  assert.deepEqual(ids(h),["second"]); await h.input("");
  assert.equal(h.doc.getElementById("notesFilterThis").getAttribute("aria-pressed"),"true");
  assert.equal(h.cards().length,1);
});
test("[T6] subtitle-only exact match finds a thought with a homophone typo",async()=>{
  const h=await harness([note("typo",{thought:"复力值得思考",thoughtAt:1,rawText:"复利需要时间"})]);
  await h.load(); await h.input("复利"); assert.deepEqual(ids(h),["typo"]);
  await h.input("复历"); assert.equal(h.cards().length,0,"不增加模糊匹配");
});

test("[T7] zero results send NO provider request, including implicit note translation",async()=>{
  const h=await harness([note("english")],{configured:true});
  await h.load(false,false); h.resetEvidence(); const before=bytes(h.local);
  await h.input("完全不存在的词"); await h.time.advance(15000);
  assert.equal(h.cards().length,0); assert.ok(h.aiButton());
  assert.equal(h.providerCalls.length,0,"禁止从 loadNotes 偷偷进入 ensureNotesChinese");
  assert.equal(h.requests.length,0); assertReadOnly(h,before);
});
test("[T7] AI button is absent for blank and nonzero searches",async()=>{
  const h=await harness([note("hit")]); await h.load(true); assert.equal(h.aiButton(),undefined);
  await h.input("Source quote"); assert.equal(h.aiButton(),undefined);
  await h.input("不存在"); assert.ok(h.aiButton()); await h.input(""); assert.equal(h.aiButton(),undefined);
});
test("[T7] click reads thoughts, returns at most five existing IDs, and never writes library",async()=>{
  const notes=Array.from({length:8},(_,i)=>note(`candidate-${i}`,{thought:`原想法 ${i}`,thoughtAt:1,createdAt:100+i}));
  const h=await harness(notes,{configured:true}); await h.load(true); await h.input("找一点相关的");
  h.aiReply=JSON.stringify(["candidate-0","nonexistent",{id:"candidate-1",thought:"AI偷偷改写"},"candidate-0",...notes.slice(2).map(n=>n.id)]);
  h.resetEvidence(); const before=bytes(h.local); const button=h.aiButton(); assert.ok(button); button.click(); await settle();
  assert.equal(h.providerCalls.length,1); assert.equal(h.requests.length,1);
  assert.ok(JSON.stringify(h.providerCalls[0]).includes("原想法"),"允许检索读取用户想法");
  const shown=ids(h); assert.equal(shown.length,5); assert.equal(new Set(shown).size,5);
  assert.ok(shown.every(id=>notes.some(n=>n.id===id))); assert.ok(!shown.includes("nonexistent"));
  for(const id of shown) assert.ok(item(h,id).textContent.includes(notes.find(n=>n.id===id).thought));
  assert.doesNotMatch(h.doc.getElementById("notesList").textContent,/AI偷偷改写/); assertReadOnly(h,before);
});
test("[T7] a normal eight-note library is sent in full without a truncation notice",async()=>{
  const notes=Array.from({length:8},(_,i)=>note(`candidate-${i}`,{thought:`原想法 ${i}`,thoughtAt:1,createdAt:100+i}));
  const h=await harness(notes,{configured:true}); await h.load(true); await h.input("找一点相关的");
  h.aiReply=JSON.stringify(["candidate-0"]); h.resetEvidence(); const before=bytes(h.local);
  assert.ok(h.aiButton()); h.aiButton().click(); await settle();
  assert.equal(h.providerCalls.length,1); assert.equal(h.requests.length,1);
  const input=JSON.stringify(h.providerCalls[0].messages);
  for(const n of notes) assert.ok(input.includes(n.thought),`正常大小的库不得漏送 ${n.id} 的想法`);
  assert.doesNotMatch(h.doc.body.textContent,/只检索了最近/);
  assertReadOnly(h,before);
});
test("[T7] truncated AI input is newest-first and visibly discloses actual N; one request",async()=>{
  const notes=Array.from({length:120},(_,i)=>note(`large-${i}`,{thought:`唯一想法${i}：`+"长文本".repeat(2500),thoughtAt:1,createdAt:1000+i}));
  const h=await harness(notes,{configured:true}); await h.load(true); await h.input("未命中");
  h.resetEvidence(); const before=bytes(h.local); const button=h.aiButton(); assert.ok(button); button.click(); await settle();
  assert.equal(h.providerCalls.length,1); assert.equal(h.requests.length,1);
  const input=JSON.stringify(h.providerCalls[0]);
  const included=notes.filter(n=>input.includes(`唯一想法${n.id.slice(6)}：`));
  assert.ok(included.length>0 && included.length<notes.length,"超大夹具应触发有说明的截断");
  assert.deepEqual(included.map(n=>n.id),notes.slice(-included.length).map(n=>n.id));
  const descending=[...included].reverse();
  for(let i=1;i<descending.length;i++) assert.ok(input.indexOf(descending[i-1].thought.slice(0,10))<input.indexOf(descending[i].thought.slice(0,10)));
  assert.ok(h.doc.body.textContent.includes(`只检索了最近 ${included.length} 条`)); assertReadOnly(h,before);
});
for(const reply of ['not json at all',JSON.stringify(["missing-id"])]) test(`[T7] invalid/unmapped AI response is discarded (${reply[0]})`,async()=>{
  const h=await harness([note("kept")],{configured:true}); await h.load(true); await h.input("未命中");
  h.aiReply=reply; h.resetEvidence(); const before=bytes(h.local); assert.ok(h.aiButton()); h.aiButton().click(); await settle();
  assert.equal(h.cards().length,0); assert.equal(h.providerCalls.length,1); assertReadOnly(h,before);
  assert.ok(!h.doc.getElementById("notesList").textContent.includes(reply));
});
test("[T7] late AI response cannot replace a newer exact-search result",async()=>{
  const h=await harness([note("old"),note("new",{thought:"新关键词",thoughtAt:1})],{configured:true});
  await h.load(true); await h.input("未命中"); let release; h.providerGate=new Promise(r=>{release=r;});
  h.aiReply=JSON.stringify(["old"]); assert.ok(h.aiButton()); h.aiButton().click(); await settle();
  await h.input("新关键词"); release(); await settle(); assert.deepEqual(ids(h),["new"]);
});
test("[T7] a candidate deleted during the AI request is not displayed from a stale snapshot",async()=>{
  const h=await harness([note("removed"),note("kept")],{configured:true});
  await h.load(true); await h.input("未命中"); let release; h.providerGate=new Promise(r=>{release=r;});
  h.aiReply=JSON.stringify(["removed","kept"]); assert.ok(h.aiButton()); h.aiButton().click(); await settle();
  await h.api.deleteNote("removed"); const before=bytes(h.local); h.resetEvidence();
  release(); await settle(); assert.deepEqual(ids(h),["kept"]); assertReadOnly(h,before);
});
test("[T7] provider failure does not retry automatically, invent candidates or write notes",async()=>{
  const h=await harness([note("kept")],{configured:true}); await h.load(true); await h.input("未命中");
  const originalFetch=h.worker.fetch;
  h.worker.fetch=async(url,options)=>{if(String(url).startsWith("chrome-extension://"))return originalFetch(url,options);h.requests.push({url:String(url)});return new Response('{}',{status:503});};
  h.resetEvidence(); const before=bytes(h.local); assert.ok(h.aiButton()); h.aiButton().click(); await settle();
  await h.time.advance(15000); assert.equal(h.providerCalls.length,1); assert.equal(h.cards().length,0); assertReadOnly(h,before);
});

test("[T8] default/current side retains source grouping and timestamp order",async()=>{
  const html=documentFor(read("sidepanel.html")); assert.equal(html.getElementById("notesFilterThis").getAttribute("aria-pressed"),"true");
  assert.equal(html.getElementById("notesFilterAll").getAttribute("aria-pressed"),"false");
  const h=await harness([note("later",{timestampSeconds:90,rawText:"Later cue",text:"Later cue"}),note("earlier",{timestampSeconds:5,rawText:"Earlier cue",text:"Earlier cue"}),note("remote",{videoId:"video_00002"})]);
  await h.load(); assert.equal(h.cards().length,2); assert.equal(h.doc.querySelectorAll(".note-source-group").length,1);
  assert.ok(h.cards()[0].textContent.includes("Earlier cue")); assert.equal(h.doc.querySelectorAll(".note-day-group").length,0);
});
test("[T8] all-notes recent groups skip empty days and treat historical quotes normally",async()=>{
  const legacy=note("legacy",{createdAt:new Date(2026,8,6,12).getTime()}); delete legacy.thought; delete legacy.thoughtAt;
  const h=await harness([legacy,note("today",{createdAt:new Date(2026,8,9,12).getTime(),thought:THOUGHT,thoughtAt:1})]);
  await h.load(true); const groups=h.doc.querySelectorAll(".note-day-group");
  assert.equal(groups.length,2,"T8: 全部笔记尚未替换为现实日期分组");
  assert.deepEqual(groups.map(g=>g.dataset.date),["2026-09-09","2026-09-06"]);
  assert.match(h.doc.getElementById("notesPanel").textContent,/最近/);
  assert.doesNotMatch(h.doc.getElementById("notesPanel").textContent,/待确认|未确认|未读|想法缺失|置顶/);
  assert.ok(item(h,"legacy")); assert.equal(h.cards().length,2);
});
for(const tz of ["America/Los_Angeles","Asia/Shanghai"]) test(`[T8] natural days use browser-local timezone (${tz})`,()=>{
  const script=`const {harness,note}=require(${JSON.stringify(path.join(__dirname,"helpers/thought-layer-harness"))});
    (async()=>{const h=await harness([note('a',{createdAt:new Date(2026,8,9,23,59).getTime()}),note('b',{createdAt:new Date(2026,8,10,0,1).getTime()})]);
      await h.load(true); process.stdout.write(JSON.stringify(h.doc.querySelectorAll('.note-day-group').map(g=>g.dataset.date)));})().catch(e=>{console.error(e);process.exitCode=1});`;
  const result=spawnSync(process.execPath,["-e",script],{env:{...process.env,TZ:tz},encoding:"utf8"});
  assert.equal(result.status,0,result.stderr); assert.deepEqual(JSON.parse(result.stdout),["2026-09-10","2026-09-09"]);
});

test("[T9] any recent note can be written/edited/cleared, touching only thought fields and index",async()=>{
  const original=note("editable"); const h=await harness([original]); await h.load(true);
  for(const value of [THOUGHT,"改正错别字后的新想法",""]) {
    await edit(h,"editable",value); const after=(await h.allNotes())[0];
    assert.equal(after.thought,value); assert.equal(after.thoughtAt===null,value==="");
    if(value) assert.ok(Number.isSafeInteger(after.thoughtAt));
    unchangedExceptThought(original,after);
    const idx=clone((await h.api.readNoteIndex())[0]); assert.equal(idx.savedAt,original.createdAt); assert.equal(idx.hasThought,!!value);
    assert.equal(idx.searchText.includes("值得保留"),value===THOUGHT);
    if(value) {await h.input(value.split("\n")[0]); assert.deepEqual(ids(h),["editable"]); await h.input("");}
  }
  assert.equal(h.doc.querySelector(".note-day-group").dataset.date,"2026-09-08");
});
test("[T9] worker rejects editing a deleted note instead of resurrecting it",async()=>{
  const h=await harness([note("deleted")]); const fence={runtimeInstanceId:h.runWorker("runtimeInstanceId"),dataGeneration:0};
  const existing=await h.send({action:"updateNoteThought",noteId:"deleted",thought:"存在时可编辑",...fence});
  assert.equal(existing.success,true,"T9: 后台尚未接入想法更新操作");
  await h.api.deleteNote("deleted"); const before=bytes(h.local); h.resetEvidence();
  const result=await h.send({action:"updateNoteThought",noteId:"deleted",thought:THOUGHT,...fence});
  assert.equal(result.success,false); assertReadOnly(h,before); assert.equal((await h.allNotes()).length,0);
});
test("[T3/T9] worker write contract keeps thought and thoughtAt together, without changing save date",async()=>{
  const original=note("write-contract"); const h=await harness([original],{configured:true});
  const fence={runtimeInstanceId:h.runWorker("runtimeInstanceId"),dataGeneration:0};
  for(const thought of [THOUGHT,"改过的原文",""]) {
    const started=Date.now(); const result=await h.send({action:"updateNoteThought",noteId:original.id,thought,...fence});
    assert.equal(result.success,true,"后台尚未接入想法更新操作");
    const after=(await h.allNotes())[0]; assert.equal(after.thought,thought); unchangedExceptThought(original,after);
    if(thought) assert.ok(after.thoughtAt>=started && after.thoughtAt<=Date.now()); else assert.equal(after.thoughtAt,null);
    const idx=(await h.api.readNoteIndex())[0]; assert.equal(idx.savedAt,original.createdAt); assert.equal(idx.hasThought,!!thought);
  }
  assert.equal(h.providerCalls.length,0,"写入想法不能调用 AI");
});
test("[T9] concurrent edits preserve both notes and their index entries",async()=>{
  const h=await harness([note("a"),note("b")]); const fence={runtimeInstanceId:h.runWorker("runtimeInstanceId"),dataGeneration:0};
  const results=await Promise.all(["a","b"].map(id=>h.send({action:"updateNoteThought",noteId:id,thought:`想法 ${id}`,...fence})));
  assert.ok(results.every(r=>r.success),"两个合法编辑请求都应成功");
  const stored=await h.allNotes(), index=clone(await h.api.readNoteIndex());
  for(const id of ["a","b"]) {assert.equal(stored.find(n=>n.id===id).thought,`想法 ${id}`); assert.ok(index.find(n=>n.id===id).searchText.includes(`想法 ${id}`));}
});
test("[T9] stale runtime/reset fence cannot write a thought",async()=>{
  const h=await harness([note("fenced")]); const fence={runtimeInstanceId:h.runWorker("runtimeInstanceId"),dataGeneration:0};
  assert.equal((await h.send({action:"updateNoteThought",noteId:"fenced",thought:THOUGHT,...fence})).success,true,"先确认写入路径存在，避免未实现接口假通过");
  const before=bytes(h.local); h.resetEvidence();
  for(const stale of [{...fence,runtimeInstanceId:"old-runtime"},{...fence,dataGeneration:2}]) {
    const result=await h.send({action:"updateNoteThought",noteId:"fenced",thought:"过时覆盖",...stale}); assert.equal(result.success,false);
  }
  assertReadOnly(h,before);
});

for(const view of ["recent","search"]) for(const platform of ["current","youtube","bilibili"]) test(`[T10] ${view} one-click route to ${platform} retains source and exact seconds`,async()=>{
  const remote=platform==="bilibili" ? note("jump",{platform:"bilibili",videoId:"BV1zBtg6NEjF",mediaKey:"bilibili:BV1zBtg6NEjF:123",bvid:"BV1zBtg6NEjF",cid:123,page:2,canonicalUrl:"https://www.bilibili.com/video/BV1zBtg6NEjF/?p=2",timestampedUrl:"https://www.bilibili.com/video/BV1zBtg6NEjF/?p=2&t=30",thought:"跳回触发点",thoughtAt:1}) : note("jump",{videoId:platform==="current"?"video_00001":"video_00002",thought:"跳回触发点",thoughtAt:1});
  const h=await harness([remote]); await h.load(true); if(view==="search") await h.input("跳回触发点");
  else assert.ok(h.doc.querySelector(".note-day-group"),"T10 的最近入口尚未实现");
  const card=item(h,"jump"), play=card.querySelector(".note-play"); assert.ok(play); play.click(); await settle();
  if(platform==="current") {
    const seek=h.navigation.find(x=>x.type==="content" && x.payload.action==="seekTo");
    assert.ok(seek,"必须向当前视频发送定位动作"); assert.equal(seek.payload.seconds,30);
  } else {
    const opened=h.navigation.find(x=>x.type==="create"); assert.ok(opened); assert.equal(opened.url,remote.timestampedUrl);
    assert.ok(h.navigation.some(x=>x.type==="activate" && x.id===2));
    const intent=h.session.snapshot().ytd_note_navigation; assert.equal(intent.mediaKey,remote.mediaKey); assert.equal(intent.timestampedUrl,remote.timestampedUrl);
  }
});
test("[T10] unopenable video displays frozen context without inventing a cause",async()=>{
  const h=await harness([note("unreachable",{videoId:"video_00002"})]); await h.load(true); h.failOpen=true;
  const before=bytes(h.local); h.cards()[0].querySelector(".note-play").click(); await settle();
  const content=h.doc.getElementById("notesPanel").textContent;
  assert.match(content,/没能打开这个视频|标签页.*失败|无法打开/); assert.match(content,/Frozen context before/);
  assert.doesNotMatch(content,/已删除|无权限/); assert.equal(h.providerCalls.length,0); assertReadOnly(h,before);
});
