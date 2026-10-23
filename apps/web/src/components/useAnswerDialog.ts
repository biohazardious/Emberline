/** The Answer dialog's state and requests; `AnswerDialog` renders it through `AnswerDialogView`. */
import type {
  AnswerRequest,
  AnswerResponse,
  Run,
  RunQuestion,
  SuggestAnswerResponse,
} from '@emberline/protocol';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import {
  addAnswerFiles,
  answerErrorText,
  chipAnswers,
  clearDraft,
  saveDraft,
  startText,
  suggestionAction,
} from '../answerDialog';
import { deliveryNote } from '../holdRecovery';
import { escapeDraft } from '../reviewComments';
import { toastInfo } from '../toast';
import { encodeMaterials, materialsErrorMessage, type WizardMaterial } from './wizard/materials';

const errorText = (e: unknown, filesSent = false): string =>
  materialsErrorMessage(e, filesSent) ??
  (e instanceof ApiRequestError ? answerErrorText(e.code, errorMessage(e)) : errorMessage(e));

export interface AnswerDialogOptions {
  run: Run;
  initialText?: string;
  onClose: () => void;
  onSent?: () => void;
}

export function useAnswerDialog({ run, initialText, onClose, onSent }: AnswerDialogOptions) {
  const query = useQuery({
    queryKey: ['run-question', run.id],
    queryFn: () => api<RunQuestion>(`/api/runs/${run.id}/question`),
    retry: false,
  });
  const [text, setTextState] = useState(() => startText(initialText, run.id));
  // The latest text for a suggestion that arrives after the person typed on.
  const textNow = useRef(text);
  const [files, setFiles] = useState<WizardMaterial[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A suggestion waiting for Replace / Keep because the box already had an answer.
  const [pending, setPending] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // Set once the dialog closes or the answer went out: late results must not write a draft for the next open.
  const closed = useRef(false);
  // A second click before React re-renders must not send twice.
  const sending = useRef(false);
  // Reset on mount too: StrictMode mounts, unmounts and mounts again in development.
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
    };
  }, []);

  const close = () => {
    closed.current = true;
    onClose();
  };

  const question = query.data ?? null;
  const questionError = query.error ? errorText(query.error) : null;

  // Every change is the draft, so closing the dialog never loses typed text.
  const setText = (v: string) => {
    textNow.current = v;
    setTextState(v);
    saveDraft(run.id, v);
  };

  // Busy from the first moment, so reading large files does not leave Send and the chips clickable.
  const post = async (body: () => Promise<AnswerRequest>) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    let filesSent = false;
    try {
      const request = await body();
      filesSent = (request.attachments?.length ?? 0) > 0;
      const res = await api<AnswerResponse>(`/api/runs/${run.id}/answer`, 'POST', request);
      closed.current = true;
      clearDraft(run.id);
      toastInfo(res.delivery === 'picker' ? 'Answer sent.' : `${deliveryNote(res.delivery)}.`);
      onSent?.();
      onClose();
    } catch (e) {
      setError(errorText(e, filesSent));
      setBusy(false);
    } finally {
      sending.current = false;
    }
  };

  const send = () => post(async () => ({ text: text.trim(), attachments: await encodeMaterials(files) }));

  // A chip answers Claude's picker by its number when core says the numbers match; otherwise it
  // only fills the box (Send then cancels the picker and types the text).
  const chooseOption = (i: number) => {
    const option = question?.options[i];
    if (!question || !option) return;
    if (chipAnswers(question)) void post(async () => ({ option: i }));
    else setText(option.label);
  };

  const suggest = async () => {
    setSuggesting(true);
    setError(null);
    try {
      const { answer } = await api<SuggestAnswerResponse>(`/api/runs/${run.id}/question/suggest`, 'POST');
      const action = suggestionAction(closed.current, textNow.current);
      if (action === 'ask') setPending(answer);
      else if (action === 'fill') setText(answer);
    } catch (e) {
      if (!closed.current) setError(errorText(e));
    } finally {
      if (!closed.current) setSuggesting(false);
    }
  };

  const addFiles = (list: FileList | File[]) => {
    if (sending.current || question?.kind === 'permission') return;
    const { added, problems: refused } = addAnswerFiles(
      files,
      [...list].map((f) => ({ file: f, name: f.name })),
    );
    setFiles([...files, ...added]);
    setProblems(refused);
  };

  const keepEditing = () => {
    setConfirmClose(false);
    textRef.current?.focus();
  };

  // Escape or a click outside asks first while there is an answer or files; the text stays a draft either way.
  const dismiss = () => {
    const action = escapeDraft(text.trim() || files.length > 0 ? 'draft' : '', confirmClose);
    if (action === 'close') close();
    else if (action === 'confirm') setConfirmClose(true);
    else keepEditing();
  };

  // Cancel and the close button: the text is a draft already, so only attached files make it ask.
  const cancel = () => {
    if (files.length > 0) setConfirmClose(true);
    else close();
  };

  return {
    question,
    loading: query.isPending,
    text,
    files,
    problems,
    busy,
    suggesting,
    error: error ?? questionError,
    confirmReplace: pending !== null,
    confirmClose,
    textRef,
    onText: setText,
    onOption: chooseOption,
    onSuggest: () => void suggest(),
    onReplace: () => {
      if (pending !== null) setText(pending);
      setPending(null);
      textRef.current?.focus();
    },
    onKeepAnswer: () => {
      setPending(null);
      textRef.current?.focus();
    },
    onFiles: addFiles,
    onRemoveFile: (id: string) => {
      if (sending.current) return;
      setFiles(files.filter((f) => f.id !== id));
      setProblems([]);
    },
    onSend: () => void send(),
    onCancel: cancel,
    onConfirmClose: close,
    onClose: close,
    onDismiss: dismiss,
    onKeepEditing: keepEditing,
  };
}
