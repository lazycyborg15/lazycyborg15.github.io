# Howaw

This project now includes a React front-end and an Express back-end.

## Project structure

- `/client`: React application
- `/server`: Express API server with MongoDB support
- `/logo`: logo PNG assets
- `/images`: general image assets
- `/fonts`: font files
- `/js`: static JavaScript files
- `/css`: static CSS files
- `/download`: download assets / exported files

## Run locally

1. Install root dependencies:

```bash
npm install
```

2. Install client dependencies:

```bash
npm run install-client
```

3. Start the app:

```bash
npm start
```

The React app will run in development mode and the Express server will run on port `5000`.

## Shared data and second-device testing

- The Express server is in `/server`
- Product prices, discounts, and admin-managed stock counts are stored in `/data/products.json`. Stock starts untracked until an admin enters a count; checkout checks and decrements tracked stock, and cancelling an unshipped order restores it.
- Newsletter signups are saved as `/data/newsletterSubscribers.json` (or in MongoDB when configured). Subscribers receive email alerts when an admin adds a product or first marks a product as discounted, and each alert includes an unsubscribe link. Products added from the admin page appear under New Arrivals for 30 days.
- Orders are stored in `/data/orders.json` and are available to the authenticated admin dashboard.
- Public product data is served by `GET /api/products`; orders are submitted through `POST /api/orders`. Customers can cancel orders that have not shipped through the order confirmation or tracking page.
- Health check: `GET /api/health`
- Start the server on the shop computer with `node server/index.js`.
- On another device connected to the same network, open the shop using the shop computer's LAN address, for example `http://192.168.1.20:5000`.

GitHub Pages can serve the storefront files, but it cannot run this API or share JSON data between devices. For production cross-device orders, host the site on Netlify (below) or deploy the Express server elsewhere and use its public URL through `window.PYNX_API_URL`.

### Deploy the site and API on Netlify with MongoDB Atlas (free)

Netlify hosts the pages and runs the API as a function ([netlify/functions/api.js](netlify/functions/api.js), configured by [netlify.toml](netlify.toml)). The site and API share one address, so `js/config.js` needs no change.

1. **Database:** create a free cluster at mongodb.com/atlas (M0). Under *Database Access* add a user with a password, and under *Network Access* allow `0.0.0.0/0`. Click *Connect → Drivers* and copy the connection string (replace `<password>`).
2. **Site:** in Netlify choose **Add new site → Import an existing project**, pick this GitHub repo, leave the build command and publish directory as detected from `netlify.toml`.
3. **Settings:** in *Site configuration → Environment variables*, configure:
   - Required for persistent data and admin access: `MONGODB_URI`, `ADMIN_PASSWORD`, `JWT_SECRET` (use a long random value).
   - Required for customer emails: `EMAIL_USER` and `EMAIL_PASS` (your Gmail address and Google app password), plus `SITE_URL` set to your public Netlify site URL.
     Order receipts and order/payment status emails are sent before the API confirms the email result. If a send fails, checkout tells the customer and the admin page records failed receipts and tracking emails for retry. Check the Netlify function logs and verify the Gmail app password if email is not sent.
   - Customer password recovery requires the same email settings and `SITE_URL`. Reset links are single-use and expire after 30 minutes. Only accounts saved on the server can be recovered by email; accounts created only on a device while offline cannot.
   - Shipping is ₱1.49 per kilometre within Cebu City and ₱0.78 per kilometre elsewhere in Cebu Province, measured from the store origin (Basak, Cebu City by default; override with `SHIPPING_ORIGIN="lat,lng"`). Other Visayas locations are ₱155, Luzon and NCR are ₱180, and Mindanao is ₱175.
   - Checkout accepts cash on delivery and, when PayMongo is configured, QRPH. GCash and card remain disabled until approval. Customers receive a payment-received email after an online payment is confirmed. Cancelled paid online orders are eligible for refunds; approved refunds usually take 3–5 business days. If PayMongo returns a QRPH refund claim link, the customer receives it by email and it expires in 3 days.
   - Vouchers are managed in `data/vouchers.json` (fields: `code`, `type` `percent` or `fixed`, `value`, `minSubtotal`, `startsAt`, `expiresAt`, `maxUses`, `active`). Discounts apply to item subtotal only, not shipping. Usage is counted from non-cancelled orders since `startsAt`. The current `PYNX5` and `PYNX10` codes each give a percentage discount, have no minimum subtotal, and allow 10 total uses. After deploying, staff can email the active newsletter subscribers once from the Products & Inventory tab in the admin dashboard; email delivery requires the server's `EMAIL_USER` and `EMAIL_PASS` settings.
   - Optional: `ADMIN_EMAIL`, `NOTIFY_EMAIL`, `JNT_TRACKING_URL_TEMPLATE`, and `SHIP_FROM`.
4. Redeploy, then open `<your-site-url>/api/health`; it should return `{"status":"ok"}`.
5. Open `/x7k2q9v4m1` on the Netlify site and log in.

Netlify cannot keep files, so accounts, orders, reviews, messages, and product prices live in MongoDB. Products start from `data/products.json` until an admin edits one.

#### Checkout, shipping and payment setup

- **Shipping fees:** Cebu City is charged ₱1.49 per kilometre, and other Cebu Province locations are charged ₱0.78 per kilometre. Distance is measured in a straight line from the store origin (Basak, Cebu City), rounded up to the next whole kilometre. Other Visayas locations cost ₱155, Luzon and NCR cost ₱180, and Mindanao costs ₱175. Fees are quoted at checkout and included in PayMongo payment totals. `SHIPPING_ORIGIN` (`"lat,lng"`) overrides the Cebu origin. Cebu addresses are located with OpenStreetMap Nominatim; the server caches successful lookups in memory.
- **Product sales and reviews:** product cards show sold quantities from non-cancelled COD orders and paid online orders. Customers can attach up to five compressed JPEG photos to a review; submitted photos appear in the admin Reviews tab.
- **PayMongo:** add `PAYMONGO_SECRET_KEY` and `PAYMONGO_WEBHOOK_SECRET` in Netlify. Register `<your-site-url>/api/webhooks/paymongo` in PayMongo for `checkout_session.payment.paid` and `payment.refund.updated`, then copy the webhook signing secret to `PAYMONGO_WEBHOOK_SECRET`. When a refund update includes a PayMongo transfer link and matches an order, the server emails that link to the customer; the link expires in 3 days. Use test keys and a test webhook during testing; switch to live credentials before accepting real payments. Never put secret keys in site JavaScript or commit them.
- **J&T tracking:** optionally set `JNT_TRACKING_URL_TEMPLATE` to J&T's tracking-page URL with `{trackingNumber}` where the waybill number belongs. If unset, the J&T button opens its Philippines homepage.
- **Site links:** `SITE_URL` is the public Netlify site URL used in email links. `PUBLIC_API_URL` is not needed when Netlify hosts both the site and API.

Checkout does not require product weights for shipping. Cash on delivery and QRPH (when configured) are the available payment methods.

### Deploy on Render instead

Alternatively use the included Render blueprint.

1. Push this repository to GitHub. In Render choose **New → Blueprint** and select the repo; [render.yaml](render.yaml) creates the `pynx-api` service.
2. When prompted, enter `ADMIN_PASSWORD`, `EMAIL_USER` / `EMAIL_PASS` (a Gmail address and its app password, used for order, review, message, and product update emails) and `MONGODB_URI` (for example a free MongoDB Atlas cluster, so accounts and orders survive redeploys).
3. Open `<your-service-url>/api/health`; it should return `{"status":"ok"}`.
4. Because the site is then hosted elsewhere (for example GitHub Pages), copy that URL into `js/config.js`. Every page (storefront, checkout, login, signup, contact, admin) reads this one setting:

```js
window.PYNX_API_URL = '<your-service-url>';
```

Set `PUBLIC_API_URL` on the server to that same Render URL so unsubscribe links in product emails return to the API. Set `SITE_URL` to the public storefront URL for email links. Checkout uses the per-kilometre shipping origin and rate above; configure product packed weights for inventory records. For QRPH, also configure `PAYMONGO_SECRET_KEY` / `PAYMONGO_WEBHOOK_SECRET`. The same API URL is used by the whole site. Customer accounts, contact messages, reviews, orders, product prices, discounts, and newsletter subscriptions then use the shared API instead of browser storage, so an order or review placed on one device appears in the admin page on any other device and triggers an email to the admins.
Other settings: `JWT_SECRET`, `ADMIN_EMAIL`, `CORS_ORIGIN`, `NOTIFY_EMAIL` (comma-separated recipients) and `DATA_DIR`. Always set your own `ADMIN_EMAIL` / `ADMIN_PASSWORD` in production; never commit their values. Without `MONGODB_URI` the server writes JSON files to `DATA_DIR`, which is wiped on hosts with an ephemeral disk.

### Admin API reference

All `/api/admin/*` routes need `Authorization: Bearer <token>` from `POST /api/admin/login`.

| Route | Purpose |
| --- | --- |
| `POST /api/admin/login` | Staff login, returns a 2-hour token |
| `GET /api/admin/orders` | All orders, newest first |
| `POST /api/admin/orders/:id/tracking` | Post the next ordered J&T tracking step and location |
| `POST /api/admin/orders/:id/tracking/:stepIndex/resend-email` | Retry a failed customer shipment-update email |
| `PUT /api/admin/orders/:id/waybill` | Save a J&T waybill and email the tracking links |
| `PATCH /api/admin/orders/:id/payment` | Mark delivered cash-on-delivery as paid |
| `GET /api/admin/contacts` | Customer concerns |
| `GET /api/admin/reviews` | Customer reviews |
| `GET /api/admin/products` | Product catalog |
| `POST /api/admin/products` | Add a product and email newsletter subscribers |
| `PUT /api/admin/products/:id` | Update price, original price, sale flag, and stock count |

Public routes: `POST /api/customers/signup`, `POST /api/customers/login`, `POST /api/orders`, `PATCH /api/orders/:id/cancel` (customer cancellation is available on the tracking page only and only before shipment), `GET /api/orders/track`, `POST /api/orders/track`, `POST /api/contact`, `POST /api/reviews`, `POST /api/newsletter/subscribe`, `GET/POST /api/newsletter/unsubscribe`, `GET /api/products`, `GET /api/health`.

## Static site fallback

The existing root HTML pages remain in place and now reference organized asset folders for CSS, JS, and logos.
