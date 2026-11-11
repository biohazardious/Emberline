import type { ImportStatusResponse, Project, ProjectSshKeyResponse } from '@emberline/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api } from '../api';
import { unfinishedImport, unfinishedImportUrl } from '../sshKeys';
import { ImportProgress } from './wizard/ImportProgress';

/**
 * Whether `project` is an import left unfinished (it waits for its own key, or its ssh clone
 * failed). The status is read only while core's project list calls the import unfinished
 * (`importUnfinished`, Ruling 24), never for a finished one; a failed read (runner down) shows nothing.
 */
function useUnfinishedImport(project: Project) {
  const url = unfinishedImportUrl(project);
  const query = useQuery({
    queryKey: ['api', url],
    queryFn: () => api<ImportStatusResponse>(url!),
    enabled: url !== null,
    refetchInterval: 120_000,
  });
  return unfinishedImport(project, url ? query.data : undefined);
}

/**
 * Project settings → Repository, for an import the wizard left unfinished (Ruling 23): the import's
 * own progress view (the project's public key with Copy and the deploy-key hint, Clone now, the
 * fixes for an ssh failure, Try again), and removing the project (asked first). Try again always
 * clones into this project: a folder a failed clone left is explained, the project never removed.
 */
export function ImportRecovery({ project }: { project: Project }) {
  const state = useUnfinishedImport(project);
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  // Shown from the first unfinished answer until the clone is done or the project removed:
  // a status read in between (cloning) must not unmount the progress.
  const [shownAs, setShownAs] = useState<'awaiting_key' | 'failed' | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (state) setShownAs((current) => current ?? state);
  }, [state]);
  const shown = shownAs !== null;
  // Try again's fallback (a fresh clone) keeps the project's own key choice.
  const keys = useQuery({
    queryKey: ['api', `/api/projects/${project.id}/ssh-key`],
    queryFn: () => api<ProjectSshKeyResponse>(`/api/projects/${project.id}/ssh-key`),
    enabled: shown,
  });

  const refreshProject = () => {
    void queryClient.invalidateQueries({ queryKey: ['api', '/api/projects'] });
    void queryClient.invalidateQueries({ queryKey: ['api', `/api/projects/${project.id}/repository`] });
    void queryClient.invalidateQueries({ queryKey: ['api', '/api/system'] });
  };

  if (done)
    return (
      <p className="banner banner-ok" role="status">
        The repository is cloned.
      </p>
    );
  if (!shown) return null;
  return (
    <section className="import-recovery" aria-labelledby="import-recovery-title">
      <h4 id="import-recovery-title">The import is not finished</h4>
      <p className="muted small">
        {shownAs === 'awaiting_key'
          ? 'This project has its own key, and its clone waits until the key is on the repository. Clone it here, or remove the project.'
          : "This project's clone failed. Clone it again here, or remove the project."}
      </p>
      <ImportProgress
        source="import_url"
        projectId={project.id}
        createBody={{
          name: project.name,
          source: 'import_url',
          repoUrl: project.repoUrl ?? '',
          ...(keys.data?.choice === 'own' ? { sshKeyChoice: 'own' as const } : {}),
        }}
        keepProject
        confirmCancel={`Remove ${project.name}? Its folder goes too${
          // Only a key the project holds (read, and there) is named (Ruling 28).
          keys.data?.key ? ", with its own SSH key (remove it from the repository's deploy keys too)" : ''
        }.`}
        onDetected={() => {
          setDone(true);
          refreshProject();
        }}
        onRecreated={(id) => {
          refreshProject();
          navigate(`/projects/${id}/settings`);
        }}
        onCancelled={() => {
          refreshProject();
          navigate('/');
        }}
      />
    </section>
  );
}

/** On the project's main page: an unfinished import, and where to finish it. */
export function UnfinishedImportNote({ project }: { project: Project }) {
  const state = useUnfinishedImport(project);
  if (!state) return null;
  return (
    <div className="banner banner-warn" role="status">
      The import of {project.name} is not finished:{' '}
      {state === 'awaiting_key'
        ? 'its clone waits for its SSH key to be added to the repository.'
        : 'its clone failed.'}{' '}
      <Link href={`/projects/${project.id}/settings`}>Finish it in Project settings → Repository</Link>.
    </div>
  );
}
