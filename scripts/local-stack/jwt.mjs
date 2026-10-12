// Prints an HS256 API key JWT for the local stack (anon or service_role), like Supabase's keys.
import { createHmac } from 'node:crypto';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const header = b64({ alg: 'HS256', typ: 'JWT' });
const now = Math.floor(Date.now() / 1000);
const payload = b64({ role: process.env.ROLE ?? 'anon', iss: 'supabase-local', iat: now, exp: now + 10 * 365 * 24 * 3600 });
const sig = createHmac('sha256', process.env.JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
process.stdout.write(`${header}.${payload}.${sig}`);
