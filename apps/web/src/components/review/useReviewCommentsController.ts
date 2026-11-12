import type {
  DiffFile,
  DiffScope,
  PermissionMode,
  Run,
  RunDiffSummary,
  RunReviewState,
} from '@emberline/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { api, errorMessage } from '../../api';
import { requestableComments } from '../../reviewComments';
import { resolveReviewShortcut } from '../../reviewShortcuts';
import { indexCommentCounts, type ReviewTreeFilterMode } from '../../reviewTree';
import { formatAgentDisplayName } from '../RunInspector';
import { commentChipId } from './CommentChip';
import type { CommentDraft } from './CommentComposer';

interface Params {
  run: Run;
  scope: DiffScope;
  setScope: (scope: DiffScope) => void;
  subTab: 'diff' | 'artifacts';
  setSubTab: (tab: 'diff' | 'artifacts') => void;
  summary: RunDiffSummary | null;
  fileDiffPath: string | undefined;
  selectedFile: string | null;
  setSelectedFile: (file: string | null) => void;
  setKeyboardFocusedFile: (file: string | null) => void;
  selectFile: (path: string, viaKeyboard?: boolean) => void;
  visibleOrderedPaths: string[];
  setFilterQuery: (q: string) => void;
  setFilterMode: (m: ReviewTreeFilterMode) => void;
  shortcutSheetOpen: boolean;
  setShortcutSheetOpen: (open: boolean) => void;
  setError: (msg: string | null) => void;
  setGitNotice: (msg: string | null) => void;
  onRunUpdated?: (run: Run) => void;
}

export function useReviewCommentsController({
  run,
  scope,
  setScope,
  subTab,
  setSubTab,
  summary,
  fileDiffPath,
  selectedFile,
  setSelectedFile,
  setKeyboardFocusedFile,
  selectFile,
  visibleOrderedPaths,
  setFilterQuery,
  setFilterMode,
  shortcutSheetOpen,
  setShortcutSheetOpen,
  setError,
  setGitNotice,
  onRunUpdated,
}: Params) {
  const queryClient = useQueryClient();
  const reviewKey = useMemo(() => ['review', run.id] as const, [run.id]);
  const reviewQuery = useQuery({
    queryKey: reviewKey,
    queryFn: () => api<RunReviewState>(`/api/runs/${run.id}/review`),
  });
  const refreshReview = useCallback(
    () => queryClient.invalidateQueries({ queryKey: reviewKey }),
    [queryClient, reviewKey],
  );

  const comments = useMemo(() => reviewQuery.data?.comments ?? [], [reviewQuery.data]);
  const requestable = useMemo(() => requestableComments(comments), [comments]);
  const viewedByPath = useMemo(
    () => new Map((reviewQuery.data?.viewed ?? []).map((v) => [v.filePath, v.signature])),
    [reviewQuery.data],
  );
  const commentIndex = useMemo(() => indexCommentCounts(comments), [comments]);
  const [, navigate] = useLocation();

  const [draft, setDraft] = useState<{ line: number; side: 'modified' | 'original' } | 'file' | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [activeLine, setActiveLine] = useState<{ line: number; side: 'modified' | 'original' } | null>(null);
  const [revealTarget, setRevealTarget] = useState<{
    line: number;
    side: 'modified' | 'original';
    nonce: number;
  } | null>(null);
  const [commentBusy, setCommentBusy] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);

  const resetFileFocus = useCallback(() => {
    setDraft(null);
    setFocusedId(null);
    setActiveLine(null);
    // A jump to a comment is for the file it was made in, not the next one shown.
    setRevealTarget(null);
  }, []);

  const reviewCall = useCallback(
    (request: Promise<unknown>) => {
      setCommentBusy(true);
      return request
        .then(refreshReview)
        .catch((e: unknown) => setError(errorMessage(e)))
        .finally(() => setCommentBusy(false));
    },
    [refreshReview, setError],
  );

  const handleAddComment = useCallback(
    (input: CommentDraft) => {
      if (!selectedFile || !draft) return;
      const where = draft === 'file' ? {} : { line: draft.line, side: draft.side };
      setDraft(null);
      void reviewCall(
        api(`/api/runs/${run.id}/review/comments`, 'POST', { filePath: selectedFile, ...where, ...input }),
      );
    },
    [selectedFile, draft, reviewCall, run.id],
  );

  const patchComment = useCallback(
    (id: string, body: { status?: 'open' | 'resolved'; priority?: 'blocking' | 'important' }) =>
      void reviewCall(api(`/api/runs/${run.id}/review/comments/${id}`, 'PATCH', body)),
    [reviewCall, run.id],
  );

  const handleDeleteComment = useCallback(
    (id: string) => void reviewCall(api(`/api/runs/${run.id}/review/comments/${id}`, 'DELETE')),
    [reviewCall, run.id],
  );

  const handleVerifyCarried = useCallback(
    () => void reviewCall(api(`/api/runs/${run.id}/review/verify-carried`, 'POST')),
    [reviewCall, run.id],
  );

  const handleToggleViewed = useCallback(
    (f: DiffFile, viewed: boolean) => {
      api(`/api/runs/${run.id}/review/viewed`, 'PUT', { filePath: f.path, signature: f.hash, viewed })
        .then(refreshReview)
        .catch((e: unknown) => setError(errorMessage(e)));
    },
    [run.id, refreshReview, setError],
  );

  const handleRequestChanges = useCallback(
    async (note: string, target: 'same' | 'new', permissionMode?: PermissionMode) => {
      const res = await api<{ run: Run; sent: number }>(
        `/api/runs/${run.id}/review/request-changes`,
        'POST',
        {
          note,
          target,
          ...(permissionMode ? { permissionMode } : {}),
        },
      );
      setRequestOpen(false);
      await refreshReview();
      if (target === 'new') {
        navigate(`/runs/${res.run.id}/review`);
        return;
      }
      setGitNotice(`Sent ${res.sent} review comment(s) to ${formatAgentDisplayName(run.agent)}.`);
      onRunUpdated?.(res.run);
    },
    [run.id, run.agent, refreshReview, navigate, setGitNotice, onRunUpdated],
  );

  const jumpToComment = useCallback(
    (commentId: string) => {
      const target = comments.find((c) => c.id === commentId);
      if (!target) return;
      setSubTab('diff');
      setDraft(null);
      const inSummary = summary?.files.some((f) => f.path === target.filePath) ?? false;
      if (inSummary) {
        if (!visibleOrderedPaths.includes(target.filePath)) {
          setFilterQuery('');
          setFilterMode('all');
        }
        setSelectedFile(target.filePath);
        setKeyboardFocusedFile(target.filePath);
      } else if (scope !== 'branch') {
        setScope('branch');
      }
      setFocusedId(target.id);
      if (target.currentLine !== null && target.currentLine !== undefined) {
        setActiveLine({ line: target.currentLine, side: target.side });
        setRevealTarget({ line: target.currentLine, side: target.side, nonce: Date.now() });
      }
    },
    [
      comments,
      setSubTab,
      summary,
      visibleOrderedPaths,
      setFilterQuery,
      setFilterMode,
      setSelectedFile,
      setKeyboardFocusedFile,
      scope,
      setScope,
    ],
  );

  useEffect(() => {
    if (!focusedId) return;
    const el = document.getElementById(commentChipId(focusedId));
    el?.scrollIntoView({ block: 'nearest' });
    el?.focus({ preventScroll: true });
  }, [focusedId, selectedFile, fileDiffPath, subTab]);

  const shortcutStateRef = useRef({
    files: visibleOrderedPaths,
    selectedFile,
    comments,
    focusedCommentId: focusedId,
    activeLine,
    draftOpen: draft !== null,
    shortcutSheetOpen,
    requestOpen,
    subTab,
  });
  shortcutStateRef.current = {
    files: visibleOrderedPaths,
    selectedFile,
    comments,
    focusedCommentId: focusedId,
    activeLine,
    draftOpen: draft !== null,
    shortcutSheetOpen,
    requestOpen,
    subTab,
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const st = shortcutStateRef.current;
      const openDialog = Boolean(document.querySelector('dialog[open]'));
      const action = resolveReviewShortcut(e, {
        files: st.files,
        selectedFile: st.selectedFile,
        comments: st.comments,
        focusedCommentId: st.focusedCommentId,
        activeLine: st.activeLine,
        draftOpen: st.draftOpen,
        shortcutSheetOpen: st.shortcutSheetOpen,
        modalOpen: st.requestOpen || openDialog,
        subTab: st.subTab,
      });
      if (!action) return;
      e.preventDefault();
      switch (action.type) {
        case 'select-file':
          selectFile(action.filePath, true);
          break;
        case 'focus-comment':
          jumpToComment(action.comment.id);
          break;
        case 'open-composer':
          setDraft(action.target);
          break;
        case 'toggle-blocking':
          setFocusedId(action.commentId);
          patchComment(action.commentId, { priority: action.nextPriority });
          break;
        case 'toggle-shortcut-sheet':
          setShortcutSheetOpen(action.open);
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectFile, jumpToComment, patchComment, setShortcutSheetOpen]);

  return {
    reviewData: reviewQuery.data,
    comments,
    requestable,
    viewedByPath,
    commentIndex,
    draft,
    setDraft,
    focusedId,
    setFocusedId,
    setActiveLine,
    revealTarget,
    commentBusy,
    requestOpen,
    setRequestOpen,
    resetFileFocus,
    handleAddComment,
    patchComment,
    handleDeleteComment,
    handleVerifyCarried,
    handleToggleViewed,
    handleRequestChanges,
    jumpToComment,
  };
}
