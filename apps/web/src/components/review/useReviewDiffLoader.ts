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
  const [fileDiff, setFileDiff] = useState<RunFileDiff | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);

  const fileDiffCacheRef = useRef<Map<string, RunFileDiff>>(new Map());
  const inFlightFileRef = useRef<Map<string, Promise<void>>>(new Map());
  const fileReqSeqRef = useRef(0);
  const clearDiffCache = useCallback(() => {
    fileDiffCacheRef.current.clear();
    inFlightFileRef.current.clear();
  }, []);

  const loadFile = useCallback(
    async (path: string, targetScope: DiffScope) => {
      const cacheKey = `${targetScope}:${path}`;
      const cached = fileDiffCacheRef.current.get(cacheKey);
      if (cached) {
        setFileDiff(cached);
        setLoadingFile(false);
        return;
      }
      const existingFlight = inFlightFileRef.current.get(cacheKey);
      if (existingFlight) {
        return existingFlight;
      }
      const reqId = ++fileReqSeqRef.current;
      setLoadingFile(true);
      const task = (async () => {
        try {
          const res = await api<RunFileDiff>(
            `/api/runs/${runId}/diff/file?path=${encodeURIComponent(path)}&scope=${encodeURIComponent(targetScope)}`,
          );
          if (fileDiffCacheRef.current.size >= MAX_DIFF_CACHE) {
            const firstKey = fileDiffCacheRef.current.keys().next().value;
            if (firstKey !== undefined) fileDiffCacheRef.current.delete(firstKey);
          }
          fileDiffCacheRef.current.set(cacheKey, res);
          if (reqId === fileReqSeqRef.current) setFileDiff(res);
        } catch (e) {
          if (reqId === fileReqSeqRef.current) setError(errorMessage(e));
        } finally {
          inFlightFileRef.current.delete(cacheKey);
          if (reqId === fileReqSeqRef.current) setLoadingFile(false);
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
    else setFileDiff(null);
  }, [selectedFile, scope, loadFile]);

  return {
    summary,
    setSummary,
    fileDiff,
    loadingDiff,
    loadingFile,
    clearDiffCache,
    loadSummary,
    loadFile,
  };
}
