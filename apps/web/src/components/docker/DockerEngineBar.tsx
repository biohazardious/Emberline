import type { DockerCleanupResponse, DockerOverview } from '@emberline/protocol';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api';
import { dockerEngineLine } from '../../dockerEngine';
import {
  cleanupLines,
  cleanupResultText,
  cleanupScopeHint,
  DOCKER_CLEANUP_SCOPE_HINT,
  dockerErrorDetails,
} from '../../dockerPage';
import { timeAgo } from '../../time';
import { Disclosure, HelpHint } from '../ui';
import { DockerAlert, type ErrorDetails } from './DockerAlert';

export function DockerEngineBar({
  data,
  scoped,
  onStart,
  onCleaned,
}: {
  data: DockerOverview;
  scoped: boolean;
  onStart: () => void;
  onCleaned: () => Promise<void>;
}) {
  const [cleaning, setCleaning] = useState(false);
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);
  const [error, setError] = useState<ErrorDetails | null>(null);
  const lines = cleanupLines(data.cleanup, timeAgo);
  const sweeping = cleaning || data.cleanup.sweeping;
  const scopeHint = cleanupScopeHint(scoped);

  async function cleanUp() {
    setCleaning(true);
    setResult(null);
    setError(null);
    onStart();
    try {
      setResult(cleanupResultText(await api<DockerCleanupResponse>('/api/docker/cleanup', 'POST')));
      await onCleaned();
    } catch (e) {
      setError(dockerErrorDetails(e));
    } finally {
      setCleaning(false);
    }
  }

  return (
    <section className="panel docker-ux-engine" aria-label="Docker engine">
      <div className="docker-ux-engine-bar">
        <div className="docker-ux-engine-status">
          <p className="docker-ux-engine-line">
            {dockerEngineLine(data.error ? { ...data.engine, error: undefined } : data.engine)}
          </p>
          <HelpHint topic="Docker cleanup">
            <div className="docker-ux-help-copy">
              <p>{scopeHint ?? DOCKER_CLEANUP_SCOPE_HINT}</p>
              <p>
                {lines.sweep} {lines.prune}
              </p>
            </div>
          </HelpHint>
        </div>
        <div className="docker-ux-engine-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={sweeping || !data.engine.available}
            onClick={() => void cleanUp()}
          >
            <RefreshCw className={`icon${sweeping ? ' icon-spin' : ''}`} aria-hidden="true" />{' '}
            {sweeping ? 'Cleaning up…' : 'Clean up now'}
          </button>
        </div>
      </div>
      {!data.engine.available && <p className="muted small">Clean up now needs a running engine.</p>}
      {result &&
        (result.ok ? (
          <p className="small" role="status">
            {result.text}
          </p>
        ) : (
          <DockerAlert error={result.text} />
        ))}
      {error && <DockerAlert error={error} />}
      {data.error && <DockerAlert error={data.error} />}
      {data.disk.error && <DockerAlert error={`Disk use could not be read: ${data.disk.error}`} />}
      {data.disk.rows.length > 0 && (
        <Disclosure label="Disk usage">
          <table className="docker-ux-disk">
            <caption className="sr-only">Disk use in the engine</caption>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Size</th>
                <th scope="col">Reclaimable</th>
              </tr>
            </thead>
            <tbody>
              {data.disk.rows.map((row) => (
                <tr key={row.type}>
                  <th scope="row">{row.type}</th>
                  <td className="mono">{row.size}</td>
                  <td className="mono">{row.reclaimable}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Disclosure>
      )}
    </section>
  );
}
