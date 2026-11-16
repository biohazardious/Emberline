import type { Project } from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { ProjectDeleteConfirm } from '../ProjectDeleteConfirm';

export function ProjectDangerSection({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [confirming, setConfirming] = useState(false);

  return (
    <section
      className="project-settings-section project-settings-section-danger"
      aria-labelledby="project-danger-title"
    >
      <div className="project-settings-section-head">
        <h3 id="project-danger-title" className="project-settings-section-title">
          Danger zone
        </h3>
        {!confirming && (
          <button type="button" className="btn btn-sm danger" onClick={() => setConfirming(true)}>
            Remove project
          </button>
        )}
      </div>
      {confirming && (
        <ProjectDeleteConfirm
          project={project}
          onCancel={() => setConfirming(false)}
          onDeleted={async (res) => {
            await queryClient.invalidateQueries({ queryKey: ['api', '/api/projects'] });
            navigate(res.nextActiveProjectId ? `/projects/${res.nextActiveProjectId}/board` : '/');
          }}
        />
      )}
    </section>
  );
}
