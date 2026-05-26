// AI OS Landing Page — Interactions

document.addEventListener('DOMContentLoaded', () => {

  // --- Mobile Menu ---
  const menuBtn = document.getElementById('mobileMenuBtn');
  const mobileMenu = document.getElementById('mobileMenu');
  if (menuBtn) {
    menuBtn.addEventListener('click', () => {
      mobileMenu.classList.toggle('active');
      menuBtn.textContent = mobileMenu.classList.contains('active') ? '✕' : '☰';
    });
    // Close menu on link click
    mobileMenu.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => {
        mobileMenu.classList.remove('active');
        menuBtn.textContent = '☰';
      });
    });
  }

  // --- FAQ Accordion ---
  document.querySelectorAll('.faq-question').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.parentElement;
      const wasOpen = item.classList.contains('open');
      // Close all
      document.querySelectorAll('.faq-item.open').forEach(i => i.classList.remove('open'));
      // Toggle clicked
      if (!wasOpen) item.classList.add('open');
    });
  });

  // --- Login Modal ---
  const loginModal = document.getElementById('loginModal');
  const loginClose = document.getElementById('loginModalClose');
  const loginBtn = document.getElementById('loginSubmitBtn');

  // Open login modal from nav
  document.querySelectorAll('a[href="/login"]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      loginModal.classList.add('active');
    });
  });

  if (loginClose) {
    loginClose.addEventListener('click', () => loginModal.classList.remove('active'));
  }

  // Close modal on overlay click
  if (loginModal) {
    loginModal.addEventListener('click', (e) => {
      if (e.target === loginModal) loginModal.classList.remove('active');
    });
  }

  // Login submit
  if (loginBtn) {
    loginBtn.addEventListener('click', async () => {
      const email = document.getElementById('loginEmail').value.trim();
      const password = document.getElementById('loginPassword').value;
      const errorEl = document.getElementById('loginError');

      if (!email || !password) {
        errorEl.textContent = 'Please fill in all fields.';
        errorEl.style.display = 'block';
        return;
      }

      loginBtn.textContent = 'Logging in...';
      loginBtn.disabled = true;

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json();

        if (data.ok && data.token) {
          localStorage.setItem('ai-os-token', data.token);
          window.location.href = '/app';
        } else {
          errorEl.textContent = data.error || 'Invalid credentials.';
          errorEl.style.display = 'block';
        }
      } catch (e) {
        errorEl.textContent = 'Connection error. Try again.';
        errorEl.style.display = 'block';
      }

      loginBtn.textContent = 'Log In';
      loginBtn.disabled = false;
    });
  }

  // --- Nav scroll effect ---
  const nav = document.querySelector('.landing-nav');
  window.addEventListener('scroll', () => {
    if (window.scrollY > 40) {
      nav.style.borderBottomColor = 'rgba(59, 130, 246, 0.15)';
    } else {
      nav.style.borderBottomColor = '';
    }
  });

  // --- Terminal typing animation ---
  const terminalLines = document.querySelectorAll('.terminal-line');
  terminalLines.forEach((line, i) => {
    line.style.opacity = '0';
    line.style.transform = 'translateY(8px)';
    line.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
    setTimeout(() => {
      line.style.opacity = '1';
      line.style.transform = 'translateY(0)';
    }, 300 + i * 400);
  });

  // --- Feature cards stagger (Intersection Observer) ---
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.feature-card, .arch-layer, .pricing-card, .testimonial-card').forEach((el, i) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = `opacity 0.5s ease ${i % 4 * 0.1}s, transform 0.5s ease ${i % 4 * 0.1}s`;
    observer.observe(el);
  });

  // --- Smooth scroll for anchor links ---
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', (e) => {
      const targetId = anchor.getAttribute('href');
      if (targetId === '#') return;
      const target = document.querySelector(targetId);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

});
