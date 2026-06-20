/* =========================================================
   SW.JS - GABUNGAN FIREBASE MESSAGING + PWA
   ========================================================= */

// 1. Import Firebase (wajib ada)
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js");

// 2. Inisialisasi Firebase (sama persis seperti di index.html)
firebase.initializeApp({
  apiKey: "AIzaSyCpT4bWPGwJJPUN_P0limoBjNAqU-Awu48",
  authDomain: "prensesi-sma12.firebaseapp.com",
  projectId: "prensesi-sma12",
  storageBucket: "prensesi-sma12.appspot.com",
  messagingSenderId: "553623533572",
  appId: "1:553623533572:web:ff5a4bb7a9eea258095d51"
});

const messaging = firebase.messaging();

// 3. Handle notifikasi yang masuk saat aplikasi di background
messaging.onBackgroundMessage(function(payload) {
  const title = payload.notification?.title || "Presensi Sekolah";
  const options = {
    body: payload.notification?.body || "Ada update presensi",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    vibrate: [200, 100, 200],  // getar biar perhatian
    requireInteraction: true   // notifikasi gak ilang otomatis
  };
  return self.registration.showNotification(title, options);
});

// 4. Event Install & Activate (biar SW langsung aktif)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  return event.waitUntil(self.clients.claim());
});

// 5. Handle klik notifikasi (buka aplikasi saat notif di-klik)
self.addEventListener("notificationclick", function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("./");
      return null;
    })
  );
});