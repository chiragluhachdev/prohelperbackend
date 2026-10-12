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
import { recoverOnBoot, startDispatcher } from './matching.js';
import { ensureLocalities } from './lib/localities.js';

import authRoutes from './routes/auth.js';
import commonRoutes from './routes/common.js';
import customerRoutes from './routes/customer.js';
import helperRoutes from './routes/helper.js';
import adminRoutes from './routes/admin.js';
import referralRoutes from './routes/referrals.js';
import partnerRoutes from './routes/partner.js';

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
  app.use('/api/referrals', referralRoutes);
  app.use('/api/partner', partnerRoutes);

  app.use((req, res) => res.status(404).json({ error: { message: `No route for ${req.method} ${req.path}`, code: 'NOT_FOUND' } }));

  /*
   * Answering while a phone is still sending its photo looks, to Android, like
   * the connection died: the app shows "check your connection" and the real
   * reason — the wrong file type, an expired session — never reaches it. So an
   * upload that is still arriving is read to the end first, up to a cap, and
   * only then answered.
   */
  const DRAIN_CAP = 12 * 1024 * 1024;
  const answer = (req, send) => {
    const uploading = String(req.headers['content-type'] || '').startsWith('multipart/');
    if (!uploading || req.readableEnded || req.destroyed) return send();

    let drained = 0;
    const finish = () => {
      req.removeListener('data', onData);
      req.removeListener('end', finish);
      req.removeListener('error', finish);
      send();
    };
    const onData = (chunk) => {
      drained += chunk.length;
      // A body big enough to be an attack is not worth draining politely.
      if (drained > DRAIN_CAP) finish();
    };
    req.on('data', onData);
    req.once('end', finish);
    req.once('error', finish);
    req.resume();
  };

  // Everything that goes wrong leaves through here, in one shape the apps can rely on.
  app.use((err, req, res, _next) => {
    const reply = (status, body) => answer(req, () => res.status(status).json(body));

    if (err instanceof ApiError) {
      return reply(err.status, { error: { message: err.message, code: err.code, details: err.details } });
    }
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than 8 MB.' : 'Upload failed.';
      return reply(400, { error: { message, code: err.code } });
    }
    if (err?.name === 'ValidationError') {
      return reply(400, {
        error: { message: Object.values(err.errors)[0]?.message || 'Invalid data.', code: 'VALIDATION_ERROR' },
      });
    }
    if (err?.name === 'CastError') {
      return reply(400, { error: { message: 'That id is not valid.', code: 'INVALID_ID' } });
    }
    if (err?.code === 11000) {
      return reply(409, { error: { message: 'That record already exists.', code: 'DUPLICATE' } });
    }

    console.error('[error]', err);
    reply(500, { error: { message: 'Something went wrong on our side.', code: 'INTERNAL' } });
  });

  return app;
}

async function main() {
  await connectDb();
  await ensureSettings();
  // The first run on a new database turns the built-in estates into editable localities.
  await ensureLocalities();

  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`\n  Pro Helper API → http://localhost:${PORT}`);
    console.log(`  env: ${NODE_ENV} · dummy auth: ${DUMMY_AUTH ? 'ON (any 6 digits)' : 'off'} · uploads: ${CLOUDINARY_ENABLED ? 'cloudinary' : 'disabled'}\n`);
  });

  // Work that was in flight when this process last stopped (UC-C54).
  await recoverOnBoot().catch((err) => console.error('[recover]', err.message));

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
