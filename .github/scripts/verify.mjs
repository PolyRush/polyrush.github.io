// Vérification des temps (anti-triche).
// Chaque nouveau temps du classement (niveaux 1 à 10 et niveau de la semaine) est rejoué par le jeu lui-même, ouvert dans
// un navigateur sans écran : son replay doit partir du départ, finir sur l'arrivée, ne jamais traverser un bloc, ni aller
// plus vite ou sauter plus haut que possible, et durer exactement le temps annoncé. Le verdict est rangé dans
// meta/verified ({ "niveau|joueur|temps": 1 bon / 0 faux }) ; un temps faux est supprimé (temps, replay, record du joueur).
// En mode veille (LOOP_MIN), la tâche reste ouverte et vérifie chaque nouveau temps dans les secondes qui suivent son envoi
// (écoute des classements, sans relire toute la base) ; une nouvelle tâche prend le relais à la fin.
import { chromium } from 'playwright';
import admin from 'firebase-admin';
import path from 'node:path';

for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log(`::error::${String(e && e.stack || e).replace(/\n/g, ' | ').slice(0, 1500)}`); process.exit(1); });
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

const todo = [], live = new Set(), queued = new Set(), zeros = [];
const want = (k, d) => {
  const r = d.data(), id = `${k}|${d.id}|${r.ms}|${r.at || 0}`;   // un envoi précis : un nouveau temps (même s'il vaut pareil) est revérifié
  live.add(id);
  if (!REPORT && V[id] === 0) zeros.push({ k, uid: d.id, ms: r.ms, at: r.at || 0, pseudo: r.pseudo || '?', id });   // déjà refusé mais encore là : à supprimer
  if ((REPORT || !(id in V)) && !queued.has(id)) { queued.add(id); todo.push({ k, uid: d.id, ms: r.ms, at: r.at || 0, pseudo: r.pseudo || '?', id }); }
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
  const res = gd ? await page.evaluate(([k, w, gg]) => window.__polyCheck(k, w, gg), [t.k, t.k[0] === 'w' ? wdoc : null, { d: gd.d, ms: gd.ms, t0: gd.t0 || 0 }])
    : { ok: false, bad: ['Pas de replay'] };
  if (res.err) { console.log(`::warning::${t.k} · ${t.pseudo} : ${res.err}`); return 'later'; }
  if (REPORT) {
    REP.push(`${t.k}/${t.pseudo}/${t.ms}=${res.spd ? res.spd.max.toFixed(3) : '?'}${res.ok ? '' : '(refusé : ' + res.bad.join(' · ') + ')'}`);
    if (res.spd && res.spd.max > 16.1) DET.push(`${t.k}/${t.pseudo} → ${res.spd.win}`);
    if (res.ng && res.ng.length) DET.push(`vide ${t.k}/${t.pseudo} → ${JSON.stringify(res.ng)}`);
    return 'done';
  }
  V[t.id] = res.ok ? 1 : 0; dirty = true;
  if (res.ok) ok++;
  else {
    bad++; console.log(`::notice::Temps refusé et supprimé — niveau ${t.k}, ${t.pseudo}, ${t.ms} ms : ${res.bad.join(' · ')}`);
    await purge(t, res.bad).catch(e => console.log(`::warning::suppression ${t.k} · ${t.pseudo} : ${e.message}`));
  }
  return 'done';
}
// Un temps refusé est supprimé pour de bon : son temps et son replay, et son record sur ce niveau (le jeu du joueur
// l'efface à sa prochaine connexion, comme quand l'admin efface un temps)
async function purge(t, why) {
  const runs = c => db.collection(c).doc(t.k).collection('runs').doc(t.uid);
  const [cur, gh] = await Promise.all([runs('scores').get(), runs('ghosts').get()]);
  if (cur.exists && (cur.data().ms !== t.ms || (cur.data().at || 0) !== t.at)) return;                // il a refait un temps entre-temps : ce nouveau temps sera vérifié à son tour
  // une copie pour l'admin (liste « Temps refusés », lisible par lui seul) : il peut revoir le replay et restaurer le temps
  const g = gh.exists ? gh.data() : {};
  await db.collection('rejected').doc(`${t.k}_${t.uid}_${t.at || 0}`).set({
    k: t.k, uid: t.uid, pseudo: t.pseudo, ms: t.ms, at: t.at || 0, why: why || ['Refusé par la vérification'], when: Date.now(),
    g: g.d ? { d: g.d, t0: g.t0 || 0, v: g.v || 0, ms: g.ms || t.ms, pseudo: g.pseudo || t.pseudo } : null
  });
  await Promise.all([runs('scores').delete(), runs('ghosts').delete()]);
  await meta('board').set({ cuts: { [t.uid]: { [t.k]: Date.now() } } }, { merge: true });
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
for (const t of zeros) { await purge(t).catch(e => console.log(`::warning::suppression ${t.k} · ${t.pseudo} : ${e.message}`)); console.log(`::notice::Temps refusé supprimé — niveau ${t.k}, ${t.pseudo}, ${t.ms} ms`); }
await drain();

// rapport : rejoue aussi les temps refusés gardés pour l'admin (pour voir si une nouvelle règle les accepterait)
if (REPORT) {
  await openPage();
  const rj = await db.collection('rejected').get();
  for (const d of rj.docs) {
    const r = d.data(); if (!r.g || !r.g.d) continue;
    const res = await page.evaluate(([k, w, gg]) => window.__polyCheck(k, w, gg), [r.k, r.k[0] === 'w' ? wdoc : null, { d: r.g.d, ms: r.ms, t0: r.g.t0 || 0 }]).catch(e => ({ err: e.message }));
    REP.push(`[refusé gardé] ${r.k}/${r.pseudo}/${r.ms}=${res.spd ? res.spd.max.toFixed(3) : '?'}${res.err ? '(' + res.err + ')' : res.ok ? ' → accepté maintenant' : '(encore refusé : ' + res.bad.join(' · ') + ')'}`);
    if (res.ng && res.ng.length) DET.push(`vide ${r.k}/${r.pseudo} → ${JSON.stringify(res.ng)}`);
  }
}
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
for (const k of keys) { const snap = await db.collection('scores').doc(k).collection('runs').get(); for (const d of snap.docs) now.add(`${k}|${d.id}|${d.data().ms}|${d.data().at || 0}`); }
for (const id of Object.keys(V)) if (!now.has(id) && id[0] !== 'w') delete V[id];
await meta('verified').set({ v: V, upd: Date.now() });
console.log(`::notice::Vérifiés : ${ok} bons, ${bad} refusés, ${skip} remis à plus tard`);
process.exit(0);
