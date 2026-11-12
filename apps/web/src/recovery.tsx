import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';
import { api } from './api';

i18n.addResourceBundle('en', 'recovery', {
  forgot: 'Forgot your password?', reset: 'Reset your password', organisation: 'Organisation', email: 'Email', password: 'New password', confirm: 'Confirm password', mismatch: 'Passwords must match',
  request: 'Send recovery link', saving: 'Please wait…', submit: 'Reset password', signIn: 'Back to sign in',
  intro: 'Enter your organisation and work email. If an active account matches, we will email a single-use link that expires in 30 minutes.',
  requested: 'If an active account matches, a recovery email is on its way. Check your inbox and spam folder.',
  hint: 'Use at least 12 characters. Your authenticator will still be required. Contact your organisation’s verified support process if you lost your authenticator.',
  done: 'Your password has been changed and all sessions have been signed out. Sign in again with your new password and authenticator.', invalid: 'This recovery link is incomplete. Request a new link.',
}, true, true);

/** Render on /forgot-password or when the initial URL starts #reset-password?. */
export function Recovery({ mode = 'forgot' }: { mode?: 'forgot' | 'reset' }) {
  const { t } = useTranslation('recovery');
  const [credentials] = useState(() => {
    const fragment=location.hash, params=new URLSearchParams(fragment.slice(fragment.indexOf('?')+1));
    return { organisation: params.get('organisation')??'', token: params.get('token')??'' };
  });
  useEffect(() => { if (mode==='reset') history.replaceState(null,'',location.pathname+location.search); }, [mode]);
  const mutation=useMutation({ mutationFn: (body: Record<string,string>) => api(`/auth/${mode==='reset'?'reset-password':'forgot-password'}`,{ method:'POST',body:JSON.stringify(body) }) });
  const valid=mode==='forgot'||(credentials.organisation && /^[A-Za-z0-9_-]{43}$/.test(credentials.token));
  return <div className="page narrow-page activation-page"><section className="form-panel">
    <h1>{t(mode==='reset'?'reset':'forgot')}</h1>
    {mutation.isSuccess ? <p role="status">{t(mode==='reset'?'done':'requested')}</p> : !valid ? <p role="alert" className="error">{t('invalid')}</p> : <>
      <p className="muted">{t(mode==='reset'?'hint':'intro')}</p>
      <form onSubmit={event=>{
        event.preventDefault(); const form=event.currentTarget, data=new FormData(form);
        if (mode==='reset') {
          const password=String(data.get('password')), confirmation=form.elements.namedItem('confirmation') as HTMLInputElement;
          confirmation.setCustomValidity(password===confirmation.value?'':t('mismatch'));
          if (form.reportValidity()) mutation.mutate({...credentials,password});
        } else mutation.mutate({organisation:String(data.get('organisation')),email:String(data.get('email'))});
      }}>
        <label>{t('organisation')}<input name="organisation" required maxLength={80} autoComplete="organization" readOnly={mode==='reset'} defaultValue={credentials.organisation}/></label>
        {mode==='forgot' ? <label>{t('email')}<input type="email" name="email" autoComplete="email" required maxLength={254}/></label> : <>
          <label>{t('password')}<input type="password" name="password" autoComplete="new-password" required minLength={12} maxLength={256}/></label>
          <label>{t('confirm')}<input type="password" name="confirmation" autoComplete="new-password" required minLength={12} maxLength={256} onChange={event=>event.target.setCustomValidity('')}/></label>
        </>}
        {mutation.error && <p role="alert" className="error">{mutation.error.message}</p>}
        <button className="button primary" disabled={mutation.isPending}>{t(mutation.isPending?'saving':mode==='reset'?'submit':'request')}</button>
      </form>
    </>}
    <a href="/">{t('signIn')}</a>
    {mode==='reset' && !mutation.isSuccess && <p><a href="/forgot-password">{t('forgot')}</a></p>}
  </section></div>;
}
