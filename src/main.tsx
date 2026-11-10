import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/schibsted-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { applyTheme, storedTheme } from "./lib/theme";
import App from "./App";
import { completeAuthRedirect } from "./session/redirect";
import { captureInviteFromUrl } from "./lib/invite";

// A theme picked earlier in this browser applies before the first paint; without one the device setting does.
applyTheme(storedTheme());

// An invitation link (/invite#token=…): keep the token for this tab and take it out of the address bar first.
captureInviteFromUrl();

// A provider sends the browser back with ?code=… in the query. That is finished here, before
// the hash router mounts, so the app starts on a clean URL with the session already loaded.
await completeAuthRedirect();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
