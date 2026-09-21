/* ────────────────────────────────────────
   DATA
──────────────────────────────────────── */
let PRODUCTS = [
    // CAPS
                { id: 1,  name: 'Vintage Cap | Washed Cotton Unisex Baseball Cap | Adjustable Casual Streetwear',  cat: 'Headwear',  price: 49,  type: 'cap',    emoji: '🧢', image: 'assets/caps/pynx-vintage-cap-black-one.png', bg: '#1a1a1a',
      desc: 'A clean six-panel snapback in black ripstop canvas. Embroidered PYNX wordmark at the front. One size fits all with adjustable snap closure.',
    sizes: ['S','M','L','XL'] },
                { id: 2,  name: 'Vintage Cap | Washed Cotton Unisex Baseball Cap | Adjustable Casual Streetwear',  cat: 'Headwear',  price: 59,  type: 'cap',    emoji: '🧢', image: 'assets/caps/pynx-vintage-cap-blue.png', bg: '#c9b89a',
      desc: 'Structured front panel, moisture-wicking sweatband. Ideal for active wear. Tone-on-tone PYNX embroidery. Fitted sizes available.',
    sizes: ['S','M','L','XL'] },
                { id: 3,  name: 'Vintage Cap | Washed Cotton Unisex Baseball Cap | Adjustable Casual Streetwear',  cat: 'Headwear',  price: 79,  type: 'cap',    emoji: '🧢', image: 'assets/caps/pynx-vintage-cap-black-two.png', bg: '#3a3a3a',
      desc: 'Italian wool-blend construction for cooler climates. Structured silhouette, leather strap back. A cold-weather staple.',
    sizes: ['S','M','L','XL'] },
    // BIKINIS
        { id: 4,  name: 'Pynx Star Bikini Set',  cat: 'Swimwear',  price: 89,  type: 'bikini', emoji: '👙', image: 'assets/bikinis/pynx-star-bikini-set.png', imageScale: 1.35, bg: '#1a1a1a',
            desc: 'Black triangle bikini set with adjustable tie straps and signature Pynx star graphics.',
    sizes: ['S','M','L','XL'] },
];

/* ────────────────────────────────────────
   CART STATE
──────────────────────────────────────── */
let cart = [];          // { product, size, qty }
let wishlist = [];      // product ids
let currentProduct = null;
let selectedSize    = null;
let editingCartKey  = null;
let selectedCartKeys = new Set();
let selectedWishlistIds = new Set();

function loadCart() {
    try {
        const data = localStorage.getItem('pynx_cart');
        if (!data) return [];
        const stored = JSON.parse(data);
        return Array.isArray(stored) ? stored : [];
    } catch (err) {
        console.error('Failed to load cart from storage:', err);
        return [];
    }
}

function saveCart() {
    try {
        localStorage.setItem('pynx_cart', JSON.stringify(cart));
    } catch (err) {
        console.error('Failed to save cart to storage:', err);
    }
}

function loadWishlist() {
    try {
        const data = localStorage.getItem('pynx_wishlist');
        if (!data) return [];
        const stored = JSON.parse(data);
        return Array.isArray(stored) ? stored : [];
    } catch (err) {
        console.error('Failed to load wishlist from storage:', err);
        return [];
    }
}

function saveWishlist() {
    try {
        localStorage.setItem('pynx_wishlist', JSON.stringify(wishlist));
    } catch (err) {
        console.error('Failed to save wishlist to storage:', err);
    }
}

const API_BASE = window.PYNX_API_URL || (window.location.protocol === 'file:' || window.location.port !== '5000'
    ? 'http://localhost:5000'
    : '');

/* ────────────────────────────────────────
   RENDER PRODUCT GRIDS
──────────────────────────────────────── */
async function loadProductCatalog() {
    try {
        const response = await fetch(getApiUrl(`/api/products?updated=${Date.now()}`), { cache: 'no-store' });
        if (!response.ok) throw new Error('Product catalog not available');
        const result = await response.json();
        const data = result.products;
        if (Array.isArray(data) && data.length) {
            PRODUCTS = data;
            let cartChanged = false;
            cart = cart.map(item => {
                const currentProduct = PRODUCTS.find(product => product.id === item.product?.id);
                if (!currentProduct) return item;
                cartChanged = cartChanged || item.product.price !== currentProduct.price || item.product.originalPrice !== currentProduct.originalPrice || item.product.onSale !== currentProduct.onSale;
                return { ...item, product: currentProduct };
            });
            if (cartChanged) saveCart();
        }
    } catch (err) {
        try {
            const response = await fetch(`data/products.json?updated=${Date.now()}`, { cache: 'no-store' });
            const data = await response.json();
            if (Array.isArray(data) && data.length) PRODUCTS = data;
        } catch (fallbackError) {
            console.warn('Unable to load the product catalog.', fallbackError);
        }
    }
}

function renderProducts() {
    const capsGrid = document.getElementById('caps-grid');
    const bikinisGrid = document.getElementById('bikinis-grid');
    if (!capsGrid && !bikinisGrid) return;

    const caps = PRODUCTS.filter(p => p.type === 'cap');
    const bikinis = PRODUCTS.filter(p => p.type === 'bikini');

    if (capsGrid) capsGrid.innerHTML = caps.map(cardHTML).join('');
    if (bikinisGrid) bikinisGrid.innerHTML = bikinis.map(cardHTML).join('');
}

function cardHTML(p) {
    const isShopPage = document.body.classList.contains('shop-page');
    const isIndexPage = document.body.classList.contains('index-page');
    const canBuy = isShopPage || isIndexPage;
    const currentPrice = Number(p.price) || 0;
    const originalPrice = Number(p.originalPrice) || currentPrice;
    const isDiscount = Boolean(p.onSale) || originalPrice > currentPrice;
    const priceHTML = canBuy ? `<div class="product-price${isDiscount ? ' sale' : ''}">₱${currentPrice.toFixed(2)}</div>` : '';
    const originalPriceHTML = canBuy && isDiscount ? `<div class="product-original-price">₱${originalPrice.toFixed(2)}</div>` : '';
    const saleBadge = isDiscount ? `<span class="product-sale-badge">Sale</span>` : '';
    const isAdmin = document.body.classList.contains('admin-preview');
    const actionOverlay = canBuy ? `
            <div class="product-overlay">
                <button class="quick-add" onclick="event.stopPropagation();quickAdd(${p.id})">Quick Add</button>
            </div>` : '';
    const adminEditButton = isShopPage && isAdmin ? `
            <button class="admin-edit-btn" onclick="event.stopPropagation();openModal(${p.id})" aria-label="Edit product">Edit</button>` : '';
    const wishlistButton = `
            <button class="wishlist-btn" onclick="event.stopPropagation();toggleWishlist(this)" aria-label="Wishlist">
                <svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
            </button>`;
    const productVisual = p.image
        ? `<img class="product-photo" src="${p.image}" alt="${p.name}" style="--photo-zoom:${p.imageScale || 1};">`
        : `<div class="pi-inner" style="font-size:6rem;">${p.emoji}</div>`;
    return `
    <div class="product-card reveal" onclick="openModal(${p.id})">
        <div class="product-image" style="background:${p.bg}20;" role="button" tabindex="0" aria-label="View details for ${p.name}" onclick="event.stopPropagation();openModal(${p.id})" onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); openModal(${p.id}); }">
            ${productVisual}${actionOverlay}
            ${adminEditButton}
            ${wishlistButton}
        </div>
        <div class="product-info">
            <div class="product-name">${p.name}${saleBadge}</div>
            <div class="product-category">${p.cat}</div>
            ${priceHTML}
            ${originalPriceHTML}
        </div>
    </div>`;
}

/* ────────────────────────────────────────
   PRODUCT MODAL
──────────────────────────────────────── */
function openModal(id, preselectedSize = null) {
    const p = PRODUCTS.find(x => x.id === id);
    currentProduct = p;
    selectedSize   = preselectedSize;
    const isShopPage = document.body.classList.contains('shop-page');
    const canBuy = isShopPage || document.body.classList.contains('index-page');

    document.getElementById('modal-img').innerHTML = p.image
        ? `<img class="product-photo" src="${p.image}" alt="${p.name}" style="--photo-zoom:${p.imageScale || 1};">`
        : `<span>${p.emoji}</span>`;
    document.getElementById('modal-img').style.background = p.bg + '15';
    document.getElementById('modal-cat').textContent  = p.cat;
    document.getElementById('modal-name').textContent = p.name;
    document.getElementById('modal-desc').textContent  = p.desc;

    const modalPriceEl = document.getElementById('modal-price');
    const sizeLabelEl = document.getElementById('size-label-el');
    const sizeGridEl = document.getElementById('size-grid');
    const modalAddBtn = document.querySelector('.modal-add');
    const adminEditor = document.getElementById('admin-product-editor');
    const adminPriceInput = document.getElementById('admin-edit-price');
    const adminOriginalInput = document.getElementById('admin-edit-original');
    const adminOnSaleInput = document.getElementById('admin-edit-onsale');
    const isAdmin = document.body.classList.contains('admin-preview');

    modalPriceEl.textContent = `₱${p.price}.00`;
    modalPriceEl.style.display = '';
    modalAddBtn.style.display = canBuy ? '' : 'none';

    if (canBuy && p.sizes && p.sizes.length) {
        sizeLabelEl.textContent = 'Choose Your Size';
        sizeLabelEl.style.display = '';
        sizeGridEl.innerHTML = p.sizes
            .map(s => `<button class="size-opt${selectedSize === s ? ' selected' : ''}" onclick="selectSize('${s}',this)">${s}</button>`)
            .join('');
        sizeGridEl.style.display = '';
    } else {
        sizeLabelEl.textContent = '';
        sizeLabelEl.style.display = 'none';
        sizeGridEl.innerHTML = '';
        sizeGridEl.style.display = 'none';
    }

    if (adminEditor && isShopPage && isAdmin) {
            adminEditor.style.display = '';
            adminPriceInput.value = p.price.toFixed(2);
            adminOriginalInput.value = (typeof p.originalPrice === 'number' ? p.originalPrice : p.price).toFixed(2);
            adminOnSaleInput.checked = Boolean(p.onSale);
    } else if (adminEditor) {
        adminEditor.style.display = 'none';
    }

    document.getElementById('modal-overlay').classList.add('show');
    document.getElementById('overlay').classList.add('show');
}

function selectSize(size, btn) {
    selectedSize = size;
    document.querySelectorAll('.size-opt').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}

function closeModal() {
    document.getElementById('modal-overlay')?.classList.remove('show');
    document.getElementById('overlay')?.classList.remove('show');
    currentProduct = null;
}

function parseResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        return response.json();
    }
    return response.text().then(text => ({ success: false, message: `Unexpected response: ${text.slice(0, 200)}` }));
}

function getApiUrl(path) {
    return `${API_BASE}${path}`;
}

function closeModalOutside(e) {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
}

function saveAdminProduct() {
    if (!currentProduct) return;
    const token = localStorage.getItem('pynx_admin_token');
    if (!token) {
        showToast('Admin login required to save product changes');
        return;
    }

    const price = Number(document.getElementById('admin-edit-price').value);
    const originalPrice = Number(document.getElementById('admin-edit-original').value);
    const onSale = document.getElementById('admin-edit-onsale').checked;
    const status = document.getElementById('admin-editor-status');

    if (Number.isNaN(price) || price < 0) {
        status.textContent = 'Please enter a valid price.';
        return;
    }
    if (Number.isNaN(originalPrice) || originalPrice < price) {
        status.textContent = 'Original price should be equal or higher than the current price.';
        return;
    }

    status.textContent = 'Saving...';

    fetch(getApiUrl(`/api/admin/products/${currentProduct.id}`), {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ price, originalPrice, onSale })
    })
        .then(async response => {
            const data = await parseResponse(response);
            return { ok: response.ok, data };
        })
        .then(({ ok, data }) => {
            if (!ok || !data.success) {
                status.textContent = data.message || 'Unable to save product.';
                return;
            }
            const updated = data.product;
            const index = PRODUCTS.findIndex(p => p.id === updated.id);
            if (index !== -1) PRODUCTS[index] = updated;
            currentProduct = updated;
            renderProducts();
            openModal(updated.id);
            status.textContent = 'Product saved successfully.';
        })
        .catch(err => {
            status.textContent = err.message || 'Unable to save product.';
            console.error(err);
        });
}

function addFromModal() {
    if (!currentProduct) return;
    if (!document.body.classList.contains('shop-page') && !document.body.classList.contains('index-page')) return;
    if (currentProduct.sizes && currentProduct.sizes.length && !selectedSize) {
        const existingItem = cart.find(i => i.key === editingCartKey);
        if (existingItem) {
            const newKey = `${currentProduct.id}-${selectedSize}`;
            if (newKey !== editingCartKey) {
                const duplicate = cart.find(i => i.key === newKey);
                if (duplicate) {
                    duplicate.qty += existingItem.qty;
                    cart = cart.filter(i => i.key !== editingCartKey);
                } else {
                    existingItem.key = newKey;
                    existingItem.size = selectedSize;
                }
            }
            showToast('Cart item updated');
        } else {
            addToCart(currentProduct, selectedSize);
        }
    } else {
        addToCart(currentProduct, selectedSize);
    }

    editingCartKey = null;
    closeModal();
}

function editCartItemSize(key) {
    const item = cart.find(i => i.key === key);
    if (!item) return;
    closeCart();
    openModal(item.product.id, item.size, key);
}

/* ────────────────────────────────────────
   CART
──────────────────────────────────────── */
function quickAdd(id) {
    const p = PRODUCTS.find(x => x.id === id);
    const size = p.sizes ? p.sizes[1] || p.sizes[0] : null;
    addToCart(p, size);
}

function addToCart(product, size) {
    const key = `${product.id}-${size}`;
    const existing = cart.find(i => i.key === key);
    if (existing) {
        existing.qty++;
    } else {
        cart.push({ key, product, size, qty: 1 });
    }
    saveCart();
    updateCartUI();
    showToast(`${product.name} added to cart`);
}

function updateCartUI() {
    const badge = document.getElementById('cart-badge');
    const list  = document.getElementById('cart-items-list');
    const empty = document.getElementById('cart-empty');
    if (!badge || !list || !empty) return;

    ensureDrawerClearButtons();
    selectedCartKeys = new Set([...selectedCartKeys].filter(key => cart.some(item => item.key === key)));
    const total = cart.reduce((s, i) => s + i.qty, 0);

    // Badge
    badge.textContent = total;
    badge.classList.toggle('show', total > 0);

    // Items list
    // Remove existing items (not the empty msg)
    list.querySelectorAll('.cart-item').forEach(el => el.remove());

    if (cart.length === 0) {
        empty.style.display = '';
    } else {
        empty.style.display = 'none';
        cart.forEach(item => {
            const div = document.createElement('div');
            div.className = 'cart-item';
            div.innerHTML = `
                <label class="drawer-select-item">
                    <input type="checkbox" ${selectedCartKeys.has(item.key) ? 'checked' : ''} onchange="toggleCartSelection('${item.key}', this.checked)" aria-label="Select ${item.product.name}">
                </label>
                <div class="ci-thumb">${item.product.emoji}</div>
                <div class="ci-body">
                    <div class="ci-name">${item.product.name}</div>
                    <div class="ci-meta">${item.product.cat}${item.size ? ' — ' + item.size : ''}</div>
                    <div class="ci-actions">
                        <button class="btn-secondary cart-action" onclick="editCartItemSize('${item.key}')">Change size</button>
                    </div>
                    <div class="ci-qty">
                        <button class="qty-btn" onclick="changeQty('${item.key}',-1)">−</button>
                        <span class="qty-val">${item.qty}</span>
                        <button class="qty-btn" onclick="changeQty('${item.key}',1)">+</button>
                    </div>
                </div>
                <div class="ci-price">₱${(item.product.price * item.qty).toFixed(2)}</div>`;
            list.insertBefore(div, empty);
        });
    }

    // Subtotal includes only the items selected by the customer.
    const selectedSubtotal = cart
        .filter(item => selectedCartKeys.has(item.key))
        .reduce((sum, item) => sum + item.product.price * item.qty, 0);
    const subtotalLabel = document.querySelector('#cart-drawer .cart-subtotal span:first-child');
    if (subtotalLabel) subtotalLabel.textContent = 'Selected subtotal';
    document.getElementById('cart-total').textContent = `₱${selectedSubtotal.toFixed(2)}`;
    updateDrawerSelectionControls();
}

function changeQty(key, delta) {
    const item = cart.find(i => i.key === key);
    if (!item) return;
    item.qty += delta;
    if (item.qty <= 0) {
        cart = cart.filter(i => i.key !== key);
        selectedCartKeys.delete(key);
    }
    saveCart();
    updateCartUI();
}

function removeFromCart(key) {
    cart = cart.filter(i => i.key !== key);
    selectedCartKeys.delete(key);
    saveCart();
    updateCartUI();
}

function clearCart() {
    if (cart.length === 0) return;
    cart = [];
    selectedCartKeys.clear();
    saveCart();
    updateCartUI();
    showToast('All cart items removed');
}

function ensureDrawerClearButtons() {
    const cartHeader = document.querySelector('#cart-drawer .drawer-header');
    const wishlistHeader = document.querySelector('#wishlist-drawer .drawer-header');

    if (cartHeader && !cartHeader.querySelector('.drawer-actions')) {
        const actions = document.createElement('div');
        actions.className = 'drawer-actions';

        const selectButton = document.createElement('button');
        selectButton.className = 'drawer-select-all';
        selectButton.type = 'button';
        selectButton.setAttribute('aria-label', 'Select all cart items');
        selectButton.title = 'Select all cart items';
        selectButton.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="4" y="4" width="12" height="12" rx="2"></rect><path d="M8 20h10a2 2 0 0 0 2-2V8"></path></svg>';
        selectButton.onclick = selectAllCart;
        actions.appendChild(selectButton);

        const removeSelectedButton = document.createElement('button');
        removeSelectedButton.className = 'drawer-remove-selected';
        removeSelectedButton.type = 'button';
        removeSelectedButton.setAttribute('aria-label', 'Remove selected cart items');
        removeSelectedButton.title = 'Remove selected cart items';
        removeSelectedButton.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 6h14M8 6v12h8V6M10 3h4M10 10h4M10 14h4"></path></svg>';
        removeSelectedButton.onclick = removeSelectedCart;
        actions.appendChild(removeSelectedButton);

        const button = document.createElement('button');
        button.className = 'drawer-clear';
        button.type = 'button';
        button.setAttribute('aria-label', 'Remove all cart items');
        button.title = 'Remove all cart items';
        button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"></path></svg>';
        button.onclick = clearCart;
        actions.appendChild(button);
        cartHeader.insertBefore(actions, cartHeader.querySelector('.drawer-close'));
    }

    if (wishlistHeader && !wishlistHeader.querySelector('.drawer-actions')) {
        const actions = document.createElement('div');
        actions.className = 'drawer-actions';

        const selectButton = document.createElement('button');
        selectButton.className = 'drawer-select-all';
        selectButton.type = 'button';
        selectButton.setAttribute('aria-label', 'Select all favorite items');
        selectButton.title = 'Select all favorite items';
        selectButton.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="4" y="4" width="12" height="12" rx="2"></rect><path d="M8 20h10a2 2 0 0 0 2-2V8"></path></svg>';
        selectButton.onclick = selectAllWishlist;
        actions.appendChild(selectButton);

        const removeSelectedButton = document.createElement('button');
        removeSelectedButton.className = 'drawer-remove-selected';
        removeSelectedButton.type = 'button';
        removeSelectedButton.setAttribute('aria-label', 'Remove selected favorite items');
        removeSelectedButton.title = 'Remove selected favorite items';
        removeSelectedButton.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 6h14M8 6v12h8V6M10 3h4M10 10h4M10 14h4"></path></svg>';
        removeSelectedButton.onclick = removeSelectedWishlist;
        actions.appendChild(removeSelectedButton);

        const button = document.createElement('button');
        button.className = 'drawer-clear';
        button.type = 'button';
        button.setAttribute('aria-label', 'Remove all favorite items');
        button.title = 'Remove all favorite items';
        button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"></path></svg>';
        button.onclick = clearWishlist;
        actions.appendChild(button);
        wishlistHeader.insertBefore(actions, wishlistHeader.querySelector('.drawer-close'));
    }

    updateDrawerSelectionControls();
}

function updateDrawerSelectionControls() {
    const cartHeader = document.querySelector('#cart-drawer .drawer-header');
    const wishlistHeader = document.querySelector('#wishlist-drawer .drawer-header');
    const cartSelect = cartHeader?.querySelector('.drawer-select-all');
    const cartRemove = cartHeader?.querySelector('.drawer-remove-selected');
    const wishlistSelect = wishlistHeader?.querySelector('.drawer-select-all');
    const wishlistRemove = wishlistHeader?.querySelector('.drawer-remove-selected');

    if (cartSelect) {
        const allSelected = cart.length && selectedCartKeys.size === cart.length;
        cartSelect.innerHTML = allSelected
            ? '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"></rect><path d="m7 12 3 3 7-7"></path></svg>'
            : '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="4" y="4" width="12" height="12" rx="2"></rect><path d="M8 20h10a2 2 0 0 0 2-2V8"></path></svg>';
        cartSelect.setAttribute('aria-label', allSelected ? 'Deselect all cart items' : 'Select all cart items');
        cartSelect.title = allSelected ? 'Deselect all cart items' : 'Select all cart items';
        cartSelect.disabled = cart.length === 0;
    }
    if (cartRemove) cartRemove.disabled = selectedCartKeys.size === 0;
    if (wishlistSelect) {
        const allSelected = wishlist.length && selectedWishlistIds.size === wishlist.length;
        wishlistSelect.innerHTML = allSelected
            ? '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"></rect><path d="m7 12 3 3 7-7"></path></svg>'
            : '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="4" y="4" width="12" height="12" rx="2"></rect><path d="M8 20h10a2 2 0 0 0 2-2V8"></path></svg>';
        wishlistSelect.setAttribute('aria-label', allSelected ? 'Deselect all favorite items' : 'Select all favorite items');
        wishlistSelect.title = allSelected ? 'Deselect all favorite items' : 'Select all favorite items';
        wishlistSelect.disabled = wishlist.length === 0;
    }
    if (wishlistRemove) wishlistRemove.disabled = selectedWishlistIds.size === 0;
}

function toggleCartSelection(key, checked) {
    if (checked) selectedCartKeys.add(key);
    else selectedCartKeys.delete(key);
    updateCartUI();
}

function selectAllCart() {
    if (selectedCartKeys.size === cart.length) selectedCartKeys.clear();
    else cart.forEach(item => selectedCartKeys.add(item.key));
    updateCartUI();
}

function removeSelectedCart() {
    if (selectedCartKeys.size === 0) return;
    cart = cart.filter(item => !selectedCartKeys.has(item.key));
    selectedCartKeys.clear();
    saveCart();
    updateCartUI();
    showToast('Selected cart items removed');
}

function openCart() {
    document.getElementById('cart-drawer')?.classList.add('open');
    document.getElementById('overlay')?.classList.add('show');
    sessionStorage.setItem('pynx_cart_open', 'true');
}

function closeCart() {
    document.getElementById('cart-drawer')?.classList.remove('open');
    document.getElementById('overlay')?.classList.remove('show');
    sessionStorage.removeItem('pynx_cart_open');
}

function closeAll() {
    closeCart();
    closeWishlist();
    closeModal();
}

// Close the cart or wishlist when clicking outside the open drawer.
document.addEventListener('click', function (event) {
    const cartDrawer = document.getElementById('cart-drawer');
    const wishlistDrawer = document.getElementById('wishlist-drawer');
    const cartOpen = cartDrawer?.classList.contains('open');
    const wishlistOpen = wishlistDrawer?.classList.contains('open');
    if (!cartOpen && !wishlistOpen) return;

    const clickedInsideCart = cartOpen && cartDrawer.contains(event.target);
    const clickedInsideWishlist = wishlistOpen && wishlistDrawer.contains(event.target);
    const clickedCartToggle = event.target.closest('.cart-btn');
    const clickedWishlistToggle = event.target.closest('.wishlist-header-btn');

    if (clickedInsideCart || clickedInsideWishlist || clickedCartToggle || clickedWishlistToggle) return;
    closeAll();
});

function checkout() {
    if (cart.length === 0) { showToast('Your cart is empty'); return; }
    closeCart();
    window.location.href = 'checkout.html';
}

/* ────────────────────────────────────────
   WISHLIST
──────────────────────────────────────── */
function toggleWishlist(btn) {
    btn.classList.toggle('active');
    const id = Number(btn.closest('.product-card').getAttribute('onclick').match(/openModal\((\d+)\)/)[1]);
    const index = wishlist.indexOf(id);
    if (index === -1) {
        wishlist.push(id);
        showToast('Added to wishlist');
    } else {
        wishlist.splice(index, 1);
        showToast('Removed from wishlist');
    }
    saveWishlist();
    updateWishlistBadge();
}

function openWishlist() {
    renderWishlistUI();
    updateWishlistBadge();
    renderWishlistUI();
    document.getElementById('wishlist-drawer')?.classList.add('open');
    document.getElementById('overlay')?.classList.add('show');
}

function closeWishlist() {
    document.getElementById('wishlist-drawer')?.classList.remove('open');
    document.getElementById('overlay')?.classList.remove('show');
}

function renderWishlistUI() {
    const list = document.getElementById('wishlist-items-list');
    const empty = document.getElementById('wishlist-empty');
    if (!list || !empty) return;

    ensureDrawerClearButtons();
    selectedWishlistIds = new Set([...selectedWishlistIds].filter(id => wishlist.includes(id)));
    list.querySelectorAll('.wishlist-item').forEach(el => el.remove());

    if (wishlist.length === 0) {
        empty.style.display = '';
        return;
    }

    empty.style.display = 'none';
    wishlist.forEach(id => {
        const product = PRODUCTS.find(p => p.id === id);
        const inCart = cart.some(item => item.product.id === product.id);
        const actionLabel = inCart ? 'Change size' : 'Add to cart';
        const item = document.createElement('div');
        item.className = 'wishlist-item';
        item.innerHTML = `
            <label class="drawer-select-item">
                <input type="checkbox" ${selectedWishlistIds.has(id) ? 'checked' : ''} onchange="toggleWishlistSelection(${id}, this.checked)" aria-label="Select ${product.name}">
            </label>
            <div class="wishlist-thumb">${product.emoji}</div>
            <div class="wishlist-body">
                <div class="wishlist-name">${product.name}</div>
                <div class="wishlist-meta">${product.cat}</div>
                <div class="wishlist-actions">
                    <button class="btn-secondary wishlist-action" onclick="openWishlistProduct(${product.id})">${actionLabel}</button>
                </div>
            </div>
        `;
        list.insertBefore(item, empty);
    });
    updateDrawerSelectionControls();
}

function openWishlistProduct(productId) {
    const product = PRODUCTS.find(p => p.id === productId);
    if (!product) return;
    const existingItem = cart.find(item => item.product.id === productId);
    closeWishlist();
    openModal(productId, existingItem ? existingItem.size : null);
}

function removeFromWishlist(id) {
    wishlist = wishlist.filter(item => item !== id);
    selectedWishlistIds.delete(id);
    saveWishlist();
    renderWishlistUI();
    updateWishlistBadge();
}

function clearWishlist() {
    if (wishlist.length === 0) return;
    wishlist = [];
    selectedWishlistIds.clear();
    saveWishlist();
    renderWishlistUI();
    updateWishlistBadge();
    showToast('All favorite items removed');
}

function toggleWishlistSelection(id, checked) {
    if (checked) selectedWishlistIds.add(id);
    else selectedWishlistIds.delete(id);
    updateDrawerSelectionControls();
}

function selectAllWishlist() {
    if (selectedWishlistIds.size === wishlist.length) selectedWishlistIds.clear();
    else wishlist.forEach(id => selectedWishlistIds.add(id));
    renderWishlistUI();
}

function removeSelectedWishlist() {
    if (selectedWishlistIds.size === 0) return;
    wishlist = wishlist.filter(id => !selectedWishlistIds.has(id));
    selectedWishlistIds.clear();
    saveWishlist();
    renderWishlistUI();
    updateWishlistBadge();
    showToast('Selected favorite items removed');
}

function updateWishlistBadge() {
    const badge = document.getElementById('wishlist-badge');
    if (!badge) return;
    badge.textContent = wishlist.length;
    badge.classList.toggle('show', wishlist.length > 0);
}

function openCartFromWishlist() {
    if (wishlist.length === 0) {
        showToast('Your wishlist is empty');
        return;
    }
    closeWishlist();
    openCart();
}

/* ────────────────────────────────────────
   CONTACT FORM
──────────────────────────────────────── */
function submitContact() {
    const first   = document.getElementById('f-first').value.trim();
    const email   = document.getElementById('f-email').value.trim();
    const message = document.getElementById('f-message').value.trim();
    if (!first || !email || !message) { showToast('Please fill in all required fields'); return; }
    if (!email.includes('@')) { showToast('Please enter a valid email address'); return; }
    document.getElementById('contact-form').style.display  = 'none';
    document.getElementById('form-success').style.display = 'block';
}

/* ────────────────────────────────────────
   NEWSLETTER
──────────────────────────────────────── */
function subscribeNewsletter() {
    const email = document.getElementById('nl-email').value.trim();
    if (!email || !email.includes('@')) { showToast('Please enter a valid email'); return; }
    document.getElementById('nl-email').value = '';
    showToast('You\'re subscribed — welcome to PYNX.');
}

/* ────────────────────────────────────────
   TOAST
──────────────────────────────────────── */
let toastTimer;
function showToast(msg) {
    const t = document.getElementById('toast');
    if (!t) {
        console.warn('Toast element not found:', msg);
        return;
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ────────────────────────────────────────
   MOBILE MENU
──────────────────────────────────────── */
function toggleMenu() {
    const dropdown = document.getElementById('menu-dropdown');
    const toggle = document.getElementById('menu-toggle');
    if (!dropdown || !toggle) return;
    dropdown.classList.toggle('show');
    toggle.classList.toggle('open');
    toggle.setAttribute('aria-expanded', dropdown.classList.contains('show'));
}
function closeMenuDropdown() {
    const dropdown = document.getElementById('menu-dropdown');
    const toggle = document.getElementById('menu-toggle');
    const mobileDropdown = document.querySelector('.mobile-dropdown');
    const mobileToggle = mobileDropdown?.querySelector('.mobile-dropdown-toggle');
    if (dropdown) dropdown.classList.remove('show');
    if (toggle) {
        toggle.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
    }
    if (mobileDropdown) {
        mobileDropdown.classList.remove('open');
    }
    if (mobileToggle) {
        mobileToggle.setAttribute('aria-expanded', 'false');
    }
}

function toggleMobileDropdown() {
    const mobileDropdown = document.querySelector('.mobile-dropdown');
    const toggle = document.querySelector('.mobile-dropdown-toggle');
    if (!mobileDropdown || !toggle) return;
    mobileDropdown.classList.toggle('open');
    toggle.setAttribute('aria-expanded', mobileDropdown.classList.contains('open'));
}

document.addEventListener('click', function(event) {
    if (!event.target.closest('.menu-toggle') && !event.target.closest('.menu-dropdown')) {
        closeMenuDropdown();
    }
});

function closeMobileNav() {
    closeMenuDropdown();
}

/* ────────────────────────────────────────
   SCROLL EFFECTS
──────────────────────────────────────── */
// Header shadow on scroll
window.addEventListener('scroll', () => {
    document.getElementById('site-header')?.classList.toggle('scrolled', window.scrollY > 30);
});

// Scroll reveal
const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            revealObserver.unobserve(entry.target);
        }
    });
}, { threshold: 0.12 });

function initReveal() {
    document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));
}

function initCategoryNavigation() {
    document.querySelectorAll('.shop-category-card').forEach(card => {
        card.addEventListener('click', function(event) {
            if (event.defaultPrevented) return;
            event.preventDefault();
            this.classList.add('is-opening');
            window.setTimeout(() => {
                window.location.href = this.href;
            }, 320);
        });
    });
}

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            e.preventDefault();
            target.scrollIntoView({ behavior: 'smooth' });
            closeMobileNav();
        }
    });
});

function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ────────────────────────────────────────
   NAVIGATION INDICATOR
──────────────────────────────────────── */
function setActiveNav() {
    let currentPage = 'home';
    if (document.body.classList.contains('shop-page')) {
        currentPage = 'shop';
    } else if (document.body.classList.contains('contact-page')) {
        currentPage = 'contact';
    } else if (document.body.classList.contains('admin-page')) {
        currentPage = 'admin';
    }

    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        link.classList.remove('active');
        const linkPage = link.getAttribute('data-page');
        if (linkPage === currentPage) {
            link.classList.add('active');
        }
    });
}

function toggleAdminLink() {
    const adminLinks = document.querySelectorAll('.admin-link');
    const token = localStorage.getItem('pynx_admin_token');
    adminLinks.forEach(link => {
        link.classList.toggle('admin-hidden', !token);
    });
}

function logoutCustomer(event) {
    event.preventDefault();
    localStorage.removeItem('pynx_logged_in');
    localStorage.removeItem('pynx_user');
    localStorage.removeItem('pynx_customer_token');
    window.location.href = 'login.html';
}

function updateCustomerAuthLinks() {
    const isLoggedIn = localStorage.getItem('pynx_logged_in') === 'true';
    document.querySelectorAll('a[href="login.html"]').forEach(link => {
        link.textContent = isLoggedIn ? 'Logout' : 'Login';
        link.setAttribute('aria-label', isLoggedIn ? 'Log out of your customer account' : 'Log in to your customer account');
        if (isLoggedIn) link.onclick = logoutCustomer;
    });
}

/* ────────────────────────────────────────
   SHOP COLLECTIONS (dynamic per product type)
──────────────────────────────────────── */
const COLLECTION_META = {
    cap:    { label: 'Caps',   eyebrow: 'Headwear', desc: 'Structured silhouettes and elevated essentials built for everyday wear.', theme: 'dark' },
    bikini: { label: 'Bikini', eyebrow: 'Swimwear',  desc: 'Clean lines, soft coverage, and tonal pieces designed for motion.',        theme: 'light' }
};

function collectionMetaFor(type, items) {
    return COLLECTION_META[type] || {
        label: items[0]?.cat || type,
        eyebrow: items[0]?.cat || 'Collection',
        desc: `Explore ${items.length} curated piece(s) in this collection.`,
        theme: 'dark'
    };
}

function renderShopCollections() {
    const grid = document.getElementById('shop-category-grid');
    if (!grid) return;
    const types = [...new Set(PRODUCTS.map(p => p.type))];
    grid.innerHTML = types.map(type => {
        const items = PRODUCTS.filter(p => p.type === type);
        const meta = collectionMetaFor(type, items);
        const isDark = meta.theme !== 'light';
        const bg = isDark
            ? 'linear-gradient(180deg, rgba(17,17,17,0.96), rgba(17,17,17,0.82))'
            : 'linear-gradient(180deg, rgba(255,255,255,0.96), rgba(240,240,235,0.9))';
        const color = isDark ? '#f0f0eb' : '#111';
        const subColor = isDark ? 'rgba(240,240,235,.72)' : 'rgba(17,17,17,.68)';
        const descColor = isDark ? 'rgba(240,240,235,.8)' : 'rgba(17,17,17,.78)';
        return `<a href="shop.html?type=${encodeURIComponent(type)}" class="shop-category-card reveal" style="display:flex; flex-direction:column; justify-content:space-between; min-height: 270px; padding: 2rem; border-radius: 24px; background: ${bg}; color: ${color}; text-decoration: none; box-shadow: 0 24px 60px rgba(17,17,17,0.1);">
            <span style="font-size: .72rem; letter-spacing: .38rem; text-transform: uppercase; color: ${subColor};">${meta.eyebrow}</span>
            <div>
                <h3 style="font-family: 'Bebas Neue', Arial, sans-serif; font-size: 3.1rem; letter-spacing: .2rem; margin: 0 0 .5rem;">${meta.label}</h3>
                <p style="margin: 0; color: ${descColor}; line-height: 1.6;">${meta.desc}</p>
                <p style="margin: .6rem 0 0; font-size:.72rem; letter-spacing:.15rem; text-transform:uppercase; color: ${descColor};">${items.length} item(s)</p>
            </div>
        </a>`;
    }).join('');
}

function initShopCollections() {
    if (!document.body.classList.contains('shop-page')) return;
    renderShopCollections();

    const categoriesSection = document.getElementById('shop-categories-section');
    const collectionSection = document.getElementById('shop-collection-section');
    if (!categoriesSection || !collectionSection) return;

    const params = new URLSearchParams(window.location.search);
    const type = params.get('type');
    const items = type ? PRODUCTS.filter(p => p.type === type) : [];

    if (type && items.length) {
        const meta = collectionMetaFor(type, items);
        document.getElementById('collection-title').textContent = meta.label.toUpperCase();
        document.getElementById('collection-eyebrow').textContent = meta.eyebrow;
        document.getElementById('collection-grid').innerHTML = items.map(cardHTML).join('');
        categoriesSection.style.display = 'none';
        collectionSection.style.display = '';
    } else {
        categoriesSection.style.display = '';
        collectionSection.style.display = 'none';
    }
    initReveal();
    initCategoryNavigation();
}

/* ────────────────────────────────────────
   INIT
──────────────────────────────────────── */
cart = loadCart();
wishlist = loadWishlist();
toggleAdminLink();
updateCustomerAuthLinks();
setActiveNav();
loadProductCatalog().finally(() => {
    renderProducts();
    updateCartUI();
    updateWishlistBadge();
    initReveal();
    initCategoryNavigation();
    toggleAdminLink();
    updateCustomerAuthLinks();
    setActiveNav();
    initShopCollections();
    // Keep the cart drawer open across page navigations until the customer closes it.
    if (sessionStorage.getItem('pynx_cart_open') === 'true') openCart();
});
