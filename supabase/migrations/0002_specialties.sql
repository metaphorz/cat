-- cat — usernames and specialties.
--
-- Two things this adds, both in service of the same goal: the agent should
-- know who it is talking to, and should be able to point each person at the
-- part of the codebase their discipline actually owns.
--
--   * every member gets a stable @username, distinct from their display name
--   * every member gets a specialty, and every channel maps specialties to
--     real paths in that channel's repository
--
-- The path mapping is per channel rather than global because "the statistics
-- code" means something different in every repository.

-- ---------------------------------------------------------------------------
-- specialties: the professions represented in the group.
-- ---------------------------------------------------------------------------
create table public.specialties (
  slug        text primary key,
  label       text not null,
  description text,
  position    int  not null default 0
);

insert into public.specialties (slug, label, description, position) values
  ('meteorology',  'Meteorologist',
   'Storm physics, wind fields, surface roughness, historical storm behaviour.', 0),
  ('statistics',   'Statistician',
   'Experimental design, sampling, metamodels, uncertainty and validation.', 1),
  ('actuarial',    'Actuary',
   'Exposure, vulnerability, loss estimation and regulatory forms.', 2),
  ('geospatial',   'Geospatial analyst',
   'Grids, boundaries, cadastral and census geography, place names.', 3),
  ('visualization','Visualization',
   'The web viewer, animation, contouring and interactive display.', 4),
  ('engineering',  'Software engineer',
   'Pipeline structure, performance, packaging and testing.', 5),
  ('simulation',   'Modeling and simulation',
   'How the pieces compose into a model, and what the model is for.', 6);

-- ---------------------------------------------------------------------------
-- Identity columns. username is the handle people are addressed by; it is
-- deliberately separate from display_name, which is free to be "Paul Fishwick"
-- while the handle stays short and stable.
-- ---------------------------------------------------------------------------
alter table public.allowlist
  add column username  text,
  add column specialty text references public.specialties(slug);

alter table public.members
  add column username  text unique,
  add column specialty text references public.specialties(slug);

create index members_specialty_idx on public.members (specialty);

-- ---------------------------------------------------------------------------
-- channel_areas: for this repository, these paths are what this specialty
-- most cares about. The agent uses this to steer people toward the code that
-- is actually theirs, and to say who else should be looped in.
-- ---------------------------------------------------------------------------
create table public.channel_areas (
  channel_id uuid   not null references public.channels(id) on delete cascade,
  specialty  text   not null references public.specialties(slug) on delete cascade,
  paths      text[] not null default '{}',
  note       text,
  primary key (channel_id, specialty)
);

-- ---------------------------------------------------------------------------
-- Username generation. Derived from the email local part when the allowlist
-- does not specify one, with a numeric suffix if that handle is taken.
-- ---------------------------------------------------------------------------
create or replace function public.derive_username(seed text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  base      text;
  candidate text;
  n         int := 1;
begin
  base := lower(regexp_replace(coalesce(seed, ''), '[^a-zA-Z0-9_]', '', 'g'));
  if base = '' then base := 'member'; end if;
  base := left(base, 24);

  candidate := base;
  while exists (select 1 from public.members where username = candidate) loop
    n := n + 1;
    candidate := base || n::text;
  end loop;

  return candidate;
end;
$$;

-- Replaces the 0001 version: same allowlist gate, now also carrying the
-- handle and specialty across into the member record.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  entry public.allowlist%rowtype;
begin
  select * into entry from public.allowlist where lower(email) = lower(new.email);

  if not found then
    raise exception using
      errcode = '42501',
      message = format('%s is not on the allowlist for this workspace.', new.email);
  end if;

  insert into public.members (
    id, email, display_name, username, specialty, can_invoke_agent, is_admin
  )
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(entry.display_name, ''), split_part(new.email, '@', 1)),
    public.derive_username(coalesce(nullif(entry.username, ''), split_part(new.email, '@', 1))),
    entry.specialty,
    entry.can_invoke_agent,
    entry.is_admin
  );

  return new;
end;
$$;

-- Anyone who signed in before this migration has no handle yet.
update public.members
set username = public.derive_username(split_part(email, '@', 1))
where username is null;

-- ---------------------------------------------------------------------------
-- Access. Both new tables are reference data: every member reads them, no
-- member writes them.
-- ---------------------------------------------------------------------------
alter table public.specialties   enable row level security;
alter table public.channel_areas enable row level security;

create policy specialties_read on public.specialties
  for select to authenticated using (public.is_member());

create policy channel_areas_read on public.channel_areas
  for select to authenticated using (public.is_member());

-- Widen the column grant from 0001 so people can set their own handle and
-- specialty. can_invoke_agent and is_admin stay off the list -- that is the
-- whole point of granting by column rather than by row.
grant update (display_name, github_login, username, specialty)
  on public.members to authenticated;

-- ---------------------------------------------------------------------------
-- Seed. Paul's specialty is a guess from the shape of the work -- one UPDATE
-- to change it. The path mapping below is drawn from the actual layout of
-- metaphorz/Multimodel.
-- ---------------------------------------------------------------------------
update public.allowlist
set username = 'paul', specialty = 'simulation'
where email = 'metaphorz@gmail.com';

update public.members
set username = 'paul', specialty = 'simulation'
where email = 'metaphorz@gmail.com';

insert into public.channel_areas (channel_id, specialty, paths, note)
select c.id, v.specialty, v.paths, v.note
from public.channels c
cross join (values
  ('meteorology',
   array['pipeline/windfield.py', 'pipeline/windfield_dynamic.py',
         'pipeline/windfield_dynamic_batch.py', 'pipeline/windfield_grid.py',
         'pipeline/windfield_ua.py', 'pipeline/build_roughness.py',
         'pipeline/build_roughness_directional.py',
         'pipeline/historical_domain_ike.py', 'HistoricalIKE/'],
   'Wind field generation, surface roughness and historical storm comparison.'),
  ('statistics',
   array['pipeline/make_lhs_design.py', 'pipeline/make_constrained_design.py',
         'pipeline/make_test_design.py', 'pipeline/fit_metamodels.py',
         'pipeline/holdout_points.py', 'pipeline/holdout_test.py',
         'pipeline/analyze_hurdat2_grid.py'],
   'Experimental design, metamodel fitting and holdout validation.'),
  ('actuarial',
   array['pipeline/build_exposure.py', 'pipeline/build_exposure_tax.py',
         'pipeline/build_vulnerability.py', 'pipeline/fill_form_s6.py',
         'chris/forms6/'],
   'Exposure and vulnerability construction, and regulatory form output.'),
  ('geospatial',
   array['pipeline/build_grid.py', 'pipeline/build_florida_boundary.py',
         'pipeline/add_place_names.py', 'data/tiger/', 'data/cadastral/'],
   'Grid construction, boundaries and cadastral/census geography.'),
  ('visualization',
   array['web/viewer.js', 'web/windfield.js', 'web/contour.js', 'web/anim.js',
         'web/analysis.js', 'web/poi.js', 'web/popup.js'],
   'The browser viewer: rendering, animation and interaction.'),
  ('engineering',
   array['pipeline/read_inputs.py', 'pipeline/precompute_live.py',
         'requirements.txt', 'tests/'],
   'Pipeline plumbing, inputs, precomputation and tests.')
) as v(specialty, paths, note)
where c.slug = 'multimodel';
