import { BrowserRouter, HashRouter, NavLink, Route, Routes } from "react-router-dom";
import { Dashboard } from "./pages/Dashboard";
import { ImportPage } from "./pages/ImportPage";
import { STATIC_MODE } from "./lib/api";
import { DemoBanner } from "./components/DemoBanner";

// GitHub Pages can't route /import to index.html, so the demo build uses hash routes.
const Router = STATIC_MODE ? HashRouter : BrowserRouter;

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-1.5 text-sm font-medium ${isActive ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"}`;

export default function App() {
  return (
    <Router>
      {STATIC_MODE && <DemoBanner />}
      <header className="border-b border-gray-200 bg-white">
        <nav className="mx-auto flex max-w-6xl items-center gap-2 px-6 py-3">
          <span className="mr-4 text-sm font-semibold tracking-wide text-gray-800">Dental Analytics</span>
          <NavLink to="/" end className={linkClass}>
            Finance Report
          </NavLink>
          <NavLink to="/import" className={linkClass}>
            Import Financing Data
          </NavLink>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/import" element={<ImportPage />} />
      </Routes>
    </Router>
  );
}
