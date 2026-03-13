/**
 * 3DPrintFactory — Shared Navigation
 * Renders the site nav and footer, marks the active page link.
 */

'use strict';

(function () {
  /* ── Determine active page ── */
  const path   = window.location.pathname.split('/').pop() || 'index.html';
  const active = (href) => path === href ? ' class="active"' : '';

  /* ── Nav HTML ── */
  const navHTML = `
<nav class="site-nav" role="navigation" aria-label="Main navigation">
  <a href="index.html" class="nav-logo">3DPrint<span>Factory</span></a>
  <ul class="nav-links" id="navLinks">
    <li><a href="index.html"${active('index.html')}>Home</a></li>
    <li><a href="quote.html"${active('quote.html')}>Get Quote</a></li>
    <li><a href="faq.html"${active('faq.html')}>FAQ</a></li>
  </ul>
  <div class="nav-cta">
    <a href="checkout.html" class="nav-cart-link" aria-label="View cart">
      CART <span class="cart-badge" id="navCartBadge" style="display:none">0</span>
    </a>
    <a href="quote.html" class="btn btn-primary btn-sm hide-mobile">GET QUOTE</a>
  </div>
  <button class="nav-hamburger" id="navHamburger" aria-expanded="false" aria-controls="navLinks">&#9776;</button>
  <div class="nav-pulse"></div>
</nav>`;

  /* ── Footer HTML ── */
  const footerHTML = `
<footer class="site-footer" role="contentinfo">
  <div class="footer-grid">
    <div class="footer-brand">
      <a href="index.html" class="nav-logo display">3DPrint<span style="color:var(--text-muted);font-size:0.7em">Factory</span></a>
      <p style="margin-top:10px">Professional FDM printing.<br>Instant quotes. Fast delivery.</p>
      <p style="margin-top:10px;font-size:0.65rem;color:var(--text-dim)">&#x2B22; Based in the UK</p>
    </div>
    <div class="footer-col">
      <h4>Services</h4>
      <ul>
        <li><a href="quote.html">Instant Quote</a></li>
        <li><a href="quote.html">PLA Printing</a></li>
        <li><a href="quote.html">PETG Printing</a></li>
        <li><a href="quote.html">Flexible (TPU)</a></li>
      </ul>
    </div>
    <div class="footer-col">
      <h4>Company</h4>
      <ul>
        <li><a href="faq.html">About Us</a></li>
        <li><a href="faq.html#faq">FAQ</a></li>
        <li><a href="faq.html#contact">Contact</a></li>
      </ul>
    </div>
    <div class="footer-col">
      <h4>Legal</h4>
      <ul>
        <li><a href="faq.html#privacy">Privacy Policy</a></li>
        <li><a href="faq.html#terms">Terms of Service</a></li>
        <li><a href="faq.html#returns">Returns Policy</a></li>
      </ul>
    </div>
  </div>
  <div class="footer-bottom">
    <span>&copy; ${new Date().getFullYear()} 3DPrintFactory Ltd. All rights reserved.</span>
    <span>Registered in England &amp; Wales</span>
  </div>
</footer>`;

  /* ── Inject nav ── */
  const navMount = document.getElementById('nav-mount');
  if (navMount) navMount.outerHTML = navHTML;

  /* ── Inject footer ── */
  const footerMount = document.getElementById('footer-mount');
  if (footerMount) footerMount.outerHTML = footerHTML;

  /* ── Hamburger toggle ── */
  document.addEventListener('click', (e) => {
    const btn   = e.target.closest('#navHamburger');
    const links = document.getElementById('navLinks');
    if (!btn || !links) return;
    const open = links.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  });

  /* ── Update cart badge ── */
  if (window.Cart) {
    window.Cart.updateNavBadge();
  } else {
    // Cart module loads after nav — re-try after it loads
    window.addEventListener('cartReady', () => window.Cart && window.Cart.updateNavBadge());
  }
})();
