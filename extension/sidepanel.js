import { SOURCES, buildSources } from "./sources.js";
import { redact, diff, putSnapshot, previousSnapshot, trimForAi, shape } from "./lib.js";
import { findServices, referenceTitles, matchService, candidates, localPlan, learnKey } from "./catalog.js";
import { SERVICE_URL } from "./config.js";
import { makeZip, dataUrlBytes } from "./zip.js";
import { icon, spinner } from "./icons.js";
import { SUGGESTIONS, FETCH_ITEMS, PRIVACY_POINTS, DOC_STATUS } from "./constants.js";
import { requestKey, isDocRequest } from "./text.js";

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Локал огноо (toISOString() нь UTC тул Монголд 00:00–08:00 хооронд өчигдрийн огноо гарна)
const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const EM_HOME = "https://e-mongolia.mn/home";

function timeAgo(iso, now = Date.now()) {
  const sec = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (sec < 60) return "дөнгөж сая";
  if (sec < 3600) return `${Math.floor(sec / 60)} минутын өмнө`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} цагийн өмнө`;
  return `${Math.floor(sec / 86400)} өдрийн өмнө`;
}

// --- Тогтмол текстүүд (бусад нь constants.js-д) -----------------------------------
const SOURCE_ICON = {
  health: "health", social: "social", invoice: "receipt", loan: "loan", vehicles: "car", penalty: "alert",
  inspection: "wrench", mandatory: "shield", idcard: "id", passport: "book", marriage: "id", property: "property",
};

// Өмнөх хувилбаруудын тохиргоо (хэрэглэгчийн Gemini/Claude key, Worker URL гэх мэт) хэрэггүй болсон тул устгана
await chrome.storage.local.remove(["provider", "geminiKey", "apiKey", "worker", "appToken", "onRepeat"]);

// --- Төлөв ------------------------------------------------------------------------
// Side panel хаагдахад тасарсан «татаж байна», «жагсаалт гаргаж байна» төлөвийг буцаана
const restore = plan => {
  if (plan?.em) { plan.running = false; plan.regenerating = false; plan.em.forEach(d => { if (d.state === "run") d.state = "idle"; }); }
  if (plan?.loading) { delete plan.loading; plan.error = "Жагсаалт гаргаж байх үед side panel хаагдсан. Дахин асууна уу."; }
  return plan;
};
const saved = await chrome.storage.local.get(["last", "chat", "listPlan", "tab", "docRef"]);
let state = saved.last || null; // { snap, prevTakenAt, changes, summary }
// [{ role: "user" | "assistant", text, links?, plan? }] — энэ компьютерт хадгална, шинээр «Шинжлэх» дарахад цэвэрлэнэ
let chat = (saved.chat || []).map(m => (restore(m.plan), m));
// «Жагсаалтаар бүрдүүлэх»-ийн жагсаалт (chat-ийн plan-тай ижил хэлбэртэй, source: "list")
let listPlan = restore(saved.listPlan || null);

const ui = {
  // «Тойм» (хураангуй, chat) ба «Бичиг баримт» (жагсаалт, цуглуулах). Сүүлд нээснийг санана (өмнөх хувилбарын "list" → documents).
  tab: ["documents", "list"].includes(saved.tab) ? "documents" : "overview",
  docRef: saved.docRef ?? null, // «Бичиг баримт» табд харагдах жагсаалт: chat-ийн мессежийн дугаар эсвэл "list"
  analyzing: false,
  asking: false,
  parsing: false,
  status: null,      // { text, cls } — шинжлэх явц, алдаа
  needsLogin: false, // «e-Mongolia нээх» товч харуулах
  listStatus: null,  // { text, cls } — жагсаалт задлах явц, алдаа
  listForm: false,   // жагсаалт байхад «Жагсаалтаар бүрдүүлэх» маягтыг нээсэн эсэх
  started: false,    // анх нээх дэлгэцээс «Жагсаалтаар бүрдүүлэх» дарсан
  menu: null,        // "overview" | "doc"
  open: new Set(),   // нээлттэй <details> (дахин зурахад хадгална)
};

// --- AI сервис ----------------------------------------------------------------------
// AI ихэвчлэн 10–40 секундэд хариулна. Үүнээс удвал хүлээлгэхгүй, алдаа гаргаж дахин оролдуулна.
const SERVICE_TIMEOUT = 60_000;

async function service(path, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SERVICE_TIMEOUT);
  try {
    const r = await fetch(SERVICE_URL + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: ctrl.signal });
    if (!r.ok) throw new Error(await r.text());
    return await r.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`AI сервис ${SERVICE_TIMEOUT / 1000} секундэд хариу өгсөнгүй. Дахин оролдоно уу.`, { cause: e });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Ижил хүсэлтэд үргэлж ижил жагсаалт: AI-ийн /plan, /parse хариуг энэ компьютерт 30 хоног хадгална.
// «Шинээр гаргах» (fresh) дарвал AI-аас дахин авч хадгалсныг солино.
const PLAN_TTL = 30 * 24 * 3600 * 1000;
async function cachedService(key, path, payload, fresh = false) {
  const { planCache = {} } = await chrome.storage.local.get("planCache");
  const hit = planCache[key];
  if (!fresh && hit && Date.now() - hit.at < PLAN_TTL) return hit.data;
  const data = await service(path, payload);
  planCache[key] = { at: Date.now(), data };
  for (const k of Object.keys(planCache).sort((a, b) => planCache[b].at - planCache[a].at).slice(50)) delete planCache[k];
  await chrome.storage.local.set({ planCache });
  return data;
}

// --- «Шинжлэх»: мэдээлэл татах → нууцалж хадгалах → AI хураангуй -------------------------
const setStatus = (text, cls = "muted") => { ui.status = text ? { text, cls } : null; render(); };

// e-Mongolia-оос мэдээлэл татах явц (content.js-ээс)
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === "PROGRESS" && ui.analyzing) setStatus(`e-Mongolia-оос мэдээлэл татаж байна… (${msg.done + 1}/${msg.total}) ${msg.name}`);
});

async function runAnalyze() {
  if (ui.analyzing) return;
  ui.analyzing = true;
  ui.needsLogin = false;
  ui.menu = null;
  setStatus("e-Mongolia-оос мэдээлэл татаж байна…");
  try {
    const [tab] = await chrome.tabs.query({ url: "https://e-mongolia.mn/*" });
    if (!tab) { ui.needsLogin = true; throw new Error("e-Mongolia нээлттэй алга. «e-Mongolia нээх» дарж нэвтрээд дахин «Шинжлэх» дарна уу."); }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const res = await chrome.tabs.sendMessage(tab.id, { type: "COLLECT", sources: buildSources() });
    if (res?.error === "NOT_LOGGED_IN") { ui.needsLogin = true; throw new Error("e-Mongolia-д нэвтрээгүй байна (эсвэл session дууссан). Нэвтрээд дахин «Шинжлэх» дарна уу."); }

    const snap = { takenAt: new Date().toISOString(), data: {}, status: {} };
    for (const s of SOURCES) {
      const r = res.results[s.id];
      snap.status[s.id] = r.ok ? { ok: true, note: r.note } : { ok: false, error: r.error };
      if (r.ok) snap.data[s.id] = redact(r.data); // хувийн танигдах мэдээллийг хадгалахаас өмнө хасна
    }
    if (!Object.keys(snap.data).length) throw new Error("Мэдээлэл татагдсангүй. e-Mongolia-д нэвтэрсэн эсэхээ шалгана уу.");

    // Сар бүрийн агшинг хадгална: дараа сараас өмнөх сартай харьцуулсан өөрчлөлтийг AI хураангуйд оруулна
    const { snapshots = {} } = await chrome.storage.local.get("snapshots");
    const all = putSnapshot(snapshots, snap);
    const prev = previousSnapshot(all, snap);
    state = { snap, prevTakenAt: prev?.takenAt || null, changes: prev ? diff(prev, snap, SOURCES) : null, summary: null };
    chat = [];
    ui.tab = "overview";
    await chrome.storage.local.set({ snapshots: all, last: state });

    setStatus("AI хураангуйлж байна… (10–40 секунд)");
    state.summary = { ...(await service("/summarize", aiPayload())), at: new Date().toISOString() };
    await chrome.storage.local.set({ last: state });
    ui.status = null;
    toast("Шинжилгээ бэлэн боллоо");
  } catch (e) {
    ui.status = { text: e.message, cls: "err" };
  }
  ui.analyzing = false;
  render();
}

// AI руу илгээх мэдээлэл (нууцалсан): эх сурвалж бүрийн өгөгдөл, татагдаагүй эх сурвалжууд, өмнөх сартай харьцуулсан ялгаа
function aiPayload() {
  const s = state.snap;
  return {
    today: today(),
    previousSnapshotDate: state.prevTakenAt?.slice(0, 10) || null,
    sources: SOURCES.filter(x => x.id in s.data).map(x => ({ name: x.name, data: trimForAi(s.data[x.id]) ?? s.status[x.id]?.note ?? null })),
    unavailable: SOURCES.filter(x => !(x.id in s.data)).map(x => x.name),
    changesSincePreviousMonth: state.changes ? state.changes.slice(0, 80) : null,
  };
}

// «Дахин эхлүүлэх»: хураангуй, асуулт хариулт, chat-ийн жагсаалтуудыг цэвэрлэнэ.
// Сар бүрийн агшинг (snapshots) үлдээнэ — дараа сард өөрчлөлтийг харьцуулахад хэрэгтэй, интерфэйсэд харагддаггүй.
async function resetInfo() {
  ui.menu = null;
  if (!confirm("Хураангуй, асуулт хариулт, бичиг баримтын жагсаалтыг цэвэрлээд шинээр эхлэх үү?")) return render();
  state = null;
  chat = [];
  Object.assign(ui, { status: null, needsLogin: false, tab: "overview" });
  await chrome.storage.local.remove(["last", "chat"]);
  $("askInput").value = "";
  render();
}

// --- Chatbot: татсан мэдээлэл + хураангуй + асуултад тохирох e-Mongolia үйлчилгээнүүдийг илгээнэ ---
async function ask(question) {
  question = question.trim();
  if (!question || !state?.snap || ui.asking) return;
  $("askInput").value = "";
  chat.push({ role: "user", text: question });
  chat.push({ role: "assistant", text: "…", pending: true });
  ui.asking = true;
  render();
  scrollToBottom();
  try {
    if (isDocRequest(question)) {
      // Тогтмол хэлбэр: гарчиг → e-Mongolia-оос цуглуулах → «Цуглуулах» → өөрөө бэлдэх
      const msg = { role: "assistant", text: "Бичиг баримтын жагсаалтыг бэлдлээ. e-Mongolia-оос авах лавлагаануудыг «Цуглуулах» дарж нэг ZIP болгон татна.", links: [], plan: { loading: true } };
      chat[chat.length - 1] = msg;
      render();
      await makePlan(msg, question.slice(0, 300), question);
    } else {
      const services = await findServices(question);
      const { sources, unavailable } = aiPayload();
      const r = await service("/chat", {
        today: today(),
        question,
        history: chat.filter(m => !m.pending).slice(-7, -1).map(({ role, text }) => ({ role, text })),
        data: { sources, unavailable },
        summary: state.summary ? { headline: state.summary.headline, alerts: state.summary.alerts } : null,
        services: services.map(s => s.title),
      });
      // AI зөвхөн бидний өгсөн нэрсээс сонгоно; холбоосыг энд (AI биш) үүсгэнэ
      const links = (r.services || []).map(t => services.find(s => s.title === t)).filter(Boolean);
      const msg = { role: "assistant", text: r.answer, links };
      chat[chat.length - 1] = msg;
      if (r.intent === "documents" && r.purpose) { msg.plan = { loading: true }; render(); await makePlan(msg, r.purpose, question); }
    }
  } catch (e) {
    chat[chat.length - 1] = { role: "assistant", text: "Алдаа: " + e.message, error: true, retry: question };
  }
  ui.asking = false;
  render();
  scrollToBottom();
}

// --- Бичиг баримт бүрдүүлэх ---------------------------------------------------
// Хоёр замаар жагсаалт гарна: chat-д зорилгоо бичих (/plan) эсвэл «Жагсаалтаар бүрдүүлэх»-д байгууллагын жагсаалтаа оруулах (/parse).
// Аль алинд нь e-Mongolia-оос авах зүйлсийг каталогтой тааруулж, «Цуглуулах» дарахад PDF-ээр татаад нэг ZIP болгоно.
async function makePlan(msg, purpose, question, fresh = false) {
  try {
    const payload = { today: today(), purpose, question, emongoliaServices: await referenceTitles() };
    const p = await cachedService("plan:" + requestKey(question), "/plan", payload, fresh);
    msg.plan = { ...(await buildPlan({ ...p, title: p.title || purpose })), purpose, question, at: Date.now() };
    const i = chat.indexOf(msg);
    if (i >= 0) ui.docRef = String(i); // шинэ жагсаалтыг «Бичиг баримт» табд харуулна
  } catch (e) {
    msg.plan = { error: "Жагсаалт гаргаж чадсангүй: " + e.message };
  }
  render();
}

// AI-ийн (эсвэл түлхүүр үгийн) мөрүүдийг e-Mongolia-ийн бодит үйлчилгээтэй тааруулна:
// хэрэглэгчийн өмнөх сонголт → яг ижил нэр / итгэлтэй таарсан → эргэлзээтэй бол сонгуулна (CHOOSE) → олдоогүй бол өөрөө бэлдэнэ
async function buildPlan(p) {
  const { learned = {} } = await chrome.storage.local.get("learned");
  const em = [], self = [];
  for (const it of p.items || []) {
    if (it.source !== "emongolia") { self.push({ label: it.label, note: it.note || "", done: false }); continue; }
    const query = it.service || it.label;
    let match = learned[learnKey(it.label)] || await matchService(query), replaced = null;
    // «Шинжлэх»-ээр гэрлэлтийн бүртгэл олдоогүй (resultCode 1) бол «Гэрлэсний бүртгэлгүй лавлагаа»-г шууд сонгоно —
    // эхлээд оролдож бүтэлгүйтээд шилжихээс хурдан
    const alt = match && notMarried() && ALTERNATIVES.find(([re]) => re.test(match.title));
    if (alt) { const m = await matchService(alt[1](match.title)); if (m) { replaced = match.title; match = m; } }
    if (match && em.some(d => d.match?.path === match.path)) continue; // давхардсан
    const d = { label: it.label, query, match, years: it.years || 0, subject: it.subject || "self", state: match ? "idle" : "CHOOSE", skip: false, ...(replaced && { replaced }) };
    if (!match) d.candidates = await candidates({ query, label: it.label });
    if (match || d.candidates.length) em.push(d);
    else self.push({ label: it.label, note: it.note || "e-Mongolia-оос олдсонгүй — өөрөө авна", done: false });
  }
  return {
    title: p.title, folder: p.title, addressee: p.addressee || "", em, self, tips: p.tips || [], warnings: documentWarnings(p),
    language: LANGUAGES.includes(p.language) ? p.language : "англи", addresseeForeign: p.addresseeForeign || "",
  };
}

// --- Бичиг баримтын хугацааны урьдчилсан анхааруулга -----------------------------------
// «Шинжлэх»-ээр татсан (нууцалсан) паспорт, иргэний үнэмлэхийн дуусах огноог шалгана. Зөвхөн кодоор, AI-гүй.
//   паспорт:  WS100110 → listData[].expiryDateAsText     иргэний үнэмлэх: WS100101 → passportExpireDate
const parseDate = v => { const m = String(v ?? "").match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/); return m ? new Date(+m[1], m[2] - 1, +m[3]) : null; };
const localDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysUntil = d => Math.round((d - localDay()) / 86400000);
const ymd = d => today(d);
function findDate(obj, re) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === "object") { const r = findDate(v, re); if (r) return r; }
    else if (re.test(k) && parseDate(v)) return parseDate(v);
  }
  return null;
}
// «Шинжлэх»-ийн гэрлэлтийн мэдээлэл: амжилттай ирсэн боловч бүртгэл олдоогүй (note = «…олдсонгүй»)
const notMarried = () => { const st = state?.snap?.status?.marriage; return !!(st?.ok && st.note); };

function documentWarnings(p) {
  const data = state?.snap?.data;
  const text = [p.title, ...(p.items || []).map(i => i.label + " " + (i.service || ""))].join(" ").toLowerCase();
  if (!data) return /виз|паспорт/.test(text) ? [{ level: "info", text: "«Миний мэдээлэл» табд «Шинжлэх» дарвал паспорт, иргэний үнэмлэхийн хугацааг урьдчилан шалгаж анхааруулна." }] : [];
  const out = [], fmt = ymd;
  const pass = findDate(data.passport, /expir/i);
  if (pass && /виз|паспорт|гадаад/.test(text)) {
    const n = daysUntil(pass);
    if (n < 0) out.push({ level: "urgent", text: `Гадаад паспортын хугацаа ${fmt(pass)}-нд дууссан. Визэд хүчинтэй паспорт заавал хэрэгтэй тул эхлээд шинээр авна уу.` });
    else if (n < 183) out.push({ level: "warning", text: `Гадаад паспорт ${fmt(pass)}-нд дуусна (${n} хоног үлдсэн). Ихэнх улс визэд 6 сараас дээш хугацаатай паспорт шаарддаг тул эхлээд сунгана уу.` });
  }
  const id = findDate(data.idcard, /expire/i);
  if (id) {
    const n = daysUntil(id);
    if (n < 0) out.push({ level: "urgent", text: `Иргэний үнэмлэхийн хугацаа ${fmt(id)}-нд дууссан. Ихэнх байгууллага хүчинтэй үнэмлэх шаарддаг тул эхлээд шинээр авна уу.` });
    else if (n < 60) out.push({ level: "warning", text: `Иргэний үнэмлэх ${fmt(id)}-нд дуусна (${n} хоног үлдсэн).` });
  }
  return out;
}

// Гадаад хэлээр лавлагааны «Хэл сонгох» талбарт сонгох хэл. AI зорилгоос нь сонгоно, хэрэглэгч жагсаалт дээрээс сольж болно.
const LANGUAGES = ["англи", "орос", "хятад", "япон", "солонгос", "герман", "франц"];
const isForeign = d => /гадаад хэл/i.test(d.match?.title || "");

// Хэрэглэгчийн сонголтыг санана: дараагийн удаа ижил мөрөнд автоматаар ашиглана
async function choose(d, c) {
  const { learned = {} } = await chrome.storage.local.get("learned");
  learned[learnKey(d.label)] = c;
  await chrome.storage.local.set({ learned });
  Object.assign(d, { match: c, state: "idle", choosing: false, url: null, detail: null });
}

// Бүртгэл байхгүй үед авах өөр лавлагаа (2026-10-08 туршилт: гэрлээгүй хүнд «Гэрлэсний бүртгэлийн лавлагаа» гардаггүй)
const ALTERNATIVES = [[/гэрлэсний бүртгэлийн лавлагаа/i, t => t.replace(/бүртгэлийн/i, "бүртгэлгүй")]];

// Татсан PDF-үүд (зөвхөн санах ойд — side panel хаахад устна, ZIP багц Downloads-д үлдэнэ)
const pdfs = new WeakMap(); // d → data URL
const safe = s => String(s).replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "_").slice(0, 60);

// Жагсаалтууд: chat-д гарсан (ref = мессежийн дугаар) ба «Жагсаалтаар бүрдүүлэх»-ээс (ref = "list"), шинэ нь эхэндээ
const planOf = ref => (ref === "list" ? listPlan : chat[+ref]?.plan);
const isReady = p => !!p?.em && !p.loading && !p.error;
function plans() {
  const all = chat.map((m, i) => ({ ref: String(i), plan: m.plan }));
  if (listPlan) all.push({ ref: "list", plan: listPlan });
  return all.filter(x => isReady(x.plan)).sort((a, b) => (b.plan.at || 0) - (a.plan.at || 0));
}
const activeDoc = () => { const all = plans(); return all.find(x => x.ref === ui.docRef) || all[0] || null; };

// Бэлэн болсон тоо: e-Mongolia-оос (хасаагүй мөр) + өөрөө бэлдэх
function progress(plan) {
  const need = plan.em.filter(d => !d.skip);
  const emDone = need.filter(d => d.state === "done").length;
  const selfDone = plan.self.filter(x => x.done).length;
  return {
    ready: emDone + selfDone, total: need.length + plan.self.length, emDone, emNeed: need.length, selfDone,
    collectable: need.filter(d => d.match && d.state !== "done").length,
  };
}

async function collectOne(plan, d, i) {
  d.state = "run"; render();
  const item = { ...d.match, fill: { years: d.years, addressee: plan.addressee, addresseeForeign: plan.addresseeForeign, subject: d.subject, language: plan.language } };
  const r = await chrome.runtime.sendMessage({ type: "COLLECT_DOC", item, index: i, folder: plan.folder });
  Object.assign(d, { state: r?.ok ? "done" : r?.error || "алдаа", detail: r?.detail, downloadId: r?.downloadId, url: r?.url });
  if (r?.ok && r.dataUrl) pdfs.set(d, r.dataUrl);
  return r;
}

// Бүх PDF + жагсаалтыг нэг ZIP болгож нэг удаа татна: Downloads/Burduulelt/<зорилго>_<огноо>.zip
async function downloadBundle(plan) {
  const files = plan.em.map((d, i) => pdfs.has(d) && { name: `${String(i + 1).padStart(2, "0")}_${safe(d.match.title)}.pdf`, data: dataUrlBytes(pdfs.get(d)) }).filter(Boolean);
  if (!files.length) return;
  const date = today();
  files.push({ name: "Жагсаалт.txt", data: `Бэлдсэн: ${date}${plan.addressee ? `\nХаана өгөх: ${plan.addressee}` : ""}\n\n${planText(plan)}\n` });
  const url = URL.createObjectURL(makeZip(files));
  const name = `${safe(plan.folder)}_${date}.zip`;
  const id = await chrome.downloads.download({ url, filename: `Burduulelt/${name}`, conflictAction: "uniquify", saveAs: false });
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  plan.bundle = { id, name, count: files.length - 1 };
  plan.bundleError = null;
  render();
}

function openPdf(d) {
  const url = URL.createObjectURL(new Blob([dataUrlBytes(pdfs.get(d))], { type: "application/pdf" }));
  chrome.tabs.create({ url });
}

// «Зогсоох» дарвал (plan.cancel) одоо татаж буй бичиг баримт дууссаны дараа зогсоно. Татсан PDF-үүдийг багцалсаар байна.
async function collectPlan(plan) {
  if (plan.running) return;
  plan.running = true; plan.cancel = false; render();
  for (const [i, d] of plan.em.entries()) {
    if (plan.cancel) break;
    if (d.state === "done" || d.skip || !d.match) continue;
    const r = await collectOne(plan, d, i);
    if (r?.error === "NOT_LOGGED_IN") break;
    const alt = r?.error === "NOT_REGISTERED" && !plan.cancel && ALTERNATIVES.find(([re]) => re.test(d.match.title));
    if (alt) {
      const m = await matchService(alt[1](d.match.title));
      if (m) { d.replaced = d.match.title; d.match = m; await collectOne(plan, d, i); }
    }
    render();
  }
  const stopped = plan.cancel;
  plan.running = false; plan.cancel = false;
  await downloadBundle(plan).catch(e => { plan.bundleError = "Багц үүсгэж чадсангүй: " + e.message; });
  if (stopped) toast("Цуглуулахыг зогсоолоо");
  render();
}

// Жагсаалтыг энгийн текстээр (хуулж бусдад илгээх, хэвлэхэд)
function planText(plan) {
  return [plan.title, "",
    "e-Mongolia-оос:", ...plan.em.filter(d => !d.skip).map(d => `${d.state === "done" ? "[x]" : "[ ]"} ${d.match?.title || d.label}`), "",
    "Өөрөө бэлдэх:", ...plan.self.map(x => `${x.done ? "[x]" : "[ ]"} ${x.label}${x.note ? " — " + x.note : ""}`),
    ...(plan.tips.length ? ["", "Зөвлөмж:", ...plan.tips.map(t => "• " + t)] : [])].join("\n");
}

const norm = s => String(s).toLowerCase().replace(/\s+/g, " ").trim();

// «Шинээр гаргах»: хадгалсан жагсаалтын оронд AI-аас шинээр гаргана
async function regenerate(ref) {
  const plan = planOf(ref);
  if (!plan || plan.running) return;
  if (!confirm("Шинээр гаргавал одоогийн тэмдэглэгээ арилна. Үргэлжлүүлэх үү?")) return;
  if (ref === "list") return parseList(true);
  const msg = chat[+ref];
  plan.regenerating = true; render();
  await makePlan(msg, plan.purpose, plan.question, true);
  // Шинээр гаргаж чадаагүй бол хуучин жагсаалт хэвээр үлдэнэ
  if (msg.plan.error) { toast(msg.plan.error); plan.regenerating = false; msg.plan = plan; render(); }
}

async function deleteList(ref) {
  const plan = planOf(ref);
  if (!plan || plan.running || !confirm(`«${plan.title}» жагсаалтыг устгах уу?`)) return;
  if (ref === "list") {
    listPlan = null;
    $("listText").value = "";
    $("listImg").value = "";
    showImgName();
    ui.listStatus = null;
  } else chat[+ref].plan = { error: "Жагсаалтыг устгасан." };
  ui.docRef = null;
  render();
  toast("Жагсаалт устгагдлаа");
}

// --- Жагсаалтаар бүрдүүлэх ----------------------------------------------------
// Байгууллагаас өгсөн жагсаалтыг (текст эсвэл зураг) AI задална → каталогтой тааруулна → «Цуглуулах» → ZIP
// fresh: «Шинээр гаргах» — ижил текстэд хадгалсан задлалтын оронд AI-аас дахин авна. Зургийн задлалтыг хадгалахгүй.
const setListStatus = (text, cls = "muted") => { ui.listStatus = text ? { text, cls } : null; render(); };

async function parseList(fresh = false) {
  const text = $("listText").value.trim(), img = $("listImg").files[0];
  if (!text && !img) return setListStatus("Жагсаалтаа бичих эсвэл зургаа сонгоно уу.", "warn");
  if (ui.parsing) return;
  ui.parsing = true;
  setListStatus(img ? "AI зургийг уншиж байна… (10–40 секунд)" : "AI жагсаалтыг задалж байна…");
  try {
    let p, note;
    try {
      const payload = { today: today(), text, ...(img && { image: await shrinkImage(img) }), emongoliaServices: await referenceTitles() };
      p = img ? await service("/parse", payload)
        : await cachedService("parse:" + text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(), "/parse", payload, fresh);
      note = `AI ${p.items.length} мөр олов.`;
    } catch (e) {
      // AI сервис ажиллахгүй бол (шинэчлэгдээгүй, хязгаарт хүрсэн…) түлхүүр үгээр задална. Зургийг AI-гүйгээр уншихгүй.
      if (!text) throw new Error(`Зургийг уншиж чадсангүй (${e.message}). Жагсаалтаа текстээр бичнэ үү.`, { cause: e });
      p = { title: "", addressee: "", tips: [], items: localPlan(text) };
      note = "AI ажиллахгүй байсан тул түлхүүр үгээр задлав.";
    }
    setListStatus(note + " e-Mongolia-тай тааруулж байна…");
    listPlan = { ...(await buildPlan({ ...p, title: p.title || "Бүрдүүлэх жагсаалт" })), source: "list", at: Date.now(), ...(!img && { text }) };
    ui.docRef = "list";
    ui.listForm = false;
    const unsure = listPlan.em.filter(d => !d.match).length;
    ui.listStatus = { text: note + (unsure ? ` ${unsure} мөрийг доороос сонгоно уу.` : ""), cls: unsure ? "warn" : "ok" };
  } catch (e) {
    ui.listStatus = { text: e.message, cls: "err" };
  }
  ui.parsing = false;
  render();
}

// Зургийг AI руу илгээхээс өмнө багасгана (сервис ~1.5MB-аас том хүсэлт хүлээж авахгүй)
async function shrinkImage(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const data = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(",")[1]); fr.readAsDataURL(blob); });
  return { media_type: "image/jpeg", data };
}

function showImgName() {
  const f = $("listImg").files[0];
  $("imgName").textContent = f ? f.name : "эсвэл жагсаалтын зургийг сонгох";
  $("listImg").closest(".file-pick").classList.toggle("has-file", !!f);
}

// --- Зурах --------------------------------------------------------------------------
function render() {
  const focusedId = document.activeElement?.id;
  const top = $("scroll").scrollTop;
  const main = !!state?.snap || plans().length > 0 || ui.tab === "documents" || ui.started;

  $("onboarding").hidden = main;
  $("main").hidden = !main;
  if (!main) renderOnboarding();
  else {
    renderTabs();
    if (ui.tab === "overview") renderOverview(); else renderDocuments();
    renderBadge();
    $("askSend").disabled = ui.asking;
  }

  $("scroll").scrollTop = top;
  if (focusedId) {
    const el = document.getElementById(focusedId);
    if (el && el !== document.activeElement) el.focus({ preventScroll: true });
  }
  save();
}

// Chat, жагсаалтыг энэ компьютерт хадгална (side panel хаагаад нээхэд алга болохгүй)
function save() {
  chrome.storage.local.set({ chat: chat.filter(m => !m.pending), listPlan, tab: ui.tab, docRef: ui.docRef }).catch(() => {});
}

// Явц, алдааны мөр. needsLogin бол «e-Mongolia нээх» товчтой.
function notice(st, needsLogin = false) {
  if (!st) return "";
  const ic = { err: icon("alert", 16), warn: icon("exclaim", 16, { sw: 2.5 }), ok: icon("check", 16, { sw: 3 }), info: icon("info", 16) }[st.cls] || spinner(16);
  return `<div class="notice notice--${esc(st.cls)}" role="status">${ic}<div class="notice__body"><span>${esc(st.text)}</span>${needsLogin
    ? `<button type="button" class="btn btn--ghost" data-action="open-em">e-Mongolia нээх ${icon("external", 14)}</button>` : ""}</div></div>`;
}
function setNotice(el, st, needsLogin) {
  el.hidden = !st;
  el.innerHTML = notice(st, needsLogin);
}

function pill(cls, label) {
  const ic = { ok: icon("check", 12, { sw: 3 }), overdue: icon("exclaim", 12, { sw: 2.5 }), attention: icon("exclaim", 12, { sw: 2.5 }), loading: spinner(12) }[cls] || "";
  return `<span class="pill pill--${cls}">${ic}${esc(label)}</span>`;
}

function renderOnboarding() {
  $("startBtn").disabled = ui.analyzing;
  $("startBtn").innerHTML = ui.analyzing ? `${spinner()} Шинжилж байна…` : "Шинжилж эхлэх";
  setNotice($("onbStatus"), ui.status, ui.needsLogin);
}

function renderTabs() {
  const onOverview = ui.tab === "overview";
  $("tab-overview").setAttribute("aria-selected", String(onOverview));
  $("tab-documents").setAttribute("aria-selected", String(!onOverview));
  $("tab-overview").tabIndex = onOverview ? 0 : -1;
  $("tab-documents").tabIndex = onOverview ? -1 : 0;
  $("view-overview").hidden = !onOverview;
  $("view-documents").hidden = onOverview;
  $("composer").hidden = !onOverview || !state?.snap;
}

function renderBadge() {
  const p = activeDoc() && progress(activeDoc().plan);
  const left = p ? p.total - p.ready : 0;
  $("docBadge").hidden = left <= 0;
  $("docBadge").textContent = String(left);
  $("docBadge").setAttribute("aria-label", `${left} бичиг баримт дутуу`);
}

// «Тойм»: хураангуй, анхааруулга, өөрчлөлт, хэвийн зүйлс, татсан мэдээлэл, асуулт
function renderOverview() {
  const snap = state?.snap, sm = state?.summary;
  if (!snap) {
    $("view-overview").innerHTML = `
      ${notice(ui.status, ui.needsLogin)}
      <div class="empty-state">
        <h2 class="section-title">Мэдээллээ шинжлээгүй байна</h2>
        <p>e-Mongolia-д нэвтрээд «Шинжлэх» дарвал ЭМД, НДШ, зээл, бичиг баримт, хөрөнгийн мэдээллийг AI-аар хураангуйлна.</p>
        <div class="btn-row">
          <button type="button" class="btn btn--primary" id="analyzeBtn" data-action="analyze" ${ui.analyzing ? "disabled" : ""}>${ui.analyzing ? `${spinner()} Шинжилж байна…` : "Шинжилж эхлэх"}</button>
          <button type="button" class="btn btn--ghost" data-action="open-em">e-Mongolia нээх ${icon("external", 14)}</button>
        </div>
      </div>`;
    return;
  }

  const menu = ui.menu === "overview" ? `<div class="menu" role="menu" aria-label="Тоймын үйлдэл">
      <button type="button" role="menuitem" data-action="open-em">${icon("external", 16)} e-Mongolia нээх</button>
      <button type="button" role="menuitem" data-action="reset" ${ui.analyzing || ui.asking ? "disabled" : ""}>${icon("trash", 16)} Дахин эхлүүлэх</button>
    </div>` : "";

  $("view-overview").innerHTML = `
    <div class="row-between">
      <span class="meta">Шинжилсэн <strong id="agoText">${esc(timeAgo(sm?.at || snap.takenAt))}</strong></span>
      <div class="head-actions">
        <button type="button" class="btn btn--ghost" id="refreshBtn" data-action="analyze" ${ui.analyzing ? "disabled" : ""}>
          ${ui.analyzing ? `${spinner(16)} Шинжилж байна…` : `${icon("refresh", 16)} Шинэчлэх`}
        </button>
        <button type="button" class="icon-btn icon-btn--sm" id="ovMenuBtn" data-action="toggle-menu" data-menu="overview" aria-label="Бусад үйлдэл" aria-haspopup="menu" aria-expanded="${ui.menu === "overview"}">${icon("more", 18)}</button>
        ${menu}
      </div>
    </div>
    ${notice(ui.status, ui.needsLogin)}
    ${sm ? summaryHtml(sm) : !ui.analyzing && !ui.status ? `<p class="empty-hint">AI хураангуй гараагүй байна. «Шинэчлэх» дарж дахин оролдоно уу.</p>` : ""}
    ${sourcesHtml(snap)}
    <section class="stack" aria-labelledby="chat-title">
      <h2 id="chat-title" class="section-title">Асуулт</h2>
      <div class="messages">${messagesHtml()}</div>
    </section>`;
}

const LEVEL = { urgent: ["Яаралтай анхаарах", "alert"], warning: ["Анхаарах", "alert"], info: ["Мэдээлэл", "info"] };

function summaryHtml(sm) {
  const alerts = (sm.alerts || []).map((a, i) => {
    const level = LEVEL[a.level] ? a.level : "info";
    const [label, ic] = LEVEL[level];
    return `
      <section class="alert alert--${level}" aria-labelledby="alert-${i}">
        <div class="alert__head">
          <span class="alert__icon">${icon(ic, 20)}</span>
          <div class="alert__text">
            <span class="alert__label">${label}</span>
            <h2 class="alert__title" id="alert-${i}">${esc(a.title)}</h2>
            <p class="alert__summary">${esc(a.detail)}</p>
            ${a.action ? `<p class="alert__action">${icon("arrow", 14)}<span>${esc(a.action)}</span></p>` : ""}
          </div>
        </div>
      </section>`;
  }).join("");

  const changes = sm.changes?.length ? `
    <section class="stack" aria-labelledby="changes-title">
      <div class="row-between">
        <h2 id="changes-title" class="section-title">Өмнөх сараас өөрчлөгдсөн</h2>
        <span class="section-sub">${sm.changes.length}</span>
      </div>
      <ul class="list">${sm.changes.map(c => `
        <li class="list-row list-row--top">
          <span class="tile">${icon("activity", 18)}</span>
          <span class="row-text"><span class="row-title">${esc(c.area)}</span><span class="row-sub">${esc(c.summary)}</span></span>
        </li>`).join("")}</ul>
    </section>` : "";

  const ok = sm.ok?.length ? `
    <section class="stack" aria-labelledby="ok-title">
      <div class="row-between">
        <h2 id="ok-title" class="section-title">Хэвийн</h2>
        <span class="section-sub">${sm.ok.length}</span>
      </div>
      <ul class="list">${sm.ok.map(o => `
        <li class="list-row">
          <span class="tile tile--ok">${icon("check", 16, { sw: 3 })}</span>
          <span class="row-body">${esc(o)}</span>
        </li>`).join("")}</ul>
    </section>` : "";

  return `
    <section class="card headline" aria-label="Хураангуй">
      <span class="headline__label">Хураангуй</span>
      <p class="headline__text">${esc(sm.headline)}</p>
    </section>
    ${alerts}${changes}${ok}`;
}

// Дэлгэрэнгүй: эх сурвалж бүрийн төлөв (зөвхөн бүтэц) ба AI руу илгээх өгөгдөл
function sourcesHtml(snap) {
  const okCount = SOURCES.filter(s => snap.status[s.id]?.ok).length;
  const rows = SOURCES.map(s => {
    const st = snap.status[s.id];
    const [cls, label] = !st ? ["unknown", "Шалгаагүй"] : !st.ok ? ["attention", "Татагдсангүй"] : st.note ? ["unknown", "Мэдээлэл алга"] : ["ok", "Татсан"];
    const detail = !st ? "" : !st.ok ? st.error : st.note || shape(snap.data[s.id]);
    return `
      <li class="list-row">
        <span class="tile">${icon(SOURCE_ICON[s.id], 18)}</span>
        <span class="row-text">
          <span class="row-title">${esc(s.name)}</span>
          ${detail ? `<span class="row-sub row-sub--code">${esc(detail)}</span>` : ""}
        </span>
        ${pill(cls, label)}
      </li>`;
  }).join("");
  return `
    <details class="tips sources" id="srcBox" ${ui.open.has("srcBox") ? "open" : ""}>
      <summary>
        <span class="tips__icon">${icon("database", 18)}</span>Татсан мэдээлэл
        <span class="tips__meta">${okCount}/${SOURCES.length} · ${esc(timeAgo(snap.takenAt))}</span>
        <span class="chev">${icon("chevron", 16)}</span>
      </summary>
      <div class="sources__body">
        <ul class="list">${rows}</ul>
        <details class="preview" id="aiPreview" ${ui.open.has("aiPreview") ? "open" : ""}>
          <summary>AI руу илгээсэн зүйл (нууцалсан)</summary>
          <pre>${esc(JSON.stringify(aiPayload(), null, 2))}</pre>
        </details>
      </div>
    </details>`;
}

function messagesHtml() {
  if (!chat.length) return `<p class="empty-hint">Асуулт асууж эсвэл зорилгоо бичээд бичиг баримтын жагсаалт гаргуулаарай. Жишээ нь: «Солонгос руу жуулчны виз мэдүүлэх бичиг баримт бүрдүүлэх».</p>`;
  return chat.map((m, mi) => {
    if (m.role === "user") return `<div class="bubble">${esc(m.text)}</div>`;
    if (m.pending) return `<div class="typing" role="status">${spinner(16)} Бодож байна…</div>`;
    if (m.error && m.retry) return `<div class="reply reply--error"><p>${esc(m.text)}</p>
      <button type="button" class="btn btn--ghost reply__retry" data-action="retry-ask" data-mi="${mi}" ${ui.asking ? "disabled" : ""}>${icon("refresh", 16)} Дахин оролдох</button></div>`;
    const links = (m.links || []).map(l => `<a class="service-link" href="https://e-mongolia.mn${esc(l.path)}" target="_blank" rel="noopener noreferrer">${icon("external", 14)}<span>${esc(l.title)}</span></a>`).join("");
    const p = m.plan;
    const plan = !p ? ""
      : p.loading || p.regenerating ? `<div class="typing" role="status">${spinner(16)} Бичиг баримтын жагсаалт гаргаж байна…</div>`
      : p.error ? `<p class="reply__error">${esc(p.error)}</p>`
      : listCard(p, String(mi));
    return `<div class="reply${m.error ? " reply--error" : ""}"><p>${esc(m.text)}</p>${links ? `<div class="service-links">${links}</div>` : ""}${plan}</div>`;
  }).join("");
}

function listCard(plan, ref) {
  const { ready, total } = progress(plan);
  return `
    <button type="button" class="list-card" data-action="open-list" data-ref="${ref}">
      <span class="tile tile--accent">${icon("clipboard", 20)}</span>
      <span class="row-text">
        <span class="row-title">${esc(plan.title)}</span>
        <span class="row-sub">${total} бичиг баримт · ${ready}/${total} бэлэн</span>
      </span>
      <span class="list-card__open">Нээх ${icon("arrow", 16)}</span>
    </button>`;
}

// «Бичиг баримт»: идэвхтэй жагсаалт эсвэл «Жагсаалтаар бүрдүүлэх» маягт
function renderDocuments() {
  const cur = activeDoc();
  const showForm = !cur || ui.listForm;
  $("listForm").hidden = !showForm;
  $("listFormClose").hidden = !cur;
  $("goAskLink").hidden = !state?.snap;
  $("parseBtn").disabled = ui.parsing || !!listPlan?.running;
  $("parseBtn").innerHTML = ui.parsing ? `${spinner()} Шинжилж байна…` : "Жагсаалтыг шинжлэх";
  setNotice($("listStatus"), showForm ? ui.listStatus : null);
  $("docsBody").innerHTML = showForm ? "" : planViewHtml(cur);
}

function planViewHtml({ ref, plan }) {
  const all = plans();
  const { ready, total, emDone, emNeed, selfDone, collectable } = progress(plan);
  const pct = total ? Math.round((ready / total) * 100) : 0;
  const hasPdf = plan.em.some(d => pdfs.has(d));
  const busy = plan.running || plan.regenerating;
  const at = `data-ref="${ref}"`;

  const switcher = all.length > 1 ? `
    <div class="field-row">
      <label for="listSelect">Жагсаалт</label>
      <select id="listSelect" data-change="switch-list">
        ${all.map(x => `<option value="${x.ref}" ${x.ref === ref ? "selected" : ""}>${esc(x.plan.title)}</option>`).join("")}
      </select>
    </div>` : "";

  const menu = ui.menu === "doc" ? `<div class="menu" role="menu" aria-label="Жагсаалтын үйлдэл">
      <button type="button" role="menuitem" data-action="copy" ${at}>${icon("copy", 16)} Жагсаалт хуулах</button>
      ${(plan.question || plan.text) && !busy ? `<button type="button" role="menuitem" data-action="regen" ${at}>${icon("refresh", 16)} Шинээр гаргах</button>` : ""}
      <button type="button" role="menuitem" data-action="new-list">${icon("plus", 16)} Өөр жагсаалт оруулах</button>
      ${!busy ? `<button type="button" role="menuitem" data-action="delete-list" ${at}>${icon("trash", 16)} Жагсаалт устгах</button>` : ""}
    </div>` : "";

  const status = [
    ref === "list" ? notice(ui.listStatus) : "",
    plan.regenerating ? notice({ text: "Жагсаалтыг AI-аар шинээр гаргаж байна…", cls: "muted" }) : "",
    plan.running ? notice({ text: "Цуглуулж байна… Дуустал e-Mongolia табыг битгий хаагаарай.", cls: "muted" }) : "",
    // Паспорт, иргэний үнэмлэхийн хугацааны анхааруулга (documentWarnings)
    ...(plan.warnings || []).map(w => notice({ text: w.text, cls: { urgent: "err", warning: "warn" }[w.level] || "info" })),
  ].join("");

  const lang = plan.em.some(isForeign) ? `
    <div class="field-row">
      <label for="lang-${ref}" class="row-text">
        <span class="row-title">Гадаад хэлээр лавлагааны хэл</span>
        <span class="row-sub">e-Mongolia-д байхгүй бол англи</span>
      </label>
      <select id="lang-${ref}" data-change="lang" ${at} ${plan.running ? "disabled" : ""}>
        ${LANGUAGES.map(l => `<option value="${l}" ${l === (plan.language || "англи") ? "selected" : ""}>${l[0].toUpperCase() + l.slice(1)}</option>`).join("")}
      </select>
    </div>` : "";

  const mainBtn = plan.running
    ? `<button type="button" class="btn btn--primary btn--block" disabled>${spinner()} ${plan.cancel ? "Зогсоож байна…" : "Цуглуулж байна…"}</button>
      <button type="button" class="btn btn--ghost btn--block" data-action="cancel-collect" ${at} ${plan.cancel ? "disabled" : ""}>${icon("close", 16)} Зогсоох</button>`
    : collectable
      ? `<button type="button" class="btn btn--primary btn--block" id="collectBtn" data-action="collect" ${at} ${plan.regenerating ? "disabled" : ""}>${icon("download", 18)} Цуглуулж ZIP-ээр татах (${collectable})</button>`
      : hasPdf && !plan.bundle
        ? `<button type="button" class="btn btn--primary btn--block" data-action="rezip" ${at}>${icon("download", 18)} ZIP дахин татах</button>`
        : "";

  const bundle = plan.bundle ? `
    <div class="card bundle-card">
      <div class="bundle">
        <span class="tile tile--ok">${icon("package", 20)}</span>
        <span class="row-text">
          <span class="row-title">${esc(plan.bundle.name)}</span>
          <span class="row-sub">${plan.bundle.count} PDF + Жагсаалт.txt · Downloads/Burduulelt</span>
        </span>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn--ghost" data-action="folder" ${at}>${icon("folder", 16)} Хавтас нээх</button>
        ${hasPdf && !plan.running ? `<button type="button" class="btn btn--ghost" data-action="rezip" ${at}>${icon("download", 16)} Багцыг дахин татах</button>` : ""}
      </div>
    </div>` : "";

  const autoSection = plan.em.length ? `
    <section class="stack" aria-labelledby="auto-title">
      <div class="row-between">
        <div class="row-text">
          <h2 id="auto-title" class="section-title">e-Mongolia-оос автоматаар</h2>
          <span class="row-sub">PDF-ээр татаж нэг ZIP файл болгоно</span>
        </div>
        <span class="section-sub progress__count">${emDone} / ${emNeed}</span>
      </div>
      ${lang}
      <ul class="list">${plan.em.map((d, i) => docRow(plan, d, i, ref)).join("")}</ul>
      ${mainBtn}
      ${plan.bundleError ? notice({ text: plan.bundleError, cls: "err" }) : ""}
      ${bundle}
    </section>` : "";

  const selfSection = plan.self.length ? `
    <section class="stack" aria-labelledby="self-title">
      <div class="row-between">
        <h2 id="self-title" class="section-title">Өөрөө бэлдэх</h2>
        <span class="section-sub progress__count">${selfDone} / ${plan.self.length}</span>
      </div>
      <ul class="list">${plan.self.map((x, i) => `
        <li>
          <label class="check-row ${x.done ? "is-done" : ""}" for="self-${ref}-${i}">
            <input type="checkbox" id="self-${ref}-${i}" data-change="tick" ${at} data-i="${i}" ${x.done ? "checked" : ""}>
            <span class="row-text">
              <span class="row-title">${esc(x.label)}</span>
              ${x.note ? `<span class="row-sub">${esc(x.note)}</span>` : ""}
            </span>
          </label>
        </li>`).join("")}</ul>
    </section>` : "";

  const tips = plan.tips?.length ? `
    <details class="tips" id="tips" ${ui.open.has("tips") ? "open" : ""}>
      <summary><span class="bulb">${icon("bulb", 18)}</span>Зөвлөмж</summary>
      <ul class="tips__list">${plan.tips.map(t => `<li>${esc(t)}</li>`).join("")}</ul>
    </details>` : "";

  return `
    ${switcher}
    <div class="doc-head">
      <div class="row-text">
        <h1>${esc(plan.title)}</h1>
        <span class="row-sub">${plan.addressee ? `Хаана өгөх: ${esc(plan.addressee)}` : plan.source === "list" ? "Байгууллагын жагсаалтаас" : "Зорилгоос гаргасан"}</span>
      </div>
      <button type="button" class="icon-btn" id="menuBtn" data-action="toggle-menu" data-menu="doc" aria-label="Бусад үйлдэл" aria-haspopup="menu" aria-expanded="${ui.menu === "doc"}">${icon("more", 18)}</button>
      ${menu}
    </div>
    ${status}
    <div class="card progress">
      <div class="row-between">
        <span class="row-title">Бэлэн</span>
        <span class="progress__count"><strong>${ready}</strong> / ${total}</span>
      </div>
      <div class="track" role="progressbar" aria-label="Бэлэн бичиг баримт" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${ready}">
        <div class="track__fill" style="width: ${pct}%"></div>
      </div>
      ${total > 0 && ready === total ? `<span class="done-note">Бүгд бэлэн. Мэдүүлэхэд бэлэн боллоо.</span>` : ""}
    </div>
    ${autoSection}
    ${selfSection}
    ${tips}
    <p class="disclaimer">${icon("info", 16)}<span>Шаардлага байгууллага бүрт өөр байж болно. Хүлээн авах байгууллагаас (банк, элчин сайдын яам, ажил олгогч, сургууль…) заавал шалгана уу.</span></p>`;
}

// Нэг бичиг баримтын мөр. Тааруулалт эргэлзээтэй (match алга) эсвэл хэрэглэгч «Солих» дарсан бол сонголтуудыг харуулна.
function docRow(plan, d, i, ref) {
  const at = `data-ref="${ref}" data-i="${i}"`;
  const lock = plan.running || plan.regenerating || d.state === "done";
  const choices = (!d.match || d.choosing) && !plan.running ? `
    <div class="choose">
      ${d.candidates?.length ? "" : `<span class="row-sub">Олдсонгүй — өөр үгээр хайна уу</span>`}
      ${(d.candidates || []).map((c, k) => `<button type="button" class="choose__opt" data-action="pick" ${at} data-c="${k}">${esc(c.title)}</button>`).join("")}
      <label class="choose__search">
        ${icon("search", 16)}
        <span class="sr-only">Өөр үгээр хайх</span>
        <input type="text" id="search-${ref}-${i}" data-change="search" ${at} value="${esc(d.query || "")}" placeholder="Өөр үгээр хайх (Enter)">
      </label>
      <div class="choose__foot">
        <button type="button" class="swap swap--muted" data-action="none" ${at}>Аль нь ч биш — өөрөө бэлдэнэ</button>
        ${d.match ? `<button type="button" class="swap swap--muted" data-action="keep" ${at}>Болих</button>` : ""}
      </div>
    </div>` : "";

  if (!d.match) return `
    <li class="doc-row">
      <div class="list-row list-row--top">
        <span class="tile tile--warn">${icon("search", 18)}</span>
        <span class="row-text">
          <span class="row-title">${esc(d.label)}</span>
          <span class="row-sub">e-Mongolia-д аль нь вэ? Сонголтыг тань санана.</span>
        </span>
        ${pill("attention", "Сонгох")}
      </div>
      ${choices}
    </li>`;

  const [cls, label, note] = DOC_STATUS[d.state] || ["overdue", "Алдаа", d.state];
  const noteText = [note, d.detail && `(${d.detail})`].filter(Boolean).join(" ");
  const noteCls = { overdue: "err", attention: "warn" }[cls] || "muted";
  const y = new Date().getFullYear();
  const meta = [
    d.years ? esc(`${y - d.years}–${y}`) : "",
    plan.source === "list" && norm(d.label) !== norm(d.match.title) ? esc(`← ${d.label}`) : "",
    d.state === "done" && pdfs.has(d) ? `<button type="button" class="swap" data-action="open" ${at}>Нээх</button>` : "",
    d.url && d.state !== "done" ? `<button type="button" class="swap" data-action="page" ${at}>Хуудсыг нээх</button>` : "",
    !lock && !d.choosing ? `<button type="button" class="swap" data-action="alt" ${at} aria-label="${esc(d.match.title)} — өөрөөр солих">Солих</button>` : "",
  ].filter(Boolean);

  return `
    <li class="doc-row${d.skip ? " is-skipped" : ""}">
      <div class="check-row">
        <input type="checkbox" id="em-${ref}-${i}" data-change="skip" ${at} ${d.skip ? "" : "checked"} ${lock ? "disabled" : ""}>
        <span class="row-text">
          <label class="row-title" for="em-${ref}-${i}">${esc(d.match.title)}</label>
          ${meta.length ? `<span class="meta-line">${meta.join(" · ")}</span>` : ""}
          ${noteText ? `<span class="doc-note doc-note--${noteCls}">${esc(noteText)}</span>` : ""}
          ${d.replaced ? `<span class="row-sub">«${esc(d.replaced)}» бүртгэлгүй тул орлуулав</span>` : ""}
        </span>
        ${pill(cls, label)}
      </div>
      ${choices}
    </li>`;
}

// --- Үйлдлүүд -------------------------------------------------------------------------
let toastTimer;
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 2800);
}

function scrollToBottom() {
  $("scroll").scrollTop = $("scroll").scrollHeight;
}

function setTab(tab) {
  ui.tab = tab;
  ui.menu = null;
  render();
  $("scroll").scrollTop = 0;
}

async function copyPlan(plan) {
  try {
    await navigator.clipboard.writeText(planText(plan));
    toast("Жагсаалт хуулагдлаа");
  } catch {
    toast("Хуулж чадсангүй");
  }
}

async function clearData() {
  if (!confirm("Хураангуй, асуулт хариулт, жагсаалт, сар бүрийн агшин, санасан сонголтууд бүгд энэ компьютерээс устна. Үргэлжлүүлэх үү?")) return;
  await chrome.storage.local.clear();
  state = null;
  chat = [];
  listPlan = null;
  Object.assign(ui, { tab: "overview", docRef: null, status: null, needsLogin: false, listStatus: null, listForm: false, started: false, menu: null });
  ui.open.clear();
  $("listText").value = "";
  $("listImg").value = "";
  showImgName();
  $("askInput").value = "";
  $("privacyDialog").close();
  render();
  toast("Хадгалсан мэдээлэл устгагдлаа");
}

// Бүтнээр нь дахин зурахгүйгээр цэсийг хаана (дарсан checkbox, select-ийн change алга болохгүй)
function closeMenu() {
  ui.menu = null;
  document.querySelectorAll(".menu").forEach(m => m.remove());
  document.querySelectorAll('[data-action="toggle-menu"]').forEach(b => b.setAttribute("aria-expanded", "false"));
}

async function onClick(e) {
  const b = e.target.closest("[data-action]");
  // Цэсний гадна эсвэл цэсний мөрийг дарахад цэс хаагдана
  if (ui.menu && b?.dataset.action !== "toggle-menu" && (b || !e.target.closest(".menu"))) closeMenu();
  if (!b || b.disabled) return;

  const { action, ref } = b.dataset;
  const plan = ref != null ? planOf(ref) : null;
  const d = plan?.em?.[+b.dataset.i];
  switch (action) {
    case "analyze": return runAnalyze();
    case "open-em": return chrome.tabs.create({ url: EM_HOME });
    case "tab": return setTab(b.dataset.tab);
    case "toggle-menu": ui.menu = ui.menu === b.dataset.menu ? null : b.dataset.menu; return render();
    case "reset": return resetInfo();
    case "suggest": return ask(b.dataset.q);
    case "retry-ask": {
      // Алдаатай хариулт сүүлийнх бол түүнийг асуултын хамт хасаад дахин асууна (ask() дахин нэмнэ)
      const mi = +b.dataset.mi, q = chat[mi]?.retry;
      if (!q || ui.asking) return;
      if (mi === chat.length - 1 && chat[mi - 1]?.role === "user") chat.splice(mi - 1, 2);
      return ask(q);
    }
    case "go-list":
      ui.started = true;
      setTab("documents");
      return $("listText").focus();
    case "go-ask":
      setTab("overview");
      scrollToBottom();
      return $("askInput").focus();
    case "open-list":
      ui.docRef = ref;
      ui.listForm = false;
      return setTab("documents");
    case "new-list":
      ui.listForm = true;
      ui.listStatus = null;
      render();
      $("scroll").scrollTop = 0;
      return $("listText").focus();
    case "close-list-form": ui.listForm = false; return render();
    case "parse": return parseList();
    case "forget":
      await chrome.storage.local.remove(["learned", "catalog", "catalogAt"]);
      return toast("Сонголтууд мартагдлаа. Үйлчилгээний жагсаалт дахин татагдана.");
    case "open-privacy": return $("privacyDialog").showModal();
    case "close-privacy": return $("privacyDialog").close();
    case "clear-data": return clearData();
  }
  if (!plan) return;
  switch (action) {
    case "copy": return copyPlan(plan);
    case "regen": return regenerate(ref);
    case "delete-list": return deleteList(ref);
    case "collect": return collectPlan(plan);
    case "cancel-collect": plan.cancel = true; return render();
    case "rezip": return downloadBundle(plan).catch(err => { plan.bundleError = "Багц үүсгэж чадсангүй: " + err.message; render(); });
    case "folder": return chrome.runtime.sendMessage(plan.bundle?.id ? { type: "SHOW_FILE", id: plan.bundle.id } : { type: "SHOW_FOLDER" });
    case "open": return openPdf(d);
    case "page": return chrome.tabs.create({ url: d.url });
    case "alt": d.choosing = true; d.candidates ||= await candidates({ query: d.query || d.match.title, label: d.label }).catch(() => []); break;
    case "keep": d.choosing = false; break;
    case "pick": if (d.candidates?.[+b.dataset.c]) await choose(d, d.candidates[+b.dataset.c]); break;
    case "none": plan.em.splice(+b.dataset.i, 1); plan.self.push({ label: d.label, note: "Өөрөө бэлдэнэ", done: false }); break;
    default: return;
  }
  render();
}

async function onChange(e) {
  const c = e.target.closest("[data-change]");
  if (!c) return;
  if (c.dataset.change === "switch-list") { ui.docRef = c.value; return render(); }
  const plan = planOf(c.dataset.ref);
  if (!plan) return;
  const i = +c.dataset.i;
  switch (c.dataset.change) {
    case "lang": plan.language = c.value; break;
    case "skip": plan.em[i].skip = !c.checked; break;
    case "tick": plan.self[i].done = c.checked; break;
    case "search": {
      // «хайх» нэрийг өөрчилбөл каталогоос дахин хайна
      const d = plan.em[i];
      d.query = c.value.trim();
      d.candidates = d.query ? await candidates({ query: d.query, label: d.label }).catch(() => []) : [];
      break;
    }
  }
  render();
}

document.addEventListener("click", onClick);
document.addEventListener("change", onChange);
// Хайх талбарт бичиж байх үед дахин зурагдвал бичсэн нь арилахгүй
document.addEventListener("input", e => {
  const c = e.target.closest('[data-change="search"]');
  const d = c && planOf(c.dataset.ref)?.em?.[+c.dataset.i];
  if (d) d.query = c.value;
});
// <details> нээгдсэн эсэхийг дахин зурахад хадгална
document.addEventListener("toggle", e => {
  if (!e.target.id) return;
  if (e.target.open) ui.open.add(e.target.id); else ui.open.delete(e.target.id);
}, true);
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && ui.menu) {
    const btn = ui.menu === "doc" ? "menuBtn" : "ovMenuBtn";
    closeMenu();
    $(btn)?.focus();
  }
});
// Таб хооронд сумаар шилжих
document.querySelector(".tabs").addEventListener("keydown", e => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  const next = ui.tab === "overview" ? "documents" : "overview";
  setTab(next);
  $(next === "overview" ? "tab-overview" : "tab-documents").focus();
});
$("askForm").onsubmit = e => { e.preventDefault(); ask($("askInput").value); };
$("listImg").onchange = showImgName;

// --- Эхлэл ----------------------------------------------------------------------------
document.querySelectorAll("[data-icon]").forEach(el => { el.innerHTML = icon(el.dataset.icon, +el.dataset.size || 18); });
$("fetchList").innerHTML = FETCH_ITEMS.map(([ic, label]) => `<li class="list-row"><span class="tile">${icon(ic, 18)}</span><span>${esc(label)}</span></li>`).join("");
document.querySelectorAll("[data-privacy-points]").forEach(ul => {
  const points = ul.dataset.privacyPoints === "short" ? PRIVACY_POINTS.slice(0, 3) : PRIVACY_POINTS;
  ul.innerHTML = points.map(p => `<li>${esc(p)}</li>`).join("");
});
$("chips").innerHTML = SUGGESTIONS.map(([label, q]) => `<button type="button" class="chip" data-action="suggest" data-q="${esc(q)}" title="${esc(q)}">${esc(label)}</button>`).join("");
$("listText").value = listPlan?.text || "";

// Хуучин хувилбарын өгөгдөл таарахгүй бол цэвэрлээд дахин зурна
try { render(); }
catch (e) {
  console.error(e);
  chat = []; listPlan = null;
  await chrome.storage.local.remove(["chat", "listPlan"]);
  render();
}

setInterval(() => {
  const el = $("agoText");
  if (el && state?.snap) el.textContent = timeAgo(state.summary?.at || state.snap.takenAt);
}, 60_000);
