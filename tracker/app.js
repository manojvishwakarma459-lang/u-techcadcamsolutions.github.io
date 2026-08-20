/* U-TECH Student Tracker — Firebase build
 * Static page + Firestore. All permission checks live in firestore.rules on Google's
 * servers, so nothing here can be bypassed by editing the page.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut, setPersistence, browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, collectionGroup, query, where, limit, orderBy, serverTimestamp, writeBatch, Timestamp
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const CFG = {
  apiKey: "AIzaSyCGz7eHh0zJCPaO1djJnt8Lae3M4KRJLp0",
  authDomain: "u-tech-student-tracker.firebaseapp.com",
  projectId: "u-tech-student-tracker",
  storageBucket: "u-tech-student-tracker.firebasestorage.app",
  messagingSenderId: "353482198921",
  appId: "1:353482198921:web:cc0e2c38c7a48cf2a41b58"
};
const INSTITUTE = 'U-TECH CAD CAM SOLUTIONS';
const LOCATION  = 'Vasai, Mumbai';
const REQUIRE_TAUGHT = true;   // a student can only sign topics marked Taught
const ALLOW_ERASE    = true;   // a student may erase his signature until it is approved

const app  = initializeApp(CFG);
const auth = getAuth(app);
const db   = getFirestore(app);

/* ───────────────────────── helpers ───────────────────────── */
const $  = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lower = s => String(s || '').trim().toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);
const dmy = v => {
  if (!v) return 'N/A';
  const d = v?.toDate ? v.toDate() : (typeof v === 'string' ? new Date(v + 'T00:00:00') : v);
  if (!(d instanceof Date) || isNaN(d)) return 'N/A';
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
};
const dmyhm = v => {
  if (!v) return '';
  const d = v?.toDate ? v.toDate() : new Date(v);
  if (isNaN(d)) return '';
  return dmy(d) + ' at ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};
const initials = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
const slug = s => String(s).replace(/[\/#?]/g, '-').trim();

let TOAST_T;
function toast(msg, kind) {
  let el = $('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(TOAST_T);
  TOAST_T = setTimeout(() => { el.className = 'toast' + (kind ? ' ' + kind : ''); }, kind === 'bad' ? 6000 : 3200);
}
const openM  = id => $(id).classList.add('open');
const closeM = id => $(id).classList.remove('open');
document.addEventListener('click', e => {
  const c = e.target.closest('[data-close]');
  if (c) closeM(c.dataset.close);
  if (e.target.classList?.contains('ov')) e.target.classList.remove('open');
});
function errMsg(e) {
  const c = e?.code || '';
  if (c.includes('permission-denied')) return 'The database refused that action. If you believe it should be allowed, tell your instructor.';
  if (c.includes('unavailable') || c.includes('network')) return 'No internet connection. Check your network and try again.';
  if (c.includes('failed-precondition')) return 'The database needs an index for this view. Message: ' + (e.message || '');
  return e?.message || String(e);
}

/* signature: strokes of integer points, stored as a JSON string (small, sharp at any size) */
class SigPad {
  constructor(canvasId, wrapId) {
    this.c = $(canvasId); this.wrap = $(wrapId); this.ctx = this.c.getContext('2d');
    this.strokes = []; this.drawing = false;
    this.ctx.lineWidth = 2.6; this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round'; this.ctx.strokeStyle = '#12122a';
    const pos = e => {
      const r = this.c.getBoundingClientRect();
      return [Math.round((e.clientX - r.left) * (this.c.width / r.width)), Math.round((e.clientY - r.top) * (this.c.height / r.height))];
    };
    this.c.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { this.c.setPointerCapture(e.pointerId); } catch (x) {}
      this.drawing = true; this.strokes.push([pos(e)]); this.wrap.classList.add('inked');
    });
    this.c.addEventListener('pointermove', e => {
      if (!this.drawing) return;
      const p = pos(e), st = this.strokes[this.strokes.length - 1], pv = st[st.length - 1];
      if (pv && Math.abs(p[0] - pv[0]) < 2 && Math.abs(p[1] - pv[1]) < 2) return;
      st.push(p);
      this.ctx.beginPath(); this.ctx.moveTo(pv[0], pv[1]); this.ctx.lineTo(p[0], p[1]); this.ctx.stroke();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => this.c.addEventListener(ev, () => { this.drawing = false; }));
  }
  clear() { this.strokes = []; this.ctx.clearRect(0, 0, this.c.width, this.c.height); this.wrap.classList.remove('inked'); }
  points() { return this.strokes.reduce((a, s) => a + s.length, 0); }
  payload() { return JSON.stringify({ w: this.c.width, h: this.c.height, strokes: this.strokes }); }
}
function sigSvg(json, h = 30, maxW = null) {
  if (!json) return '';
  let sig; try { sig = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return ''; }
  if (!sig?.strokes?.length) return '';
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  sig.strokes.forEach(st => st.forEach(p => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }));
  if (x1 < x0) return '';
  const pad = 10;
  const bx = Math.max(0, x0 - pad), by = Math.max(0, y0 - pad);
  const bw = Math.max(24, Math.min(sig.w, x1 + pad) - bx), bh = Math.max(24, Math.min(sig.h, y1 + pad) - by);
  let sc = h / bh, w = Math.round(bw * sc);
  if (maxW && w > maxW) { w = maxW; sc = w / bw; }
  const sw = Math.min(14, Math.max(2, (h > 60 ? 2.6 : 1.9) / sc)).toFixed(1);
  const paths = sig.strokes.filter(s => s.length).map(s => '<polyline points="' + s.map(p => p[0] + ',' + p[1]).join(' ') + '"/>').join('');
  return `<svg viewBox="${bx} ${by} ${bw} ${bh}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="#12122a" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`;
}
const tState = t => t.iAck ? 'Completed' : (t.sAck ? 'Awaiting Approval' : (t.stage === 'Taught' ? 'Taught' : 'Pending'));
function badge(state) {
  const c = state === 'Completed' ? 'b-done' : state === 'Awaiting Approval' ? 'b-wait' : state === 'Taught' ? 'b-taught' : 'b-pend';
  return `<span class="badge ${c}">${state}</span>`;
}
function parseSyllabusText(text) {
  const out = []; let cur = null;
  String(text).split(/\r?\n/).forEach(raw => {
    let line = raw.trim(); if (!line) return;
    let isMod = false;
    if (/^#+\s*/.test(line)) { isMod = true; line = line.replace(/^#+\s*/, ''); }
    else if (/:\s*$/.test(line)) { isMod = true; line = line.replace(/:\s*$/, ''); }
    line = line.replace(/^[-*•▪◦>]+\s*/, '').replace(/^\(?\d+(\.\d+)*[.)]?\s+/, '').replace(/^[a-zA-Z][.)]\s+/, '').trim();
    if (!line) return;
    if (isMod) { cur = { title: line, topics: [] }; out.push(cur); }
    else { if (!cur) { cur = { title: 'General', topics: [] }; out.push(cur); } cur.topics.push(line); }
  });
  return out.filter(m => m.topics.length);
}

/* ───────────────────────── data layer ───────────────────────── */
const ME = { email: '', name: '', pic: '', role: '', sid: '' };

async function audit(action, sid, tid, detail) {
  try {
    await addDoc(collection(db, 'audit'), {
      ts: serverTimestamp(), actor: ME.email, role: ME.role, action,
      sid: sid || '', tid: tid || '', detail: String(detail || '').slice(0, 500)
    });
  } catch (e) { /* history is best-effort; never block the real action */ }
}
async function loadSyllabi() {
  const snap = await getDocs(collection(db, 'syllabi'));
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  out.sort((a, b) => (a.course || '').localeCompare(b.course || ''));
  return out;
}
async function loadStudent(sid) {
  const s = await getDoc(doc(db, 'students', sid));
  if (!s.exists()) throw new Error('Student record not found.');
  const tSnap = await getDocs(collection(db, 'students', sid, 'topics'));
  const topics = [];
  tSnap.forEach(d => topics.push({ id: d.id, ...d.data() }));
  topics.sort((a, b) => (a.course || '').localeCompare(b.course || '') || (a.sort || 0) - (b.sort || 0));
  let logs = [];
  try {
    const lSnap = await getDocs(collection(db, 'students', sid, 'logs'));
    lSnap.forEach(d => logs.push({ id: d.id, ...d.data() }));
    logs.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  } catch (e) {}
  return { sid, ...s.data(), topics, logs };
}
function counts(topics) {
  const total = topics.length;
  const done = topics.filter(t => t.iAck).length;
  const waiting = topics.filter(t => t.sAck && !t.iAck).length;
  const pending = topics.filter(t => !t.sAck && !t.iAck).length;
  const hours = 0;
  return { total, done, waiting, pending, hours, pct: total ? Math.round(done / total * 100) : 0 };
}
async function applySyllabus(sid, courseName, existingTopics) {
  const id = slug(courseName);
  const sd = await getDoc(doc(db, 'syllabi', id));
  if (!sd.exists()) return 0;
  const mods = sd.data().modules || [];
  const have = new Set((existingTopics || []).filter(t => t.course === courseName)
    .map(t => lower((t.module || 'General') + '||' + t.topic)));
  let sort = (existingTopics || []).reduce((m, t) => Math.max(m, t.sort || 0), 0);
  let added = 0;
  let batch = writeBatch(db), ops = 0;
  for (const m of mods) {
    for (const tp of (m.topics || [])) {
      const key = lower((m.title || 'General') + '||' + tp);
      if (have.has(key)) continue;
      have.add(key); sort++; added++;
      batch.set(doc(collection(db, 'students', sid, 'topics')), {
        course: courseName, module: m.title || 'General', topic: tp, sort,
        stage: 'Pending', sAck: false, sAckAt: null, sig: null, pending: false,
        iAck: false, iAckAt: null, iBy: '', notes: ''
      });
      if (++ops >= 400) { await batch.commit(); batch = writeBatch(db); ops = 0; }
    }
  }
  if (ops) await batch.commit();
  if (added) audit('apply_syllabus', sid, '', added + ' topics of ' + courseName);
  return added;
}

/* ───────────────────────── auth ───────────────────────── */
const boot = (msg, spin = true, btnHtml = '') => {
  $('bootMsg').innerHTML = msg || '';
  $('bootSpin').style.display = spin ? '' : 'none';
  $('bootBtn').innerHTML = btnHtml;
};
const GOOGLE_SVG = '<svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2.5 24 .5 14.6.5 6.5 5.8 2.6 13.6l7.8 6.1C12.3 13.4 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-2.8-.4-4.1H24v8.3h12.8c-.3 2.1-1.7 5.2-4.9 7.3l7.6 5.9c4.5-4.2 7-10.3 7-17.4z"/><path fill="#FBBC05" d="M10.4 28.3c-.5-1.5-.8-3.1-.8-4.8s.3-3.3.8-4.8l-7.8-6.1C1 15.8 0 19.8 0 23.5s1 7.7 2.6 10.9l7.8-6.1z"/><path fill="#34A853" d="M24 47.5c6.2 0 11.4-2 15.2-5.6l-7.6-5.9c-2 1.4-4.7 2.4-7.6 2.4-6.4 0-11.7-3.9-13.6-9.3l-7.8 6.1C6.5 43.2 14.6 47.5 24 47.5z"/></svg>';

async function doSignIn() {
  const prov = new GoogleAuthProvider();
  prov.setCustomParameters({ prompt: 'select_account' });
  try {
    boot('Opening Google sign-in&hellip;');
    await signInWithPopup(auth, prov);
  } catch (e) {
    if (['auth/popup-blocked', 'auth/cancelled-popup-request', 'auth/operation-not-supported-in-this-environment'].includes(e.code)) {
      try { await signInWithRedirect(auth, prov); return; } catch (e2) { showSignIn(errMsg(e2)); return; }
    }
    if (e.code === 'auth/popup-closed-by-user') { showSignIn(''); return; }
    if (e.code === 'auth/unauthorized-domain') {
      showSignIn('This web address is not on the tracker\'s allowed list. Open it as <b>www.u-tech.in/tracker/</b>.');
      return;
    }
    showSignIn(errMsg(e));
  }
}
function showSignIn(msg) {
  boot(msg || 'Sign in with the Google account your institute registered for you.', false,
    `<button class="gsi" id="btnIn">${GOOGLE_SVG} Sign in with Google</button>`);
  $('btnIn').onclick = doSignIn;
}

setPersistence(auth, browserLocalPersistence).catch(() => {});
getRedirectResult(auth).catch(() => {});

onAuthStateChanged(auth, async user => {
  if (!user) { $('app').style.display = 'none'; $('boot').style.display = ''; showSignIn(''); return; }
  boot('Checking your access&hellip;');
  ME.email = lower(user.email); ME.name = user.displayName || user.email; ME.pic = user.photoURL || '';
  try {
    const a = await getDoc(doc(db, 'admins', ME.email));
    if (a.exists()) { ME.role = 'instructor'; ME.sid = ''; }
    else {
      const ix = await getDoc(doc(db, 'emailIndex', ME.email));
      if (!ix.exists()) {
        await signOut(auth);
        showSignIn(`<b>${esc(ME.email)}</b> is not registered in this tracker.<br>Ask your instructor to add your Google address, then sign in again.`);
        return;
      }
      ME.role = 'student'; ME.sid = ix.data().sid;
    }
  } catch (e) {
    showSignIn('Could not check your access. ' + esc(errMsg(e)));
    return;
  }
  $('boot').style.display = 'none';
  $('app').style.display = '';
  $('meName').textContent = ME.name;
  $('meRole').textContent = ME.role === 'instructor' ? 'Instructor' : 'Student';
  $('meAv').innerHTML = ME.pic ? `<img src="${esc(ME.pic)}" alt="">` : esc(initials(ME.name));
  $('hdrSub').textContent = LOCATION + '  •  ' + (ME.role === 'instructor' ? 'Instructor Dashboard' : 'My Syllabus Progress');
  audit('login', ME.sid, '', ME.role);
  if (ME.role === 'instructor') initAdmin(); else initStudent();
});
$('btnOut').onclick = () => signOut(auth);

/* ═════════════════════════ STUDENT ═════════════════════════ */
let SD = null, SP = null, signing = null, openState = {};

async function initStudent() {
  $('main').innerHTML = `<div class="wrap narrow">
      <div class="hero" id="s-hero"><h1>Loading&hellip;</h1></div>
      <div class="stats" id="s-stats"></div>
      <div class="card" style="padding:13px 15px;background:#f8fafc">
        <div style="font-size:12.5px;line-height:1.75;color:var(--muted)">
          <b style="color:var(--navy)">How this works.</b>
          Your instructor marks a topic as <span class="badge b-taught">Taught</span> after it is covered in class.
          You then open it, read the confirmation and <b>sign with your finger</b>.
          Your instructor checks and approves it &mdash; after that it shows
          <span class="badge b-done">Completed</span> and is locked.
        </div>
      </div>
      <div id="s-courses"></div><div id="s-list"></div>
      <div style="text-align:center;margin:18px 0 30px"><button class="btn btn-ghost btn-sm" id="s-print">&#128424; Print my progress report</button></div>
    </div>`;
  SP = SP || new SigPad('sg-canvas', 'sg-pad');
  $('sg-clear').onclick = () => SP.clear();
  $('sg-save').onclick = submitSign;
  $('s-print').onclick = () => showReport(SD);
  await refreshStudent();
}
async function refreshStudent() {
  try { SD = await loadStudent(ME.sid); renderStudent(); }
  catch (e) { toast(errMsg(e), 'bad'); }
}
function renderStudent() {
  const c = counts(SD.topics);
  $('s-hero').innerHTML = `
    <h1>${esc(SD.name)}</h1>
    <div class="sub">${esc(SD.primaryCourse || 'No course yet')} &nbsp;&bull;&nbsp; Joined ${dmy(SD.joinDate)}</div>
    <div class="ptop"><span>Approved by instructor</span><span>${c.done}/${c.total} &bull; ${c.pct}%</span></div>
    <div class="pbar dark"><i style="width:${c.pct}%"></i></div>`;
  $('s-stats').innerHTML = [
    ['g', '&#10003;', c.done, 'Completed &amp; approved'],
    ['o', '&#9995;', c.waiting, 'Waiting for approval'],
    ['r', '&#9203;', c.pending, 'Still pending'],
  ].map(([k, i, n, l]) => `<div class="stat"><div class="ic ${k}">${i}</div><div><div class="n">${n}</div><div class="l">${l}</div></div></div>`).join('');

  const courses = SD.courses || [];
  $('s-courses').innerHTML = !courses.length ? '' : `<div class="card"><div class="card-t">My courses</div>` + courses.map(cr => {
    const ct = SD.topics.filter(t => t.course === cr.name);
    const dn = ct.filter(t => t.iAck).length;
    const pct = ct.length ? Math.round(dn / ct.length * 100) : 0;
    return `<div style="display:flex;align-items:center;gap:11px;padding:8px 0;border-bottom:1px solid var(--border)">
      <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;color:var(--navy)">${esc(cr.name)}</div>
      <div style="font-size:11px;color:var(--muted)">${esc(cr.status || '')} &bull; from ${dmy(cr.startDate)}</div></div>
      <div style="width:96px"><div class="pbar"><i style="width:${pct}%"></i></div></div>
      <div style="font-size:11px;font-weight:700;color:var(--muted);width:78px;text-align:right">${dn}/${ct.length} &bull; ${pct}%</div></div>`;
  }).join('') + `</div>`;

  const groups = groupTopics(SD.topics);
  $('s-list').innerHTML = !groups.length
    ? `<div class="card"><div class="empty">No syllabus loaded yet &mdash; your instructor will add it.</div></div>`
    : groups.map((g, i) => {
        const done = g.items.filter(t => t.iAck).length;
        const todo = g.items.filter(t => canSign(t)).length;
        const open = openState[g.key] !== undefined ? openState[g.key] : !(g.items.length && g.items.every(t => t.iAck));
        return `<div class="mod">
          <div class="mod-h" data-mod="${i}"><b>${esc(g.module)}</b>
            <span>${todo ? `<span class="pill">${todo} to sign</span>&nbsp;&nbsp;` : ''}${done}/${g.items.length} done &nbsp;${open ? '&#9652;' : '&#9662;'}</span></div>
          ${open ? g.items.map(sRow).join('') : ''}</div>`;
      }).join('');
  document.querySelectorAll('#s-list .mod-h').forEach(el => el.onclick = () => {
    const g = groupTopics(SD.topics)[+el.dataset.mod];
    const cur = openState[g.key] !== undefined ? openState[g.key] : !(g.items.length && g.items.every(t => t.iAck));
    openState[g.key] = !cur; renderStudent();
  });
  document.querySelectorAll('#s-list [data-sign]').forEach(b => b.onclick = () => startSign(b.dataset.sign));
  document.querySelectorAll('#s-list [data-erase]').forEach(b => b.onclick = () => erase(b.dataset.erase));
  document.querySelectorAll('#s-list [data-view]').forEach(b => b.onclick = () => viewSig(SD, b.dataset.view));
}
const canSign = t => !t.sAck && !t.iAck && (!REQUIRE_TAUGHT || t.stage === 'Taught');
function groupTopics(topics) {
  const m = new Map();
  topics.forEach(t => {
    const k = (t.course || '') + '   ' + (t.module || 'General');
    if (!m.has(k)) m.set(k, { key: k, course: t.course, module: t.module || 'General', items: [] });
    m.get(k).items.push(t);
  });
  return [...m.values()];
}
function sRow(t) {
  let action;
  if (t.iAck) action = `<div class="sig-thumb" data-view="${t.id}">${sigSvg(t.sig, 30, 120)}</div><div class="sig-meta">Approved &#10003;</div>`;
  else if (t.sAck) action = `<div class="sig-thumb" data-view="${t.id}">${sigSvg(t.sig, 30, 120)}</div>
      <div class="sig-meta">Signed ${esc(dmyhm(t.sAckAt))}</div>
      ${ALLOW_ERASE ? `<div class="sig-meta"><a href="javascript:void(0)" data-erase="${t.id}" style="color:var(--red);font-weight:700;text-decoration:none">erase</a></div>` : ''}`;
  else if (canSign(t)) action = `<button class="btn btn-gold btn-sm" data-sign="${t.id}">&#9997; Sign</button>`;
  else action = `<span class="badge b-pend">Not taught yet</span>`;
  return `<div class="trow"><div class="ti"><div class="tt">${esc(t.topic)}</div>
    <div class="tm">${badge(tState(t))}${t.notes ? ' &nbsp;' + esc(t.notes) : ''}</div></div>
    <div class="ta">${action}</div></div>`;
}
function startSign(tid) {
  const t = SD.topics.find(x => x.id === tid); if (!t) return;
  signing = tid;
  $('sg-topic').innerHTML = esc(t.topic) + `<span>${esc(t.course)} &nbsp;&bull;&nbsp; ${esc(t.module)}</span>`;
  $('sg-declare').innerHTML = `I, <b>${esc(SD.name)}</b>, confirm that this topic has been taught to me at ${esc(INSTITUTE)}, that I have <b>understood</b> it, and that I am able to perform it on my own. I am signing below in my own hand.`;
  $('sg-stamp').innerHTML = 'Signing on <b>' + dmy(today()) + '</b>';
  SP.clear(); openM('m-sign');
}
async function submitSign() {
  if (!signing) return;
  if (SP.points() < 6) { toast('Please sign inside the box first.', 'bad'); return; }
  const btn = $('sg-save'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const t = SD.topics.find(x => x.id === signing);
    await updateDoc(doc(db, 'students', ME.sid, 'topics', signing), {
      sAck: true, sAckAt: serverTimestamp(), sig: SP.payload(), pending: true
    });
    audit('student_sign', ME.sid, signing, t?.topic || '');
    closeM('m-sign'); signing = null;
    await refreshStudent();
    toast('Signed. Your instructor will approve it.', 'good');
  } catch (e) { toast(errMsg(e), 'bad'); }
  btn.disabled = false; btn.innerHTML = '&#10003; I understood &mdash; submit signature';
}
async function erase(tid) {
  if (!confirm('Erase your signature for this topic? You will have to sign again.')) return;
  try {
    await updateDoc(doc(db, 'students', ME.sid, 'topics', tid), { sAck: false, sAckAt: null, sig: null, pending: false });
    audit('student_unsign', ME.sid, tid, '');
    await refreshStudent(); toast('Signature erased.');
  } catch (e) { toast(errMsg(e), 'bad'); }
}
function viewSig(sd, tid) {
  const t = sd.topics.find(x => x.id === tid);
  if (!t?.sig) { toast('No signature stored for this topic.'); return; }
  $('v-body').innerHTML = `
    <div class="sig-top">${esc(t.topic)}<span>${esc(t.course)} &nbsp;&bull;&nbsp; ${esc(t.module)}</span></div>
    <div class="sig-big">${sigSvg(t.sig, 170)}<div class="sig-name">${esc(sd.name)}</div></div>
    <div style="font-size:12.5px;color:var(--muted);margin-top:12px;line-height:1.75">
      Signed on <b style="color:var(--navy)">${esc(dmyhm(t.sAckAt))}</b><br>
      ${t.iAck ? `Approved${t.iBy ? ' by <b style="color:var(--navy)">' + esc(t.iBy) + '</b>' : ''} on <b style="color:var(--navy)">${esc(dmyhm(t.iAckAt))}</b> &mdash; this record is locked.` : 'Waiting for instructor approval.'}
    </div>`;
  openM('m-view');
}

/* ═════════════════════════ INSTRUCTOR ═════════════════════════ */
let TAB = 'queue', STUDENTS = [], SYL = [], CUR = null, sylCourse = '', QUEUE = [];

async function initAdmin() {
  $('main').innerHTML = `<div class="wrap">
    <div class="tabs">
      <button class="tab active" data-tab="queue">&#9995; Approvals <span id="qCount"></span></button>
      <button class="tab" data-tab="students">&#128100; Students</button>
      <button class="tab" data-tab="syllabus">&#128218; Syllabus</button>
      <button class="tab" data-tab="history">&#128220; History</button>
      <button class="tab" data-tab="setup">&#9881; Setup</button>
    </div><div id="view"></div></div>`;
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => go(b.dataset.tab));
  wireAdminModals();
  SYL = await loadSyllabi().catch(() => []);
  go('queue');
}
const V = h => { $('view').innerHTML = h; };
function go(tab) {
  TAB = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ({ queue: viewQueue, students: viewStudents, syllabus: viewSyllabus, history: viewHistory, setup: viewSetup }[tab])();
}

/* ---- approvals ---- */
async function viewQueue() {
  V('<div class="card"><div class="empty">Loading&hellip;</div></div>');
  try {
    const snap = await getDocs(query(collectionGroup(db, 'topics'), where('pending', '==', true), limit(200)));
    QUEUE = [];
    snap.forEach(d => {
      const sid = d.ref.parent.parent.id;
      QUEUE.push({ id: d.id, sid, ...d.data() });
    });
    QUEUE.sort((a, b) => (b.sAckAt?.seconds || 0) - (a.sAckAt?.seconds || 0));
    const names = {};
    await Promise.all([...new Set(QUEUE.map(q => q.sid))].map(async sid => {
      const s = await getDoc(doc(db, 'students', sid)); names[sid] = s.exists() ? s.data().name : sid;
    }));
    $('qCount').innerHTML = QUEUE.length ? `<span class="pill">${QUEUE.length}</span>` : '';
    V(`<div class="card">
      <div class="card-t"><span>&#9995; Signed by students &mdash; waiting for your approval</span>
        <button class="btn btn-ghost btn-sm" id="q-ref">&#8635; Refresh</button></div>
      ${!QUEUE.length ? '<div class="empty">Nothing waiting. When a student signs a topic it appears here.</div>' : `
      <div class="tw"><table><thead><tr><th>Student</th><th>Topic</th><th>Module</th><th>Signature</th><th>Signed</th><th></th></tr></thead><tbody>
      ${QUEUE.map((t, i) => `<tr>
        <td><b>${esc(names[t.sid] || '')}</b></td>
        <td>${esc(t.topic)}</td>
        <td><span class="muted" style="font-size:11.5px">${esc(t.course)}<br>${esc(t.module)}</span></td>
        <td><span class="sig-thumb" data-qsig="${i}">${sigSvg(t.sig, 30, 130)}</span></td>
        <td class="muted" style="font-size:11.5px">${esc(dmyhm(t.sAckAt))}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-green btn-xs" data-qok="${i}">&#10003; Approve</button>
          <button class="btn btn-ghost btn-xs" data-qopen="${t.sid}">Open</button></td></tr>`).join('')}
      </tbody></table></div>`}</div>`);
    $('q-ref').onclick = viewQueue;
    document.querySelectorAll('[data-qsig]').forEach(el => el.onclick = () => {
      const t = QUEUE[+el.dataset.qsig];
      $('v-body').innerHTML = `<div class="sig-top">${esc(t.topic)}<span>${esc(names[t.sid] || '')} &nbsp;&bull;&nbsp; ${esc(t.course)} &bull; ${esc(t.module)}</span></div>
        <div class="sig-big">${sigSvg(t.sig, 170)}<div class="sig-name">${esc(names[t.sid] || '')}</div></div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:12px">Signed on <b style="color:var(--navy)">${esc(dmyhm(t.sAckAt))}</b></div>`;
      openM('m-view');
    });
    document.querySelectorAll('[data-qok]').forEach(b => b.onclick = async () => {
      const t = QUEUE[+b.dataset.qok];
      await approve(t.sid, t.id, true, t.topic); viewQueue();
    });
    document.querySelectorAll('[data-qopen]').forEach(b => b.onclick = () => { CUR = b.dataset.qopen; go('students'); });
  } catch (e) {
    V(`<div class="card"><div class="empty" style="color:var(--red)">${esc(errMsg(e))}</div></div>`);
  }
}
async function approve(sid, tid, val, label) {
  try {
    await updateDoc(doc(db, 'students', sid, 'topics', tid), val
      ? { iAck: true, iAckAt: serverTimestamp(), iBy: ME.email, stage: 'Taught', pending: false }
      : { iAck: false, iAckAt: null, iBy: '', pending: false });
    audit(val ? 'approve' : 'unapprove', sid, tid, label || '');
    toast(val ? 'Approved and locked.' : 'Approval removed.', val ? 'good' : '');
  } catch (e) { toast(errMsg(e), 'bad'); }
}

/* ---- students ---- */
async function viewStudents() {
  V(`<div class="split">
      <div><input class="search" id="q" placeholder="Search students...">
        <div class="slist" id="slist"><div class="empty">Loading…</div></div>
        <button class="btn btn-gold btn-block" style="margin-top:10px" id="s-new">&#43; Add student</button></div>
      <div id="detail"><div class="card"><div class="empty">Pick a student from the list, or add a new one.</div></div></div>
    </div>`);
  $('s-new').onclick = newStudent;
  $('q').oninput = paintList;
  const snap = await getDocs(collection(db, 'students'));
  STUDENTS = [];
  snap.forEach(d => STUDENTS.push({ sid: d.id, ...d.data() }));
  STUDENTS.sort((a, b) => (b.active === false ? 1 : 0) - (a.active === false ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
  paintList();
  if (CUR) openStudent(CUR);
}
function paintList() {
  const q = lower($('q')?.value);
  const f = STUDENTS.filter(s => lower(s.name).includes(q) || lower(s.email).includes(q) || lower(s.primaryCourse).includes(q));
  $('slist').innerHTML = !f.length ? '<div class="empty">No match</div>' : f.map(s => `
    <div class="sitem ${s.sid === CUR ? 'on' : ''}" data-sid="${s.sid}">
      <div class="av">${esc(initials(s.name))}</div>
      <div style="flex:1;min-width:0"><div class="nm">${esc(s.name)}${s.active === false ? ' <span class="muted">(inactive)</span>' : ''}</div>
        <div class="cs">${esc(s.primaryCourse || 'No course')}</div></div></div>`).join('');
  document.querySelectorAll('[data-sid]').forEach(el => el.onclick = () => openStudent(el.dataset.sid));
}
async function openStudent(sid) {
  CUR = sid; paintList();
  $('detail').innerHTML = '<div class="card"><div class="empty">Loading…</div></div>';
  let sd;
  try { sd = await loadStudent(sid); } catch (e) { $('detail').innerHTML = `<div class="card"><div class="empty">${esc(errMsg(e))}</div></div>`; return; }
  window.__sd = sd;
  const c = counts(sd.topics);
  const hours = (sd.logs || []).reduce((a, l) => a + (parseFloat(l.duration) || 0), 0);
  const groups = groupTopics(sd.topics);
  $('detail').innerHTML = `
    <div class="hero">
      <div style="display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <div><h1>${esc(sd.name)}</h1>
          <div class="sub">&#9993; ${esc(sd.email)} &nbsp;&bull;&nbsp; &#128222; ${esc(sd.mobile || 'N/A')} &nbsp;&bull;&nbsp; Joined ${dmy(sd.joinDate)}</div>
          ${sd.notes ? `<div class="sub" style="font-style:italic">&#128161; ${esc(sd.notes)}</div>` : ''}</div>
        <div style="display:flex;flex-direction:column;gap:7px;align-items:flex-end">
          <button class="btn btn-gold btn-sm" id="d-log">&#43; Daily entry</button>
          <button class="btn btn-ghost btn-sm" style="color:#cbd5e1;border-color:rgba(226,185,111,.35)" id="d-edit">&#9998; Edit</button>
          <button class="btn btn-ghost btn-sm" style="color:#cbd5e1;border-color:rgba(226,185,111,.35)" id="d-rep">&#128424; Report</button>
        </div>
      </div>
      <div class="ptop"><span>Instructor-approved completion</span><span>${c.done}/${c.total} &bull; ${c.pct}%</span></div>
      <div class="pbar dark"><i style="width:${c.pct}%"></i></div>
    </div>
    <div class="stats">
      <div class="stat"><div class="ic b">&#127979;</div><div><div class="n">${(sd.courses || []).length}</div><div class="l">Courses</div></div></div>
      <div class="stat"><div class="ic g">&#10003;</div><div><div class="n">${c.done}</div><div class="l">Approved</div></div></div>
      <div class="stat"><div class="ic o">&#9995;</div><div><div class="n">${c.waiting}</div><div class="l">Awaiting approval</div></div></div>
      <div class="stat"><div class="ic r">&#9203;</div><div><div class="n">${c.pending}</div><div class="l">Pending</div></div></div>
      <div class="stat"><div class="ic p">&#9200;</div><div><div class="n">${hours.toFixed(1)}</div><div class="l">Hours</div></div></div>
    </div>
    <div class="card"><div class="card-t"><span>Courses</span><button class="btn btn-gold btn-sm" id="d-enrol">&#43; Add course</button></div>
      ${!(sd.courses || []).length ? '<div class="empty">No course yet.</div>' : sd.courses.map((cr, i) => {
        const ct = sd.topics.filter(t => t.course === cr.name), dn = ct.filter(t => t.iAck).length;
        const pct = ct.length ? Math.round(dn / ct.length * 100) : 0;
        const lib = SYL.find(s => s.course === cr.name);
        return `<div style="display:flex;align-items:center;gap:11px;padding:9px 0;border-bottom:1px solid var(--border);flex-wrap:wrap">
          <div style="flex:1;min-width:150px"><div style="font-size:13px;font-weight:700;color:var(--navy)">${esc(cr.name)}</div>
          <div style="font-size:11px;color:var(--muted)">${esc(cr.status || '')} &bull; from ${dmy(cr.startDate)} &bull; library has ${lib ? (lib.count || 0) : 0} topics</div></div>
          <div style="width:100px"><div class="pbar"><i style="width:${pct}%"></i></div></div>
          <div style="font-size:11px;font-weight:700;color:var(--muted);width:74px;text-align:right">${dn}/${ct.length} &bull; ${pct}%</div>
          <button class="btn btn-ghost btn-xs" data-apply="${esc(cr.name)}">&#8681; Load syllabus</button>
          <button class="btn btn-ghost btn-xs" data-unenrol="${i}">&#10005;</button></div>`;
      }).join('')}
    </div>
    <div class="card"><div class="card-t"><span>Syllabus progress &amp; acceptance</span>
      <span style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-gold btn-sm" id="d-applyall">&#8681; Load all syllabi</button>
        <button class="btn btn-ghost btn-sm" id="d-addtopic">&#43; Add topic</button></span></div>
      ${!sd.topics.length ? '<div class="empty">No topics yet. Use <b>Load all syllabi</b>.</div>' : groups.map(g => {
        const dn = g.items.filter(t => t.iAck).length;
        return `<div class="mod"><div class="mod-h"><b>${esc(g.module)}</b><span>${esc(g.course)} &bull; ${dn}/${g.items.length} approved</span></div>
        <div class="tw"><table><thead><tr><th style="width:30px">#</th><th>Topic</th><th style="text-align:center">Student &#9997;</th><th style="text-align:center">Approve</th><th>Status</th><th>Notes</th><th></th></tr></thead><tbody>
        ${g.items.map((t, i) => `<tr>
          <td class="muted" style="font-size:11.5px">${i + 1}</td>
          <td><b>${esc(t.topic)}</b></td>
          <td style="text-align:center">${t.sig ? `<span class="sig-thumb" data-vsig="${t.id}">${sigSvg(t.sig, 30, 120)}</span><div class="sig-meta">${esc(dmyhm(t.sAckAt))}</div>` : '<span class="muted" style="font-size:11px">not signed</span>'}</td>
          <td style="text-align:center"><input type="checkbox" class="chk" ${t.iAck ? 'checked' : ''} data-ok="${t.id}">${t.iAck ? `<div class="sig-meta">${esc(dmyhm(t.iAckAt))}</div>` : ''}</td>
          <td>${badge(tState(t))}</td>
          <td class="muted" style="font-size:11.5px;max-width:170px">${esc(t.notes) || '&mdash;'}</td>
          <td style="white-space:nowrap">
            ${!t.iAck ? `<button class="btn btn-ghost btn-xs" data-taught="${t.id}" data-val="${t.stage === 'Taught' ? 0 : 1}">${t.stage === 'Taught' ? 'T&#10005;' : 'T'}</button>` : ''}
            <button class="btn btn-ghost btn-xs" data-note="${t.id}">&#9998;</button>
            <button class="btn btn-red btn-xs" data-del="${t.id}">&#10005;</button></td></tr>`).join('')}
        </tbody></table></div></div>`;
      }).join('')}
    </div>
    <div class="card"><div class="card-t"><span>Daily log</span></div>
      ${!(sd.logs || []).length ? '<div class="empty">No entries yet.</div>' : sd.logs.map(l => `
        <div style="padding:10px 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
            <div style="font-size:11.5px;color:var(--muted)">${dmy(l.date)} &bull; <b style="color:var(--navy3)">${esc(l.course || '')}</b>${l.duration ? ' &bull; ' + esc(l.duration) + ' hr' : ''}</div>
            <button class="btn btn-red btn-xs" data-dellog="${l.id}">&#10005;</button></div>
          <div style="font-size:13px;font-weight:700;color:var(--navy);margin-top:3px">${esc(l.topic)}</div>
          ${l.notes ? `<div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(l.notes)}</div>` : ''}</div>`).join('')}
    </div>
    <div style="text-align:right;margin-bottom:26px"><button class="btn btn-red btn-sm" id="d-delstu">&#128465; Delete this student and all records</button></div>`;

  $('d-log').onclick = () => openLog(sd);
  $('d-edit').onclick = () => editStudent(sd);
  $('d-rep').onclick = () => showReport(sd);
  $('d-enrol').onclick = () => openEnrol();
  $('d-applyall').onclick = async () => {
    let n = 0;
    for (const cr of (sd.courses || [])) n += await applySyllabus(sid, cr.name, sd.topics);
    toast(n ? n + ' topic(s) loaded.' : 'Nothing new to load.', n ? 'good' : '');
    openStudent(sid);
  };
  $('d-addtopic').onclick = () => openTopic(sd);
  $('d-delstu').onclick = async () => {
    if (!confirm('Delete ' + sd.name + ' and every record, signature and log? This cannot be undone.')) return;
    try {
      const t = await getDocs(collection(db, 'students', sid, 'topics'));
      let b = writeBatch(db), n = 0;
      for (const d of t.docs) { b.delete(d.ref); if (++n >= 400) { await b.commit(); b = writeBatch(db); n = 0; } }
      const l = await getDocs(collection(db, 'students', sid, 'logs'));
      for (const d of l.docs) { b.delete(d.ref); if (++n >= 400) { await b.commit(); b = writeBatch(db); n = 0; } }
      if (n) await b.commit();
      await deleteDoc(doc(db, 'emailIndex', lower(sd.email))).catch(() => {});
      await deleteDoc(doc(db, 'students', sid));
      audit('student_delete', sid, '', sd.name);
      CUR = null; toast('Student deleted.'); viewStudents();
    } catch (e) { toast(errMsg(e), 'bad'); }
  };
  document.querySelectorAll('[data-apply]').forEach(b => b.onclick = async () => {
    const n = await applySyllabus(sid, b.dataset.apply, sd.topics);
    toast(n ? n + ' topic(s) loaded.' : 'Nothing new to load — or no syllabus saved for that course.', n ? 'good' : '');
    openStudent(sid);
  });
  document.querySelectorAll('[data-unenrol]').forEach(b => b.onclick = async () => {
    const i = +b.dataset.unenrol, arr = (sd.courses || []).slice();
    if (!confirm('Remove "' + arr[i].name + '" from this student? Topics already loaded stay.')) return;
    arr.splice(i, 1);
    await updateDoc(doc(db, 'students', sid), { courses: arr });
    audit('unenrol', sid, '', ''); openStudent(sid);
  });
  document.querySelectorAll('[data-vsig]').forEach(b => b.onclick = () => viewSig(sd, b.dataset.vsig));
  document.querySelectorAll('[data-ok]').forEach(b => b.onchange = async () => {
    const t = sd.topics.find(x => x.id === b.dataset.ok);
    if (b.checked && !t.sAck && !confirm('This student has NOT signed this topic yet.\n\nApproving now leaves no signature on record. Approve anyway?')) { openStudent(sid); return; }
    await approve(sid, b.dataset.ok, b.checked, t.topic); openStudent(sid);
  });
  document.querySelectorAll('[data-taught]').forEach(b => b.onclick = async () => {
    try {
      await updateDoc(doc(db, 'students', sid, 'topics', b.dataset.taught), { stage: +b.dataset.val ? 'Taught' : 'Pending' });
      audit(+b.dataset.val ? 'set_taught' : 'set_pending', sid, b.dataset.taught, '');
      openStudent(sid);
    } catch (e) { toast(errMsg(e), 'bad'); }
  });
  document.querySelectorAll('[data-note]').forEach(b => b.onclick = async () => {
    const t = sd.topics.find(x => x.id === b.dataset.note);
    const v = prompt('Note for "' + t.topic + '":', t.notes || '');
    if (v === null) return;
    await updateDoc(doc(db, 'students', sid, 'topics', b.dataset.note), { notes: v.trim().slice(0, 1000) });
    openStudent(sid);
  });
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const t = sd.topics.find(x => x.id === b.dataset.del);
    if (!confirm('Delete "' + t.topic + '" from this student?' + (t.sAck ? '\n\nWARNING: his signature for this topic will be deleted too.' : ''))) return;
    await deleteDoc(doc(db, 'students', sid, 'topics', b.dataset.del));
    audit('topic_delete', sid, b.dataset.del, t.topic + (t.sAck ? ' (had a signature)' : ''));
    openStudent(sid);
  });
  document.querySelectorAll('[data-dellog]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this entry?')) return;
    await deleteDoc(doc(db, 'students', sid, 'logs', b.dataset.dellog));
    openStudent(sid);
  });
}

/* ---- student form ---- */
function courseOptions(sel) {
  const names = [...new Set([...SYL.map(s => s.course), ...STUDENTS.map(s => s.primaryCourse)].filter(Boolean))].sort();
  return '<option value="">— select —</option>' + names.map(c => `<option${c === sel ? ' selected' : ''}>${esc(c)}</option>`).join('');
}
function newStudent() {
  $('ms-title').innerHTML = '&#128100; Add student';
  ['st-id', 'st-name', 'st-mobile', 'st-email', 'st-notes'].forEach(i => $(i).value = '');
  $('st-join').value = today();
  $('st-course').innerHTML = courseOptions('');
  $('st-loadsyl').checked = true;
  $('st-activeWrap').style.display = 'none';
  openM('m-student');
}
function editStudent(sd) {
  $('ms-title').innerHTML = '&#9998; Edit student';
  $('st-id').value = sd.sid; $('st-name').value = sd.name || ''; $('st-mobile').value = sd.mobile || '';
  $('st-email').value = sd.email || ''; $('st-join').value = sd.joinDate || ''; $('st-notes').value = sd.notes || '';
  $('st-course').innerHTML = courseOptions(sd.primaryCourse);
  $('st-loadsyl').checked = false;
  $('st-activeWrap').style.display = ''; $('st-active').checked = sd.active !== false;
  openM('m-student');
}
function wireAdminModals() {
  $('st-save').onclick = saveStudent;
  $('en-save').onclick = saveEnrol;
  $('lg-save').onclick = saveLog;
  $('tp-save').onclick = saveTopic;
  $('sy-new').onclick = sylNewCourse;
  $('sy-addmod').onclick = () => { collectSyl(); sylData().modules.push({ title: 'Module ' + (sylData().modules.length + 1), topics: [''] }); paintSyl(); };
  $('sy-append').onclick = () => sylImport(false);
  $('sy-replace').onclick = () => sylImport(true);
  $('sy-save').onclick = sylSave;
  $('sy-course').onchange = () => { collectSyl(); sylCourse = $('sy-course').value; paintSyl(); };
  $('imp-go').onclick = doImport;
}
async function saveStudent() {
  const sid0 = $('st-id').value;
  const name = $('st-name').value.trim();
  const email = lower($('st-email').value);
  if (!name) return toast('Student name is required.', 'bad');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('A valid Gmail address is required — the student signs in with it.', 'bad');
  const dup = STUDENTS.find(s => lower(s.email) === email && s.sid !== sid0);
  if (dup) return toast('Another student already uses that email address.', 'bad');
  const data = {
    name, email, mobile: $('st-mobile').value.trim(), joinDate: $('st-join').value || today(),
    primaryCourse: $('st-course').value, notes: $('st-notes').value.trim(),
    active: $('st-activeWrap').style.display === 'none' ? true : $('st-active').checked
  };
  try {
    let sid = sid0;
    if (sid) {
      const before = STUDENTS.find(s => s.sid === sid);
      await updateDoc(doc(db, 'students', sid), data);
      if (before && lower(before.email) !== email) {
        await deleteDoc(doc(db, 'emailIndex', lower(before.email))).catch(() => {});
      }
      await setDoc(doc(db, 'emailIndex', email), { sid, name });
      audit('student_update', sid, '', name);
    } else {
      const ref = doc(collection(db, 'students'));
      await setDoc(ref, { ...data, courses: data.primaryCourse ? [{ name: data.primaryCourse, status: 'In Progress', startDate: data.joinDate, endDate: '' }] : [], createdAt: serverTimestamp() });
      sid = ref.id;
      await setDoc(doc(db, 'emailIndex', email), { sid, name });
      audit('student_add', sid, '', name + ' <' + email + '>');
      if ($('st-loadsyl').checked && data.primaryCourse) {
        const n = await applySyllabus(sid, data.primaryCourse, []);
        if (n) toast(n + ' topic(s) loaded from the ' + data.primaryCourse + ' syllabus.', 'good');
      }
    }
    closeM('m-student'); CUR = sid; toast('Saved.', 'good'); viewStudents();
  } catch (e) { toast(errMsg(e), 'bad'); }
}
function openEnrol() {
  $('en-course').innerHTML = courseOptions('');
  $('en-start').value = today(); $('en-end').value = '';
  openM('m-enroll');
}
async function saveEnrol() {
  const sd = window.__sd; const name = $('en-course').value;
  if (!name) return toast('Select a course.', 'bad');
  const arr = (sd.courses || []).slice();
  if (arr.some(c => c.name === name)) return toast('Already enrolled in that course.', 'bad');
  arr.push({ name, status: $('en-status').value, startDate: $('en-start').value || today(), endDate: $('en-end').value || '' });
  try {
    await updateDoc(doc(db, 'students', sd.sid), { courses: arr });
    audit('enrol', sd.sid, '', name);
    let n = 0;
    if ($('en-loadsyl').checked) n = await applySyllabus(sd.sid, name, sd.topics);
    closeM('m-enroll'); toast(n ? n + ' topic(s) loaded from the syllabus.' : 'Course added.', 'good');
    openStudent(sd.sid);
  } catch (e) { toast(errMsg(e), 'bad'); }
}
function openLog(sd) {
  $('lg-date').value = today();
  const names = (sd.courses || []).map(c => c.name);
  $('lg-course').innerHTML = (names.length ? names : [sd.primaryCourse || '']).map(c => `<option>${esc(c)}</option>`).join('');
  ['lg-topic', 'lg-dur', 'lg-notes'].forEach(i => $(i).value = '');
  const fill = () => {
    const c = $('lg-course').value;
    const lib = (SYL.find(s => s.course === c)?.modules || []).flatMap(m => m.topics || []);
    const mine = sd.topics.filter(t => t.course === c).map(t => t.topic);
    $('lg-list').innerHTML = [...new Set([...mine, ...lib])].map(t => `<option value="${esc(t)}"></option>`).join('');
  };
  $('lg-course').onchange = fill; fill();
  openM('m-log');
}
async function saveLog() {
  const sd = window.__sd;
  const topic = $('lg-topic').value.trim();
  if (!topic) return toast('Enter the topic covered.', 'bad');
  const course = $('lg-course').value;
  try {
    await addDoc(collection(db, 'students', sd.sid, 'logs'), {
      date: $('lg-date').value || today(), course, topic,
      duration: $('lg-dur').value ? parseFloat($('lg-dur').value) : null,
      notes: $('lg-notes').value.trim(), by: ME.email, at: serverTimestamp()
    });
    let marked = 0;
    for (const t of sd.topics) {
      if (t.course === course && lower(t.topic) === lower(topic) && !t.iAck && t.stage !== 'Taught') {
        await updateDoc(doc(db, 'students', sd.sid, 'topics', t.id), { stage: 'Taught' }); marked++;
      }
    }
    audit('log_add', sd.sid, '', topic);
    closeM('m-log');
    toast(marked ? 'Saved. "' + topic + '" is now marked Taught — the student can sign it.' : 'Entry saved.', 'good');
    openStudent(sd.sid);
  } catch (e) { toast(errMsg(e), 'bad'); }
}
function openTopic(sd) {
  const names = (sd.courses || []).map(c => c.name);
  $('tp-course').innerHTML = (names.length ? names : [sd.primaryCourse || '']).map(c => `<option>${esc(c)}</option>`).join('');
  ['tp-topic', 'tp-module', 'tp-notes'].forEach(i => $(i).value = '');
  $('tp-tosyl').checked = false;
  openM('m-topic');
}
async function saveTopic() {
  const sd = window.__sd;
  const topic = $('tp-topic').value.trim();
  if (!topic) return toast('Enter the topic name.', 'bad');
  const course = $('tp-course').value, module = $('tp-module').value.trim() || 'General';
  try {
    const sort = sd.topics.reduce((m, t) => Math.max(m, t.sort || 0), 0) + 1;
    await addDoc(collection(db, 'students', sd.sid, 'topics'), {
      course, module, topic, sort, stage: 'Pending', sAck: false, sAckAt: null, sig: null,
      pending: false, iAck: false, iAckAt: null, iBy: '', notes: $('tp-notes').value.trim()
    });
    if ($('tp-tosyl').checked && course) {
      const id = slug(course);
      const d = await getDoc(doc(db, 'syllabi', id));
      const mods = d.exists() ? (d.data().modules || []) : [];
      let m = mods.find(x => x.title === module);
      if (!m) { m = { title: module, topics: [] }; mods.push(m); }
      if (!m.topics.some(t => lower(t) === lower(topic))) m.topics.push(topic);
      await setDoc(doc(db, 'syllabi', id), { course, modules: mods, count: mods.reduce((a, x) => a + (x.topics || []).length, 0) });
      SYL = await loadSyllabi();
    }
    audit('topic_add', sd.sid, '', topic);
    closeM('m-topic'); openStudent(sd.sid);
  } catch (e) { toast(errMsg(e), 'bad'); }
}

/* ---- the syllabus that came from the U-TECH Mill3D document ---- */
const DEFAULT_SYLLABUS = { course: 'Mastercam 2026 - Mill 3D', modules: [
  { title: 'Module 1 - Basic CAD Design', topics: [
    'Interface Overview & File / Home Command Utilization', '2D / 3D Wireframe Designing', 'Solid Modeling',
    'Surface Patchup + Modifications', 'Model Prep (Direct Editing)', 'Drafting / Transform / View Tools',
    'Practice Assignments after every section'] },
  { title: 'Module 2 - 2D Programming: Initial Setup & Process', topics: [
    'Machine Selection - choose machine type (Mill / Lathe) to initiate the programming environment',
    'Stock Setup - define raw material size', 'Origin Setup - move the part to the software origin',
    'Post Processor - converts toolpaths into G & M codes (Fanuc, Siemens, Mitsubishi, Haas)'] },
  { title: 'Module 3 - 2D Programming: Operations', topics: [
    'Facing Operation (material removal from the top)', 'Pocket Operation (rough removal from boundary)',
    'Contour Operation (side milling - roughing, finishing, engraving, chamfering)',
    'Drilling Operation (create holes in a solid)',
    'Dynamic Milling Rough (high-speed roughing - with Rougher endmill tool only)',
    'Slot Mill (slot profile rough finish)', 'Swept 2D / 2.5D (radius, chamfer, profile finishing)',
    'Helix Bore (hole finishing after drilling)', 'Threadmill (internal / external threading using thread mill tools)'] },
  { title: 'Module 4 - 2D Programming: Validation', topics: [
    'Simulation / Verification', 'G & M Code Execution', 'Practice Assignments with Scoring'] },
  { title: 'Module 5 - 3D Programming: Setup', topics: [
    'Machine Selection (Mill)', 'Stock Setup (stock for verification - 3D simulation)', 'Workplane Setup (origin setup)',
    'Surface Patchup & Fill Holes (open profile filling to avoid machining in that area)', 'Stock Model Creation (raw material)'] },
  { title: 'Module 6 - 3D Programming: Roughing', topics: [
    'Stock Model Creation (raw material)', 'Area Roughing (3D roughing)', 'Rest Stock Model Creation',
    'Area Rest Roughing (rest area roughing)', 'Dynamic OptiRough (high-speed roughing with Endmill tool)'] },
  { title: 'Module 7 - 3D Programming: Finishing', topics: [
    'Waterline - steep profiles (taper, straight, top radius)', 'Equal Scallop - steep & shallow profile finishing',
    'Pencil - corner finishing (leftover material)', 'Horizontal Area - flat surface finishing',
    'Hybrid - combined steep, shallow, flat finishing', 'Raster - open 3D profile finishing',
    'Spiral - circular finishing', 'Project - engraving / marking'] },
  { title: 'Module 8 - 3D Programming: Validation', topics: [
    'Simulation / Verification', 'G & M Code Execution', 'Practice + Assignment + Exam + Certification (after 15 days)'] },
  { title: 'Module 9 - Interface Breakdown: File Tab', topics: [
    'New - create a new project', 'Open - import files (.DWG, .STEP, .IGES)', 'Open in Editor - NC editing in Code Expert',
    'Merge - combine multiple files', 'Save / Save As', 'Save Some - export selected geometry', 'Zip2Go - compress a file',
    'Convert - upgrade old version files', 'Print / Help / Community / Configuration'] },
  { title: 'Module 10 - Interface Breakdown: Home Tab', topics: [
    'Clipboard - copy / paste between views', 'Attributes - change colour, style, appearance of geometry / models',
    'Organize - move / manage levels and Z position', 'Delete / Duplicate / Display - manage screen content visibility',
    'Analyze - inspect geometry and toolpath'] },
  { title: 'Module 11 - Analyze Tools Overview', topics: [
    'Analyze Entity - check properties of 2D lines / circles', 'Analyze Distance - measure between two points',
    'Analyze Toolpath - view Feed, RPM, Operation number', 'Dynamic - check 3D dimensions',
    'Draft Angle - colour-coded draft analysis', 'Check Solid - detect modelling issues',
    'Curvature - highlight minimum radius in colour', '2D Area - calculate perimeter and area',
    'Statistics - display model info', 'Run Add-in - DLL tools like Overlap Check',
    'Netscript Editor - advanced users (C# scripting & DLL creation)'] },
]};
const OTHER_COURSES = ['Mastercam Mill 2D', 'Mastercam Mill 3D', 'Mastercam Lathe', 'Mastercam Mill-Turn',
  'Mastercam Multi-Axis', 'Mastercam Wire EDM', 'AutoCAD 2D', 'AutoCAD 3D', 'SolidWorks', 'CATIA', 'NX CAM'];

async function seedDefaults() {
  const d = DEFAULT_SYLLABUS;
  const count = d.modules.reduce((a, m) => a + m.topics.length, 0);
  await setDoc(doc(db, 'syllabi', slug(d.course)), { course: d.course, modules: d.modules, count });
  for (const c of OTHER_COURSES) {
    const id = slug(c);
    const ex = await getDoc(doc(db, 'syllabi', id));
    if (!ex.exists()) await setDoc(doc(db, 'syllabi', id), { course: c, modules: [], count: 0 });
  }
  audit('syllabus_seed', '', '', d.course + ': ' + d.modules.length + ' modules, ' + count + ' topics');
  SYL = await loadSyllabi();
  toast('Loaded the U-TECH Mill 3D syllabus: ' + d.modules.length + ' modules, ' + count + ' topics.', 'good');
}

/* ---- syllabus tab ---- */
async function viewSyllabus() {
  SYL = await loadSyllabi();
  const hasAny = SYL.some(s => (s.count || 0) > 0);
  V(`<div class="card"><div class="card-t"><span>&#128218; Syllabus library &mdash; one syllabus per course, reused for every student</span>
      <span style="display:flex;gap:6px;flex-wrap:wrap">
        ${!hasAny ? '<button class="btn btn-green btn-sm" id="sy-seed">&#8681; Load the U-TECH Mill 3D syllabus</button>' : ''}
        <button class="btn btn-gold btn-sm" id="sy-open">&#9998; Open editor</button></span></div>
    ${!SYL.length ? '<div class="empty">No syllabus saved yet. Load the built-in Mill 3D syllabus, or open the editor and paste one in.</div>' : `<div class="tw"><table>
      <thead><tr><th>Course</th><th>Modules</th><th>Topics</th><th></th></tr></thead><tbody>
      ${SYL.map(s => `<tr><td><b>${esc(s.course)}</b></td><td>${(s.modules || []).length}</td>
        <td>${s.count || 0}${!s.count ? ' <span class="muted">(empty)</span>' : ''}</td>
        <td style="white-space:nowrap"><button class="btn btn-ghost btn-xs" data-syedit="${esc(s.course)}">Edit</button>
        <button class="btn btn-red btn-xs" data-sydel="${esc(s.id)}">&#10005;</button></td></tr>`).join('')}
    </tbody></table></div>`}</div>`);
  $('sy-open').onclick = () => openSyl('');
  if ($('sy-seed')) $('sy-seed').onclick = async () => {
    const b = $('sy-seed'); b.disabled = true; b.textContent = 'Loading…';
    try { await seedDefaults(); viewSyllabus(); } catch (e) { toast(errMsg(e), 'bad'); b.disabled = false; }
  };
  document.querySelectorAll('[data-syedit]').forEach(b => b.onclick = () => openSyl(b.dataset.syedit));
  document.querySelectorAll('[data-sydel]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this course syllabus from the library?\n\nTopics already loaded into students are NOT touched.')) return;
    await deleteDoc(doc(db, 'syllabi', b.dataset.sydel));
    audit('syllabus_delete', '', '', b.dataset.sydel);
    viewSyllabus();
  });
}
function openSyl(course) {
  sylCourse = course || (SYL[0]?.course || 'New course');
  if (!SYL.find(s => s.course === sylCourse)) SYL.push({ id: slug(sylCourse), course: sylCourse, modules: [], count: 0 });
  $('sy-course').innerHTML = SYL.map(s => `<option${s.course === sylCourse ? ' selected' : ''}>${esc(s.course)}</option>`).join('');
  paintSyl(); openM('m-syl');
}
const sylData = () => SYL.find(s => s.course === sylCourse) || { course: sylCourse, modules: [], count: 0 };
function collectSyl() {
  const wrap = $('sy-list'); if (!wrap) return;
  const mods = [...wrap.querySelectorAll('.symod')].map(md => ({
    title: (md.querySelector('.symname').value || '').trim() || 'General',
    topics: [...md.querySelectorAll('.sytopic')].map(i => i.value.trim()).filter(Boolean)
  }));
  const d = sylData(); d.modules = mods; d.count = mods.reduce((a, m) => a + m.topics.length, 0);
}
function paintSyl() {
  const d = sylData();
  $('sy-list').innerHTML = (!d.modules.length ? '<div class="empty" style="border:1px dashed var(--border);border-radius:11px">No syllabus for this course yet. Add a module, or paste it below.</div>' : '')
    + d.modules.map((m, mi) => `<div class="symod" style="border:1px solid var(--border);border-radius:11px;padding:12px;margin-bottom:10px;background:#fcfcfd">
        <div style="display:flex;gap:8px;margin-bottom:9px">
          <input class="symname" value="${esc(m.title)}" placeholder="Module name" style="flex:1;padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;font-weight:700;font-size:12.5px;color:var(--navy)">
          <button class="btn btn-red btn-xs" data-symdel="${mi}">&#10005;</button></div>
        ${(m.topics || []).map((t, ti) => `<div style="display:flex;gap:7px;align-items:center;margin-bottom:5px">
          <span class="muted" style="font-size:10px;width:18px;text-align:right;font-weight:700">${ti + 1}</span>
          <input class="sytopic" value="${esc(t)}" placeholder="Topic" style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:7px;font-size:12.5px">
          <button data-sytdel="${mi}:${ti}" style="background:none;border:none;color:#cbd5e1;cursor:pointer">&#10005;</button></div>`).join('')}
        <button class="btn btn-ghost btn-xs" style="margin-top:5px" data-sytadd="${mi}">&#43; Topic</button></div>`).join('')
    + (d.modules.length ? `<div class="muted" style="font-size:11px;text-align:right;font-weight:700;margin-bottom:10px">${d.modules.length} module(s) &bull; ${d.count} topic(s)</div>` : '');
  document.querySelectorAll('[data-symdel]').forEach(b => b.onclick = () => { collectSyl(); sylData().modules.splice(+b.dataset.symdel, 1); paintSyl(); });
  document.querySelectorAll('[data-sytadd]').forEach(b => b.onclick = () => { collectSyl(); sylData().modules[+b.dataset.sytadd].topics.push(''); paintSyl(); });
  document.querySelectorAll('[data-sytdel]').forEach(b => b.onclick = () => {
    const [mi, ti] = b.dataset.sytdel.split(':').map(Number);
    collectSyl(); sylData().modules[mi].topics.splice(ti, 1); paintSyl();
  });
}
function sylNewCourse() {
  const n = prompt('New course name:'); if (!n?.trim()) return;
  collectSyl(); sylCourse = n.trim();
  if (!SYL.find(s => s.course === sylCourse)) SYL.push({ id: slug(sylCourse), course: sylCourse, modules: [], count: 0 });
  $('sy-course').innerHTML = SYL.map(s => `<option${s.course === sylCourse ? ' selected' : ''}>${esc(s.course)}</option>`).join('');
  paintSyl();
}
function sylImport(replace) {
  const ta = $('sy-paste');
  if (!ta.value.trim()) return toast('Paste your syllabus text first.', 'bad');
  const parsed = parseSyllabusText(ta.value);
  if (!parsed.length) return toast('Could not read any topics from that text.', 'bad');
  collectSyl();
  const d = sylData();
  if (replace) { if (!confirm('Replace the whole syllabus for "' + sylCourse + '"?')) return; d.modules = parsed; }
  else d.modules = d.modules.concat(parsed);
  d.count = d.modules.reduce((a, m) => a + m.topics.length, 0);
  ta.value = ''; paintSyl();
  toast(parsed.reduce((a, m) => a + m.topics.length, 0) + ' topic(s) added below — press Save syllabus to store it.', 'good');
}
async function sylSave() {
  collectSyl();
  const d = sylData();
  try {
    await setDoc(doc(db, 'syllabi', slug(d.course)), { course: d.course, modules: d.modules, count: d.count });
    audit('syllabus_save', '', '', d.course + ': ' + d.modules.length + ' modules, ' + d.count + ' topics');
    toast('Saved: ' + d.modules.length + ' module(s), ' + d.count + ' topic(s).', 'good');
    SYL = await loadSyllabi();
    if (TAB === 'syllabus') viewSyllabus();
  } catch (e) { toast(errMsg(e), 'bad'); }
}

/* ---- history ---- */
async function viewHistory() {
  V('<div class="card"><div class="empty">Loading&hellip;</div></div>');
  try {
    const snap = await getDocs(query(collection(db, 'audit'), orderBy('ts', 'desc'), limit(300)));
    const rows = []; snap.forEach(d => rows.push(d.data()));
    V(`<div class="card"><div class="card-t"><span>&#128220; History &mdash; every signature, approval and change</span>
      <button class="btn btn-ghost btn-sm" id="h-ref">&#8635; Refresh</button></div>
      ${!rows.length ? '<div class="empty">Nothing recorded yet.</div>' : `<div class="tw"><table>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td style="white-space:nowrap;font-size:11.5px">${esc(dmyhm(r.ts))}</td>
          <td style="font-size:11.5px">${esc(r.actor)}<div class="muted" style="font-size:10px">${esc(r.role || '')}</div></td>
          <td><span class="badge ${String(r.action).includes('sign') ? 'b-wait' : String(r.action).includes('approve') ? 'b-done' : 'b-taught'}">${esc(r.action)}</span></td>
          <td class="muted" style="font-size:11.5px">${esc(r.detail || '')}</td></tr>`).join('')}
      </tbody></table></div>`}</div>`);
    $('h-ref').onclick = viewHistory;
  } catch (e) { V(`<div class="card"><div class="empty" style="color:var(--red)">${esc(errMsg(e))}</div></div>`); }
}

/* ---- setup ---- */
async function viewSetup() {
  let admins = [];
  try { const s = await getDocs(collection(db, 'admins')); s.forEach(d => admins.push({ id: d.id, ...d.data() })); } catch (e) {}
  V(`<div class="grid2">
    <div class="card"><div class="card-t">&#128100; Instructor accounts</div>
      <p class="muted" style="font-size:12.5px;line-height:1.7;margin-bottom:12px">These Google accounts can approve topics and manage students. Anyone else who signs in must exist as a student, otherwise they are refused.</p>
      ${admins.map(a => `<div style="display:flex;align-items:center;gap:9px;padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="flex:1"><b style="font-size:13px">${esc(a.id)}</b><div class="muted" style="font-size:11px">${esc(a.name || 'instructor')}</div></div>
        ${a.id === ME.email ? '<span class="chip">you</span>' : `<button class="btn btn-red btn-xs" data-adel="${esc(a.id)}">&#10005;</button>`}</div>`).join('')}
      <div class="f" style="margin-top:14px"><label>Add an instructor (Gmail)</label><input id="ad-email" placeholder="teacher@gmail.com"></div>
      <button class="btn btn-gold btn-sm" id="ad-add">&#43; Add instructor</button>
    </div>
    <div class="card"><div class="card-t">&#128190; Data</div>
      <p class="muted" style="font-size:12.5px;line-height:1.7;margin-bottom:12px">Keep a copy of everything, or bring your offline records in.</p>
      <button class="btn btn-gold btn-sm" id="d-export">&#8681; Download full backup (JSON)</button>
      <div style="height:9px"></div>
      <button class="btn btn-ghost btn-sm" id="d-import">&#8679; Import from offline tracker</button>
      <div class="hint-box" style="margin-top:16px">
        Students sign in at:<br><b style="word-break:break-all">${esc(location.origin + location.pathname)}</b><br>
        Send that link to each student, along with the Gmail address you registered for him.
      </div>
    </div></div>`);
  $('ad-add').onclick = async () => {
    const em = lower($('ad-email').value);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return toast('Enter a valid email address.', 'bad');
    try { await setDoc(doc(db, 'admins', em), { name: '', addedBy: ME.email, addedAt: serverTimestamp() }); audit('admin_add', '', '', em); toast('Instructor added.', 'good'); viewSetup(); }
    catch (e) { toast(errMsg(e), 'bad'); }
  };
  document.querySelectorAll('[data-adel]').forEach(b => b.onclick = async () => {
    if (!confirm('Remove instructor ' + b.dataset.adel + '?')) return;
    try { await deleteDoc(doc(db, 'admins', b.dataset.adel)); audit('admin_delete', '', '', b.dataset.adel); viewSetup(); }
    catch (e) { toast(errMsg(e), 'bad'); }
  });
  $('d-export').onclick = doExport;
  $('d-import').onclick = () => { $('imp-out').innerHTML = ''; openM('m-import'); };
}
async function doExport() {
  toast('Building backup…');
  try {
    const syl = {};
    (await loadSyllabi()).forEach(s => { syl[s.course] = (s.modules || []).map(m => ({ module: m.title, topics: m.topics || [] })); });
    const out = [];
    const sSnap = await getDocs(collection(db, 'students'));
    for (const d of sSnap.docs) {
      const sd = await loadStudent(d.id);
      out.push({
        name: sd.name, email: sd.email, mobile: sd.mobile || '', joinDate: sd.joinDate || '',
        primaryCourse: sd.primaryCourse || '', notes: sd.notes || '', courses: sd.courses || [],
        topics: sd.topics.map(t => ({
          course: t.course, module: t.module, topic: t.topic, stage: t.stage,
          sAck: !!t.sAck, sAckAt: t.sAckAt?.toDate ? t.sAckAt.toDate().toISOString().slice(0, 10) : '',
          sAckTime: t.sAckAt?.toDate ? t.sAckAt.toDate().toTimeString().slice(0, 5) : '',
          sig: t.sig ? JSON.parse(t.sig) : null,
          iAck: !!t.iAck, iAckAt: t.iAckAt?.toDate ? t.iAckAt.toDate().toISOString().slice(0, 10) : '',
          iBy: t.iBy || '', notes: t.notes || ''
        })),
        logs: (sd.logs || []).map(l => ({ date: l.date, course: l.course, topic: l.topic, duration: l.duration, notes: l.notes }))
      });
    }
    const blob = new Blob([JSON.stringify({ type: 'utech-tracker-backup', source: 'online', exportedAt: today(), syllabi: syl, students: out }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'utech_backup_' + today() + '.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Backup downloaded.', 'good');
  } catch (e) { toast(errMsg(e), 'bad'); }
}
async function doImport() {
  const f = $('imp-file').files[0];
  if (!f) return toast('Choose your backup file first.', 'bad');
  const replace = $('imp-replace').checked;
  let d;
  try { d = JSON.parse(await f.text()); } catch (e) { return toast('That file is not readable JSON.', 'bad'); }
  const rep = { courses: 0, sylTopics: 0, students: 0, topics: 0, signatures: 0, logs: 0, skipped: [] };
  $('imp-out').innerHTML = '<div class="hint-box">Importing… please keep this page open.</div>';
  try {
    for (const [course, mods] of Object.entries(d.syllabi || {})) {
      const id = slug(course);
      const ex = await getDoc(doc(db, 'syllabi', id));
      if (ex.exists() && !replace) continue;
      const modules = (mods || []).map(m => ({ title: m.module || 'General', topics: (m.topics || []).filter(Boolean) }));
      await setDoc(doc(db, 'syllabi', id), { course, modules, count: modules.reduce((a, m) => a + m.topics.length, 0) });
      rep.courses++; rep.sylTopics += modules.reduce((a, m) => a + m.topics.length, 0);
    }
    const existing = await getDocs(collection(db, 'students'));
    const byEmail = {};
    existing.forEach(x => byEmail[lower(x.data().email)] = x.id);
    for (const s of (d.students || [])) {
      const email = lower(s.email);
      if (!s.name) continue;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { rep.skipped.push(s.name + ' (no email address)'); continue; }
      let sid = byEmail[email];
      if (!sid) {
        const ref = doc(collection(db, 'students'));
        await setDoc(ref, {
          name: s.name, email, mobile: s.mobile || '', joinDate: s.joinDate || '', primaryCourse: s.primaryCourse || '',
          notes: s.notes || '', active: true, courses: (s.courses || []).map(c => ({ name: c.name, status: c.status || 'In Progress', startDate: c.startDate || '', endDate: c.endDate || '' })),
          createdAt: serverTimestamp()
        });
        sid = ref.id;
        await setDoc(doc(db, 'emailIndex', email), { sid, name: s.name });
        rep.students++;
      }
      const have = new Set();
      const cur = await getDocs(collection(db, 'students', sid, 'topics'));
      cur.forEach(x => { const t = x.data(); have.add(lower(t.course + '||' + t.module + '||' + t.topic)); });
      let sort = 0, batch = writeBatch(db), ops = 0;
      for (const t of (s.topics || [])) {
        if (!t.topic) continue;
        const key = lower((t.course || '') + '||' + (t.module || 'General') + '||' + t.topic);
        if (have.has(key)) continue;
        have.add(key); sort++;
        let sAt = null;
        if (t.sAck && t.sAckAt) {
          const iso = String(t.sAckAt).slice(0, 10) + 'T' + (/^\d{2}:\d{2}$/.test(t.sAckTime || '') ? t.sAckTime : '09:00') + ':00';
          const dt = new Date(iso); if (!isNaN(dt)) sAt = Timestamp.fromDate(dt);
        }
        let iAt = null;
        if (t.iAck && t.iAckAt) { const dt = new Date(String(t.iAckAt).slice(0, 10) + 'T09:00:00'); if (!isNaN(dt)) iAt = Timestamp.fromDate(dt); }
        const sig = t.sig ? JSON.stringify(t.sig) : null;
        if (sig) rep.signatures++;
        batch.set(doc(collection(db, 'students', sid, 'topics')), {
          course: t.course || '', module: t.module || 'General', topic: t.topic, sort,
          stage: t.stage || 'Pending', sAck: !!t.sAck, sAckAt: sAt, sig, pending: !!t.sAck && !t.iAck,
          iAck: !!t.iAck, iAckAt: iAt, iBy: t.iBy || (t.iAck ? 'imported' : ''), notes: t.notes || ''
        });
        rep.topics++;
        if (++ops >= 400) { await batch.commit(); batch = writeBatch(db); ops = 0; }
      }
      if (ops) await batch.commit();
      for (const l of (s.logs || [])) {
        if (!l.topic) continue;
        await addDoc(collection(db, 'students', sid, 'logs'), {
          date: l.date || today(), course: l.course || '', topic: l.topic,
          duration: l.duration ? parseFloat(l.duration) : null, notes: l.notes || '', by: 'imported', at: serverTimestamp()
        });
        rep.logs++;
      }
    }
    audit('import', '', '', JSON.stringify(rep));
    $('imp-out').innerHTML = `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:12px;font-size:12.5px;line-height:1.8">
      <b>Import finished.</b><br>Courses with a syllabus: ${rep.courses} (${rep.sylTopics} library topics)<br>
      New students: ${rep.students} &bull; topics: ${rep.topics} &bull; signatures: ${rep.signatures} &bull; log entries: ${rep.logs}
      ${rep.skipped.length ? '<br><b style="color:#b45309">Skipped (no email address):</b> ' + esc(rep.skipped.join(', ')) : ''}</div>`;
    SYL = await loadSyllabi();
    toast('Import finished.', 'good');
  } catch (e) {
    $('imp-out').innerHTML = `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:10px;padding:12px;font-size:12.5px">${esc(errMsg(e))}</div>`;
  }
}

/* ---- printable report ---- */
function showReport(sd) {
  const c = counts(sd.topics);
  const hours = (sd.logs || []).reduce((a, l) => a + (parseFloat(l.duration) || 0), 0);
  const groups = groupTopics(sd.topics);
  $('main').innerHTML = `<div class="wrap" id="rep">
    <div class="no-print" style="margin-bottom:14px;display:flex;gap:8px">
      <button class="btn btn-gold btn-sm" id="rp-print">&#128424; Print / Save as PDF</button>
      <button class="btn btn-ghost btn-sm" id="rp-back">&larr; Back</button></div>
    <div style="display:flex;justify-content:space-between;border-bottom:3px solid var(--gold3);padding-bottom:14px;margin-bottom:18px;gap:16px;flex-wrap:wrap">
      <div><h1 style="font-size:20px;color:var(--navy)">${esc(INSTITUTE)}</h1>
        <div class="muted" style="font-size:12px;margin-top:4px;line-height:1.7">${esc(LOCATION)}<br><b>Syllabus Progress &amp; Acceptance Record</b></div></div>
      <div class="muted" style="font-size:12px;text-align:right">
        <b style="display:block;font-size:15px;color:var(--navy3)">${esc(sd.name)}</b>
        ${esc(sd.email)}<br>${esc(sd.mobile || '')}<br>Joined ${dmy(sd.joinDate)}<br>Printed ${dmy(today())}</div>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px">
      ${[[c.total, 'Syllabus topics'], [c.done, 'Signed &amp; approved'], [c.waiting, 'Awaiting approval'], [c.pending, 'Pending'], [c.pct + '%', 'Completion'], [hours.toFixed(1), 'Class hours']]
        .map(([n, l]) => `<div style="border:1px solid var(--border);border-radius:10px;padding:9px 14px;font-size:12px;color:var(--muted)"><b style="display:block;font-size:18px;color:var(--navy)">${n}</b>${l}</div>`).join('')}
    </div>
    ${groups.map(g => {
      const dn = g.items.filter(t => t.iAck).length;
      return `<h3 style="font-size:12.5px;color:var(--navy3);text-transform:uppercase;letter-spacing:.7px;margin:16px 0 7px;padding-bottom:4px;border-bottom:1px solid var(--border)">
        ${esc(g.module)} <span style="float:right;text-transform:none;letter-spacing:0" class="muted">${esc(g.course)} &bull; ${dn}/${g.items.length} approved</span></h3>
      <table style="font-size:11.5px"><thead><tr><th style="width:26px">#</th><th>Topic</th><th style="width:150px;text-align:center">Student signature</th><th style="width:92px">Signed on</th><th style="width:92px">Approved</th><th style="width:104px">Status</th></tr></thead><tbody>
      ${g.items.map((t, i) => `<tr><td>${i + 1}</td><td>${esc(t.topic)}</td>
        <td style="text-align:center">${t.sig ? sigSvg(t.sig, 34, 140) : '<span style="color:#cbd5e1">—</span>'}</td>
        <td>${t.sAckAt ? esc(dmyhm(t.sAckAt)).replace(' at ', '<br>') : '-'}</td>
        <td>${t.iAckAt ? esc(dmy(t.iAckAt)) : '-'}</td>
        <td>${tState(t)}</td></tr>`).join('')}
      </tbody></table>`;
    }).join('')}
    ${!sd.topics.length ? '<div class="empty">No syllabus topics recorded yet.</div>' : ''}
    <div style="margin-top:26px;display:flex;justify-content:space-between;gap:40px;font-size:11.5px" class="muted">
      <div style="flex:1;border-top:1px solid var(--navy);padding-top:6px">${esc(sd.name)}<br><span style="font-size:10px">Student</span></div>
      <div style="flex:1;border-top:1px solid var(--navy);padding-top:6px">For ${esc(INSTITUTE)}<br><span style="font-size:10px">Instructor</span></div>
    </div>
    <div class="muted" style="margin-top:18px;font-size:10.5px;line-height:1.7;border-top:1px dashed var(--border);padding-top:10px">
      Each signature above was drawn by the student on his own device after signing in with his registered Google account,
      against the declaration that the topic was taught to him and understood. Dates and times are recorded by the server, not by
      the student's phone, and cannot be edited from his screen. Topics marked <b>Completed</b> were approved by an instructor and
      are locked against further change.
    </div></div>`;
  $('rp-print').onclick = () => window.print();
  $('rp-back').onclick = () => { if (ME.role === 'instructor') { initAdmin(); } else { initStudent(); } };
}
