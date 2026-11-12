import type { DiffScope, RunDiffSummary, RunFileDiff } from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import { buildReviewTree, orderedTreeFiles } from '../../reviewTree';

const EMPTY_COUNTS = new Map<string, { open: number; blocking: number }>();
const EMPTY_VIEWED = new Map<string, string>();
const MAX_DIFF_CACHE = 30;

export function useReviewDiffLoader(params: {
  runId: string;
  scope: DiffScope;
  selectedFile: string | null;
  setSelectedFile: (updater: (prev: string | null) => string | null) => void;
  setError: (msg: string | null) => void;
}) {
  const { runId, scope, selectedFile, setSelectedFile, setError } = params;
  const queryClient = useQueryClient();
  const [summary, setSummary] = useState<RunDiffSummary | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; diff: RunFileDiff } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  const fileDiffCacheRef = useRef<Map<string, RunFileDiff>>(new Map());
  const inFlightFileRef = useRef<Map<string, Promise<void>>>(new Map());
  // A response reaches the pane only while its file is still the selected one, so a late answer
  // for a file the reviewer has already moved past never replaces the current one.
  const selectedKey = selectedFile ? `${scope}:${selectedFile}` : null;
  const selectedKeyRef = useRef(selectedKey);
  selectedKeyRef.current = selectedKey;
  const clearDiffCache = useCallback(() => {
    fileDiffCacheRef.current.clear();
    inFlightFileRef.current.clear();
  }, []);

  const loadFile = useCallback(
    async (path: string, targetScope: DiffScope) => {
      const cacheKey = `${targetScope}:${path}`;
      const isSelected = () => selectedKeyRef.current === cacheKey;
      const cached = fileDiffCacheRef.current.get(cacheKey);
      if (cached) {
        if (isSelected()) setLoaded({ key: cacheKey, diff: cached });
        return;
      }
      const existingFlight = inFlightFileRef.current.get(cacheKey);
      if (existingFlight) return existingFlight;
      setFailedKey((prev) => (prev === cacheKey ? null : prev));
      // A cleared cache (a refresh, a stage toggle) orphans this flight: its answer may predate the
      // change, so it is not cached, and it is dropped once a newer flight or answer exists.
      const isCurrentFlight = () => inFlightFileRef.current.get(cacheKey) === task;
      const isSuperseded = () =>
        !isCurrentFlight() &&
        (inFlightFileRef.current.has(cacheKey) || fileDiffCacheRef.current.has(cacheKey));
      const task = (async () => {
        try {
          const res = await api<RunFileDiff>(
            `/api/runs/${runId}/diff/file?path=${encodeURIComponent(path)}&scope=${encodeURIComponent(targetScope)}`,
          );
          if (isSuperseded()) return;
          if (isCurrentFlight()) {
            if (fileDiffCacheRef.current.size >= MAX_DIFF_CACHE) {
              const firstKey = fileDiffCacheRef.current.keys().next().value;
              if (firstKey !== undefined) fileDiffCacheRef.current.delete(firstKey);
            }
            fileDiffCacheRef.current.set(cacheKey, res);
          }
          if (isSelected()) setLoaded({ key: cacheKey, diff: res });
        } catch (e) {
          if (isSuperseded()) return;
          setFailedKey(cacheKey);
          if (isSelected()) setError(errorMessage(e));
        } finally {
          if (isCurrentFlight()) inFlightFileRef.current.delete(cacheKey);
        }
      })();
      inFlightFileRef.current.set(cacheKey, task);
      return task;
    },
    [runId, setError],
  );

  const loadSummary = useCallback(
    async (targetScope: DiffScope, keepSelection = true) => {
      setLoadingDiff(true);
      setError(null);
      fileDiffCacheRef.current.clear();
      inFlightFileRef.current.clear();
      try {
        const queryKey = ['diff-summary', runId, targetScope] as const;
        const prefetched = !keepSelection ? queryClient.getQueryData<RunDiffSummary>(queryKey) : undefined;
        const res =
          prefetched ??
          (await queryClient.fetchQuery<RunDiffSummary>({
            queryKey,
            queryFn: () =>
              api<RunDiffSummary>(`/api/runs/${runId}/diff?scope=${encodeURIComponent(targetScope)}`),
            staleTime: 0,
          }));
        setSummary(res);
        const treeOrder = orderedTreeFiles(buildReviewTree(res.files, EMPTY_COUNTS, EMPTY_VIEWED));
        const defaultFirst = treeOrder[0]?.path ?? null;
        if (!keepSelection && defaultFirst) {
          void loadFile(defaultFirst, targetScope);
        }
        setSelectedFile((prev) => {
          if (keepSelection && prev && res.files.some((f) => f.path === prev)) return prev;
          return defaultFirst;
        });
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoadingDiff(false);
      }
    },
    [runId, queryClient, loadFile, setError, setSelectedFile],
  );

  useEffect(() => {
    void loadSummary(scope, false);
  }, [scope, loadSummary]);

  useEffect(() => {
    if (selectedFile) void loadFile(selectedFile, scope);
  }, [selectedFile, scope, loadFile]);

  // A diff already fetched is served on the render that selects its file, not an effect later.
  const fileDiff =
    selectedKey === null
      ? null
      : loaded?.key === selectedKey
        ? loaded.diff
        : (fileDiffCacheRef.current.get(selectedKey) ?? null);
  const loadingFile = selectedKey !== null && fileDiff === null && failedKey !== selectedKey;

  return {
    summary,
    setSummary,
    /** The diff of the selected file, or null while it loads (or when its load failed). */
    fileDiff,
    loadingDiff,
    loadingFile,
    clearDiffCache,
    loadSummary,
    loadFile,
  };
}
