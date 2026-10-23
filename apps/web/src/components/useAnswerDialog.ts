/** The Answer dialog's state and requests; `AnswerDialog` renders it through `AnswerDialogView`. */
import type {
  AnswerRequest,
  AnswerResponse,
  Run,
  RunQuestion,
  SuggestAnswerResponse,
} from '@emberline/protocol';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import { addAnswerFiles, answerErrorText, clearDraft, loadDraft, saveDraft } from '../answerDialog';
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
  const [text, setTextState] = useState(() => initialText ?? loadDraft(run.id));
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

  const question = query.data ?? null;
  const questionError = query.error ? errorText(query.error) : null;

  // Every change is the draft, so closing the dialog never loses typed text.
  const setText = (v: string) => {
    textNow.current = v;
    setTextState(v);
    saveDraft(run.id, v);
  };

  const post = async (body: AnswerRequest) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<AnswerResponse>(`/api/runs/${run.id}/answer`, 'POST', body);
      clearDraft(run.id);
      toastInfo(res.delivery === 'picker' ? 'Answer sent.' : `${deliveryNote(res.delivery)}.`);
      onSent?.();
      onClose();
    } catch (e) {
      setError(errorText(e, (body.attachments?.length ?? 0) > 0));
      setBusy(false);
    }
  };

  const send = async () => {
    let attachments;
    try {
      attachments = await encodeMaterials(files);
    } catch (e) {
      setError(errorText(e));
      return;
    }
    await post({ text: text.trim(), attachments });
  };

  // With Claude's picker open a chip answers it; otherwise it only fills the box.
  const chooseOption = (i: number) => {
    const option = question?.options[i];
    if (!question || !option) return;
    if (question.picker) void post({ option: i });
    else setText(option.label);
  };

  const suggest = async () => {
    setSuggesting(true);
    setError(null);
    try {
      const { answer } = await api<SuggestAnswerResponse>(`/api/runs/${run.id}/question/suggest`, 'POST');
      if (textNow.current.trim()) setPending(answer);
      else setText(answer);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSuggesting(false);
    }
  };

  const addFiles = (list: FileList | File[]) => {
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
    if (action === 'close') onClose();
    else if (action === 'confirm') setConfirmClose(true);
    else keepEditing();
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
    onKeepAnswer: () => setPending(null),
    onFiles: addFiles,
    onRemoveFile: (id: string) => {
      setFiles(files.filter((f) => f.id !== id));
      setProblems([]);
    },
    onSend: () => void send(),
    onDismiss: dismiss,
    onKeepEditing: keepEditing,
  };
}
