/* Steadhold service worker — receives push notifications */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data.json(); } catch (e) { data = { title: 'Steadhold', body: event.data && event.data.text() }; }
  const urgent = data.kind === 'emergency' || (data.title || '').includes('🚨');
  event.waitUntil(self.registration.showNotification(data.title || 'Steadhold', {
    body: data.body || '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: data.kind || 'steadhold',
    renotify: urgent,
    requireInteraction: urgent,
    data: { url: data.url || '/' }
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) { c.navigate(url); return c.focus(); }
    return clients.openWindow(url);
  }));
});
