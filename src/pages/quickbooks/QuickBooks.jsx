import { useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { QBOverview } from './QBOverview'
import { QBImport } from './QBImport'
import { QBLibrary } from './QBLibrary'
import { QBEmiReceipts } from './QBEmiReceipts'
import { QBPaymentsDisbursed } from './QBPaymentsDisbursed'
import { QBAccounts } from './QBAccounts'
import { QBExceptions } from './QBExceptions'
import { QBPreview } from './QBPreview'
import { QBExportHistory } from './QBExportHistory'
import { cn } from '@/lib/utils'

const TABS = [
  { id: 'overview',   label: 'Overview' },
  { id: 'import',     label: 'Import Data' },
  { id: 'library',    label: 'Transaction Library' },
  { id: 'emi',        label: 'EMI Receipts' },
  { id: 'payments',   label: 'Payments' },
  { id: 'accounts',   label: 'Accounts' },
  { id: 'exceptions', label: 'Exceptions' },
  { id: 'preview',    label: 'QB Preview' },
  { id: 'history',    label: 'Export History' },
]

const TAB_COMPONENTS = {
  overview: QBOverview,
  import: QBImport,
  library: QBLibrary,
  emi: QBEmiReceipts,
  payments: QBPaymentsDisbursed,
  accounts: QBAccounts,
  exceptions: QBExceptions,
  preview: QBPreview,
  history: QBExportHistory,
}

export function QuickBooks() {
  const [activeTab, setActiveTab] = useState('overview')
  const ActivePage = TAB_COMPONENTS[activeTab] || QBOverview

  return (
    <div>
      <PageHeader
        title="QuickBooks Data"
        description="Centralized financial transaction preparation for QuickBooks Desktop"
      />

      {/* Tab Navigation */}
      <div className="border-b border-[var(--border-light)] mb-6 -mt-2">
        <div className="flex gap-0 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors duration-100',
                activeTab === tab.id
                  ? 'border-[var(--accent)] text-[var(--accent)]'
                  : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-light)]'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <ActivePage onNavigate={setActiveTab} />
    </div>
  )
}
