import type { Run, RunDetail, RunEvent } from '@emberline/protocol';
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { api } from '../../api';
import { completionEventText } from '../../completionSignal';
import { EVENT_LABEL } from '../../runEventLabels';
import { timeAgo } from '../../time';
import {
  BuildOutputsList,
  ConflictEventDetail,
  conflictEventInfo,
  ExpandableText,
  FinalAnswer,
  LastScreen,
} from '../RunOutcome';
import { RunStatePill } from '../RunStatePill';
import { Disclosure } from '../ui/Disclosure';
import { droppedDependencyText, handoffTarget, payloadSummary } from './runInspectorMeta';
import './run-inspector.css';

function hasEventPayload(payload: unknown): boolean {
  return Boolean(payload && typeof payload === 'object' && Object.keys(payload as object).length > 0);
}

export function RunEventTimeline({ run }: { run: Run }) {
  const [detail, setDetail] = useState<RunDetail>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api<RunDetail>(`/api/runs/${run.id}`)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [run.id, run.state, run.stateChangedAt, run.lastEvent]);

  // The saved last screen is shown on its own above the timeline, not as an entry in it.
  const events: RunEvent[] = (detail?.events ?? []).filter((e) => e.type !== 'last_screen');

  if (loading && events.length === 0) {
    return <p className="muted small">Loading activity timeline…</p>;
  }

  if (events.length === 0) {
    return <p className="muted small">No events recorded yet.</p>;
  }

  return (
    <>
      {detail?.finalMessage && (run.state === 'done' || run.state === 'failed' || run.endedAt) && (
        <FinalAnswer text={detail.finalMessage} />
      )}
      <BuildOutputsList runId={run.id} refreshKey={run.stateChangedAt} />
      {detail?.lastScreen && !run.terminalId && <LastScreen text={detail.lastScreen} />}
      <section className="dock-section" aria-label="Activity">
        <div className="dock-section-head">
          <span className="eyebrow">Activity</span>
        </div>
        <ol className="event-timeline" aria-label="Agent event timeline">
          {[...events].reverse().map((ev) => {
            const summary = payloadSummary(ev.payload);
            const tool = summary.tool;
            const conflict = conflictEventInfo(ev.type, ev.payload);
            const dropped = ev.type === 'dependency_dropped' ? droppedDependencyText(ev.payload) : undefined;
            const text = dropped ?? completionEventText(ev.type, ev.payload) ?? summary.detail;
            return (
              <li key={ev.id} className={`event-item event-src-${ev.source}`}>
                <div className="event-head">
                  <span className="event-type mono">{EVENT_LABEL[ev.type] ?? ev.type}</span>
                  {handoffTarget(ev) && (
                    <Link href={`/runs/${handoffTarget(ev)}/review`} className="badge badge-soft mono">
                      run {handoffTarget(ev)?.slice(0, 8)} →
                    </Link>
                  )}
                  {tool && <span className="badge badge-soft mono">{tool}</span>}
                  {ev.state && <RunStatePill state={ev.state} />}
                  <span className="event-time mono">{timeAgo(ev.ts)}</span>
                </div>
                {conflict ? <ConflictEventDetail info={conflict} /> : text && <ExpandableText text={text} />}
                {hasEventPayload(ev.payload) && (
                  <Disclosure label="Payload">
                    <pre className="event-payload mono">{JSON.stringify(ev.payload, null, 2)}</pre>
                  </Disclosure>
                )}
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}
