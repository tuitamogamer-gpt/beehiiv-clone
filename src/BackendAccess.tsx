import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, Database, LockKeyhole, Mail, RefreshCw, ShieldCheck } from 'lucide-react';
import { BeeMark } from './components/Brand';
import { api, BackendError, errorMessage, getStatus, type Account, type Capabilities } from './backend';
import BackendWorkspace from './BackendWorkspace';
import './backend.css';

export function ServiceStatus({ capabilities, loading = false }: { capabilities: Capabilities | null; loading?: boolean }) {
  const rows = [
    ['Database', !!capabilities && capabilities.database !== 'not_configured', capabilities?.database === 'sqlite' ? 'Local SQLite' : 'PostgreSQL'],
    ['Account security', capabilities?.authentication, 'Configured'],
    ['Email delivery', capabilities?.email, 'Configured'],
    ['Scheduled jobs', capabilities?.scheduler, 'Configured'],
    ['Payments', capabilities?.payments, 'Configured'],
    ['Signup protection', capabilities?.botProtection, 'Configured'],
    ['Media storage', capabilities?.media, 'Configured'],
    ['AI tools', capabilities?.ai, 'Configured'],
  ] as const;
  return <div className="live-service-list">{rows.map(([label, configured, ready]) => <div key={label}><span>{label}</span><span className={configured ? 'live-service-ready' : 'live-service-missing'}>{loading ? 'Checking…' : configured ? <><Check size={12} />{ready}</> : 'Needs setup'}</span></div>)}</div>;
}

export default function BackendAccess({ onDemo }: { onDemo: () => void }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [method, setMethod] = useState<'password' | 'magic' | 'invite'>('password');
  const [tokens] = useState(() => ({ magic: new URLSearchParams(location.search).get('magic_token'), invitation: new URLSearchParams(location.search).get('invitation_token') }));
  const [invitation, setInvitation] = useState(tokens.invitation);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    document.title = 'beehiiv — Your live workspace';
    if (tokens.magic || tokens.invitation) {
      const clean = new URL(location.href);
      clean.searchParams.delete('magic_token'); clean.searchParams.delete('invitation_token');
      history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
    }
    void (async () => {
      const [status, session] = await Promise.allSettled([getStatus(), tokens.magic ? api<Account>('/auth/magic-link/verify', { body: { token: tokens.magic } }) : api<Account>('/auth/me')]);
      if (status.status === 'fulfilled') setCapabilities(status.value);
      if (session.status === 'fulfilled') setAccount(session.value);
      else if (tokens.magic || !(session.reason instanceof BackendError) || session.reason.status !== 401) setError(errorMessage(session.reason));
      if (status.status === 'rejected' && session.status === 'rejected' && !tokens.magic) setError(errorMessage(status.reason));
      if (tokens.invitation) setMethod('invite');
      setLoading(false);
    })();
  }, [tokens]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      if (method === 'magic') {
        const result = await api<{ message: string }>('/auth/magic-link', { body: { email } });
        setNotice(result.message);
      } else if (method === 'invite' && invitation) {
        const result = await api<Account>('/team/invitations/accept', { body: { token: invitation, ...(!account ? { name, password } : {}) } });
        setAccount(result); setInvitation(null); setPassword('');
      } else {
        setAccount(await api<Account>('/auth/login', { body: { email, password } }));
        setPassword('');
        if (invitation) setMethod('invite');
      }
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }

  async function refreshStatus() {
    setBusy(true); setError('');
    try { setCapabilities(await getStatus()); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }

  if (account && !invitation) return <BackendWorkspace account={account} onAccount={setAccount} onSignedOut={() => setAccount(null)} onDemo={onDemo} />;
  return <main className="live-access">
    <section className="live-access-story"><div className="live-wordmark"><BeeMark size={32} /><strong>beehiiv<span>.</span></strong></div><div><span className="live-eyebrow">YOUR NEXT CHAPTER STARTS HERE</span><h1>Good ideas.<br />Real connections.<br /><em>Your newsletter.</em></h1><p>A home for your writing, your readers, and everything you’re building together.</p><div className="live-access-proof"><ShieldCheck size={18} /><span>Private accounts. Shared publications. Your own audience.</span></div></div><small>Already curious? <button onClick={onDemo}>Explore the demo <ArrowRight size={13} /></button></small></section>
    <section className="live-access-main"><div className="live-login-card">
      <span className="live-label"><span />LIVE WORKSPACE</span>
      <h2>{invitation && method === 'invite' ? 'You’re invited.' : 'Welcome to your workspace.'}</h2>
      <p>{invitation && method === 'invite' ? account ? `Accept this invitation as ${account.user.email}.` : 'Create an account, or enter your existing password to rejoin.' : 'Sign in to work with your publication’s saved data.'}</p>
      {error && <div className="live-alert live-alert-error" role="alert">{error}</div>}
      {notice && <div className="live-alert live-alert-success" role="status">{notice}</div>}
      {loading ? <div className="live-loading"><RefreshCw size={19} className="live-spin" />Checking your session…</div> : <form onSubmit={submit}>
        {method === 'invite' && invitation ? !account && <><label className="form-field">Your name<input className="field" autoComplete="name" required value={name} onChange={event => setName(event.target.value)} maxLength={120} /></label><label className="form-field">Your password<input className="field" type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={password} onChange={event => setPassword(event.target.value)} /><small>Use at least 12 characters for a new account, or your existing password.</small></label></> : <><label className="form-field">Email address<input className="field" type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></label>{method === 'password' && <label className="form-field">Password<input className="field" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>}</>}
        <button className="btn btn-primary live-full" disabled={busy}>{busy ? 'Please wait…' : method === 'invite' ? 'Accept invitation' : method === 'magic' ? 'Email me a sign-in link' : 'Sign in'}<ArrowRight size={16} /></button>
        <div className="live-auth-alternatives">{method === 'invite' ? <button type="button" onClick={() => { setMethod('password'); setError(''); }}>I already have an account</button> : <button type="button" onClick={() => { setMethod(method === 'password' ? 'magic' : 'password'); setError(''); }}>{method === 'password' ? <><Mail size={14} />Use a magic link instead</> : <><LockKeyhole size={14} />Sign in with a password</>}</button>}{invitation && method !== 'invite' && <button type="button" onClick={() => setMethod('invite')}>Return to invitation</button>}</div>
      </form>}
      <details className="live-setup" open={!!capabilities && !capabilities.authentication}><summary><Database size={15} />Workspace service status</summary><ServiceStatus capabilities={capabilities} loading={loading} />{capabilities && !capabilities.authentication && <p>Ask your workspace administrator to finish database and account setup before signing in.</p>}<button className="live-text-button" onClick={refreshStatus} disabled={busy}><RefreshCw size={13} />Check again</button></details>
      <div className="live-access-footer">No account yet? Ask your publication administrator for an invitation.</div>
    </div></section>
  </main>;
}
