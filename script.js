/* ────────────────────────────────────────
   DATA
──────────────────────────────────────── */
const PRODUCTS = [
    // CAPS
    { id: 1,  name: 'Classic Snapback',  cat: 'Headwear',  price: 49,  type: 'cap',    emoji: '🧢', bg: '#1a1a1a',
      desc: 'A clean six-panel snapback in black ripstop canvas. Embroidered PYNX wordmark at the front. One size fits all with adjustable snap closure.',
      sizes: ['XS','S','M','L','XL'] },
    { id: 2,  name: 'Athletic Fit',      cat: 'Headwear',  price: 59,  type: 'cap',    emoji: '🧢', bg: '#c9b89a',
      desc: 'Structured front panel, moisture-wicking sweatband. Ideal for active wear. Tone-on-tone PYNX embroidery. Fitted sizes available.',
      sizes: ['XS','S','M','L','XL'] },
    { id: 3,  name: 'Premium Wool',      cat: 'Headwear',  price: 79,  type: 'cap',    emoji: '🧢', bg: '#3a3a3a',
      desc: 'Italian wool-blend construction for cooler climates. Structured silhouette, leather strap back. A cold-weather staple.',
      sizes: ['S','M','L'] },
    // BIKINIS
    { id: 4,  name: 'Minimal Triangle',  cat: 'Swimwear',  price: 89,  type: 'bikini', emoji: '👙', bg: '#1a1a1a',
      desc: 'Triangle top with adjustable tie straps. Side-tie bottoms for a customisable fit. UPF 50+ chlorine-resistant fabric in deep black.',
      sizes: ['XS','S','M','L'] },
    { id: 5,  name: 'Classic Bandeau',   cat: 'Swimwear',  price: 99,  type: 'bikini', emoji: '👙', bg: '#e8e3d8',
      desc: 'Strapless bandeau top with removable straps. Moderate coverage bottoms. Four-way stretch recycled nylon fabric.',
      sizes: ['XS','S','M','L'] },
    { id: 6,  name: 'High-Waist Set',    cat: 'Swimwear',  price: 129, type: 'bikini', emoji: '👙', bg: '#5a6475',
      desc: 'High-waisted bottoms with a scoop front. Paired triangle top. PYNX tonal branding at the hip. Fully reversible.',
      sizes: ['XS','S','M','L'] },
];

/* ────────────────────────────────────────
   CART STATE
──────────────────────────────────────── */
let cart = [];          // { product, size, qty }
let wishlist = [];      // product ids
let currentProduct = null;
let selectedSize    = null;

/* ────────────────────────────────────────
   RENDER PRODUCT GRIDS
──────────────────────────────────────── */
function renderProducts() {
    const caps    = PRODUCTS.filter(p => p.type === 'cap');
    const bikinis = PRODUCTS.filter(p => p.type === 'bikini');

    document.getElementById('caps-grid').innerHTML    = caps.map(cardHTML).join('');
    document.getElementById('bikinis-grid').innerHTML = bikinis.map(cardHTML).join('');
}

function cardHTML(p) {
    return `
    <div class="product-card reveal" onclick="openModal(${p.id})">
        <div class="product-image" style="background:${p.bg}20;">
            <div class="pi-inner" style="font-size:6rem;">${p.emoji}</div>
            <div class="product-overlay">
                <button class="quick-add" onclick="event.stopPropagation();quickAdd(${p.id})">Quick Add</button>
            </div>
            <button class="wishlist-btn" onclick="event.stopPropagation();toggleWishlist(this)" aria-label="Wishlist">
                <svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
            </button>
        </div>
        <div class="product-info">
            <div class="product-name">${p.name}</div>
            <div class="product-category">${p.cat}</div>
            <div class="product-price">$${p.price}.00</div>
        </div>
    </div>`;
}

/* ────────────────────────────────────────
   PRODUCT MODAL
──────────────────────────────────────── */
function openModal(id) {
    const p = PRODUCTS.find(x => x.id === id);
    currentProduct = p;
    selectedSize   = null;

    document.getElementById('modal-img').innerHTML   = `<span>${p.emoji}</span>`;
    document.getElementById('modal-img').style.background = p.bg + '15';
    document.getElementById('modal-cat').textContent  = p.cat;
    document.getElementById('modal-name').textContent = p.name;
    document.getElementById('modal-price').textContent = `$${p.price}.00`;
    document.getElementById('modal-desc').textContent  = p.desc;

    if (p.sizes && p.sizes.length) {
        document.getElementById('size-label-el').textContent = 'Select Size';
        document.getElementById('size-grid').innerHTML = p.sizes
            .map(s => `<button class="size-opt" onclick="selectSize('${s}',this)">${s}</button>`)
            .join('');
    } else {
        document.getElementById('size-label-el').textContent = '';
        document.getElementById('size-grid').innerHTML = '';
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
    document.getElementById('modal-overlay').classList.remove('show');
    document.getElementById('overlay').classList.remove('show');
    currentProduct = null;
}

function closeModalOutside(e) {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
}

function addFromModal() {
    if (!currentProduct) return;
    if (currentProduct.sizes && currentProduct.sizes.length && !selectedSize) {
        showToast('Please select a size');
        return;
    }
    addToCart(currentProduct, selectedSize);
    closeModal();
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
    updateCartUI();
    showToast(`${product.name} added to cart`);
}

function updateCartUI() {
    const total = cart.reduce((s, i) => s + i.qty, 0);

    // Badge
    const badge = document.getElementById('cart-badge');
    badge.textContent = total;
    badge.classList.toggle('show', total > 0);

    // Items list
    const list  = document.getElementById('cart-items-list');
    const empty = document.getElementById('cart-empty');

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
                <div class="ci-thumb">${item.product.emoji}</div>
                <div class="ci-body">
                    <div class="ci-name">${item.product.name}</div>
                    <div class="ci-meta">${item.product.cat}${item.size ? ' — ' + item.size : ''}</div>
                    <div class="ci-qty">
                        <button class="qty-btn" onclick="changeQty('${item.key}',-1)">−</button>
                        <span class="qty-val">${item.qty}</span>
                        <button class="qty-btn" onclick="changeQty('${item.key}',1)">+</button>
                    </div>
                </div>
                <div class="ci-price">$${(item.product.price * item.qty).toFixed(2)}</div>
                <button class="ci-remove" onclick="removeFromCart('${item.key}')">×</button>`;
            list.insertBefore(div, empty);
        });
    }

    // Total
    const sub = cart.reduce((s, i) => s + i.product.price * i.qty, 0);
    document.getElementById('cart-total').textContent = `$${sub.toFixed(2)}`;
}

function changeQty(key, delta) {
    const item = cart.find(i => i.key === key);
    if (!item) return;
    item.qty += delta;
    if (item.qty <= 0) cart = cart.filter(i => i.key !== key);
    updateCartUI();
}

function removeFromCart(key) {
    cart = cart.filter(i => i.key !== key);
    updateCartUI();
}

function openCart() {
    document.getElementById('cart-drawer').classList.add('open');
    document.getElementById('overlay').classList.add('show');
}

function closeCart() {
    document.getElementById('cart-drawer').classList.remove('open');
    document.getElementById('overlay').classList.remove('show');
}

function closeAll() {
    closeCart();
    closeWishlist();
    closeModal();
}

// Close the wishlist drawer when clicking outside it.
document.addEventListener('click', function (event) {
    const drawer = document.getElementById('wishlist-drawer');
    if (!drawer || !drawer.classList.contains('open')) return;
    if (drawer.contains(event.target) || event.target.closest('.wishlist-header-btn')) return;
    closeWishlist();
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
    updateWishlistBadge();
}

function openWishlist() {
    renderWishlistUI();
    updateWishlistBadge();
    renderWishlistUI();
    document.getElementById('wishlist-drawer').classList.add('open');
    document.getElementById('overlay').classList.add('show');
}

function closeWishlist() {
    document.getElementById('wishlist-drawer').classList.remove('open');
    document.getElementById('overlay').classList.remove('show');
}

function renderWishlistUI() {
    const list = document.getElementById('wishlist-items-list');
    const empty = document.getElementById('wishlist-empty');
    list.querySelectorAll('.wishlist-item').forEach(el => el.remove());

    if (wishlist.length === 0) {
        empty.style.display = '';
        return;
    }

    empty.style.display = 'none';
    wishlist.forEach(id => {
        const product = PRODUCTS.find(p => p.id === id);
        const item = document.createElement('div');
        item.className = 'wishlist-item';
        item.innerHTML = `
            <div class="wishlist-thumb">${product.emoji}</div>
            <div class="wishlist-body">
                <div class="wishlist-name">${product.name}</div>
                <div class="wishlist-meta">${product.cat}</div>
            </div>
            <button class="wishlist-remove" onclick="removeFromWishlist(${product.id})">×</button>
        `;
        list.insertBefore(item, empty);
    });
}

function removeFromWishlist(id) {
    wishlist = wishlist.filter(item => item !== id);
    renderWishlistUI();
    updateWishlistBadge();
}

function updateWishlistBadge() {
    const badge = document.getElementById('wishlist-badge');
    if (!badge) return;
    badge.textContent = wishlist.length;
    badge.classList.toggle('show', wishlist.length > 0);
}

function openCartFromWishlist() {
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
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ────────────────────────────────────────
   MOBILE MENU
──────────────────────────────────────── */
function toggleMenu() {
    const nav    = document.getElementById('mobile-nav');
    const toggle = document.getElementById('menu-toggle');
    nav.classList.toggle('open');
    toggle.classList.toggle('open');
}
function closeMobileNav() {
    document.getElementById('mobile-nav').classList.remove('open');
    document.getElementById('menu-toggle').classList.remove('open');
}

/* ────────────────────────────────────────
   SCROLL EFFECTS
──────────────────────────────────────── */
// Header shadow on scroll
window.addEventListener('scroll', () => {
    document.getElementById('site-header').classList.toggle('scrolled', window.scrollY > 30);

    // Disable cart/wishlist when contact form is in view
    const contactForm = document.getElementById('contact-form');
    const cartBtn = document.querySelector('.cart-btn');
    const wishlistBtn = document.querySelector('.wishlist-header-btn');
    
    if (contactForm) {
        const contactRect = contactForm.getBoundingClientRect();
        const isContactInView = contactRect.top < window.innerHeight && contactRect.bottom > 0;
        
        if (cartBtn) {
            cartBtn.classList.toggle('disabled-btn', isContactInView);
            cartBtn.style.pointerEvents = isContactInView ? 'none' : 'auto';
        }
        if (wishlistBtn) {
            wishlistBtn.classList.toggle('disabled-btn', isContactInView);
            wishlistBtn.style.pointerEvents = isContactInView ? 'none' : 'auto';
        }
    }
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
   INIT
──────────────────────────────────────── */
renderProducts();
updateWishlistBadge();
initReveal();
