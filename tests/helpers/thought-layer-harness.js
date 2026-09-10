// Offline integration harness. Loads the production scripts unchanged; only
// browser APIs, time and network responses are substituted. No live user data.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const decode = (s) => String(s).replace(/&(?:amp|lt|gt|quot|#39);/g,
  (x) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[x]);
const escape = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc;
    this.children = []; this.attributes = {}; this.dataset = {}; this.style = {};
    this.listeners = {}; this.value = ""; this.hidden = false; this.disabled = false;
    this.classList = {
      contains: (s) => this.className.split(/\s+/).includes(s),
      add: (...ss) => { this.className = [...new Set([...this.className.split(/\s+/), ...ss])].filter(Boolean).join(" "); },
      remove: (...ss) => { this.className = this.className.split(/\s+/).filter(s => !ss.includes(s)).join(" "); },
      toggle: (s, force) => { const enabled = force ?? !this.classList.contains(s); this.classList[enabled ? "add" : "remove"](s); return enabled; },
    };
  }
  get id() { return this.attributes.id || ""; }
  set id(v) { this.attributes.id = String(v); }
  get className() { return this.attributes.class || ""; }
  set className(v) { this.attributes.class = String(v); }
  get isConnected() { return this === this.ownerDocument || !!this.parentElement?.isConnected; }
  get isContentEditable() { return this.attributes.contenteditable === "true"; }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this.tagName === "#TEXT" ? this.text : this.children.map(x => x.textContent).join(""); }
  set textContent(v) { this.replaceChildren(); if (v !== "") { const n = new Element("#text", this.ownerDocument); n.text = String(v ?? ""); this.appendChild(n); } }
  get innerHTML() { return this.children.map(x => x.tagName === "#TEXT" ? escape(x.text) : `<${x.tagName.toLowerCase()} ${Object.entries(x.attributes).map(([k,v]) => `${k}="${escape(v)}"`).join(" ")}>${x.innerHTML}</${x.tagName.toLowerCase()}>`).join(""); }
  set innerHTML(html) {
    this.replaceChildren(); const stack = [this];
    for (const token of String(html).match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith("<!")) continue;
      if (token.startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
      if (!token.startsWith("<")) { const n = new Element("#text", this.ownerDocument); n.text = decode(token); stack.at(-1).appendChild(n); continue; }
      const tag = token.match(/^<([\w:-]+)/)?.[1]; if (!tag) continue;
      const n = new Element(tag, this.ownerDocument);
      const attrs = token.slice(tag.length + 1).replace(/\/?\s*>$/, "");
      for (const m of attrs.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) n.setAttribute(m[1], decode(m[2] ?? m[3] ?? m[4] ?? ""));
      stack.at(-1).appendChild(n);
      if (!/^(input|img|br|hr|meta|link|source|wbr)$/i.test(tag) && !token.endsWith("/>")) stack.push(n);
    }
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k.startsWith("data-")) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, x) => x.toUpperCase())] = String(v);
    if (k === "hidden" || k === "disabled") this[k] = true;
    if (k === "value") this.value = String(v);
  }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; if (k === "hidden" || k === "disabled") this[k] = false; }
  appendChild(n) { n.remove(); this.children.push(n); n.parentElement = this; return n; }
  append(...ns) { ns.forEach(n => this.appendChild(n)); }
  replaceChildren(...ns) { this.children.forEach(n => { n.parentElement = null; }); this.children = []; this.append(...ns); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null; }
  contains(n) { return n === this || this.children.some(x => x.contains(n)); }
  matches(selector) {
    return selector.split(",").some(part => {
      const parts = part.trim().split(/\s+/); const leaf = parts.pop();
      const attrs = [...leaf.matchAll(/\[([^=\]]+)(?:=["']?([^\]"']*)["']?)?\]/g)];
      if (attrs.some(([,k,v]) => this.getAttribute(k) === null || (v !== undefined && this.getAttribute(k) !== v))) return false;
      const simple = leaf.replace(/\[[^\]]+\]/g, "");
      const tag = simple.match(/^[\w-]+/)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      if ([...simple.matchAll(/([.#])([\w-]+)/g)].some(([,type,name]) => type === "#" ? this.id !== name : !this.classList.contains(name))) return false;
      if (!parts.length) return true;
      let p = this.parentElement; while (p) { if (p.matches(parts.join(" "))) return true; p = p.parentElement; } return false;
    });
  }
  querySelectorAll(s) { return this.children.flatMap(n => [...(n.tagName !== "#TEXT" && n.matches(s) ? [n] : []), ...n.querySelectorAll(s)]); }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  closest(s) { return this.matches(s) ? this : this.parentElement?.closest(s) || null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  dispatchEvent(event) {
    event.target ||= this; event.currentTarget = this;
    event.preventDefault ||= () => { event.defaultPrevented = true; };
    event.stopPropagation ||= () => { event.stopped = true; };
    for (const fn of this.listeners[event.type] || []) fn(event);
    if (event.bubbles !== false && !event.stopped) this.parentElement?.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: "click" }); }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { width: 500, height: 300, top: 0, bottom: 300 }; }
  scrollIntoView() {}
}
function documentFor(html = "") {
  const doc = new Element("document", null); doc.ownerDocument = doc;
  doc.createElement = tag => new Element(tag, doc);
  doc.createElementNS = (_, tag) => doc.createElement(tag);
  doc.createDocumentFragment = () => doc.createElement("fragment");
  doc.getElementById = id => doc.querySelector(`#${id}`);
  doc.head = doc.appendChild(doc.createElement("head"));
  doc.body = doc.appendChild(doc.createElement("body")); doc.body.innerHTML = html;
  doc.activeElement = doc.body; doc.readyState = "loading"; doc.scripts = [];
  return doc;
}
function clock() {
  let now = 0, serial = 0; const timers = new Map();
  return {
    setTimeout(fn, ms = 0) { const id = ++serial; timers.set(id, {fn, at: now + ms}); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return ++serial; }, clearInterval() {},
    async advance(ms) {
      const end = now + ms;
      for (let i = 0; i < 500; i++) {
        const next = [...timers].filter(([,v]) => v.at <= end).sort((a,b) => a[1].at-b[1].at)[0];
        if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].fn(); await settle();
      }
      now = end; await settle();
    },
  };
}
function memory(initial = {}) {
  let values = clone(initial); const writes = [];
  return {
    writes, snapshot: () => clone(values), setAccessLevel: async () => {},
    async get(keys) {
      if (keys == null) return clone(values);
      const defaults = typeof keys === "object" && !Array.isArray(keys) ? clone(keys) : {};
      const selected = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
      for (const k of selected) if (Object.hasOwn(values,k)) defaults[k] = clone(values[k]);
      return defaults;
    },
    async set(items) { writes.push({ type: "set", keys: Object.keys(items) }); Object.assign(values, clone(items)); },
    async remove(keys) { keys = [].concat(keys); writes.push({ type: "remove", keys }); keys.forEach(k => delete values[k]); },
    async clear() { writes.push({ type: "clear", keys: Object.keys(values) }); values = {}; },
  };
}
function note(id, overrides = {}) {
  const videoId = overrides.videoId || "video_00001";
  return {
    id, videoId, mediaKey: videoId, platform: "youtube", bvid: "", cid: null, page: null,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    timestampedUrl: `https://www.youtube.com/watch?v=${videoId}&t=30s`, timestamp: "0:30", timestampSeconds: 30,
    videoTitle: "Test video", channelName: "Test channel", text: "Source quote", rawText: "Source quote",
    sourceLanguage: "en", textLanguage: "en", translatedText: "", translatedValidated: false,
    translatedValidationVersion: 0, translatedUnchanged: false,
    createdAt: new Date(2026, 8, 8, 12).getTime(), thought: "", thoughtAt: null,
    triggerWindow: [{ t: 28, text: "Frozen context before" }, { t: 30, text: "Source quote" }], ...overrides,
  };
}
function library(notes) {
  const data = { ytd_notes_schema: 1, ytd_note_index: [] };
  for (const n of notes) {
    (data[`ytd_notes_${n.mediaKey}`] ||= []).push(n);
    data.ytd_note_index.push({ id:n.id, mediaKey:n.mediaKey, platform:n.platform, videoTitle:n.videoTitle,
      channelName:n.channelName, timestampSeconds:n.timestampSeconds, savedAt:n.createdAt,
      hasThought:!!n.thought, searchText:[n.thought,n.rawText,n.videoTitle,n.channelName].filter(Boolean).join(" ").normalize("NFKC").trim().replace(/\s+/g," ") });
  }
  return data;
}
const noteKey = k => k === "ytd_note_index" || k === "ytd_notes" || k.startsWith("ytd_notes_");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k,canonical(value[k])])) : value;
}
const bytes = storage => Buffer.from(JSON.stringify(canonical(Object.fromEntries(Object.entries(storage.snapshot()).filter(([k]) => noteKey(k))))));
const noteWrites = storage => storage.writes.filter(w => w.type === "clear" || w.keys.some(noteKey));

async function harness(notes = [], { configured = false, platform = "youtube" } = {}) {
  const currentUrl = new URL(platform === "bilibili"
    ? "https://www.bilibili.com/video/BV1e3411j7ZM/"
    : "https://www.youtube.com/watch?v=video_00001");
  const transcript = [{start:30,duration:10,text:"Source quote",language:"en"}];
  const local = memory({ ...library(notes), ytd_settings: { provider:"deepseek", aiApiKeys:{ deepseek: configured ? "offline-fixture" : "" } },
    digest_video_00001: { transcriptSource:"youtube-passive", transcriptSourcePolicyVersion:5,
      transcript },
    ...(platform === "bilibili" ? Object.fromEntries([123,124].map(cid=>[
      `digest_bilibili:BV1e3411j7ZM:${cid}`, {transcriptSource:"bilibili",transcriptSourcePolicyVersion:5,transcript},
    ])) : {}) });
  const session = memory(); const messages = [], notifications = [], requests = [], providerCalls = [], navigation = [];
  const listeners = []; const ignored = {addListener() {}}; const time = clock();
  const createdTabs = new Map(); let nextCreatedTabId = 2;
  const h = {local, session, messages, requests, providerCalls, navigation, time, url:currentUrl, mediaRequests:[],
    aiReply: JSON.stringify([]), failOpen:false, providerGate:null};
  const globals = {
    console, URL, URLSearchParams, TextDecoder, TextEncoder, AbortController, Blob, Response,
    setTimeout, clearTimeout, setInterval:()=>0, clearInterval(){}, importScripts(){},
    YTD_SETTINGS: require(path.join(root,"settings.js")), YTD_AI_PROVIDERS: require(path.join(root,"ai-providers.js")),
    YTD_NOTES_BACKUP: require(path.join(root,"notes-backup.js")), YTD_NOTE_EXPORT: require(path.join(root,"note-export.js")),
    YTD_NOTE_SOURCES: require(path.join(root,"note-sources.js")), YTD_EXPORT_JOBS: require(path.join(root,"export-jobs.js")),
    BILIBILI_ADAPTER: require(path.join(root,"bilibili.js")),
    async fetch(url, options = {}) {
      if (String(url).startsWith("chrome-extension://")) return new Response(read(String(url).split("/test/")[1]));
      requests.push({url:String(url), body:options.body});
      if (h.providerGate) await h.providerGate;
      return new Response(JSON.stringify({choices:[{message:{content:h.aiReply},finish_reason:"stop"}]}));
    },
  };
  if (platform === "bilibili") {
    // Run the real Bilibili adapter; replace only its remote metadata response.
    Object.assign(globals, {BILIBILI_ADAPTER: {
      ...globals.BILIBILI_ADAPTER,
      ...globals.BILIBILI_ADAPTER.createAdapter({fetchImpl:async url=>{
        const parsed=new URL(url); h.mediaRequests.push(parsed.href);
        assert.equal(parsed.pathname,"/x/web-interface/view","字幕已缓存，不允许偷偷获取新字幕");
        return new Response(JSON.stringify({code:0,data:{bvid:parsed.searchParams.get("bvid"),aid:1,
          title:"Test video",owner:{name:"Test channel"},duration:200,
          pages:[{cid:123,page:1,duration:200,part:"Part 1"},{cid:124,page:2,duration:200,part:"Part 2"}],
        }}));
      }}),
    }});
  }
  const chrome = {
    storage: { local, session, onChanged:ignored },
    runtime:{ id:"test", onInstalled:ignored, onMessage:{addListener:fn=>listeners.push(fn)},
      getURL:p=>`chrome-extension://test/${p}`, getManifest:()=>({version:"2.0.0"}),
      sendMessage:async m=>{ notifications.push(clone(m)); return {success:true}; } },
    action:{onClicked:ignored}, sidePanel:{setPanelBehavior(){},setOptions:async()=>{},open:async()=>{}},
    tabs:{ onUpdated:ignored,onActivated:ignored,
      get:async id=>id === 1 ? {id,url:currentUrl.href} : createdTabs.get(id),
      query:async()=>[{id:1,url:currentUrl.href}],
      create:async options=>{ if(h.failOpen) throw new Error("fixture open failure"); navigation.push({type:"create",...options}); const tab={id:nextCreatedTabId++,...options}; createdTabs.set(tab.id,tab); return tab; },
      update:async(id, options)=>{ navigation.push({type:"activate",id,...options}); return {id,...options}; }, remove:async()=>{},
      sendMessage:async(id, payload)=>{ navigation.push({type:"content",id,payload}); return {success:true}; } },
    windows:{getCurrent:async()=>({id:1})}, scripting:{executeScript:async()=>[]},
  };
  h.worker = vm.createContext({...globals, chrome, providerCalls});
  h.runWorker = code => vm.runInContext(code, h.worker);
  // Objects created by the worker must be validated in the same VM realm,
  // just as importScripts runs these helpers in one service worker in Chrome.
  for (const file of ["notes-backup.js", "note-sources.js", "export-jobs.js"]) h.runWorker(read(file));
  h.runWorker(read("background.js"));
  // Spy the shared provider boundary AND its HTTP transport. Do not mock the
  // search handler or translateNotes; both execute in the real worker.
  h.runWorker("const phase2OriginalCompletion = requestAiCompletion; requestAiCompletion = async function(options) { providerCalls.push(options); return phase2OriginalCompletion(options); };");
  h.api = h.worker.__YTD_TRANSLATION_TESTING__;
  h.send = async (m) => {
    messages.push(clone(m));
    return new Promise((resolve,reject) => {
      let asyncResponse = false, answered = false;
      for (const fn of listeners) { try { asyncResponse = fn(m,{tab:{id:1,url:currentUrl.href}}, r=>{answered=true;resolve(r);}) === true || asyncResponse; } catch(e) { reject(e); } }
      if (!asyncResponse && !answered) resolve({success:false,error:`UNHANDLED_ACTION:${m.action}`});
    });
  };
  const doc = documentFor(read("sidepanel.html")); h.doc = doc;
  const window = {addEventListener(){},getSelection:()=>null,close(){},location:currentUrl,getComputedStyle:()=>({display:"block",visibility:"visible"})};
  h.panel = vm.createContext({...globals, ...time, document:doc, window, navigator:{clipboard:{writeText:async()=>{}}},
    IntersectionObserver:class{observe(){}}, CSS:{escape:s=>s}, chrome:{...chrome,runtime:{...chrome.runtime,onMessage:ignored,sendMessage:h.send}}});
  h.run = code => vm.runInContext(code,h.panel);
  h.run(read("sidepanel.js"));
  h.panel.fenceId = h.runWorker("runtimeInstanceId");
  h.run(`currentVideoId = 'video_00001'; videoTabId = 1; currentRouteKey = 'youtube:video_00001';
    extensionDataRuntimeInstanceId = fenceId; currentConfigStatus = {hasAiKey:${configured}}; setupEventListeners();`);
  h.load = async(showAll=false, translateMissing=false) => { await h.run(`loadNotes(${showAll ? "null" : "currentVideoId"}, {translateMissing:${translateMissing}})`); await settle(); };
  h.input = async value => {
    const input = doc.querySelector('input[type="search"]');
    assert.ok(input,"T5–T8: 笔记页尚缺搜索框"); input.value=value; input.dispatchEvent({type:"input"}); await time.advance(400);
  };
  h.cards = () => doc.querySelectorAll("#notesList .note-item");
  h.aiButton = () => doc.querySelectorAll("button").find(x=>x.textContent.trim()==="让 AI 找找" && !x.hidden);
  h.allNotes = async () => clone(await h.api.readAllNotes());
  h.resetEvidence = () => { local.writes.length=0; providerCalls.length=0; requests.length=0; messages.length=0; };
  h.contentDoc = documentFor(platform === "bilibili"
    ? '<h1 class="video-title">Test video</h1><div id="bilibili-player"><video></video></div>'
    : '<h1 class="ytd-watch-metadata">Test video</h1><video class="html5-main-video"></video>');
  h.video = h.contentDoc.querySelector("video"); Object.assign(h.video,{currentTime:36,duration:200,paused:false,pauseCalls:0,playCalls:0,
    pause(){this.paused=true;this.pauseCalls++;},play(){this.paused=false;this.playCalls++;}});
  h.content = vm.createContext({...globals,...time,document:h.contentDoc,window,
    navigator:{clipboard:{writeText:async()=>{}}},MutationObserver:class{observe(){}},
    chrome:{runtime:{...chrome.runtime,onMessage:ignored,sendMessage:h.send}}});
  vm.runInContext(read(platform === "bilibili" ? "content-bilibili.js" : "content.js"),h.content);
  h.contentDoc.dispatchEvent({type:"DOMContentLoaded",bubbles:false});
  h.press = async (key, extra={}) => { h.contentDoc.activeElement.dispatchEvent({type:"keydown",key,...extra}); await settle(); };
  h.toast = () => h.contentDoc.getElementById(`digestdock-test-${platform}-note-toast`);
  await settle(); h.resetEvidence(); return h;
}
module.exports = {harness,note,settle,bytes,noteWrites,clone,read,documentFor};
