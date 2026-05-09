import { fetchSourceContent, type TaskSourcePayload } from "./api";

export async function openTaskSource(
  source: TaskSourcePayload,
  token: string | null,
): Promise<void> {
  if (source.kind === "url" && source.source_url) {
    window.open(source.source_url, "_blank", "noopener,noreferrer");
    return;
  }

  const blob = await fetchSourceContent(token, source.source_id);
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  anchor.download = source.display_name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
