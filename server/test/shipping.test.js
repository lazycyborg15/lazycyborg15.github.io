const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pynx-shipping-test-'));
process.env.DATA_DIR = dataDir;
process.env.SHIPPING_ORIGIN = '10.2864738,123.8703173';
for (const name of ['MONGODB_URI', 'NETLIFY', 'AWS_LAMBDA_FUNCTION_NAME', 'EMAIL_USER', 'EMAIL_PASS']) {
  delete process.env[name];
}
fs.writeFileSync(path.join(dataDir, 'products.json'), JSON.stringify([
  { id: 1, name: 'Test product', price: 100 },
]));

const { app } = require('../index');
let server;
let baseUrl;

before(async () => {
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const name of ['products.json', 'orders.json']) {
    const file = path.join(dataDir, name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  fs.rmdirSync(dataDir);
});

async function post(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

const items = [{ product: { id: 1 }, qty: 1 }];
const location = { lat: 10.3364738, lng: 123.8703173 };
const address = (city, province = 'Cebu', region = 'Visayas') => ({
  region, province, city, barangay: 'Test Barangay', street: 'Test Street', postalCode: '6000',
});

test('shipping quotes use the Cebu City and other Cebu Province rates', async () => {
  for (const [city, fee] of [
    ['City of Cebu', 8.94],
    ['Cebu City', 8.94],
    ['CITY OF CEBU', 8.94],
    ['City of Mandaue', 4.68],
    ['City of Lapu-Lapu', 4.68],
  ]) {
    const { status, data } = await post('/api/shipping/quote', {
      addressParts: address(city), items, location,
    });
    assert.equal(status, 200, city);
    assert.equal(data.distanceKm, 6, city);
    assert.equal(data.shippingFee, fee, city);
    assert.equal(data.total, 100 + fee, city);
  }
});

test('shipping quotes preserve the flat rates outside Cebu Province', async () => {
  for (const [province, region, fee] of [
    ['Iloilo', 'Visayas', 155],
    ['Laguna', 'Luzon', 180],
    ['Metro Manila', 'Luzon', 180],
    ['Davao del Sur', 'Mindanao', 175],
  ]) {
    const { status, data } = await post('/api/shipping/quote', {
      addressParts: address('Test City', province, region), items,
    });
    assert.equal(status, 200, province);
    assert.equal(data.shippingFee, fee, province);
    assert.equal(data.total, 100 + fee, province);
  }
});

test('orders use the same shipping rate as the quote', async () => {
  for (const [city, fee] of [['City of Cebu', 8.94], ['City of Mandaue', 4.68]]) {
    const { status, data } = await post('/api/orders', {
      firstName: 'Test',
      lastName: 'Customer',
      email: 'test@example.com',
      contact: '09123456789',
      addressParts: address(city),
      location,
      items,
      paymentMethod: 'cash_on_hand',
      returnPolicyAgreement: { version: '2026-11-07-cancellation-refunds', agreedAt: new Date().toISOString() },
    });
    assert.equal(status, 201, city);
    assert.equal(data.order.shippingDistanceKm, 6, city);
    assert.equal(data.order.shippingFee, fee, city);
    assert.equal(data.order.total, 100 + fee, city);
  }
});
