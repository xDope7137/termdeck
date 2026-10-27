'use strict';

// The marketing header's two live behaviours. Both are additive: with no JS the
// header is the opaque, non-highlighting bar the stylesheet already draws, so
// nothing here can leave a reader with a broken chrome.
//
// 1. TRANSPARENT OVER THE HERO. On a page whose first band is a full-bleed hero
//    (.hsec-hero), the bar starts with no background and no rule so the hero
//    reads to the top of the window, then takes its surface the moment you
//    scroll off it. Only on such pages: everywhere else the first thing under
//    the bar is ordinary content on the page column, and a transparent header
//    over that is just unreadable.
//
// 2. CURRENT SECTION. The nav points at in-page anchors, and on a long page it
//    should say which one you are in. A link is marked aria-current="location"
//    — the semantic for "this is where you are in a set of navigation links",
//    which also gives the stylesheet something to hang the marker on without a
//    class that means the same thing twice.
//
// Both run off ONE rAF-throttled scroll listener. The alternative — an
// IntersectionObserver per section — answers "is it visible", but the question
// here is "which one is under the header", and sections taller than the
// viewport make those two different answers.
//
// 3. THE PHONE MENU. Below 900px the stylesheet folds .nav-links away and shows
//    .nav-menu-btn (home.css); this wires the button: aria-expanded, the
//    menu-open class the panel hangs off, Escape and a tap outside close it,
//    focus moves to the first link on open and back to the button on close,
//    and choosing a link closes it. Additive like the rest: no JS, no menu,
//    and every destination is still in the footer.

(() => {
  const nav = document.querySelector('header.nav');
  if (!nav) return;

  const hero = document.querySelector('.hsec-hero');
  const links = [...nav.querySelectorAll('.nav-links a')];

  const menuBtn = nav.querySelector('.nav-menu-btn');
  const menu = nav.querySelector('.nav-links');
  if (menuBtn && menu) {
    const isOpen = () => nav.classList.contains('menu-open');
    const setOpen = (open, { refocus = true } = {}) => {
      if (open === isOpen()) return;
      nav.classList.toggle('menu-open', open);
      menuBtn.setAttribute('aria-expanded', String(open));
      if (open) {
        const first = menu.querySelector('a');
        if (first) first.focus({ preventScroll: true });
      } else if (refocus) {
        menuBtn.focus({ preventScroll: true });
      }
    };
    menuBtn.addEventListener('click', () => setOpen(!isOpen()));
    menu.addEventListener('click', (e) => {
      if (e.target.closest('a')) setOpen(false, { refocus: false });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) { e.preventDefault(); setOpen(false); }
    });
    document.addEventListener('pointerdown', (e) => {
      if (isOpen() && !nav.contains(e.target)) setOpen(false, { refocus: false });
    });
    // Widening past the fold puts the links back in the bar; the panel state
    // must not survive into that layout.
    const wide = window.matchMedia('(min-width: 901px)');
    wide.addEventListener('change', () => { if (wide.matches) setOpen(false, { refocus: false }); });
  }

  // In-page targets only: a link to /#features from /blog points at another
  // document, and nothing on this page can be "current" for it.
  //
  // The comparison has to be on the CANONICAL path, not the raw one. The nav
  // links the extensionless URLs the site actually serves (/about, /blog,
  // /#features) while the files behind them are /about.html, /blog/index.html
  // and /homepage.html — and the test suite, crawlers and any stray old link
  // reach them by filename. Comparing raw pathnames finds no targets on
  // /homepage.html, which is to say the header silently stops highlighting
  // anything on exactly the page this was written for.
  const norm = (p) => {
    const s = p.replace(/\/index\.html$/, '/').replace(/\.html$/, '').replace(/\/+$/, '');
    return (s === '' || s === '/homepage') ? '/' : s;
  };
  const here = norm(location.pathname);
  const targets = [];
  for (const a of links) {
    const url = new URL(a.getAttribute('href'), location.href);
    if (norm(url.pathname) !== here) continue;
    if (!url.hash) continue;
    const el = document.getElementById(url.hash.slice(1));
    if (el) targets.push({ a, el });
  }
  // DOCUMENT order, not nav order. The header lists Engines before Usage while
  // the page lays them out the other way round, so walking the nav's own order
  // and keeping the last match named whichever link happened to come last —
  // which is how this managed to highlight "Usage" for the Engines section.
  targets.sort((x, y) =>
    (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);

  // A page that IS one of the nav's destinations (/blog, /about) marks that
  // link once and has nothing to scroll-spy.
  if (!targets.length) {
    for (const a of links) {
      const url = new URL(a.getAttribute('href'), location.href);
      if (!url.hash && norm(url.pathname) === here) a.setAttribute('aria-current', 'page');
    }
  }

  // A section is current once its top passes this line. It has to clear
  // html{scroll-padding-top}, or clicking a nav link parks the section exactly
  // where the test line sits and nothing is ever marked — the anchor you just
  // followed would be the one link that never lights up.
  const pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
  const OFFSET = Math.max(nav.offsetHeight, pad) + 24;
  let current = null;
  let atTop = null;

  function apply() {
    if (hero) {
      // Only while the page is genuinely AT the top. The obvious rule — stay
      // transparent for as long as the hero is behind the bar — keeps it
      // transparent for hundreds of pixels of scrolling, and every one of them
      // drags hero content up through the nav links. The bar has to take its
      // surface the moment anything starts moving underneath it.
      const top = window.scrollY < nav.offsetHeight / 2;
      if (top !== atTop) {
        atTop = top;
        nav.classList.toggle('is-top', top);
      }
    }

    if (!targets.length) return;
    // The last section whose top has passed under the bar — and at the very
    // bottom of the page the last section always wins, because a short final
    // section can never get its top up to the bar.
    let found = null;
    const ended = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    if (ended) {
      found = targets[targets.length - 1];
    } else {
      for (const t of targets) {
        if (t.el.getBoundingClientRect().top <= OFFSET) found = t;
      }
    }
    if (found === current) return;
    if (current) current.a.removeAttribute('aria-current');
    if (found) found.a.setAttribute('aria-current', 'location');
    current = found;
  }

  let queued = false;
  function onScroll() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; apply(); });
  }

  apply();
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll, { passive: true });
})();
