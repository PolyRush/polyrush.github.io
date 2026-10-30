// Niveau de la semaine automatique.
// Prépare d'avance les niveaux des prochains lundis (meta/wk_AAAA-MM-JJ) : le jeu les prend tout seul le lundi à
// 00h00 (heure de Paris). Range aussi le niveau de la semaine en cours comme niveau courant (meta/weekly).
// Le niveau est fabriqué par le jeu lui-même (générateur + vérification par le robot), ouvert dans un navigateur sans
// écran ; ce script ne fait que l'enregistrer, avec un compte de service Firebase (secret FIREBASE_SERVICE_ACCOUNT).
import { chromium } from 'playwright';
import admin from 'firebase-admin';
import path from 'node:path';

const AHEAD = +(process.env.WEEKS_AHEAD || 2);          // combien de lundis à l'avance
const DRY = process.env.DRY_RUN === '1';                // essai : ne rien écrire

// --- lundi 00h00 à Paris, en ms (mêmes calculs que dans le jeu) ---
function parisParts(ts) {
  const o = {};
  for (const p of new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(ts)) o[p.type] = p.value;
  return o;
}
function parisOffset(ts) { const o = parisParts(ts); return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - Math.floor(ts / 1000) * 1000; }
function weekStart(ts) {
  const o = parisParts(ts), wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(o.weekday);
  const local = Date.UTC(+o.year, +o.month - 1, +o.day) - wd * 864e5;
  let t = local - parisOffset(local); t = local - parisOffset(t);
  return t;
}
const wkKey = t => { const o = parisParts(t + 6 * 3600e3); return 'wk_' + o.year + '-' + o.month + '-' + o.day; };

let db = null;
if (!DRY) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null');
  if (!sa) { console.error('Secret FIREBASE_SERVICE_ACCOUNT manquant'); process.exit(1); }
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  db = admin.firestore();
}
const meta = id => db.collection('meta').doc(id);

const now = Date.now(), cur = weekStart(now);
const mondays = [cur]; for (let i = 1; i <= AHEAD; i++) mondays.push(weekStart(cur + i * 7 * 864e5 + 12 * 3600e3));

// 1) ce qui manque
let curDoc = null;
if (!DRY) { const s = await meta('weekly').get(); curDoc = s.exists ? s.data() : null; }
const curFrom = curDoc ? (+curDoc.from || weekStart(+curDoc.created || 0)) : 0;
const todo = [];
for (const t of mondays) {
  if (t === cur) continue;                                        // la semaine en cours : on ne change jamais de niveau en cours de semaine
  if (!DRY && (await meta(wkKey(t)).get()).exists) continue;      // déjà préparé
  todo.push(t);
}
console.log(`::notice::Lundis ${mondays.map(wkKey).join(', ')} · à fabriquer : ${todo.map(wkKey).join(', ') || 'rien'}`);
let failed = false;

// 2) fabriquer avec le jeu
if (todo.length) {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', e => console.log(`::warning::Erreur dans la page : ${e.message}`));
  await page.goto('file://' + path.resolve('index.html') + '?autogen=1');
  await page.waitForFunction(() => typeof window.__polyGen === 'function', null, { timeout: 60000 });
  for (const t of todo) {
    let doc = null;
    for (let tries = 0; tries < 3 && !doc; tries++) doc = await page.evaluate(from => window.__polyGen(from), t);
    if (!doc) { console.log(`::error::Génération ratée pour ${wkKey(t)}`); failed = true; continue; }
    doc.pub = curDoc ? !!curDoc.pub : false;
    console.log(`::notice::Fabriqué ${wkKey(t)} · robot ${doc.info && doc.info.t} s · ${doc.info && doc.info.sc} raccourci(s)${DRY ? ' (essai, rien enregistré)' : ''}`);
    if (!DRY) await meta(wkKey(t)).set(doc);
  }
  await browser.close();
}

// 3) la semaine en cours : son niveau devient le niveau courant (le classement repart à zéro avec lui)
if (!DRY && curFrom < cur) {
  const q = await meta(wkKey(cur)).get();
  if (q.exists) {
    if (curDoc && curDoc.id) {
      // la semaine qui s'achève : on range les temps de chacun, ses points restent acquis (calculés par le jeu)
      const key = wkKey(curFrom), ref = meta('points'), p = await ref.get();
      if (!(p.exists && p.data().weeks && p.data().weeks[key])) {
        const snap = await db.collection('scores').doc('w' + curDoc.id).collection('runs').get();
        const ms = {}, names = {};
        snap.docs.forEach(x => { const r = x.data(); if (r.ms > 0) { ms[x.id] = r.ms; names[x.id] = r.pseudo || ''; } });
        await ref.set({ weeks: { [key]: { id: String(curDoc.id), from: curFrom, ms } }, names }, { merge: true });
        console.log(`::notice::Semaine ${key} rangée pour les points : ${Object.keys(ms).length} joueur(s)`);
      }
    }
    await meta('weekly').set({ ...q.data(), from: cur, pub: curDoc ? !!curDoc.pub : !!q.data().pub });
    await meta(wkKey(cur)).delete();
    console.log(`::notice::Niveau de la semaine mis en place : ${wkKey(cur)}`);
  }
}
console.log('Fini.');
process.exit(failed ? 1 : 0);
