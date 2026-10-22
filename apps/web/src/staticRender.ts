import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';

/** Test only: the first render of `element` as HTML. `useApi` answers come from `cached`; no effects run and nothing is fetched. */
export function renderStatic(
  element: ReactElement,
  cached: Record<string, unknown> = {},
  path = '/',
): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [url, data] of Object.entries(cached)) client.setQueryData(['api', url], data);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(Router, { ssrPath: path, children: element }),
    ),
  );
}
