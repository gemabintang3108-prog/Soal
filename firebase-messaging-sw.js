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

messaging.onBackgroundMessage(function(payload) {

  const title = payload.notification?.title || "Presensi Sekolah";

  const options = {
    body: payload.notification?.body || "Ada update presensi",
    icon: "./icon-192.png"
  };

  self.registration.showNotification(title, options);
});
