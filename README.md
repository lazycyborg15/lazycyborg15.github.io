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

## Server notes

- The Express server is in `/server`
- MongoDB connection string is controlled by `MONGO_URI`
- API endpoint: `POST /api/orders`
- Health check: `GET /api/health`

## Static site fallback

The existing root HTML pages remain in place and now reference organized asset folders for CSS, JS, and logos.
