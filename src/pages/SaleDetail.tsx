import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Badge, Button, ConfirmDialog, ErrorState, Field, PageHeader, Skeleton, Textarea } from '../components/ui';
import { toAppError } from '../lib/errors';
import { formatLongDate, formatTime, naira } from '../lib/format';
import type { Invoice } from '../lib/types';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import { useQuery, useWorkspace } from '../state/workspace';

const METHOD: Record<string, string> = { cash: 'Cash', transfer: 'Bank transfer', pos: 'POS', credit: 'Credit' };

export default function SaleDetail() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const ws = useWorkspace();
  const auth = useAuth();
  const toast = useToast();
  const sale = useQuery(['sales'], (api) => api.getSale(id), [id]);
  const existingInvoice = useQuery(['sales'], (api) => api.getInvoiceForSale(id), [id]);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reverseError, setReverseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inv = invoice ?? existingInvoice.data;
  const s = sale.data;
  const canReverse = ws.business?.role !== 'assistant';

  const issue = async () => {
    if (!ws.api) return;
    setIssuing(true);
    try {
      setInvoice(await ws.api.issueInvoice(id));
    } catch (e) {
      toast.error(`Invoice not created: ${toAppError(e).message}`);
    } finally {
      setIssuing(false);
    }
  };

  useEffect(() => {
    if (params.get('invoice') === '1' && s?.status === 'completed' && !existingInvoice.loading && !existingInvoice.data && !invoice && !issuing) void issue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, s?.status, existingInvoice.loading, existingInvoice.data]);

  const share = async () => {
    if (!s) return;
    const text = `${ws.business?.name ?? 'Vendora'}${inv ? ` — Invoice ${inv.invoice_number}` : ''}\n${formatLongDate(s.created_at)}\n` +
      s.items.map((i) => `${i.quantity} × ${i.product_name} @ ${naira(i.unit_price)} = ${naira(i.line_total)}`).join('\n') +
      `\nTotal: ${naira(s.total_amount)}\nPaid: ${naira(s.amount_paid)}${s.total_amount > s.amount_paid ? `\nBalance owing: ${naira(s.total_amount - s.amount_paid)}` : ''}`;
    try {
      if (navigator.share) await navigator.share({ title: inv ? `Invoice ${inv.invoice_number}` : 'Receipt', text });
      else { await navigator.clipboard.writeText(text); toast.success('Receipt copied. Paste it into WhatsApp or SMS.'); }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast.error('Could not share. Try Print → Save as PDF instead.');
    }
  };

  const reverse = async () => {
    if (reason.trim().length < 3) { setReverseError('Please say why (at least 3 letters).'); return; }
    setBusy(true);
    setReverseError(null);
    try {
      await ws.api!.reverseSale(id, reason.trim());
      ws.invalidate('sales', 'products', 'dashboard', 'customers');
      toast.success('Sale reversed. Stock has been put back.');
      setReverseOpen(false);
    } catch (e) {
      setReverseError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={inv ? `Invoice ${inv.invoice_number}` : 'Sale'} subtitle={s ? `${formatLongDate(s.created_at)} · ${formatTime(s.created_at)}` : undefined} actions={<Link to="/sales" className="btn btn-on-dark btn-sm">Back</Link>} />
      <div className="page-body" style={{ maxWidth: 760 }}>
        {sale.loading && !s ? <Skeleton height={320} radius={22} /> : sale.error ? <ErrorState message={sale.error} onRetry={sale.retry} /> : !s ? (
          <ErrorState message="This sale could not be found. It may belong to another business." />
        ) : (
          <>
            <article className="invoice stack" aria-label="Invoice">
              <div className="row-between wrap">
                <div>
                  <h2>{ws.business?.name}</h2>
                  <div className="small muted">{[ws.business?.market_area, ws.business?.city].filter(Boolean).join(', ')}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  {inv ? <><strong>{inv.invoice_number}</strong><br /></> : <Badge tone="neutral">No invoice number yet</Badge>}
                  <span className="small muted">{formatLongDate(s.created_at)}</span><br />
                  {s.status === 'reversed' && <span className="void-stamp">REVERSED{inv?.status === 'void' ? ' · VOID' : ''}</span>}
                </div>
              </div>
              {s.customer_name && <div className="small">Customer: <strong>{s.customer_name}</strong></div>}
              <table>
                <thead><tr><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Price</th><th scope="col">Amount</th></tr></thead>
                <tbody>
                  {s.items.map((i, idx) => (
                    <tr key={idx}><td>{i.product_name}</td><td>{i.quantity} {i.unit}</td><td className="tabular">{naira(i.unit_price)}</td><td className="tabular">{naira(i.line_total)}</td></tr>
                  ))}
                </tbody>
              </table>
              <div className="stack-sm" style={{ alignSelf: 'flex-end', minWidth: 220 }}>
                <div className="row-between"><span>Total</span><strong className="tabular">{naira(s.total_amount)}</strong></div>
                <div className="row-between small"><span className="muted">Paid ({METHOD[s.payment_method]})</span><span className="tabular">{naira(s.amount_paid)}</span></div>
                {s.total_amount > s.amount_paid && <div className="row-between small"><span className="muted">Balance owing</span><strong className="text-danger tabular">{naira(s.total_amount - s.amount_paid)}</strong></div>}
              </div>
              {s.status === 'reversed' && <p className="small text-danger">Reversed: {s.reversal_reason}</p>}
              <p className="xs muted">Recorded with Vendora{auth.profile?.full_name && ws.mode === 'live' ? ` by ${ws.business?.name}` : ''}. {s.payment_method === 'transfer' ? 'Transfer recorded by the seller; not bank-confirmed.' : ''}</p>
            </article>

            <div className="row wrap no-print">
              {!inv && s.status === 'completed' && <Button onClick={() => void issue()} loading={issuing}>🧾 Create invoice number</Button>}
              <Button variant="secondary" onClick={() => window.print()}>🖨 Print / Save PDF</Button>
              <Button variant="secondary" onClick={() => void share()}>📤 Share</Button>
              {s.status === 'completed' && canReverse && <Button variant="danger" onClick={() => setReverseOpen(true)}>↺ Reverse sale</Button>}
            </div>
            <p className="xs muted no-print">To save a PDF, choose Print and then “Save as PDF”.</p>
          </>
        )}
      </div>
      <ConfirmDialog open={reverseOpen} title="Reverse this sale?" confirmLabel="Reverse sale" tone="danger" busy={busy} onCancel={() => setReverseOpen(false)} onConfirm={() => void reverse()}>
        <p>The items go back into stock and any amount owing is cancelled. The original sale stays in your records, marked as reversed{inv ? ` and invoice ${inv.invoice_number} becomes void` : ''}.</p>
        <Field label="Reason" required error={reverseError}>{({ id: fid, invalid, describedBy }) => <Textarea id={fid} aria-invalid={invalid} aria-describedby={describedBy} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer returned the bag" />}</Field>
      </ConfirmDialog>
    </>
  );
}
