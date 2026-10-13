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
3. **Settings:** in *Site configuration → Environment variables* add `MONGODB_URI`, `ADMIN_PASSWORD`, `JWT_SECRET` (any long random text), and for emails `EMAIL_USER` / `EMAIL_PASS` (a Gmail address and its app password). Optional: `ADMIN_EMAIL`, `NOTIFY_EMAIL`.
4. Redeploy, then open `https://<your-site>.netlify.app/api/health`; it should return `{"status":"ok"}`.
5. Open `/admin.html` on the Netlify site and log in.

Netlify cannot keep files, so accounts, orders, reviews, messages, and product prices live in MongoDB. Products start from `data/products.json` until an admin edits one.

### Deploy on Render instead

Alternatively use the included Render blueprint.

1. Push this repository to GitHub. In Render choose **New → Blueprint** and select the repo; [render.yaml](render.yaml) creates the `pynx-api` service.
2. When prompted, enter `ADMIN_PASSWORD`, `EMAIL_USER` / `EMAIL_PASS` (a Gmail address and its app password, used for order, review and message emails) and `MONGODB_URI` (for example a free MongoDB Atlas cluster, so accounts and orders survive redeploys).
3. Open `https://<your-service>.onrender.com/api/health`; it should return `{"status":"ok"}`.
4. Because the site is then hosted elsewhere (for example GitHub Pages), copy that URL into `js/config.js`. Every page (storefront, checkout, login, signup, contact, admin) reads this one setting:

```js
window.PYNX_API_URL = 'https://your-service.onrender.com';
```

The same API URL is used by the whole site. Customer accounts, contact messages, reviews, orders, product prices, and discounts then use the shared API instead of browser storage, so an order or review placed on one device appears in the admin page on any other device and triggers an email to the admins.

Other settings: `JWT_SECRET`, `ADMIN_EMAIL`, `CORS_ORIGIN`, `NOTIFY_EMAIL` (comma-separated recipients) and `DATA_DIR`. Always set your own `ADMIN_EMAIL` / `ADMIN_PASSWORD` in production; never commit their values. Without `MONGODB_URI` the server writes JSON files to `DATA_DIR`, which is wiped on hosts with an ephemeral disk.

### Admin API reference

All `/api/admin/*` routes need `Authorization: Bearer <token>` from `POST /api/admin/login`.

| Route | Purpose |
| --- | --- |
| `POST /api/admin/login` | Staff login, returns a 2-hour token |
| `GET /api/admin/orders` | All orders, newest first |
| `PATCH /api/admin/orders/:id/status` | Update order status; customers are emailed when orders are delivered or cancelled |
| `GET /api/admin/contacts` | Customer concerns |
| `GET /api/admin/reviews` | Customer reviews |
| `GET /api/admin/products` | Product catalog |
| `PUT /api/admin/products/:id` | Update price, original price, sale flag, and stock count |

Public routes: `POST /api/customers/signup`, `POST /api/customers/login`, `POST /api/orders`, `PATCH /api/orders/:id/cancel` (customer cancellation is available on the tracking page only and only before shipment), `GET /api/orders/track`, `POST /api/orders/track`, `POST /api/contact`, `POST /api/reviews`, `GET /api/products`, `GET /api/health`.

## Static site fallback

The existing root HTML pages remain in place and now reference organized asset folders for CSS, JS, and logos.
