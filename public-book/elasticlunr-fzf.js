/**
 * Japanese search support for mdBook.
 *
 * Replaces elasticlunr's Index.load with fzf-based fuzzy search.
 * elasticlunr.js splits on whitespace which fails for Japanese (no spaces).
 * fzf does character-by-character fuzzy matching which handles CJK correctly.
 *
 * @see https://github.com/rust-lang/mdBook/issues/2052
 */
(() => {
  'use strict';

  if (typeof window.elasticlunr === 'undefined') {
    console.warn('elasticlunr-fzf: elasticlunr not found, skipping patch');
    return;
  }

  if (typeof window.fzf === 'undefined' || typeof window.fzf.Fzf === 'undefined') {
    console.warn('elasticlunr-fzf: fzf not found, skipping patch');
    return;
  }

  const Fzf = window.fzf.Fzf;

  window.elasticlunr.Index.load = (index) => {
    const storeDocs = index.documentStore.docs;
    const docIds = Object.keys(storeDocs);

    const fzfInstance = new Fzf(docIds, {
      selector: (id) => {
        const doc = storeDocs[id];
        return `${doc.title} ${doc.breadcrumbs} ${doc.body}`;
      },
    });

    return {
      search: (searchterm) => {
        const entries = fzfInstance.find(searchterm);
        return entries.map((entry) => ({
          doc: storeDocs[entry.item],
          ref: entry.item,
          score: entry.score,
        }));
      },
    };
  };
})();
