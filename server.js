// squarenet-server v3.0 — Firebase Edition
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── Firebase Init ─────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ── Collections ───────────────────────────────────────────────
const CLIENTS  = () => db.collection('clients');
const KB       = () => db.collection('kb');
const SQUARE_KB= () => db.collection('squareKB');
const UNSOLVED = () => db.collection('unsolved');
const TRAINED  = () => db.collection('trained');

const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
function isAdmin(req) { return req.headers['x-admin-pass'] === ADMIN_PASS; }

// ── KB Cache (in-memory for speed) ───────────────────────────
let kbCache = null;
let sqKBCache = null;
let cacheTime = 0;

async function getKBCache() {
  if (kbCache && Date.now() - cacheTime < 5000) return { kb: kbCache, squareKB: sqKBCache };
  const [kbSnap, sqSnap] = await Promise.all([
    KB().get(), SQUARE_KB().get()
  ]);
  kbCache = {};
  kbSnap.forEach(doc => { kbCache[doc.id] = doc.data(); });
  sqKBCache = {};
  sqSnap.forEach(doc => { sqKBCache[doc.id] = doc.data().value; });
  cacheTime = Date.now();
  return { kb: kbCache, squareKB: sqKBCache };
}

function invalidateCache() { kbCache = null; sqKBCache = null; cacheTime = 0; }

// ── CLIENT API ────────────────────────────────────────────────
app.get('/api/validate', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  if (!apiKey) return res.json({ valid: false, error: 'No API key' });
  try {
    const doc = await CLIENTS().doc(apiKey).get();
    if (!doc.exists) return res.json({ valid: false, error: 'Invalid API key' });
    const client = doc.data();
    // Update lastSeen
    await CLIENTS().doc(apiKey).update({ lastSeen: new Date().toISOString() });
    const plan = client.plan || 1000;
    const today = new Date().toISOString().slice(0,10);
    const used = (client.usage || {})[today] || 0;
    const remaining = Math.max(0, plan - used);
    const midnight = new Date(); midnight.setHours(24,0,0,0);
    const hoursLeft = Math.round((midnight - new Date()) / 3600000);
    res.json({ valid: true, name: client.name, plan, usedToday: used, remaining, resetInHours: hoursLeft, active: client.active !== false });
  } catch(e) { res.json({ valid: false, error: e.message }); }
});

app.get('/api/kb', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  if (!apiKey) return res.status(401).json({ error: 'Invalid API key' });
  try {
    const doc = await CLIENTS().doc(apiKey).get();
    if (!doc.exists) return res.status(401).json({ error: 'Invalid API key' });
    const { kb, squareKB } = await getKBCache();
    res.json({ kb, squareKB, updatedAt: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/unsolved', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  if (!apiKey) return res.status(401).json({ error: 'Invalid API key' });
  try {
    const doc = await CLIENTS().doc(apiKey).get();
    if (!doc.exists) return res.status(401).json({ error: 'Invalid API key' });
    const { imageKey, imageSrc, taskText, objectName, gridInfo, squareImages } = req.body;
    if (!imageKey || !imageSrc) return res.status(400).json({ error: 'Missing data' });
    const existing = await UNSOLVED().doc(imageKey).get();
    if (existing.exists) return res.json({ ok: true, status: 'already_exists' });
    await UNSOLVED().doc(imageKey).set({
      id: uuidv4(), imageKey, imageSrc,
      taskText: taskText||'', objectName: objectName||'unknown',
      gridInfo: gridInfo||null, squareImages: squareImages||[],
      submittedBy: doc.data().name,
      submittedAt: new Date().toISOString(), status: 'pending'
    });
    // Track usage
    const today = new Date().toISOString().slice(0,10);
    const client = doc.data();
    const usage = client.usage || {};
    usage[today] = (usage[today] || 0) + 1;
    await CLIENTS().doc(apiKey).update({ usage });
    res.json({ ok: true, status: 'saved' });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/solved', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  try {
    const doc = await CLIENTS().doc(apiKey).get();
    if (!doc.exists) return res.json({ ok: false });
    const today = new Date().toISOString().slice(0,10);
    const usage = doc.data().usage || {};
    usage[today] = (usage[today] || 0) + 1;
    await CLIENTS().doc(apiKey).update({ usage });
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

// ── ADMIN API ─────────────────────────────────────────────────
app.post('/admin/login', (req, res) => {
  res.json({ ok: req.body.password === ADMIN_PASS });
});

app.get('/admin/stats', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const [clients, unsolved, trained, sqKB] = await Promise.all([
      CLIENTS().get(), UNSOLVED().where('status','==','pending').get(),
      TRAINED().get(), SQUARE_KB().get()
    ]);
    res.json({
      clients: clients.size, unsolved: unsolved.size,
      trained: trained.size, squareKB: sqKB.size, tasksToday: 0
    });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/admin/unsolved', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const snap = await UNSOLVED().where('status','==','pending').orderBy('submittedAt','desc').limit(50).get();
    const list = snap.docs.map(d => d.data());
    res.json({ list, count: list.length });
  } catch(e) { res.json({ list: [], count: 0 }); }
});

app.get('/admin/trained', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const snap = await TRAINED().orderBy('trainedAt','desc').limit(100).get();
    const list = snap.docs.map(d => d.data());
    res.json({ list, count: list.length });
  } catch(e) { res.json({ list: [], count: 0 }); }
});

app.post('/admin/train', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { imageKey, imageSrc, objectName, taskText, selectedSquares,
          noObject, gridRows, gridCols, squarePHashes, taskNumber } = req.body;
  if (!imageKey) return res.status(400).json({ error: 'Missing imageKey' });
  try {
    const trainedAt = new Date().toISOString();
    // Save to KB
    await KB().doc(imageKey).set({
      objectName: objectName||'', imageSrc: imageSrc||'',
      noObject: noObject||false, selectedSquares: selectedSquares||[],
      gridRows: gridRows||3, gridCols: gridCols||3,
      taskNumber: taskNumber||1, trainedAt
    });
    // Save per-square hashes
    if (squarePHashes && Array.isArray(squarePHashes)) {
      const batch = db.batch();
      for (const item of squarePHashes) {
        if (item.hash) {
          const safeHash = item.hash.substring(0, 64);
          const val = item.isObject ? { name: objectName, num: taskNumber } : '__none__';
          batch.set(SQUARE_KB().doc(safeHash), { value: val });
        }
      }
      await batch.commit();
    }
    // Mark unsolved as trained
    const unsolvedDoc = await UNSOLVED().doc(imageKey).get();
    if (unsolvedDoc.exists) await UNSOLVED().doc(imageKey).update({ status: 'trained' });
    // Save to trained
    await TRAINED().doc(imageKey).set({
      imageKey, imageSrc, objectName, taskText,
      selectedSquares: selectedSquares||[], noObject: noObject||false,
      taskNumber: taskNumber||1, trainedAt
    });
    invalidateCache();
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.delete('/admin/trained/:key', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await Promise.all([
      KB().doc(req.params.key).delete(),
      TRAINED().doc(req.params.key).delete()
    ]);
    invalidateCache();
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// Client management
app.get('/admin/clients', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const snap = await CLIENTS().get();
    const clients = {};
    const today = new Date().toISOString().slice(0,10);
    snap.forEach(doc => {
      const d = doc.data();
      clients[doc.id] = { ...d, usedToday: (d.usage||{})[today]||0 };
    });
    res.json({ clients });
  } catch(e) { res.json({ clients: {} }); }
});

app.post('/admin/clients', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { name, plan } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const apiKey = 'sn_' + uuidv4().replace(/-/g,'').substring(0,24);
  await CLIENTS().doc(apiKey).set({
    name, apiKey, plan: plan||1000, active: true,
    createdAt: new Date().toISOString(), lastSeen: null, usage: {}
  });
  res.json({ ok: true, apiKey, name });
});

app.patch('/admin/clients/:apiKey', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { plan, active, name } = req.body;
  const update = {};
  if (plan !== undefined) update.plan = plan;
  if (active !== undefined) update.active = active;
  if (name !== undefined) update.name = name;
  await CLIENTS().doc(req.params.apiKey).update(update);
  res.json({ ok: true });
});

app.delete('/admin/clients/:apiKey', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  await CLIENTS().doc(req.params.apiKey).delete();
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SquareNet Server v3.0 Firebase on port ${PORT}`));
