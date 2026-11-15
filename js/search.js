/*
  search.js — zack design
  Site search over /search.json (built by Jekyll). The index is fetched the
  first time search opens, or when the pointer heads for the button, so pages
  that never search pay nothing for it.
  Open: the navbar button, "/" or Cmd/Ctrl+K. Arrows move, Enter opens.
*/

(function () {
  'use strict';

  const dialog = document.getElementById('site-search');
  if (!dialog || typeof dialog.showModal !== 'function') return;

  const input = dialog.querySelector('.site-search__input');
  const list = dialog.querySelector('.site-search__results');
  const status = dialog.querySelector('.site-search__status');
  const openers = document.querySelectorAll('[data-search-open]');

  const MAX_RESULTS = 12;
  let index = null;
  let loading = null;
  let results = [];
  let active = -1;

  // ------------------------------------------------------------- Index
  const fold = (s) =>
    (s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');

  const load = () => {
    if (loading) return loading;
    loading = fetch('/search.json', { credentials: 'same-origin' })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then((docs) => {
        index = docs.map((d) => ({
          ...d,
          ft: fold(d.t),
          fk: fold(d.k + ' ' + d.c),
          fe: fold(d.e),
          fb: fold(d.b),
        }));
        return index;
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
    return loading;
  };

  // ------------------------------------------------------------- Scoring
  const countOf = (hay, needle, cap) => {
    let n = 0;
    let i = hay.indexOf(needle);
    while (i !== -1 && n < cap) {
      n++;
      i = hay.indexOf(needle, i + needle.length);
    }
    return n;
  };

  // True when `needle` starts a word in `hay`.
  const startsWord = (hay, needle) => {
    let i = hay.indexOf(needle);
    while (i !== -1) {
      if (i === 0 || !/[\p{L}\p{N}]/u.test(hay[i - 1])) return true;
      i = hay.indexOf(needle, i + 1);
    }
    return false;
  };

  const search = (query) => {
    const q = fold(query).trim();
    const terms = q.split(/[^\p{L}\p{N}.+#-]+/u).filter(Boolean);
    if (!terms.length) return [];

    const scored = [];
    index.forEach((doc, order) => {
      let score = 0;
      for (const term of terms) {
        let s = 0;
        if (doc.ft.includes(term)) s += startsWord(doc.ft, term) ? 12 : 6;
        if (doc.fk.includes(term)) s += startsWord(doc.fk, term) ? 6 : 3;
        if (doc.fe.includes(term)) s += 3;
        const hits = countOf(doc.fb, term, 8);
        if (hits) s += 1 + hits * 0.4;
        // Every term has to match somewhere: "rust phone" finds Dolphone, not
        // everything written in Rust.
        if (!s) return;
        score += s;
      }
      if (terms.length > 1) {
        if (doc.ft.includes(q)) score += 10;
        else if (doc.fb.includes(q)) score += 3;
      }
      // Newer first among near-equals; the index is in date order.
      scored.push({ doc, score: score - order * 0.01 });
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((s) => ({ doc: s.doc, terms }));
  };

  // ------------------------------------------------------------- Rendering
  const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Highlight terms in the original (unfolded) text. Folding only strips
  // accents, so positions found in the folded copy line up with the original.
  const highlight = (text, terms) => {
    if (!terms.length) return escapeHtml(text);
    const folded = fold(text);
    if (folded.length !== text.length) return escapeHtml(text);
    const re = new RegExp(terms.map(escapeRe).join('|'), 'g');
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(folded))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      out += escapeHtml(text.slice(last, m.index)) + '<mark>' + escapeHtml(text.slice(m.index, m.index + m[0].length)) + '</mark>';
      last = m.index + m[0].length;
    }
    return out + escapeHtml(text.slice(last));
  };

  // A window of body text around the first match, or the summary when the
  // match is only in the title or tags.
  const snippet = (doc, terms) => {
    let at = -1;
    for (const t of terms) {
      const i = doc.fb.indexOf(t);
      if (i !== -1 && (at === -1 || i < at)) at = i;
    }
    if (at === -1 || terms.some((t) => doc.fe.includes(t))) {
      const e = doc.e.length > 180 ? doc.e.slice(0, 180).replace(/\s+\S*$/, '') + '…' : doc.e;
      return e;
    }
    let start = Math.max(0, at - 70);
    let end = Math.min(doc.b.length, at + 130);
    if (start > 0) start = doc.b.indexOf(' ', start) + 1 || start;
    if (end < doc.b.length) end = doc.b.lastIndexOf(' ', end) || end;
    return (start > 0 ? '…' : '') + doc.b.slice(start, end) + (end < doc.b.length ? '…' : '');
  };

  const render = (items, query) => {
    results = items;
    active = items.length ? 0 : -1;
    list.innerHTML = items
      .map(({ doc, terms }, i) => {
        const meta = [doc.c, doc.d].filter(Boolean).map(escapeHtml).join('<span class="site-search__dot"></span>');
        return (
          '<li role="option" id="site-search-opt-' + i + '" aria-selected="' + (i === active) + '">' +
          '<a class="site-search__hit" href="' + escapeHtml(doc.u) + '" tabindex="-1">' +
          '<span class="site-search__meta">' + meta + '</span>' +
          '<span class="site-search__title">' + highlight(doc.t, terms) + '</span>' +
          '<span class="site-search__snippet">' + highlight(snippet(doc, terms), terms) + '</span>' +
          '</a></li>'
        );
      })
      .join('');
    syncActive();

    if (!query.trim()) status.textContent = 'Search every post and page.';
    else if (!items.length) status.textContent = 'Nothing matches “' + query.trim() + '”.';
    else status.textContent = items.length === MAX_RESULTS ? 'Top ' + MAX_RESULTS + ' results' : items.length + (items.length === 1 ? ' result' : ' results');
  };

  const syncActive = () => {
    Array.from(list.children).forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', 'site-search-opt-' + active);
      list.children[active].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  let queued = false;
  const run = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!index) return;
      render(search(input.value), input.value);
    });
  };

  // ------------------------------------------------------------- Open / close
  const open = () => {
    if (dialog.open) return;
    dialog.showModal();
    document.documentElement.classList.add('search-open');
    input.select();
    if (index) return run();
    status.textContent = 'Loading…';
    load().then(run, () => {
      status.textContent = 'Search couldn’t load. Check your connection and try again.';
    });
  };

  dialog.addEventListener('close', () => document.documentElement.classList.remove('search-open'));

  openers.forEach((btn) => {
    btn.addEventListener('click', (e) => { e.preventDefault(); open(); });
    btn.addEventListener('pointerenter', () => load().catch(() => {}), { once: true });
    btn.addEventListener('focus', () => load().catch(() => {}), { once: true });
  });

  // A click on the backdrop lands on the <dialog> itself.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.querySelector('.site-search__close').addEventListener('click', () => dialog.close());

  document.addEventListener('keydown', (e) => {
    if (dialog.open) return;
    const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]');
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      open();
    } else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      open();
    }
  });

  input.addEventListener('input', run);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + results.length) % results.length;
      syncActive();
    } else if (e.key === 'Enter') {
      if (active < 0) return;
      e.preventDefault();
      const link = list.children[active].querySelector('a');
      if (e.metaKey || e.ctrlKey) window.open(link.href, '_blank', 'noopener');
      else window.location.href = link.href;
    }
  });

  list.addEventListener('pointermove', (e) => {
    const li = e.target.closest('li[role="option"]');
    if (!li) return;
    const i = Array.prototype.indexOf.call(list.children, li);
    if (i !== active) { active = i; syncActive(); }
  });
})();
