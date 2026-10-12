import { useEffect, useState } from 'react';
import { subscribeNotifications, unreadCount } from '../../data/hubApi';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../state/auth';
import { useWorkspace } from '../../state/workspace';

/** Unread hub notifications (messages, connection requests). Live via Supabase Realtime when enabled. */
export function useHubBadge(): number {
  const ws = useWorkspace();
  const auth = useAuth();
  const [n, setN] = useState(0);
  const userId = auth.user?.id;
  useEffect(() => {
    if (ws.mode !== 'live' || !userId || !supabase) { setN(0); return; }
    let active = true;
    const refresh = () => { unreadCount().then((c) => active && setN(c)).catch(() => {}); };
    refresh();
    const ch = subscribeNotifications(userId, refresh);
    const t = setInterval(refresh, 60000); // fallback if Realtime isn't enabled on the project
    return () => { active = false; clearInterval(t); void supabase?.removeChannel(ch); };
  }, [ws.mode, userId, ws.versions.hub]);
  return n;
}
