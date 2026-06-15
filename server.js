// server.js — SquareNet Central Server
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ── Data Storage (JSON files — no database needed) ──────────
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

// Files: clients.json, kb.json, unsolved.json, trained.json, square_kb.json
function getClients()   { return readJSON('clients.json'); }
function getKB()        { return readJSON('kb.json'); }
function getSquareKB()  { return readJSON('square_kb.json'); }
function getUnsolved()  { return readJSON('unsolved.json'); }
function getTrained()   { return readJSON('trained.json'); }

function saveClients(d)  { writeJSON('clients.json', d); }
function saveKB(d)       { writeJSON('kb.json', d); }
function saveSquareKB(d) { writeJSON('square_kb.json', d); }
function saveUnsolved(d) { writeJSON('unsolved.json', d); }
function saveTrained(d)  { writeJSON('trained.json', d); }

// ── Admin Password (set via env or default) ──────────────────
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

function isAdmin(req) {
  return req.headers['x-admin-pass'] === ADMIN_PASS;
}

function isValidClient(req) {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  if (!apiKey) return false;
  const clients = getClients();
  return !!clients[apiKey];
}

// ─────────────────────────────────────────────────────────────
// CLIENT API (Extension uses these)
// ─────────────────────────────────────────────────────────────

// Validate API key
app.get('/api/validate', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  const clients = getClients();
  if (!apiKey || !clients[apiKey]) {
    return res.json({ valid: false, error: 'Invalid API key' });
  }
  const client = clients[apiKey];
  client.lastSeen = new Date().toISOString();
  clients[apiKey] = client;
  saveClients(clients);
  res.json({ valid: true, name: client.name });
});

// Get full KB (trained data) — clients download this
app.get('/api/kb', (req, res) => {
  if (!isValidClient(req)) return res.status(401).json({ error: 'Invalid API key' });
  res.json({
    kb: getKB(),
    squareKB: getSquareKB(),
    updatedAt: new Date().toISOString()
  });
});

// Submit unsolved task for training
app.post('/api/unsolved', (req, res) => {
  if (!isValidClient(req)) return res.status(401).json({ error: 'Invalid API key' });
  
  const { imageKey, imageSrc, taskText, objectName, gridInfo, squareImages } = req.body;
  if (!imageKey || !imageSrc) return res.status(400).json({ error: 'Missing data' });

  const unsolved = getUnsolved();
  if (unsolved[imageKey]) {
    return res.json({ ok: true, status: 'already_exists' });
  }

  unsolved[imageKey] = {
    id: uuidv4(),
    imageKey,
    imageSrc,
    taskText: taskText || '',
    objectName: objectName || 'unknown',
    gridInfo: gridInfo || null,
    squareImages: squareImages || [],
    submittedAt: new Date().toISOString(),
    status: 'pending'
  };
  saveUnsolved(unsolved);
  res.json({ ok: true, status: 'saved' });
});

// ─────────────────────────────────────────────────────────────
// ADMIN API (Dashboard uses these)
// ─────────────────────────────────────────────────────────────

// Admin login check
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASS) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: 'Wrong password' });
  }
});

// Get all unsolved tasks
app.get('/admin/unsolved', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const unsolved = getUnsolved();
  const list = Object.values(unsolved)
    .filter(e => e.status === 'pending')
    .sort((a,b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  res.json({ list, count: list.length });
});

// Get all trained tasks
app.get('/admin/trained', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const trained = getTrained();
  const list = Object.values(trained)
    .sort((a,b) => new Date(b.trainedAt) - new Date(a.trainedAt));
  res.json({ list, count: list.length });
});

// Save trained task (from admin dashboard training)
app.post('/admin/train', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { imageKey, imageSrc, objectName, taskText, selectedSquares,
          noObject, gridRows, gridCols, squarePHashes, taskNumber } = req.body;

  if (!imageKey) return res.status(400).json({ error: 'Missing imageKey' });

  // Save to full KB
  const kb = getKB();
  kb[imageKey] = {
    objectName: objectName || '',
    imageSrc: imageSrc || '',
    noObject: noObject || false,
    selectedSquares: selectedSquares || [],
    gridRows: gridRows || 3,
    gridCols: gridCols || 3,
    taskNumber: taskNumber || 1,
    trainedAt: new Date().toISOString()
  };
  saveKB(kb);

  // Save per-square pHashes
  if (squarePHashes && Array.isArray(squarePHashes)) {
    const sqKB = getSquareKB();
    for (const item of squarePHashes) {
      if (item.hash) {
        sqKB[item.hash] = item.isObject
          ? { name: objectName, num: taskNumber }
          : '__none__';
      }
    }
    saveSquareKB(sqKB);
  }

  // Mark unsolved as trained
  const unsolved = getUnsolved();
  if (unsolved[imageKey]) {
    unsolved[imageKey].status = 'trained';
    saveUnsolved(unsolved);
  }

  // Save to trained list
  const trained = getTrained();
  trained[imageKey] = {
    imageKey, imageSrc, objectName, taskText,
    selectedSquares: selectedSquares || [],
    noObject: noObject || false,
    taskNumber: taskNumber || 1,
    trainedAt: new Date().toISOString()
  };
  saveTrained(trained);

  res.json({ ok: true });
});

// Delete trained task
app.delete('/admin/trained/:imageKey', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const key = decodeURIComponent(req.params.imageKey);
  const kb = getKB();
  const trained = getTrained();
  delete kb[key];
  delete trained[key];
  saveKB(kb);
  saveTrained(trained);
  res.json({ ok: true });
});

// Get stats
app.get('/admin/stats', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const unsolved = getUnsolved();
  const trained  = getTrained();
  const clients  = getClients();
  const sqKB     = getSquareKB();
  res.json({
    unsolved: Object.values(unsolved).filter(e => e.status === 'pending').length,
    trained:  Object.keys(trained).length,
    clients:  Object.keys(clients).length,
    squareKB: Object.keys(sqKB).length
  });
});

// ── Client Management ────────────────────────────────────────
// List clients
app.get('/admin/clients', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const clients = getClients();
  res.json({ clients });
});

// Create new client
app.post('/admin/clients', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const clients = getClients();
  const apiKey = 'sn_' + uuidv4().replace(/-/g,'').substring(0,24);
  clients[apiKey] = {
    name,
    apiKey,
    createdAt: new Date().toISOString(),
    lastSeen: null
  };
  saveClients(clients);
  res.json({ ok: true, apiKey, name });
});

// Delete client
app.delete('/admin/clients/:apiKey', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const clients = getClients();
  delete clients[req.params.apiKey];
  saveClients(clients);
  res.json({ ok: true });
});

// ── Server Start ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SquareNet Server running on port ${PORT}`);
  console.log(`Admin password: ${ADMIN_PASS}`);
});
