alter table if exists employee_ratings
  drop constraint if exists employee_ratings_stage_check;

alter table if exists employee_ratings
  add constraint employee_ratings_stage_check
  check (stage in ('self', 'manager', 'hod', 'final'));
