import React from "react";
import ReactDOM from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import App from "./App";
import { createWebStoryBridge } from "@/renderer/bridge/webStoryBridge";
import type { StoryBridge } from "@/shared/ipc";

const windowWithOptionalBridge = window as Window & { storyBridge?: StoryBridge };
if (!windowWithOptionalBridge.storyBridge) {
  windowWithOptionalBridge.storyBridge = createWebStoryBridge();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
