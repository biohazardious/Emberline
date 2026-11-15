import { type ReactNode, useId } from 'react';
import { Disclosure } from './Disclosure';

export interface SettingRowProps {
  label: ReactNode;
  summary?: ReactNode;
  details?: ReactNode;
  detailsLabel?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  htmlFor?: string;
  className?: string;
}

export function SettingRow({
  label,
  summary,
  details,
  detailsLabel,
  control,
  children,
  htmlFor,
  className,
}: SettingRowProps) {
  const labelId = useId();
  const summaryId = useId();
  const controlSlot = control ?? children;

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={summary ? summaryId : undefined}
      className={`ui-setting-row${className ? ` ${className}` : ''}`}
    >
      <div className="ui-setting-main">
        <div className="ui-setting-copy">
          {htmlFor ? (
            <label id={labelId} htmlFor={htmlFor} className="ui-setting-label">
              {label}
            </label>
          ) : (
            <div id={labelId} className="ui-setting-label">
              {label}
            </div>
          )}
          {summary && (
            <p id={summaryId} className="ui-setting-summary muted">
              {summary}
            </p>
          )}
        </div>
        {controlSlot && <div className="ui-setting-control">{controlSlot}</div>}
      </div>
      {details && <Disclosure label={detailsLabel}>{details}</Disclosure>}
    </div>
  );
}
