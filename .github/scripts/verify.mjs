// Vérification des temps (anti-triche).
// Chaque nouveau temps du classement (niveaux 1 à 10 et niveau de la semaine) est rejoué par le jeu lui-même, ouvert dans
// un navigateur sans écran : son replay doit partir du départ, finir sur l'arrivée, ne jamais traverser un bloc, ni aller
// plus vite ou sauter plus haut que possible, et durer exactement le temps annoncé. Le verdict est rangé dans
// meta/verified ({ "niveau|joueur|temps": 1 bon / 0 faux }) : le jeu cache des classements (et des points) les temps faux.
// En mode veille (LOOP_MIN), la tâche reste ouverte et vérifie chaque nouveau temps dans les secondes qui suivent son envoi
// (écoute des classements, sans relire toute la base) ; une nouvelle tâche prend le relais à la fin.
import { chromium } from 'playwright';
import admin from 'firebase-admin';
import path from 'node:path';

const REPORT = process.env.REPORT === '1';   // rapport : rejoue tous les temps, affiche leur vitesse, n'enregistre rien
const LOOP_MIN = REPORT ? 0 : +(process.env.LOOP_MIN || 0);
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null');
if (!sa) { console.error('Secret FIREBASE_SERVICE_ACCOUNT manquant'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const meta = id => db.collection('meta').doc(id);

const [vs, wk] = await Promise.all([meta('verified').get(), meta('weekly').get()]);
const V = (vs.exists && vs.data().v) || {};
const wdoc = wk.exists && wk.data().id ? wk.data() : null;
const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
if (wdoc) keys.push('w' + wdoc.id);

const todo = [], live = new Set(), queued = new Set();
const want = (k, d) => {
  const r = d.data(), id = `${k}|${d.id}|${r.ms}`;
  live.add(id);
  if ((REPORT || !(id in V)) && !queued.has(id)) { queued.add(id); todo.push({ k, uid: d.id, ms: r.ms, pseudo: r.pseudo || '?', id }); }
};
for (const k of keys) {
  const snap = await db.collection('scores').doc(k).collection('runs').get();
  for (const d of snap.docs) want(k, d);
}
console.log(`::notice::${live.size} temps au classement · ${todo.length} à vérifier${LOOP_MIN ? ` · veille ${LOOP_MIN} min` : ''}`);

let ok = 0, bad = 0, skip = 0, page = null, browser = null, busy = false, dirty = false;
const REP = [], DET = [];   // rapport : une seule ligne (GitHub n'affiche que 10 notes par étape)
async function openPage() {
  if (page) return;
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', e => console.log(`::warning::Erreur dans la page : ${e.message}`));
  await page.goto('file://' + path.resolve('index.html') + '?autogen=1');
  await page.waitForFunction(() => typeof window.__polyCheck === 'function', null, { timeout: 60000 });
}
async function check(t) {
  const g = await db.collection('ghosts').doc(t.k).collection('runs').doc(t.uid).get();
  const gd = g.exists ? g.data() : null;
  if (gd && gd.ms !== t.ms) return 'later';                          // replay en cours d'envoi : plus tard
  const res = gd ? await page.evaluate(([k, w, gg]) => window.__polyCheck(k, w, gg), [t.k, t.k[0] === 'w' ? wdoc : null, { d: gd.d, ms: gd.ms }])
    : { ok: false, bad: ['Pas de replay'] };
  if (res.err) { console.log(`::warning::${t.k} · ${t.pseudo} : ${res.err}`); return 'later'; }
  if (REPORT) {
    REP.push(`${t.k}/${t.pseudo}/${t.ms}=${res.spd ? res.spd.max.toFixed(3) : '?'}${res.ok ? '' : '(refusé : ' + res.bad.join(' · ') + ')'}`);
    if (res.spd && res.spd.max > 16.1) DET.push(`${t.k}/${t.pseudo} → ${res.spd.win}`);
    return 'done';
  }
  V[t.id] = res.ok ? 1 : 0; dirty = true;
  if (res.ok) ok++;
  else { bad++; console.log(`::notice::Temps refusé — niveau ${t.k}, ${t.pseudo}, ${t.ms} ms : ${res.bad.join(' · ')}`); }
  return 'done';
}
async function save() {
  if (!dirty || REPORT) return;
  dirty = false;
  await meta('verified').set({ v: V, upd: Date.now() });
}
// la file : un temps à la fois ; un replay pas encore arrivé est réessayé un peu plus tard
async function drain() {
  if (busy) return; busy = true;
  try {
    while (todo.length) {
      await openPage();
      const t = todo.shift();
      const r = await check(t).catch(e => { console.log(`::warning::${t.k} · ${t.pseudo} : ${e.message}`); return 'later'; });
      if (r === 'later') { skip++; t.tries = (t.tries || 0) + 1; if (LOOP_MIN && t.tries < 20) setTimeout(() => { todo.push(t); drain(); }, 15000); else queued.delete(t.id); }
      else queued.delete(t.id);
      await save();
    }
  } finally { busy = false; }
}
await drain();

if (LOOP_MIN) {
  // veille : chaque temps ajouté ou amélioré est vérifié tout de suite
  const stop = keys.map(k => db.collection('scores').doc(k).collection('runs').onSnapshot(snap => {
    for (const ch of snap.docChanges()) if (ch.type !== 'removed') want(k, ch.doc);
    drain();
  }, e => console.log(`::warning::écoute ${k} : ${e.message}`)));
  await new Promise(r => setTimeout(r, LOOP_MIN * 60000));
  stop.forEach(f => f());
  while (busy) await new Promise(r => setTimeout(r, 500));
}
if (browser) await browser.close();
if (REPORT) { console.log(`::notice::Rapport vitesse (${REP.length}) : ${REP.join(' ; ')}`); if (DET.length) console.log(`::notice::Détail : ${DET.join(' ### ')}`); process.exit(0); }
// on oublie les verdicts des temps qui ne sont plus au classement (sauf ceux des niveaux de la semaine : leurs points restent)
const now = new Set();
for (const k of keys) { const snap = await db.collection('scores').doc(k).collection('runs').get(); for (const d of snap.docs) now.add(`${k}|${d.id}|${d.data().ms}`); }
for (const id of Object.keys(V)) if (!now.has(id) && id[0] !== 'w') delete V[id];
await meta('verified').set({ v: V, upd: Date.now() });
console.log(`::notice::Vérifiés : ${ok} bons, ${bad} refusés, ${skip} remis à plus tard`);
process.exit(0);
