import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BusinessApi } from '../data/api';
import { DemoBusinessApi } from '../data/demoApi';
import { SupabaseBusinessApi } from '../data/supabaseApi';
import { toAppError } from '../lib/errors';
import { supabase } from '../lib/supabase';
import type { Business, Customer, Language, Product } from '../lib/types';
import { cacheProducts, getCachedProducts, listQueued, onQueueChange, syncQueue, type QueuedSale } from '../offline/queue';
import { useAuth } from './auth';
import { useToast } from './toast';

export type DataKey = 'products' | 'sales' | 'customers' | 'dashboard' | 'payments' | 'hub';

interface Workspace {
  mode: 'live' | 'demo' | null;
  ready: boolean;
  businesses: Business[];
  business: Business | null;
  businessesError: string | null;
  api: BusinessApi | null;
  language: Language;
  setLanguage(l: Language): Promise<void>;
  enterDemo(language?: Language): void;
  exitDemo(): void;
  resetDemo(): void;
  selectBusiness(id: string): void;
  reloadBusinesses(): Promise<Business[]>;

  products: Product[];
  productsState: { loading: boolean; error: string | null; fromCache: string | null };
  customers: Customer[];
  versions: Record<DataKey, number>;
  invalidate(...keys: DataKey[]): void;

  online: boolean;
  queue: QueuedSale[];
  syncNow(): Promise<void>;
}

const Ctx = createContext<Workspace | null>(null);
const MODE_KEY = 'vendora.mode';
const LANG_KEY = 'vendora.lang';
const BIZ_KEY = 'vendora.business';

function readStore(storage: Storage | undefined, key: string): string | null {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}
function writeStore(storage: Storage | undefined, key: string, value: string | null) {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch { /* storage blocked: keep in memory */ }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const toast = useToast();
  const [demo, setDemo] = useState(() => readStore(globalThis.sessionStorage, MODE_KEY) === 'demo');
  const [localLang, setLocalLang] = useState<Language>(() => (readStore(globalThis.localStorage, LANG_KEY) as Language) || 'en');
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessesLoaded, setBusinessesLoaded] = useState(false);
  const [businessesError, setBusinessesError] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(() => readStore(globalThis.localStorage, BIZ_KEY));
  const [demoNonce, setDemoNonce] = useState(0);
  const [products, setProducts] = useState<Product[]>([]);
  const [productsState, setProductsState] = useState({ loading: false, error: null as string | null, fromCache: null as string | null });
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [versions, setVersions] = useState<Record<DataKey, number>>({ products: 0, sales: 0, customers: 0, dashboard: 0, payments: 0, hub: 0 });
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [queue, setQueue] = useState<QueuedSale[]>([]);

  const live = !demo && Boolean(auth.session);
  const mode: Workspace['mode'] = demo ? 'demo' : auth.session ? 'live' : null;

  const reloadBusinesses = useCallback(async (): Promise<Business[]> => {
    if (!supabase || !auth.session) return [];
    const { data, error } = await supabase.from('business_members')
      .select('role, businesses(id,name,category,market_area,city)').eq('user_id', auth.session.user.id);
    if (error) {
      setBusinessesError(toAppError(error).message);
      setBusinessesLoaded(true);
      return [];
    }
    const list: Business[] = (data ?? []).flatMap((r) => {
      const b = r.businesses as unknown as Omit<Business, 'role'> | null;
      return b ? [{ ...b, role: r.role as Business['role'] }] : [];
    });
    setBusinessesError(null);
    setBusinesses(list);
    setBusinessesLoaded(true);
    return list;
  }, [auth.session]);

  useEffect(() => {
    if (live) void reloadBusinesses();
    else { setBusinesses([]); setBusinessesLoaded(false); }
  }, [live, reloadBusinesses]);

  const business = useMemo<Business | null>(() => {
    if (demo) return { id: 'demo-business', name: 'Ngozi Provisions (Demo)', category: 'foodstuff', market_area: 'Alaba Market', city: 'Lagos', role: 'owner' };
    return businesses.find((b) => b.id === currentId) ?? businesses[0] ?? null;
  }, [demo, businesses, currentId]);

  const api = useMemo<BusinessApi | null>(() => {
    if (demo) return new DemoBusinessApi();
    if (supabase && auth.session && business) return new SupabaseBusinessApi(supabase, business.id, auth.session.user.id);
    return null;
    // demoNonce forces a fresh demo api after reset
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, auth.session?.user.id, business?.id, demoNonce]);

  const language: Language = demo || !auth.profile ? localLang : auth.profile.preferred_language;

  const invalidate = useCallback((...keys: DataKey[]) => {
    setVersions((v) => {
      const next = { ...v };
      for (const k of keys) next[k] += 1;
      return next;
    });
  }, []);

  // Products: always fresh from the source; cached copy only shown (and labelled) when offline.
  const productsReq = useRef(0);
  useEffect(() => {
    if (!api) { setProducts([]); return; }
    const req = ++productsReq.current;
    setProductsState((s) => ({ ...s, loading: true, error: null }));
    api.listProducts().then((list) => {
      if (req !== productsReq.current) return;
      setProducts(list);
      setProductsState({ loading: false, error: null, fromCache: null });
      if (api.mode === 'live') void cacheProducts(api.businessId, list);
    }).catch(async (e) => {
      if (req !== productsReq.current) return;
      const err = toAppError(e);
      const cached = api.mode === 'live' && err.code === 'NETWORK' ? await getCachedProducts(api.businessId) : null;
      if (cached) {
        setProducts(cached.products);
        setProductsState({ loading: false, error: null, fromCache: cached.savedAt });
      } else setProductsState({ loading: false, error: err.message, fromCache: null });
    });
  }, [api, versions.products]);

  useEffect(() => {
    if (!api) { setCustomers([]); return; }
    let active = true;
    api.listCustomers().then((c) => active && setCustomers(c)).catch(() => { /* surfaced on the customers page */ });
    return () => { active = false; };
  }, [api, versions.customers]);

  // Offline queue
  const refreshQueue = useCallback(async () => {
    if (!api || api.mode !== 'live') { setQueue([]); return; }
    setQueue(await listQueued(api.businessId));
  }, [api]);
  useEffect(() => {
    void refreshQueue();
    return onQueueChange(() => void refreshQueue());
  }, [refreshQueue]);

  const syncNow = useCallback(async () => {
    if (!api || api.mode !== 'live') return;
    const report = await syncQueue(api);
    if (report.synced.length) {
      toast.success(`${report.synced.length} offline sale${report.synced.length === 1 ? '' : 's'} now recorded.`);
      invalidate('products', 'sales', 'dashboard', 'customers');
    }
    if (report.failed.length) toast.error(`${report.failed.length} offline sale${report.failed.length === 1 ? ' was' : 's were'} not accepted: ${report.failed[0].reason} Open Sales to review.`);
  }, [api, toast, invalidate]);

  useEffect(() => {
    const on = () => { setOnline(true); void syncNow(); };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    if (navigator.onLine) void syncNow();
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, [syncNow]);

  const value = useMemo<Workspace>(() => ({
    mode,
    ready: demo || !auth.session || businessesLoaded,
    businesses,
    business,
    businessesError,
    api,
    language,
    async setLanguage(l) {
      setLocalLang(l);
      writeStore(globalThis.localStorage, LANG_KEY, l);
      if (!demo && auth.session) await auth.updateProfile({ preferred_language: l });
    },
    enterDemo(l) {
      writeStore(globalThis.sessionStorage, MODE_KEY, 'demo');
      if (l) { setLocalLang(l); writeStore(globalThis.localStorage, LANG_KEY, l); }
      setDemo(true);
    },
    exitDemo() {
      writeStore(globalThis.sessionStorage, MODE_KEY, null);
      DemoBusinessApi.reset();
      setDemo(false);
    },
    resetDemo() {
      DemoBusinessApi.reset();
      setDemoNonce((n) => n + 1);
    },
    selectBusiness(id) {
      writeStore(globalThis.localStorage, BIZ_KEY, id);
      setCurrentId(id);
    },
    reloadBusinesses,
    products,
    productsState,
    customers,
    versions,
    invalidate,
    online,
    queue,
    syncNow,
  }), [mode, demo, auth, businessesLoaded, businesses, business, businessesError, api, language, reloadBusinesses, products, productsState, customers, versions, invalidate, online, queue, syncNow]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): Workspace {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWorkspace outside provider');
  return v;
}

/** Fetch data from the current API, refetching when the given data keys are invalidated. */
export function useQuery<T>(keys: DataKey[], fetcher: (api: BusinessApi) => Promise<T>, deps: unknown[] = []) {
  const { api, versions } = useWorkspace();
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const versionKey = keys.map((k) => versions[k]).join('.');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!api) return;
    let active = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetcher(api).then((data) => active && setState({ data, loading: false, error: null }))
      .catch((e) => active && setState((s) => ({ data: s.data, loading: false, error: toAppError(e).message })));
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, versionKey, retry, ...deps]);
  return { ...state, retry: () => setRetry((r) => r + 1) };
}
