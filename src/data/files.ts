/** A download link for text the browser builds itself. */
export function blobUrl(content: string, type: string): string {
  return URL.createObjectURL(new Blob([content], { type }));
}
