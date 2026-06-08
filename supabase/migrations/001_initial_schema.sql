-- SmartRepay AI initial schema (ordered for FK dependencies)

create table if not exists borrowers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  aliases text[],
  employer text,
  created_at timestamptz default now()
);

create table if not exists loans (
  id uuid primary key default gen_random_uuid(),
  borrower_id uuid references borrowers(id),
  loan_number text unique not null,
  outstanding_balance numeric(12,2),
  status text default 'active',
  created_at timestamptz default now()
);

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  payer text,
  description text,
  amount numeric(12,2) not null,
  reference text,
  status text default 'pending' check (status in ('pending','matched','exception','posted')),
  confidence_score numeric(5,2),
  matched_borrower_id uuid references borrowers(id),
  loan_id uuid references loans(id),
  import_hash text unique,
  created_at timestamptz default now()
);

create table if not exists exceptions (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid references transactions(id),
  type text check (type in ('unmatched','duplicate','partial','suspicious')),
  assigned_to text,
  sla_hours int default 24,
  status text default 'open' check (status in ('open','resolved','escalated')),
  resolution_note text,
  created_at timestamptz default now(),
  resolved_at timestamptz
);

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  entity text,
  entity_id uuid,
  action text,
  actor text,
  prior_value jsonb,
  new_value jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_transactions_status on transactions(status);
create index if not exists idx_transactions_date on transactions(date);
create index if not exists idx_exceptions_status on exceptions(status);
create index if not exists idx_audit_log_created on audit_log(created_at desc);

alter table borrowers enable row level security;
alter table loans enable row level security;
alter table transactions enable row level security;
alter table exceptions enable row level security;
alter table audit_log enable row level security;

create policy "authenticated_all_borrowers" on borrowers for all to authenticated using (true) with check (true);
create policy "authenticated_all_loans" on loans for all to authenticated using (true) with check (true);
create policy "authenticated_all_transactions" on transactions for all to authenticated using (true) with check (true);
create policy "authenticated_all_exceptions" on exceptions for all to authenticated using (true) with check (true);
create policy "authenticated_all_audit_log" on audit_log for all to authenticated using (true) with check (true);
