import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';
import { api } from './api';

i18n.addResourceBundle('en', 'operations', { title: 'Service health', description: 'Current checks for the shared service. Contact your service operator if a component needs attention.', refresh: 'Refresh status', healthy: 'Healthy', attention: 'Needs attention', database: 'Database', worker: 'Background worker', storage: 'File storage', scanner: 'File scanner', queue: 'Email queue', backup: 'Backup within 48 hours', loading: 'Checking service health…' });
export function OperationsPanel() {
  const { t } = useTranslation('operations');
  const query = useQuery({ queryKey: ['operations'], queryFn: () => api<{ healthy: boolean; checks: Record<string, boolean> }>('/admin/operations'), staleTime: 30000 });
  return <section className="form-panel"><h2>{t('title')}</h2><p className="muted">{t('description')}</p>{query.isPending ? <p role="status">{t('loading')}</p> : null}{query.error ? <p role="alert" className="error">{query.error.message}</p> : null}<dl>{Object.entries(query.data?.checks ?? {}).map(([name, ok]) => <div key={name}><dt>{t(name)}</dt><dd>{t(ok ? 'healthy' : 'attention')}</dd></div>)}</dl><button className="button secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{t('refresh')}</button></section>;
}
