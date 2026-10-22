import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App.tsx";
import { RouterProvider } from "./router.tsx";
import { IdentityProvider } from "./identity.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider>
      <IdentityProvider>
        <App />
      </IdentityProvider>
    </RouterProvider>
  </StrictMode>,
);
