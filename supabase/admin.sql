-- TRIPLE S staff dashboard (admin/ page): access rules.
-- Run once in your Supabase project, after schema.sql:
-- SQL Editor -> New query -> paste -> Run.
--
-- Anyone signed in with an @triple-s.me email address can view and delete
-- submissions and CVs. Nobody else can, including the public form.
-- Create staff accounts yourself (Authentication -> Users -> Add user) and keep
-- public sign-ups switched off, so nobody can register an address they don't own.

create or replace function public.is_staff()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(lower(auth.jwt() ->> 'email') like '%@triple-s.me', false);
$$;

grant execute on function public.is_staff() to authenticated;
grant select, delete on table public.student_interest_submissions to authenticated;

drop policy if exists "Staff can view submissions" on public.student_interest_submissions;
create policy "Staff can view submissions"
  on public.student_interest_submissions
  for select
  to authenticated
  using ((select public.is_staff()));

drop policy if exists "Staff can delete submissions" on public.student_interest_submissions;
create policy "Staff can delete submissions"
  on public.student_interest_submissions
  for delete
  to authenticated
  using ((select public.is_staff()));

drop policy if exists "Staff can view CVs" on storage.objects;
create policy "Staff can view CVs"
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'cvs' and (select public.is_staff()));

drop policy if exists "Staff can delete CVs" on storage.objects;
create policy "Staff can delete CVs"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'cvs' and (select public.is_staff()));
