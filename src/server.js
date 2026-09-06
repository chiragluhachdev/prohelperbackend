// Must be first: populates process.env from .env when running locally.
// On a host like Railway the variables already exist and this is a no-op.
import './lib/env.js';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import mongoose from 'mongoose';
import multer from 'multer';

import { PORT, NODE_ENV, DUMMY_AUTH, CLOUDINARY_ENABLED } from './config.js';
import { connectDb } from './lib/db.js';
import { ensureSettings } from './lib/settings.js';
import { ApiError } from './lib/http.js';
import { startDispatcher } from './matching.js';

import authRoutes from './routes/auth.js';
import commonRoutes from './routes/common.js';
import customerRoutes from './routes/customer.js';
import helperRoutes from './routes/helper.js';
import adminRoutes from './routes/admin.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  if (NODE_ENV !== 'test') app.use(morgan('dev'));

  app.get('/api/health', (_req, res) =>
    res.json({
      ok: true,
      service: 'prohelper-api',
      db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      dummyAuth: DUMMY_AUTH,
      uploads: CLOUDINARY_ENABLED ? 'cloudinary' : 'disabled',
      time: new Date().toISOString(),
    }),
  );

  app.use('/api/auth', authRoutes);
  app.use('/api', commonRoutes);
  app.use('/api/customer', customerRoutes);
  app.use('/api/helper', helperRoutes);
  app.use('/api/admin', adminRoutes);

  app.use((req, res) => res.status(404).json({ error: { message: `No route for ${req.method} ${req.path}`, code: 'NOT_FOUND' } }));

  // Everything that goes wrong leaves through here, in one shape the apps can rely on.
  app.use((err, _req, res, _next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { message: err.message, code: err.code, details: err.details } });
    }
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than 8 MB.' : 'Upload failed.';
      return res.status(400).json({ error: { message, code: err.code } });
    }
    if (err?.name === 'ValidationError') {
      return res.status(400).json({
        error: { message: Object.values(err.errors)[0]?.message || 'Invalid data.', code: 'VALIDATION_ERROR' },
      });
    }
    if (err?.name === 'CastError') {
      return res.status(400).json({ error: { message: 'That id is not valid.', code: 'INVALID_ID' } });
    }
    if (err?.code === 11000) {
      return res.status(409).json({ error: { message: 'That record already exists.', code: 'DUPLICATE' } });
    }

    console.error('[error]', err);
    res.status(500).json({ error: { message: 'Something went wrong on our side.', code: 'INTERNAL' } });
  });

  return app;
}

async function main() {
  await connectDb();
  await ensureSettings();

  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`\n  Pro Helper API → http://localhost:${PORT}`);
    console.log(`  env: ${NODE_ENV} · dummy auth: ${DUMMY_AUTH ? 'ON (any 6 digits)' : 'off'} · uploads: ${CLOUDINARY_ENABLED ? 'cloudinary' : 'disabled'}\n`);
  });

  // The 60-second window and every other deadline is enforced here, not on the phone.
  startDispatcher();

  const shutdown = async (signal) => {
    console.log(`\n[server] ${signal} — shutting down`);
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.argv[1]?.endsWith('server.js')) {
  main().catch((err) => {
    console.error('[server] failed to start:', err.message);
    process.exit(1);
  });
}
