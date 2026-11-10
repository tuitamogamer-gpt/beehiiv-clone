import { useEffect, useState, type FormEvent } from 'react';
import { Download, Eye, Filter, PenLine, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { api, type LiveSubscriber, type Page, type Segment, type SegmentCondition, type SegmentOperator } from '../backend';
import { Dialog, formatDateTime, formatNumber, type Perform } from './ui';

type FieldKind = 'text' | 'enum' | 'tags' | 'number';
type FieldOption = { value: string; label: string; kind: FieldKind; choices?: string[] };
const FIELDS: FieldOption[] = [
  { value: 'status', label: 'Status', kind: 'enum', choices: ['Active', 'Pending', 'Unsubscribed'] },
  { value: 'tier', label: 'Tier', kind: 'enum', choices: ['Free', 'Premium'] },
  { value: 'source', label: 'Source', kind: 'text' },
  { value: 'tags', label: 'Tags', kind: 'tags' },
  { value: 'email', label: 'Email', kind: 'text' },
  { value: 'name', label: 'Name', kind: 'text' },
  { value: 'joined', label: 'Join date (YYYY-MM-DD)', kind: 'text' },
  { value: 'openCount', label: 'Opens', kind: 'number' },
  { value: 'clickCount', label: 'Clicks', kind: 'number' },
  { value: 'sentCount', label: 'Emails received', kind: 'number' },
  { value: 'openRate', label: 'Open rate (%)', kind: 'number' },
  { value: 'custom', label: 'Custom field…', kind: 'text' },
];
const OPERATORS: Record<FieldKind, { value: SegmentOperator; label: string }[]> = {
  enum: [{ value: 'equals', label: 'is' }, { value: 'not_equals', label: 'is not' }],
  text: [{ value: 'equals', label: 'is exactly' }, { value: 'not_equals', label: 'is not' }, { value: 'contains', label: 'contains' }, { value: 'not_contains', label: 'does not contain' }, { value: 'is_set', label: 'is set' }, { value: 'not_set', label: 'is empty' }],
  tags: [{ value: 'contains', label: 'include' }, { value: 'not_contains', label: 'do not include' }, { value: 'is_set', label: 'are not empty' }, { value: 'not_set', label: 'are empty' }],
  number: [{ value: 'greater_than', label: 'is more than' }, { value: 'less_than', label: 'is less than' }, { value: 'equals', label: 'equals' }, { value: 'not_equals', label: 'does not equal' }],
};
const CUSTOM_OPERATORS: { value: SegmentOperator; label: string }[] = [...OPERATORS.text, { value: 'greater_than', label: 'is more than (number)' }, { value: 'less_than', label: 'is less than (number)' }];
const CUSTOM_KEY = /^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/;

type Row = { field: string; customKey: string; operator: SegmentOperator; value: string };
type Draft = { id?: string; version?: number; type: 'dynamic' | 'static'; name: string; match: 'all' | 'any'; rows: Row[] };

const fieldOption = (field: string) => FIELDS.find(option => option.value === field) || FIELDS[FIELDS.length - 1];
const operatorsFor = (row: Row) => row.field === 'custom' ? CUSTOM_OPERATORS : OPERATORS[fieldOption(row.field).kind];
const needsValue = (operator: SegmentOperator) => operator !== 'is_set' && operator !== 'not_set';
const blankRow = (): Row => ({ field: 'tags', customKey: '', operator: 'contains', value: '' });
const toRow = (condition: SegmentCondition): Row => condition.field.startsWith('customFields.')
  ? { field: 'custom', customKey: condition.field.slice(13), operator: condition.operator, value: condition.value === null || condition.value === undefined ? '' : String(condition.value) }
  : { field: condition.field, customKey: '', operator: condition.operator, value: condition.value === null || condition.value === undefined ? '' : String(condition.value) };

function toCondition(row: Row): SegmentCondition {
  const field = row.field === 'custom' ? `customFields.${row.customKey.trim()}` : row.field;
  if (row.field === 'custom' && !CUSTOM_KEY.test(row.customKey.trim())) throw new Error('Custom field names start with a letter and use letters, numbers, dashes or underscores.');
  if (!needsValue(row.operator)) return { field, operator: row.operator };
  const numeric = row.operator === 'greater_than' || row.operator === 'less_than' || (row.field !== 'custom' && fieldOption(row.field).kind === 'number');
  if (numeric) {
    const value = Number(row.value);
    if (row.value.trim() === '' || !Number.isFinite(value)) throw new Error(`Enter a number for “${row.field === 'custom' ? row.customKey : fieldOption(row.field).label}”.`);
    return { field, operator: row.operator, value };
  }
  if (!row.value.trim()) throw new Error(`Enter a value for “${row.field === 'custom' ? row.customKey || 'custom field' : fieldOption(row.field).label}”.`);
  return { field, operator: row.operator, value: row.value.trim() };
}

export function describeCondition(condition: SegmentCondition) {
  const custom = condition.field.startsWith('customFields.');
  const option = custom ? null : fieldOption(condition.field);
  const operators = custom ? CUSTOM_OPERATORS : OPERATORS[option!.kind];
  const label = custom ? condition.field.slice(13) : option!.label;
  const verb = operators.find(item => item.value === condition.operator)?.label || condition.operator.replace('_', ' ');
  return needsValue(condition.operator) ? `${label} ${verb} ${String(condition.value)}` : `${label} ${verb}`;
}

type Props = { publicationId: string; isAdmin: boolean; busy: boolean; perform: Perform; onError: (error: unknown) => void; error: string; clearError: () => void };

export default function SegmentsPanel({ publicationId, isAdmin, busy, perform, onError, error, clearError }: Props) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState('');
  const [preview, setPreview] = useState<{ segment: Segment; members: LiveSubscriber[]; more: boolean } | null>(null);

  async function load(next?: string) {
    setLoading(true);
    try {
      const page = await api<Page<Segment>>(`/segments${next ? `?cursor=${encodeURIComponent(next)}` : ''}`);
      setSegments(previous => next ? [...previous, ...page.items] : page.items); setCursor(page.nextCursor);
    } catch (error) { onError(error); } finally { setLoading(false); }
  }
  useEffect(() => { setSegments([]); setDraft(null); setPreview(null); void load(); }, [publicationId]);
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) { setDraft(null); setPreview(null); } }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [busy]);

  const replace = (segment: Segment) => setSegments(previous => previous.some(item => item.id === segment.id) ? previous.map(item => item.id === segment.id ? segment : item) : [segment, ...previous]);
  const recalculate = (segment: Segment, message = 'Segment recalculated.') => perform(async () => replace(await api<Segment>(`/segments/${encodeURIComponent(segment.id)}/recalculate`, { method: 'POST', body: {} })), message, false);

  function save(event: FormEvent) {
    event.preventDefault(); setFormError('');
    if (!draft) return;
    let conditions: SegmentCondition[] = [];
    try {
      if (draft.type === 'dynamic') {
        if (!draft.rows.length) throw new Error('Add at least one condition.');
        conditions = draft.rows.map(toCondition);
      }
    } catch (error) { setFormError(error instanceof Error ? error.message : 'Check the conditions.'); return; }
    const current = draft;
    void perform(async () => {
      const body = current.type === 'dynamic' ? { name: current.name.trim(), match: current.match, conditions } : { name: current.name.trim() };
      const saved = await api<Segment>(current.id ? `/segments/${encodeURIComponent(current.id)}` : '/segments', { method: current.id ? 'PATCH' : 'POST', body: current.id ? { ...body, version: current.version } : { ...body, type: 'dynamic' } });
      // Counts are calculated on request, so refresh right away for an accurate member total.
      replace(saved.type === 'dynamic' ? await api<Segment>(`/segments/${encodeURIComponent(saved.id)}/recalculate`, { method: 'POST', body: {} }) : saved);
      setDraft(null);
    }, current.id ? 'Segment saved.' : 'Segment created.', false);
  }

  function updateRow(index: number, patch: Partial<Row>) {
    setDraft(previous => {
      if (!previous) return previous;
      const rows = previous.rows.map((row, position) => {
        if (position !== index) return row;
        const next = { ...row, ...patch };
        if (patch.field !== undefined) { const allowed = operatorsFor(next); next.operator = allowed[0].value; next.value = fieldOption(next.field).choices?.[0] || ''; }
        return next;
      });
      return { ...previous, rows };
    });
  }

  return <section className="card live-panel live-segments-panel">
    <div className="live-panel-heading"><div><h2>Segments</h2><p>Group readers by status, tags, engagement or custom fields. Members are calculated from live records.</p></div><button className="btn btn-secondary" disabled={busy} onClick={() => { setFormError(''); clearError(); setDraft({ type: 'dynamic', name: '', match: 'all', rows: [blankRow()] }); }}><Plus size={15} />New segment</button></div>
    {segments.length ? <div className="live-table-wrap"><table className="live-table"><thead><tr><th>Segment</th><th>Members</th><th>Last calculated</th><th /></tr></thead><tbody>{segments.map(segment => <tr key={segment.id}>
      <td><strong className="live-block">{segment.name}</strong><small className="live-block">{segment.type === 'static' ? `Static list · ${formatNumber((segment.subscriberIds || []).length)} chosen readers` : `${segment.match === 'any' ? 'Any' : 'All'} of: ${(segment.conditions || []).map(describeCondition).join(segment.match === 'any' ? ' or ' : ' and ') || 'every subscriber'}`}</small></td>
      <td>{segment.count === null ? <span className="badge">Not calculated</span> : formatNumber(segment.count)}</td>
      <td>{formatDateTime(segment.recalculatedAt)}</td>
      <td><div className="live-row-actions">
        <button className="icon-btn" disabled={busy} aria-label={`Recalculate ${segment.name}`} title="Recalculate" onClick={() => void recalculate(segment)}><RefreshCw size={15} /></button>
        <button className="icon-btn" disabled={busy} aria-label={`Preview members of ${segment.name}`} title="Preview members" onClick={() => void perform(async () => { const page = await api<Page<LiveSubscriber>>(`/segments/${encodeURIComponent(segment.id)}/subscribers?limit=25`); setPreview({ segment, members: page.items, more: Boolean(page.nextCursor) }); }, '', false)}><Eye size={15} /></button>
        {isAdmin && <a className="icon-btn" aria-label={`Export ${segment.name}`} title="Export CSV" href={`/api/segments/${encodeURIComponent(segment.id)}/export`} download={`${segment.name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'segment'}.csv`}><Download size={15} /></a>}
        <button className="icon-btn" disabled={busy} aria-label={`Edit ${segment.name}`} title="Edit" onClick={() => { setFormError(''); clearError(); setDraft({ id: segment.id, version: segment.version, type: segment.type, name: segment.name, match: segment.match, rows: (segment.conditions || []).map(toRow) }); }}><PenLine size={15} /></button>
        <button className="icon-btn" disabled={busy} aria-label={`Delete ${segment.name}`} title="Delete" onClick={() => { if (window.confirm(`Delete the “${segment.name}” segment? Subscribers are not affected.`)) void perform(async () => { await api(`/segments/${encodeURIComponent(segment.id)}`, { method: 'DELETE' }); setSegments(previous => previous.filter(item => item.id !== segment.id)); }, 'Segment deleted.', false); }}><Trash2 size={15} /></button>
      </div></td>
    </tr>)}</tbody></table></div> : loading ? <div className="live-loading"><RefreshCw className="live-spin" size={18} />Loading segments…</div> : <div className="live-empty live-empty-compact"><Filter size={26} /><h3>No segments yet.</h3><p>Create one to find engaged readers, premium members or anyone with a specific tag.</p></div>}
    {cursor && <button className="live-text-button live-load-more" disabled={loading} onClick={() => void load(cursor)}>Load more segments</button>}

    {draft && <Dialog wide error={formError || error} title={draft.id ? 'Edit segment' : 'Create a segment'} onClose={() => !busy && setDraft(null)}>
      <form onSubmit={save}>
        <label className="form-field">Segment name<input className="field" required maxLength={200} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="Engaged readers" /></label>
        {draft.type === 'static' ? <p className="live-muted-note">This static segment keeps its chosen members. Rename it here; manage members through the segments API.</p> : <>
          <label className="form-field">Readers must match<select className="field" value={draft.match} onChange={event => setDraft({ ...draft, match: event.target.value as Draft['match'] })}><option value="all">All conditions</option><option value="any">Any condition</option></select></label>
          <fieldset className="live-conditions"><legend>Conditions</legend>
            {draft.rows.map((row, index) => { const option = fieldOption(row.field); return <div className="live-condition" key={index}>
              <select className="field" aria-label={`Condition ${index + 1} field`} value={row.field} onChange={event => updateRow(index, { field: event.target.value })}>{FIELDS.map(field => <option key={field.value} value={field.value}>{field.label}</option>)}</select>
              {row.field === 'custom' && <input className="field" aria-label={`Condition ${index + 1} custom field name`} placeholder="field_name" value={row.customKey} onChange={event => updateRow(index, { customKey: event.target.value })} />}
              <select className="field" aria-label={`Condition ${index + 1} operator`} value={row.operator} onChange={event => updateRow(index, { operator: event.target.value as SegmentOperator })}>{operatorsFor(row).map(operator => <option key={operator.value} value={operator.value}>{operator.label}</option>)}</select>
              {needsValue(row.operator) && (option.choices && row.field !== 'custom'
                ? <select className="field" aria-label={`Condition ${index + 1} value`} value={row.value} onChange={event => updateRow(index, { value: event.target.value })}>{option.choices.map(choice => <option key={choice}>{choice}</option>)}</select>
                : <input className="field" aria-label={`Condition ${index + 1} value`} inputMode={option.kind === 'number' || row.operator === 'greater_than' || row.operator === 'less_than' ? 'decimal' : undefined} value={row.value} onChange={event => updateRow(index, { value: event.target.value })} placeholder={option.kind === 'number' ? '0' : 'Value'} />)}
              <button type="button" className="icon-btn" aria-label={`Remove condition ${index + 1}`} onClick={() => setDraft({ ...draft, rows: draft.rows.filter((_, position) => position !== index) })}><X size={15} /></button>
            </div>; })}
            {draft.rows.length < 50 && <button type="button" className="live-text-button" onClick={() => setDraft({ ...draft, rows: [...draft.rows, blankRow()] })}><Plus size={13} />Add condition</button>}
          </fieldset>
          <p className="live-muted-note">Text comparisons are case-insensitive for “contains” and exact for “is exactly”. Custom fields compare text unless you choose a number comparison.</p>
        </>}
        <button className="btn btn-primary live-full" disabled={busy}>{draft.id ? 'Save segment' : 'Create segment'}</button>
      </form>
    </Dialog>}

    {preview && <Dialog wide title={`Members of ${preview.segment.name}`} onClose={() => setPreview(null)}>
      {preview.members.length ? <div className="live-table-wrap"><table className="live-table"><thead><tr><th>Subscriber</th><th>Status</th><th>Tier</th></tr></thead><tbody>{preview.members.map(member => <tr key={member.id}><td><strong className="live-block">{member.name}</strong><small className="live-block">{member.email}</small></td><td><span className="badge">{member.status}</span></td><td>{member.tier}</td></tr>)}</tbody></table></div> : <p className="live-empty-copy">No subscribers match this segment right now.</p>}
      {preview.more && <p className="live-muted-note">Showing the first {preview.members.length} members.{isAdmin ? ' Export the segment for the complete list.' : ''}</p>}
    </Dialog>}
  </section>;
}
