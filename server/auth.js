// Google sign-in, limited to one Workspace domain. Sessions are a signed cookie,
// so the app keeps no session store and runs fine on Cloud Run.

import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

const COOKIE = 'td_session';
const SESSION_HOURS = 12;

export function createAuth({ clientId, allowedDomain, sessionSecret, disabled }) {
  const google = clientId ? new OAuth2Client(clientId) : null;
  const secret = sessionSecret || crypto.randomBytes(32).toString('hex');
  const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

  function readSession(req) {
    const raw = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!raw) return null;
    const [data, sig] = raw.split('.');
    if (!data || !sig) return null;
    const expected = sign(data);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const session = JSON.parse(Buffer.from(data, 'base64url').toString());
    return session.exp > Date.now() ? session : null;
  }

  function writeSession(res, user) {
    const data = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + SESSION_HOURS * 3600_000 })).toString('base64url');
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${data}.${sign(data)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`);
  }

  return {
    config: (req, res) => res.json({ clientId: clientId ?? null, disabled: Boolean(disabled), user: disabled ? { email: 'demo@toydoctorinc.com', name: 'Demo' } : readSession(req) }),

    async signIn(req, res) {
      if (disabled) return res.json({ ok: true });
      try {
        const ticket = await google.verifyIdToken({ idToken: req.body?.credential, audience: clientId });
        const p = ticket.getPayload();
        const domainOk = p.hd === allowedDomain && p.email_verified && p.email.toLowerCase().endsWith(`@${allowedDomain}`);
        if (!domainOk) return res.status(403).json({ error: `Please sign in with your @${allowedDomain} account.` });
        writeSession(res, { email: p.email.toLowerCase(), name: p.name ?? p.email });
        res.json({ ok: true });
      } catch {
        res.status(401).json({ error: 'Google sign-in could not be verified.' });
      }
    },

    signOut(req, res) {
      res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      res.json({ ok: true });
    },

    require(req, res, next) {
      if (disabled) { req.user = { email: 'demo@toydoctorinc.com', name: 'Demo' }; return next(); }
      const s = readSession(req);
      if (!s) return res.status(401).json({ error: 'Not signed in' });
      req.user = s; next();
    },
  };
}
