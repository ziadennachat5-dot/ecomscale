import { Outlet } from "react-router-dom";
import { AdminSidebar } from "./AdminSidebar";
import { Topbar } from "./Topbar";

export function AdminLayout() {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-base text-ink">
      <AdminSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
