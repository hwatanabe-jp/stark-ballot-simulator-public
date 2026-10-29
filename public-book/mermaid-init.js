// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

(() => {
  function isLightTheme(classList, darkThemes) {
    let lastThemeWasLight = true;
    for (const cssClass of classList) {
      if (darkThemes.includes(cssClass)) {
        lastThemeWasLight = false;
        break;
      }
    }

    return lastThemeWasLight;
  }

  const darkThemes = ['ayu', 'navy', 'coal'];
  const lightThemes = ['light', 'rust'];

  const classList = document.getElementsByTagName('html')[0].classList;

  const lastThemeWasLight = isLightTheme(classList, darkThemes);

  const theme = lastThemeWasLight ? 'default' : 'dark';
  mermaid.initialize({
    startOnLoad: true,
    theme,
    flowchart: { useMaxWidth: false },
    sequence: { useMaxWidth: false },
  });

  // Simplest way to make mermaid re-render the diagrams in the new theme is via refreshing the page

  for (const darkTheme of darkThemes) {
    document.getElementById('mdbook-theme-' + darkTheme).addEventListener('click', () => {
      if (lastThemeWasLight) {
        window.location.reload();
      }
    });
  }

  for (const lightTheme of lightThemes) {
    document.getElementById('mdbook-theme-' + lightTheme).addEventListener('click', () => {
      if (!lastThemeWasLight) {
        window.location.reload();
      }
    });
  }
})();
