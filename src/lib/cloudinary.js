import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';
import { CLOUDINARY, CLOUDINARY_ENABLED } from '../config.js';
import { badRequest } from './http.js';

if (CLOUDINARY_ENABLED) cloudinary.config({ ...CLOUDINARY, secure: true });

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

/** Files stay in memory only long enough to be streamed to Cloudinary. */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.includes(file.mimetype)) {
      return cb(badRequest('Upload a JPG, PNG or PDF file.', 'UNSUPPORTED_FILE_TYPE'));
    }
    cb(null, true);
  },
});

/**
 * KYC documents are uploaded as `type: 'authenticated'`, so the Cloudinary URL
 * is not publicly guessable — only the owner and admins get it from the API.
 */
export function uploadBuffer(buffer, { folder, publicId, resourceType = 'auto', privateFile = false }) {
  if (!CLOUDINARY_ENABLED) {
    return Promise.reject(badRequest('File uploads are not configured on this server.', 'UPLOADS_DISABLED'));
  }
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: publicId,
        resource_type: resourceType,
        type: privateFile ? 'authenticated' : 'upload',
        overwrite: true,
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    stream.end(buffer);
  });
}

export async function destroyAsset(publicId, resourceType = 'image') {
  if (!CLOUDINARY_ENABLED || !publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, type: 'authenticated' });
  } catch (err) {
    console.error('[cloudinary] destroy failed', err.message);
  }
}

export { CLOUDINARY_ENABLED };
