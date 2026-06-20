importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyCpT4bWPGwJJPUN_P0limoBjNAqU-Awu48",
  authDomain: "prensesi-sma12.firebaseapp.com",
  projectId: "prensesi-sma12",
  storageBucket: "prensesi-sma12.appspot.com",
  messagingSenderId: "553623533572",
  appId: "1:553623533572:web:ff5a4bb7a9eea258095d51"
});

const messaging = firebase.messaging();

// Handle notifikasi di background
messaging.onBackgroundMessage(function(payload) {
  const title = payload.notification?.title || "Presensi Sekolah";
  const options = {
    body: payload.notification?.body || "Ada update presensi",
    icon: "./icon-192.png",
    badge: "./icon-192.png"
  };
  self.registration.showNotification(title, options);
});

// Install & activate
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Handle klik notifikasi
self.addEventListener("notificationclick", function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      const targetUrl = event.action === "open" ? "/" : "./";
      if (clients.openWindow) return clients.openWindow(targetUrl);
      return null;
    })
  );
});
