import { useEffect, useState } from 'react';
import { BarChart3, Globe, Inbox, Mail, MousePointerClick, RefreshCw, Users, Wallet } from 'lucide-react';
import { api, type AnalyticsSummary } from '../backend';
import { formatDateTime, formatMinorCurrency, formatNumber, formatPercent, share, ShareBar } from './ui';

type Props = { publicationId: string; onError: (error: unknown) => void };

export default function AnalyticsView({ publicationId, onError }: Props) {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);

  async function load(signal?: AbortSignal) {
    setLoading(true);
    try { setSummary(await api<AnalyticsSummary>('/analytics/summary', { signal })); }
    catch (error) { if (!(error instanceof Error && error.name === 'AbortError')) onError(error); }
    finally { if (!signal?.aborted) setLoading(false); }
  }
  useEffect(() => { const controller = new AbortController(); setSummary(null); void load(controller.signal); return () => controller.abort(); }, [publicationId]);

  const heading = <div className="live-heading"><div><span className="live-eyebrow">NUMBERS WITH A STORY BEHIND THEM</span><h1>See what’s resonating.</h1><p>Every figure comes from records saved for this publication. Nothing is estimated or borrowed from the demo.</p></div><button className="btn btn-secondary" disabled={loading} onClick={() => void load()}><RefreshCw size={15} className={loading ? 'live-spin' : ''} />Refresh</button></div>;
  if (!summary) return <>{heading}{loading ? <div className="live-loading"><RefreshCw className="live-spin" size={22} />Gathering your numbers…</div> : <section className="card live-empty"><BarChart3 size={30} /><h3>Analytics couldn’t be loaded.</h3><p>Check the connection and try again.</p><button className="btn btn-secondary" onClick={() => void load()}>Try again</button></section>}</>;

  const { subscribers, email, commerce, website } = summary;
  const sources = Object.entries(subscribers.bySource).sort((a, b) => b[1] - a[1]);
  const domains = Object.entries(email.byMailboxDomain).sort((a, b) => b[1].accepted - a[1].accepted).slice(0, 8);
  const revenue = Object.entries(commerce.revenueByCurrency).filter(([, amount]) => amount > 0);
  const metrics = [
    { label: 'Active subscribers', value: formatNumber(subscribers.active), detail: `${formatNumber(subscribers.total)} total · ${formatNumber(subscribers.premium)} premium`, icon: Users },
    { label: 'Emails accepted', value: formatNumber(email.accepted), detail: email.deliveryRate === null ? 'Delivery confirmations appear after signed provider events' : `${formatPercent(email.deliveryRate)} confirmed delivered`, icon: Mail },
    { label: 'Unique open rate', value: formatPercent(email.openRate), detail: `${formatNumber(email.uniqueOpens)} readers opened · privacy proxies included`, icon: Inbox },
    { label: 'Unique click rate', value: formatPercent(email.clickRate), detail: `${formatNumber(email.uniqueClicks)} readers clicked · ${formatNumber(email.botClicks)} scanner clicks excluded`, icon: MousePointerClick },
    { label: 'Website visits', value: formatNumber(website.recordedVisits), detail: 'First-party page requests, unfiltered bots included', icon: Globe },
    { label: 'Paid orders', value: formatNumber(commerce.paidOrders), detail: revenue.length ? revenue.map(([currency, amount]) => formatMinorCurrency(amount, currency)).join(' · ') : 'No confirmed revenue yet', icon: Wallet },
  ];

  return <>
    {heading}
    <div className="live-metric-grid">{metrics.map(metric => <div className="card live-metric" key={metric.label}><span>{metric.label}<metric.icon size={18} /></span><strong>{metric.value}</strong><small>{metric.detail}</small></div>)}</div>
    <div className="live-analytics-grid">
      <section className="card live-panel">
        <div className="live-panel-heading"><div><h2>Where readers come from</h2><p>Acquisition source saved with each subscriber.</p></div></div>
        {sources.length ? <ul className="live-share-list">{sources.slice(0, 10).map(([source, count]) => <li key={source}><span><strong>{source}</strong><small>{formatNumber(count)} · {formatPercent(share(count, subscribers.total))}</small></span><ShareBar value={share(count, subscribers.total)} label={source} /></li>)}</ul> : <p className="live-empty-copy">Sources appear as readers subscribe or are imported.</p>}
      </section>
      <section className="card live-panel">
        <div className="live-panel-heading"><div><h2>Inbox health</h2><p>Provider events by recipient mailbox domain.</p></div></div>
        {domains.length ? <div className="live-table-wrap"><table className="live-table"><thead><tr><th>Domain</th><th>Accepted</th><th>Delivered</th><th>Bounced</th><th>Complaints</th></tr></thead><tbody>{domains.map(([domain, stats]) => <tr key={domain}><td><strong>{domain}</strong></td><td>{formatNumber(stats.accepted)}</td><td>{formatNumber(stats.delivered)}</td><td>{formatNumber(stats.bounced)}</td><td>{formatNumber(stats.complained)}</td></tr>)}</tbody></table></div> : <p className="live-empty-copy">Delivery results appear after your first send is accepted by the email provider.</p>}
        <div className="live-inline-stats"><span>Bounces <strong>{formatNumber(email.bounces)}</strong></span><span>Complaints <strong>{formatNumber(email.complaints)}</strong></span></div>
      </section>
    </div>
    <section className="card live-panel live-limitations">
      <h2>Reading these numbers</h2>
      <ul>{summary.limitations.map(item => <li key={item}>{item}</li>)}<li>Revenue counts confirmed charges less recorded refunds, before processor fees.</li></ul>
      <p className="live-muted-note">Calculated {formatDateTime(summary.asOf)}.</p>
    </section>
  </>;
}
