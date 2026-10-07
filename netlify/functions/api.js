const path = require('path');
const serverless = require('serverless-http');
const { app, setSeeds } = require('../../server/index');

// JSON files are bundled at build time because the function has no writable disk.
setSeeds({ products: require('../../data/products.json') });

const handler = serverless(app);

exports.handler = async (event, context) => {
  // Netlify may pass either the original /api/... path or the rewritten function path.
  let requestPath = String(event.path || '/').replace(/^\/\.netlify\/functions\/api/, '') || '/';
  if (!requestPath.startsWith('/api')) requestPath = path.posix.join('/api', requestPath);
  return handler({ ...event, path: requestPath }, context);
};
