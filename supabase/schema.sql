-- ============================================================================
-- أثري — مخطط Supabase الكامل
-- نفّذ هذا الملف مرة واحدة من: Supabase Dashboard → SQL Editor → New query
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1) الملف المهني
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  job_title text not null default '',
  organization text not null default '',
  specialization text not null default '',
  location text not null default '',
  contact_email text not null default '',
  phone text not null default '',
  website text not null default '',
  years_experience text not null default '',
  bio text not null default '',
  skills jsonb not null default '[]'::jsonb check (jsonb_typeof(skills) = 'array'),
  photo jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2) عناصر الملف: الإنجازات والشواهد والتقارير
-- ----------------------------------------------------------------------------
create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  section text not null check (section in ('achievements', 'evidence', 'reports')),
  title text not null default 'بدون عنوان',
  category text not null default '',
  item_date date,
  description text not null default '',
  tags jsonb not null default '[]'::jsonb check (jsonb_typeof(tags) = 'array'),
  link text not null default '',
  attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  content text not null default '',
  impact text not null default '',
  status text not null default '' check (status in ('', 'draft', 'final', 'approved')),
  evidence_type text not null default '' check (evidence_type in ('', 'document', 'image', 'link', 'note')),
  linked_achievement_id uuid references public.items(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint items_link_only_for_evidence
    check (linked_achievement_id is null or section = 'evidence')
);

create index if not exists items_user_updated_idx
  on public.items (user_id, updated_at desc);
create index if not exists items_user_section_updated_idx
  on public.items (user_id, section, updated_at desc);
create index if not exists items_linked_achievement_idx
  on public.items (linked_achievement_id)
  where linked_achievement_id is not null;

-- ----------------------------------------------------------------------------
-- 3) سجل النشاط
-- ----------------------------------------------------------------------------
create table if not exists public.activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'created',
  section text check (section is null or section in ('achievements', 'evidence', 'reports')),
  title text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists activity_user_created_idx
  on public.activity (user_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 4) الدوال والمشغلات
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists items_set_updated_at on public.items;
create trigger items_set_updated_at
before update on public.items
for each row execute function public.set_updated_at();

-- إنشاء ملف مهني تلقائيًا عند إنشاء حساب جديد
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, contact_email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.email, '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- التأكد من أن الشاهد مرتبط بإنجاز يملكه المستخدم نفسه
create or replace function public.validate_item_link()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.linked_achievement_id is not null then
    if not exists (
      select 1
      from public.items
      where id = new.linked_achievement_id
        and user_id = new.user_id
        and section = 'achievements'
    ) then
      raise exception 'linked_achievement_id must reference an achievement owned by the same user';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists items_validate_link on public.items;
create trigger items_validate_link
before insert or update on public.items
for each row execute function public.validate_item_link();

-- ----------------------------------------------------------------------------
-- 5) تفعيل Row Level Security
-- ----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.items enable row level security;
alter table public.activity enable row level security;

-- الملف المهني: كل مستخدم يرى ويعدّل ملفه فقط
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check ((select auth.uid()) = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

drop policy if exists "profiles_delete_own" on public.profiles;
create policy "profiles_delete_own"
  on public.profiles for delete
  to authenticated
  using ((select auth.uid()) = id);

-- العناصر: كل مستخدم يرى ويضيف ويعدّل ويحذف عناصره فقط
drop policy if exists "items_select_own" on public.items;
create policy "items_select_own"
  on public.items for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "items_insert_own" on public.items;
create policy "items_insert_own"
  on public.items for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "items_update_own" on public.items;
create policy "items_update_own"
  on public.items for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "items_delete_own" on public.items;
create policy "items_delete_own"
  on public.items for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- النشاط: قراءة وإضافة فقط، ولا يمكن تعديل سجل النشاط أو حذفه
drop policy if exists "activity_select_own" on public.activity;
create policy "activity_select_own"
  on public.activity for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "activity_insert_own" on public.activity;
create policy "activity_insert_own"
  on public.activity for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- ----------------------------------------------------------------------------
-- 6) الصلاحيات
-- ----------------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.items to authenticated;
grant select, insert on public.activity to authenticated;

revoke all on public.profiles from anon;
revoke all on public.items from anon;
revoke all on public.activity from anon;

-- ----------------------------------------------------------------------------
-- 7) استبدال المساحة بالكامل (النسخ الاحتياطي / الاستيراد)
-- ----------------------------------------------------------------------------
create or replace function public.replace_workspace(payload jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_profile jsonb;
  v_items jsonb;
  v_activity jsonb;
  v_section text;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'invalid payload';
  end if;

  if octet_length(payload::text) > 5 * 1024 * 1024 then
    raise exception 'payload too large';
  end if;

  v_items := coalesce(payload->'items', '[]'::jsonb);
  v_activity := coalesce(payload->'activity', '[]'::jsonb);

  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'items must be an array';
  end if;
  if jsonb_typeof(v_activity) <> 'array' then
    raise exception 'activity must be an array';
  end if;

  v_profile := coalesce(payload->'profile', '{}'::jsonb);
  if jsonb_typeof(v_profile) <> 'object' then
    v_profile := '{}'::jsonb;
  end if;

  -- حذف المحتوى الحالي للمستخدم فقط
  update public.items
  set linked_achievement_id = null
  where user_id = v_uid and linked_achievement_id is not null;
  delete from public.items where user_id = v_uid;
  delete from public.activity where user_id = v_uid;

  -- حفظ الملف المهني
  insert into public.profiles (
    id, full_name, job_title, organization, specialization, location,
    contact_email, phone, website, years_experience, bio, skills, photo, updated_at
  )
  values (
    v_uid,
    coalesce(v_profile->>'fullName', ''),
    coalesce(v_profile->>'jobTitle', ''),
    coalesce(v_profile->>'organization', ''),
    coalesce(v_profile->>'specialization', ''),
    coalesce(v_profile->>'location', ''),
    coalesce(v_profile->>'email', ''),
    coalesce(v_profile->>'phone', ''),
    coalesce(v_profile->>'website', ''),
    coalesce(v_profile->>'yearsExperience', ''),
    coalesce(v_profile->>'bio', ''),
    case when jsonb_typeof(v_profile->'skills') = 'array' then v_profile->'skills' else '[]'::jsonb end,
    case when jsonb_typeof(v_profile->'photo') = 'object' then v_profile->'photo' else null end,
    now()
  )
  on conflict (id) do update set
    full_name = excluded.full_name,
    job_title = excluded.job_title,
    organization = excluded.organization,
    specialization = excluded.specialization,
    location = excluded.location,
    contact_email = excluded.contact_email,
    phone = excluded.phone,
    website = excluded.website,
    years_experience = excluded.years_experience,
    bio = excluded.bio,
    skills = excluded.skills,
    photo = excluded.photo,
    updated_at = now();

  -- إدخال الإنجازات أولًا، ثم الشواهد، ثم التقارير
  foreach v_section in array array['achievements', 'evidence', 'reports']
  loop
    insert into public.items (
      id, user_id, section, title, category, item_date, description, tags,
      link, attachments, content, impact, status, evidence_type,
      linked_achievement_id, created_at, updated_at
    )
    select
      coalesce(nullif(item->>'id', '')::uuid, gen_random_uuid()),
      v_uid,
      v_section,
      coalesce(nullif(item->>'title', ''), 'بدون عنوان'),
      coalesce(item->>'category', ''),
      nullif(item->>'date', '')::date,
      coalesce(item->>'description', ''),
      case when jsonb_typeof(item->'tags') = 'array' then item->'tags' else '[]'::jsonb end,
      coalesce(item->>'link', ''),
      case when jsonb_typeof(item->'attachments') = 'array' then item->'attachments' else '[]'::jsonb end,
      coalesce(item->>'content', ''),
      coalesce(item->>'impact', ''),
      case when item->>'status' in ('draft', 'final', 'approved') then item->>'status' else '' end,
      case when item->>'evidenceType' in ('document', 'image', 'link', 'note') then item->>'evidenceType' else '' end,
      case
        when v_section = 'evidence' and nullif(item->>'linkedAchievementId', '') is not null
          then (item->>'linkedAchievementId')::uuid
        else null
      end,
      coalesce(nullif(item->>'createdAt', '')::timestamptz, now()),
      coalesce(nullif(item->>'updatedAt', '')::timestamptz, now())
    from jsonb_array_elements(v_items) as item
    where item->>'section' = v_section;
  end loop;

  -- حفظ سجل النشاط
  insert into public.activity (id, user_id, kind, section, title, created_at)
  select
    coalesce(nullif(entry->>'id', '')::uuid, gen_random_uuid()),
    v_uid,
    coalesce(nullif(entry->>'kind', ''), 'created'),
    case when entry->>'section' in ('achievements', 'evidence', 'reports') then entry->>'section' else null end,
    coalesce(entry->>'title', ''),
    coalesce(nullif(entry->>'at', '')::timestamptz, now())
  from jsonb_array_elements(v_activity) as entry
  limit 60
  on conflict (id) do nothing;
end;
$$;

revoke all on function public.replace_workspace(jsonb) from public;
revoke all on function public.replace_workspace(jsonb) from anon;
grant execute on function public.replace_workspace(jsonb) to authenticated;

revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon;
revoke all on function public.handle_new_user() from authenticated;

-- تحديث مخطط PostgREST فورًا
notify pgrst, 'reload schema';
