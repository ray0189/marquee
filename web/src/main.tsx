import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

// As soon as the site is idle, work out what this device can play and fetch the playback engine, so pressing
// play only has to look at the film itself.
const warm = () => {
  void import("./lib/device").then((m) => m.device());
  void import("./lib/remux").then((m) => m.warmRemux());
};
if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 3000 });
else setTimeout(warm, 1500);
