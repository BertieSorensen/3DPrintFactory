/**
 * 3DPrintFactory — Shared Cart Module
 *
 * Manages cart state in localStorage, shared between the quote and checkout pages.
 * All user-provided strings are sanitised before being stored or rendered.
 */

'use strict';

const CART_KEY      = '3dpf_cart';
const SETUP_FEE     = 2.50;
const MAX_QTY       = 999;
const MAX_FILE_SIZE = 52_428_800; // 50 MB

/* ── Materials ─────────────────────────────────────────────────────────────── */
const MATERIALS = {
  PLA:  { price: 0.05, density: 1.24, label: 'PLA',  desc: 'Standard & biodegradable' },
  PETG: { price: 0.07, density: 1.27, label: 'PETG', desc: 'Durable & food-safe' },
  ABS:  { price: 0.06, density: 1.05, label: 'ABS',  desc: 'Heat & impact resistant' },
  TPU:  { price: 0.10, density: 1.21, label: 'TPU',  desc: 'Flexible & rubber-like' },
};

/* ── HTML Escaping ──────────────────────────────────────────────────────────── */
/**
 * Escape a string for safe insertion into HTML.
 * Uses the browser's own serialiser — no hand-rolled regexes.
 */
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

/* ── Delivery Estimate ──────────────────────────────────────────────────────── */
/**
 * Returns { courier, cost, totalWeightG } for the combined effective volume.
 * Rates: Royal Mail Tracked 48 (≤2 kg) / Evri Standard (>2 kg).
 */
function deliveryEstimate(effVolCm3, materialKey) {
  const mat = MATERIALS[materialKey] ?? MATERIALS.PLA;
  const printWeightG  = effVolCm3 * mat.density;
  const totalWeightG  = printWeightG + 300; // +300 g packaging
  const totalWeightKg = totalWeightG / 1000;

  let courier, cost;
  if (totalWeightKg <= 2) {
    courier = 'Royal Mail Tracked 48';
    cost    = 6.33;
  } else if (totalWeightKg <= 5) {
    courier = 'Evri Standard';
    cost    = 4.49;
  } else if (totalWeightKg <= 10) {
    courier = 'Evri Standard';
    cost    = 5.99;
  } else if (totalWeightKg <= 15) {
    courier = 'Evri Standard';
    cost    = 7.49;
  } else {
    courier = 'Evri Standard';
    cost    = 9.99;
  }

  return { courier, cost, totalWeightG: Math.round(totalWeightG) };
}

/* ── Cart Calculations ──────────────────────────────────────────────────────── */
function cartMaterialTotal(cart) {
  return cart.reduce((sum, item) => sum + item.matCostPerUnit * item.qty, 0);
}

function cartDeliveryAndSetup(cart) {
  if (cart.length === 0) return { setup: 0, delivery: 0, courier: '', total: 0 };
  const totalEffVol      = cart.reduce((s, i) => s + i.effVolPerUnit * i.qty, 0);
  const heaviestDensity  = Math.max(...cart.map(i => (MATERIALS[i.material] ?? MATERIALS.PLA).density));
  const fakeKey          = Object.keys(MATERIALS).find(k => MATERIALS[k].density === heaviestDensity) || 'PLA';
  const delivery         = deliveryEstimate(totalEffVol, fakeKey);
  return {
    setup:    SETUP_FEE,
    delivery: delivery.cost,
    courier:  delivery.courier,
    weight:   delivery.totalWeightG,
    total:    SETUP_FEE + delivery.cost,
  };
}

function cartGrandTotal(cart) {
  return cartMaterialTotal(cart) + cartDeliveryAndSetup(cart).total;
}

function cartItemCount(cart) {
  return cart.reduce((s, i) => s + i.qty, 0);
}

/* ── localStorage Persistence ───────────────────────────────────────────────── */
function cartLoad() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cartSave(cart) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch {
    // Storage full or unavailable — fail silently
  }
}

function cartClear() {
  try { localStorage.removeItem(CART_KEY); } catch { /* ignore */ }
}

/* ── Cart Mutations ─────────────────────────────────────────────────────────── */
let _nextId = Date.now(); // unique IDs survive page reloads

function cartAdd(cart, item) {
  // Sanitise the filename
  const safeName = String(item.name ?? 'model.stl')
    .replace(/[<>"'&]/g, c => ({ '<':'&lt;', '>':'&gt;', '"':'&quot;', "'": '&#39;', '&':'&amp;' }[c]))
    .slice(0, 128);

  const existing = cart.find(i =>
    i.name === safeName &&
    i.material === item.material &&
    i.infill === item.infill &&
    i.supportLabel === item.supportLabel
  );

  if (existing) {
    existing.qty = Math.min(existing.qty + item.qty, MAX_QTY);
    return cart;
  }

  cart.push({
    id:              _nextId++,
    name:            safeName,
    material:        item.material,
    qty:             Math.min(Math.max(1, Math.round(item.qty)), MAX_QTY),
    infill:          item.infill,
    supportLabel:    item.supportLabel,
    effVolPerUnit:   item.effVolPerUnit,
    matCostPerUnit:  item.matCostPerUnit,
  });
  return cart;
}

function cartRemove(cart, id) {
  return cart.filter(i => i.id !== id);
}

function cartSetQty(cart, id, qty) {
  const item = cart.find(i => i.id === id);
  if (!item) return cart;
  const clamped = Math.round(qty);
  if (clamped < 1) return cartRemove(cart, id);
  item.qty = Math.min(clamped, MAX_QTY);
  return cart;
}

/* ── Nav Badge Update ───────────────────────────────────────────────────────── */
function updateNavBadge() {
  const badge = document.getElementById('navCartBadge');
  if (!badge) return;
  const count = cartItemCount(cartLoad());
  badge.textContent = count;
  badge.style.display = count > 0 ? 'inline-flex' : 'none';
}

/* ── Exports ────────────────────────────────────────────────────────────────── */
window.Cart = {
  MATERIALS,
  SETUP_FEE,
  MAX_QTY,
  MAX_FILE_SIZE,
  escapeHTML,
  deliveryEstimate,
  cartMaterialTotal,
  cartDeliveryAndSetup,
  cartGrandTotal,
  cartItemCount,
  cartLoad,
  cartSave,
  cartClear,
  cartAdd,
  cartRemove,
  cartSetQty,
  updateNavBadge,
};
