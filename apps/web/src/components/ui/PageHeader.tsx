import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, meta, actions, icon, children, className }: PageHeaderProps) {
  return (
    <header className={`ui-page-header${className ? ` ${className}` : ''}`}>
      <div className="ui-page-header-bar">
        <div className="ui-page-header-main">
          <div className="ui-page-header-title-row">
            {icon && (
              <span className="ui-page-header-icon" aria-hidden="true">
                {icon}
              </span>
            )}
            <h1 className="ui-page-title">{title}</h1>
            {meta && <div className="ui-page-meta">{meta}</div>}
          </div>
          {subtitle && <p className="ui-page-subtitle muted">{subtitle}</p>}
        </div>
        {actions && <div className="ui-page-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
