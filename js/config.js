// Public URL of the deployed Express API (no trailing slash), for example:
// window.PYNX_API_URL = 'https://pynx-api.onrender.com';
// Leave empty when the site itself is served by the Express server.
window.PYNX_API_URL = window.PYNX_API_URL || '';

// Single API base shared by every page (storefront, checkout, login, admin).
window.PYNX_API_BASE = (function () {
    if (window.PYNX_API_URL) return window.PYNX_API_URL.replace(/\/+$/, '');
    const { protocol, hostname, port } = window.location;
    const isLocal = protocol === 'file:' || hostname === 'localhost' || hostname === '127.0.0.1';
    return isLocal && port !== '5000' ? 'http://localhost:5000' : '';
})();

// False on a static host (GitHub Pages) where no API URL has been set.
window.PYNX_API_CONFIGURED = Boolean(window.PYNX_API_URL) || !window.location.hostname.endsWith('github.io');
