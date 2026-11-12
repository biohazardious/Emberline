export interface DisposableTextModel {
  getValue(): string;
  setValue(newValue: string): void;
  getLanguageId(): string;
  dispose(): void;
}

export interface MonacoModelApi<M extends DisposableTextModel = DisposableTextModel> {
  createModel(value: string, language?: string): M;
  setModelLanguage(model: M, languageId: string): void;
}

export interface DiffModelPair<M extends DisposableTextModel = DisposableTextModel> {
  key: string;
  original: M;
  modified: M;
}

/**
 * Lazily creates `{ original, modified }` Monaco text models on demand for the currently viewed
 * file and bounds resident model pairs with an LRU cache so opening or traversing a 300-file diff
 * never freezes the main thread or leaks memory.
 */
export class LazyMonacoModelPool<M extends DisposableTextModel = DisposableTextModel> {
  private readonly cache = new Map<string, DiffModelPair<M>>();
  private activeKey: string | null = null;
  private createdPairs = 0;

  constructor(
    private readonly editorApi: MonacoModelApi<M>,
    private readonly maxEntries = 12,
  ) {}

  get size(): number {
    return this.cache.size;
  }

  get totalCreatedPairs(): number {
    return this.createdPairs;
  }

  acquire(
    key: string,
    input: { original: string; modified: string; language: string },
    onBeforeEvict?: () => void,
  ): DiffModelPair<M> {
    this.activeKey = key;
    const existing = this.cache.get(key);
    if (existing) {
      this.cache.delete(key);
      this.cache.set(key, existing);
      if (existing.original.getValue() !== input.original) {
        existing.original.setValue(input.original);
      }
      if (existing.modified.getValue() !== input.modified) {
        existing.modified.setValue(input.modified);
      }
      if (existing.original.getLanguageId() !== input.language) {
        this.editorApi.setModelLanguage(existing.original, input.language);
      }
      if (existing.modified.getLanguageId() !== input.language) {
        this.editorApi.setModelLanguage(existing.modified, input.language);
      }
      return existing;
    }

    if (this.cache.size >= this.maxEntries) {
      this.evictOldest(onBeforeEvict);
    }

    const pair: DiffModelPair<M> = {
      key,
      original: this.editorApi.createModel(input.original, input.language),
      modified: this.editorApi.createModel(input.modified, input.language),
    };
    this.createdPairs += 1;
    this.cache.set(key, pair);
    return pair;
  }

  private evictOldest(onBeforeEvict?: () => void): void {
    for (const [candidateKey, pair] of this.cache) {
      if (candidateKey === this.activeKey && this.cache.size > 1) continue;
      if (candidateKey === this.activeKey) onBeforeEvict?.();
      this.cache.delete(candidateKey);
      pair.original.dispose();
      pair.modified.dispose();
      return;
    }
  }

  disposeAll(onBeforeDispose?: () => void): void {
    onBeforeDispose?.();
    for (const pair of this.cache.values()) {
      pair.original.dispose();
      pair.modified.dispose();
    }
    this.cache.clear();
    this.activeKey = null;
  }
}
