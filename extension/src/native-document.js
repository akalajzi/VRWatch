// webNavigation deliberately omits chrome-extension: pages in Chromium.
// Only our active top-level extension document can use native ownership instead.
// Both identities below come from browser APIs, never request payload fields.
export function currentNativeDocument(owned, sender, frame, extensionRoot) {
  if (!sender.documentId) return false;
  if (frame) return frame.documentId === sender.documentId && !frame.errorOccurred;
  return sender.frameId === 0 && sender.tab?.id === owned.activeTabId &&
    sender.documentId === owned.documentId && typeof sender.url === 'string' &&
    sender.url.startsWith(extensionRoot);
}
