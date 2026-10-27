'use strict';

// Load-in reveal for the marketing pages (homepage, /vs/*, /blog). Every .rv
// rests a step low (the LOAD-IN REVEAL block in /home.css and /vs/vs.css) and
// slides up to its seat the first time it enters the viewport — hero on load,
// sections as you reach them, siblings staggered by --rvd.
//
// Two ways an element gets tagged, ONE observer that lands it:
//   - the homepage choreographs by hand: .rv and --rvd live in its markup, so
//     the hidden state exists at parse time and its inline head gate (rv-on)
//     sets up before first paint;
//   - the vs/blog pages are content that keeps being written, so their tags
//     come from the convention pass below — hero children and section-level
//     blocks, staggered among tagged siblings of the same parent. On those
//     pages BOTH the gate and the tags come from this script, so a failed
//     load, no-JS, or a stale cached stylesheet all degrade to the resting
//     page with nothing hidden.
//
// The hero headline and post figures slide without fading (rv-move): an
// opacity:0 LCP candidate does not count as painted until it fades in, and
// that read as a slow page in Lighthouse. Once a node lands its classes are
// stripped — .rv's 1s transition would otherwise outlive the entrance and
// slow a card's .18s hover lift.

(() => {
  if (!('IntersectionObserver' in window)) return;

  // Convention pass (a no-op on the homepage: these classes only exist on the
  // vs/blog shells). DOM order inside a parent is the stagger order.
  const AUTO = '.vs-hero .shell > *, .vs-section-head, .vs-cmp-wrap, .vs-note, ' +
    '.vs-cta, .vs-related, .vs-faq-card, .vs-card, .post-body, .post-figure, .post-steps';
  const tagged = new Map(); // parent -> tagged-child count, for the stagger
  for (const el of document.querySelectorAll(AUTO)) {
    if (el.classList.contains('rv')) continue;
    el.classList.add('rv');
    const n = tagged.get(el.parentNode) || 0;
    if (n) el.style.setProperty('--rvd', `${Math.min(n, 4) / 10}s`);
    tagged.set(el.parentNode, n + 1);
  }
  for (const el of document.querySelectorAll('.vs-hero h1.rv, .post-figure.rv')) {
    el.classList.add('rv-move');
  }

  document.documentElement.classList.add('rv-on');

  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return;
    io.unobserve(e.target);
    const el = e.target;
    requestAnimationFrame(() => el.classList.add('rv-in'));
    setTimeout(() => {
      el.classList.remove('rv', 'rv-in', 'rv-move', 'rv-fade');
      el.style.removeProperty('--rvd');
    }, 2000); // past the longest stagger (.4s) + duration (1.2s)
  }), { rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.rv').forEach((el) => io.observe(el));
})();
