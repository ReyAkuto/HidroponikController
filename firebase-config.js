// ============================================================
//  firebase-config.js
//  Konfigurasi Firebase untuk Hydroponic Monitor Dashboard
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { getAuth, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBykwJKz-HYVoM1NSlYZDdr-2adru26Noo",
  authDomain: "hidroponikcontroller.firebaseapp.com",
  databaseURL: "https://hidroponikcontroller-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "hidroponikcontroller",
  storageBucket: "hidroponikcontroller.appspot.com",
  messagingSenderId: "",   // isi jika perlu
  appId: ""                // isi jika perlu
};

const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);

// Auto-login dengan akun esp32 (baca-only monitoring)
// Ganti credential di sini sesuai kebutuhan
const MONITOR_EMAIL    = "esp32@hidroponik.com";
const MONITOR_PASSWORD = "esp32123";

export { app, db, auth, signInWithEmailAndPassword, MONITOR_EMAIL, MONITOR_PASSWORD };