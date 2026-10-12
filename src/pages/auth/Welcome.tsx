import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui';
import { LANGUAGES } from '../../lib/types';
import { useAuth } from '../../state/auth';
import { useWorkspace } from '../../state/workspace';

export default function Welcome() {
  const ws = useWorkspace();
  const auth = useAuth();
  const navigate = useNavigate();

  return (
    <div className="welcome on-dark">
      <div className="blob a" aria-hidden="true" />
      <div className="blob b" aria-hidden="true" />
      <div className="welcome-inner">
        <div className="logo-tile" aria-hidden="true">🛒</div>
        <div className="stack-sm" style={{ alignItems: 'center' }}>
          <h1>Vendora</h1>
          <span className="tagline-pill">AI Business Assistant for Traders</span>
        </div>
        <p className="lede">Talk to Vendora. It handles the rest.</p>

        <div className="stack-sm" style={{ width: '100%' }}>
          <div className="choose" id="lang-label">Choose your language</div>
          <div className="lang-chips" role="group" aria-labelledby="lang-label">
            {LANGUAGES.map((l) => (
              <button key={l.code} className="chip on-dark" aria-pressed={ws.language === l.code} onClick={() => void ws.setLanguage(l.code)} lang={l.code === 'pcm' ? 'pcm' : l.code}>
                {l.label}
              </button>
            ))}
          </div>
          {['yo', 'ig', 'ha'].includes(ws.language) && (
            <p className="xs" style={{ color: 'var(--on-dark-muted)' }}>
              Screens are in English. Voice understanding for this language is basic for now — you can always type or check the words.
            </p>
          )}
        </div>

        <div className="stack" style={{ width: '100%', marginTop: 'var(--s-4)' }}>
          {auth.configured ? (
            <>
              <Button variant="cta" size="lg" block onClick={() => navigate('/signup')}>Get Started →</Button>
              <p className="auth-link">Already have an account? <Link to="/signin">Sign in</Link></p>
              <p className="auth-link">Just looking? <button onClick={() => { ws.enterDemo(ws.language); navigate('/'); }}>Try the demo shop</button></p>
            </>
          ) : (
            <>
              <Button variant="cta" size="lg" block onClick={() => { ws.enterDemo(ws.language); navigate('/'); }}>Try the demo shop →</Button>
              <div className="config-note" role="note">
                Accounts are not switched on yet because this copy of Vendora is not connected to its database.
                The demo shop works fully, with sample data kept only in this browser tab.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
