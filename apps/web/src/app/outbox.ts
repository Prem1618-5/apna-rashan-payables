import { useEffect, useState } from "react";
import { api } from "../api/client";
import { createOutbox, type OutboxMeta } from "../lib/outbox";
import { invalidate } from "../lib/resource";

export const outbox = createOutbox({
  upload: (item) => api.uploadDocument(item),
  onUploaded: () => invalidate("invoices", "dashboard"),
});

let started = false;
/** Upload on app open, when the phone comes back online, and when the app is brought to the front. */
export function startOutbox() {
  if (started) return;
  started = true;
  void outbox.refresh().then(() => outbox.drain());
  window.addEventListener("online", () => void outbox.drain(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void outbox.drain();
  });
}

export function useOutbox(): OutboxMeta[] {
  const [items, setItems] = useState(outbox.items);
  useEffect(() => outbox.subscribe(setItems), []);
  return items;
}
