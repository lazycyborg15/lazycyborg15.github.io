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

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'Contactpynx@gmail.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@pynx.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// Without JWT_SECRET a random per-process secret is used, so sessions reset on restart; set it in production.
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');
if (!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set; admin login is disabled.');

// NOTIFY_EMAIL may hold several comma-separated admin addresses.
async function notifyAdmins(subject, text) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('Email notification not sent: missing EMAIL_USER or EMAIL_PASS environment variables.');
    return { emailSent: false, emailError: 'Email is not configured on the server.' };
  }
  try {
    await transporter.sendMail({ from: process.env.EMAIL_USER, to: NOTIFY_EMAIL, subject, text });
    return { emailSent: true, emailError: null };
  } catch (err) {
    console.error('Saved, but email notification failed:', err);
    return { emailSent: false, emailError: err.message || 'Email send failed' };
  }
}

async function notifyCustomer(to, subject, text) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('Customer email not sent: missing EMAIL_USER or EMAIL_PASS environment variables.');
    return { emailSent: false, emailError: 'Email is not configured on the server.' };
  }
  try {
    await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, text });
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

app.post('/api/orders', async (req, res) => {
  const { firstName, lastName, address, email, contact, items = [] } = req.body;

  if (!firstName || !lastName || !address || !email || !contact) {
    return res.status(400).json({ success: false, message: 'Please provide all required order details.' });
  }

  const order = {
    id: crypto.randomUUID(),
    firstName,
    lastName,
    address,
    email,
    contact,
    items,
    total: items.reduce((sum, item) => sum + (Number(item.product?.price) || 0) * (Number(item.qty) || 0), 0),
    createdAt: new Date().toISOString(),
  };

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

  const customerEmail = await notifyCustomer(
    String(email).trim(),
    'Thank you for your PYNX order',
    `Hi ${firstName},\n\nThank you for shopping with PYNX. We've received your order.\n\nItems:\n${itemLine}\n\nTotal: PHP ${order.total.toFixed(2)}\nShipping address: ${address}\nContact: ${contact}\nOrder placed: ${order.createdAt}\n\nWe'll be in touch with updates on your order.\n\n- PYNX`
  );

  return res.status(201).json({ success: true, order, emailSent, emailError, customerEmailSent: customerEmail.emailSent });
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
