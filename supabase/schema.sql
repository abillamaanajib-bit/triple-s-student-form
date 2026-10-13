-- TRIPLE S Student Interest Form: database setup.
-- Run once in your Supabase project: SQL Editor -> New query -> paste -> Run.
--
-- Security model: the public form (publishable key, "anon" role) can only ADD
-- responses and upload CVs. It cannot read, change or delete anything. You view
-- responses in the dashboard (Table Editor) and CVs under Storage -> cvs.

create table if not exists public.student_interest_submissions (
  id                 uuid primary key default gen_random_uuid(),
  submitted_at       timestamptz not null default now(),
  full_name          text not null check (char_length(full_name) between 1 and 120),
  email              text not null check (char_length(email) between 3 and 254),
  mobile             text not null check (char_length(mobile) between 7 and 20),
  school             text not null check (char_length(school) <= 60),
  major              text not null check (char_length(major) between 1 and 120),
  year_of_study      text not null check (char_length(year_of_study) <= 60),
  interests          text[] not null default '{}' check (cardinality(interests) <= 30),
  experience_types   text[] not null default '{}' check (cardinality(experience_types) <= 10),
  skills             text check (char_length(skills) <= 1500),
  available_from     date,
  available_until    date check (available_until is null or available_from is null or available_until >= available_from),
  availability_notes text check (char_length(availability_notes) <= 200),
  profile_link       text check (char_length(profile_link) <= 300),
  cv_path            text check (char_length(cv_path) <= 400),
  contact_consent    boolean not null
);

alter table public.student_interest_submissions enable row level security;

grant insert on table public.student_interest_submissions to anon;

drop policy if exists "Public form can submit" on public.student_interest_submissions;
create policy "Public form can submit"
  on public.student_interest_submissions
  for insert
  to anon
  with check (true);

-- Private bucket for CV uploads: 5 MB max, PDF and Word only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'cvs',
  'cvs',
  false,
  5242880,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do nothing;

drop policy if exists "Public form can upload CVs" on storage.objects;
create policy "Public form can upload CVs"
  on storage.objects
  for insert
  to anon
  with check (bucket_id = 'cvs');
