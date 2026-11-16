import type {
  ContainerPreviewDiffResponse,
  ContainerPreviewOptionsResponse,
  Project,
  WorktreeConfigStatusResponse,
} from '@emberline/protocol';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import {
  ANCHOR_HOLD_MS,
  anchorHoldActive,
  anchorResizeTargets,
  anchorScrollDue,
  CONTAINER_PREVIEW_ANCHOR,
  CONTAINER_PREVIEW_DIFF_DELAY_MS,
  CONTAINER_PREVIEW_TITLE,
  type ContainerPreviewDraft,
  choiceForService,
  containerPreviewBoxShown,
  containerPreviewIntro,
  containerPreviewSaveEnabled,
  declaredPortsLine,
  defaultContainerPreviewChoice,
  optionsAfterSave,
  parsePort,
  portProblem,
  USE_CONTAINER_PREVIEW_LABEL,
} from '../containerPreviewSetup';
import { useApi } from '../hooks/useApi';
import { refreshWorktreeConfigViews, WORKTREE_EDIT_HINT, worktreeSaveFailure } from '../projectSettings';
import './project-settings-ux.css';
import { Disclosure } from './ui/Disclosure';

/** Spec §2: pick a compose service and port, see the worktree.yml diff, then commit + approve it. */
export function ContainerPreviewBox({ project }: { project: Project }) {
  const optionsUrl = `/api/projects/${project.id}/container-preview`;
  const statusUrl = `/api/projects/${project.id}/worktree-config`;
  const options = useApi<ContainerPreviewOptionsResponse>(optionsUrl, 30_000);
  const queryClient = useQueryClient();
  const data = options.data;
  const shown = containerPreviewBoxShown(data);
  const [draft, setDraft] = useState<ContainerPreviewDraft | null>(null);
  const [portText, setPortText] = useState('');
  const [diffState, setDiffState] = useState<{ for: string; value: ContainerPreviewDiffResponse } | null>(
    null,
  );
  const [diffError, setDiffError] = useState<ReturnType<typeof worktreeSaveFailure> | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof worktreeSaveFailure> | null>(null);
  const [reloads, setReloads] = useState(0);
  const box = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!data?.available) return;
    if (draft && data.services.some((s) => s.name === draft.service)) return;
    const next = defaultContainerPreviewChoice(data.services);
    setDraft(next);
    setPortText(next?.port != null ? String(next.port) : '');
  }, [data, draft]);

  const fetching = useIsFetching();
  const scrolled = useRef(false);
  const holdStop = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (
      !anchorScrollDue({
        scrolled: scrolled.current,
        shown,
        fetching,
        hash: window.location.hash,
        anchor: CONTAINER_PREVIEW_ANCHOR,
      })
    )
      return;
    scrolled.current = true;
    box.current?.scrollIntoView({ block: 'start' });
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const started = Date.now();
    let userScrolled = false;
    const userEvents = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;
    const stop = () => {
      observer.disconnect();
      for (const e of userEvents) window.removeEventListener(e, onUser);
      holdStop.current = null;
    };
    const onUser = () => {
      userScrolled = true;
      stop();
    };
    const observer = new ResizeObserver(() => {
      if (
        !anchorHoldActive({
          elapsedMs: Date.now() - started,
          userScrolled,
          hash: window.location.hash,
          anchor: CONTAINER_PREVIEW_ANCHOR,
        })
      ) {
        stop();
        return;
      }
      el.scrollIntoView({ block: 'start' });
    });
    for (const e of userEvents) window.addEventListener(e, onUser, { passive: true });
    for (const target of anchorResizeTargets(el)) observer.observe(target);
    holdStop.current = stop;
    setTimeout(() => holdStop.current === stop && stop(), ANCHOR_HOLD_MS);
  }, [shown, fetching]);
  useEffect(() => () => holdStop.current?.(), []);

  const file = data?.available ? data.file : null;
  const service = draft?.service ?? null;
  const port = draft?.port ?? null;
  const pickKey = file && service && port !== null ? `${file}\n${service}\n${port}` : null;
  const diff = diffState && diffState.for === pickKey ? diffState.value : null;
  useEffect(() => {
    setDiffState(null);
    setDiffError(null);
    if (!file || !service || port === null) return;
    let stale = false;
    const timer = setTimeout(() => {
      api<ContainerPreviewDiffResponse>(`${optionsUrl}/diff`, 'POST', { file, service, port }).then(
        (next) => !stale && setDiffState({ for: `${file}\n${service}\n${port}`, value: next }),
        (err: unknown) => !stale && setDiffError(worktreeSaveFailure(err)),
      );
    }, CONTAINER_PREVIEW_DIFF_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [file, service, port, optionsUrl, reloads]);

  const save = async () => {
    if (!file || !service || port === null || !diff) return;
    setBusy(true);
    setFailure(null);
    try {
      const saved = await api<WorktreeConfigStatusResponse>(optionsUrl, 'POST', {
        file,
        service,
        port,
        baseSha256: diff.baseSha256,
      });
      queryClient.setQueryData(['api', statusUrl], saved);
      queryClient.setQueryData<ContainerPreviewOptionsResponse>(['api', optionsUrl], optionsAfterSave);
      await options.refresh();
      await refreshWorktreeConfigViews(queryClient, project.id);
    } catch (err) {
      setFailure(worktreeSaveFailure(err));
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    setFailure(null);
    await options.refresh().catch(() => undefined);
    await queryClient.invalidateQueries({ queryKey: ['api', statusUrl] });
    setReloads((n) => n + 1);
  };

  if (!shown || !data?.file) return null;
  const problem = portProblem(portText);
  const ports = data.services.find((s) => s.name === service)?.ports ?? [];
  return (
    <section
      ref={box}
      id={CONTAINER_PREVIEW_ANCHOR}
      className="project-settings-section container-preview-setup"
      aria-labelledby="container-preview-title"
    >
      <div className="project-settings-section-head">
        <h3 id="container-preview-title" className="project-settings-section-title">
          {CONTAINER_PREVIEW_TITLE}
        </h3>
        <span className="badge mono">{data.file}</span>
      </div>
      {!data.available ? (
        <p className="banner banner-warn" role="alert">
          {data.reason}
        </p>
      ) : (
        <>
          <div className="container-preview-row">
            <div className="container-preview-controls">
              <label className="container-preview-field">
                Service
                <select
                  className="input"
                  value={service ?? ''}
                  disabled={busy}
                  onChange={(e) => {
                    const next = choiceForService(data.services, e.target.value);
                    setDraft(next);
                    setPortText(next.port != null ? String(next.port) : '');
                  }}
                >
                  {data.services.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="container-preview-field">
                Container port
                <input
                  className="input container-preview-port-input mono"
                  inputMode="numeric"
                  list="container-preview-ports"
                  aria-invalid={problem !== null}
                  aria-describedby={problem ? 'container-preview-port-problem' : undefined}
                  value={portText}
                  disabled={busy}
                  onChange={(e) => {
                    setPortText(e.target.value);
                    setDraft((d) => (d ? { ...d, port: parsePort(e.target.value) } : d));
                  }}
                />
                <datalist id="container-preview-ports">
                  {ports.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </label>
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!containerPreviewSaveEnabled({ draft, diffReady: diff !== null, busy })}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : USE_CONTAINER_PREVIEW_LABEL}
            </button>
          </div>
          {problem && (
            <p id="container-preview-port-problem" className="banner banner-warn" role="alert">
              {problem}
            </p>
          )}
          {diffError && (
            <div className="banner banner-error" role="alert">
              <p>{diffError.message}</p>
              {diffError.errors.length > 0 && (
                <ul>
                  {diffError.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
              {diffError.reload && (
                <button type="button" className="btn btn-sm" onClick={() => void reload()}>
                  Reload
                </button>
              )}
            </div>
          )}
          {failure && (
            <div className="banner banner-error" role="alert">
              <p>{failure.message}</p>
              {failure.errors.length > 0 && (
                <ul>
                  {failure.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
              {failure.reload && (
                <button type="button" className="btn btn-sm" onClick={() => void reload()}>
                  Reload
                </button>
              )}
            </div>
          )}
          <Disclosure label="Setup details">
            <div className="container-preview-details">
              <p className="muted small">{containerPreviewIntro(data.file)}</p>
              {service && (
                <p id="container-preview-declared" className="muted small">
                  {declaredPortsLine(service, ports)}
                </p>
              )}
              {diff && (
                <div role="region" aria-label="Changes to worktree.yml">
                  <pre className="worktree-review-diff mono" tabIndex={0}>
                    {diff.diff}
                  </pre>
                </div>
              )}
              <p className="muted small">{WORKTREE_EDIT_HINT}</p>
            </div>
          </Disclosure>
        </>
      )}
    </section>
  );
}
