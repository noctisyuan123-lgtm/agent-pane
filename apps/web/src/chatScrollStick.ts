/**
 * Live stream keeps the chat pinned to the bottom. Expanding a process fold
 * (L1 pack / Worked-for / tool details) must release that pin so the user
 * is not yanked to the latest thinking bubble.
 */

type Handler = () => void;

let releaseHandler: Handler | null = null;

export function registerChatStickRelease(handler: Handler | null): void {
  releaseHandler = handler;
}

/** Call from fold / details UI when the user intentionally expands or collapses trail. */
export function releaseChatStickForInspect(): void {
  releaseHandler?.();
}
