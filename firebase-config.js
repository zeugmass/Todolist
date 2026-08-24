// Firebase proje ayarları. apiKey gizli bir şifre DEĞİLDİR; herkese açık olması normaldir.
// Güvenlik, Firestore kuralları (firestore.rules) ile sağlanır.
export const firebaseConfig = {
  apiKey: "AIzaSyDjMxKMX4sPdVqGqmUKFzNBOGs3DXVhZp8",
  authDomain: "todo-72119.firebaseapp.com",
  projectId: "todo-72119",
  storageBucket: "todo-72119.firebasestorage.app",
  messagingSenderId: "899072386998",
  appId: "1:899072386998:web:818683c7a623e0fcbc8317"
};

// Web Push (bildirim) genel anahtarı — gizli değildir.
export const VAPID_KEY = "BGqR76axu5G6VDL1SxXPF4MMDfkF1vzHgGBe8rvr9n01Q0Gl-t3w4jXEtlqDn4wNGI22K1LKHOyvyKPl9mH5-ls";
