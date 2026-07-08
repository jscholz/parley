export function chatLabelFor(chatId: string): string {
  const stripped = chatId.replace(/^sidekick:/, '');
  return stripped.length > 12 ? stripped.slice(0, 12) + '…' : stripped;
}

export function formatRelativeTime(ts: number): string {
  // Clamp: doc stamps come from the SERVER clock (doc_show displayed_at)
  // — a device whose clock trails the server by a few seconds would
  // otherwise render "-3s ago".
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return String(sec) + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return String(min) + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return String(hr) + 'h ago';
  const day = Math.floor(hr / 24);
  return String(day) + 'd ago';
}
