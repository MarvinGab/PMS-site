-- Public bucket for brand assets (org logos, email header/body/signature
-- images, user avatars). Email recipients and other devices need stable
-- absolute URLs, so every image picker in the app uploads here instead of
-- persisting data URLs / blob URLs / Vite asset paths.

insert into storage.buckets (id, name, public)
values ('brand-assets', 'brand-assets', true)
on conflict (id) do nothing;

-- The app talks to Supabase with the anon key (no Supabase auth session —
-- it has its own app-auth flow), so policies cannot rely on auth.uid().
-- We allow public read + anon write to match the rest of the app's pattern;
-- tighten later if you adopt Supabase auth.

drop policy if exists "brand-assets public read"   on storage.objects;
drop policy if exists "brand-assets anon write"    on storage.objects;
drop policy if exists "brand-assets anon update"   on storage.objects;
drop policy if exists "brand-assets anon delete"   on storage.objects;

create policy "brand-assets public read" on storage.objects
  for select using (bucket_id = 'brand-assets');

create policy "brand-assets anon write" on storage.objects
  for insert with check (bucket_id = 'brand-assets');

create policy "brand-assets anon update" on storage.objects
  for update using (bucket_id = 'brand-assets') with check (bucket_id = 'brand-assets');

create policy "brand-assets anon delete" on storage.objects
  for delete using (bucket_id = 'brand-assets');
