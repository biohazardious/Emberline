/**
 * Test only, for files that run in a DOM (`// @vitest-environment happy-dom`): render, click, type,
 * pick files and wait, each inside React's `act`. `staticRender` is the node-only counterpart.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import { type api, ApiRequestError } from './api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A cache of its own per test; a failed request is not retried. */
export const testQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

export interface Rendered {
  container: HTMLElement;
  client: QueryClient;
  rerender: (element: ReactElement) => Promise<void>;
  unmount: () => Promise<void>;
}

const roots = new Set<Root>();

/** Mounts `element` at `path` (the browser location wouter reads) with a query client. */
export async function renderDom(
  element: ReactElement,
  { path = '/', client = testQueryClient() }: { path?: string; client?: QueryClient } = {},
): Promise<Rendered> {
  window.history.replaceState(null, '', path);
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  roots.add(root);
  const wrap = (el: ReactElement) => <QueryClientProvider client={client}>{el}</QueryClientProvider>;
  await act(async () => root.render(wrap(element)));
  return {
    container,
    client,
    rerender: (el) => act(async () => root.render(wrap(el))),
    unmount: async () => {
      roots.delete(root);
      await act(async () => root.unmount());
    },
  };
}

/** Unmounts everything `renderDom` mounted and empties the page; call it after each test. */
export async function cleanup(): Promise<void> {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
}

const text = (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/** The button whose text is `name` (a RegExp: matches), or null. */
export function queryButton(
  name: string | RegExp,
  root: ParentNode = document.body,
): HTMLButtonElement | null {
  const buttons = [...root.querySelectorAll('button')];
  return buttons.find((b) => (typeof name === 'string' ? text(b) === name : name.test(text(b)))) ?? null;
}

export function getButton(name: string | RegExp, root: ParentNode = document.body): HTMLButtonElement {
  const found = queryButton(name, root);
  if (!found) throw new Error(`no button ${String(name)} in: ${text(document.body)}`);
  return found;
}

export async function click(el: Element): Promise<void> {
  await act(async () => (el as HTMLElement).click());
}

/** Types `value` into a controlled field the way the browser does: set the value, fire `input`. */
export async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Picks `files` in a file input, as the file chooser does. */
export async function pickFiles(input: HTMLInputElement, files: File[]): Promise<void> {
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}

/** Lets pending requests, effects and timers run (fake timers advance instead of sleeping). */
export async function settle(ms = 10): Promise<void> {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
    else await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Retries `check` until it passes, letting the app run in between; throws its last failure. */
export async function waitFor(check: () => void, timeoutMs = 2_000): Promise<void> {
  for (let waited = 0; ; waited += 10) {
    try {
      check();
      return;
    } catch (e) {
      if (waited >= timeoutMs) throw e;
    }
    await settle();
  }
}

/** A promise settled from outside: a request still in flight until the test answers it. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Route = (body: unknown) => unknown;

/**
 * A stand-in for `api`: `routes` maps "METHOD /path" to an answer (a function gets the body; what
 * it throws or rejects with is the failure). Anything else fails as a 404, so a stray request shows.
 */
export const apiRoutes =
  (routes: Record<string, Route>): typeof api =>
  async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const route = routes[`${method} ${path}`];
    if (!route) throw new ApiRequestError(404, 'not_found', `no test route for ${method} ${path}`);
    return (await route(body)) as T;
  };
