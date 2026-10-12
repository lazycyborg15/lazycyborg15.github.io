const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const SEED_DIR = path.join(__dirname, '../data');
const MONGODB_URI = process.env.MONGODB_URI || '';
const IS_SERVERLESS = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);

// Default records bundled by the serverless wrapper (the filesystem is not available there).
let SEEDS = {};
function setSeeds(seeds) {
  SEEDS = seeds || {};
}

// Storage is JSON files by default. When MONGODB_URI is set, each collection is
// kept in MongoDB instead so data survives redeploys on hosts with ephemeral disks.
let StoreModel = null;
if (MONGODB_URI) {
  const mongoose = require('mongoose');
  StoreModel = mongoose.model('Store', new mongoose.Schema(
    { _id: String, data: mongoose.Schema.Types.Mixed },
    { minimize: false }
  ));
}

function readJsonFile(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error('Error reading ' + file + ':', err);
  }
  return null;
}

async function loadCollection(name) {
  if (StoreModel) {
    const doc = await StoreModel.findById(name).lean();
    if (doc) return doc.data || [];
    return SEEDS[name] || readJsonFile(path.join(SEED_DIR, name + '.json')) || [];
  }
  return readJsonFile(path.join(DATA_DIR, name + '.json')) || readJsonFile(path.join(SEED_DIR, name + '.json')) || [];
}

async function saveCollection(name, items) {
  if (StoreModel) {
    await StoreModel.updateOne({ _id: name }, { $set: { data: items } }, { upsert: true });
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, name + '.json'), JSON.stringify(items, null, 2), 'utf8');
}

const loadOrders = () => loadCollection('orders');
const saveOrders = orders => saveCollection('orders', orders);

// Appends a single record. MongoDB does it atomically so parallel serverless instances never overwrite each other.
async function appendItem(name, item) {
  if (StoreModel) {
    await StoreModel.updateOne({ _id: name }, { $push: { data: item } }, { upsert: true });
    return;
  }
  await withLock(async () => {
    const items = await loadCollection(name);
    items.push(item);
    await saveCollection(name, items);
  });
}
const loadContacts = () => loadCollection('contacts');
const saveContacts = contacts => saveCollection('contacts', contacts);
const loadProducts = () => loadCollection('products');
const saveProducts = products => saveCollection('products', products);
const loadCustomers = () => loadCollection('customers');
const saveCustomers = customers => saveCollection('customers', customers);
const loadReviews = () => loadCollection('reviews');
const saveReviews = reviews => saveCollection('reviews', reviews);

// Serializes read-modify-write cycles so concurrent requests don't overwrite each other.
let writeQueue = Promise.resolve();
function withLock(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { passwordSalt: salt, passwordHash };
}

function verifyPassword(password, customer) {
  if (!customer?.passwordSalt || !customer?.passwordHash) return false;
  const storedHash = Buffer.from(customer.passwordHash, 'hex');
  const candidates = [
    crypto.scryptSync(password, customer.passwordSalt, 64),
    crypto.pbkdf2Sync(password, customer.passwordSalt, 10000, 64, 'sha512'),
    crypto.createHash('sha512').update(password + customer.passwordSalt).digest(),
    crypto.createHash('sha512').update(customer.passwordSalt + password).digest(),
  ];

  return candidates.some(candidate => candidate.length === storedHash.length && crypto.timingSafeEqual(candidate, storedHash));
}

app.use(cors());
app.use(express.json());
// The repo root is served as the site, so keep data and server files private.
app.use((req, res, next) => {
  if (/^\/(data|server|\.git|\.github|node_modules)(\/|$)/i.test(decodeURIComponent(req.path)) || /\.(env|log)$/i.test(req.path)) {
    return res.status(404).json({ success: false, message: 'Not found.' });
  }
  next();
});
let dbConnection = null;
function connectDb() {
  if (!MONGODB_URI) return Promise.resolve();
  if (!dbConnection) {
    dbConnection = require('mongoose').connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 })
      .catch(err => { dbConnection = null; throw err; });
  }
  return dbConnection;
}

// The connection is cached across requests; serverless hosts reuse warm instances.
app.use('/api', async (req, res, next) => {
  if (IS_SERVERLESS && !MONGODB_URI) {
    return res.status(503).json({ success: false, message: 'The database is not configured. Set MONGODB_URI on the host.' });
  }
  try {
    await connectDb();
    next();
  } catch (err) {
    console.error('Database connection failed:', err);
    res.status(503).json({ success: false, message: 'Cannot reach the database right now. Please try again shortly.' });
  }
});

app.use(express.static(path.join(__dirname, '../')));
app.use(express.static(path.join(__dirname, '../client/build')));

console.log('Data storage: ' + (MONGODB_URI ? 'MongoDB' : 'JSON files (' + DATA_DIR + ')'));

// Pasted values often carry quotes or spaces (Google shows app passwords as "abcd efgh ijkl mnop"), so they are cleaned first.
const EMAIL_USER = String(process.env.EMAIL_USER || '').replace(/["'\s]/g, '');
const EMAIL_PASS = String(process.env.EMAIL_PASS || '').replace(/["'\s]/g, '');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

// Safe summary for the admin page: which account is used and how long the password is, never the password.
function emailDiagnostics() {
  const [name = '', domain = ''] = EMAIL_USER.split('@');
  return {
    user: EMAIL_USER ? `${name.slice(0, 2)}***@${domain}` : '(not set)',
    passwordLength: EMAIL_PASS.length,
  };
}

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'Contactpynx@gmail.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@pynx.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// Without JWT_SECRET a random per-process secret is used, so sessions reset on restart; set it in production.
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');
if (!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set; admin login is disabled.');

// Shown as "PYNX <address>" in the customer's inbox.
const mailFrom = () => `"PYNX" <${EMAIL_USER}>`;

// NOTIFY_EMAIL may hold several comma-separated admin addresses.
async function notifyAdmins(subject, text) {
  if (!EMAIL_USER || !EMAIL_PASS) {
    console.warn('Email notification not sent: missing EMAIL_USER or EMAIL_PASS environment variables.');
    return { emailSent: false, emailError: 'Email is not configured on the server.' };
  }
  try {
    await transporter.sendMail({ from: mailFrom(), to: NOTIFY_EMAIL, subject, text });
    return { emailSent: true, emailError: null };
  } catch (err) {
    console.error('Saved, but email notification failed:', err);
    return { emailSent: false, emailError: err.message || 'Email send failed' };
  }
}

async function notifyCustomer(to, subject, text, html) {
  if (!EMAIL_USER || !EMAIL_PASS) {
    console.warn('Customer email not sent: missing EMAIL_USER or EMAIL_PASS environment variables.');
    return { emailSent: false, emailError: 'Email is not configured on the server.' };
  }
  try {
    await transporter.sendMail({ from: mailFrom(), replyTo: NOTIFY_EMAIL, to, subject, text, html });
    return { emailSent: true, emailError: null };
  } catch (err) {
    console.error('Order saved, but customer confirmation email failed:', err);
    return { emailSent: false, emailError: err.message || 'Email send failed' };
  }
}

app.post('/api/customers/signup', async (req, res) => {
  const { firstName, lastName, email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (!firstName || !lastName || !normalizedEmail || !password || password.length < 6) {
    return res.status(400).json({ success: false, message: 'Please provide valid account details and a password with at least 6 characters.' });
  }

  try {
    const customer = await withLock(async () => {
      const customers = await loadCustomers();
      if (customers.some(item => item.email.toLowerCase() === normalizedEmail)) return null;
      const created = {
        id: crypto.randomUUID(),
        firstName: String(firstName).trim(),
        lastName: String(lastName).trim(),
        email: normalizedEmail,
        ...hashPassword(password),
        createdAt: new Date().toISOString(),
      };
      customers.push(created);
      await saveCustomers(customers);
      return created;
    });

    if (!customer) {
      return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
    }

    const token = jwt.sign({ role: 'customer', id: customer.id, email: customer.email }, JWT_SECRET, { expiresIn: '7d' });
    return res.status(201).json({ success: true, token, customer: { id: customer.id, firstName: customer.firstName, lastName: customer.lastName, email: customer.email } });
  } catch (error) {
    console.error('Signup failed:', error);
    return res.status(500).json({ success: false, message: 'Unable to create your account right now. Please try again later.' });
  }
});

app.post('/api/customers/login', async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();

  try {
    const customer = (await loadCustomers()).find(item => item.email.toLowerCase() === normalizedEmail);

    if (!customer || !verifyPassword(password || '', customer)) {
      return res.status(401).json({ success: false, message: 'Invalid customer email or password.' });
    }

    const token = jwt.sign({ role: 'customer', id: customer.id, email: customer.email }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ success: true, token, customer: { id: customer.id, firstName: customer.firstName, lastName: customer.lastName, email: customer.email } });
  } catch (error) {
    console.error('Login failed:', error);
    return res.status(500).json({ success: false, message: 'Unable to log in right now. Please try again later.' });
  }
});

// processing = being packed, done = packed and ready to ship, shipped = on the way.
const ORDER_STATUSES = ['processing', 'done', 'shipped', 'delivered'];

// Delivery window shown to customers, counted in days from the order date.
const DELIVERY_MIN_DAYS = Number(process.env.DELIVERY_MIN_DAYS) || 3;
const DELIVERY_MAX_DAYS = Math.max(DELIVERY_MIN_DAYS, Number(process.env.DELIVERY_MAX_DAYS) || 7);
// Optional shipping origin (for example "Cagayan de Oro City, Misamis Oriental") drawn on the tracking map.
const SHIP_FROM = process.env.SHIP_FROM || '';
const GEOCODE_COUNTRY = process.env.GEOCODE_COUNTRY !== undefined ? process.env.GEOCODE_COUNTRY : 'ph';
// Dates are calculated in Philippine time so late-evening orders don't roll back a day.
const STORE_UTC_OFFSET_MS = 8 * 3600 * 1000;

function addDays(iso, days) {
  const date = new Date(Date.parse(iso) + STORE_UTC_OFFSET_MS);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const deliveryEstimate = order => ({
  from: order.estimatedDeliveryFrom || addDays(order.createdAt, DELIVERY_MIN_DAYS),
  to: order.estimatedDeliveryTo || addDays(order.createdAt, DELIVERY_MAX_DAYS),
});

function formatEstimate({ from, to }) {
  const day = (value, withYear) => new Date(value + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: withYear ? 'numeric' : undefined, timeZone: 'UTC' });
  return from === to ? day(to, true) : `${day(from)} - ${day(to, true)}`;
}

const formatDateTime = iso => new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });

// Free OpenStreetMap geocoding. Usage policy allows about one request per second, so lookups are spaced out and failures are remembered briefly.
const geocodeFailures = new Map();
let shipFromCache = null;

async function nominatimSearch(query) {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '1' });
  if (GEOCODE_COUNTRY) params.set('countrycodes', GEOCODE_COUNTRY);
  const response = await fetch('https://nominatim.openstreetmap.org/search?' + params, {
    headers: { 'User-Agent': `PYNX-order-tracking (${NOTIFY_EMAIL})`, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) return null;
  const [hit] = await response.json();
  return hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
}

// Tries the full address, then progressively drops the leading parts (house number, street).
async function geocode(address) {
  const text = String(address || '').trim();
  if (!text) return null;
  const failedAt = geocodeFailures.get(text);
  if (failedAt && Date.now() - failedAt < 10 * 60 * 1000) return null;

  const parts = text.split(',').map(part => part.trim()).filter(Boolean);
  const candidates = [...new Set(parts.map((_, index) => parts.slice(index).join(', ')))].slice(0, 3);
  // Serverless functions are cut off after ~10 seconds, so stop trying before that.
  const deadline = Date.now() + 7000;
  let hadError = false;
  for (let index = 0; index < candidates.length; index++) {
    if (index) await new Promise(resolve => setTimeout(resolve, 1100));
    if (Date.now() > deadline) break;
    try {
      const point = await nominatimSearch(candidates[index]);
      if (point) return point;
    } catch (err) {
      console.warn('Geocoding failed:', err.message);
      hadError = true;
    }
  }
  if (!hadError) geocodeFailures.set(text, Date.now());
  return null;
}

async function shipFromPoint() {
  if (!SHIP_FROM) return null;
  if (!shipFromCache) {
    // SHIP_FROM may also be plain coordinates ("8.4822,124.6472") to skip the lookup.
    const coords = SHIP_FROM.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    shipFromCache = coords ? { lat: Number(coords[1]), lng: Number(coords[2]) } : await geocode(SHIP_FROM);
  }
  return shipFromCache;
}

async function ensureDestination(order) {
  if (order.destination) return order.destination;
  // Region and postal code don't help the lookup, so only street, barangay, city and province are searched.
  const parts = order.addressParts;
  const point = await geocode(parts ? [parts.street, parts.barangay, parts.city, parts.province].filter(Boolean).join(', ') : order.address);
  if (!point) return null;
  order.destination = point;
  await withLock(async () => {
    const orders = await loadOrders();
    const stored = orders.find(item => item.id === order.id);
    if (stored) {
      stored.destination = point;
      await saveOrders(orders);
    }
  });
  return point;
}

const googleMapsUrl = address => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

// Short reference shown to customers; derived from the id so older orders get one too.
const orderNumber = order => 'PYNX-' + String(order.id || '').replace(/-/g, '').slice(0, 8).toUpperCase();

// Base URL used for the tracking link in emails. Set SITE_URL on the host; otherwise the request origin is used.
function siteBaseUrl(req) {
  const configured = process.env.SITE_URL || req.headers.origin || '';
  return /^https?:\/\//i.test(configured) ? configured.replace(/\/+$/, '') : '';
}

const trackingUrl = (req, order) => `${siteBaseUrl(req)}/track.html?id=${encodeURIComponent(order.id)}`;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function orderItemLines(items) {
  return items.map(item => {
    const price = Number(item.product?.price) || 0;
    const qty = Number(item.qty) || 1;
    return {
      name: item.product?.name || 'Item',
      size: item.size || '',
      image: item.product?.image || '',
      imageScale: Number(item.product?.imageScale) || 1,
      bg: item.product?.bg || '',
      qty,
      price,
      lineTotal: price * qty,
    };
  });
}

// Keeps only the first digits and the last two so the phone number is recognisable but not exposed.
function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 7) return '*'.repeat(digits.length);
  return digits.slice(0, 3) + '*'.repeat(digits.length - 5) + digits.slice(-2);
}

// Package updates shown on the tracking page, newest first. Status changes come from the saved
// timestamps and location updates from the admin, so older orders get a timeline too.
function trackingEvents(order) {
  const times = order.statusTimes || {};
  const events = [{ at: order.createdAt, title: 'Preparing to ship', description: 'We received your order and are preparing your package.', major: true }];
  if (times.done) events.push({ at: times.done, title: 'Packed and ready to ship', description: 'Your package is packed and waiting for the courier to pick it up.', major: true });
  if (times.shipped) events.push({ at: times.shipped, title: 'Package picked up', description: 'Your package was collected by our carrier and is on its way.', major: true });
  (order.locationUpdates || []).forEach(update => events.push({ at: update.at, title: 'In transit', description: `Package is now in ${update.text}.`, major: false }));
  if (times.delivered) events.push({ at: times.delivered, title: 'Delivered', description: 'Your package has been delivered. Thank you for shopping with PYNX!', major: true });
  // Ties keep their creation order, newest first.
  return events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.at)
    .sort((a, b) => Date.parse(b.event.at) - Date.parse(a.event.at) || b.index - a.index)
    .map(({ event }) => event);
}

// Customer-safe view of an order. The link or order number plus email is what protects it, so the
// recipient details are shown to whoever opens it, with the phone number masked.
function publicOrder(order, map = {}) {
  const current = order.status === 'shipped' ? order.currentLocation : null;
  return {
    orderNumber: orderNumber(order),
    firstName: order.firstName,
    recipient: { name: `${order.firstName} ${order.lastName}`.trim(), phone: maskPhone(order.contact), address: order.address },
    status: order.status || 'processing',
    createdAt: order.createdAt,
    statusUpdatedAt: order.statusUpdatedAt || null,
    statusTimes: order.statusTimes || {},
    events: trackingEvents(order),
    estimatedDelivery: deliveryEstimate(order),
    currentLocation: current ? { text: current.text, updatedAt: current.updatedAt } : null,
    map: {
      destination: map.destination || null,
      origin: map.origin || null,
      originLabel: map.origin ? SHIP_FROM : '',
      current: current && Number.isFinite(current.lat) ? { lat: current.lat, lng: current.lng } : null,
    },
    total: order.total,
    items: orderItemLines(order.items || []),
  };
}

async function trackingPayload(order) {
  let destination = null;
  let origin = null;
  try {
    destination = await ensureDestination(order);
    origin = await shipFromPoint();
  } catch (err) {
    console.warn('Map lookup failed:', err.message);
  }
  return publicOrder(order, { destination, origin });
}

function receiptEmail(order, link) {
  const lines = orderItemLines(order.items || []);
  const number = orderNumber(order);
  const estimate = formatEstimate(deliveryEstimate(order));
  const mapsLink = googleMapsUrl(order.address);
  const placed = formatDateTime(order.createdAt);
  const text = [
    `Hi ${order.firstName},`,
    '',
    `Thank you for shopping with PYNX. We've received your order.`,
    '',
    `Order number: ${number}`,
    `Order placed: ${placed}`,
    `Estimated delivery: ${estimate}`,
    '',
    'Items:',
    ...(lines.map(l => `${l.name}${l.size ? ` / ${l.size}` : ''} x${l.qty} - PHP ${l.lineTotal.toFixed(2)}`)),
    '',
    `Total: PHP ${order.total.toFixed(2)}`,
    `Shipping address: ${order.address}`,
    `View on Google Maps: ${mapsLink}`,
    `Contact: ${order.contact}`,
    '',
    link ? `Track your order on the map: ${link}` : `Quote your order number ${number} when contacting us about this order.`,
    '',
    '- PYNX',
  ].join('\n');

  const cell = 'padding:8px 0;border-bottom:1px solid #eee';
  const rows = lines.map(l => `<tr><td style="${cell}">${escapeHtml(l.name)}${l.size ? ` <span style="color:#777">(${escapeHtml(l.size)})</span>` : ''}</td><td style="${cell};text-align:center">x${l.qty}</td><td style="${cell};text-align:right">PHP ${l.lineTotal.toFixed(2)}</td></tr>`).join('');
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">
<h1 style="letter-spacing:.2em">PYNX</h1>
<p>Hi ${escapeHtml(order.firstName)},</p>
<p>Thank you for shopping with PYNX. We've received your order. Here is your receipt.</p>
<p><strong>Order number:</strong> ${number}<br><strong>Order placed:</strong> ${escapeHtml(placed)}</p>
<p style="background:#f4f4f0;padding:12px 16px;border-radius:6px"><strong>Estimated delivery:</strong> ${escapeHtml(estimate)}</p>
<table style="width:100%;border-collapse:collapse">${rows}<tr><td colspan="2" style="padding:10px 0;font-weight:bold">Total</td><td style="padding:10px 0;text-align:right;font-weight:bold">PHP ${order.total.toFixed(2)}</td></tr></table>
<p><strong>Shipping address:</strong> ${escapeHtml(order.address)}<br><a href="${escapeHtml(mapsLink)}">View on Google Maps</a><br><strong>Contact:</strong> ${escapeHtml(order.contact)}</p>
${link ? `<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#111;color:#fff;padding:12px 22px;text-decoration:none;border-radius:4px">Track your order</a></p><p style="font-size:12px;color:#777">Or open this link: ${escapeHtml(link)}</p>` : ''}
<p>- PYNX</p></div>`;
  return { text, html };
}

// Short updates sent when an order moves forward.
function statusEmail(order, status, link) {
  const number = orderNumber(order);
  const estimate = formatEstimate(deliveryEstimate(order));
  const messages = {
    done: [`Your PYNX order ${number} is packed and ready to ship`, `Good news! Your order ${number} is packed and ready to ship.`],
    shipped: [`Your PYNX order ${number} is on the way`, `Your order ${number} is on the way to you.${order.currentLocation?.text ? `\nLatest location: ${order.currentLocation.text}` : ''}\nEstimated delivery: ${estimate}`],
    delivered: [`Your PYNX order ${number} was delivered`, `Your order ${number} has been delivered. Thank you for shopping with PYNX!`],
  };
  const [subject, body] = messages[status];
  return { subject, text: `Hi ${order.firstName},\n\n${body}\n${link && status !== 'delivered' ? `\nTrack your order: ${link}\n` : ''}\n- PYNX` };
}

const clean = (value, max = 120) => String(value || '').trim().slice(0, max);

// Structured Philippine address as entered at checkout; null when the required parts are missing.
function cleanAddressParts(parts) {
  if (!parts || typeof parts !== 'object') return null;
  const result = {
    region: clean(parts.region, 40),
    province: clean(parts.province),
    city: clean(parts.city),
    barangay: clean(parts.barangay),
    postalCode: clean(parts.postalCode, 12),
    street: clean(parts.street, 200),
  };
  return result.province && result.city && result.barangay && result.street ? result : null;
}

const formatAddressParts = parts => [parts.street, parts.barangay, parts.city, parts.province, parts.postalCode, parts.region].filter(Boolean).join(', ');

// Pin placed by the customer on the checkout map.
function cleanPoint(point) {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  return point && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

// Remembers whether the receipt went out so admins can see failures and resend.
async function recordReceiptResult(orderId, result) {
  try {
    await withLock(async () => {
      const orders = await loadOrders();
      const order = orders.find(item => item.id === orderId);
      if (!order) return;
      order.receiptEmail = { sent: Boolean(result.emailSent), error: result.emailError || null, at: new Date().toISOString() };
      await saveOrders(orders);
    });
  } catch (err) {
    console.error('Could not record receipt email result:', err);
  }
}

app.post('/api/orders', async (req, res) => {
  const { firstName, lastName, email, contact, items = [] } = req.body;
  const addressParts = cleanAddressParts(req.body.addressParts);
  const address = addressParts ? formatAddressParts(addressParts) : clean(req.body.address, 400);

  if (!firstName || !lastName || !address || !email || !contact) {
    return res.status(400).json({ success: false, message: 'Please provide all required order details.' });
  }

  const order = {
    id: crypto.randomUUID(),
    firstName,
    lastName,
    address,
    ...(addressParts ? { addressParts } : {}),
    ...(cleanPoint(req.body.location) ? { destination: cleanPoint(req.body.location) } : {}),
    email,
    contact,
    items,
    total: items.reduce((sum, item) => sum + (Number(item.product?.price) || 0) * (Number(item.qty) || 0), 0),
    status: 'processing',
    createdAt: new Date().toISOString(),
  };
  order.estimatedDeliveryFrom = addDays(order.createdAt, DELIVERY_MIN_DAYS);
  order.estimatedDeliveryTo = addDays(order.createdAt, DELIVERY_MAX_DAYS);

  try {
    await appendItem('orders', order);
  } catch (error) {
    console.error('Failed to save order:', error);
    return res.status(500).json({ success: false, message: 'Order save failed. Please try again later.' });
  }

  const itemLine = items.map(item => {
    const sizeText = item.size ? ` / ${item.size}` : '';
    const price = Number(item.product?.price) || 0;
    return `${item.product?.name || 'Item'} x${item.qty || 1}${sizeText} - PHP ${price.toFixed(2)} each`;
  }).join('\n') || 'No items.';

  const { emailSent, emailError } = await notifyAdmins(
    `New order received from ${firstName} ${lastName}`,
    `New order details:\n\nName: ${firstName} ${lastName}\nEmail: ${email}\nContact: ${contact}\nAddress: ${address}\n\nItems:\n${itemLine}\n\nTotal: PHP ${order.total.toFixed(2)}\nPlaced: ${order.createdAt}\n\nView it in the admin page.`
  );

  const link = trackingUrl(req, order);
  const receipt = receiptEmail(order, siteBaseUrl(req) ? link : '');
  const customerEmail = await notifyCustomer(
    String(email).trim(),
    `Your PYNX order receipt (${orderNumber(order)})`,
    receipt.text,
    receipt.html
  );
  await recordReceiptResult(order.id, customerEmail);

  return res.status(201).json({
    success: true,
    order: { ...order, orderNumber: orderNumber(order) },
    trackingPath: `/track.html?id=${encodeURIComponent(order.id)}`,
    emailSent,
    emailError,
    customerEmailSent: customerEmail.emailSent,
    customerEmailError: customerEmail.emailError,
  });
});

// Customers open the link from their receipt; the unguessable order id acts as the access key.
app.get('/api/orders/track', async (req, res) => {
  const id = String(req.query.id || '');
  try {
    res.set('Cache-Control', 'no-store');
    const order = id ? (await loadOrders()).find(item => item.id === id) : null;
    if (!order) return res.status(404).json({ success: false, message: 'We could not find that order.' });
    return res.json({ success: true, order: await trackingPayload(order) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Unable to look up your order right now.' });
  }
});

// Fallback for customers who lost the link: order number plus the email used at checkout.
app.post('/api/orders/track', async (req, res) => {
  const number = String(req.body.orderNumber || '').trim().toUpperCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  try {
    const order = number && email
      ? (await loadOrders()).find(item => item.id && orderNumber(item) === number && String(item.email || '').trim().toLowerCase() === email)
      : null;
    if (!order) return res.status(404).json({ success: false, message: 'No order matches that order number and email.' });
    return res.json({ success: true, order: await trackingPayload(order), id: order.id });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Unable to look up your order right now.' });
  }
});

// The public catalog is read from the same persistent store that admins edit.
app.get('/api/products', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, products: await loadProducts() });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Failed to load products.' });
  }
});

app.post('/api/contact', async (req, res) => {
  const { name, email, phone, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ success: false, message: 'Please provide name, email, and message.' });
  }

  const contactEntry = {
    name,
    email,
    phone: phone || '',
    message,
    createdAt: new Date().toISOString(),
  };

  try {
    await appendItem('contacts', contactEntry);
  } catch (error) {
    console.error('Failed to save contact message:', error);
    return res.status(500).json({ success: false, message: 'Unable to save your message. Please try again later.' });
  }

  await notifyAdmins(
    `New customer message from ${name}`,
    `Name: ${name}\nEmail: ${email}\nPhone: ${contactEntry.phone || '-'}\n\nMessage:\n${message}`
  );

  return res.status(201).json({ success: true, message: 'Message received.' });
});

app.post('/api/reviews', async (req, res) => {
  const { name, email, rating, comment, productName } = req.body;
  const stars = Number(rating);

  if (!name || !String(comment || '').trim() || !Number.isInteger(stars) || stars < 1 || stars > 5) {
    return res.status(400).json({ success: false, message: 'Please provide your name, a rating from 1 to 5, and a comment.' });
  }

  const review = {
    id: crypto.randomUUID(),
    name: String(name).trim().slice(0, 100),
    email: String(email || '').trim().slice(0, 200),
    rating: stars,
    comment: String(comment).trim().slice(0, 2000),
    productName: String(productName || '').trim().slice(0, 200),
    createdAt: new Date().toISOString(),
  };

  try {
    await appendItem('reviews', review);
  } catch (error) {
    console.error('Failed to save review:', error);
    return res.status(500).json({ success: false, message: 'Unable to save your review. Please try again later.' });
  }

  await notifyAdmins(
    `New ${stars}-star review from ${review.name}`,
    `Name: ${review.name}\nEmail: ${review.email || '-'}\nRating: ${stars}/5\nProduct: ${review.productName || '-'}\n\nReview:\n${review.comment}`
  );

  return res.status(201).json({ success: true, message: 'Thank you for your review.' });
});

function verifyAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Missing authorization token.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') {
      throw new Error('Unauthorized');
    }
    req.admin = payload;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
}

app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (ADMIN_PASSWORD && String(email || '').trim().toLowerCase() === ADMIN_EMAIL.toLowerCase() && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'admin', email }, JWT_SECRET, { expiresIn: '2h' });
    return res.json({ success: true, token, email });
  }
  return res.status(401).json({ success: false, message: 'Invalid credentials.' });
});

app.get('/api/admin/orders', verifyAdmin, async (req, res) => {
  try {
    // Orders saved before ids existed get one here so they can be removed by id.
    const orders = await withLock(async () => {
      const stored = await loadOrders();
      if (stored.some(order => !order.id)) {
        stored.forEach(order => {
          if (!order.id) order.id = crypto.randomUUID();
        });
        await saveOrders(stored);
      }
      return stored;
    });
    orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.json({ success: true, orders });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Failed to load orders.' });
  }
});

app.post('/api/admin/orders/:id/resend-receipt', verifyAdmin, async (req, res) => {
  try {
    const order = (await loadOrders()).find(item => item.id === String(req.params.id));
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    const link = siteBaseUrl(req) ? trackingUrl(req, order) : '';
    const receipt = receiptEmail(order, link);
    const result = await notifyCustomer(String(order.email || '').trim(), `Your PYNX order receipt (${orderNumber(order)})`, receipt.text, receipt.html);
    await recordReceiptResult(order.id, result);
    return res.json({ success: true, emailSent: result.emailSent, emailError: result.emailError, diagnostics: emailDiagnostics() });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Failed to resend the receipt.' });
  }
});

app.patch('/api/admin/orders/:id/status', verifyAdmin, async (req, res) => {
  const orderId = String(req.params.id);
  const status = String(req.body.status || '');
  const location = String(req.body.location || '').trim().slice(0, 200);
  if (!ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, message: `Status must be one of: ${ORDER_STATUSES.join(', ')}.` });
  }
  if (location && status !== 'shipped') {
    return res.status(400).json({ success: false, message: 'A current location can only be set while an order is shipped.' });
  }

  try {
    // Looked up before taking the write lock because geocoding can take a few seconds.
    const point = location ? await geocode(location) : null;

    const result = await withLock(async () => {
      const orders = await loadOrders();
      const order = orders.find(item => item.id === orderId);
      if (!order) return null;

      const previous = order.status || 'processing';
      const changed = previous !== status;
      const now = new Date().toISOString();
      order.status = status;
      if (changed) {
        order.statusUpdatedAt = now;
        const times = order.statusTimes || {};
        ORDER_STATUSES.forEach((name, index) => {
          if (index > ORDER_STATUSES.indexOf(status)) delete times[name];
        });
        times[status] = now;
        order.statusTimes = times;
      }
      if (ORDER_STATUSES.indexOf(status) < ORDER_STATUSES.indexOf('shipped')) delete order.locationUpdates;
      if (status !== 'shipped') {
        delete order.currentLocation;
      } else if (location) {
        order.currentLocation = { text: location, ...(point || {}), updatedAt: now };
        order.locationUpdates = [...(order.locationUpdates || []), { text: location, at: now }];
      }
      await saveOrders(orders);
      return { order, changed, advanced: changed && ORDER_STATUSES.indexOf(status) > ORDER_STATUSES.indexOf(previous) };
    });
    if (!result) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    // Tell the customer when the order moves forward (never when an admin undoes a step).
    if (result.advanced && status !== 'processing' && result.order.email) {
      const link = siteBaseUrl(req) ? trackingUrl(req, result.order) : '';
      const mail = statusEmail(result.order, status, link);
      await notifyCustomer(String(result.order.email).trim(), mail.subject, mail.text);
    }
    return res.json({ success: true, order: result.order, locationFound: location ? Boolean(point) : undefined });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Failed to update order status.' });
  }
});

app.delete('/api/admin/orders/:id', verifyAdmin, async (req, res) => {
  const orderId = String(req.params.id);
  try {
    const removed = await withLock(async () => {
      const orders = await loadOrders();
      const remaining = orders.filter(order => order.id !== orderId);
      if (remaining.length === orders.length) return false;
      await saveOrders(remaining);
      return true;
    });
    if (!removed) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }
    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Failed to remove order.' });
  }
});

app.get('/api/admin/products', verifyAdmin, async (req, res) => {
  try {
    const products = await loadProducts();
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, products });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Failed to load products.' });
  }
});

app.put('/api/admin/products/:id', verifyAdmin, async (req, res) => {
  const productId = Number(req.params.id);
  const { price, originalPrice, onSale } = req.body;

  if (Number.isNaN(productId)) {
    return res.status(400).json({ success: false, message: 'Invalid product ID.' });
  }

  if (typeof price !== 'number' || price < 0) {
    return res.status(400).json({ success: false, message: 'Price must be a non-negative number.' });
  }

  try {
    const product = await withLock(async () => {
      const products = await loadProducts();
      const index = products.findIndex(p => p.id === productId);
      if (index === -1) return null;

      const savedOriginalPrice = typeof originalPrice === 'number' && originalPrice >= price
        ? originalPrice
        : price;
      products[index].originalPrice = savedOriginalPrice;
      products[index].onSale = Boolean(onSale);
      products[index].price = products[index].onSale ? price : savedOriginalPrice;

      await saveProducts(products);
      return products[index];
    });

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }
    return res.json({ success: true, product });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Failed to update product.' });
  }
});

app.get('/api/admin/contacts', verifyAdmin, async (req, res) => {
  try {
    const contacts = (await loadContacts()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.json({ success: true, contacts });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Failed to load customer concerns.' });
  }
});

app.get('/api/admin/reviews', verifyAdmin, async (req, res) => {
  try {
    const reviews = (await loadReviews()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.json({ success: true, reviews });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Failed to load reviews.' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Serve the standalone admin page from the root workspace so login works when opened via localhost.
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../admin.html'));
});

app.get('*', (req, res) => {
  const clientIndex = path.join(__dirname, '../client/build/index.html');
  const rootIndex = path.join(__dirname, '../index.html');

  if (fs.existsSync(clientIndex)) {
    return res.sendFile(clientIndex);
  }

  return res.sendFile(rootIndex);
});

async function start() {
  await connectDb();
  if (MONGODB_URI) console.log('Connected to MongoDB');
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  start().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = { app, setSeeds };
