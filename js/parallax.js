/*
  parallax.js — zack design
  - Navbar scrolled state
  - Reading progress bar (post pages)
  - Per-element --scroll-progress via IntersectionObserver + rAF
  - Reveal entrance + stagger
  - Hero orb cursor drift (desktop)
  - Smooth anchor scrolling
  - TOC active-section highlight (post pages)
*/

(function () {
  'use strict';

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isFinePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  // ---------------------------------------------------------------- Navbar
  const nav = document.getElementById('mainNav');
  if (nav) {
    const updateNav = () => {
      nav.classList.toggle('navbar-scrolled', window.scrollY > 60);
    };
    updateNav();
    window.addEventListener('scroll', updateNav, { passive: true });
  }

  // ---------------------------------------------------------------- Reading progress (posts)
  const progressBars = document.querySelectorAll('.reading-progress__bar');
  if (progressBars.length) {
    const updateProgress = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      const p = scrollable > 0 ? (window.scrollY / scrollable) * 100 : 0;
      progressBars.forEach((bar) => (bar.style.width = p + '%'));
    };
    updateProgress();
    window.addEventListener('scroll', updateProgress, { passive: true });
    window.addEventListener('resize', updateProgress, { passive: true });
  }

  // ---------------------------------------------------------------- Smooth anchor scroll
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const href = a.getAttribute('href');
      if (!href || href === '#' || href.length < 2) return;
      const target = document.querySelector(href);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
        block: 'start',
      });
    });
  });

  // ---------------------------------------------------------------- Reveal elements
  const revealSelector = '.reveal, .reveal-left, .reveal-right, .reveal-scale';
  const revealEls = document.querySelectorAll(revealSelector);
  if (revealEls.length) {
    // Set stagger delays on children of data-stagger containers
    document.querySelectorAll('[data-stagger]').forEach((container) => {
      const step = parseInt(container.dataset.stagger, 10) || 80;
      const children = container.querySelectorAll(
        ':scope > .reveal, :scope > .reveal-left, :scope > .reveal-right, :scope > .reveal-scale, :scope > * > .reveal, :scope > * > .reveal-left, :scope > * > .reveal-right, :scope > * > .reveal-scale'
      );
      children.forEach((child, i) => {
        child.style.setProperty('--reveal-delay', i * step + 'ms');
      });
    });

    const revealIO = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-revealed');
            revealIO.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );
    revealEls.forEach((el) => revealIO.observe(el));
  }

  // ---------------------------------------------------------------- Scroll progress per-element
  if (!prefersReducedMotion) {
    const parallaxEls = Array.from(document.querySelectorAll('[data-parallax]'));
    if (parallaxEls.length) {
      const visibleSet = new Set();

      const visibilityIO = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) visibleSet.add(entry.target);
            else visibleSet.delete(entry.target);
          });
          schedule();
        },
        { threshold: 0, rootMargin: '20% 0px 20% 0px' }
      );
      parallaxEls.forEach((el) => visibilityIO.observe(el));

      const update = () => {
        const vh = window.innerHeight;
        visibleSet.forEach((el) => {
          const rect = el.getBoundingClientRect();
          // progress 0 = element just entered from bottom; 1 = element just left out the top
          const raw = (vh - rect.top) / (vh + rect.height);
          const progress = Math.max(0, Math.min(1, raw));
          el.style.setProperty('--scroll-progress', progress.toFixed(4));
        });
      };

      let rafPending = false;
      const schedule = () => {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
          update();
          rafPending = false;
        });
      };

      update();
      window.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', schedule, { passive: true });
    }

    // -------------------------------------------------------------- Hero orb mouse drift
    if (isFinePointer) {
      const orbs = document.querySelectorAll('.hero-orb');
      if (orbs.length) {
        let targetX = 0, targetY = 0, curX = 0, curY = 0;
        document.addEventListener(
          'mousemove',
          (e) => {
            targetX = (e.clientX / window.innerWidth - 0.5) * 2;
            targetY = (e.clientY / window.innerHeight - 0.5) * 2;
          },
          { passive: true }
        );
        const tick = () => {
          curX += (targetX - curX) * 0.05;
          curY += (targetY - curY) * 0.05;
          orbs.forEach((orb, i) => {
            const mult = i % 2 === 0 ? 28 : -20;
            orb.style.transform = `translate3d(${(curX * mult).toFixed(2)}px, ${(curY * mult).toFixed(2)}px, 0)`;
          });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }
    }
  }

  // ---------------------------------------------------------------- TOC build + active section (post pages)
  const toc = document.querySelector('.post-toc');
  if (toc) {
    const headings = document.querySelectorAll('.post-body h2, .post-body h3');
    if (headings.length >= 2) {
      const slugify = (t) =>
        t
          .toLowerCase()
          .trim()
          .replace(/[^\w\s-]/g, '')
          .replace(/\s+/g, '-')
          .replace(/-+/g, '-');
      const list = document.createElement('ul');
      headings.forEach((h) => {
        if (!h.id) h.id = slugify(h.textContent);
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = '#' + h.id;
        a.textContent = h.textContent;
        if (h.tagName === 'H3') a.classList.add('post-toc__h3');
        li.appendChild(a);
        list.appendChild(li);
      });
      const label = document.createElement('div');
      label.className = 'post-toc__label';
      label.textContent = 'In this post';
      toc.appendChild(label);
      toc.appendChild(list);
      toc.hidden = false;

      const tocLinks = toc.querySelectorAll('a[href^="#"]');
      const tocMap = new Map();
      tocLinks.forEach((link) => {
        const id = link.getAttribute('href').slice(1);
        const target = document.getElementById(id);
        if (target) tocMap.set(target, link);
      });

      if (tocMap.size) {
        const tocIO = new IntersectionObserver(
          (entries) => {
            entries.forEach((entry) => {
              const link = tocMap.get(entry.target);
              if (!link) return;
              if (entry.isIntersecting) {
                tocLinks.forEach((l) => l.classList.remove('is-active'));
                link.classList.add('is-active');
              }
            });
          },
          { rootMargin: '-35% 0px -55% 0px', threshold: 0 }
        );
        tocMap.forEach((_, target) => tocIO.observe(target));
      }
    } else {
      toc.hidden = true;
    }
  }

  // ---------------------------------------------------------------- Copy link share
  document.querySelectorAll('[data-copy-url]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const url = btn.dataset.copyUrl || window.location.href;
      navigator.clipboard?.writeText(url).then(() => {
        const original = btn.innerHTML;
        btn.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
        setTimeout(() => {
          btn.innerHTML = original;
        }, 1600);
      });
    });
  });
})();
