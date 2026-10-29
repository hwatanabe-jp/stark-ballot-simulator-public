import { defineConfig } from 'oxfmt';

export default defineConfig({
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 120,
  tabWidth: 2,
  useTabs: false,
  arrowParens: 'always',
  endOfLine: 'lf',
  sortPackageJson: true,
  ignorePatterns: ['public-book/book/', 'public-book/fzf.umd.js', 'public-book/mermaid.min.js', 'formal/.lake/'],
  sortImports: false,
  sortTailwindcss: {
    stylesheet: 'apps/web/src/styles/globals.css',
  },
});
