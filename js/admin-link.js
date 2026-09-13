document.addEventListener('DOMContentLoaded', () => {
    const adminLinks = document.querySelectorAll('.admin-link');
    const token = localStorage.getItem('pynx_admin_token');
    adminLinks.forEach(link => {
        link.classList.toggle('admin-visible', Boolean(token));
        link.classList.toggle('admin-hidden', !token);
    });
});
