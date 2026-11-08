const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();
const RETURN_POLICY_VERSION = '2026-11-07-cancellation-refunds';
const PORT = process.env.PORT || 5000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const SEED_DIR = path.join(__dirname, '../data');
const MONGODB_URI = process.env.MONGODB_URI || '';
const IS_SERVERLESS = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
const PAYMONGO_SECRET_KEY = process.env.PAYMONGO_SECRET_KEY || '';
const PAYMONGO_WEBHOOK_SECRET = process.env.PAYMONGO_WEBHOOK_SECRET || '';
const ONLINE_PAYMENTS_ENABLED = Boolean(PAYMONGO_SECRET_KEY && PAYMONGO_WEBHOOK_SECRET);
const CEBU_CITY_SHIPPING_RATE_PER_KM = 1.49;
const CEBU_PROVINCE_SHIPPING_RATE_PER_KM = 0.78;
const MINIMUM_SHIPPING_FEE = 66.06;
const FLAT_SHIPPING_FEES = {
  visayas: 155,
  luzon: 180,
  ncr: 180,
  mindanao: 175,
};
// Store origin: Basak San Nicolas, Cebu City. Set SHIPPING_ORIGIN="lat,lng" to move it.
const SHIPPING_ORIGIN = (() => {
  const match = String(process.env.SHIPPING_ORIGIN || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  return match ? { lat: Number(match[1]), lng: Number(match[2]) } : { lat: 10.2864738, lng: 123.8703173 };
})();
const TRACKING_STEPS = [
  { key: 'preparing_to_ship', title: 'Preparing to ship', requiresSpecificLocation: false },
  { key: 'packaged_for_pickup', title: 'Packaged for pickup', requiresSpecificLocation: false },
  { key: 'arrived_at_sorting_center', title: 'Package arrived at sorting center', requiresSpecificLocation: true },
  { key: 'left_sorting_center', title: 'Package left the sorting center', requiresSpecificLocation: true },
  { key: 'carrier_processing', title: 'Package is being processed by the carrier', requiresSpecificLocation: true },
  { key: 'arrived_at_nearest_hub', title: 'Package arrived at the nearest hub', requiresSpecificLocation: true },
  { key: 'out_for_delivery', title: 'Out for delivery', requiresSpecificLocation: true },
  { key: 'delivered', title: 'Delivered', requiresSpecificLocation: true },
];

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
const loadNewsletterSubscribers = () => loadCollection('newsletterSubscribers');
const saveNewsletterSubscribers = subscribers => saveCollection('newsletterSubscribers', subscribers);
const loadProducts = () => loadCollection('products');
const saveProducts = products => saveCollection('products', products);
async function loadProductsWithPriceMigration() {
  const products = await loadProducts();
  const hasOutdatedBikiniPrice = product =>
    product.type === 'bikini' &&
    String(product.name || '').trim().toLowerCase() === 'pynx star bikini set' &&
    Number(product.price) === 89;
  const legacyCapName = 'Vintage Cap | Washed Cotton Unisex Baseball Cap | Adjustable Casual Streetwear';
  const legacyCapPrices = new Set([309, 469]);
  const capSeedFor = product => Array.isArray(SEEDS.products)
    ? SEEDS.products.find(seed => seed.type === 'cap' && String(seed.id) === String(product.id))
    : null;
  const needsCapPriceUpdate = product => {
    const seed = capSeedFor(product);
    const price = Number(product.price);
    return Boolean(seed
      && Number(seed.price) !== price
      && legacyCapPrices.has(price)
      && Number(product.originalPrice ?? product.price) === price
      && product.onSale !== true);
  };
  const needsCapSeedUpdate = product => {
    const seed = capSeedFor(product);
    return Boolean(seed && (
      product.image !== seed.image ||
      String(product.name || '').trim() === legacyCapName ||
      needsCapPriceUpdate(product)
    ));
  };

  if (!products.some(product => hasOutdatedBikiniPrice(product) || needsCapSeedUpdate(product))) return products;

  return withLock(async () => {
    const latestProducts = await loadProducts();
    let migrated = false;
    const updatedProducts = latestProducts.map(product => {
      if (hasOutdatedBikiniPrice(product)) {
        migrated = true;
        return { ...product, price: 489, originalPrice: 489, onSale: false };
      }
      if (!needsCapSeedUpdate(product)) return product;

      const seed = capSeedFor(product);
      migrated = true;
      return {
        ...product,
        image: seed.image,
        ...(needsCapPriceUpdate(product)
          ? { price: Number(seed.price), originalPrice: Number(seed.originalPrice ?? seed.price), onSale: false }
          : {}),
        ...(String(product.name || '').trim() === legacyCapName
          ? { name: seed.name, bg: seed.bg, desc: seed.desc }
          : {})
      };
    });

    if (migrated) await saveProducts(updatedProducts);
    return updatedProducts;
  });
}
const loadCustomers = () => loadCollection('customers');
const loadVouchers = () => loadCollection('vouchers');
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
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  },
}));
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
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 8000,
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

function newsletterApiBase(req) {
  const configuredBase = process.env.PUBLIC_API_URL || process.env.URL || '';
  const forwardedProtocol = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProtocol || req.protocol;
  return String(configuredBase || `${protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

async function notifyNewsletterSubscribers(product, type, req) {
  const subscribers = (await loadNewsletterSubscribers()).filter(subscriber => subscriber.active);
  if (!subscribers.length) return { sent: 0, failed: 0 };
  if (!EMAIL_USER || !EMAIL_PASS) {
    console.warn('Product email notification not sent: missing EMAIL_USER or EMAIL_PASS environment variables.');
    return { sent: 0, failed: subscribers.length, error: 'Email is not configured on the server.' };
  }

  const discounted = Number(product.originalPrice) > Number(product.price);
  const label = type === 'new' ? 'New at PYNX' : 'Now on sale at PYNX';
  const subject = `${label}: ${String(product.name).replace(/[\r\n]/g, ' ').slice(0, 120)}`;
  const siteBase = String(process.env.SITE_URL || process.env.URL || '').replace(/\/+$/, '');
  const shopUrl = siteBase ? `${siteBase}/shop.html?view=${type === 'new' ? 'new' : 'sale'}` : '';
  const apiBase = newsletterApiBase(req);

  const results = await Promise.all(subscribers.map(async subscriber => {
    const unsubscribeUrl = `${apiBase}/api/newsletter/unsubscribe?token=${encodeURIComponent(subscriber.unsubscribeToken)}`;
    const priceText = discounted
      ? `Now PHP ${Number(product.price).toFixed(2)} (regularly PHP ${Number(product.originalPrice).toFixed(2)}).`
      : `Price: PHP ${Number(product.price).toFixed(2)}.`;
    const text = [
      label,
      '',
      product.name,
      priceText,
      '',
      shopUrl ? `Shop now: ${shopUrl}` : 'Visit the PYNX store to shop now.',
      '',
      `To stop receiving these emails, unsubscribe here: ${unsubscribeUrl}`,
    ].join('\n');

    try {
      await transporter.sendMail({
        from: mailFrom(),
        replyTo: NOTIFY_EMAIL,
        to: subscriber.email,
        subject,
        text,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      return true;
    } catch (error) {
      console.error('Product email notification failed:', error);
      return false;
    }
  }));

  const sent = results.filter(Boolean).length;
  const failed = results.length - sent;
  return { sent, failed, ...(failed ? { error: 'Some notification emails could not be sent.' } : {}) };
}

async function unsubscribeFromNewsletter(token) {
  if (!token) return false;
  return withLock(async () => {
    const subscribers = await loadNewsletterSubscribers();
    const subscriber = subscribers.find(item => item.unsubscribeToken === token);
    if (!subscriber) return false;
    subscriber.active = false;
    subscriber.unsubscribedAt = new Date().toISOString();
    await saveNewsletterSubscribers(subscribers);
    return true;
  });
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

app.post('/api/customers/forgot-password', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
  }
  let base;
  try {
    base = new URL(process.env.SITE_URL || '');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
      || (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname))) throw new Error('Invalid SITE_URL');
  } catch (error) {
    console.error('Password reset requires a valid SITE_URL:', error.message);
    return res.status(503).json({ success: false, message: 'Password recovery is not configured. Please contact the store.' });
  }
  if (!EMAIL_USER || !EMAIL_PASS) {
    console.error('Password reset requires EMAIL_USER and EMAIL_PASS.');
    return res.status(503).json({ success: false, message: 'Password recovery is not configured. Please contact the store.' });
  }
  const message = 'If an account exists for that email, a password reset link will be sent.';
  try {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const now = new Date();
    const reset = { tokenHash, requestedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString() };
    const customer = await withLock(async () => {
      const customers = await loadCustomers();
      const stored = customers.find(item => String(item.email || '').toLowerCase() === email);
      if (!stored || Date.parse(stored.passwordReset?.requestedAt || '') > now.getTime() - 60 * 1000) return null;
      if (StoreModel) {
        const updated = await StoreModel.updateOne({
          _id: 'customers',
          data: { $elemMatch: { id: stored.id, $or: [
            { 'passwordReset.requestedAt': { $exists: false } },
            { 'passwordReset.requestedAt': { $lte: new Date(now.getTime() - 60 * 1000).toISOString() } },
          ] } },
        }, { $set: { 'data.$.passwordReset': reset } });
        if (!updated.modifiedCount) return null;
      } else {
        stored.passwordReset = reset;
        await saveCustomers(customers);
      }
      return stored;
    });
    if (customer) {
      const resetUrl = new URL('reset-password.html', base.href.endsWith('/') ? base.href : `${base.href}/`);
      resetUrl.hash = token;
      const text = `Hi ${customer.firstName},\n\nUse this link to reset your PYNX password:\n${resetUrl.href}\n\nThis link expires in 30 minutes and can be used once. If you did not request it, ignore this email.\n\n- PYNX`;
      const html = `<div style="font-family:Arial,sans-serif"><h1>PYNX</h1><p>Hi ${escapeHtml(customer.firstName)},</p><p>Use this link to reset your PYNX password:</p><p><a href="${escapeHtml(resetUrl.href)}">Reset your password</a></p><p>This link expires in 30 minutes and can be used once. If you did not request it, ignore this email.</p><p>- PYNX</p></div>`;
      const result = await notifyCustomer(email, 'Reset your PYNX password', text, html);
      if (!result.emailSent) console.error('Password reset email failed:', result.emailError);
    }
    return res.json({ success: true, message });
  } catch (error) {
    console.error('Password reset request failed:', error);
    return res.status(500).json({ success: false, message: 'Unable to request a password reset. Please try again later.' });
  }
});

app.post('/api/customers/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)
    || typeof password !== 'string' || password.length < 6 || password.length > 200) {
    return res.status(400).json({ success: false, message: 'Provide a valid reset link and a password between 6 and 200 characters.' });
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const now = new Date().toISOString();
  try {
    const changed = await withLock(async () => {
      const credentials = hashPassword(password);
      if (StoreModel) {
        const result = await StoreModel.updateOne({
          _id: 'customers',
          data: { $elemMatch: { 'passwordReset.tokenHash': tokenHash, 'passwordReset.expiresAt': { $gt: now } } },
        }, { $set: { 'data.$.passwordSalt': credentials.passwordSalt, 'data.$.passwordHash': credentials.passwordHash },
          $unset: { 'data.$.passwordReset': '' } });
        return result.modifiedCount === 1;
      }
      const customers = await loadCustomers();
      const customer = customers.find(item => item.passwordReset?.tokenHash === tokenHash && item.passwordReset.expiresAt > now);
      if (!customer) return false;
      Object.assign(customer, credentials);
      delete customer.passwordReset;
      await saveCustomers(customers);
      return true;
    });
    if (!changed) return res.status(400).json({ success: false, message: 'This reset link is invalid, expired, or has already been used.' });
    return res.json({ success: true, message: 'Your password has been changed. You can now log in.' });
  } catch (error) {
    console.error('Password reset failed:', error);
    return res.status(500).json({ success: false, message: 'Unable to reset your password. Please try again later.' });
  }
});

// processing = being packed, done = packed and ready to ship, shipped = on the way.
const ORDER_STATUSES = ['processing', 'done', 'shipped', 'delivered', 'cancelled'];

// Optional shipping origin (for example "Cagayan de Oro City, Misamis Oriental") drawn on the tracking map.
const SHIP_FROM = process.env.SHIP_FROM || '';
const GEOCODE_COUNTRY = process.env.GEOCODE_COUNTRY !== undefined ? process.env.GEOCODE_COUNTRY : 'ph';

const formatDateTime = iso => new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });

// Free OpenStreetMap geocoding. Usage policy allows about one request per second, so lookups are spaced out and failures are remembered briefly.
const geocodeFailures = new Map();
const geocodeHits = new Map();
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
  if (geocodeHits.has(text)) return geocodeHits.get(text);
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
      if (point) {
        geocodeHits.set(text, point);
        return point;
      }
    } catch (err) {
      console.warn('Geocoding failed:', err.message);
      hadError = true;
    }
  }
  if (!hadError) geocodeFailures.set(text, Date.now());
  return null;
}

// Straight-line distance in kilometres between two lat/lng points.
function haversineKm(a, b) {
  const toRadians = degrees => degrees * Math.PI / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// Finds the customer's delivery point, used for the per-km shipping fee.
async function deliveryPoint(addressParts) {
  const text = [addressParts.street, addressParts.barangay, addressParts.city, addressParts.province].filter(Boolean).join(', ');
  return geocode(text);
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

const trackingUrl = (req, order) => `${siteBaseUrl(req)}/track/${encodeURIComponent(orderNumber(order))}`;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function trackingUpdateEmail(order, event, req) {
  const step = TRACKING_STEPS[event.stepIndex];
  const title = event.title || step.title;
  const location = event.location || '';
  const number = orderNumber(order);
  const trackLink = trackingUrl(req, order);
  const trackingNumber = String(order.trackingNumber || '');
  const trackTemplate = process.env.JNT_TRACKING_URL_TEMPLATE || 'https://www.jtexpress.ph/';
  const jntUrl = trackingNumber
    ? trackTemplate.includes('{trackingNumber}')
      ? trackTemplate.replaceAll('{trackingNumber}', encodeURIComponent(trackingNumber))
      : trackTemplate
    : '';
  const isOutForDelivery = event.stepIndex === 6;
  const isDelivered = event.stepIndex === 7;
  let subject;
  let update;
  if (isDelivered) {
    subject = `Your PYNX order ${number} has been delivered`;
    update = location ? `Your order has been delivered at ${location}.` : 'Your order has been delivered.';
  } else if (isOutForDelivery) {
    subject = `Your PYNX order ${number} is out for delivery`;
    update = location ? `Your package is out for delivery from ${location}.` : 'Your package is out for delivery.';
  } else if (event.stepIndex === 0) {
    subject = `Your PYNX order ${number} is being prepared`;
    update = `Your order status is now ${title}.`;
  } else if (event.stepIndex === 1) {
    subject = `Your PYNX order ${number} is packaged for pickup`;
    update = `Your order status is now ${title}.`;
  } else {
    subject = `Your PYNX order ${number} is in transit`;
    update = location
      ? `Your package is in transit. Latest update: ${title} at ${location}.`
      : `Your package status is now ${title}.`;
  }
  const text = [
    `Hi ${order.firstName},`,
    '',
    update,
    '',
    `Order number: ${number}`,
    ...(trackingNumber ? [`J&T tracking number: ${trackingNumber}`] : []),
    `Tracking update: ${title}`,
    ...(location ? [`Location: ${location}`] : []),
    `Track on our site: ${trackLink}`,
    ...(jntUrl ? [`Track on J&T: ${jntUrl}`] : []),
    '',
    '- PYNX',
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111"><h1>PYNX</h1><p>Hi ${escapeHtml(order.firstName)},</p><p>${escapeHtml(update)}</p><p><strong>Order number:</strong> ${escapeHtml(number)}${trackingNumber ? `<br><strong>J&amp;T tracking number:</strong> ${escapeHtml(trackingNumber)}` : ''}<br><strong>Tracking update:</strong> ${escapeHtml(title)}${location ? `<br><strong>Location:</strong> ${escapeHtml(location)}` : ''}</p><p><a href="${escapeHtml(trackLink)}" style="background:#111;color:#fff;padding:12px 22px;text-decoration:none;border-radius:4px">Track on PYNX</a></p>${jntUrl ? `<p><a href="${escapeHtml(jntUrl)}" style="background:#e11d48;color:#fff;padding:12px 22px;text-decoration:none;border-radius:4px">Track on J&amp;T</a></p>` : ''}<p>- PYNX</p></div>`;
  return { subject, text, html };
}

async function sendTrackingUpdateEmail(order, event, req) {
  const email = trackingUpdateEmail(order, event, req);
  const result = await notifyCustomer(String(order.email || '').trim(), email.subject, email.text, email.html);
  await withLock(async () => {
    const orders = await loadOrders();
    const stored = orders.find(item => item.id === order.id);
    const storedEvent = stored?.trackingEvents?.find(item => item.at === event.at);
    if (!storedEvent) throw new Error('Tracking update was not found while recording its email result.');
    storedEvent.notification = {
      sent: Boolean(result.emailSent),
      error: result.emailError || null,
      at: new Date().toISOString(),
    };
    await saveOrders(orders);
  });
  return result;
}

async function sendPaymentStatusEmail(order) {
  const number = orderNumber(order);
  const subject = `Payment received for your PYNX order ${number}`;
  const text = [
    `Hi ${order.firstName},`,
    '',
    `We have received your cash-on-delivery payment for order ${number}.`,
    '',
    `Amount paid: PHP ${Number(order.total).toFixed(2)}`,
    `Payment status: Paid`,
    '',
    '- PYNX',
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111"><h1>PYNX</h1><p>Hi ${escapeHtml(order.firstName)},</p><p>We have received your cash-on-delivery payment for order <strong>${escapeHtml(number)}</strong>.</p><p><strong>Amount paid:</strong> PHP ${Number(order.total).toFixed(2)}<br><strong>Payment status:</strong> Paid</p><p>- PYNX</p></div>`;
  const result = await notifyCustomer(String(order.email || '').trim(), subject, text, html);
  await withLock(async () => {
    const orders = await loadOrders();
    const stored = orders.find(item => item.id === order.id);
    if (!stored) return;
    stored.paymentEmail = {
      sent: Boolean(result.emailSent),
      error: result.emailError || null,
      at: new Date().toISOString(),
    };
    await saveOrders(orders);
  });
  return result;
}

async function sendOnlinePaymentReceivedEmail(order) {
  const number = orderNumber(order);
  const method = order.paymentMethod === 'gcash' ? 'GCash' : order.paymentMethod === 'card' ? 'card' : 'QRPH';
  const subject = `Payment received for your PYNX order ${number}`;
  const refundNote = 'If a refund is approved, it takes 3–5 days to reach your account.';
  const text = [
    `Hi ${order.firstName},`,
    '',
    `We have received your ${method} payment for order ${number}. Thank you!`,
    '',
    `Amount paid: PHP ${Number(order.total).toFixed(2)}`,
    `Payment method: ${method}`,
    'Payment status: Paid',
    '',
    refundNote,
    '',
    '- PYNX',
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111"><h1>PYNX</h1><p>Hi ${escapeHtml(order.firstName)},</p><p>We have received your ${escapeHtml(method)} payment for order <strong>${escapeHtml(number)}</strong>. Thank you!</p><p><strong>Amount paid:</strong> PHP ${Number(order.total).toFixed(2)}<br><strong>Payment method:</strong> ${escapeHtml(method)}<br><strong>Payment status:</strong> Paid</p><p>${escapeHtml(refundNote)}</p><p>- PYNX</p></div>`;
  const result = await notifyCustomer(String(order.email || '').trim(), subject, text, html);
  await withLock(async () => {
    const orders = await loadOrders();
    const stored = orders.find(item => item.id === order.id);
    if (!stored) return;
    stored.paymentEmail = {
      sent: Boolean(result.emailSent),
      error: result.emailError || null,
      at: new Date().toISOString(),
    };
    await saveOrders(orders);
  });
  return result;
}

async function sendRefundTransferLinkEmail(order, transferLink) {
  const number = orderNumber(order);
  const subject = `Refund details for your PYNX order ${number}`;
  const text = [
    `Hi ${order.firstName},`,
    '',
    `A refund has been initiated for your PYNX order ${number}.`,
    '',
    `To receive the refund, securely enter your bank or e-wallet details using this PayMongo link: ${transferLink}`,
    'This link expires in 3 days. PYNX will never ask you to send your bank details by email.',
    '',
    '- PYNX',
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111"><h1>PYNX</h1><p>Hi ${escapeHtml(order.firstName)},</p><p>A refund has been initiated for your PYNX order <strong>${escapeHtml(number)}</strong>.</p><p>To receive the refund, securely enter your bank or e-wallet details using PayMongo's link:</p><p style="margin:24px 0"><a href="${escapeHtml(transferLink)}" style="background:#111;color:#fff;padding:12px 22px;text-decoration:none;border-radius:4px">Continue to PayMongo</a></p><p>This link expires in 3 days. PYNX will never ask you to send your bank details by email.</p><p>- PYNX</p></div>`;
  return notifyCustomer(String(order.email || '').trim(), subject, text, html);
}

async function sendPendingPaymentEmail(order, checkoutUrl) {
  const number = orderNumber(order);
  const subject = `Payment pending for your PYNX order ${number}`;
  const text = [
    `Hi ${order.firstName},`,
    '',
    `Payment for your PYNX order ${number} is still pending.`,
    `Total to pay: PHP ${Number(order.total).toFixed(2)}`,
    '',
    `Return to PayMongo to complete your QRPH payment: ${checkoutUrl}`,
    '',
    'Your order will be processed after PayMongo confirms your payment.',
    '',
    '- PYNX',
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111"><h1>PYNX</h1><p>Hi ${escapeHtml(order.firstName)},</p><p>Payment for your PYNX order <strong>${escapeHtml(number)}</strong> is still pending.</p><p><strong>Total to pay:</strong> PHP ${Number(order.total).toFixed(2)}</p><p>Your order will be processed after PayMongo confirms your payment.</p><p style="margin:24px 0"><a href="${escapeHtml(checkoutUrl)}" style="background:#111;color:#fff;padding:12px 22px;text-decoration:none;border-radius:4px">Resume QRPH payment</a></p><p>- PYNX</p></div>`;
  return notifyCustomer(String(order.email || '').trim(), subject, text, html);
}

function orderItemLines(items) {
  return items.map(item => {
    const price = Number(item.product?.price) || 0;
    const qty = Number(item.qty) || 1;
    return {
      name: item.product?.name || 'Item',
      size: item.size || '',
      image: item.product?.image || '',
      images: Array.isArray(item.product?.images) ? item.product.images : [],
      fitImage: item.product?.fitImage || '',
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

// Package updates shown on the tracking page, newest first.
function trackingEvents(order) {
  if (Array.isArray(order.trackingEvents) && order.trackingEvents.length) {
    return [...order.trackingEvents].reverse().map(event => {
      const step = TRACKING_STEPS[event.stepIndex];
      return {
        at: event.at,
        title: event.title || step?.title || 'Package update',
        description: event.location || ({
          0: 'We received your order and are preparing it.',
          1: 'Your order is packed and ready for the courier.',
          3: 'Your order has been shipped.',
          6: 'Your package is out for delivery.',
          7: 'Your package has been delivered.',
        }[event.stepIndex] || 'Your order status was updated.'),
        major: true,
        location: event.location,
      };
    });
  }
  const times = order.statusTimes || {};
  const events = [{ at: order.createdAt, title: 'Preparing to ship', description: 'We received your order and are preparing your package.', major: true }];
  if (times.done) events.push({ at: times.done, title: 'Packed and ready to ship', description: 'Your package is packed and waiting for the courier to pick it up.', major: true });
  if (times.shipped) events.push({ at: times.shipped, title: 'Package picked up', description: 'Your package was collected by our carrier and is on its way.', major: true });
  (order.locationUpdates || []).forEach(update => events.push({ at: update.at, title: 'In transit', description: `Package is now in ${update.text}.`, major: false }));
  if (times.delivered) events.push({ at: times.delivered, title: 'Delivered', description: 'Your package has been delivered. Thank you for shopping with PYNX!', major: true });
  if (times.cancelled) events.push({ at: times.cancelled, title: 'Order cancelled', description: 'This order was cancelled by the store.', major: true });
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
  const latestTrackingEvent = order.trackingEvents?.[order.trackingEvents.length - 1];
  const current = latestTrackingEvent?.point
    ? { ...latestTrackingEvent.point, text: latestTrackingEvent.location, updatedAt: latestTrackingEvent.at }
    : order.status === 'shipped' ? order.currentLocation : null;
  const latestStep = latestTrackingEvent?.stepIndex ?? -1;
  return {
    id: order.id,
    orderNumber: orderNumber(order),
    firstName: order.firstName,
    recipient: { name: `${order.firstName} ${order.lastName}`.trim(), phone: maskPhone(order.contact), address: order.address },
    status: order.status || 'processing',
    createdAt: order.createdAt,
    statusUpdatedAt: order.statusUpdatedAt || null,
    statusTimes: order.statusTimes || {},
    events: trackingEvents(order),
    trackingStepIndex: latestStep,
    trackingSteps: TRACKING_STEPS.map(step => step.title),
    trackingNumber: order.trackingNumber || null,
    jntTrackingUrl: order.trackingNumber
      ? (process.env.JNT_TRACKING_URL_TEMPLATE || 'https://www.jtexpress.ph/').includes('{trackingNumber}')
        ? (process.env.JNT_TRACKING_URL_TEMPLATE || 'https://www.jtexpress.ph/').replaceAll('{trackingNumber}', encodeURIComponent(order.trackingNumber))
        : process.env.JNT_TRACKING_URL_TEMPLATE || 'https://www.jtexpress.ph/'
      : null,
    paymentMethod: order.paymentMethod || null,
    paymentStatus: order.paymentStatus || 'pending',
    subtotal: Number(order.subtotal ?? (Number(order.total) - Number(order.shippingFee || 0))) || 0,
    shippingFee: Number(order.shippingFee) || 0,
    discount: Number(order.discount) || 0,
    voucherCode: order.voucherCode || null,
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
  const mapsLink = googleMapsUrl(order.address);
  const placed = formatDateTime(order.createdAt);
  const text = [
    `Hi ${order.firstName},`,
    '',
    `Thank you for shopping with PYNX. We've received your order.`,
    '',
    `Order number: ${number}`,
    `Order placed: ${placed}`,
    `Payment method: ${order.paymentMethod === 'cash_on_hand' ? 'Cash on delivery' : order.paymentMethod === 'gcash' ? 'GCash' : order.paymentMethod === 'qrph' ? 'QRPH' : 'Card'}`,
    `Payment status: ${order.paymentStatus === 'paid' ? 'Paid' : 'Pending'}`,
    '',
    'Items:',
    ...(lines.map(l => `${l.name}${l.size ? ` / ${l.size}` : ''} x${l.qty} - PHP ${l.lineTotal.toFixed(2)}`)),
    '',
    `Item subtotal: PHP ${Number(order.subtotal ?? order.total - (order.shippingFee || 0)).toFixed(2)}`,
    ...(order.discount > 0 ? [`Voucher ${order.voucherCode} discount: -PHP ${Number(order.discount).toFixed(2)}`] : []),
    `Additional fee (shipping): PHP ${Number(order.shippingFee || 0).toFixed(2)}`,
    `Total to pay: PHP ${order.total.toFixed(2)}`,
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
<p><strong>Payment:</strong> ${escapeHtml(order.paymentMethod === 'cash_on_hand' ? 'Cash on delivery' : order.paymentMethod === 'gcash' ? 'GCash' : order.paymentMethod === 'qrph' ? 'QRPH' : 'Card')} (${escapeHtml(order.paymentStatus === 'paid' ? 'Paid' : 'Pending')})</p>
<table style="width:100%;border-collapse:collapse">${rows}<tr><td colspan="2" style="padding:10px 0">Item subtotal</td><td style="padding:10px 0;text-align:right">PHP ${Number(order.subtotal ?? order.total - (order.shippingFee || 0)).toFixed(2)}</td></tr>${order.discount > 0 ? `<tr><td colspan="2" style="padding:10px 0">Voucher ${escapeHtml(order.voucherCode)}</td><td style="padding:10px 0;text-align:right">-PHP ${Number(order.discount).toFixed(2)}</td></tr>` : ''}<tr><td colspan="2" style="padding:10px 0">Additional fee (shipping)</td><td style="padding:10px 0;text-align:right">PHP ${Number(order.shippingFee || 0).toFixed(2)}</td></tr><tr><td colspan="2" style="padding:10px 0;font-weight:bold">Total to pay</td><td style="padding:10px 0;text-align:right;font-weight:bold">PHP ${order.total.toFixed(2)}</td></tr></table>
<p><strong>Shipping address:</strong> ${escapeHtml(order.address)}<br><a href="${escapeHtml(mapsLink)}">View on Google Maps</a><br><strong>Contact:</strong> ${escapeHtml(order.contact)}</p>
${link ? `<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#111;color:#fff;padding:12px 22px;text-decoration:none;border-radius:4px">Track your order</a></p><p style="font-size:12px;color:#777">Or open this link: ${escapeHtml(link)}</p>` : ''}
<p>- PYNX</p></div>`;
  return { text, html };
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

function cleanProductImages(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 8) return null;
  const images = value.map(image => String(image || '').trim());
  if (images.some(image => !image || image.length > 500 || /^(?:javascript|data):/i.test(image))) return null;
  return [...new Set(images)];
}

function shippingArea(addressParts) {
  const normalize = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const region = normalize(addressParts.region);
  const province = normalize(addressParts.province);
  if (province === 'cebu' || province === 'cebuprovince') return 'cebu';
  if (province === 'ncr' || province === 'metromanila' || region === 'ncr') return 'ncr';
  if (region === 'visayas') return 'visayas';
  if (region === 'luzon') return 'luzon';
  if (region === 'mindanao') return 'mindanao';
  return null;
}

function cebuShippingRate(city) {
  const normalized = String(city || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return ['cityofcebu', 'cebucity', 'cebu'].includes(normalized)
    ? CEBU_CITY_SHIPPING_RATE_PER_KM
    : CEBU_PROVINCE_SHIPPING_RATE_PER_KM;
}

function shippingQuote(items, products, destination, addressParts) {
  const area = shippingArea(addressParts);
  if (!area) return { error: 'Please select a supported delivery region and province.' };
  if (area === 'cebu' && !destination) {
    return { error: "We couldn't find your address on the map. Please check the street, barangay, city, and province." };
  }
  const distanceKm = area === 'cebu' ? Math.ceil(haversineKm(SHIPPING_ORIGIN, destination)) : null;
  let subtotal = 0;
  const normalizedItems = [];
  for (const item of items) {
    const product = products.find(candidate => String(candidate.id) === String(item.product?.id));
    if (!product) return { error: `${item.product?.name || 'A product'} is no longer available. Please refresh your cart.` };
    const quantity = Number(item?.qty);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      return { error: 'Order quantities must be whole numbers between 1 and 99.' };
    }
    subtotal += Number(product.price) * quantity;
    normalizedItems.push({
      product: { ...product },
      qty: quantity,
      size: clean(item.size, 20),
    });
  }

  const shippingFee = area === 'cebu'
    ? Math.max(MINIMUM_SHIPPING_FEE, Math.round(distanceKm * cebuShippingRate(addressParts.city) * 100) / 100)
    : FLAT_SHIPPING_FEES[area];
  return {
    shippingArea: area,
    distanceKm,
    shippingFee,
    subtotal,
    items: normalizedItems,
  };
}

// Vouchers come from data/vouchers.json. Usage is counted from orders that were not cancelled.
function applyVoucher(rawCode, subtotal, vouchers, orders) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { code: '', discount: 0 };
  const voucher = (Array.isArray(vouchers) ? vouchers : [])
    .find(item => String(item.code || '').trim().toUpperCase() === code);
  if (!voucher || voucher.active === false) return { error: 'That voucher code is not valid.' };
  if (voucher.expiresAt && new Date(voucher.expiresAt).getTime() < Date.now()) return { error: 'This voucher has expired.' };
  const minSubtotal = Number(voucher.minSubtotal) || 0;
  if (subtotal < minSubtotal) return { error: `This voucher needs a subtotal of at least ₱${minSubtotal.toFixed(2)}.` };
  if (Number.isInteger(voucher.maxUses)) {
    const used = orders.filter(order => order.voucherCode === code && order.status !== 'cancelled').length;
    if (used >= voucher.maxUses) return { error: 'This voucher has already been used up.' };
  }
  const value = Number(voucher.value) || 0;
  const raw = voucher.type === 'percent' ? subtotal * value / 100 : value;
  const discount = Math.round(Math.min(Math.max(raw, 0), subtotal) * 100) / 100;
  return { code, discount };
}

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

async function sendOrderReceipt(order, req) {
  const link = trackingUrl(req, order);
  const receipt = receiptEmail(order, link);
  const result = await notifyCustomer(
    String(order.email).trim(),
    `Your PYNX order receipt (${orderNumber(order)})`,
    receipt.text,
    receipt.html
  );
  await recordReceiptResult(order.id, result);
  return result;
}

async function createPayMongoCheckout(order, req) {
  if (!PAYMONGO_SECRET_KEY) throw new Error('Online payments are not configured. Please choose cash on delivery or contact the store.');
  const base = siteBaseUrl(req);
  const itemLines = order.items.map(item => {
    const image = String(item.product.image || '').trim();
    const imageUrl = /^https?:\/\//i.test(image)
      ? image
      : base && image && !/^(?:javascript|data):/i.test(image)
        ? `${base}/${image.replace(/^(?:\.\/|\/)+/, '')}`
        : '';
    return {
      currency: 'PHP',
      amount: Math.round(Number(item.product.price) * 100),
      name: String(item.product.name).slice(0, 100),
      quantity: item.qty,
      ...(imageUrl ? { images: [imageUrl] } : {}),
    };
  });
  // PayMongo has no negative line items, so a voucher is shown as one discounted items line.
  const lineItems = order.discount > 0
    ? [{
      currency: 'PHP',
      amount: Math.round((Number(order.subtotal) - Number(order.discount)) * 100),
      name: `Items (voucher ${order.voucherCode} applied)`.slice(0, 100),
      quantity: 1,
    }]
    : itemLines;
  if (order.shippingFee > 0) {
    lineItems.push({
      currency: 'PHP',
      amount: Math.round(order.shippingFee * 100),
      name: 'J&T shipping',
      quantity: 1,
    });
  }
  const response = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${PAYMONGO_SECRET_KEY}:`).toString('base64')}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      data: {
        attributes: {
          cancel_url: `${base}/track/${encodeURIComponent(orderNumber(order))}?payment=cancelled`,
          success_url: `${base}/track/${encodeURIComponent(orderNumber(order))}?payment=success`,
          description: `PYNX order ${orderNumber(order)}`,
          reference_number: orderNumber(order),
          payment_method_types: [order.paymentMethod],
          line_items: lineItems,
          metadata: { order_id: order.id, order_number: orderNumber(order) },
        },
      },
    }),
    signal: AbortSignal.timeout(12000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('PayMongo checkout creation failed:', result.errors || response.status);
    throw new Error('Unable to start PayMongo checkout. Please try again or choose cash on delivery.');
  }
  const session = result.data;
  if (!session?.id || !session.attributes?.checkout_url) {
    console.error('PayMongo returned an incomplete checkout session.');
    throw new Error('PayMongo did not return a checkout link. Please try again.');
  }
  return { id: session.id, url: session.attributes.checkout_url };
}

async function rollbackUnpaidOrder(order) {
  await withLock(async () => {
    const [orders, products] = await Promise.all([loadOrders(), loadProducts()]);
    const stored = orders.find(item => item.id === order.id);
    if (!stored || stored.paymentStatus === 'paid') return;
    for (const reservation of stored.inventoryReservations || []) {
      const product = products.find(item => String(item.id) === String(reservation.productId));
      if (product && Number.isInteger(product.stock)) product.stock += reservation.quantity;
    }
    await saveProducts(products);
    await saveOrders(orders.filter(item => item.id !== order.id));
  });
}

app.post('/api/shipping/quote', async (req, res) => {
  const suppliedAddress = req.body.addressParts || {};
  const addressParts = {
    region: clean(suppliedAddress.region, 40),
    province: clean(suppliedAddress.province),
    city: clean(suppliedAddress.city),
    barangay: clean(suppliedAddress.barangay),
    postalCode: '',
    street: clean(suppliedAddress.street),
  };
  if (!addressParts.province || !addressParts.city || !Array.isArray(req.body.items) || req.body.items.length === 0) {
    return res.status(400).json({ success: false, message: 'Enter your province and city and add an item to your cart.' });
  }
  try {
    const area = shippingArea(addressParts);
    const destination = area === 'cebu' ? cleanPoint(req.body.location) || await deliveryPoint(addressParts) : null;
    const quote = shippingQuote(req.body.items, await loadProducts(), destination, addressParts);
    if (quote.error) return res.status(422).json({ success: false, message: quote.error });
    const voucher = applyVoucher(req.body.voucherCode, quote.subtotal, await loadVouchers(), await loadOrders());
    const discount = voucher.discount || 0;
    return res.json({
      success: true,
      distanceKm: quote.distanceKm,
      shippingFee: quote.shippingFee,
      subtotal: quote.subtotal,
      voucherCode: voucher.code || '',
      voucherError: voucher.error || '',
      discount,
      total: quote.subtotal - discount + quote.shippingFee,
    });
  } catch (error) {
    console.error('Shipping quote failed:', error);
    return res.status(500).json({ success: false, message: 'Unable to calculate shipping right now.' });
  }
});

app.get('/api/checkout/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({
    success: true,
    onlinePaymentsEnabled: ONLINE_PAYMENTS_ENABLED,
  });
});

app.post('/api/webhooks/paymongo', async (req, res) => {
  if (!PAYMONGO_SECRET_KEY || !PAYMONGO_WEBHOOK_SECRET) {
    return res.status(503).json({ success: false, message: 'PayMongo webhook is not configured.' });
  }
  const signatureHeader = String(req.get('paymongo-signature') || '');
  const signatureParts = Object.fromEntries(signatureHeader.split(',').map(part => {
    const [key, value] = part.trim().split('=');
    return [key, value];
  }).filter(([key, value]) => key && value));
  const timestamp = signatureParts.t;
  const signature = PAYMONGO_SECRET_KEY.startsWith('sk_live_') ? signatureParts.li : signatureParts.te;
  if (!timestamp || !signature || !req.rawBody) {
    return res.status(400).json({ success: false, message: 'Invalid PayMongo webhook signature.' });
  }
  const expected = crypto.createHmac('sha256', PAYMONGO_WEBHOOK_SECRET)
    .update(`${timestamp}.${req.rawBody.toString('utf8')}`)
    .digest('hex');
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== receivedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
    return res.status(400).json({ success: false, message: 'Invalid PayMongo webhook signature.' });
  }

  const event = req.body?.data?.attributes;
  const eventType = String(event?.type || '');
  if (eventType === 'payment.refund.updated') {
    const refund = event?.data;
    const refundId = String(refund?.id || '');
    const refundAttributes = refund?.attributes || {};
    const paymentId = String(refundAttributes.payment_id || '');
    const transferLink = String(refundAttributes.transfer_link || '');
    if (!refundId || !paymentId) {
      return res.status(400).json({ success: false, message: 'PayMongo refund event is missing its refund or payment ID.' });
    }
    if (!transferLink) return res.json({ success: true, ignored: true, message: 'Refund does not include a customer transfer link.' });

    let transferUrl;
    try {
      transferUrl = new URL(transferLink);
    } catch {
      return res.status(400).json({ success: false, message: 'PayMongo refund event contains an invalid transfer link.' });
    }
    const validTransferHost = transferUrl.protocol === 'https:'
      && (transferUrl.hostname.endsWith('.paymongo.com') || transferUrl.hostname.endsWith('.paymongo-stg.com'));
    if (!validTransferHost) {
      console.error('PayMongo refund event contained an unexpected transfer link host.');
      return res.status(400).json({ success: false, message: 'PayMongo refund event contains an unexpected transfer link.' });
    }

    try {
      const claim = await withLock(async () => {
        const orders = await loadOrders();
        const stored = orders.find(item => item.paymongoPaymentId === paymentId);
        if (!stored) return { unmatched: true };
        if (!Array.isArray(stored.refundNotifications)) stored.refundNotifications = [];
        let notification = stored.refundNotifications.find(item => item.refundId === refundId);
        if (notification?.status === 'sent') return { duplicate: true };
        if (notification?.status === 'sending'
          && Date.now() - Date.parse(notification.updatedAt || '') < 5 * 60 * 1000) return { duplicate: true };
        if (!notification) {
          notification = { refundId };
          stored.refundNotifications.push(notification);
        }
        notification.status = 'sending';
        notification.transferLink = transferLink;
        notification.updatedAt = new Date().toISOString();
        await saveOrders(orders);
        return {
          order: {
            id: stored.id,
            firstName: stored.firstName,
            email: stored.email,
            orderNumber: orderNumber(stored),
          },
        };
      });

      if (claim.unmatched) {
        console.warn(`PayMongo refund ${refundId} did not match a PYNX order.`);
        return res.json({ success: true, ignored: true });
      }
      if (claim.duplicate) return res.json({ success: true, duplicate: true });

      const result = await sendRefundTransferLinkEmail(claim.order, transferLink);
      await withLock(async () => {
        const orders = await loadOrders();
        const stored = orders.find(item => item.id === claim.order.id);
        const notification = stored?.refundNotifications?.find(item => item.refundId === refundId);
        if (!notification) return;
        notification.status = result.emailSent ? 'sent' : 'failed';
        notification.emailError = result.emailError || null;
        notification.updatedAt = new Date().toISOString();
        await saveOrders(orders);
      });
      if (!result.emailSent) {
        console.error(`Could not email PayMongo refund link for order ${claim.order.orderNumber}: ${result.emailError || 'unknown email error'}`);
        return res.status(502).json({ success: false, message: 'Could not send the customer refund email.' });
      }
      return res.json({ success: true, emailSent: true });
    } catch (error) {
      console.error('PayMongo refund notification failed:', error);
      return res.status(500).json({ success: false, message: 'Could not process the PayMongo refund notification.' });
    }
  }
  if (eventType !== 'checkout_session.payment.paid') return res.json({ success: true, ignored: true });
  const sessionId = String(event?.data?.id || '');
  if (!sessionId) return res.status(400).json({ success: false, message: 'PayMongo event is missing the checkout session ID.' });

  try {
    const response = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${encodeURIComponent(sessionId)}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${PAYMONGO_SECRET_KEY}:`).toString('base64')}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Could not verify PayMongo checkout session:', result.errors || response.status);
      return res.status(502).json({ success: false, message: 'Could not verify the PayMongo payment.' });
    }
    const session = result.data;
    const attributes = session?.attributes || {};
    if (attributes.status !== 'paid') return res.status(202).json({ success: true, pending: true });
    const orderId = String(attributes.metadata?.order_id || '');
    const order = await withLock(async () => {
      const orders = await loadOrders();
      const stored = orders.find(item => item.id === orderId && item.paymongoSessionId === sessionId);
      if (!stored) return null;
      if (attributes.reference_number !== orderNumber(stored)
        || String(attributes.currency || '').toUpperCase() !== 'PHP'
        || Number(attributes.amount) !== Math.round(Number(stored.total) * 100)) return null;
      if (stored.paymentStatus !== 'paid') {
        stored.paymentStatus = 'paid';
        stored.paidAt = new Date().toISOString();
        stored.paymongoPaymentId = attributes.payments?.[0]?.id || null;
        await saveOrders(orders);
      }
      return stored;
    });
    if (!order) {
      console.error('PayMongo paid event did not match an order, session, amount, or currency.');
      return res.status(400).json({ success: false, message: 'Payment does not match an order.' });
    }
    if (!order.paymentEmail?.sent) await sendOnlinePaymentReceivedEmail(order);
    if (!order.receiptEmail?.sent) await sendOrderReceipt(order, req);
    return res.json({ success: true });
  } catch (error) {
    console.error('PayMongo webhook processing failed:', error);
    return res.status(500).json({ success: false, message: 'Could not process the payment webhook.' });
  }
});

app.post('/api/orders', async (req, res) => {
  const { firstName, lastName, email, contact, items = [] } = req.body;
  const paymentMethod = String(req.body.paymentMethod || '');
  const returnPolicyAgreement = req.body.returnPolicyAgreement;
  const addressParts = cleanAddressParts(req.body.addressParts);
  const address = addressParts ? formatAddressParts(addressParts) : clean(req.body.address, 400);

  if (!firstName || !lastName || !address || !email || !contact) {
    return res.status(400).json({ success: false, message: 'Please provide all required order details.' });
  }
  if (!addressParts) return res.status(400).json({ success: false, message: 'A complete province, city, barangay, and street address is required for shipping.' });
  const returnPolicyAgreedAt = Date.parse(returnPolicyAgreement?.agreedAt || '');
  if (returnPolicyAgreement?.version !== RETURN_POLICY_VERSION || !Number.isFinite(returnPolicyAgreedAt)) {
    return res.status(400).json({ success: false, message: 'Please review and agree to the current return and refund policy before placing your order.' });
  }
  if (paymentMethod !== 'cash_on_hand' && (paymentMethod !== 'qrph' || !ONLINE_PAYMENTS_ENABLED)) {
    return res.status(503).json({ success: false, message: 'QRPH payments are not configured. Please choose cash on delivery.' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Your cart is empty.' });
  }
  if (items.some(item => !item || !Number.isInteger(Number(item.qty)) || Number(item.qty) < 1)) {
    return res.status(400).json({ success: false, message: 'Order quantities must be whole numbers greater than zero.' });
  }

  const destination = cleanPoint(req.body.location) || await deliveryPoint(addressParts);
  const order = {
    id: crypto.randomUUID(),
    firstName: clean(firstName, 80),
    lastName: clean(lastName, 80),
    address,
    addressParts,
    returnPolicyAgreement: {
      version: RETURN_POLICY_VERSION,
      agreedAt: new Date(returnPolicyAgreedAt).toISOString(),
    },
    ...(destination ? { destination } : {}),
    email: String(email).trim().toLowerCase(),
    contact: clean(contact, 32),
    inventoryReservations: [],
    paymentMethod,
    paymentStatus: paymentMethod === 'cash_on_hand' ? 'pending' : 'awaiting_payment',
    status: 'processing',
    trackingStepIndex: -1,
    trackingEvents: [],
    createdAt: new Date().toISOString(),
  };

  try {
    const result = await withLock(async () => {
      const products = await loadProducts();
      const quote = shippingQuote(items, products, destination, addressParts);
      if (quote.error) return { error: quote.error };
      const quantities = new Map();
      for (const item of items) {
        const productId = String(item.product?.id ?? '');
        const product = products.find(candidate => String(candidate.id) === productId);
        if (!product) return { error: `Product ${item.product?.name || ''} is no longer available. Please refresh your cart.` };
        quantities.set(productId, (quantities.get(productId) || 0) + Number(item.qty));
      }

      for (const [productId, quantity] of quantities) {
        const product = products.find(candidate => String(candidate.id) === productId);
        if (Number.isInteger(product.stock) && product.stock < quantity) {
          return { error: `${product.name} does not have enough stock. Available: ${product.stock}.` };
        }
      }

      const existingOrders = await loadOrders();
      const voucher = applyVoucher(req.body.voucherCode, quote.subtotal, await loadVouchers(), existingOrders);
      if (voucher.error) return { error: voucher.error };
      const discount = voucher.discount || 0;

      order.items = quote.items;
      order.subtotal = quote.subtotal;
      order.shippingFee = quote.shippingFee;
      order.discount = discount;
      if (voucher.code) order.voucherCode = voucher.code;
      order.total = quote.subtotal - discount + quote.shippingFee;
      order.shippingDistanceKm = quote.distanceKm;
      order.shippingArea = quote.shippingArea;
      const originalProducts = products.map(product => ({ ...product }));
      quantities.forEach((quantity, productId) => {
        const product = products.find(candidate => String(candidate.id) === productId);
        if (Number.isInteger(product.stock)) {
          product.stock -= quantity;
          order.inventoryReservations.push({ productId, quantity });
        }
      });

      try {
        await saveProducts(products);
        const orders = await loadOrders();
        await saveOrders([...orders, order]);
      } catch (error) {
        try {
          await saveProducts(originalProducts);
        } catch (rollbackError) {
          console.error('Failed to roll back inventory after order save failed:', rollbackError);
        }
        throw error;
      }
      return { saved: true };
    });
    if (result.error) {
      return res.status(409).json({ success: false, message: result.error });
    }
  } catch (error) {
    console.error('Failed to save order:', error);
    return res.status(500).json({ success: false, message: 'Order save failed. Please try again later.' });
  }

  if (paymentMethod !== 'cash_on_hand') {
    try {
      const session = await createPayMongoCheckout(order, req);
      await withLock(async () => {
        const orders = await loadOrders();
        const stored = orders.find(item => item.id === order.id);
        if (stored) {
          stored.paymongoSessionId = session.id;
          await saveOrders(orders);
        }
      });
      const pendingPaymentEmail = await sendPendingPaymentEmail(order, session.url);
      if (!pendingPaymentEmail.emailSent) {
        console.error('PayMongo checkout was created, but the pending-payment email was not sent:', pendingPaymentEmail.emailError);
      }
      return res.status(201).json({
        success: true,
        order: { ...order, orderNumber: orderNumber(order) },
        checkoutUrl: session.url,
        trackingPath: `/track/${encodeURIComponent(orderNumber(order))}`,
        paymentEmailSent: Boolean(pendingPaymentEmail.emailSent),
      });
    } catch (error) {
      console.error('Online checkout setup failed:', error.message);
      try {
        await rollbackUnpaidOrder(order);
      } catch (rollbackError) {
        console.error('Could not roll back order after payment setup failed:', rollbackError);
      }
      return res.status(502).json({ success: false, message: error.message || 'Unable to start online payment.' });
    }
  }

  const itemLine = order.items.map(item => {
    const sizeText = item.size ? ` / ${item.size}` : '';
    const price = Number(item.product?.price) || 0;
    return `${item.product?.name || 'Item'} x${item.qty || 1}${sizeText} - PHP ${price.toFixed(2)} each`;
  }).join('\n') || 'No items.';

  const receiptPromise = sendOrderReceipt(order, req).catch(async error => {
    console.error('Order was saved, but the customer receipt email could not be processed:', error);
    const result = { emailSent: false, emailError: error.message || 'Receipt email failed.' };
    await recordReceiptResult(order.id, result);
    return result;
  });
  const [adminNotification, receiptResult] = await Promise.all([
    notifyAdmins(
      `New cash-on-delivery order from ${firstName} ${lastName}`,
      `New order details:\n\nName: ${firstName} ${lastName}\nEmail: ${email}\nContact: ${contact}\nAddress: ${address}\n\nItems:\n${itemLine}\n\nItem subtotal: PHP ${order.subtotal.toFixed(2)}${order.discount > 0 ? `\nVoucher ${order.voucherCode} discount: -PHP ${order.discount.toFixed(2)}` : ''}\nAdditional fee (shipping): PHP ${order.shippingFee.toFixed(2)}\nTotal to pay: PHP ${order.total.toFixed(2)}\nPlaced: ${order.createdAt}\n\nView it in the admin page.`
    ),
    receiptPromise,
  ]);
  if (!adminNotification.emailSent) {
    console.error('Order was saved, but the admin email notification failed:', adminNotification.emailError);
  }

  return res.status(201).json({
    success: true,
    order: { ...order, orderNumber: orderNumber(order) },
    trackingPath: `/track/${encodeURIComponent(orderNumber(order))}`,
    receiptEmailSent: Boolean(receiptResult.emailSent),
    receiptEmailConfigured: Boolean(EMAIL_USER && EMAIL_PASS),
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

app.get('/track/:orderNumber', (req, res) => {
  res.sendFile(path.join(__dirname, '../track.html'));
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
    const [products, orders] = await Promise.all([loadProductsWithPriceMigration(), loadOrders()]);
    const soldCounts = new Map();
    orders.forEach(order => {
      if (!order || order.status === 'cancelled'
        || (order.paymentMethod && order.paymentMethod !== 'cash_on_hand' && order.paymentStatus !== 'paid')) return;
      (Array.isArray(order.items) ? order.items : []).forEach(item => {
        const productId = String(item?.product?.id ?? '');
        const quantity = Number(item.qty);
        if (!productId || !Number.isInteger(quantity) || quantity < 1) return;
        soldCounts.set(productId, (soldCounts.get(productId) || 0) + quantity);
      });
    });
    const productsWithSales = products.map(product => ({
      ...product,
      soldCount: soldCounts.get(String(product.id)) || 0,
    }));
    return res.json({ success: true, products: productsWithSales });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Failed to load products.' });
  }
});

app.post('/api/newsletter/subscribe', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
  }

  try {
    const result = await withLock(async () => {
      const subscribers = await loadNewsletterSubscribers();
      const existing = subscribers.find(item => item.email === email);
      if (existing?.active) return { alreadySubscribed: true };
      if (existing) {
        existing.active = true;
        existing.unsubscribeToken = crypto.randomBytes(24).toString('hex');
        existing.subscribedAt = new Date().toISOString();
        delete existing.unsubscribedAt;
      } else {
        subscribers.push({
          email,
          active: true,
          unsubscribeToken: crypto.randomBytes(24).toString('hex'),
          subscribedAt: new Date().toISOString(),
        });
      }
      await saveNewsletterSubscribers(subscribers);
      return { alreadySubscribed: false };
    });

    return res.status(result.alreadySubscribed ? 200 : 201).json({
      success: true,
      alreadySubscribed: result.alreadySubscribed,
      message: result.alreadySubscribed ? 'This email is already subscribed.' : 'You are subscribed to PYNX updates.',
    });
  } catch (error) {
    console.error('Newsletter subscription failed:', error);
    return res.status(500).json({ success: false, message: 'Unable to subscribe right now. Please try again later.' });
  }
});

app.get('/api/newsletter/unsubscribe', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    const validToken = (await loadNewsletterSubscribers()).some(subscriber => subscriber.unsubscribeToken === token);
    if (!validToken) return res.status(404).send('This unsubscribe link is invalid or has expired.');
    return res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>PYNX email preferences</title><body><h1>Email preferences</h1><p>Stop receiving PYNX product and sale updates.</p><form method="post" action="/api/newsletter/unsubscribe?token=${encodeURIComponent(token)}"><button type="submit">Unsubscribe</button></form></body></html>`);
  } catch (error) {
    console.error('Newsletter unsubscribe failed:', error);
    return res.status(500).send('Unable to update your email preferences right now.');
  }
});

app.post('/api/newsletter/unsubscribe', async (req, res) => {
  try {
    const unsubscribed = await unsubscribeFromNewsletter(String(req.query.token || ''));
    if (!unsubscribed) return res.status(404).json({ success: false, message: 'This unsubscribe link is invalid or has expired.' });
    return res.json({ success: true });
  } catch (error) {
    console.error('Newsletter unsubscribe failed:', error);
    return res.status(500).json({ success: false, message: 'Unable to update your email preferences right now.' });
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
  const images = req.body.images === undefined ? [] : req.body.images;

  if (!name || !String(comment || '').trim() || !Number.isInteger(stars) || stars < 1 || stars > 5) {
    return res.status(400).json({ success: false, message: 'Please provide your name, a rating from 1 to 5, and a comment.' });
  }
  if (!Array.isArray(images) || images.length > 5
    || images.some(image => typeof image !== 'string'
      || image.length > 180000
      || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image))) {
    return res.status(400).json({ success: false, message: 'Please upload up to 5 valid review photos. Each photo must be under 180 KB after compression.' });
  }

  const review = {
    id: crypto.randomUUID(),
    name: String(name).trim().slice(0, 100),
    email: String(email || '').trim().slice(0, 200),
    rating: stars,
    comment: String(comment).trim().slice(0, 2000),
    productName: String(productName || '').trim().slice(0, 200),
    images,
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

async function cancelOrderById(orderId) {
  return withLock(async () => {
    const orders = await loadOrders();
    const order = orders.find(item => item.id === orderId);
    if (!order) return { missing: true };
    if (order.status === 'cancelled') return { order, changed: false };
    if (!['processing', 'done', undefined].includes(order.status)) {
      return { invalid: 'This order can no longer be cancelled because it has shipped or been delivered.' };
    }

    const products = await loadProducts();
    const inventoryRollback = products.map(product => ({ ...product }));
    for (const reservation of order.inventoryReservations || []) {
      const product = products.find(candidate => String(candidate.id) === String(reservation.productId));
      if (product && Number.isInteger(product.stock)) product.stock += Number(reservation.quantity) || 0;
    }

    const now = new Date().toISOString();
    order.status = 'cancelled';
    order.statusUpdatedAt = now;
    order.statusTimes = { ...(order.statusTimes || {}), cancelled: now };
    delete order.locationUpdates;
    delete order.currentLocation;

    try {
      await saveProducts(products);
      await saveOrders(orders);
    } catch (error) {
      try {
        await saveProducts(inventoryRollback);
      } catch (rollbackError) {
        console.error('Failed to roll back inventory after order cancellation failed:', rollbackError);
      }
      throw error;
    }

    return { order, changed: true };
  });
}

async function sendCancellationNotifications(order) {
  const number = orderNumber(order);
  const items = orderItemLines(order.items || [])
    .map(item => `${item.name}${item.size ? ` / ${item.size}` : ''} x${item.qty}`)
    .join('\n');
  const message = `Order ${number} was cancelled.\nCustomer: ${order.firstName} ${order.lastName}\nEmail: ${order.email}`;
  const refundMessage = order.paymentStatus === 'paid' && order.paymentMethod !== 'cash_on_hand'
    ? '\n\nBecause your online payment was received, PYNX will initiate a refund. Once approved and processed, refunds usually take 3–5 business days. If PayMongo requires bank or e-wallet details, we will email you its secure refund link. The link expires after 3 days.'
    : order.paymentStatus === 'paid'
      ? '\n\nYour cash-on-delivery payment was marked as paid. Please contact PYNX so we can arrange the refund. Approved refunds usually take 3–5 business days to process.'
      : '';
  const customerMessage = `Hi ${order.firstName},\n\nYour order ${number} has been cancelled. The cancelled items were:\n${items}${refundMessage}\n\nIf you need help, please contact PYNX.\n\n- PYNX`;
  await Promise.all([
    notifyAdmins(`PYNX order ${number} cancelled`, message),
    notifyCustomer(String(order.email || '').trim(), `Your PYNX order ${number} was cancelled`, customerMessage),
  ]).catch(error => console.error('Order cancellation email notifications failed:', error));
}

app.patch('/api/orders/:id/cancel', async (req, res) => {
  try {
    const result = await cancelOrderById(String(req.params.id));
    if (result.missing) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (result.invalid) return res.status(409).json({ success: false, message: result.invalid });
    if (result.changed) await sendCancellationNotifications(result.order);
    return res.json({
      success: true,
      order: { id: result.order.id, status: result.order.status, statusUpdatedAt: result.order.statusUpdatedAt, statusTimes: result.order.statusTimes },
    });
  } catch (error) {
    console.error('Customer order cancellation failed:', error);
    return res.status(500).json({ success: false, message: 'Unable to cancel this order right now. Please try again.' });
  }
});

app.post('/api/admin/orders/:id/tracking', verifyAdmin, async (req, res) => {
  const orderId = String(req.params.id);
  const stepIndex = Number(req.body.stepIndex);
  const location = clean(req.body.location, 200);
  const milestoneTitles = {
    0: 'Preparing order',
    1: 'Ready for courier',
    3: 'Shipped',
    6: 'Out for delivery',
    7: 'Delivered',
  };
  if (!Object.prototype.hasOwnProperty.call(milestoneTitles, stepIndex)) {
    return res.status(400).json({ success: false, message: 'Choose a supported order status.' });
  }

  try {
    const point = location ? await geocode(location) : null;
    const result = await withLock(async () => {
      const orders = await loadOrders();
      const order = orders.find(item => item.id === orderId);
      if (!order) return { missing: true };
      if (order.status === 'cancelled') return { invalid: 'Cancelled orders cannot receive tracking updates.' };
      if (order.status === 'delivered') return { invalid: 'Delivered orders cannot receive further status updates.' };
      const statusStepIndex = { processing: -1, done: 1, shipped: 3, delivered: 7 }[order.status] ?? -1;
      const currentStepIndex = Number.isInteger(order.trackingStepIndex)
        ? Math.max(order.trackingStepIndex, statusStepIndex)
        : statusStepIndex;
      if (stepIndex <= currentStepIndex) {
        return { invalid: 'Choose a later status than the order’s current status.' };
      }
      const event = { stepIndex, title: milestoneTitles[stepIndex], location, ...(point ? { point } : {}), at: new Date().toISOString() };
      order.trackingEvents = [...(order.trackingEvents || []), event];
      order.trackingStepIndex = stepIndex;
      order.status = stepIndex === TRACKING_STEPS.length - 1
        ? 'delivered'
        : stepIndex < 2 ? (stepIndex === 0 ? 'processing' : 'done') : 'shipped';
      order.statusUpdatedAt = event.at;
      order.statusTimes = { ...(order.statusTimes || {}), [order.status]: event.at };
      if (point) order.currentLocation = { text: location, ...point, updatedAt: event.at };
      await saveOrders(orders);
      return { order, event, locationFound: Boolean(point) };
    });

    if (result.missing) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (result.invalid) return res.status(409).json({ success: false, message: result.invalid });
    const emailResult = await sendTrackingUpdateEmail(result.order, result.event, req);
    return res.json({
      success: true,
      order: result.order,
      locationFound: result.locationFound,
      notificationRequired: true,
      emailSent: emailResult ? Boolean(emailResult.emailSent) : null,
      emailError: emailResult?.emailError || null,
    });
  } catch (error) {
    console.error('Tracking update failed:', error);
    return res.status(500).json({ success: false, message: 'Unable to save this tracking update.' });
  }
});

app.post('/api/admin/orders/:id/tracking/:stepIndex/resend-email', verifyAdmin, async (req, res) => {
  const orderId = String(req.params.id);
  const stepIndex = Number(req.params.stepIndex);
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= TRACKING_STEPS.length) {
    return res.status(400).json({ success: false, message: 'Choose a tracking update to resend.' });
  }
  try {
    const order = (await loadOrders()).find(item => item.id === orderId);
    const event = order?.trackingEvents?.find(item => item.stepIndex === stepIndex);
    if (!order || !event) return res.status(404).json({ success: false, message: 'Tracking update not found.' });
    const emailResult = await sendTrackingUpdateEmail(order, event, req);
    return res.json({
      success: true,
      emailSent: Boolean(emailResult.emailSent),
      emailError: emailResult.emailError || null,
    });
  } catch (error) {
    console.error('Tracking notification resend failed:', error);
    return res.status(500).json({ success: false, message: 'Unable to resend the tracking notification.' });
  }
});

app.put('/api/admin/orders/:id/waybill', verifyAdmin, async (req, res) => {
  const orderId = String(req.params.id);
  const trackingNumber = String(req.body.trackingNumber || '').trim();
  if (!/^[A-Za-z0-9-]{5,40}$/.test(trackingNumber)) {
    return res.status(400).json({ success: false, message: 'Enter a J&T waybill number between 5 and 40 letters or digits.' });
  }

  try {
    const order = await withLock(async () => {
      const orders = await loadOrders();
      const stored = orders.find(item => item.id === orderId);
      if (!stored) return null;
      if (stored.trackingNumber === trackingNumber && stored.waybillEmail?.sent) return { ...stored, waybillUnchanged: true };
      stored.trackingNumber = trackingNumber;
      stored.waybillEmail = stored.waybillEmail || { sent: false, at: null, error: null };
      await saveOrders(orders);
      return stored;
    });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.waybillUnchanged) return res.json({ success: true, order, emailSent: Boolean(order.waybillEmail?.sent), unchanged: true });

    const trackLink = trackingUrl(req, order);
    const trackTemplate = process.env.JNT_TRACKING_URL_TEMPLATE || 'https://www.jtexpress.ph/';
    const jntUrl = trackTemplate.includes('{trackingNumber}')
      ? trackTemplate.replaceAll('{trackingNumber}', encodeURIComponent(trackingNumber))
      : trackTemplate;
    const subject = `Your PYNX order ${orderNumber(order)} has shipped`;
    const text = [
      `Hi ${order.firstName},`,
      '',
      'Your PYNX order has been handed to J&T Express.',
      `Order number: ${orderNumber(order)}`,
      `J&T tracking number: ${trackingNumber}`,
      `Track on our site: ${trackLink}`,
      `Track on J&T: ${jntUrl}`,
      '',
      '- PYNX',
    ].join('\n');
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111"><h1>PYNX</h1><p>Hi ${escapeHtml(order.firstName)}, your order has shipped with J&amp;T Express.</p><p><strong>Order number:</strong> ${escapeHtml(orderNumber(order))}<br><strong>J&amp;T tracking number:</strong> ${escapeHtml(trackingNumber)}</p><p><a href="${escapeHtml(trackLink)}" style="background:#111;color:#fff;padding:12px 22px;text-decoration:none;border-radius:4px">Track on PYNX</a></p><p><a href="${escapeHtml(jntUrl)}" style="background:#e11d48;color:#fff;padding:12px 22px;text-decoration:none;border-radius:4px">Track on J&amp;T</a></p></div>`;
    const emailResult = await notifyCustomer(String(order.email).trim(), subject, text, html);
    await withLock(async () => {
      const orders = await loadOrders();
      const stored = orders.find(item => item.id === orderId);
      if (stored) {
        stored.waybillEmail = { sent: emailResult.emailSent, at: new Date().toISOString(), error: emailResult.emailError };
        await saveOrders(orders);
      }
    });
    return res.json({ success: true, order, emailSent: emailResult.emailSent, emailError: emailResult.emailError });
  } catch (error) {
    console.error('Saving J&T waybill failed:', error);
    return res.status(500).json({ success: false, message: 'Unable to save the J&T waybill.' });
  }
});

app.patch('/api/admin/orders/:id/payment', verifyAdmin, async (req, res) => {
  const orderId = String(req.params.id);
  try {
    const order = await withLock(async () => {
      const orders = await loadOrders();
      const stored = orders.find(item => item.id === orderId);
      if (!stored) return { missing: true };
      if (stored.paymentMethod !== 'cash_on_hand') return { invalid: 'Only cash-on-delivery payments can be marked paid by an admin.' };
      if (stored.status !== 'delivered') return { invalid: 'Cash on delivery can be marked paid after the order is delivered.' };
      if (stored.paymentStatus === 'paid') return { unchanged: true, order: stored };
      stored.paymentStatus = 'paid';
      stored.paidAt = new Date().toISOString();
      await saveOrders(orders);
      return { order: stored };
    });
    if (order.missing) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.invalid) return res.status(409).json({ success: false, message: order.invalid });
    if (order.unchanged) return res.json({ success: true, order: order.order, unchanged: true });
    const emailResult = await sendPaymentStatusEmail(order.order);
    return res.json({
      success: true,
      order: order.order,
      emailSent: Boolean(emailResult.emailSent),
      emailError: emailResult.emailError || null,
    });
  } catch (error) {
    console.error('Payment status update failed:', error);
    return res.status(500).json({ success: false, message: 'Unable to mark this order paid.' });
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

  if (status === 'cancelled') {
    try {
      const result = await cancelOrderById(orderId);
      if (result.missing) return res.status(404).json({ success: false, message: 'Order not found.' });
      if (result.invalid) return res.status(409).json({ success: false, message: result.invalid });
      if (result.changed) await sendCancellationNotifications(result.order);
      return res.json({ success: true, order: result.order });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ success: false, message: 'Failed to cancel order.' });
    }
  }

  return res.status(400).json({ success: false, message: 'Use the ordered tracking-step endpoint to update shipping status.' });
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
    const products = await loadProductsWithPriceMigration();
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, products });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Failed to load products.' });
  }
});

app.post('/api/admin/products', verifyAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const type = String(req.body.type || '');
  const image = String(req.body.image || '').trim();
  const desc = String(req.body.desc || '').trim();
  const price = Number(req.body.price);
  const weightGrams = Number(req.body.weightGrams);
  const images = cleanProductImages(req.body.images || []);
  const fitImage = String(req.body.fitImage || '').trim();

  if (!name || name.length > 200 || !['cap', 'bikini'].includes(type) || !Number.isFinite(price) || price < 0 || !image || image.length > 500 || /^(?:javascript|data):/i.test(image) || desc.length > 2000 || !Number.isInteger(weightGrams) || weightGrams < 1 || !images || fitImage.length > 500 || /^(?:javascript|data):/i.test(fitImage)) {
    return res.status(400).json({ success: false, message: 'Provide a product name, category, valid price and image path, packed weight in grams, and valid gallery image paths.' });
  }

  try {
    const product = await withLock(async () => {
      const products = await loadProducts();
      const nextId = products.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
      const created = {
        id: nextId,
        name,
        cat: type === 'cap' ? 'Headwear' : 'Swimwear',
        price,
        originalPrice: price,
        type,
        emoji: type === 'cap' ? '🧢' : '👙',
        image,
        weightGrams,
        bg: '#1a1a1a',
        desc,
        onSale: false,
        createdAt: new Date().toISOString(),
      };
      if (images.length) created.images = images;
      if (fitImage) created.fitImage = fitImage;
      if (type === 'bikini') created.sizes = ['S', 'M', 'L'];
      await saveProducts([...products, created]);
      return created;
    });

    let newsletterNotification;
    try {
      newsletterNotification = await notifyNewsletterSubscribers(product, 'new', req);
    } catch (error) {
      console.error('Product saved, but newsletter notification failed:', error);
      newsletterNotification = { sent: 0, failed: 0, error: 'Product saved, but notification emails could not be processed.' };
    }
    return res.status(201).json({ success: true, product, newsletterNotification });
  } catch (error) {
    console.error('Product creation failed:', error);
    return res.status(500).json({ success: false, message: 'Failed to create product.' });
  }
});

app.put('/api/admin/products/:id', verifyAdmin, async (req, res) => {
  const productId = Number(req.params.id);
  const { price, originalPrice, onSale, stock, weightGrams, fitImage } = req.body;
  const images = cleanProductImages(req.body.images);

  if (Number.isNaN(productId)) {
    return res.status(400).json({ success: false, message: 'Invalid product ID.' });
  }

  if (typeof price !== 'number' || price < 0) {
    return res.status(400).json({ success: false, message: 'Price must be a non-negative number.' });
  }
  if (onSale && (typeof originalPrice !== 'number' || originalPrice <= price)) {
    return res.status(400).json({ success: false, message: 'A sale price must be lower than the original price.' });
  }
  if (stock !== null && stock !== undefined && (!Number.isInteger(stock) || stock < 0)) {
    return res.status(400).json({ success: false, message: 'Stock must be a whole number of zero or more, or null when not tracked.' });
  }
  if (weightGrams !== undefined && (!Number.isInteger(weightGrams) || weightGrams < 1)) {
    return res.status(400).json({ success: false, message: 'Packed weight must be a whole number of grams greater than zero.' });
  }
  if (images === null || (fitImage !== undefined && (String(fitImage).length > 500 || /^(?:javascript|data):/i.test(String(fitImage).trim())))) {
    return res.status(400).json({ success: false, message: 'Gallery images must be valid image paths (up to 8 extra images).' });
  }

  try {
    const result = await withLock(async () => {
      const products = await loadProducts();
      const index = products.findIndex(p => p.id === productId);
      if (index === -1) return null;

      const previouslyDiscounted = products[index].onSale
        || Number(products[index].originalPrice) > Number(products[index].price);
      const savedOriginalPrice = typeof originalPrice === 'number' && originalPrice >= price
        ? originalPrice
        : price;
      products[index].originalPrice = savedOriginalPrice;
      products[index].onSale = Boolean(onSale);
      products[index].price = products[index].onSale ? price : savedOriginalPrice;
      if (stock === null) delete products[index].stock;
      else if (stock !== undefined) products[index].stock = stock;
      if (weightGrams !== undefined) products[index].weightGrams = weightGrams;
      if (images !== undefined) {
        if (images.length) products[index].images = images;
        else delete products[index].images;
      }
      if (fitImage !== undefined) {
        const cleanedFitImage = String(fitImage).trim();
        if (cleanedFitImage) products[index].fitImage = cleanedFitImage;
        else delete products[index].fitImage;
      }

      await saveProducts(products);
      return { product: products[index], announceSale: !previouslyDiscounted && Boolean(products[index].onSale) };
    });

    if (!result) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }
    let newsletterNotification = null;
    if (result.announceSale) {
      try {
        newsletterNotification = await notifyNewsletterSubscribers(result.product, 'sale', req);
      } catch (error) {
        console.error('Product updated, but newsletter notification failed:', error);
        newsletterNotification = { sent: 0, failed: 0, error: 'Product updated, but notification emails could not be processed.' };
      }
    }
    return res.json({ success: true, product: result.product, newsletterNotification });
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
