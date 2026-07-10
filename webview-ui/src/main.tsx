import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initLocale } from "./i18n";
import "./styles.css";

// Fixa o locale a partir do data-locale injetado pelo host, ANTES do primeiro render (o idioma do
// VSCode é fixo por sessão — não precisa de context reativo).
initLocale();

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
