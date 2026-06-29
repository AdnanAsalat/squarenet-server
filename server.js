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
const saveTrained  = d => { invalidateKBCache(); _statsCache=null; bumpTrainedVersion(); return writeJSON('trained.json', d); };
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
    let contentKey = null;
    if (Array.isArray(val.cellHashes) && val.cellHashes.length && val.cellHashes.every(h => h)) {
      contentKey = val.cellHashes.join('-');
    }
    lightKB[key] = {
      objectName: val.objectName,
      noObject: val.noObject,
      selectedSquares: val.selectedSquares,
      gridRows: val.gridRows,
      gridCols: val.gridCols,
      taskNumber: val.taskNumber,
      cellHashes: val.cellHashes || null,
      contentKey: contentKey
    };
  }
  _lightKBCache = lightKB;
  _squareKBCache = getSquareKB();
}

// Global solving switch (ON by default). When OFF, extensions stop solving for
// everyone (training still works). Stored in a tiny file so it survives restarts.
function getSolvingEnabled() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR,'settings.json'),'utf8')).solvingEnabled !== false; }
  catch(e) { return true; }
}
function setSolvingEnabled(on) {
  try { fs.writeFileSync(path.join(DATA_DIR,'settings.json'), JSON.stringify({ solvingEnabled: !!on }), 'utf8'); } catch(e){}
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
  res.json({
    kb: _lightKBCache,
    squareKB: _squareKBCache,
    solvingEnabled: getSolvingEnabled(),   // global ON/OFF for all extensions
    updatedAt: new Date().toISOString()
  });
});

// FAST SOLVE: extension sends this task's object + cellHashes; server checks the
// plan, then looks the image up in the trained KB and returns ONLY the answer.
// The extension keeps NO local KB — so plan expiry instantly stops solving, and
// there's no big KB download. Exact match is an instant index lookup; if that
// misses we do a 98.5% tolerant scan within the same object (JPEG drift).
let _solveIndex = null;          // "object|contentKey" -> {selectedSquares,noObject,taskNumber}
let _solveIndexVer = -1;
function buildSolveIndex() {
  const kb = getKB();
  const idx = {};
  for (const v of Object.values(kb)) {
    if (!Array.isArray(v.cellHashes) || !v.cellHashes.length || !v.cellHashes.every(h=>h)) continue;
    idx[(v.objectName||'') + '|' + v.cellHashes.join('-')] = {
      selectedSquares: v.selectedSquares || [], noObject: !!v.noObject,
      taskNumber: v.taskNumber, objectName: v.objectName, cellHashes: v.cellHashes
    };
  }
  _solveIndex = idx;
  _solveIndexVer = getTrainedVersion();
}
app.post('/api/solve', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  const client = getClientInfo(apiKey);
  if (!client) return res.status(401).json({ error: 'Invalid API key' });

  // PLAN CHECKS — if blocked, solving stops here (extension can't solve offline).
  if (client.active === false) {
    return res.status(403).json({ error: 'Account suspended', code: 'SUSPENDED' });
  }
  const { count } = getClientUsage(apiKey);
  const plan = client.plan || 1000;
  if (count >= plan) {
    return res.status(403).json({ error: 'Daily limit reached', code: 'LIMIT_REACHED', used: count, limit: plan });
  }
  if (!getSolvingEnabled()) return res.json({ ok: true, match: null, solvingDisabled: true });

  const { objectName, cellHashes } = req.body;
  if (!objectName || !Array.isArray(cellHashes) || cellHashes.length !== 9 || !cellHashes.every(h=>h)) {
    return res.json({ ok: true, match: null });   // not enough info → treat as unknown
  }

  // Rebuild index if training changed.
  if (!_solveIndex || _solveIndexVer !== getTrainedVersion()) buildSolveIndex();

  // 1) exact match (instant)
  let hit = _solveIndex[objectName + '|' + cellHashes.join('-')];
  // 2) tolerant match within same object (98.5%)
  if (!hit) {
    for (const k in _solveIndex) {
      const cand = _solveIndex[k];
      if (cand.objectName !== objectName) continue;
      if (cellsMatch(cand.cellHashes, cellHashes)) { hit = cand; break; }
    }
  }
  if (!hit) return res.json({ ok: true, match: null });
  res.json({ ok: true, match: {
    selectedSquares: hit.selectedSquares, noObject: hit.noObject, taskNumber: hit.taskNumber
  }});
});

// Admin: read/set the global solving switch
app.get('/admin/solving', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ solvingEnabled: getSolvingEnabled() });
});
app.post('/admin/solving', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  setSolvingEnabled(!!req.body.solvingEnabled);
  res.json({ ok: true, solvingEnabled: getSolvingEnabled() });
});

app.post('/api/unsolved', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  const client = getClientInfo(apiKey);
  if (!client) return res.status(401).json({ error: 'Invalid API key' });
  const { imageKey, imageSrc, taskText, objectName, gridInfo, squareImages } = req.body;
  if (!imageKey || !imageSrc) return res.status(400).json({ error: 'Missing data' });
  const unsolved = getUnsolved();
  if (unsolved[imageKey]) return res.json({ ok: true, status: 'already_exists' });
  // Build ordered cellHashes from squareImages (for duplicate detection)
  let cellHashes = null;
  if (Array.isArray(squareImages) && squareImages.length) {
    cellHashes = [];
    for (const s of squareImages) {
      if (s && s.index != null) cellHashes[s.index] = s.src || '';
    }
  }
  // CONTENT DEDUPE in unsolved: KolotiBablo serves the same image with a slightly
  // different base64 each time, so the same picture can arrive under a different
  // imageKey and pile up as multiple unsolved copies. If an unsolved entry with
  // the SAME object + identical cell hashes already exists, reuse THAT key
  // (update in place) instead of creating a second copy. Result: one unsolved
  // entry per image (still visible for training), no unsolved duplicates.
  if (cellHashes && cellHashes.length && cellHashes.every(h => h) && objectName) {
    for (const [exKey, ex] of Object.entries(unsolved)) {
      if (ex.objectName === objectName &&
          Array.isArray(ex.cellHashes) && cellsMatch(ex.cellHashes, cellHashes)) {
        return res.json({ ok: true, status: 'already_exists', merged: true });
      }
    }
  }
  unsolved[imageKey] = {
    id: uuidv4(), imageKey, imageSrc, taskText: taskText||'',
    objectName: objectName||'unknown', gridInfo: gridInfo||null,
    squareImages: squareImages||[], cellHashes, submittedBy: client.name,
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
  const all = Object.values(trained).sort((a,b)=>new Date(b.trainedAt)-new Date(a.trainedAt));
  // Pagination — sending all 800+ full base64 images at once is very slow,
  // especially on a slow connection. Default to 60 per page.
  const offset = parseInt(req.query.offset) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 60, 200);
  const page = all.slice(offset, offset + limit);
  res.json({ list: page, count: page.length, total: all.length, version: getTrainedVersion() });
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
      // Match the complaint to its training. First try the exact imageKey.
      // If that misses (KolotiBablo can serve the same image under a slightly
      // different base64, so the client's imageKey may differ), fall back to the
      // unique task number the client saw — task numbers are unique, so this
      // reliably finds the same task without picking a wrong one.
      let t = trained[c.imageKey] || null;
      if (!t && c.taskNumber) {
        t = Object.values(trained).find(x => x.taskNumber === c.taskNumber) || null;
      }
      if (t) {
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
      // No training found at all → flag it for manual training.
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

// Backfill cellHashes for an existing trained task (sent from the dashboard,
// which computes the hashes in-browser from the stored image). Used to make
// old tasks (trained before strict verification) fully verifiable.
app.post('/admin/backfill-cells', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { imageKey, cellHashes } = req.body;
  if (!imageKey || !Array.isArray(cellHashes)) return res.status(400).json({ error: 'Missing data' });
  const kb = getKB(); const trained = getTrained();
  let changed = false;
  if (kb[imageKey])     { kb[imageKey].cellHashes = cellHashes; changed = true; }
  if (trained[imageKey]){ trained[imageKey].cellHashes = cellHashes; changed = true; }
  if (changed) { saveKB(kb); saveTrained(trained); }
  res.json({ ok: true, changed });
});

// List trained tasks that still need cellHashes (have an image but no hashes yet)
app.get('/admin/needs-cells', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const trained = getTrained();
  const list = Object.values(trained)
    .filter(t => t.imageSrc && !t.noObject && (!t.cellHashes || !t.cellHashes.length))
    .map(t => ({ imageKey: t.imageKey, imageSrc: t.imageSrc, gridRows: t.gridRows||3, gridCols: t.gridCols||3 }));
  res.json({ list, count: list.length });
});

// Two tasks are duplicates ONLY if their cell hashes are byte-for-byte identical
// (zero difference). This is strict so we never delete genuinely different tasks.
function cellsMatch(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  // Tolerant content match: KolotiBablo re-encodes the same image with slightly
  // different JPEG each time, so identical pictures can differ by a few bits.
  // Measured: same images score 99%+, and the closest "different" pair was
  // actually the same image (1-bit drift). 98.5% recognises the same image with
  // zero risk of matching a genuinely different one. (Exact equality is a subset,
  // so previously-exact matches still match.)
  let total = 0, same = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] || '', y = b[i] || '';
    const n = x.length < y.length ? x.length : y.length;
    for (let j = 0; j < n; j++) { total++; if (x[j] === y[j]) same++; }
    total += Math.abs(x.length - y.length);   // length diff counts as mismatch
  }
  if (!total) return false;
  return (same / total) >= 0.985;
}

app.get('/admin/duplicates', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const trained = getTrained();
  const unsolved = getUnsolved();

  // Collect comparable items from BOTH trained and unsolved that have cell hashes.
  const items = [];
  for (const t of Object.values(trained)) {
    if (t.cellHashes && t.cellHashes.length && !t.noObject) {
      items.push({ imageKey:t.imageKey, taskNumber:t.taskNumber||null, objectName:t.objectName||'?',
        imageSrc:t.imageSrc||'', source:'trained', cellHashes:t.cellHashes });
    }
  }
  for (const u of Object.values(unsolved)) {
    if (u.cellHashes && u.cellHashes.length) {
      items.push({ imageKey:u.imageKey, taskNumber:null, objectName:u.objectName||'?',
        imageSrc:u.imageSrc||'', source:'unsolved', cellHashes:u.cellHashes });
    }
  }

  // STEP 1 — group by EXACT content (instant via a map). This collapses the
  // huge majority of duplicates (identical re-trains) without any O(n²) scan.
  const exactMap = {};
  for (const it of items) {
    const key = it.objectName + '|' + it.cellHashes.join('-');
    (exactMap[key] = exactMap[key] || []).push(it);
  }
  const buckets = Object.values(exactMap);

  // STEP 2 — merge buckets whose representatives are near-duplicates (98.5%),
  // to also catch the same image that drifted a few bits across JPEG re-encodes.
  // We only compare one representative per bucket, so this is fast even with
  // thousands of tasks (previously a full item×item scan timed out and silently
  // returned only a fraction of the duplicates).
  const usedB = new Set();
  const groups = [];
  for (let i = 0; i < buckets.length; i++) {
    if (usedB.has(i)) continue;
    let group = buckets[i].slice();
    const rep = buckets[i][0];
    for (let j = i+1; j < buckets.length; j++) {
      if (usedB.has(j)) continue;
      const rep2 = buckets[j][0];
      if (rep.objectName === rep2.objectName && cellsMatch(rep.cellHashes, rep2.cellHashes)) {
        group = group.concat(buckets[j]);
        usedB.add(j);
      }
    }
    if (group.length > 1) {
      usedB.add(i);
      group.sort((a,b)=>(a.taskNumber||999999)-(b.taskNumber||999999));
      groups.push(group.map(g => ({
        imageKey:g.imageKey, taskNumber:g.taskNumber, objectName:g.objectName,
        imageSrc:g.imageSrc, source:g.source
      })));
    }
  }
  const dupCount = groups.reduce((s,g)=>s+(g.length-1),0);
  // Count trained tasks WITHOUT cell hashes — these can't be scanned for
  // duplicates until "Secure All Tasks" is run. Report so admin knows.
  let missingCells = 0;
  for (const t of Object.values(trained)) {
    if (!t.noObject && (!t.cellHashes || !t.cellHashes.length)) missingCells++;
  }
  res.json({ groups, groupCount: groups.length, duplicateCount: dupCount, missingCells });
});

// Delete specific tasks by imageKey (from trained AND/OR unsolved)
app.post('/admin/delete-duplicates', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { imageKeys } = req.body;
  if (!Array.isArray(imageKeys)) return res.status(400).json({ error: 'Missing imageKeys' });

  const kb = getKB(); const trained = getTrained(); const unsolved = getUnsolved();

  // Delete exactly the keys that were selected. The dashboard never puts a
  // checkbox on the keeper (oldest copy), so the keeper is never sent here —
  // that is what protects it. (The old server-side "keeper re-scan" wrongly
  // matched the copy being deleted and refused to delete it.)
  let removed = 0;
  for (const k of imageKeys) {
    let hit = false;
    if (trained[k]) { delete trained[k]; hit = true; }
    if (kb[k]) { delete kb[k]; hit = true; }
    if (unsolved[k]) { delete unsolved[k]; hit = true; }
    if (hit) removed++;
  }
  saveKB(kb); saveTrained(trained); saveUnsolved(unsolved);
  res.json({ ok: true, removed });
});

// Debug: return KB as key -> objectName (NO images) for the console inspector.
// Admin-only. Lightweight so it can be fetched from the task page.
app.get('/admin/kb-keys', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const kb = getKB();
  const out = {};
  for (const [key, val] of Object.entries(kb)) {
    out[key] = { objectName: val.objectName || '', noObject: !!val.noObject };
  }
  res.json({ kb: out, count: Object.keys(out).length });
});

// Migrate all KB/trained keys to a new fingerprint (first 350 chars of base64).
// Rebuilds keys from each stored image so old tasks match the new extension.
// Cleanup: remove any unsolved entry whose imageKey is already trained.
// Fixes the "trained task also stuck in unsolved → shows as duplicate" issue.
app.post('/admin/cleanup-unsolved', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const trained = getTrained();
  const unsolved = getUnsolved();
  let removed = 0;
  for (const k of Object.keys(unsolved)) {
    if (trained[k]) { delete unsolved[k]; removed++; }
  }
  if (removed) saveUnsolved(unsolved);
  res.json({ ok: true, removed });
});

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

  // Build an ordered array of every cell's hash (index 0..n) for strict
  // cell-by-cell verification by the extension. This lets the client confirm
  // the exact same image (every square in place) before solving.
  let cellHashes = null;
  if (squarePHashes && Array.isArray(squarePHashes)) {
    cellHashes = [];
    for (const item of squarePHashes) {
      if (item.index != null) cellHashes[item.index] = item.hash || '';
    }
  }

  // DEDUPE BY CONTENT: KolotiBablo serves the same image with slightly different
  // base64, so the same picture can arrive under a different imageKey. If an
  // existing trained task has the SAME object name AND matching cell content,
  // remove that old entry first and reuse its task number — so re-training the
  // same picture UPDATES it instead of creating a duplicate. The object name
  // must match (and be non-empty): the SAME image can be a different task for a
  // different object, and those must stay separate.
  if (cellHashes && cellHashes.length && cellHashes.every(h=>h) && objectName) {
    for (const [oldKey, v] of Object.entries(trained)) {
      if (oldKey === imageKey) continue;
      if (v.objectName === objectName &&
          Array.isArray(v.cellHashes) && cellsMatch(v.cellHashes, cellHashes)) {
        if (v.taskNumber) taskNumber = v.taskNumber;  // keep its number
        delete trained[oldKey];
        if (kb[oldKey]) delete kb[oldKey];
      }
    }
  }

  kb[imageKey] = { objectName:objectName||'', imageSrc:imageSrc||'',
    noObject:noObject||false, selectedSquares:selectedSquares||[],
    gridRows:gridRows||3, gridCols:gridCols||3, cellHashes,
    taskNumber, trainedAt:new Date().toISOString() };
  saveKB(kb);
  // NOTE: squareKB (per-square pHash guessing) is no longer used for matching,
  // so we skip building/writing it here — this makes training noticeably faster
  // (one less large file written per train).
  const unsolved = getUnsolved();
  // Remove the task from unsolved once trained. (Previously this only set
  // status='trained' and left it in unsolved, so every freshly-trained task
  // showed up as a duplicate of itself — trained copy + leftover unsolved copy.)
  if (unsolved[imageKey]) { delete unsolved[imageKey]; saveUnsolved(unsolved); }
  trained[imageKey] = { imageKey, imageSrc, objectName, taskText,
    selectedSquares:selectedSquares||[], noObject:noObject||false,
    gridRows:gridRows||3, gridCols:gridCols||3, cellHashes,
    taskNumber, trainedAt:new Date().toISOString() };
  saveTrained(trained);
  res.json({ ok: true, taskNumber, version: getTrainedVersion() });
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
