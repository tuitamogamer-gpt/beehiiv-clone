import { useEffect, useState, type FormEvent } from 'react';
import { History, KeyRound, PenLine, Plus, RefreshCw, RotateCcw, Trash2, Webhook, X } from 'lucide-react';
import { api, type Page, type WebhookDelivery, type WebhookEndpoint } from '../backend';
import { Dialog, formatDateTime, type Perform } from './ui';

export const WEBHOOK_EVENTS: { group: string; events: string[] }[] = [
  { group: 'Subscribers', events: ['subscriber.created', 'subscriber.updated', 'subscriber.confirmed', 'subscriber.unsubscribed', 'subscriber.deleted'] },
  { group: 'Newsletters', events: ['post.scheduled', 'post.sent', 'post.send_completed'] },
  { group: 'Email activity', events: ['email.delivered', 'email.opened', 'email.clicked', 'email.bounced', 'email.complained', 'email.delivery_delayed'] },
  { group: 'Growth', events: ['newsletter_list.subscribed', 'newsletter_list.unsubscribed', 'referral.confirmed', 'referral.milestone_earned'] },
  { group: 'Commerce', events: ['order.paid', 'order.refunded', 'subscription.upgraded', 'subscription.paused', 'subscription.updated'] },
  { group: 'Automations', events: ['automation.started', 'automation.completed', 'automation.cancelled'] },
  { group: 'Content and community', events: ['website.page.published', 'poll.submitted', 'survey.submitted', 'community.post.created', 'podcast.episode.published', 'podcast.episode.updated', 'podcast.episode.archived'] },
];

type Draft = { id?: string; version?: number; name: string; url: string; events: string[] };
type Props = { publicationId: string; busy: boolean; perform: Perform; onError: (error: unknown) => void; onNotice: (message: string) => void; error: string; clearError: () => void };

export default function WebhooksPanel({ publicationId, busy, perform, onError, onNotice, error, clearError }: Props) {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState('');
  const [secret, setSecret] = useState<{ endpoint: string; value: string } | null>(null);
  const [history, setHistory] = useState<{ endpoint: WebhookEndpoint; deliveries: WebhookDelivery[] } | null>(null);

  async function load() {
    setLoading(true);
    try { setEndpoints((await api<Page<WebhookEndpoint>>('/webhooks?limit=100')).items); }
    catch (error) { onError(error); } finally { setLoading(false); }
  }
  useEffect(() => { setEndpoints([]); setSecret(null); setDraft(null); setHistory(null); void load(); }, [publicationId]);
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) { setDraft(null); setHistory(null); } }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [busy]);

  const replace = (endpoint: WebhookEndpoint) => setEndpoints(previous => previous.some(item => item.id === endpoint.id) ? previous.map(item => item.id === endpoint.id ? endpoint : item) : [...previous, endpoint]);
  const openHistory = (endpoint: WebhookEndpoint) => perform(async () => setHistory({ endpoint, deliveries: (await api<Page<WebhookDelivery>>(`/webhooks/${encodeURIComponent(endpoint.id)}/deliveries?limit=25`)).items }), '', false);
  const allEvents = draft?.events.includes('*') || false;

  function save(event: FormEvent) {
    event.preventDefault(); setFormError('');
    if (!draft) return;
    if (!draft.events.length) { setFormError('Choose at least one event.'); return; }
    if (!/^https:\/\//i.test(draft.url.trim())) { setFormError('Use a public https:// URL for the endpoint.'); return; }
    const current = draft;
    void perform(async () => {
      const body = { name: current.name.trim(), url: current.url.trim(), events: current.events };
      if (current.id) replace(await api<WebhookEndpoint>(`/webhooks/${encodeURIComponent(current.id)}`, { method: 'PATCH', body: { ...body, version: current.version } }));
      else {
        const created = await api<WebhookEndpoint & { secret: string }>('/webhooks', { body });
        const { secret: value, ...endpoint } = created; replace(endpoint); setSecret({ endpoint: endpoint.name, value });
      }
      setDraft(null);
    }, current.id ? 'Webhook endpoint saved.' : 'Webhook endpoint created.', false);
  }

  const toggleEvent = (name: string, checked: boolean) => setDraft(previous => previous && ({ ...previous, events: checked ? [...new Set([...previous.events.filter(item => item !== '*'), name])] : previous.events.filter(item => item !== name) }));

  return <section className="card live-panel live-webhooks-panel">
    <div className="live-panel-heading"><div><h2>Webhooks</h2><p>Send signed event notifications to your own HTTPS endpoints. Every attempt is recorded and failed deliveries retry automatically.</p></div><button className="btn btn-secondary" disabled={busy} onClick={() => { setFormError(''); clearError(); setDraft({ name: '', url: '', events: ['subscriber.created'] }); }}><Plus size={15} />Add endpoint</button></div>
    {secret && <div className="card live-key-reveal"><div className="live-panel-heading"><h2>Signing secret for {secret.endpoint}</h2><button className="icon-btn" aria-label="Dismiss signing secret" onClick={() => setSecret(null)}><X size={17} /></button></div><p>Shown once. Verify the <code>webhook-signature</code> header: HMAC-SHA256 of <code>timestamp.body</code> with this secret.</p><code>{secret.value}</code><button className="btn btn-secondary" onClick={() => void navigator.clipboard.writeText(secret.value).then(() => onNotice('Signing secret copied.')).catch(() => onError(new Error('Could not copy. Select and copy the secret manually.')))}>Copy secret</button></div>}
    {endpoints.length ? <div className="live-table-wrap"><table className="live-table"><thead><tr><th>Endpoint</th><th>Events</th><th>Status</th><th /></tr></thead><tbody>{endpoints.map(endpoint => <tr key={endpoint.id}>
      <td><strong className="live-block">{endpoint.name}</strong><small className="live-block live-url">{endpoint.url}</small></td>
      <td>{endpoint.events.includes('*') ? 'All events' : endpoint.events.length <= 2 ? endpoint.events.join(', ') : `${endpoint.events.slice(0, 2).join(', ')} +${endpoint.events.length - 2}`}</td>
      <td><label className="live-switch"><input type="checkbox" checked={endpoint.enabled} disabled={busy} aria-label={`${endpoint.enabled ? 'Disable' : 'Enable'} ${endpoint.name}`} onChange={event => { const enabled = event.target.checked; void perform(async () => replace(await api<WebhookEndpoint>(`/webhooks/${encodeURIComponent(endpoint.id)}`, { method: 'PATCH', body: { enabled, version: endpoint.version } })), enabled ? 'Webhook endpoint enabled.' : 'Webhook endpoint paused.', false); }} /><span>{endpoint.enabled ? 'Active' : 'Paused'}</span></label></td>
      <td><div className="live-row-actions">
        <button className="icon-btn" disabled={busy} aria-label={`Delivery history for ${endpoint.name}`} title="Delivery history" onClick={() => void openHistory(endpoint)}><History size={15} /></button>
        <button className="icon-btn" disabled={busy} aria-label={`Rotate secret for ${endpoint.name}`} title="Rotate signing secret" onClick={() => { if (window.confirm(`Rotate the signing secret for ${endpoint.name}? Deliveries are signed with the new secret immediately.`)) void perform(async () => { const result = await api<{ secret: string }>(`/webhooks/${encodeURIComponent(endpoint.id)}/rotate-secret`, { method: 'POST', body: {} }); setSecret({ endpoint: endpoint.name, value: result.secret }); await load(); }, 'Signing secret rotated.', false); }}><KeyRound size={15} /></button>
        <button className="icon-btn" disabled={busy} aria-label={`Edit ${endpoint.name}`} title="Edit" onClick={() => { setFormError(''); clearError(); setDraft({ id: endpoint.id, version: endpoint.version, name: endpoint.name, url: endpoint.url, events: endpoint.events }); }}><PenLine size={15} /></button>
        <button className="icon-btn" disabled={busy} aria-label={`Delete ${endpoint.name}`} title="Delete" onClick={() => { if (window.confirm(`Delete the ${endpoint.name} endpoint? Queued deliveries to it will stop.`)) void perform(async () => { await api(`/webhooks/${encodeURIComponent(endpoint.id)}`, { method: 'DELETE' }); setEndpoints(previous => previous.filter(item => item.id !== endpoint.id)); }, 'Webhook endpoint deleted.', false); }}><Trash2 size={15} /></button>
      </div></td>
    </tr>)}</tbody></table></div> : loading ? <div className="live-loading"><RefreshCw className="live-spin" size={18} />Loading webhooks…</div> : <div className="live-empty live-empty-compact"><Webhook size={26} /><h3>No endpoints yet.</h3><p>Add an HTTPS endpoint to react to new subscribers, sends, orders and more.</p></div>}

    {draft && <Dialog wide error={formError || error} title={draft.id ? 'Edit webhook endpoint' : 'Add a webhook endpoint'} onClose={() => !busy && setDraft(null)}>
      <form onSubmit={save}>
        <label className="form-field">Name<input className="field" required maxLength={160} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="CRM sync" /></label>
        <label className="form-field">Endpoint URL<input className="field" type="url" required maxLength={2048} value={draft.url} onChange={event => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/webhooks/newsletter" /><small>Public HTTPS only. Private networks and redirects are rejected.</small></label>
        <fieldset className="live-event-picker"><legend>Events</legend>
          <label className="live-event-all"><input type="checkbox" checked={allEvents} onChange={event => setDraft({ ...draft, events: event.target.checked ? ['*'] : [] })} />All events, including ones added later</label>
          {!allEvents && WEBHOOK_EVENTS.map(group => <div key={group.group} className="live-event-group"><strong>{group.group}</strong><div className="live-scope-grid">{group.events.map(name => <label key={name}><input type="checkbox" checked={draft.events.includes(name)} onChange={event => toggleEvent(name, event.target.checked)} />{name}</label>)}</div></div>)}
        </fieldset>
        <button className="btn btn-primary live-full" disabled={busy}>{draft.id ? 'Save endpoint' : 'Create endpoint'}</button>
      </form>
    </Dialog>}

    {history && <Dialog wide error={error} title={`Deliveries to ${history.endpoint.name}`} onClose={() => setHistory(null)}>
      <div className="live-panel-heading live-history-heading"><p>The 25 most recent attempts. Receivers should use the <code>webhook-id</code> header to ignore duplicates.</p><button className="btn btn-secondary" disabled={busy} onClick={() => void openHistory(history.endpoint)}><RefreshCw size={14} />Refresh</button></div>
      {history.deliveries.length ? <div className="live-table-wrap"><table className="live-table"><thead><tr><th>Attempt</th><th>Result</th><th>When</th><th /></tr></thead><tbody>{history.deliveries.map(delivery => <tr key={delivery.id}><td>#{delivery.attempt}<small className="live-block">Event {delivery.eventId.slice(0, 8)}</small></td><td><span className={`badge ${delivery.status === 'failed' ? 'live-badge-error' : 'live-badge-success'}`}>{delivery.status === 'failed' ? 'Failed' : 'Delivered'}{delivery.statusCode ? ` · ${delivery.statusCode}` : ''}</span>{delivery.error && <small className="live-block">{delivery.error}</small>}</td><td>{formatDateTime(delivery.attemptedAt)}</td><td>{delivery.status === 'failed' && <button className="btn btn-secondary" disabled={busy || !history.endpoint.enabled} title={history.endpoint.enabled ? 'Queue this event again' : 'Enable the endpoint to retry'} onClick={() => void perform(async () => { await api(`/webhook-deliveries/${encodeURIComponent(delivery.id)}/retry`, { method: 'POST', body: {} }); }, 'Retry queued. The worker delivers it on its next run.', false)}><RotateCcw size={14} />Retry</button>}</td></tr>)}</tbody></table></div> : <p className="live-empty-copy">No delivery attempts yet. Attempts appear after a subscribed event happens and the worker runs.</p>}
    </Dialog>}
  </section>;
}
