/**
 * 3DPrintFactory — Scroll-reveal animations
 * Adds 'revealed' class to [data-reveal] and [data-reveal-stagger]
 * elements when they enter the viewport.
 */
'use strict';

(function () {
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });

  document.querySelectorAll('[data-reveal], [data-reveal-stagger]').forEach(function (el) {
    observer.observe(el);
  });
})();
