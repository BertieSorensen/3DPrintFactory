'use strict';
const express  = require('express');
const multer   = require('multer');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const Stripe   = require('stripe');

const app    = express();
const PORT   = process.env.PORT || 3000;
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

// ── Database ─────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'orders.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    NOT NULL UNIQUE,
    first_name TEXT    NOT NULL,
    last_name  TEXT    NOT NULL,
    phone      TEXT,
    address1   TEXT,
    address2   TEXT,
    city       TEXT,
    postcode   TEXT,
    country    TEXT    DEFAULT 'GB',
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at               TEXT    NOT NULL,
    status                   TEXT    NOT NULL DEFAULT 'Pending',
    notes                    TEXT,
    items                    TEXT    NOT NULL,
    total_amount             REAL    NOT NULL,
    customer_id              INTEGER REFERENCES customers(id),
    stripe_payment_intent_id TEXT,
    stripe_payment_status    TEXT
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

// Migrate existing orders table if it lacks the new columns
const orderCols = db.pragma('table_info(orders)').map(c => c.name);
if (!orderCols.includes('customer_id')) {
  db.exec('ALTER TABLE orders ADD COLUMN customer_id INTEGER REFERENCES customers(id)');
}
if (!orderCols.includes('stripe_payment_intent_id')) {
  db.exec('ALTER TABLE orders ADD COLUMN stripe_payment_intent_id TEXT');
}
if (!orderCols.includes('stripe_payment_status')) {
  db.exec('ALTER TABLE orders ADD COLUMN stripe_payment_status TEXT');
}

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
  limits: { fileSize: 200 * 1024 * 1024 },
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(__dirname));

// ── Stripe config ─────────────────────────────────────────────────────────────
app.get('/api/stripe-config', (_req, res) => {
  if (!process.env.STRIPE_PUBLISHABLE_KEY) return res.json({ enabled: false });
  res.json({ enabled: true, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// POST /api/create-payment-intent
app.post('/api/create-payment-intent', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payment processing not configured' });
  const { amount_pence } = req.body;
  if (!Number.isInteger(amount_pence) || amount_pence < 30) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  try {
    const pi = await stripe.paymentIntents.create({
      amount: amount_pence,
      currency: 'gbp',
      automatic_payment_methods: { enabled: true },
    });
    res.json({ clientSecret: pi.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Customer helpers ──────────────────────────────────────────────────────────
function upsertCustomer(customer) {
  const now   = new Date().toISOString();
  const email = customer.email.toLowerCase().trim();
  const existing = db.prepare('SELECT id FROM customers WHERE email = ?').get(email);
  if (existing) {
    db.prepare(`
      UPDATE customers
      SET first_name=?, last_name=?, phone=?, address1=?, address2=?,
          city=?, postcode=?, country=?, updated_at=?
      WHERE id=?
    `).run(
      customer.firstName, customer.lastName, customer.phone || '',
      customer.address1, customer.address2 || '', customer.city,
      customer.postcode, customer.country || 'GB', now, existing.id
    );
    return existing.id;
  }
  const result = db.prepare(`
    INSERT INTO customers (email, first_name, last_name, phone, address1, address2, city, postcode, country, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    email, customer.firstName, customer.lastName, customer.phone || '',
    customer.address1, customer.address2 || '', customer.city,
    customer.postcode, customer.country || 'GB', now, now
  );
  return result.lastInsertRowid;
}

// ── API ───────────────────────────────────────────────────────────────────────

// POST /api/orders
app.post('/api/orders', upload.any(), async (req, res) => {
  let orderData;
  try {
    orderData = JSON.parse(req.body.data);
  } catch {
    return res.status(400).json({ error: 'Invalid order data JSON' });
  }

  const { items, notes, total, customer, stripePaymentIntentId } = orderData;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order must contain at least one item' });
  }

  // Verify Stripe payment when an intent ID is provided
  let stripeStatus = null;
  if (stripePaymentIntentId) {
    if (!stripe) return res.status(503).json({ error: 'Payment processing not configured on server' });
    try {
      const pi = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
      if (pi.status !== 'succeeded') {
        return res.status(402).json({ error: `Payment not completed (status: ${pi.status})` });
      }
      stripeStatus = pi.status;
    } catch (err) {
      return res.status(400).json({ error: 'Could not verify payment: ' + err.message });
    }
  }

  const insertOrder = db.prepare(`
    INSERT INTO orders (created_at, status, notes, items, total_amount, customer_id, stripe_payment_intent_id, stripe_payment_status)
    VALUES (?, 'Pending', ?, ?, ?, ?, ?, ?)
  `);
  const insertFile = db.prepare(`
    INSERT INTO order_files (order_id, cart_item_idx, cart_item_name, filename, original_name, size_bytes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const txn = db.transaction(() => {
    const customerId = (customer && customer.email) ? upsertCustomer(customer) : null;

    const { lastInsertRowid: orderId } = insertOrder.run(
      new Date().toISOString(),
      notes || '',
      JSON.stringify(items),
      parseFloat(total) || 0,
      customerId,
      stripePaymentIntentId || null,
      stripeStatus
    );

    for (const file of (req.files || [])) {
      const idx      = parseInt(file.fieldname.replace('stl_', ''), 10);
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

// GET /api/orders — list all orders (newest first)
app.get('/api/orders', (_req, res) => {
  const orders = db.prepare(`
    SELECT o.*,
           COUNT(f.id) AS file_count,
           c.first_name  AS customer_first_name,
           c.last_name   AS customer_last_name,
           c.email       AS customer_email
    FROM orders o
    LEFT JOIN order_files f ON f.order_id = o.id
    LEFT JOIN customers   c ON c.id = o.customer_id
    GROUP BY o.id
    ORDER BY o.created_at DESC
  `).all();
  res.json(orders);
});

// GET /api/orders/:id — single order with files and customer
app.get('/api/orders/:id', (req, res) => {
  const order = db.prepare(`
    SELECT o.*,
           c.first_name AS customer_first_name,
           c.last_name  AS customer_last_name,
           c.email      AS customer_email,
           c.phone      AS customer_phone,
           c.address1   AS customer_address1,
           c.address2   AS customer_address2,
           c.city       AS customer_city,
           c.postcode   AS customer_postcode,
           c.country    AS customer_country
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    WHERE o.id = ?
  `).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const files = db.prepare(`SELECT * FROM order_files WHERE order_id = ? ORDER BY cart_item_idx`).all(req.params.id);
  order.items = JSON.parse(order.items);
  res.json({ ...order, files });
});

// PATCH /api/orders/:id/status
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

// GET /api/orders/:id/files/:fileId — download STL
app.get('/api/orders/:id/files/:fileId', (req, res) => {
  const file = db.prepare(`SELECT * FROM order_files WHERE id = ? AND order_id = ?`).get(req.params.fileId, req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  const filePath = path.join(uploadDir, file.filename);
  if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'File no longer on disk' });
  res.download(filePath, file.original_name);
});

// DELETE /api/orders/:id
app.delete('/api/orders/:id', (req, res) => {
  const files = db.prepare(`SELECT filename FROM order_files WHERE order_id = ?`).all(req.params.id);
  db.prepare(`DELETE FROM orders WHERE id = ?`).run(req.params.id);
  for (const f of files) {
    const fp = path.join(uploadDir, f.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  res.json({ success: true });
});

// GET /api/customers — list all customers with order stats
app.get('/api/customers', (_req, res) => {
  const customers = db.prepare(`
    SELECT c.*,
           COUNT(o.id)                    AS order_count,
           COALESCE(SUM(o.total_amount), 0) AS total_spent
    FROM customers c
    LEFT JOIN orders o ON o.customer_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `).all();
  res.json(customers);
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  3DPrintFactory server running`);
  console.log(`  Quote tool : http://localhost:${PORT}/quote.html`);
  console.log(`  Admin      : http://localhost:${PORT}/admin.html`);
  console.log(`  Stripe     : ${stripe ? 'configured' : 'not configured (invoice mode)'}\n`);
});
