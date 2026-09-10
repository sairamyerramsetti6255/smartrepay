import { randomUUID } from 'crypto'

/**
 * QuickBooks Data Module — additive-only database migration.
 * Called once at server startup inside initDb().
 * Uses CREATE TABLE IF NOT EXISTS — never destructive.
 */
export function qbMigrateDb(db) {
  db.exec(`
    -- Batch tracking for each import run
    create table if not exists qb_import_batches (
      id text primary key,
      source_type text not null,
      source_name text,
      total_files integer default 0,
      total_records integer default 0,
      valid_records integer default 0,
      invalid_records integer default 0,
      duplicate_records integer default 0,
      needs_review_records integer default 0,
      status text default 'processing' check (status in ('processing','completed','completed_with_exceptions','failed')),
      created_by text,
      created_at text default (datetime('now')),
      completed_at text
    );

    -- Every imported source item (PDF, image, text, SmartRepay txn, etc.)
    create table if not exists qb_input_library (
      id text primary key,
      batch_id text references qb_import_batches(id),
      source_type text not null check (source_type in ('pdf','image','excel','csv','text','free_text','email','loandisk','smartrepay','manual')),
      source_reference_id text,
      source_document_id text,
      original_filename text,
      original_text text,
      email_sender text,
      email_subject text,
      document_type text,
      transaction_type text,
      classification_confidence real,
      extraction_confidence real,
      processing_status text default 'pending' check (processing_status in ('pending','processing','extracted','mapped','validated','error')),
      attachment_status text default 'pending',
      created_by text,
      created_at text default (datetime('now')),
      updated_at text default (datetime('now'))
    );

    -- Per-field AI/OCR extraction results with confidence scores
    create table if not exists qb_extracted_fields (
      id text primary key,
      input_id text references qb_input_library(id),
      field_name text not null,
      raw_value text,
      normalized_value text,
      confidence real default 1.0,
      source_page integer,
      validation_status text default 'pending',
      validation_message text,
      original_value text,
      corrected_value text,
      corrected_by text,
      corrected_at text
    );

    -- Normalized QB-ready transaction records
    create table if not exists qb_transactions (
      id text primary key,
      input_id text references qb_input_library(id),
      batch_id text references qb_import_batches(id),
      template_type text not null check (template_type in ('emi_receipt','payment_disbursed','account_to_create')),
      transaction_date text,
      borrower_id text,
      loan_id text,
      vendor_name text,
      customer_name text,
      reference_number text,
      amount real,
      currency text default 'BSD',
      payment_method text,
      deposit_to text,
      bank_account text,
      mapped_payload_json text,
      validation_status text default 'pending' check (validation_status in ('pending','valid','invalid','needs_review','duplicate')),
      approval_status text default 'pending_review' check (approval_status in ('pending_review','approved','rejected','exported')),
      transaction_hash text unique,
      ai_confidence real,
      approved_by text,
      approved_at text,
      rejection_reason text,
      source_smartrepay_id text,
      created_at text default (datetime('now')),
      updated_at text default (datetime('now'))
    );

    -- EMI line items (principal / interest / fee breakdown)
    create table if not exists qb_transaction_lines (
      id text primary key,
      transaction_id text references qb_transactions(id),
      line_number integer not null,
      account_name text not null,
      amount real not null,
      memo text
    );

    -- Proposed new QuickBooks accounts
    create table if not exists qb_accounts_to_create (
      id text primary key,
      transaction_id text references qb_transactions(id),
      account_name text not null,
      account_type text not null,
      account_number text,
      sub_account_of text,
      description text,
      validation_status text default 'pending',
      existence_status text default 'unknown' check (existence_status in ('unknown','existing','new_required','created','inactive'))
    );

    -- Attachment validation records
    create table if not exists qb_attachments (
      id text primary key,
      input_id text references qb_input_library(id),
      document_id text,
      filename text,
      mime_type text,
      document_type text,
      ocr_confidence real,
      status text default 'pending' check (status in ('pending','valid','invalid','unsupported','corrupted','low_quality','password_protected','ocr_failed','duplicate','needs_review')),
      validation_analysis text,
      created_at text default (datetime('now'))
    );

    -- Rule-by-rule validation outcomes per transaction
    create table if not exists qb_validation_results (
      id text primary key,
      transaction_id text references qb_transactions(id),
      rule_code text not null,
      field_name text,
      severity text not null check (severity in ('INFO','WARNING','ERROR','BLOCKING')),
      status text not null check (status in ('pass','fail')),
      message text,
      created_at text default (datetime('now'))
    );

    -- Export batch history
    create table if not exists qb_export_batches (
      id text primary key,
      format text not null check (format in ('json','csv','excel','iif')),
      record_count integer default 0,
      total_amount real default 0,
      generated_by text,
      generated_at text default (datetime('now')),
      status text default 'pending' check (status in ('pending','completed','failed')),
      file_reference text,
      payload_json text
    );

    -- RPA Bot Execution Runs
    create table if not exists qb_rpa_runs (
      id text primary key,
      run_type text not null default 'full_pipeline',
      status text default 'running' check (status in ('running','completed','completed_with_exceptions','failed')),
      records_scanned integer default 0,
      records_extracted integer default 0,
      records_resolved integer default 0,
      records_validated integer default 0,
      records_auto_approved integer default 0,
      records_excepted integer default 0,
      records_exported integer default 0,
      confidence_threshold real default 0.90,
      execution_time_ms integer default 0,
      triggered_by text default 'user',
      logs_json text,
      summary_text text,
      created_at text default (datetime('now')),
      completed_at text
    );

    -- RPA Bot Automation Settings
    create table if not exists qb_rpa_settings (
      id text primary key,
      autopilot_enabled integer default 1,
      auto_approve_min_confidence real default 0.90,
      auto_ingest_smartrepay integer default 1,
      auto_resolve_borrowers integer default 1,
      auto_export_packages integer default 1,
      schedule_interval text default 'hourly',
      notification_email text,
      created_at text default (datetime('now')),
      updated_at text default (datetime('now'))
    );

    -- Indexes for performance
    create index if not exists idx_qb_input_library_batch on qb_input_library(batch_id);
    create index if not exists idx_qb_input_library_source on qb_input_library(source_type);
    create index if not exists idx_qb_transactions_status on qb_transactions(validation_status);
    create index if not exists idx_qb_transactions_approval on qb_transactions(approval_status);
    create index if not exists idx_qb_transactions_template on qb_transactions(template_type);
    create index if not exists idx_qb_transactions_hash on qb_transactions(transaction_hash);
    create index if not exists idx_qb_transactions_batch on qb_transactions(batch_id);
    create index if not exists idx_qb_validation_txn on qb_validation_results(transaction_id);
    create index if not exists idx_qb_lines_txn on qb_transaction_lines(transaction_id);
    create index if not exists idx_qb_rpa_runs_status on qb_rpa_runs(status);
    create index if not exists idx_qb_rpa_runs_created on qb_rpa_runs(created_at);
  `)

  console.log('[QB] Database migration complete — qb_* tables ready')
}
