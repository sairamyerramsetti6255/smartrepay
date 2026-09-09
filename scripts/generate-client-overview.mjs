/**
 * Generates docs/SmartRepay_Client_Overview.docx
 * Run: node scripts/generate-client-overview.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  PageBreak,
} from 'docx'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outPath = path.join(__dirname, '..', 'docs', 'SmartRepay_Client_Overview.docx')

const PURPLE = '6F42C1'
const GRAY = '64748B'
const LIGHT = 'F8FAFC'

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 200 },
    children: [new TextRun({ text, bold: true, size: 32, color: PURPLE })],
  })
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 160 },
    children: [new TextRun({ text, bold: true, size: 26, color: '1E293B' })],
  })
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 120 },
    children: [new TextRun({ text, bold: true, size: 22, color: '334155' })],
  })
}

function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 140, line: 276 },
    children: [new TextRun({ text, size: 22, ...opts })],
  })
}

function bullet(text, level = 0) {
  return new Paragraph({
    bullet: { level },
    spacing: { after: 80 },
    children: [new TextRun({ text, size: 22 })],
  })
}

function spacer() {
  return new Paragraph({ spacing: { after: 120 }, children: [] })
}

function tableRow(cells, header = false) {
  return new TableRow({
    children: cells.map(
      (text) =>
        new TableCell({
          shading: header ? { type: ShadingType.CLEAR, fill: LIGHT } : undefined,
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          children: [
            new Paragraph({
              children: [new TextRun({ text, bold: header, size: 20 })],
            }),
          ],
        })
    ),
  })
}

function featureTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
      left: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
      right: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
      insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
    },
    rows: [tableRow(['Feature', 'What it does for you'], true), ...rows.map((r) => tableRow(r))],
  })
}

const doc = new Document({
  creator: 'SmartRepay AI',
  title: 'SmartRepay AI — Client Overview',
  description: 'Client-facing feature overview for Simplified Lending Bahamas',
  sections: [
    {
      properties: {},
      children: [
        // Cover
        new Paragraph({ spacing: { before: 2400 }, children: [] }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: 'SmartRepay AI', bold: true, size: 56, color: PURPLE })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 200, after: 400 },
          children: [new TextRun({ text: 'Loan Repayment Reconciliation Platform', size: 28, color: GRAY })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new TextRun({ text: 'Prepared for: Simplified Lending Bahamas', size: 24, italics: true })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: `Document date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
              size: 22,
              color: GRAY,
            }),
          ],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 600 },
          children: [
            new TextRun({
              text: 'CONFIDENTIAL — Client overview for business and operations teams',
              size: 20,
              color: GRAY,
              italics: true,
            }),
          ],
        }),

        new Paragraph({ children: [new PageBreak()] }),

        // Executive summary
        h1('1. Executive Summary'),
        p(
          'SmartRepay AI is a purpose-built reconciliation platform that helps Simplified Lending Bahamas turn messy bank statements, employer payroll files, and walk-in receipts into clean, borrower-level repayment records. Instead of manually searching spreadsheets and LoanDisk for every payment, your team uploads source documents once, runs intelligent matching, reviews only the exceptions, and exports approved results back to LoanDisk.'
        ),
        p(
          'The system is designed around how collections and mid-office teams actually work: a guided four-step workflow (Upload → Match → Review → Reconcile), a live dashboard with matching and repayment analytics, and configurable rules so name and amount logic can be tuned without developer involvement.'
        ),
        bullet('Reduces manual matching effort through hybrid name + amount scoring'),
        bullet('Supports multiple file types: bank PDFs, employer statements, Excel/CSV, and scanned images'),
        bullet('Surfaces only uncertain payments for human review — high-confidence matches auto-approve'),
        bullet('Keeps a full audit trail and integrates with your existing LoanDisk / SQL Server data'),
        bullet('Captures walk-in, WhatsApp, email, and phone receipts alongside bank credits'),

        new Paragraph({ children: [new PageBreak()] }),

        h1('2. Who Uses SmartRepay'),
        p('SmartRepay serves different roles across your lending operation. Each role sees the screens relevant to their responsibilities.'),
        featureTable([
          ['Collections', 'Upload statements, run matching, review unmatched payments, enter manual receipts'],
          ['Mid-office', 'Resolve exceptions, confirm borrower assignments, monitor pipeline progress'],
          ['Accounting', 'Approve matched payments for posting, export to LoanDisk, run daily reports'],
          ['System owner', 'Configure matching rules, thresholds, and algorithm weights; full system access'],
        ]),
        spacer(),
        p(
          'Access is controlled by role. Settings such as Matching Rules are restricted to system owners. Posting on the Reconcile screen requires accounting or system-owner privileges.'
        ),

        h1('3. The Reconciliation Workflow'),
        p(
          'SmartRepay guides users through a linear workflow shown in the sidebar. Each step is marked complete when its work is done, so teams always know what to do next.'
        ),
        h3('Step 1 — Upload Documents'),
        p(
          'Import bank statements, employer payroll deduction files, Excel/CSV repayment exports, or scanned images. You can upload multiple files in one action (for example, a bank statement and an employer listing for the same period). Each file is parsed, previewed, and staged before import.'
        ),
        bullet('Bank statement — PDF or spreadsheet with credit transactions'),
        bullet('Employer statement — payroll deductions with employee name and amount per row'),
        bullet('Excel / CSV — standard repayment export layouts'),
        bullet('Image / scan — photo of a statement with AI-assisted extraction'),
        bullet('Standard Bahamas bank exports parse automatically; non-standard layouts can use AI column mapping'),

        h3('Step 2 — Run Matching'),
        p(
          'The matching engine compares each imported credit line against your active loan book (synced from LoanDisk). It scores candidates by borrower name similarity and EMI amount reconciliation, then assigns a confidence level. Matches above the auto-match threshold are approved automatically; others appear in the review queue.'
        ),

        h3('Step 3 — Review Unmatched'),
        p(
          'Payments that could not be matched with sufficient confidence appear in the exception queue. Staff can search, filter, and open a detailed review drawer showing name match scores, EMI comparison, and the borrower’s loan statement. Actions include confirm, reassign to another borrower, or reject.'
        ),

        h3('Step 4 — Reconcile & Post'),
        p(
          'Confirmed matches are grouped by date for final approval. Accounting users approve posts and export a LoanDisk-compatible file. This closes the loop from bank credit to recorded repayment.'
        ),

        new Paragraph({ children: [new PageBreak()] }),

        h1('4. Feature Guide — Screen by Screen'),

        h2('4.1 Dashboard'),
        p(
          'The Dashboard is your operations command centre. It shows reconciliation pipeline volume, matching algorithm analytics, import file health, and borrower repayment ratings — all in one place.'
        ),
        h3('Reconciliation pipeline'),
        bullet('Files imported → transactions staged → processed → matched vs unmatched → manual receipts'),
        bullet('Badges for auto-matched, confirmed, and needs-review counts with a link to the match queue'),

        h3('Repayment health'),
        bullet('Active borrowers and loan count'),
        bullet('At-risk / overdue loan count for follow-up'),
        bullet('Manual receipt volume and value'),

        h3('Hybrid matching algorithm analytics'),
        bullet('Confidence bucket distribution: Same person, Very likely, Review, Different person'),
        bullet('Name score tiers: full name + amount (100), full name (90+), first + last (70+), below threshold'),
        bullet('Amount match kinds: exact EMI, sum of loans, subset, partial payment, mismatch'),
        bullet('Missing / exception patterns: why lines failed (name gate, amount mismatch, partial payment, etc.)'),

        h3('Borrower repayment ratings'),
        bullet('Borrowers grouped into buckets: Excellent, On track, At risk, Overdue, Delinquent, No payments'),
        bullet('Rating is driven by the worst-performing loan per borrower'),
        bullet('Table of borrowers needing attention with days since last EMI payment'),

        h3('Per-file and per-source analytics'),
        bullet('Match rate and average confidence for each imported file'),
        bullet('Confidence breakdown by source type (bank, employer, spreadsheet)'),
        bullet('7-day activity chart: matched, unmatched, and receipts entered'),

        h2('4.2 Upload Documents (Ingest)'),
        p('Central hub for bringing payment data into SmartRepay.'),
        bullet('Drag-and-drop or browse for single or multiple files'),
        bullet('Document type selector ensures the correct parser is applied'),
        bullet('Preview parsed rows before committing to staging'),
        bullet('Imported files list with row counts, matched/unmatched/pending per file'),
        bullet('Staged rows grid with sortable, filterable columns'),
        bullet('Delete imported files and their staged credits when needed'),

        h2('4.3 Run Matching (Match Queue)'),
        p('Where automatic reconciliation happens and staff monitor progress.'),
        bullet('Run Matching button processes all pending staged credits'),
        bullet('Live progress indicator during batch matching'),
        bullet('Filter by All, Matched, or Unmatched'),
        bullet('Scope panel to focus on a specific imported file'),
        bullet('Confidence bucket badges on every row (Same person through Different person)'),
        bullet('Name score and amount match kind visible per transaction'),
        bullet('Review drawer: payer name, match reasoning, EMI comparison, linked loan statement'),
        bullet('Export all transactions to spreadsheet for offline analysis'),

        h2('4.4 Review Unmatched (Exceptions)'),
        p('Dedicated queue for payments that need human decision.'),
        bullet('Filters: Needs action, Unmatched, Needs review, All'),
        bullet('Search by payer name, description, borrower, reference, or source file'),
        bullet('Same rich review drawer as the Match screen'),
        bullet('Export unmatched transactions for external follow-up'),

        h2('4.5 Reconcile & Post'),
        p('Final approval before repayments are sent to LoanDisk.'),
        bullet('Transactions grouped by statement date'),
        bullet('Approve individual or batch posts'),
        bullet('LoanDisk export preview and CSV download'),
        bullet('Restricted to users with posting permission'),

        h2('4.6 Active Loans'),
        p('Read-only view of the live loan book synced from LoanDisk.'),
        bullet('Search by borrower name, loan number, branch, or borrower ID'),
        bullet('Summary cards: total loans, borrowers, EMI totals, outstanding balance'),
        bullet('Loan status badges (active, arrears, overdue, etc.)'),
        bullet('Click any loan number to open the full Loan Statement'),

        h2('4.7 Loan Statement'),
        p('Per-loan repayment history and analytics.'),
        bullet('Borrower details, EMI, balance, installments paid, last payment date'),
        bullet('Combined ledger: LoanDisk-synced repayments plus manual SmartRepay receipts'),
        bullet('Repayment summary: total paid, manual vs synced split, principal/interest/fees'),
        bullet('Export full statement to Excel'),

        h2('4.8 Manual Receipts'),
        p('Capture payments that never appear on a bank statement.'),
        bullet('Add receipts for walk-in, WhatsApp, email, or phone collections'),
        bullet('Link each receipt to a borrower and loan'),
        bullet('Full grid with add, edit, and delete'),
        bullet('Column sort and filter on every field'),
        bullet('Optional receipt file attachment'),

        h2('4.9 Matching Rules (Settings)'),
        p('System owners tune how the engine behaves without code changes.'),
        bullet('Score limits: minimum name score (70), strong name score (90), auto-match confidence (85)'),
        bullet('Confidence weights: name share vs amount share (must total 100%)'),
        bullet('Amount tolerance: allowed variance vs expected EMI'),
        bullet('Typo similarity floor for forgiving spelling differences'),
        bullet('Signal toggles: borrower name field, transaction description'),
        bullet('Amount component scores for exact, sum, subset, partial, and mismatch cases'),
        bullet('Read-only reference for the hybrid name algorithm and confidence buckets'),
        bullet('Live preview: test a payer name against a borrower name and see the score breakdown'),

        h2('4.10 Audit Log'),
        p('Searchable record of system actions for compliance and troubleshooting.'),

        h2('4.11 Daily Report'),
        p('Snapshot of today’s processing: transactions processed, posted, pending, exceptions, and SLA percentage. Printable and shareable.'),

        h2('4.12 Borrowers'),
        p('Borrower directory with sync to SQL Server. Pulls active and current loans from LoanDisk into staging tables used by matching. Sync is append/upsert only — existing data is never deleted. Can be scheduled weekly via server configuration.'),

        new Paragraph({ children: [new PageBreak()] }),

        h1('5. How Matching Works (Plain Language)'),
        p(
          'SmartRepay uses a hybrid matching algorithm designed for real-world Bahamas bank and payroll data, where names are abbreviated, misspelled, or formatted differently from LoanDisk.'
        ),
        h3('Name matching'),
        p('Each first and last name token is scored using a blend of four techniques:'),
        bullet('Jaro-Winkler similarity (45%) — handles transpositions and common typos'),
        bullet('Damerau-Levenshtein similarity (30%) — catches single-character edits'),
        bullet('Double Metaphone phonetic match (15%) — links sound-alike names'),
        bullet('Levenshtein similarity (10%) — general edit distance'),
        p('Both first and last names must pass a typo floor or the match is rejected entirely — preventing false positives such as matching any “Smith” when the payer is “Jamaal Moss”.'),
        spacer(),
        p('Name score tiers:'),
        bullet('0 — No match (name gate failed)'),
        bullet('70–89 — First and last names match (typo-tolerant)'),
        bullet('90–99 — Full name match (all bank tokens found in borrower name)'),
        bullet('100 — Full name plus EMI amount reconciles'),

        h3('Amount matching'),
        p('The engine compares the credit amount against expected EMI(s) for the matched borrower:'),
        bullet('Exact single EMI — payment matches one loan’s expected amount'),
        bullet('Sum all — payment covers multiple loans combined'),
        bullet('Subset — payment covers a subset of the borrower’s loans'),
        bullet('Partial — payment is less than expected (flagged for review)'),
        bullet('Mismatch — amount does not reconcile within tolerance'),

        h3('Confidence buckets'),
        featureTable([
          ['Same person (95%+)', 'High certainty — typically auto-matched'],
          ['Very likely (85–94%)', 'Strong match — usually auto-approved'],
          ['Review (70–84%)', 'First + last pass but needs manual check'],
          ['Different person (<70%)', 'Not a valid match — stays in exception queue'],
        ]),

        new Paragraph({ children: [new PageBreak()] }),

        h1('6. Integration with LoanDisk'),
        p('SmartRepay does not replace LoanDisk — it makes LoanDisk data actionable for daily reconciliation.'),
        bullet('Active loans and borrowers sync from LoanDisk into SQL Server staging tables'),
        bullet('Matching runs against this live loan book index'),
        bullet('Repayment history on loan statements combines LoanDisk records with manual receipts'),
        bullet('Reconcile exports approved matches in LoanDisk-compatible format'),
        bullet('Weekly automated sync can be enabled (default: Sunday 02:00 UTC)'),
        bullet('Manual “Sync to SQL Server” available from the Borrowers screen'),

        h1('7. Data Sources Supported'),
        featureTable([
          ['Bank PDF', 'Credit transactions extracted; balance-delta and amount fallback logic'],
          ['Bank Excel/CSV', 'Standard columns: date, reference, beneficiary, amount'],
          ['Employer payroll', 'Employee name and deduction amount per row'],
          ['Spreadsheet export', 'Flexible column mapping; AI assist for non-standard layouts'],
          ['Scanned image', 'AI extraction for photo/scan uploads'],
          ['Manual receipt', 'Walk-in, WhatsApp, email, phone — entered directly in SmartRepay'],
        ]),

        h1('8. Security & Audit'),
        bullet('Role-based access: collections, mid-office, accounting, system owner'),
        bullet('Authenticated login required for all operational screens'),
        bullet('Audit log tracks key actions across the platform'),
        bullet('Settings changes restricted to system owners'),
        bullet('Posting approvals restricted to accounting and system owners'),

        h1('9. Typical Day for Your Team'),
        p('A practical example of how SmartRepay fits into daily operations:'),
        bullet('Morning: Upload yesterday’s bank statement and any employer deduction files'),
        bullet('Run matching — most payments auto-match within seconds'),
        bullet('Collections reviews the exception queue — confirm or reassign the handful that need attention'),
        bullet('Enter any walk-in or WhatsApp receipts received overnight'),
        bullet('Accounting opens Reconcile, approves matched payments, and exports to LoanDisk'),
        bullet('Manager checks the Dashboard for at-risk borrowers and file-level match rates'),

        h1('10. Benefits Summary'),
        featureTable([
          ['Speed', 'Batch matching replaces line-by-line manual lookup'],
          ['Accuracy', 'Hybrid name algorithm reduces false matches and missed payments'],
          ['Visibility', 'Dashboard analytics on matching quality and repayment health'],
          ['Control', 'Configurable rules and human review for edge cases'],
          ['Completeness', 'Bank credits and manual receipts in one reconciliation picture'],
          ['Traceability', 'Audit log, loan statements, and export history'],
          ['Flexibility', 'Multiple file types and multi-file upload in one session'],
        ]),

        spacer(),
        h1('11. Glossary'),
        featureTable([
          ['Staged credit', 'A payment line imported from a bank/employer file, awaiting or after matching'],
          ['EMI', 'Expected monthly installment amount for a loan'],
          ['Confidence bucket', 'Label describing how certain the system is about a match'],
          ['Exception', 'A payment that could not be auto-matched and needs review'],
          ['Posting', 'Final approval that sends a matched payment toward LoanDisk export'],
          ['LoanDisk', 'Your core loan management system — source of truth for loans and borrowers'],
        ]),

        spacer(),
        new Paragraph({
          spacing: { before: 400 },
          children: [
            new TextRun({
              text: 'For technical setup, API reference, and environment configuration, see the project README. For matching rule changes or onboarding support, contact your SmartRepay implementation team.',
              size: 20,
              italics: true,
              color: GRAY,
            }),
          ],
        }),
      ],
    },
  ],
})

const buffer = await Packer.toBuffer(doc)
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, buffer)
console.log(`Created: ${outPath}`)
