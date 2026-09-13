const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;
const ORDERS_FILE = path.join(__dirname, '../orders.json');
const CONTACTS_FILE = path.join(__dirname, '../contacts.json');
const PRODUCTS_FILE = path.join(__dirname, '../data/products.json');
const CUSTOMERS_FILE = path.join(__dirname, '../data/customers.json');

// File-based order storage
function loadOrders() {
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      const data = fs.readFileSync(ORDERS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading orders:', err);
  }
  return [];
}

function saveOrders(orders) {
  try {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving orders:', err);
    throw err;
  }
}

function loadContacts() {
  try {
    if (fs.existsSync(CONTACTS_FILE)) {
      const data = fs.readFileSync(CONTACTS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading contacts:', err);
  }
  return [];
}

function saveContacts(contacts) {
  try {
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving contacts:', err);
    throw err;
  }
}

function loadProducts() {
  try {
    if (fs.existsSync(PRODUCTS_FILE)) {
      const data = fs.readFileSync(PRODUCTS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading products:', err);
  }
  return [];
}

function saveProducts(products) {
  try {
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving products:', err);
    throw err;
  }
}

function loadCustomers() {
  try {
    if (fs.existsSync(CUSTOMERS_FILE)) {
      const data = fs.readFileSync(CUSTOMERS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading customers:', err);
  }
  return [];
}

function saveCustomers(customers) {
  fs.mkdirSync(path.dirname(CUSTOMERS_FILE), { recursive: true });
  fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify(customers, null, 2), 'utf8');
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
app.use(express.static(path.join(__dirname, '../')));
app.use(express.static(path.join(__dirname, '../client/build')));

console.log('Order storage: file-based (' + ORDERS_FILE + ')');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'Contactpynx@gmail.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@pynx.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'PYNX2026!';
const JWT_SECRET = process.env.JWT_SECRET || 'pynx_admin_secret';

app.post('/api/customers/signup', (req, res) => {
  const { firstName, lastName, email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (!firstName || !lastName || !normalizedEmail || !password || password.length < 6) {
    return res.status(400).json({ success: false, message: 'Please provide valid account details and a password with at least 6 characters.' });
  }

  const customers = loadCustomers();
  if (customers.some(customer => customer.email.toLowerCase() === normalizedEmail)) {
    return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
  }

  const customer = {
    id: crypto.randomUUID(),
    firstName: String(firstName).trim(),
    lastName: String(lastName).trim(),
    email: normalizedEmail,
    ...hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  customers.push(customer);
  saveCustomers(customers);

  const token = jwt.sign({ role: 'customer', id: customer.id, email: customer.email }, JWT_SECRET, { expiresIn: '7d' });
  return res.status(201).json({ success: true, token, customer: { id: customer.id, firstName: customer.firstName, lastName: customer.lastName, email: customer.email } });
});

app.post('/api/customers/login', (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const customer = loadCustomers().find(item => item.email.toLowerCase() === normalizedEmail);

  if (!customer || !verifyPassword(password || '', customer)) {
    return res.status(401).json({ success: false, message: 'Invalid customer email or password.' });
  }

  const token = jwt.sign({ role: 'customer', id: customer.id, email: customer.email }, JWT_SECRET, { expiresIn: '7d' });
  return res.json({ success: true, token, customer: { id: customer.id, firstName: customer.firstName, lastName: customer.lastName, email: customer.email } });
});

app.post('/api/orders', async (req, res) => {
  const { firstName, lastName, address, email, contact, items = [] } = req.body;

  if (!firstName || !lastName || !address || !email || !contact) {
    return res.status(400).json({ success: false, message: 'Please provide all required order details.' });
  }

  const order = {
    firstName,
    lastName,
    address,
    email,
    contact,
    items,
    createdAt: new Date().toISOString(),
  };

  try {
    const orders = loadOrders();
    orders.push(order);
    saveOrders(orders);
  } catch (error) {
    console.error('Failed to save order:', error);
    return res.status(500).json({ success: false, message: 'Order save failed. Please try again later.' });
  }

  let emailSent = false;
  let emailError = null;

  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    const itemLine = items.map(item => {
      const sizeText = item.size ? ` / ${item.size}` : '';
      return `${item.product?.name || 'Item'} x${item.qty || 1}${sizeText}`;
    }).join('\n') || 'No items.';

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: NOTIFY_EMAIL,
      subject: `New order received from ${firstName} ${lastName}`,
      text: `New order details:\n\nName: ${firstName} ${lastName}\nEmail: ${email}\nContact: ${contact}\nAddress: ${address}\n\nItems:\n${itemLine}`,
    };

    try {
      await transporter.sendMail(mailOptions);
      emailSent = true;
    } catch (err) {
      emailError = err.message || 'Email send failed';
      console.error('Order saved but email notification failed:', err);
    }
  } else {
    console.warn('Email notification not sent: missing EMAIL_USER or EMAIL_PASS environment variables.');
  }

  return res.status(201).json({ success: true, order, emailSent, emailError });
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
    const contacts = loadContacts();
    contacts.push(contactEntry);
    saveContacts(contacts);
  } catch (error) {
    console.error('Failed to save contact message:', error);
    return res.status(500).json({ success: false, message: 'Unable to save your message. Please try again later.' });
  }

  return res.status(201).json({ success: true, message: 'Message received.' });
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
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'admin', email }, JWT_SECRET, { expiresIn: '2h' });
    return res.json({ success: true, token, email });
  }
  return res.status(401).json({ success: false, message: 'Invalid credentials.' });
});

app.get('/api/admin/orders', verifyAdmin, async (req, res) => {
  try {
    const orders = loadOrders().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.json({ success: true, orders });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Failed to load orders.' });
  }
});

app.get('/api/admin/products', verifyAdmin, async (req, res) => {
  try {
    const products = loadProducts();
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

  try {
    const products = loadProducts();
    const index = products.findIndex(p => p.id === productId);
    if (index === -1) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }

    if (typeof price !== 'number' || price < 0) {
      return res.status(400).json({ success: false, message: 'Price must be a non-negative number.' });
    }

    const savedOriginalPrice = typeof originalPrice === 'number' && originalPrice >= price
      ? originalPrice
      : price;
    products[index].originalPrice = savedOriginalPrice;
    products[index].onSale = Boolean(onSale);
    products[index].price = products[index].onSale ? price : savedOriginalPrice;

    saveProducts(products);
    return res.json({ success: true, product: products[index] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Failed to update product.' });
  }
});

app.get('/api/admin/contacts', verifyAdmin, async (req, res) => {
  try {
    const contacts = loadContacts().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.json({ success: true, contacts });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Failed to load customer concerns.' });
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
