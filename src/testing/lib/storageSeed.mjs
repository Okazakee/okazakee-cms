/**
 * Isolated fixture — deterministic loopback Storage objects.
 *
 * Creates the public `website` bucket and uploads the tiny assets referenced
 * by the seed SQL, so next/image and the preview components resolve real
 * loopback URLs.
 */
import { createAdminClient } from './auth.mjs';
import { storageAssets, storageBucket } from './config.mjs';

export async function seedStorage(status, log) {
  const admin = createAdminClient(status);

  const { error: bucketError } = await admin.storage.createBucket(
    storageBucket,
    { public: true }
  );
  if (bucketError && !/already exists/i.test(bucketError.message)) {
    throw new Error(`failed to create bucket: ${bucketError.message}`);
  }

  const uploaded = [];
  for (const asset of storageAssets) {
    const bytes = Buffer.from(asset.base64, 'base64');
    const { error } = await admin.storage
      .from(storageBucket)
      .upload(asset.path, bytes, {
        contentType: asset.contentType,
        upsert: true,
      });
    if (error) {
      throw new Error(`failed to upload ${asset.path}: ${error.message}`);
    }
    const { data } = admin.storage.from(storageBucket).getPublicUrl(asset.path);
    uploaded.push(data.publicUrl);
  }

  log?.info(`Storage ready (${uploaded.length} objects in ${storageBucket})`);
  return uploaded;
}
