// Vérification des temps (anti-triche).
// Chaque nouveau temps du classement (niveaux 1 à 10 et niveau de la semaine) est rejoué par le jeu lui-même, ouvert dans
// un navigateur sans écran : son replay doit partir du départ, finir sur l'arrivée, ne jamais traverser un bloc, ni aller
// plus vite ou sauter plus haut que possible, et durer exactement le temps annoncé. Le verdict est rangé dans
// meta/verified ({ "niveau|joueur|temps": 1 bon / 0 faux }) : le jeu ne compte les points d'un joueur, pour les autres,
// qu'une fois son temps vérifié, et cache des classements les temps faux.
import { chromium } from 'playwright';
import admin from 'firebase-admin';
import path from 'node:path';

const REPORT = process.env.REPORT === '1';   // rapport : rejoue tous les temps, affiche leur vitesse, n'enregistre rien
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

const todo = [], live = new Set();
for (const k of keys) {
  const snap = await db.collection('scores').doc(k).collection('runs').get();
  for (const d of snap.docs) {
    const r = d.data(), id = `${k}|${d.id}|${r.ms}`;
    live.add(id);
    if (REPORT || !(id in V)) todo.push({ k, uid: d.id, ms: r.ms, pseudo: r.pseudo || '?', id });
  }
}
console.log(`::notice::${live.size} temps au classement · ${todo.length} à vérifier`);

let ok = 0, bad = 0, skip = 0;
if (todo.length) {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', e => console.log(`::warning::Erreur dans la page : ${e.message}`));
  await page.goto('file://' + path.resolve('index.html') + '?autogen=1');
  await page.waitForFunction(() => typeof window.__polyCheck === 'function', null, { timeout: 60000 });
  for (const t of todo) {
    const g = await db.collection('ghosts').doc(t.k).collection('runs').doc(t.uid).get();
    const gd = g.exists ? g.data() : null;
    if (gd && gd.ms !== t.ms) { skip++; continue; }                   // replay en cours d'envoi : à la prochaine
    const res = gd ? await page.evaluate(([k, w, gg]) => window.__polyCheck(k, w, gg), [t.k, t.k[0] === 'w' ? wdoc : null, { d: gd.d, ms: gd.ms }])
      : { ok: false, bad: ['Pas de replay'] };
    if (res.err) { console.log(`::warning::${t.k} · ${t.pseudo} : ${res.err}`); skip++; continue; }
    if (REPORT) { console.log(`::notice::Vitesse — niveau ${t.k}, ${t.pseudo}, ${t.ms} ms : ${res.spd ? res.spd.max.toFixed(3) + ' studs/s (à ' + res.spd.at.toFixed(1) + ' s)' : '?'} · ${res.ok ? 'bon' : 'refusé : ' + res.bad.join(' · ')}`); continue; }
    V[t.id] = res.ok ? 1 : 0;
    if (res.ok) ok++;
    else { bad++; console.log(`::notice::Temps refusé — niveau ${t.k}, ${t.pseudo}, ${t.ms} ms : ${res.bad.join(' · ')}`); }
  }
  await browser.close();
}
// on oublie les verdicts des temps qui ne sont plus au classement (sauf ceux des niveaux de la semaine : leurs points restent)
if (REPORT) process.exit(0);
for (const id of Object.keys(V)) if (!live.has(id) && id[0] !== 'w') delete V[id];
await meta('verified').set({ v: V, upd: Date.now() });
console.log(`::notice::Vérifiés : ${ok} bons, ${bad} refusés, ${skip} remis à plus tard`);
