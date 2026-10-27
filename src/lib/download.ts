import type { ExportResult } from "../data";

/** Starts a browser download for a prepared export. */
export function download(file: ExportResult) {
  const a = document.createElement("a");
  a.href = file.downloadUrl;
  a.download = file.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
