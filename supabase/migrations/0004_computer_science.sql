-- cat — add computer science as a specialty.
--
-- Distinct from 'engineering', which is about this codebase's plumbing:
-- packaging, performance, tests. Computer science is the discipline itself --
-- algorithms, languages, systems, computational method.

insert into public.specialties (slug, label, description, position) values
  ('computer_science', 'Computer scientist',
   'Algorithms, data structures, languages, systems and computational method.', 7)
on conflict (slug) do update
  set label       = excluded.label,
      description = excluded.description,
      position    = excluded.position;
