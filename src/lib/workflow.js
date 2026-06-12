import { Upload, GitCompare, AlertTriangle, Scale } from 'lucide-react'

/**
 * The reconciliation workflow — single source of truth for the guided flow.
 * Order matters: the UI walks the user through these steps in sequence.
 */
export const WORKFLOW_STEPS = [
  {
    id: 'upload',
    number: 1,
    label: 'Upload docs',
    short: 'Upload',
    path: '/ingest',
    icon: Upload,
    description: 'Import a bank or employer statement to bring payments into SmartRepay.',
    cta: 'Upload documents',
  },
  {
    id: 'match',
    number: 2,
    label: 'Run matching',
    short: 'Match',
    path: '/match',
    icon: GitCompare,
    description: 'Automatically match imported payments to borrowers by name.',
    cta: 'Go to matching',
  },
  {
    id: 'review',
    number: 3,
    label: 'Review unmatched',
    short: 'Review',
    path: '/exceptions',
    icon: AlertTriangle,
    description: 'Resolve payments that could not be matched automatically.',
    cta: 'Review unmatched',
  },
  {
    id: 'reconcile',
    number: 4,
    label: 'Reconcile & post',
    short: 'Reconcile',
    path: '/reconcile',
    icon: Scale,
    description: 'Approve matched payments and export them to LoanDisk.',
    cta: 'Open reconciliation',
  },
]

export const STEP_STATUS = {
  DONE: 'done',
  ACTIVE: 'active',
  TODO: 'todo',
}

/**
 * Compute each step's status and the single most important next action,
 * from lightweight transaction counts + borrower readiness.
 */
export function computeWorkflow({ counts, borrowersReady, borrowersSyncing }) {
  const c = counts || {}
  const transactions = c.transactions ?? 0
  const pending = c.pending ?? 0
  const matched = c.matched ?? 0
  const unmatched = c.unmatched ?? 0
  const posted = c.posted ?? 0
  const documents = c.documents ?? 0

  const hasUploaded = transactions > 0 || documents > 0
  const allProcessed = transactions > 0 && pending === 0
  const reviewComplete = allProcessed && unmatched === 0
  const reconcileComplete = transactions > 0 && matched === 0 && posted > 0

  const status = {
    upload: hasUploaded ? STEP_STATUS.DONE : STEP_STATUS.ACTIVE,
    match: !hasUploaded
      ? STEP_STATUS.TODO
      : allProcessed
        ? STEP_STATUS.DONE
        : STEP_STATUS.ACTIVE,
    review: !allProcessed
      ? STEP_STATUS.TODO
      : reviewComplete
        ? STEP_STATUS.DONE
        : STEP_STATUS.ACTIVE,
    reconcile: !allProcessed
      ? STEP_STATUS.TODO
      : reconcileComplete
        ? STEP_STATUS.DONE
        : matched > 0
          ? STEP_STATUS.ACTIVE
          : STEP_STATUS.TODO,
  }

  const counters = {
    upload: documents,
    match: pending,
    review: unmatched,
    reconcile: matched,
  }

  // Determine the single next action to highlight.
  let nextStepId = null
  if (!hasUploaded) nextStepId = 'upload'
  else if (pending > 0) nextStepId = 'match'
  else if (unmatched > 0) nextStepId = 'review'
  else if (matched > 0) nextStepId = 'reconcile'

  const prerequisite = !borrowersReady
    ? {
        ready: false,
        syncing: borrowersSyncing,
        message: borrowersSyncing
          ? 'Loading borrowers from LoanDisk — you can upload a statement while this finishes.'
          : 'No borrowers loaded yet. Borrowers sync automatically after login.',
      }
    : { ready: true }

  const allComplete = hasUploaded && allProcessed && reconcileComplete

  return { status, counters, nextStepId, prerequisite, allComplete }
}

export function getStep(id) {
  return WORKFLOW_STEPS.find((s) => s.id === id) || null
}
