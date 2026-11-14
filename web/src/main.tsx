import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useMe } from "./api/hooks.ts";
import { ProjectLayout } from "./components/ProjectLayout.tsx";
import { AuthPage } from "./pages/AuthPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { OverviewPage } from "./pages/OverviewPage.tsx";
import { TasksPage } from "./pages/TasksPage.tsx";
import { TestsPage } from "./pages/TestsPage.tsx";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: true, retry: 1 } },
});

function App() {
  const me = useMe();
  if (me.isLoading) return <div className="center-msg">Loading…</div>;

  if (!me.data) {
    return (
      <Routes>
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route path="*" element={<AuthPage mode="login" />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/projects/:projectId" element={<ProjectLayout />}>
        <Route index element={<Navigate to="overview" replace />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="tests" element={<TestsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
