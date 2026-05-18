// Aquipax Service Worker v13 — JeanieIQ
// Network-first caching + scheduled local notifications

const CACHE_NAME = 'aquipax-v13';
const STATIC_ASSETS = ['/index.html','/app.html','/manifest.json','/icon-192.png','/aquipax_logo.png','/landing.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS)).catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname.includes('supabase') || url.hostname.includes('anthropic') ||
      url.hostname.includes('rapidapi') || url.hostname.includes('openfoodfacts') ||
      url.hostname.includes('stripe') || url.pathname.startsWith('/.netlify/functions') ||
      url.hostname.includes('apify') || url.hostname.includes('openai')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && e.request.method === 'GET') {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});

// ── Push notifications (server-sent) ──
self.addEventListener('push', e => {
  // Also post to app to add to in-app notification list
  self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>{
    clients.forEach(client=>{
      try{
        const data=e.data?.json()||{};
        client.postMessage({type:'PUSH_RECEIVED',title:data.title,body:data.body,icon:data.icon});
      }catch(err){}
    });
  });
  let data = {title:'Aquipax',body:'Your daily financial briefing is ready.'};
  try{data=e.data.json();}catch(err){}
  e.waitUntil(self.registration.showNotification(data.title||'Aquipax',{
    body:data.body, icon:'/icon-192.png', badge:'/icon-192.png',
    tag:data.tag||'aquipax', data:data.url||'/app.html', vibrate:[200,100,200]
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const c of list){if(c.url.includes(self.location.origin)&&'focus' in c)return c.focus();}
    return clients.openWindow(e.notification.data||'/app.html');
  }));
});

// ── Scheduled local notifications ──
// The app sends SCHEDULE_NOTIFICATIONS with the user's state data
// The SW stores it and fires notifications at the right times

let scheduledNotifications = [];
let notificationCheckInterval = null;

self.addEventListener('message', e => {
  if(e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if(e.data?.type === 'SCHEDULE_NOTIFICATIONS') {
    const state = e.data.state;
    scheduledNotifications = buildNotificationSchedule(state);
    // Store in cache for persistence
    caches.open(CACHE_NAME).then(c => {
      c.put('/sw-notifications.json', new Response(JSON.stringify({
        scheduled: scheduledNotifications,
        updatedAt: Date.now()
      })));
    });
    startNotificationChecker();
    return;
  }

  if(e.data?.type === 'CHECK_NOTIFICATIONS') {
    fireReadyNotifications();
    return;
  }
});

function buildNotificationSchedule(state) {
  const notifications = [];
  const now = new Date();

  // ── Bin day reminders (evening before, 7pm) ──
  if(state?.notifications?.bins !== false && state?.bins) {
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    state.bins.forEach(bin => {
      if(!bin.label || !bin.day) return;
      const binDayIdx = dayNames.indexOf(bin.day);
      if(binDayIdx === -1) return;

      // Find next occurrence of this bin day
      const daysUntil = (binDayIdx - now.getDay() + 7) % 7 || 7;
      const binDate = new Date(now);
      binDate.setDate(now.getDate() + daysUntil);
      binDate.setHours(19, 0, 0, 0); // 7pm the evening before

      // Notify the evening BEFORE
      const notifyDate = new Date(binDate);
      notifyDate.setDate(binDate.getDate() - 1);
      notifyDate.setHours(19, 0, 0, 0);

      if(notifyDate > now) {
        notifications.push({
          id: `bin-${bin.label}-${notifyDate.toDateString()}`,
          fireAt: notifyDate.getTime(),
          title: `🗑️ ${bin.label} out tonight`,
          body: `Put your ${bin.label.toLowerCase()} bin out — collection tomorrow.`,
          tag: 'bin-reminder',
          url: '/app.html'
        });
      }
    });
  }

  // ── Contract renewal reminders ──
  if(state?.contracts) {
    state.contracts.forEach(contract => {
      if(!contract.endDate || !contract.label) return;
      const endDate = new Date(contract.endDate);
      const daysUntil = Math.ceil((endDate - now) / (1000*60*60*24));

      // Notify at 60, 30, and 7 days before
      [60, 30, 7].forEach(days => {
        if(daysUntil >= days - 1 && daysUntil <= days + 1) {
          const notifyDate = new Date();
          notifyDate.setHours(9, 0, 0, 0); // 9am today
          if(notifyDate > now) {
            notifications.push({
              id: `contract-${contract.label}-${days}`,
              fireAt: notifyDate.getTime(),
              title: `⚠️ ${contract.label} renews in ${days} days`,
              body: `Your ${contract.label} contract ends on ${endDate.toLocaleDateString('en-GB')}. Tap to compare deals.`,
              tag: 'contract-reminder',
              url: '/app.html'
            });
          }
        }
      });
    });
  }

  // ── Morning briefing (daily at 8am) ──
  if(state?.notifications?.morningBriefing !== false) {
    const briefingTime = new Date();
    briefingTime.setHours(8, 0, 0, 0);
    if(briefingTime <= now) briefingTime.setDate(briefingTime.getDate() + 1);

    const safe = state?._lastSafe || 0;
    const name = state?.hh?.name || '';
    const urgentContracts = (state?.contracts||[]).filter(c => {
      if(!c.endDate) return false;
      const d = Math.ceil((new Date(c.endDate) - now) / (1000*60*60*24));
      return d >= 0 && d <= 30;
    });
    const mostUrgent = urgentContracts[0];

    // Step streak
    let stepStreak = 0;
    const steps = state?.healthData?.steps || [];
    const checkDate = new Date();
    for(let i = 0; i < 30; i++) {
      const ds = checkDate.toISOString().split('T')[0];
      const s = steps.find(x => x.date === ds);
      if(s && s.count >= 10000) { stepStreak++; checkDate.setDate(checkDate.getDate() - 1); }
      else break;
    }

    // Build personalised body
    const parts = [];
    if(safe > 0) parts.push(`£${safe.toLocaleString()} safe to spend this month.`);
    if(mostUrgent) {
      const days = Math.ceil((new Date(mostUrgent.endDate) - now) / (1000*60*60*24));
      parts.push(`${mostUrgent.label} renews in ${days} days.`);
    }
    if(stepStreak >= 3) parts.push(`${stepStreak}-day step streak 🔥`);
    if(parts.length === 0) parts.push('Check in on your finances and health today.');

    const greeting = name ? `Good morning ${name}.` : 'Good morning.';
    const body = greeting + ' ' + parts.join(' ');
    const title = '☀️ ' + (name ? `Morning ${name}` : 'Morning briefing') + ' — Aquipax';

    notifications.push({
      id: `briefing-${briefingTime.toDateString()}`,
      fireAt: briefingTime.getTime(),
      title,
      body,
      tag: 'morning-briefing',
      url: '/app.html'
    });
  }

  // ── Family event morning reminders ──
  if(state?._familyEvents?.length > 0) {
    const myName = state?.hh?.members?.find(m => m.user_id === state?._currentUserId)?.name || '';
    state._familyEvents.forEach(ev => {
      if(!ev.event_date || !ev.title) return;
      // Only notify if I'm involved (in members list or 'Everyone') or if it's today/tomorrow
      const isInvolved = !ev.members?.length || ev.members.includes('Everyone') || (myName && ev.members.includes(myName));
      if(!isInvolved) return;
      
      const eventDate = new Date(ev.event_date);
      eventDate.setHours(0, 0, 0, 0);
      const daysUntil = Math.ceil((eventDate - now) / (1000*60*60*24));
      
      // Morning reminder on the day (8am)
      if(daysUntil === 0 || daysUntil === 1) {
        const notifyDate = new Date(eventDate);
        notifyDate.setHours(8, 0, 0, 0);
        if(notifyDate > now) {
          const timeStr = ev.start_time ? ` at ${ev.start_time}` : '';
          const membersStr = ev.members?.length && !ev.members.includes('Everyone') ? ` (${ev.members.join(', ')})` : '';
          notifications.push({
            id: `family-event-${ev.id}-${notifyDate.toDateString()}`,
            fireAt: notifyDate.getTime(),
            title: `📅 ${daysUntil === 0 ? 'Today' : 'Tomorrow'}: ${ev.title}`,
            body: `${ev.title}${timeStr}${membersStr}${ev.location ? ' · ' + ev.location : ''}`,
            tag: `family-event-${ev.id}`,
            url: '/app.html'
          });
        }
      }
    });
  }

  return notifications;
}

function startNotificationChecker() {
  // Check every minute for notifications that should fire
  if(notificationCheckInterval) clearInterval(notificationCheckInterval);
  notificationCheckInterval = setInterval(fireReadyNotifications, 60000);
  fireReadyNotifications(); // Check immediately
}

async function fireReadyNotifications() {
  const now = Date.now();
  const fired = [];

  for(const n of scheduledNotifications) {
    if(n.fireAt <= now && !n.fired) {
      try {
        await self.registration.showNotification(n.title, {
          body: n.body,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: n.tag || n.id,
          data: n.url || '/app.html',
          vibrate: [200, 100, 200]
        });
        n.fired = true;
        fired.push(n.id);
      } catch(err) {
        // Notification permission may not be granted
      }
    }
  }

  // Remove fired notifications
  scheduledNotifications = scheduledNotifications.filter(n => !n.fired);
}

self.addEventListener('sync', e => {
  if(e.tag === 'sync-data') {
    self.clients.matchAll().then(cs => cs.forEach(c => c.postMessage({type:'SYNC_REQUESTED'})));
  }
  if(e.tag === 'check-notifications') {
    fireReadyNotifications();
  }
});
