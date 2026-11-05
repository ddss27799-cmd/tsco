-- =====================================================================
-- Quik + TSCO: имя/фамилия, баланс ◈, онлайн, посещаемость, закрепление
-- Выполнить один раз: Supabase -> SQL Editor -> New query -> Run
-- =====================================================================

-- 1. Новые поля профиля
alter table public.profiles add column if not exists first_name text not null default '';
alter table public.profiles add column if not exists last_name  text not null default '';
alter table public.profiles add column if not exists balance    bigint not null default 0;
alter table public.profiles add column if not exists is_admin   boolean not null default false;
do $$ begin
  alter table public.profiles add constraint balance_nonneg check (balance >= 0);
exception when duplicate_object then null; end $$;

-- 2. Баланс нельзя менять с клиента: пользователь может править только свои имена
revoke update on public.profiles from authenticated, anon;
grant update (display_name, first_name, last_name) on public.profiles to authenticated;

-- 3. Служебные таблицы (доступ только через функции ниже)
create table if not exists public.presence (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_seen timestamptz not null default now()
);
create table if not exists public.app_visits (
  app text not null,
  day date not null default current_date,
  vid text not null,
  primary key (app, day, vid)
);
create table if not exists public.project_pins (
  app text primary key,
  pinned boolean not null default false
);
insert into public.project_pins(app) values ('quik'),('tsm'),('quicliker') on conflict do nothing;

alter table public.presence     enable row level security;
alter table public.app_visits   enable row level security;
alter table public.project_pins enable row level security;

-- 4. Функции

-- Пульс: вызывается из Quik каждые 60 секунд
create or replace function public.heartbeat() returns void
language sql security definer set search_path = public as $$
  insert into presence(user_id, last_seen) values (auth.uid(), now())
  on conflict (user_id) do update set last_seen = now();
$$;

-- Сколько людей сейчас в Quik (считается последние 2 минуты)
create or replace function public.online_count() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from presence where last_seen > now() - interval '2 minutes';
$$;

-- Учёт посещения: app = quik | tsm | quicliker | hub, vid = id пользователя или анонимный id
create or replace function public.track_visit(p_app text, p_vid text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_app not in ('quik','tsm','quicliker','hub') then return; end if;
  if p_vid is null or length(p_vid) < 8 or length(p_vid) > 64 then return; end if;
  insert into app_visits(app, day, vid) values (p_app, current_date, p_vid)
  on conflict do nothing;
end $$;

-- Посещаемость за сегодня по проектам + закрепление
create or replace function public.app_popularity()
returns table(app text, users_today int, pinned boolean)
language sql stable security definer set search_path = public as $$
  select p.app,
         coalesce((select count(distinct v.vid)::int from app_visits v
                    where v.app = p.app and v.day = current_date), 0),
         p.pinned
  from project_pins p;
$$;

-- Всего уникальных людей на сайте за сегодня (все проекты и хаб)
create or replace function public.site_daily_users() returns int
language sql stable security definer set search_path = public as $$
  select count(distinct vid)::int from app_visits where day = current_date;
$$;

-- Закрепить проект (только админ). Закреплён может быть только один.
create or replace function public.set_pin(p_app text, p_pinned boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from profiles where id = auth.uid() and is_admin) then
    raise exception 'forbidden';
  end if;
  if p_pinned then
    update project_pins set pinned = (app = p_app);
  else
    update project_pins set pinned = false where app = p_app;
  end if;
end $$;

-- Выдать или забрать ◈ у пользователя по имени (только админ)
create or replace function public.admin_add_coins(p_name text, p_amount bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare nb bigint;
begin
  if not exists (select 1 from profiles where id = auth.uid() and is_admin) then
    raise exception 'forbidden';
  end if;
  if p_amount is null or abs(p_amount) > 1000000000 then raise exception 'bad amount'; end if;
  update profiles set balance = balance + p_amount
   where lower(username) = lower(p_name)
   returning balance into nb;
  if nb is null then raise exception 'no user'; end if;
  return nb;
end $$;

-- 5. Права на вызов
revoke execute on function public.heartbeat()                      from public, anon;
revoke execute on function public.set_pin(text, boolean)           from public, anon;
revoke execute on function public.admin_add_coins(text, bigint)    from public, anon;
grant  execute on function public.heartbeat()                      to authenticated;
grant  execute on function public.set_pin(text, boolean)           to authenticated;
grant  execute on function public.admin_add_coins(text, bigint)    to authenticated;
grant  execute on function public.online_count()                   to anon, authenticated;
grant  execute on function public.track_visit(text, text)          to anon, authenticated;
grant  execute on function public.app_popularity()                 to anon, authenticated;
grant  execute on function public.site_daily_users()               to anon, authenticated;
