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
- Product prices and discounts are stored in `/data/products.json`.
- Orders are stored in `/data/orders.json` and are available to the authenticated admin dashboard.
- Public product data is served by `GET /api/products`; orders are submitted through `POST /api/orders`.
- Health check: `GET /api/health`
- Start the server on the shop computer with `node server/index.js`.
- On another device connected to the same network, open the shop using the shop computer's LAN address, for example `http://192.168.1.20:5000`.

GitHub Pages can serve the storefront files, but it cannot run this API or share JSON data between devices. For production cross-device orders, deploy the Express server and use its public URL through `window.PYNX_API_URL`.

## Static site fallback

The existing root HTML pages remain in place and now reference organized asset folders for CSS, JS, and logos.
