import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/schibsted-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import App from "./App";
import { completeAuthRedirect } from "./session/redirect";

// A provider sends the browser back with ?code=… in the query. That is finished here, before
// the hash router mounts, so the app starts on a clean URL with the session already loaded.
await completeAuthRedirect();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
