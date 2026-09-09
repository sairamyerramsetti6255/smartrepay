import { Outlet } from 'react-router-dom'
import { BorrowerSyncProvider } from '@/context/BorrowerSyncContext'
import { WorkflowProvider } from '@/context/WorkflowContext'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

export function Layout() {
  return (
    <BorrowerSyncProvider>
      <WorkflowProvider>
        <div className="min-h-screen bg-[var(--bg-app)]">
          <Sidebar />
          <TopBar />
          <main className="ml-[248px] pt-14 min-h-screen">
            <div className="p-8 w-full">
              <div className="page-enter w-full">
                <Outlet />
              </div>
            </div>
          </main>
        </div>
      </WorkflowProvider>
    </BorrowerSyncProvider>
  )
}
