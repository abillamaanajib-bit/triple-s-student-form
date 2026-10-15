-- TRIPLE S dashboard: who can manage staff accounts (the "Team" panel).
-- Run once in your Supabase project, after admin.sql:
-- SQL Editor -> New query -> paste -> Run.
--
-- Everyone with an @triple-s.me account can view submissions (admin.sql).
-- Only the people listed in dashboard_admins can add, reset or remove staff
-- accounts, through the staff-admin Edge Function.

create table if not exists public.dashboard_admins (
  email text primary key check (email = lower(email) and email like '%@triple-s.me')
);

-- No policies: the table can't be read or changed from the web page, only by
-- the staff-admin function (secret key) or here in SQL.
alter table public.dashboard_admins enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_staff()
    and exists (
      select 1 from public.dashboard_admins
      where email = lower(coalesce(auth.jwt() ->> 'email', ''))
    );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- The first admins. Change these to the right people BEFORE running.
-- More admins can be added later from the Team panel.
insert into public.dashboard_admins (email) values
  ('n.abillamaa@triple-s.me'),
  ('r.assi@triple-s.me')
on conflict do nothing;
