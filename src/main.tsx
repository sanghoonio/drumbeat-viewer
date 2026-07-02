import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { CoordinatorProvider } from "./duckdb/coordinator";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CoordinatorProvider>
      <App />
    </CoordinatorProvider>
  </StrictMode>,
);
