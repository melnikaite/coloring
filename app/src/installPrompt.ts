/**
 * Wraps the `beforeinstallprompt` browser event so the gallery can show its
 * own explicit install button instead of relying on the browser's own
 * install heuristics/UI (which some browsers never surface on their own).
 */

type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let deferredEvent: BeforeInstallPromptEvent | null = null;
const listeners = new Set<(available: boolean) => void>();

function notify(available: boolean) {
  listeners.forEach((cb) => cb(available));
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredEvent = event as BeforeInstallPromptEvent;
  notify(true);
});

// Covers installing via the browser's own menu instead of our button.
window.addEventListener('appinstalled', () => {
  deferredEvent = null;
  notify(false);
});

/** Subscribes to install-button availability changes. Returns an unsubscribe fn. */
export function onInstallAvailabilityChange(cb: (available: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Shows the browser's install prompt. No-op if it isn't currently available. */
export async function promptInstall(): Promise<void> {
  const event = deferredEvent;
  if (!event) return;
  await event.prompt();
  await event.userChoice;
  // Once prompted, the browser won't refire beforeinstallprompt until it
  // decides to - treat it as consumed regardless of accept/dismiss.
  deferredEvent = null;
  notify(false);
}
