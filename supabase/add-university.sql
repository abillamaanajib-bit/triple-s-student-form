-- Adds the "University" answer to existing projects (new setups get it from schema.sql).
-- Run once in your Supabase project: SQL Editor -> New query -> paste -> Run.
-- Safe to run more than once.

alter table public.student_interest_submissions
  add column if not exists university text check (char_length(university) <= 120);
