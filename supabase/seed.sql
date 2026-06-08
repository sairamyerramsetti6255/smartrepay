-- Demo seed: run in Supabase SQL Editor (or use in-app "Load demo data" while signed in)

insert into borrowers (full_name, aliases, employer) values
  ('John Martinez', array['J. Martinez', 'Martinez Consulting'], 'Acme Corp'),
  ('Sarah Chen', array['S. Chen LLC'], 'TechStart Inc'),
  ('Robert Williams', array['Bob Williams', 'R. Williams'], 'Global Finance')
on conflict do nothing;

insert into loans (borrower_id, loan_number, outstanding_balance, status)
select id, 'LN-10042', 12500.00, 'active' from borrowers where full_name = 'John Martinez'
on conflict (loan_number) do nothing;

insert into loans (borrower_id, loan_number, outstanding_balance, status)
select id, 'LN-10089', 8200.50, 'active' from borrowers where full_name = 'Sarah Chen'
on conflict (loan_number) do nothing;

insert into loans (borrower_id, loan_number, outstanding_balance, status)
select id, 'LN-10115', 45000.00, 'active' from borrowers where full_name = 'Robert Williams'
on conflict (loan_number) do nothing;

-- Sample pending transactions (today) for matching demo
insert into transactions (date, payer, description, amount, reference, status, import_hash)
select current_date, 'John Martinez', 'Loan repayment Acme Corp payroll', 500.00, 'REF-1001', 'pending',
  encode(sha256((current_date::text || '|John Martinez|500|REF-1001')::bytea), 'hex')
where not exists (select 1 from transactions where import_hash = encode(sha256((current_date::text || '|John Martinez|500|REF-1001')::bytea), 'hex'));

insert into transactions (date, payer, description, amount, reference, status, import_hash)
select current_date, 'Sarah Chen', 'Monthly payment TechStart Inc', 350.50, 'REF-1002', 'pending',
  encode(sha256((current_date::text || '|Sarah Chen|350.5|REF-1002')::bytea), 'hex')
where not exists (select 1 from transactions where import_hash = encode(sha256((current_date::text || '|Sarah Chen|350.5|REF-1002')::bytea), 'hex'));

insert into transactions (date, payer, description, amount, reference, status, import_hash)
select current_date, 'Robert Williams', 'Wire Global Finance', 1200.00, 'REF-1003', 'pending',
  encode(sha256((current_date::text || '|Robert Williams|1200|REF-1003')::bytea), 'hex')
where not exists (select 1 from transactions where import_hash = encode(sha256((current_date::text || '|Robert Williams|1200|REF-1003')::bytea), 'hex'));

insert into transactions (date, payer, description, amount, reference, status, import_hash)
select current_date, 'Unknown Vendor LLC', 'Unidentified deposit', 99.00, 'REF-9999', 'pending',
  encode(sha256((current_date::text || '|Unknown Vendor LLC|99|REF-9999')::bytea), 'hex')
where not exists (select 1 from transactions where import_hash = encode(sha256((current_date::text || '|Unknown Vendor LLC|99|REF-9999')::bytea), 'hex'));
