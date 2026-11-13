import { posix } from "node:path";
import { vi } from "vitest";

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
    readonly fragment = "",
  ) {}

  static file(path: string): Uri {
    return new Uri("file", path);
  }

  static parse(value: string): Uri {
    const parts = /^([a-z-]+):\/\/(.*)$/u.exec(value);
    return parts ? new Uri(parts[1]!, parts[2]!) : new Uri("file", value);
  }

  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, posix.join(base.path, ...parts));
  }

  with(change: { scheme?: string; path?: string; fragment?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.path ?? this.path, change.fragment ?? this.fragment);
  }

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}://${this.path}${this.fragment ? `#${this.fragment}` : ""}`;
  }
}

export class RelativePattern {
  constructor(
    readonly base: unknown,
    readonly pattern: string,
  ) {}
}

type Handler<T> = (event: T) => unknown;

export class EventEmitter<T> {
  private handlers: Handler<T>[] = [];

  event = (listener: Handler<T>, _thisArg?: unknown, bucket?: Array<{ dispose(): void }>) => {
    this.handlers.push(listener);
    const handle = { dispose: () => void this.handlers.splice(this.handlers.indexOf(listener), 1) };
    bucket?.push(handle);
    return handle;
  };

  fire = (data: T) => {
    this.handlers.slice().forEach((listener) => listener(data));
  };

  dispose = () => {
    this.handlers = [];
  };
}

export interface FakeWatcher {
  onDidChange: EventEmitter<Uri>["event"];
  onDidCreate: EventEmitter<Uri>["event"];
  fireChange: (uri: Uri) => void;
  fireCreate: (uri: Uri) => void;
  dispose: ReturnType<typeof vi.fn>;
}

/** Everything recorded here is cleared by resetMock(). */
export const watchers: FakeWatcher[] = [];
export const files = new Map<string, Uint8Array>();
export const configuration = new Map<string, unknown>();
export const shownErrors: string[] = [];
export const shownWarnings: string[] = [];
export const openedExternally: Uri[] = [];
export const executedCommands: Array<{ command: string; args: unknown[] }> = [];
export const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: vi.fn((key: string, fallback?: unknown) => (configuration.has(key) ? configuration.get(key) : fallback)),
    update: vi.fn(async (key: string, value: unknown, _target?: number) => void configuration.set(key, value)),
  })),
  createFileSystemWatcher: vi.fn((): FakeWatcher => {
    const changed = new EventEmitter<Uri>();
    const created = new EventEmitter<Uri>();
    const watcher: FakeWatcher = {
      onDidChange: changed.event,
      onDidCreate: created.event,
      fireChange: changed.fire,
      fireCreate: created.fire,
      dispose: vi.fn(),
    };
    watchers.push(watcher);
    return watcher;
  }),
  fs: {
    readFile: vi.fn(async (uri: Uri) => {
      const content = files.get(uri.toString());
      if (content === undefined) {
        throw new Error(`ENOENT ${uri.toString()}`);
      }
      return content;
    }),
    writeFile: vi.fn(async (uri: Uri, content: Uint8Array) => void files.set(uri.toString(), content)),
    delete: vi.fn(async (uri: Uri) => void files.delete(uri.toString())),
  },
};

export const window = {
  registerCustomEditorProvider: vi.fn(() => ({ dispose: vi.fn() })),
  setStatusBarMessage: vi.fn(() => ({ dispose: vi.fn() })),
  showErrorMessage: vi.fn(async (message: string) => void shownErrors.push(message)),
  showWarningMessage: vi.fn(async (message: string) => void shownWarnings.push(message)),
  /** Answers with `quickPick.choose(items)`; by default nothing is picked. */
  showQuickPick: vi.fn(async <T>(items: T[], _options?: unknown) => quickPick.choose(items) as T | undefined),
  /** Cancelled unless a test answers it. */
  showSaveDialog: vi.fn(async (_options?: unknown): Promise<Uri | undefined> => undefined),
};

export const quickPick: { choose: (items: unknown[]) => unknown } = { choose: () => undefined };

export const env = {
  openExternal: vi.fn(async (uri: Uri) => void openedExternally.push(uri)),
};

export const commands = {
  registerCommand: vi.fn((command: string, callback: (...args: unknown[]) => unknown) => {
    registeredCommands.set(command, callback);
    return { dispose: vi.fn() };
  }),
  executeCommand: vi.fn(async (command: string, ...args: unknown[]) => void executedCommands.push({ command, args })),
};

export class CancellationTokenSource {
  readonly token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
  cancel(): void {
    this.token.isCancellationRequested = true;
  }
  dispose = vi.fn();
}

// --- Language models and chat -------------------------------------------------------------

export class LanguageModelChatMessage {
  constructor(
    readonly role: "user" | "assistant",
    readonly content: string,
  ) {}
  static User(content: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage("user", content);
  }
  static Assistant(content: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage("assistant", content);
  }
}

export class LanguageModelError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
  static NoPermissions(message = ""): LanguageModelError {
    return new LanguageModelError(message, "NoPermissions");
  }
  static Blocked(message = ""): LanguageModelError {
    return new LanguageModelError(message, "Blocked");
  }
  static NotFound(message = ""): LanguageModelError {
    return new LanguageModelError(message, "NotFound");
  }
}

/** A chat model that replays `answer`'s chunks, or throws it when given an error. */
export function fakeModel(answer: string[] | Error, maxInputTokens = 64_000, meta = { id: "gpt-x", name: "GPT X", family: "gpt", vendor: "copilot" }) {
  return {
    ...meta,
    maxInputTokens,
    sendRequest: vi.fn(async (_messages: LanguageModelChatMessage[], _options: unknown, _token: unknown) => {
      if (answer instanceof Error) {
        throw answer;
      }
      return { text: (async function* () { yield* answer; })() };
    }),
  };
}

export const languageModels: Array<ReturnType<typeof fakeModel>> = [];
export const lm = { selectChatModels: vi.fn(async (_selector: unknown) => [...languageModels]) };

export class ChatRequestTurn {
  constructor(
    readonly prompt: string,
    readonly command: string | undefined,
    readonly participant: string,
  ) {}
}

export class ChatResponseMarkdownPart {
  readonly value: { value: string };
  constructor(value: string) {
    this.value = { value };
  }
}

export class ChatResponseTurn {
  constructor(
    readonly response: unknown[],
    readonly participant: string,
  ) {}
}

export const chatHandlers = new Map<string, (...args: unknown[]) => unknown>();
export const chat = {
  createChatParticipant: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
    chatHandlers.set(id, handler);
    return { dispose: vi.fn() };
  }),
};

/** Forget everything recorded so far. */
export function resetMock(): void {
  const drain = (list: { length: number }) => (list.length = 0);
  drain(watchers);
  drain(shownErrors);
  drain(shownWarnings);
  drain(openedExternally);
  drain(executedCommands);
  drain(languageModels);
  files.clear();
  configuration.clear();
  quickPick.choose = () => undefined;
  registeredCommands.clear();
  chatHandlers.clear();
}
