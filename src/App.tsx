import { Routes, Route } from "react-router-dom";
import MovementForm from "./pages/MovementForm";
import LoginPage from "./pages/LoginPage";
import AdminLayout from "./pages/admin/AdminLayout";
import Dashboard from "./pages/admin/Dashboard";
import History from "./pages/admin/History";
import Summaries from "./pages/admin/Summaries";
import Pending from "./pages/admin/Pending";
import ReturnRequests from "./pages/admin/ReturnRequests";
import WithdrawalRequests from "./pages/admin/WithdrawalRequests";
import Materials from "./pages/admin/Materials";
import Categories from "./pages/admin/Categories";
import Technicians from "./pages/admin/Technicians";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<MovementForm />} />
      <Route path="/admin/login" element={<LoginPage />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="historial" element={<History />} />
        <Route path="resumenes" element={<Summaries />} />
        <Route path="pendientes" element={<Pending />} />
        <Route path="retiros" element={<WithdrawalRequests />} />
        <Route path="devoluciones" element={<ReturnRequests />} />
        <Route path="materiales" element={<Materials />} />
        <Route path="categorias" element={<Categories />} />
        <Route path="tecnicos" element={<Technicians />} />
      </Route>
      <Route
        path="*"
        element={
          <div className="flex min-h-screen items-center justify-center p-6 text-center">
            <div>
              <p className="text-lg font-semibold text-slate-800">Página no encontrada</p>
              <a href="/" className="mt-3 inline-block text-brand-600 underline">
                Ir al formulario de movimientos
              </a>
            </div>
          </div>
        }
      />
    </Routes>
  );
}
