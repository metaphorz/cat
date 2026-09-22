-- cat — images in the conversation.
--
-- A screen grab of a plot says in one glance what a paragraph describing the
-- plot does not, and this group spends its time on plots. So messages can
-- carry images: dragged in, pasted from the clipboard, or chosen from a file
-- picker.
--
-- The bucket is private. The alternative -- a public bucket with unguessable
-- URLs -- is the usual shortcut, and it means anyone who ever sees a URL keeps
-- access to that image forever, with no way to revoke it short of deleting the
-- file. The sidebar tells people not to paste anything proprietary; that is a
-- reason to make the storage match the instruction, not a reason to rely on
-- the instruction.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'attachments',
  'attachments',
  false,
  10485760,  -- 10 MB: a generous screen grab, far short of a video
  -- No SVG. An SVG is a document that can carry script, and nothing anyone
  -- drags in here is one: screen grabs are PNG, photographs are JPEG. Allowing
  -- it would add a whole class of problem in exchange for nothing.
  array['image/png', 'image/jpeg', 'image/gif', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Who may put an image in, and who may read one back. The same answer as for
-- messages: any member reads everything, and writes only as themselves. Paths
-- are <member id>/<random>.<ext>, so the first path segment is the owner and
-- the policy can check it without a second table.
-- ---------------------------------------------------------------------------
create policy attachments_read on storage.objects
  for select to authenticated
  using (bucket_id = 'attachments' and public.is_member());

create policy attachments_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and public.is_member()
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Deleting your own image, to match messages_delete_own.
create policy attachments_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- What a message carries. A column rather than a table: an attachment has no
-- life of its own, is never queried except alongside its message, and goes
-- when the message goes.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column attachments jsonb not null default '[]'::jsonb;

comment on column public.messages.attachments is
  'Array of {path, name, type, width, height} for images in this message.';

-- The body-is-not-empty assumption elsewhere: a message may now be an image
-- with nothing said about it, so an empty body is legitimate provided
-- something is attached.
alter table public.messages
  add constraint messages_not_empty check (
    body <> '' or attachments <> '[]'::jsonb or status = 'pending'
  );
