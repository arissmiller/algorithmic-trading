import { NavLink, Outlet } from "react-router-dom";
import { APP_NAV_GROUPS } from "./app/navigation";
import { useApiHealth } from "./app/useApiHealth";

export default function App() {
  const serverOnline = useApiHealth();

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface text-text-primary">
      <div className="pointer-events-none fixed left-1/2 top-2 z-50 -translate-x-1/2 rounded border-2 border-yellow-200 bg-yellow-300 px-4 py-1.5 text-center text-xs font-bold uppercase tracking-wide text-black shadow-[0_0_18px_rgba(253,224,71,0.55)]">
        Nothing here is intended as financial advice. All trades are virtual.
      </div>

      <header className="border-b border-border bg-surface-1 shadow-[0_0_18px_rgba(70,215,255,0.12)]">
        <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3 pr-24">
          <span className="text-sm font-semibold tracking-tight">AI Investment Platform</span>
          <a
            href="https://arissmiller.net"
            className="ml-auto rounded border border-border bg-surface-2 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary transition-colors hover:text-text-primary"
          >
            Back to Projects
          </a>
          <span
            className={`h-2 w-2 rounded-full ${serverOnline ? "bg-buy" : "bg-sell"}`}
            title={serverOnline ? "API online" : "API offline"}
          />
          <span className="text-[11px] text-text-secondary">
            {serverOnline ? "API online" : "API offline"}
          </span>
        </div>
        <nav className="space-y-2 px-3 py-2">
          {APP_NAV_GROUPS.map((group) => (
            <div key={group.label} className="flex items-start gap-2">
              <p className="w-20 shrink-0 pt-1 text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
                {group.label}
              </p>
              <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-0.5">
                {group.pages.map((page) => (
                  <NavLink
                    key={page.path}
                    to={page.path}
                    className={({ isActive }) =>
                      `shrink-0 rounded border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
                        isActive
                          ? "border-accent/50 bg-accent/15 text-accent"
                          : "border-border bg-surface-2 text-text-secondary hover:text-text-primary"
                      }`
                    }
                  >
                    {page.label}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
