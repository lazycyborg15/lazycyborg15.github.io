import { useState } from 'react';

function Checkout() {
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();

    const formData = {
      firstName: event.target.firstName.value,
      lastName: event.target.lastName.value,
      email: event.target.email.value,
      contact: event.target.contact.value,
      address: event.target.address.value,
      items: [],
    };

    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      const result = await response.json();

      if (!response.ok || !result.success) {
        const message = result.message || 'Failed to submit order. Please try again.';
        alert(message);
        return;
      }

      setSubmitted(true);
    } catch (error) {
      console.error(error);
      alert('Failed to submit order. Please try again later.');
    }
  };

  return (
    <div className="page page-checkout">
      <header className="site-header">
        <div className="logo">PYNX</div>
      </header>
      <main>
        <section className="section">
          <h2>Checkout</h2>
          {!submitted ? (
            <form className="checkout-form" onSubmit={handleSubmit}>
              <label>
                First Name
                <input name="firstName" required />
              </label>
              <label>
                Last Name
                <input name="lastName" required />
              </label>
              <label>
                Email
                <input name="email" type="email" required />
              </label>
              <label>
                Contact
                <input name="contact" required />
              </label>
              <label>
                Address
                <input name="address" required />
              </label>
              <button className="btn-primary" type="submit">Submit Order</button>
            </form>
          ) : (
            <div className="form-success">
              <p>Thanks for your order. We will email you a confirmation shortly.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default Checkout;
