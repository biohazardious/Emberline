/** Built-in file templates written at project creation. Only the plain static site has one. */
import type { StarterId } from '@emberline/protocol';

export interface StarterContext {
  name: string;
  description: string;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function staticPlain({ name, description }: StarterContext): Record<string, string> {
  const title = escapeHtml(name);
  const lead = escapeHtml(description.trim().split('\n')[0] ?? '') || 'Edit this page to get started.';
  return {
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to content</a>
    <header class="site-header">
      <h1>${title}</h1>
    </header>
    <main id="main">
      <p class="lead">${lead}</p>
      <button type="button" id="greet" aria-live="polite">Say hello</button>
    </main>
    <footer class="site-footer">
      <p>Built with Emberline.</p>
    </footer>
    <script src="script.js" defer></script>
  </body>
</html>
`,
    'styles.css': `:root {
  color-scheme: light dark;
  --bg: #fdfcfa;
  --fg: #1c1b19;
  --accent: #b4410f;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161514;
    --fg: #f1efeb;
    --accent: #ff9966;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--fg);
  font: 1rem/1.6 system-ui, sans-serif;
}

main,
.site-header,
.site-footer {
  width: min(100% - 2rem, 48rem);
  margin-inline: auto;
}

main {
  flex: 1;
}

.lead {
  font-size: 1.25rem;
}

button {
  padding: 0.6rem 1.2rem;
  border: 2px solid var(--accent);
  border-radius: 0.4rem;
  background: transparent;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}

button:focus-visible,
a:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}

.skip-link {
  position: absolute;
  left: -999px;
}

.skip-link:focus {
  left: 1rem;
  top: 1rem;
}
`,
    'script.js': `'use strict';

const button = document.getElementById('greet');
if (button) {
  button.addEventListener('click', () => {
    button.textContent = 'Hello!';
  });
}
`,
  };
}

export const STARTERS: Record<StarterId, (ctx: StarterContext) => Record<string, string>> = {
  'static-plain': staticPlain,
};
