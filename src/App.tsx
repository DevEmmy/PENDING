import { lazy, Suspense, type ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { Splash } from './components/Splash';
import { AuthProvider, useAuth } from './state/auth';
import { ToastProvider } from './state/toast';
import { useWorkspace, WorkspaceProvider } from './state/workspace';
import { VoiceProvider } from './voice/VoiceProvider';
import Welcome from './pages/auth/Welcome';
import SignIn from './pages/auth/SignIn';
import SignUp from './pages/auth/SignUp';
import { CheckEmail, ForgotPassword, ResetPassword } from './pages/auth/Recovery';
import Onboarding from './pages/auth/Onboarding';
import Home from './pages/Home';
import Chat from './pages/Chat';
import Stock from './pages/Stock';
import Sales from './pages/Sales';
import NewSale from './pages/NewSale';
import SaleDetail from './pages/SaleDetail';
import Customers from './pages/Customers';
import CustomerDetail from './pages/CustomerDetail';
import Insights from './pages/Insights';
import Profile from './pages/Profile';

// The Vendors Hub is a larger, live-only area: load it on demand.
const HubHome = lazy(() => import('./pages/hub/HubHome'));
const AdvertDetail = lazy(() => import('./pages/hub/AdvertDetail'));
const AdvertEditor = lazy(() => import('./pages/hub/AdvertEditor'));
const MyAdverts = lazy(() => import('./pages/hub/MyAdverts'));
const VendorProfile = lazy(() => import('./pages/hub/VendorProfile'));
const EditVendorProfile = lazy(() => import('./pages/hub/EditVendorProfile'));
const Connections = lazy(() => import('./pages/hub/Connections'));
const Inbox = lazy(() => import('./pages/hub/Inbox'));
const Conversation = lazy(() => import('./pages/hub/Conversation'));

function RequireApp({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const ws = useWorkspace();
  const location = useLocation();
  if (ws.mode === 'demo') return <>{children}</>;
  if (auth.loading) return <Splash />;
  if (!auth.session) return <Navigate to="/welcome" replace state={{ from: location.pathname }} />;
  if (auth.recoveryMode) return <Navigate to="/reset-password" replace />;
  if (!ws.ready) return <Splash label="Opening your shop…" />;
  if (ws.businessesError) return <Splash label={`Could not load your shop: ${ws.businessesError} Pull to refresh or try again.`} />;
  if (!ws.business) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

function RequireSession({ children }: { children: ReactNode }) {
  const auth = useAuth();
  if (auth.loading) return <Splash />;
  if (!auth.session) return <Navigate to="/signin" replace />;
  return <>{children}</>;
}

function RedirectIfIn({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const ws = useWorkspace();
  if (ws.mode === 'demo') return <Navigate to="/" replace />;
  if (auth.loading) return <Splash />;
  if (auth.session && !auth.recoveryMode) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <HashRouter>
      <ToastProvider>
        <AuthProvider>
          <WorkspaceProvider>
            <VoiceProvider>
              <Routes>
                <Route path="/welcome" element={<RedirectIfIn><Welcome /></RedirectIfIn>} />
                <Route path="/signin" element={<RedirectIfIn><SignIn /></RedirectIfIn>} />
                <Route path="/signup" element={<RedirectIfIn><SignUp /></RedirectIfIn>} />
                <Route path="/check-email" element={<CheckEmail />} />
                <Route path="/forgot-password" element={<ForgotPassword />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/onboarding" element={<RequireSession><Onboarding /></RequireSession>} />
                <Route element={<RequireApp><AppShell /></RequireApp>}>
                  <Route index element={<Home />} />
                  <Route path="chat" element={<Chat />} />
                  <Route path="stock" element={<Stock />} />
                  <Route path="sales" element={<Sales />} />
                  <Route path="sales/new" element={<NewSale />} />
                  <Route path="sales/:id" element={<SaleDetail />} />
                  <Route path="customers" element={<Customers />} />
                  <Route path="customers/:id" element={<CustomerDetail />} />
                  <Route path="insights" element={<Insights />} />
                  <Route path="profile" element={<Profile />} />
                  <Route path="hub/*" element={
                    <Suspense fallback={<Splash label="Opening Vendors Hub…" />}>
                      <Routes>
                        <Route index element={<HubHome />} />
                        <Route path="adverts/new" element={<AdvertEditor />} />
                        <Route path="adverts/:id" element={<AdvertDetail />} />
                        <Route path="adverts/:id/edit" element={<AdvertEditor />} />
                        <Route path="my-adverts" element={<MyAdverts />} />
                        <Route path="vendors/:businessId" element={<VendorProfile />} />
                        <Route path="profile" element={<EditVendorProfile />} />
                        <Route path="connections" element={<Connections />} />
                        <Route path="messages" element={<Inbox />} />
                        <Route path="messages/:id" element={<Conversation />} />
                      </Routes>
                    </Suspense>
                  } />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </VoiceProvider>
          </WorkspaceProvider>
        </AuthProvider>
      </ToastProvider>
    </HashRouter>
  );
}
