'use strict';
const express  = require('express');
const multer   = require('multer');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Database ─────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'orders.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   TEXT    NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'Pending',
    notes        TEXT,
    items        TEXT    NOT NULL,
    total_amount REAL    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS order_files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      INTEGER NOT NULL,
    cart_item_idx INTEGER NOT NULL,
    cart_item_name TEXT,
    filename      TEXT    NOT NULL,
    original_name TEXT    NOT NULL,
    size_bytes    INTEGER,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
  );
`);

// ── File Storage ──────────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => {
    const uid = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uid + '.stl');
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.stl')) cb(null, true);
    else cb(new Error('Only .stl files are accepted'));
  },
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB per file
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(__dirname));   // serves quote.html, admin.html, etc.

// ── API ───────────────────────────────────────────────────────────────────────

// POST /api/orders  — create new order
app.post('/api/orders', upload.any(), (req, res) => {
  let orderData;
  try {
    orderData = JSON.parse(req.body.data);
  } catch {
    return res.status(400).json({ error: 'Invalid order data JSON' });
  }

  const { items, notes, total } = orderData;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order must contain at least one item' });
  }

  const insertOrder = db.prepare(`
    INSERT INTO orders (created_at, status, notes, items, total_amount)
    VALUES (?, 'Pending', ?, ?, ?)
  `);
  const insertFile = db.prepare(`
    INSERT INTO order_files (order_id, cart_item_idx, cart_item_name, filename, original_name, size_bytes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const txn = db.transaction(() => {
    const { lastInsertRowid: orderId } = insertOrder.run(
      new Date().toISOString(),
      notes || '',
      JSON.stringify(items),
      parseFloat(total) || 0
    );

    for (const file of (req.files || [])) {
      const idx = parseInt(file.fieldname.replace('stl_', ''), 10);
      const itemName = (items[idx] && items[idx].name) || file.originalname;
      insertFile.run(orderId, idx, itemName, file.filename, file.originalname, file.size);
    }

    return orderId;
  });

  try {
    const orderId = txn();
    res.json({ success: true, orderId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders  — list all orders (newest first)
app.get('/api/orders', (_req, res) => {
  const orders = db.prepare(`
    SELECT o.*,
           COUNT(f.id) AS file_count
    FROM orders o
    LEFT JOIN order_files f ON f.order_id = o.id
    GROUP BY o.id
    ORDER BY o.created_at DESC
  `).all();
  res.json(orders);
});

// GET /api/orders/:id  — single order with files
app.get('/api/orders/:id', (req, res) => {
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const files = db.prepare(`SELECT * FROM order_files WHERE order_id = ? ORDER BY cart_item_idx`).all(req.params.id);
  order.items = JSON.parse(order.items);
  res.json({ ...order, files });
});

// PATCH /api/orders/:id/status  — update status
const VALID_STATUSES = ['Pending', 'Confirmed', 'Printing', 'Quality Check', 'Shipped', 'Complete', 'Cancelled'];
app.patch('/api/orders/:id/status', (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${VALID_STATUSES.join(', ')}` });
  }
  const info = db.prepare(`UPDATE orders SET status = ? WHERE id = ?`).run(status, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Order not found' });
  res.json({ success: true });
});

// GET /api/orders/:id/files/:fileId  — download STL
app.get('/api/orders/:id/files/:fileId', (req, res) => {
  const file = db.prepare(`
    SELECT * FROM order_files WHERE id = ? AND order_id = ?
  `).get(req.params.fileId, req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  const filePath = path.join(uploadDir, file.filename);
  if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'File no longer on disk' });
  res.download(filePath, file.original_name);
});

// DELETE /api/orders/:id  — delete an order and its files
app.delete('/api/orders/:id', (req, res) => {
  const files = db.prepare(`SELECT filename FROM order_files WHERE order_id = ?`).all(req.params.id);
  db.prepare(`DELETE FROM orders WHERE id = ?`).run(req.params.id);
  for (const f of files) {
    const fp = path.join(uploadDir, f.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  res.json({ success: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  3DPrintFactory server running`);
  console.log(`  Quote tool : http://localhost:${PORT}/quote.html`);
  console.log(`  Admin      : http://localhost:${PORT}/admin.html\n`);
});
