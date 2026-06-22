import { supabase } from './supabaseClient';

const BUCKET = 'brand-assets';
const DEFAULT_LOGO_CACHE_KEY = 'zarohr_default_brand_logo_url_v2';
const DEFAULT_LOGO_PATH = 'defaults/zaro-logo-email.jpg';

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error || new Error('FileReader failed'));
    r.readAsDataURL(file);
  });
}

function sanitizeExt(name, fallback = 'png') {
  const raw = String(name || '').split('.').pop() || fallback;
  const clean = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  return clean || fallback;
}

function randomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function resizeToBlob(file, { maxDim, quality, mimeType, background = '#ffffff' }) {
  const dataUrl = await readAsDataUrl(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, w, h);
      }
      ctx.drawImage(img, 0, 0, w, h);
      const mime = mimeType || (file.type === 'image/png' ? 'image/png' : 'image/jpeg');
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), mime, quality);
    };
    img.onerror = () => reject(new Error('Image decode failed'));
    img.src = dataUrl;
  });
}

export async function uploadBrandAsset(file, { folder = 'misc', orgKey = 'global', resize } = {}) {
  if (!file) throw new Error('No file provided');
  if (!supabase) {
    return readAsDataUrl(file);
  }
  let body = file;
  let contentType = file.type || 'image/png';
  if (resize && file.type?.startsWith('image/')) {
    const blob = await resizeToBlob(file, {
      maxDim: resize.maxDim || 320,
      quality: resize.quality ?? 0.86,
      mimeType: resize.mimeType,
      background: resize.background,
    });
    body = blob;
    contentType = blob.type || contentType;
  }
  const ext = sanitizeExt(file.name, contentType.includes('png') ? 'png' : 'jpg');
  const safeOrg = String(orgKey || 'global').replace(/[^a-zA-Z0-9_-]/g, '_') || 'global';
  const safeFolder = String(folder || 'misc').replace(/[^a-zA-Z0-9_-]/g, '_') || 'misc';
  const path = `${safeFolder}/${safeOrg}/${randomId()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, body, {
    cacheControl: '31536000',
    upsert: false,
    contentType,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

export async function uploadEmailLogoAsset(file, { orgKey = 'global', folder = 'email-logos' } = {}) {
  if (!file) throw new Error('No file provided');
  return uploadBrandAsset(file, {
    folder,
    orgKey,
    resize: {
      maxDim: 240,
      quality: 0.72,
      mimeType: 'image/jpeg',
      background: '#ffffff',
    },
  });
}

export async function ensureDefaultZaroLogoUrl(bundledUrl) {
  if (!supabase) return bundledUrl;
  // The client cannot upload to the `brand-assets` bucket — the bucket's RLS
  // policy requires a Supabase Auth user (we use a custom server-session
  // model instead). So we simply return the public URL for the bundled Zaro
  // logo path; the file has been uploaded once via the Supabase dashboard at:
  //   brand-assets/defaults/zaro-logo-email.jpg
  // Emails that go out reference this stable URL, so they always render the
  // logo regardless of the recipient's mail client. If the file is missing
  // from Storage, the image will simply 404 in the email — to fix, drop
  // the bundled Zaro logo (final zaro logo.png) at that exact path in the
  // bucket via the Supabase dashboard.
  try {
    const cached = localStorage.getItem(DEFAULT_LOGO_CACHE_KEY);
    if (cached && isPublicBrandAssetUrl(cached)) return cached;
    if (cached) localStorage.removeItem(DEFAULT_LOGO_CACHE_KEY);
  } catch { /* ignore */ }

  const { data: publicData } = supabase.storage.from(BUCKET).getPublicUrl(DEFAULT_LOGO_PATH);
  const publicUrl = publicData?.publicUrl;
  if (publicUrl) {
    try { localStorage.setItem(DEFAULT_LOGO_CACHE_KEY, publicUrl); } catch { /* ignore */ }
    return publicUrl;
  }
  return bundledUrl;
}

export function isPublicBrandAssetUrl(url) {
  if (!url) return false;
  if (typeof url !== 'string') return false;
  if (url.startsWith('data:')) return false;
  if (url.startsWith('blob:')) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return false;
    if (host.endsWith('.local')) return false;
    // Reject the dev server's bundler asset paths (e.g. /src/, /@fs/, /@vite/).
    if (/^\/(?:src|@fs|@vite|@id|node_modules)\//.test(parsed.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}
