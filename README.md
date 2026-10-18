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
   - Shipping fees use the store defaults below. `SHIPPING_RATES_JSON` is optional and only needed to replace those defaults. Enter each product's packed weight in Admin → Products & Inventory.
   - Required for GCash/card: `PAYMONGO_SECRET_KEY` and `PAYMONGO_WEBHOOK_SECRET`, after configuring the PayMongo webhook described below. Leave these unset to keep online payments disabled; cash on delivery remains available once shipping is configured.
   - Optional: `ADMIN_EMAIL`, `NOTIFY_EMAIL`, `JNT_TRACKING_URL_TEMPLATE`, and `SHIP_FROM`.
4. Redeploy, then open `<your-site-url>/api/health`; it should return `{"status":"ok"}`.
5. Open `/admin.html` on the Netlify site and log in.

Netlify cannot keep files, so accounts, orders, reviews, messages, and product prices live in MongoDB. Products start from `data/products.json` until an admin edits one.

#### Checkout, shipping and payment setup

- **Shipping fees:** default rates are Cebu City ₱60; Lapu-Lapu City and Talisay City ₱80; other Cebu Province locations ₱100; other Visayas locations ₱100 for packed orders under 1,000 g and ₱160 at 1,000 g or more; Luzon and Mindanao ₱120 under 1,000 g and ₱180 at 1,000 g or more. These location/weight-based fees are quoted at checkout, added to the item subtotal, and included in PayMongo payment totals. Set each product's packed weight in grams in **Admin → Products & Inventory**; new products require a weight at creation.
- **Custom shipping fees:** optionally set `SHIPPING_RATES_JSON` to a JSON array of zones to override the defaults. Each zone needs `name`, and one or more of `regions`, `provinces`, or `cities`, plus `rates` (weight brackets with `maxWeightGrams` and `fee` in PHP). A city zone can also specify `provinces` to limit that city match to a province. The server selects the most specific matching city, then province, then region.
- **PayMongo:** add `PAYMONGO_SECRET_KEY` and `PAYMONGO_WEBHOOK_SECRET` in Netlify. Register `<your-site-url>/api/webhooks/paymongo` in PayMongo for `checkout_session.payment.paid`, then copy the webhook signing secret to `PAYMONGO_WEBHOOK_SECRET`. Use test keys and a test webhook during testing; switch to live credentials before accepting real payments. Never put secret keys in site JavaScript or commit them.
- **J&T tracking:** optionally set `JNT_TRACKING_URL_TEMPLATE` to J&T's tracking-page URL with `{trackingNumber}` where the waybill number belongs. If unset, the J&T button opens its Philippines homepage.
- **Site links:** `SITE_URL` is the public Netlify site URL used in email links. `PUBLIC_API_URL` is not needed when Netlify hosts both the site and API.

Checkout requires packed weights for all ordered products; it refuses an order if a product weight is missing. Online payment options additionally require PayMongo credentials and webhook setup.

### Deploy on Render instead

Alternatively use the included Render blueprint.

1. Push this repository to GitHub. In Render choose **New → Blueprint** and select the repo; [render.yaml](render.yaml) creates the `pynx-api` service.
2. When prompted, enter `ADMIN_PASSWORD`, `EMAIL_USER` / `EMAIL_PASS` (a Gmail address and its app password, used for order, review, message, and product update emails) and `MONGODB_URI` (for example a free MongoDB Atlas cluster, so accounts and orders survive redeploys).
3. Open `<your-service-url>/api/health`; it should return `{"status":"ok"}`.
4. Because the site is then hosted elsewhere (for example GitHub Pages), copy that URL into `js/config.js`. Every page (storefront, checkout, login, signup, contact, admin) reads this one setting:

```js
window.PYNX_API_URL = '<your-service-url>';
```

Set `PUBLIC_API_URL` on the server to that same Render URL so unsubscribe links in product emails return to the API. Set `SITE_URL` to the public storefront URL for email links. Checkout uses the default location/weight shipping rates above; configure product packed weights, and configure `SHIPPING_RATES_JSON` only if you want to override those rates. For GCash/card, also configure `PAYMONGO_SECRET_KEY` / `PAYMONGO_WEBHOOK_SECRET`. The same API URL is used by the whole site. Customer accounts, contact messages, reviews, orders, product prices, discounts, and newsletter subscriptions then use the shared API instead of browser storage, so an order or review placed on one device appears in the admin page on any other device and triggers an email to the admins.

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
