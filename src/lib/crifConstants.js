export const CRIF_COMPANY_OPTIONS = [
  { id: '18279', label: 'Simplified Lending Branch' },
  { id: '26281', label: 'E&S' },
  { id: '16209', label: 'SBDC' },
  { id: '36198', label: 'SL Business Loans' },
  { id: '51238', label: 'Test Branch - Retail Loans' },
]

/** Branches included in universal CRIF sync (matches db-check / Simplified dashboard). */
export const CRIF_SYNC_BRANCH_OPTIONS = [
  { id: '18279', label: 'Simplified Lending' },
  { id: '26281', label: 'E&S' },
]

export const CRIF_SYNC_BRANCH_IDS = CRIF_SYNC_BRANCH_OPTIONS.map((b) => b.id)

export const CRIF_CATEGORY_OPTIONS = [
  { value: 'Borrower', label: 'Borrower' },
  { value: 'Contract', label: 'Contract' },
]

export const CRIF_ASCII_OPTIONS = [
  { value: '1', label: 'CR+LF' },
  { value: 'Other', label: 'Other' },
]

export const CRIF_LENGTH_OPTIONS = {
  Borrower: [
    { value: '1500', label: '1500' },
    { value: 'Other', label: 'Other' },
  ],
  Contract: [
    { value: '800', label: '800' },
    { value: 'Other', label: 'Other' },
  ],
}

export const CRIF_COMPANY_LABEL_BY_ID = Object.fromEntries(
  CRIF_COMPANY_OPTIONS.map((c) => [c.id, c.label])
)
