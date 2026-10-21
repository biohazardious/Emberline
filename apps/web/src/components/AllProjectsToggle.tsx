import { ALL_PROJECTS_LABEL, moreInOtherProjects } from '../projectScope';

export function AllProjectsToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className={`btn btn-sm${on ? ' btn-primary' : ''}`}
      aria-pressed={on}
      onClick={() => onChange(!on)}
    >
      {ALL_PROJECTS_LABEL}
    </button>
  );
}

/** "N more in other projects" as a link-style button that turns "All projects" on; nothing for 0. */
export function MoreInOtherProjects({ count, onShow }: { count: number; onShow: () => void }) {
  const text = moreInOtherProjects(count);
  if (!text) return null;
  return (
    <p className="muted small scope-more">
      <button type="button" className="link-btn" onClick={onShow}>
        {text}
      </button>
    </p>
  );
}
