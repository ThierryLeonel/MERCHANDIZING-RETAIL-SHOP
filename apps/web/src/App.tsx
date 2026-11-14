import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { Layout } from "./components/Layout";
import { Spinner } from "./components/ui";
import { useSession } from "./lib/session";
import { LoginPage } from "./pages/Login";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const Pos = lazy(() => import("./pages/pos/PosPage"));
const Returns = lazy(() => import("./pages/pos/ReturnsPage"));
const Products = lazy(() => import("./pages/products/ProductsPage"));
const ProductDetail = lazy(() => import("./pages/products/ProductDetail"));
const ProductForm = lazy(() => import("./pages/products/ProductForm"));
const CatalogueSetup = lazy(() => import("./pages/products/CatalogueSetupPage"));
const Inventory = lazy(() => import("./pages/inventory/InventoryPage"));
const Purchasing = lazy(() => import("./pages/purchasing/PurchasingPage"));
const PurchaseOrderDetail = lazy(() => import("./pages/purchasing/PurchaseOrderDetail"));
const PurchaseOrderForm = lazy(() => import("./pages/purchasing/PurchaseOrderForm"));
const Customers = lazy(() => import("./pages/customers/CustomersPage"));
const CustomerDetail = lazy(() => import("./pages/customers/CustomerDetail"));
const Finance = lazy(() => import("./pages/finance/FinancePage"));
const SessionDetail = lazy(() => import("./pages/finance/SessionDetail"));
const Accounting = lazy(() => import("./pages/accounting/AccountingPage"));
const JournalDetail = lazy(() => import("./pages/accounting/JournalDetail"));
const Reports = lazy(() => import("./pages/reports/ReportsPage"));
const Approvals = lazy(() => import("./pages/ApprovalsPage"));
const Admin = lazy(() => import("./pages/admin/AdminPage"));
const Account = lazy(() => import("./pages/AccountPage"));
const SaleDetail = lazy(() => import("./pages/pos/SaleDetail"));

export function App() {
  const { me, loading } = useSession();
  const location = useLocation();
  if (loading) return <Spinner />;
  if (!me) return location.pathname === "/login" ? <LoginPage /> : <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return (
    <Layout>
      <Suspense fallback={<Spinner />}>
        <Routes>
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/" element={<Dashboard />} />
          <Route path="/pos" element={<Pos />} />
          <Route path="/pos/returns" element={<Returns />} />
          <Route path="/sales/:id" element={<SaleDetail />} />
          <Route path="/products" element={<Products />} />
          <Route path="/products/new" element={<ProductForm />} />
          <Route path="/products/setup" element={<CatalogueSetup />} />
          <Route path="/products/:id" element={<ProductDetail />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/purchasing" element={<Purchasing />} />
          <Route path="/purchasing/orders/new" element={<PurchaseOrderForm />} />
          <Route path="/purchasing/orders/:id" element={<PurchaseOrderDetail />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/customers/:id" element={<CustomerDetail />} />
          <Route path="/finance" element={<Finance />} />
          <Route path="/finance/sessions/:id" element={<SessionDetail />} />
          <Route path="/accounting" element={<Accounting />} />
          <Route path="/accounting/journals/:id" element={<JournalDetail />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/account" element={<Account />} />
          <Route path="*" element={<div className="p-10 text-center text-slate-500">Page not found</div>} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
