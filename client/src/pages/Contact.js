function Contact() {
  const handleSubmit = (event) => {
    event.preventDefault();
    alert('Message sent — we’ll reply within 1–2 business days.');
    event.target.reset();
  };

  return (
    <div className="page page-contact">
      <header className="site-header">
        <div className="logo">PYNX</div>
      </header>
      <main>
        <section className="section contact-hero">
          <h1>Reach Out to Us</h1>
          <p>Prefer to reach us directly? Write to us at <a href="mailto:support@example.com">support@example.com</a></p>
        </section>
        <section className="section contact-panel">
          <form className="contact-form" onSubmit={handleSubmit}>
            <label>
              Name
              <input name="name" required />
            </label>
            <label>
              Email
              <input name="email" type="email" required />
            </label>
            <label>
              Phone Number
              <input name="phone" required />
            </label>
            <label>
              Comment
              <textarea name="message" required />
            </label>
            <button className="btn-primary" type="submit">Send</button>
          </form>
        </section>
      </main>
    </div>
  );
}

export default Contact;
