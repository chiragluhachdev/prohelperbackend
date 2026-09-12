import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin SDK
try {
  const serviceAccountPath = path.resolve(__dirname, '../../firebase-service-account.json');
  if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('[fcm] Firebase Admin SDK initialized');
  } else {
    console.warn('[fcm] firebase-service-account.json not found. Push notifications will be disabled.');
  }
} catch (err) {
  console.error('[fcm] Failed to initialize Firebase Admin SDK:', err.message);
}

/**
 * Send a high-priority data-only push notification via FCM.
 * 
 * @param {string} token - The recipient's FCM token
 * @param {object} data - Key-value pairs of string data payload
 */
export async function sendDataPush(token, data) {
  if (!admin.apps.length) {
    console.warn('[fcm] Firebase not initialized, skipping push.');
    return false;
  }
  
  if (!token) return false;

  const message = {
    token,
    data, // Data payload
    android: {
      priority: 'high', // Wake up the device immediately
    },
  };

  try {
    const response = await admin.messaging().send(message);
    console.log('[fcm] Successfully sent message:', response);
    return true;
  } catch (error) {
    console.error('[fcm] Error sending message:', error.message);
    return false;
  }
}
