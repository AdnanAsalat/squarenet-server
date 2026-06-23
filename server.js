// squarenet-server v2.1 — AACaptcha Solver Backend
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, def={}) {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return def;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch(e) { return def; }
}
function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data), 'utf8');
}

const getClients  = () => readJSON('clients.json');
const getKB       = () => readJSON('kb.json');
const getSquareKB = () => readJSON('square_kb.json');
const getUnsolved = () => readJSON('unsolved.json');
const getTrained  = () => readJSON('trained.json');
const getUsage    = () => readJSON('usage.json');
const getComplaints = () => readJSON('complaints.json');

// ── Caches (declared early so save functions can clear them) ──
let _lightKBCache = null, _squareKBCache = null;
let _statsCache = null, _statsCacheTime = 0;
function invalidateKBCache() { _lightKBCache = null; _squareKBCache = null; }

// Trained "version" — a number that changes whenever trained data changes.
// The dashboard uses this to skip re-downloading trained data if nothing changed.
function getTrainedVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR,'trained_version.json'),'utf8')).v || 0; }
  catch(e) { return 0; }
}
function bumpTrainedVersion() {
  const v = getTrainedVersion() + 1;
  try { fs.writeFileSync(path.join(DATA_DIR,'trained_version.json'), JSON.stringify({v}), 'utf8'); } catch(e){}
  return v;
}

const saveClients  = d => { _statsCache=null; return writeJSON('clients.json', d); };
const saveKB       = d => { invalidateKBCache(); _statsCache=null; return writeJSON('kb.json', d); };
const saveSquareKB = d => { invalidateKBCache(); _statsCache=null; return writeJSON('square_kb.json', d); };
const saveUnsolved = d => { _statsCache=null; return writeJSON('unsolved.json', d); };
const saveTrained  = d => { _statsCache=null; bumpTrainedVersion(); return writeJSON('trained.json', d); };
const saveUsage    = d => writeJSON('usage.json', d);
const saveComplaints = d => { _statsCache=null; return writeJSON('complaints.json', d); };

const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
function isAdmin(req) { return req.headers['x-admin-pass'] === ADMIN_PASS; }
function getTodayKey() { return new Date().toISOString().slice(0,10); }

function getClientInfo(apiKey) {
  if (!apiKey) return null;
  return getClients()[apiKey] || null;
}

function incrementUsage(apiKey) {
  const usage = getUsage(); const today = getTodayKey();
  if (!usage[apiKey]) usage[apiKey] = {};
  usage[apiKey][today] = (usage[apiKey][today] || 0) + 1;
  saveUsage(usage);
  return usage[apiKey][today];
}

// Auto-create default client
const DEFAULT_KEY = process.env.DEFAULT_CLIENT_KEY;
if (DEFAULT_KEY) {
  const clients = getClients();
  if (!clients[DEFAULT_KEY]) {
    clients[DEFAULT_KEY] = {
      name: process.env.DEFAULT_CLIENT_NAME || 'Admin',
      apiKey: DEFAULT_KEY, plan: 9999999, active: true,
      createdAt: new Date().toISOString(), lastSeen: null
    };
    saveClients(clients);
    console.log('Default client created:', DEFAULT_KEY);
  }
}

// ── CLIENT API ────────────────────────────────────────────────
app.get('/api/validate', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  const client = getClientInfo(apiKey);
  if (!client) return res.json({ valid: false, error: 'Invalid API key' });
  const clients = getClients();
  clients[apiKey].lastSeen = new Date().toISOString();
  saveClients(clients);
  const { count } = getClientUsage(apiKey);
  const plan = client.plan || 1000;
  const remaining = Math.max(0, plan - count);
  const midnight = new Date(); midnight.setHours(24,0,0,0);
  const hoursLeft = Math.round((midnight - new Date()) / 3600000);
  res.json({ valid: true, name: client.name, plan, usedToday: count, remaining, resetInHours: hoursLeft, active: client.active !== false });
});

function getClientUsage(apiKey) {
  const usage = getUsage(); const today = getTodayKey();
  if (!usage[apiKey]) usage[apiKey] = {};
  if (!usage[apiKey][today]) usage[apiKey][today] = 0;
  return { usage, today, count: usage[apiKey][today] };
}

// Lightweight version check - returns only size, not full KB
app.get('/api/kb-version', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  if (!getClientInfo(apiKey)) return res.status(401).json({ error: 'Invalid API key' });
  const kb = getKB();
  const sqKB = getSquareKB();
  res.json({ 
    size: Object.keys(kb).length,
    sqSize: Object.keys(sqKB).length,
    updatedAt: new Date().toISOString()
  });
});

// Build light KB (no images). Rebuilt only when training changes.
function buildKBCache() {
  const kb = getKB();
  const lightKB = {};
  for (const [key, val] of Object.entries(kb)) {
    lightKB[key] = {
      objectName: val.objectName,
      noObject: val.noObject,
      selectedSquares: val.selectedSquares,
      gridRows: val.gridRows,
      gridCols: val.gridCols,
      taskNumber: val.taskNumber
    };
  }
  _lightKBCache = lightKB;
  _squareKBCache = getSquareKB();
}

app.get('/api/kb', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  const client = getClientInfo(apiKey);
  if (!client) return res.status(401).json({ error: 'Invalid API key' });

  if (client.active === false) {
    return res.status(403).json({ error: 'Account suspended', code: 'SUSPENDED' });
  }

  const { count } = getClientUsage(apiKey);
  const plan = client.plan || 1000;
  if (count >= plan) {
    return res.status(403).json({ 
      error: 'Daily limit reached. Upgrade your plan.', 
      code: 'LIMIT_REACHED',
      used: count, limit: plan
    });
  }

  // Use cached light KB (rebuilt only when training changes) — much faster,
  // avoids re-reading and stripping the large kb.json on every client request.
  if (!_lightKBCache || !_squareKBCache) buildKBCache();
  res.json({ kb: _lightKBCache, squareKB: _squareKBCache, updatedAt: new Date().toISOString() });
});

app.post('/api/unsolved', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  const client = getClientInfo(apiKey);
  if (!client) return res.status(401).json({ error: 'Invalid API key' });
  const { imageKey, imageSrc, taskText, objectName, gridInfo, squareImages } = req.body;
  if (!imageKey || !imageSrc) return res.status(400).json({ error: 'Missing data' });
  const unsolved = getUnsolved();
  if (unsolved[imageKey]) return res.json({ ok: true, status: 'already_exists' });
  unsolved[imageKey] = {
    id: uuidv4(), imageKey, imageSrc, taskText: taskText||'',
    objectName: objectName||'unknown', gridInfo: gridInfo||null,
    squareImages: squareImages||[], submittedBy: client.name,
    submittedAt: new Date().toISOString(), status: 'pending'
  };
  saveUnsolved(unsolved);
  // NOTE: Do NOT increment usage here — submitting an unsolved task for training
  // is not a "solve". Only count actual solves (in /api/solved).
  res.json({ ok: true, status: 'saved' });
});

app.post('/api/solved', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  if (!getClientInfo(apiKey)) return res.json({ ok: false });
  incrementUsage(apiKey);
  res.json({ ok: true });
});

// ── ADMIN API ─────────────────────────────────────────────────
app.post('/admin/login', (req, res) => {
  res.json({ ok: req.body.password === ADMIN_PASS, token: req.body.password === ADMIN_PASS ? ADMIN_PASS : null });
});

// Stats are cached briefly so the every-8s dashboard poll doesn't re-read
// large data files from disk each time.
app.get('/admin/stats', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const now = Date.now();
  if (_statsCache && (now - _statsCacheTime) < 15000) {
    return res.json(_statsCache);   // serve cached (valid for 15s)
  }
  const unsolved = getUnsolved(); const trained = getTrained();
  const clients = getClients(); const sqKB = getSquareKB();
  const usage = getUsage(); const today = getTodayKey();
  const complaints = getComplaints();
  let tasksToday = 0;
  for (const k of Object.keys(usage)) tasksToday += (usage[k][today] || 0);
  _statsCache = {
    unsolved: Object.values(unsolved).filter(e=>e.status==='pending').length,
    trained: Object.keys(trained).length,
    clients: Object.keys(clients).length,
    squareKB: Object.keys(sqKB).length, tasksToday,
    complaints: Object.keys(complaints).length
  };
  _statsCacheTime = now;
  res.json(_statsCache);
});

app.get('/admin/unsolved', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const unsolved = getUnsolved();
  const all = Object.values(unsolved).filter(e=>e.status==='pending')
    .sort((a,b)=>new Date(b.submittedAt)-new Date(a.submittedAt));
  // Pagination: return `limit` items starting at `offset` (for Load More)
  const offset = parseInt(req.query.offset) || 0;
  const limit = parseInt(req.query.limit) || 60;
  const list = all.slice(offset, offset + limit);
  res.json({ list, count: list.length, total: all.length, offset, limit });
});

// Lightweight: just the current trained version number (tiny, fast).
// Dashboard calls this first; only re-downloads trained data if version changed.
app.get('/admin/trained-version', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ version: getTrainedVersion() });
});

app.get('/admin/trained', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const trained = getTrained();
  const list = Object.values(trained).sort((a,b)=>new Date(b.trainedAt)-new Date(a.trainedAt));
  res.json({ list, count: list.length, total: list.length, version: getTrainedVersion() });
});

// Fix duplicate/missing task numbers — renumber all trained tasks uniquely
// by trained date (oldest = #1). Safe to run anytime.
// ── COMPLAINTS ──────────────────────────────────────────────
// Client reports a wrong solve. Captures task #, object, how it was solved,
// and the original training so admin can compare & retrain.
app.post('/api/complaint', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  const client = getClientInfo(apiKey);
  if (!client) return res.status(401).json({ error: 'Invalid API key' });

  const { imageKey, objectName, taskNumber, solvedSquares, noObjectSolved, imageSrc } = req.body;
  if (!imageKey) return res.status(400).json({ error: 'Missing imageKey' });

  const complaints = getComplaints();

  // Store the RAW complaint exactly as the client reported it. We do NOT guess
  // the training here — matching is done at load time, ONLY by exact imageKey,
  // so we never show a different task that merely shares a number/name.
  const id = uuidv4();
  complaints[id] = {
    id,
    imageKey,
    objectName: objectName || '?',
    taskNumber: taskNumber || null,       // what the client saw at solve time
    imageSrc: imageSrc || '',             // the actual task image
    solvedSquares: solvedSquares || [],   // what the extension clicked
    noObjectSolved: !!noObjectSolved,
    clientName: client.name || '?',
    clientEmail: client.email || '',
    createdAt: new Date().toISOString(),
    status: 'open'
  };
  saveComplaints(complaints);
  res.json({ ok: true });
});

app.get('/admin/complaints', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const trained = getTrained();
  const squareKB = getSquareKB();

  const list = Object.values(getComplaints())
    .sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))
    .map(c => {
      // ONLY match by exact image fingerprint (imageKey). Matching by task
      // number or object name is WRONG — it picks a *different* task that
      // happens to share the number/name, showing misleading training.
      const t = trained[c.imageKey] || null;
      if (t) {
        // This exact image was trained as a full task — show that training.
        return {
          ...c,
          isTrained: true,
          solveType: 'full',
          trainedSquares: t.selectedSquares || [],
          trainedNoObject: !!t.noObject,
          gridRows: t.gridRows || c.gridRows || 3,
          gridCols: t.gridCols || c.gridCols || 3,
          taskNumber: t.taskNumber,
          imageSrc: c.imageSrc || t.imageSrc || ''
        };
      }
      // Not a full-image trained task → it was solved by PER-SQUARE matching.
      // There is no single "training" to show; flag it clearly.
      return { ...c, isTrained: false, solveType: 'per-square' };
    });

  res.json({ list, count: list.length });
});

app.delete('/admin/complaints/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const complaints = getComplaints();
  delete complaints[req.params.id];
  saveComplaints(complaints);
  res.json({ ok: true });
});

// Clear all resolved/all complaints
app.post('/admin/complaints/clear', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  saveComplaints({});
  res.json({ ok: true });
});

// ── COMPLAINTS END ──────────────────────────────────────────

app.post('/admin/renumber', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const kb = getKB();
  const trained = getTrained();
  const sqKB = getSquareKB();

  const entries = Object.values(trained)
    .sort((a,b) => new Date(a.trainedAt||0) - new Date(b.trainedAt||0));

  let n = 0;
  const remap = {};
  for (const e of entries) {
    n++;
    e.taskNumber = n;
    trained[e.imageKey] = e;
    if (kb[e.imageKey]) kb[e.imageKey].taskNumber = n;
    if (e.objectName) remap[e.objectName] = n;
  }

  for (const h of Object.keys(sqKB)) {
    const v = sqKB[h];
    if (v && typeof v === 'object' && v.name && remap[v.name] !== undefined) {
      v.num = remap[v.name];
    }
  }

  saveKB(kb); saveTrained(trained); saveSquareKB(sqKB);
  res.json({ ok: true, renumbered: n });
});

app.post('/admin/train', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { imageKey, imageSrc, objectName, taskText, selectedSquares,
          noObject, gridRows, gridCols, squarePHashes } = req.body;
  if (!imageKey) return res.status(400).json({ error: 'Missing imageKey' });

  const kb = getKB();
  const trained = getTrained();

  // Determine the task number:
  // - If this image was trained before, KEEP its existing number (retrain).
  // - Otherwise assign a NEW number = (highest number ever used) + 1.
  //   This stays unique even after deletes (never reuses a number).
  let taskNumber;
  if (kb[imageKey] && kb[imageKey].taskNumber) {
    taskNumber = kb[imageKey].taskNumber;
  } else if (trained[imageKey] && trained[imageKey].taskNumber) {
    taskNumber = trained[imageKey].taskNumber;
  } else {
    let maxNum = 0;
    for (const v of Object.values(kb)) if (v.taskNumber > maxNum) maxNum = v.taskNumber;
    for (const v of Object.values(trained)) if (v.taskNumber > maxNum) maxNum = v.taskNumber;
    taskNumber = maxNum + 1;
  }

  kb[imageKey] = { objectName:objectName||'', imageSrc:imageSrc||'',
    noObject:noObject||false, selectedSquares:selectedSquares||[],
    gridRows:gridRows||3, gridCols:gridCols||3,
    taskNumber, trainedAt:new Date().toISOString() };
  saveKB(kb);
  if (squarePHashes && Array.isArray(squarePHashes)) {
    const sqKB = getSquareKB();
    for (const item of squarePHashes) {
      if (item.hash) sqKB[item.hash] = item.isObject ? { name:objectName, num:taskNumber } : '__none__';
    }
    saveSquareKB(sqKB);
  }
  const unsolved = getUnsolved();
  if (unsolved[imageKey]) { unsolved[imageKey].status='trained'; saveUnsolved(unsolved); }
  trained[imageKey] = { imageKey, imageSrc, objectName, taskText,
    selectedSquares:selectedSquares||[], noObject:noObject||false,
    gridRows:gridRows||3, gridCols:gridCols||3,
    taskNumber, trainedAt:new Date().toISOString() };
  saveTrained(trained);
  res.json({ ok: true, taskNumber });
});

app.delete('/admin/trained/:key', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const key = decodeURIComponent(req.params.key);
  const kb = getKB(); const trained = getTrained();
  const objName = (kb[key]||{}).objectName;
  delete kb[key]; delete trained[key];
  saveKB(kb); saveTrained(trained);
  // Also remove orphaned pHash entries for this object from squareKB
  if (objName) {
    const sqKB = getSquareKB();
    let changed = false;
    for (const h of Object.keys(sqKB)) {
      const v = sqKB[h];
      if (v && typeof v === 'object' && v.name === objName) { delete sqKB[h]; changed = true; }
    }
    if (changed) saveSquareKB(sqKB);
  }
  // Reset unsolved status so it can be re-trained if seen again
  const unsolved = getUnsolved();
  if (unsolved[key]) { unsolved[key].status = 'unsolved'; saveUnsolved(unsolved); }
  res.json({ ok: true });
});

app.get('/admin/clients', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const clients = getClients(); const usage = getUsage(); const today = getTodayKey();
  for (const k of Object.keys(clients)) clients[k].usedToday = (usage[k]||{})[today]||0;
  res.json({ clients });
});

app.post('/admin/clients', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { name, plan, apiKey: providedKey } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const clients = getClients();
  // Use provided key from portal, or generate new one
  const apiKey = providedKey || ('sn_' + uuidv4().replace(/-/g,'').substring(0,24));
  clients[apiKey] = { name, apiKey, plan:plan||1000, active:true,
    createdAt:new Date().toISOString(), lastSeen:null };
  saveClients(clients);
  res.json({ ok:true, apiKey, name });
});

app.patch('/admin/clients/:apiKey', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const clients = getClients();
  if (!clients[req.params.apiKey]) return res.status(404).json({ error: 'Not found' });
  const { plan, active, name } = req.body;
  if (plan !== undefined) clients[req.params.apiKey].plan = plan;
  if (active !== undefined) clients[req.params.apiKey].active = active;
  if (name !== undefined) clients[req.params.apiKey].name = name;
  saveClients(clients);
  res.json({ ok: true });
});

app.delete('/admin/clients/:apiKey', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const clients = getClients();
  delete clients[req.params.apiKey];
  saveClients(clients);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SquareNet Server v2.1 on port ${PORT}`);
  try { console.log('Data files:', require('fs').readdirSync(DATA_DIR)); } catch(e) {}
});
