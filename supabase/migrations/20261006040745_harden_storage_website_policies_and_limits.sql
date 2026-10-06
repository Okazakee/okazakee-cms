-- Harden storage boundary: drop 4 broad authenticated INSERT/UPDATE policies on storage.objects (website bucket); set 10MiB + webp/png/pdf limits on website + website-dev. CMS writes stay service_role (bypassrls); public buckets stay public=true so anon reads unaffected. Existing 53 website objects verified compatible (0 over limit, mimetypes subset). No new bucket, no object copy.
DROP POLICY IF EXISTS "Authenticated users can upload to website bucket" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload avatars" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update website bucket" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update avatars" ON storage.objects;
UPDATE storage.buckets SET file_size_limit = 10485760, allowed_mime_types = ARRAY['image/webp','image/png','application/pdf'] WHERE id IN ('website','website-dev');
