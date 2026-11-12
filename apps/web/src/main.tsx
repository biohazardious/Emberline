import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { queryClient } from './queryClient';
import './index.css';
import './error-filter.css';
import './responsive.css';
import './board-bulk.css';

// Apply the saved theme before the first paint, so sign-in and setup match the app.
try {
  const savedTheme = localStorage.getItem('emberline.theme');
  if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.dataset.theme = savedTheme;
} catch {
  // Storage unavailable: the default (dark) theme applies.
}

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary title="Emberline encountered an unexpected error">
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
