import "@fontsource/ibm-plex-sans-arabic/400.css";
import "@fontsource/ibm-plex-sans-arabic/500.css";
import "@fontsource/ibm-plex-sans-arabic/600.css";
import "@fontsource/ibm-plex-sans-arabic/700.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/assistant.css";
import "./styles/pos.css";
import "./styles/pages.css";
import "./styles/landing.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, setUnauthorizedHandler } from "./api/client";
import { meKey } from "./app/session";
import { buildRouter } from "./router";
import { ToastProvider } from "./ui/Toast";
import { stackTablesOnPhones } from "./ui/stackTables";

stackTablesOnPhones();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Retry network blips, never permission or validation answers.
      retry: (count, err) => count < 2 && (!(err instanceof ApiError) || err.status === 0 || err.status >= 500),
    },
  },
});
const router = buildRouter(queryClient);

// Session expired mid-work: go to login and come back to the same page afterwards.
setUnauthorizedHandler((code) => {
  const here = window.location.pathname + window.location.search;
  // Signed in with the password, the second step still due: ask for the code, then come back.
  if (code === "mfa_required") {
    if (window.location.pathname !== "/mfa") void router.navigate({ to: "/mfa", search: { next: here } as never });
    return;
  }
  queryClient.setQueryData(meKey, null);
  if (!["/login", "/register", "/", "/verify-email", "/forgot-password", "/reset-password"].includes(window.location.pathname)) {
    void router.navigate({ to: "/login", search: { next: here } as never });
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
