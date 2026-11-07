const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pynx-password-reset-'));
process.env.DATA_DIR = dataDir;
process.env.SITE_URL = 'https://store.example';
process.env.EMAIL_USER = 'test@example.com';
process.env.EMAIL_PASS = 'test-password';
for (const name of ['MONGODB_URI', 'NETLIFY', 'AWS_LAMBDA_FUNCTION_NAME']) delete process.env[name];

const messages = [];
const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({
  sendMail: async message => { messages.push(message); },
});
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
  const file = path.join(dataDir, 'customers.json');
  if (fs.existsSync(file)) fs.unlinkSync(file);
  fs.rmdirSync(dataDir);
});

async function post(route, body) {
  const response = await fetch(`${baseUrl}/api/customers/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

test('email reset is private, expires, is single-use, and changes the password', async () => {
  const email = 'customer@example.com';
  const signup = await post('signup', { firstName: 'Test', lastName: 'Customer', email, password: 'old-password' });
  assert.equal(signup.status, 201);

  const missing = await post('forgot-password', { email: 'unknown@example.com' });
  const requested = await post('forgot-password', { email: email.toUpperCase() });
  assert.equal(requested.status, 200);
  assert.deepEqual(requested.data, missing.data);
  assert.equal(messages.length, 1);
  const link = messages[0].text.match(/https:\/\/store\.example\/reset-password\.html#[a-f0-9]{64}/)[0];
  const token = new URL(link).hash.slice(1);
  const records = JSON.parse(fs.readFileSync(path.join(dataDir, 'customers.json'), 'utf8'));
  const customer = records.find(item => item.email === email);
  assert.equal(customer.passwordReset.tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.notEqual(customer.passwordReset.tokenHash, token);

  await post('forgot-password', { email });
  assert.equal(messages.length, 1, 'repeated requests are rate limited');
  assert.equal((await post('reset-password', { token, password: 'short' })).status, 400);
  const responses = await Promise.all([
    post('reset-password', { token, password: 'new-password' }),
    post('reset-password', { token, password: 'new-password' }),
  ]);
  assert.deepEqual(responses.map(result => result.status).sort(), [200, 400]);
  assert.equal((await post('login', { email, password: 'old-password' })).status, 401);
  assert.equal((await post('login', { email, password: 'new-password' })).status, 200);

  const expiredToken = crypto.randomBytes(32).toString('hex');
  const updated = JSON.parse(fs.readFileSync(path.join(dataDir, 'customers.json'), 'utf8'));
  updated.find(item => item.email === email).passwordReset = {
    tokenHash: crypto.createHash('sha256').update(expiredToken).digest('hex'),
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  };
  fs.writeFileSync(path.join(dataDir, 'customers.json'), JSON.stringify(updated));
  assert.equal((await post('reset-password', { token: expiredToken, password: 'another-password' })).status, 400);
  assert.equal((await post('login', { email, password: 'new-password' })).status, 200);
});
