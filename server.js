// server.js — SquareNet Central Server v2.0
// Plan system: daily task limits per client
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
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function readJSON(file) {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return {};
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch(e) { return {}; }
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

const saveClients  = d => writeJSON('clients.json', d);
const saveKB       = d => writeJSON('kb.json', d);
const saveSquareKB = d => writeJSON('square_kb.json', d);
const saveUnsolved = d => writeJSON('unsolved.json', d);
const saveTrained  = d => writeJSON('trained.json', d);
const saveUsage    = d => writeJSON('usage.json', d);

const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

function isAdmin(req) {
  return req.headers['x-admin-pass'] === ADMIN_PASS;
}

// ── Usage/Plan helpers ───────────────────────────────────────
function getTodayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getClientUsage(apiKey) {
  const usage = getUsage();
  const today = getTodayKey();
  if (!usage[apiKey]) usage[apiKey] = {};
  if (!usage[apiKey][today]) usage[apiKey][today] = 0;
  return { usage, today, count: usage[apiKey][today] };
}

function incrementUsage(apiKey) {
  const { usage, today } = getClientUsage(apiKey);
  usage[apiKey][today] = (usage[apiKey][today] || 0) + 1;
  // Keep only last 7 days
  for (const key of Object.keys(usage[apiKey])) {
    const d = new Date(key);
    if ((Date.now() - d.getTime()) > 7 * 86400000) delete usage[apiKey][key];
  }
  saveUsage(usage);
  return usage[apiKey][today];
}

// ── Validate client + plan check ─────────────────────────────
function getClientInfo(apiKey) {
  if (!apiKey) return null;
  const clients = getClients();
  return clients[apiKey] || null;
}

// ── CLIENT API ───────────────────────────────────────────────

// Validate + get plan info
app.get('/api/validate', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  const client = getClientInfo(apiKey);
  if (!client) return res.json({ valid: false, error: 'Invalid API key' });

  // Update last seen
  const clients = getClients();
  clients[apiKey].lastSeen = new Date().toISOString();
  saveClients(clients);

  const { count } = getClientUsage(apiKey);
  const plan = client.plan || 1000;
  const remaining = Math.max(0, plan - count);

  // Reset time = midnight tonight
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const hoursLeft = Math.round((midnight - now) / 3600000);

  res.json({
    valid: true,
    name: client.name,
    plan: plan,
    usedToday: count,
    remaining: remaining,
    resetInHours: hoursLeft,
    active: client.active !== false
  });
});

// Get KB
app.get('/api/kb', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  const client = getClientInfo(apiKey);
  if (!client) return res.status(401).json({ error: 'Invalid API key' });
  res.json({ kb: getKB(), squareKB: getSquareKB(), updatedAt: new Date().toISOString() });
});

// Submit unsolved
app.post('/api/unsolved', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  const client = getClientInfo(apiKey);
  if (!client) return res.status(401).json({ error: 'Invalid API key' });

  const { imageKey, imageSrc, taskText, objectName, gridInfo, squareImages } = req.body;
  if (!imageKey || !imageSrc) return res.status(400).json({ error: 'Missing data' });

  const unsolved = getUnsolved();
  if (unsolved[imageKey]) return res.json({ ok: true, status: 'already_exists' });

  unsolved[imageKey] = {
    id: uuidv4(), imageKey, imageSrc,
    taskText: taskText || '', objectName: objectName || 'unknown',
    gridInfo: gridInfo || null, squareImages: squareImages || [],
    submittedBy: client.name,
    submittedAt: new Date().toISOString(), status: 'pending'
  };
  saveUnsolved(unsolved);

  // Track usage
  incrementUsage(apiKey);

  res.json({ ok: true, status: 'saved' });
});

// Report solved (client auto-solved from KB)
app.post('/api/solved', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  const client = getClientInfo(apiKey);
  if (!client) return res.status(401).json({ error: 'Invalid API key' });
  incrementUsage(apiKey);
  res.json({ ok: true });
});

// ── ADMIN API ────────────────────────────────────────────────

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  res.json({ ok: password === ADMIN_PASS, token: password === ADMIN_PASS ? ADMIN_PASS : null });
});

app.get('/admin/unsolved', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const unsolved = getUnsolved();
  const list = Object.values(unsolved).filter(e => e.status === 'pending')
    .sort((a,b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  res.json({ list, count: list.length });
});

app.get('/admin/trained', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const trained = getTrained();
  const list = Object.values(trained).sort((a,b) => new Date(b.trainedAt) - new Date(a.trainedAt));
  res.json({ list, count: list.length });
});

app.post('/admin/train', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { imageKey, imageSrc, objectName, taskText, selectedSquares,
          noObject, gridRows, gridCols, squarePHashes, taskNumber } = req.body;
  if (!imageKey) return res.status(400).json({ error: 'Missing imageKey' });

  const kb = getKB();
  kb[imageKey] = { objectName: objectName||'', imageSrc: imageSrc||'',
    noObject: noObject||false, selectedSquares: selectedSquares||[],
    gridRows: gridRows||3, gridCols: gridCols||3,
    taskNumber: taskNumber||1, trainedAt: new Date().toISOString() };
  saveKB(kb);

  if (squarePHashes && Array.isArray(squarePHashes)) {
    const sqKB = getSquareKB();
    for (const item of squarePHashes) {
      if (item.hash) sqKB[item.hash] = item.isObject ? { name: objectName, num: taskNumber } : '__none__';
    }
    saveSquareKB(sqKB);
  }

  const unsolved = getUnsolved();
  if (unsolved[imageKey]) { unsolved[imageKey].status = 'trained'; saveUnsolved(unsolved); }

  const trained = getTrained();
  trained[imageKey] = { imageKey, imageSrc, objectName, taskText,
    selectedSquares: selectedSquares||[], noObject: noObject||false,
    taskNumber: taskNumber||1, trainedAt: new Date().toISOString() };
  saveTrained(trained);
  res.json({ ok: true });
});

app.delete('/admin/trained/:key', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const key = decodeURIComponent(req.params.key);
  const kb = getKB(); const trained = getTrained();
  delete kb[key]; delete trained[key];
  saveKB(kb); saveTrained(trained);
  res.json({ ok: true });
});

app.get('/admin/stats', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const unsolved = getUnsolved(); const trained = getTrained();
  const clients = getClients(); const sqKB = getSquareKB();
  const usage = getUsage(); const today = getTodayKey();
  let totalToday = 0;
  for (const k of Object.keys(usage)) totalToday += (usage[k][today] || 0);
  res.json({
    unsolved: Object.values(unsolved).filter(e => e.status==='pending').length,
    trained: Object.keys(trained).length, clients: Object.keys(clients).length,
    squareKB: Object.keys(sqKB).length, tasksToday: totalToday
  });
});

app.get('/admin/clients', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const clients = getClients(); const usage = getUsage(); const today = getTodayKey();
  // Add today's usage to each client
  for (const k of Object.keys(clients)) {
    clients[k].usedToday = (usage[k] || {})[today] || 0;
  }
  res.json({ clients });
});

app.post('/admin/clients', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { name, plan } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const clients = getClients();
  const apiKey = 'sn_' + uuidv4().replace(/-/g,'').substring(0,24);
  clients[apiKey] = { name, apiKey, plan: plan||1000, active: true,
    createdAt: new Date().toISOString(), lastSeen: null };
  saveClients(clients);
  res.json({ ok: true, apiKey, name });
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

// Auto-create default client from env variable
const DEFAULT_KEY = process.env.DEFAULT_CLIENT_KEY;
if (DEFAULT_KEY) {
  const clients = getClients();
  if (!clients[DEFAULT_KEY]) {
    clients[DEFAULT_KEY] = {
      name: process.env.DEFAULT_CLIENT_NAME || 'Admin',
      apiKey: DEFAULT_KEY,
      plan: 9999999,
      active: true,
      createdAt: new Date().toISOString(),
      lastSeen: null
    };
    saveClients(clients);
    console.log('Default client created:', DEFAULT_KEY);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SquareNet Server v2.1 on port ${PORT}`);
  console.log(`Admin pass: ${ADMIN_PASS}`);
  console.log(`Data dir: ${DATA_DIR}`);
  // Log what's in data dir
  try {
    const files = require('fs').readdirSync(DATA_DIR);
    console.log('Data files:', files);
  } catch(e) { console.log('Data dir empty or missing'); }
});
