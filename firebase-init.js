// firebase-init.js
import admin from "firebase-admin";
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function initializeFirebase() {
  try {
    if (admin.apps.length === 0) {
      let serviceAccount;
      
      if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      } else {
        // استخدام fs.readFileSync بدلاً من import
        const serviceAccountPath = join(__dirname, 'serviceAccountKey.json');
        const serviceAccountData = readFileSync(serviceAccountPath, 'utf8');
        serviceAccount = JSON.parse(serviceAccountData);
      }

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      
      console.log("Firebase initialized successfully");
    }
    
    return admin.firestore();
  } catch (error) {
    console.error("Error initializing Firebase:", error);
    throw error;
  }
}

export { admin };