import type { PostMetrics } from '../backend';
import { formatNumber, formatPercent, share, ShareBar } from './ui';

export default function PostPerformance({ metrics }: { metrics: PostMetrics }) {
  const rows: { label: string; value: number; rate?: number; note: string }[] = [
    { label: 'Confirmed delivered', value: metrics.delivered, rate: share(metrics.delivered, metrics.accepted), note: 'Signed delivery events from your email provider' },
    { label: 'Unique opens', value: metrics.uniqueOpens, rate: share(metrics.uniqueOpens, metrics.accepted), note: 'Can include mailbox privacy proxies' },
    { label: 'Unique clicks', value: metrics.uniqueClicks, rate: share(metrics.uniqueClicks, metrics.accepted), note: `${formatNumber(metrics.botClicks)} security-scanner clicks excluded` },
    { label: 'Bounced', value: metrics.bounced, rate: share(metrics.bounced, metrics.accepted), note: 'Hard bounces are suppressed automatically' },
    { label: 'Complaints', value: metrics.complained, rate: share(metrics.complained, metrics.accepted), note: 'Complaining readers are unsubscribed' },
  ];
  if (!metrics.accepted) return <div className="live-empty live-performance-empty"><h3>No delivery results yet.</h3><p>Numbers appear once the email provider accepts this send and reports signed events.</p></div>;
  return <div className="live-performance">
    <div className="live-performance-total"><strong>{formatNumber(metrics.accepted)}</strong><span>emails accepted by the provider</span></div>
    <ul className="live-share-list">{rows.map(row => <li key={row.label}><span><strong>{row.label}</strong><small>{formatNumber(row.value)} · {formatPercent(row.rate)} — {row.note}</small></span><ShareBar value={row.rate || 0} label={row.label} /></li>)}</ul>
    <p className="live-muted-note">Rates use accepted emails as the base. Refreshing this view recalculates from stored provider events.</p>
  </div>;
}
