import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { retentionClasses, type DataPolicy, type SessionView } from '@astrama/contracts';
import { api } from './api';
import i18n from './i18n';

const messages = { title: 'Data and attachment policy', intro: 'Changes apply to future uploads. Existing files remain available. Every upload is privately stored and security scanned.', file: 'Maximum file size (MiB; infrastructure maximum 5)', count: 'Maximum attachments per ticket', total: 'Maximum combined size per ticket (MiB)', extensions: 'Allowed filename extensions (comma separated; empty allows all scanned formats)', hold: 'Legal hold: block all retention and organisation deletion', retention: 'Retention', retentionHelp: 'Leave days empty to disable. A trusted operator must preview and explicitly execute retention. Whole terminal tickets and associated files/history are removed only after every class period has elapsed; the longest period wins. Any hold blocks deletion. Accounts are removed only through the separate operator organisation deletion process. Backup expiry is managed separately by the deployment owner.', days: 'Retention days (empty disables)', classHold: 'Legal hold for this record class', tickets: 'Tickets and messages', attachments: 'Attachment objects', audits: 'Ticket audit history', save: 'Save data policy', saved: 'Data policy saved', loading: 'Loading data policy...', operator: 'Full organisation export and deletion require a trusted operator with a reason and customer authorization reference. Organisation settings do not grant access to ticket content.' };
i18n.addResourceBundle('en', 'dataPolicy', messages, true, false);

export function DataPolicyPanel({ session }: { session: SessionView }) {
  const { t } = useTranslation('dataPolicy'), cache = useQueryClient();
  const policy = useQuery({ queryKey: ['data-policy'], queryFn: () => api<DataPolicy>('/admin/data-policy') });
  const [draft, setDraft] = useState<DataPolicy | null>(null), [extensions, setExtensions] = useState<string | null>(null);
  const save = useMutation({ mutationFn: (value: DataPolicy) => api<DataPolicy>('/admin/data-policy', { method: 'POST', body: JSON.stringify(value) }, session.csrfToken), onSuccess: value => { cache.setQueryData(['data-policy'], value); setDraft(null); setExtensions(null); } });
  const value = draft ?? policy.data;
  if (!value) return <p role={policy.error ? 'alert' : 'status'}>{policy.error instanceof Error ? policy.error.message : t('loading')}</p>;
  const attachment = (key: 'maxFileBytes' | 'maxFilesPerTicket' | 'maxTotalBytes', number: number) => setDraft({ ...value, attachments: { ...value.attachments, [key]: number } });
  return <section className="form-panel"><h2>{t('title')}</h2><p className="muted">{t('intro')}</p><form className="config-form" onSubmit={event => { event.preventDefault(); save.mutate({ ...value, attachments: { ...value.attachments, allowedExtensions: extensions === null ? value.attachments.allowedExtensions : extensions.split(',').map(part => part.trim().toLowerCase().replace(/^\./, '')).filter(Boolean) } }); }}>
    <fieldset disabled={save.isPending}><label>{t('file')}<input type="number" min={1 / 1048576} max="5" step="any" required value={value.attachments.maxFileBytes / 1048576} onChange={e => attachment('maxFileBytes', Math.round(Number(e.target.value) * 1048576))} /></label>
      <label>{t('count')}<input type="number" min="1" max="100" required value={value.attachments.maxFilesPerTicket} onChange={e => attachment('maxFilesPerTicket', Number(e.target.value))} /></label>
      <label>{t('total')}<input type="number" min={1 / 1048576} max="500" step="any" required value={value.attachments.maxTotalBytes / 1048576} onChange={e => attachment('maxTotalBytes', Math.round(Number(e.target.value) * 1048576))} /></label>
      <label>{t('extensions')}<input value={extensions ?? value.attachments.allowedExtensions.join(', ')} onChange={e => setExtensions(e.target.value)} /></label>
      <label className="checkbox-label"><input type="checkbox" checked={value.legalHold} onChange={e => setDraft({ ...value, legalHold: e.target.checked })} />{t('hold')}</label>
      <h3>{t('retention')}</h3><p className="muted">{t('retentionHelp')}</p>
      {retentionClasses.map(kind => <fieldset key={kind}><legend>{t(kind)}</legend><label>{t('days')}<input type="number" min="1" max="36500" value={value.retention[kind].days ?? ''} onChange={e => setDraft({ ...value, retention: { ...value.retention, [kind]: { ...value.retention[kind], days: e.target.value === '' ? null : Number(e.target.value) } } })} /></label><label className="checkbox-label"><input type="checkbox" checked={value.retention[kind].legalHold} onChange={e => setDraft({ ...value, retention: { ...value.retention, [kind]: { ...value.retention[kind], legalHold: e.target.checked } } })} />{t('classHold')}</label></fieldset>)}
      <button className="button primary" type="submit">{t('save')}</button>
    </fieldset>
    {save.error instanceof Error && <p role="alert">{save.error.message}</p>}{save.isSuccess && <p role="status">{t('saved')}</p>}
  </form><p className="muted">{t('operator')}</p></section>;
}

