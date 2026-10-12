import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, EmptyState, Field, Input, PageHeader, Sheet, Tabs } from '../components/ui';
import { toAppError } from '../lib/errors';
import { initials, naira, relativeTime } from '../lib/format';
import { useToast } from '../state/toast';
import { useWorkspace } from '../state/workspace';

export default function Customers() {
  const ws = useWorkspace();
  const [tab, setTab] = useState<'owing' | 'all'>('owing');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const owing = ws.customers.filter((c) => c.balance > 0);
  const total = owing.reduce((a, c) => a + c.balance, 0);
  const list = useMemo(() => (tab === 'owing' ? owing : ws.customers)
    .filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (tab === 'owing' ? b.balance - a.balance : a.name.localeCompare(b.name))), [tab, owing, ws.customers, q]);

  return (
    <>
      <PageHeader title="Money owed" subtitle={owing.length ? `${owing.length} customer${owing.length === 1 ? '' : 's'} owe you ${naira(total)}` : 'Track customers who buy on credit'}
        actions={<Button variant="yellow" size="sm" onClick={() => setAdding(true)}>＋ Customer</Button>} />
      <div className="page-body" style={{ maxWidth: 820 }}>
        <Tabs label="Customers" value={tab} onChange={setTab} options={[{ value: 'owing', label: 'Owing', count: owing.length }, { value: 'all', label: 'All customers', count: ws.customers.length }]} />
        <div className="search-bar">
          <span aria-hidden="true">🔍</span>
          <label htmlFor="cust-search" className="sr-only">Search customers</label>
          <input id="cust-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customers…" />
        </div>
        {list.length === 0 ? (
          <EmptyState icon={tab === 'owing' ? '🎉' : '👥'} title={tab === 'owing' ? 'Nobody owes you' : 'No customers yet'}>
            {tab === 'owing' ? 'When you sell on credit, the balance shows here.' : 'Customers are added when you sell on credit, or tap “+ Customer”.'}
          </EmptyState>
        ) : (
          <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {list.map((c) => (
              <li key={c.customer_id}>
                <Link to={`/customers/${c.customer_id}`} className={`list-row accent ${c.balance > 0 ? 'accent-warning' : 'accent-success'}`}>
                  <span className="avatar avatar-sm" aria-hidden="true">{initials(c.name)}</span>
                  <span className="grow">
                    <span className="row-title" style={{ display: 'block' }}>{c.name}</span>
                    <span className="row-sub">{c.phone ?? 'No phone'}{c.last_activity_at ? ` · last activity ${relativeTime(c.last_activity_at)}` : ''}</span>
                  </span>
                  <span className={`row-amount ${c.balance > 0 ? 'text-danger' : 'muted'}`}>
                    {c.balance > 0 ? `owes ${naira(c.balance)}` : c.balance < 0 ? `credit ${naira(-c.balance)}` : 'Settled'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <AddCustomerSheet open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function AddCustomerSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ws = useWorkspace();
  const toast = useToast();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} onClose={onClose} title="Add a customer">
      <form className="form" noValidate onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) { setError('Enter the customer name.'); return; }
        setBusy(true);
        setError(null);
        try {
          await ws.api!.createCustomer(name.trim(), phone.trim());
          ws.invalidate('customers');
          toast.success(`${name.trim()} added.`);
          setName(''); setPhone('');
          onClose();
        } catch (err) {
          setError(toAppError(err).message);
        } finally {
          setBusy(false);
        }
      }}>
        <Field label="Name" required error={error}>{({ id, invalid, describedBy }) => <Input id={id} data-autofocus aria-invalid={invalid} aria-describedby={describedBy} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Emeka Chukwu" />}</Field>
        <Field label="Phone" optional>{({ id }) => <Input id={id} type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="080 0000 0000" />}</Field>
        <div className="sheet-footer" style={{ marginTop: 0 }}>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" loading={busy}>Save customer</Button>
        </div>
      </form>
    </Sheet>
  );
}
