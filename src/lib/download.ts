import type { ExportResult } from "../data";

/** A download link for text the browser holds (a CSV from the API, or built by the mock). */
export function blobUrl(content: string, type: string): string {
  return URL.createObjectURL(new Blob([content], { type }));
}

/** Starts a browser download for a prepared export. */
export function download(file: ExportResult) {
  const a = document.createElement("a");
  a.href = file.downloadUrl;
  a.download = file.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
