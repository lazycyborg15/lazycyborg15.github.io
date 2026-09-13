import { Link } from 'react-router-dom';
import './Home.css';

const products = [
  { id: 1, name: 'Classic Snapback', price: 49, type: 'cap', emoji: '🧢' },
  { id: 2, name: 'Athletic Fit', price: 59, type: 'cap', emoji: '🧢' },
  { id: 3, name: 'Premium Wool', price: 79, type: 'cap', emoji: '🧢' },
  { id: 4, name: 'Minimal Triangle', price: 89, type: 'bikini', emoji: '👙' },
  { id: 5, name: 'Classic Bandeau', price: 99, type: 'bikini', emoji: '👙' },
  { id: 6, name: 'High-Waist Set', price: 129, type: 'bikini', emoji: '👙' },
];

function Home() {
  return (
    <div className="page page-home">
      <header className="site-header">
        <div className="logo">PYNX</div>
        <nav>
          <Link to="/">Home</Link>
          <Link to="/contact">Contact</Link>
          <Link to="/checkout">Checkout</Link>
        </nav>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="hero-eyebrow">New Heir Collection — 2026</p>
          <h1>Bold. Minimal. Iconic.</h1>
          <p>Premium headwear and swimwear for those who move with purpose.</p>
          <div className="hero-actions">
          </div>
        </div>
      </section>

      <section className="product-section" id="caps">
        <h2>Caps</h2>
        <div className="product-grid">
          {products.filter(p => p.type === 'cap').map(product => (
            <div key={product.id} className="product-card">
              <div className="product-thumb">{product.emoji}</div>
              <h3>{product.name}</h3>
            </div>
          ))}
        </div>
      </section>

      <section className="product-section" id="bikinis">
        <h2>Bikinis</h2>
        <div className="product-grid">
          {products.filter(p => p.type === 'bikini').map(product => (
            <div key={product.id} className="product-card">
              <div className="product-thumb">{product.emoji}</div>
              <h3>{product.name}</h3>
            </div>
          ))}
        </div>
      </section>

      <footer className="page-footer">
        <p>© 2026 PYNX. All rights reserved.</p>
      </footer>
    </div>
  );
}

export default Home;
