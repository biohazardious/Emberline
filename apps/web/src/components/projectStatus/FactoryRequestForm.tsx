import type { Project, WorkspaceDemoTarget } from '@emberline/protocol';
import { FileText, Paperclip, X } from 'lucide-react';
import { type ClipboardEvent, type DragEvent, type FormEvent, useEffect, useRef, useState } from 'react';
import { Disclosure } from '../ui/Disclosure';
import { Switch } from '../ui/Switch';
import { type AttachedFilePreview, formatFileSize, getFactoryExamples } from './projectStatusHelpers';

export function FactoryRequestForm({
  project,
  mainTarget,
  prompt,
  onPromptChange,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  autoDispatch,
  onAutoDispatchChange,
  submitting,
  onSubmitNow,
}: {
  project: Project;
  mainTarget: WorkspaceDemoTarget | undefined;
  prompt: string;
  onPromptChange: (next: string) => void;
  attachments: AttachedFilePreview[];
  onAddFiles: (files: FileList | File[]) => Promise<void>;
  onRemoveAttachment: (id: string) => void;
  autoDispatch: boolean;
  onAutoDispatchChange: (next: boolean) => void;
  submitting: boolean;
  onSubmitNow: () => Promise<void>;
}) {
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 68), 260)}px`;
  }, [prompt]);

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item && item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void onAddFiles(files);
    }
  };

  const handleDrop = (e: DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      void onAddFiles(e.dataTransfer.files);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void onSubmitNow();
  };

  const examples = getFactoryExamples(project, mainTarget);

  return (
    <form
      className={`factory-composer-form${dragOver ? ' factory-composer-form-drag' : ''}`}
      onSubmit={handleSubmit}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
      }}
      onDrop={handleDrop}
    >
      <div className="factory-composer-box">
        {attachments.length > 0 && (
          <div className="factory-attachments-strip">
            {attachments.map((att) => (
              <div key={att.id} className="factory-attachment-chip">
                {att.previewDataUrl ? (
                  <img src={att.previewDataUrl} alt={att.name} className="factory-attachment-thumb" />
                ) : (
                  <span className="factory-attachment-icon">
                    <FileText className="icon" aria-hidden />
                  </span>
                )}
                <div className="factory-attachment-meta">
                  <span className="factory-attachment-name">{att.name}</span>
                  <span className="muted mono factory-attachment-size">{formatFileSize(att.sizeBytes)}</span>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onRemoveAttachment(att.id)}
                  aria-label="Remove attachment"
                >
                  <X className="icon" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          rows={2}
          aria-label="Factory request"
          className="factory-textarea"
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!submitting && (prompt.trim() || attachments.length > 0)) {
                void onSubmitNow();
              }
            }
          }}
          placeholder="Describe a feature, bug fix, or UI change…"
        />

        <div className="factory-composer-foot">
          <div className="factory-composer-controls">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.json,.md,.txt,.csv,.svg,.html,.css,.ts,.tsx,.js,.pdf"
              className="factory-file-input"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  void onAddFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />
            <button type="button" className="btn btn-sm" onClick={() => fileInputRef.current?.click()}>
              <Paperclip className="icon" aria-hidden /> Attach files
              {attachments.length > 0 && <span className="badge mono">{attachments.length}/10</span>}
            </button>
            <Switch checked={autoDispatch} onChange={onAutoDispatchChange} label="Auto-dispatch" />
          </div>

          <button
            type="submit"
            className="btn btn-sm btn-primary"
            disabled={submitting || (!prompt.trim() && attachments.length === 0)}
          >
            {submitting ? 'Sending…' : 'Send to factory'}
          </button>
        </div>
      </div>

      <div className="factory-disclosures-row">
        <Disclosure label="Example prompts">
          <div className="factory-examples-list">
            {examples.map((ex) => (
              <button
                key={ex}
                type="button"
                className="chip-btn factory-example-chip"
                onClick={() => onPromptChange(ex)}
              >
                {ex}
              </button>
            ))}
          </div>
        </Disclosure>

        <Disclosure label="Attachment rules">
          <p className="muted">
            Attach up to 10 files (15 MB each): reference images, mockups, JSON specs, or logs. Paste
            screenshots with <code className="mono">Ctrl+V</code>, drop files onto the box, or press{' '}
            <code className="mono">Shift+Enter</code> for a new line. Product Owner refines the specification
            and creates specialist tickets in dependency order.
          </p>
        </Disclosure>
      </div>
    </form>
  );
}
