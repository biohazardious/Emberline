import type { Run, RunDetail } from '@emberline/protocol';
import { KeyRound, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { api } from '../../api';
import { extractFailureDetails, failureFetchNeeded, formatAgentDisplayName } from './runInspectorMeta';
import './run-inspector.css';

export function RunFailureBanner({ run }: { run: Run }) {
  const [detail, setDetail] = useState<RunDetail>();
  const fetchNeeded = failureFetchNeeded(run);

  useEffect(() => {
    if (!fetchNeeded) return;
    let cancelled = false;
    void api<RunDetail>(`/api/runs/${run.id}`)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [run.id, fetchNeeded, run.stateChangedAt]);

  if (!fetchNeeded) return null;

  const { reason, exitCode, needsAuth } = extractFailureDetails(detail?.events ?? [], run.agent);

  return (
    <div className="run-failure-banner" role="alert">
      <div className="run-failure-head">
        <strong className="run-failure-title">
          <TriangleAlert className="icon" aria-hidden /> {formatAgentDisplayName(run.agent)} run failed
          {exitCode !== undefined ? ` (exit code ${exitCode})` : ''}
        </strong>
        {needsAuth && (
          <Link href="/settings" className="btn btn-sm run-failure-auth-link">
            <KeyRound className="icon" aria-hidden /> Configure auth
          </Link>
        )}
      </div>
      <pre className="mono run-failure-reason">{reason}</pre>
    </div>
  );
}
