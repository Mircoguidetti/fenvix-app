import { client } from "../data";

/** Visible on every screen while the data is fake. */
export function SampleLabel() {
  if (!client.isSample) return null;
  return <span className="tag tag-sample">Sample data</span>;
}
