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
  CONTAINER_PREVIEW_ANCHOR,
  CONTAINER_PREVIEW_DIFF_DELAY_MS,
  CONTAINER_PREVIEW_TITLE,
  type ContainerPreviewDraft,
  USE_CONTAINER_PREVIEW_LABEL,
  choiceForService,
  containerPreviewBoxShown,
  containerPreviewIntro,
  containerPreviewSaveEnabled,
  declaredPortsLine,
  defaultContainerPreviewChoice,
  parsePort,
  portProblem,
} from '../containerPreviewSetup';
import { useApi } from '../hooks/useApi';
import { WORKTREE_EDIT_HINT, refreshWorktreeConfigViews, worktreeSaveFailure } from '../projectSettings';

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

  // Defaults once the services are known; a choice whose service vanished starts over.
  useEffect(() => {
    if (!data?.available) return;
    if (draft && data.services.some((s) => s.name === draft.service)) return;
    const next = defaultContainerPreviewChoice(data.services);
    setDraft(next);
    setPortText(next?.port != null ? String(next.port) : '');
  }, [data, draft]);

  // Scroll to the box once, after the page's first loads settle: content above it still grows until then.
  const fetching = useIsFetching();
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !shown || fetching > 0 || window.location.hash !== `#${CONTAINER_PREVIEW_ANCHOR}`)
      return;
    scrolled.current = true;
    box.current?.scrollIntoView({ block: 'start' });
  }, [shown, fetching]);

  // The diff follows the choice, a moment after the last change.
  const file = data?.available ? data.file : null;
  const service = draft?.service ?? null;
  const port = draft?.port ?? null;
  const pickKey = file && service && port !== null ? `${file}\n${service}\n${port}` : null;
  // A diff counts only for the pick it was made for, so a stale one is never shown or saved.
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
      await options.refresh(); // file becomes null: the box goes away
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
      className="container-preview-setup"
      aria-labelledby="container-preview-title"
    >
      <h3 id="container-preview-title">{CONTAINER_PREVIEW_TITLE}</h3>
      <p className="muted">{containerPreviewIntro(data.file)}</p>
      {!data.available ? (
        <p className="banner banner-warn" role="alert">
          {data.reason}
        </p>
      ) : (
        <>
          <div className="container-preview-setup-fields">
            <label>
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
            <label>
              Container port
              <input
                className="input"
                inputMode="numeric"
                list="container-preview-ports"
                aria-invalid={problem !== null}
                aria-describedby={problem ? 'container-preview-port-problem' : 'container-preview-declared'}
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
          {problem && (
            <p id="container-preview-port-problem" className="banner banner-warn" role="alert">
              {problem}
            </p>
          )}
          {service && (
            <p id="container-preview-declared" className="muted small">
              {declaredPortsLine(service, ports)}
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
          {diff && (
            <div role="region" aria-label="Changes to worktree.yml">
              <pre className="worktree-review-diff mono" tabIndex={0}>
                {diff.diff}
              </pre>
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
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!containerPreviewSaveEnabled({ draft, diffReady: diff !== null, busy })}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : USE_CONTAINER_PREVIEW_LABEL}
            </button>
            <span className="muted small">{WORKTREE_EDIT_HINT}</span>
          </div>
        </>
      )}
    </section>
  );
}
