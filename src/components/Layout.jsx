import { Outlet } from 'react-router-dom'
import { BorrowerSyncProvider } from '@/context/BorrowerSyncContext'
import { WorkflowProvider } from '@/context/WorkflowContext'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { DemoDataBanner } from './DemoDataBanner'

export function Layout() {
  return (
    <BorrowerSyncProvider>
      <WorkflowProvider>
        <div className="min-h-screen bg-[var(--bg-app)]">
          <Sidebar />
          <TopBar />
          <main className="ml-[248px] pt-14 min-h-screen">
            <div className="p-10 max-w-[1240px]">
              <DemoDataBanner />
              <div className="page-enter">
                <Outlet />
              </div>
            </div>
          </main>
        </div>
      </WorkflowProvider>
    </BorrowerSyncProvider>
  )
}
