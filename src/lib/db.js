import mongoose from 'mongoose';
import { MONGO_URI } from '../config.js';

export async function connectDb() {
  if (!MONGO_URI) throw new Error('MONGO_URI is not set — copy .env.example to .env');
  mongoose.set('strictQuery', true);
  await mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 15000,
    maxPoolSize: 20,
  });
  console.log(`[db] connected to "${mongoose.connection.name}"`);
  mongoose.connection.on('disconnected', () => console.warn('[db] disconnected'));
  mongoose.connection.on('error', (e) => console.error('[db] error', e.message));
  return mongoose.connection;
}
