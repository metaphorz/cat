-- cat — engineering means engineering.
--
-- 'engineering' was originally written as "software engineer", which is wrong
-- for a catastrophe-modelling group: engineering here is civil, coastal and
-- structural. The software side moves to 'computer_science', which was added
-- separately and is the better home for it.
--
-- This also reassigns the channel_areas mapping for #multimodel. In a wind
-- model the standard split is that engineering owns the damage relationship
-- (how structures respond to wind) while the actuary owns exposure and loss.

update public.specialties
set label       = 'Engineer',
    description = 'Civil, coastal and structural engineering: the built environment, and how it responds to hazard.'
where slug = 'engineering';

update public.specialties
set description = 'Software and systems: pipeline structure, algorithms, packaging, performance and tests.'
where slug = 'computer_science';

-- Pipeline plumbing was filed under engineering; it belongs to computer science.
update public.channel_areas
set specialty = 'computer_science'
where specialty = 'engineering'
  and channel_id = (select id from public.channels where slug = 'multimodel');

update public.channel_areas
set paths = array[
      'pipeline/read_inputs.py', 'pipeline/precompute_live.py',
      'pipeline/build_all.sh', 'requirements.txt', 'tests/', 'web/vendor/'
    ],
    note = 'Pipeline structure, inputs, precomputation, packaging and tests.'
where specialty = 'computer_science'
  and channel_id = (select id from public.channels where slug = 'multimodel');

-- And give engineering the part of the model that is actually theirs.
insert into public.channel_areas (channel_id, specialty, paths, note)
select c.id, 'engineering',
       array['pipeline/build_vulnerability.py', 'inputs/'],
       'Vulnerability and damage relationships: how the built environment responds to wind.'
from public.channels c
where c.slug = 'multimodel'
on conflict (channel_id, specialty) do update
  set paths = excluded.paths,
      note  = excluded.note;
